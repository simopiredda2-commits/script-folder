import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  IDENTITY_UNAVAILABLE,
  RECOVERY_EXPIRED,
  type ReturnFailure,
} from '../src/auth/identity-service';
import { accessLog, appUser, doctorProfile } from '../src/db/schema';
import { totp } from '../src/security/totp';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Ripristino delle credenziali con SPID o CIE (D181, D189): medici e segreteria che hanno perso
 * la password o il codice, o sono bloccati, entrano con SPID o CIE e scelgono una password nuova,
 * se il codice fiscale riconosciuto è quello del loro utente.
 */

/** Codici fiscali inventati, con la X come luogo di nascita (D12). */
const SECRETARY_CF = 'SRVMRT85C41X101Q';
const STRANGER_CF = 'NSSNSS70A01X101Z';

let t: TestDatabase;
let s: Scenario;
beforeAll(async () => {
  t = await createTestDatabase();
  s = await createScenario(t.db, { idleLockMinutes: null });
});
afterAll(async () => {
  await s?.app.close();
  await t?.drop();
});

const cookieOf = (r: { cookies: { name: string; value: string }[] }, name: string) =>
  r.cookies.find((c) => c.name === name)?.value;

/** Avvio, pagina simulata con il codice fiscale di chi «entra», ritorno al programma. */
async function spid(
  username: string,
  fiscalCode: string,
  opts: { ip?: string; postazione?: string; afterStart?: () => void } = {},
) {
  const ip = opts.ip ?? '10.30.0.1';
  const start = await s.app.inject({
    method: 'POST',
    url: '/api/ripristino',
    payload: { nomeUtente: username, postazione: opts.postazione ?? 'casa' },
    remoteAddress: ip,
  });
  if (start.statusCode !== 200) return { start, back: null, cookie: undefined, location: '' };
  opts.afterStart?.();
  const page = new URL(start.json<{ indirizzo: string }>().indirizzo, 'http://localhost');
  page.pathname += '/esito';
  page.searchParams.delete('response_type');
  page.searchParams.delete('code_challenge_method');
  page.searchParams.set('azione', 'spid');
  page.searchParams.set('codice_fiscale', fiscalCode);
  const approved = await s.app.inject({ method: 'GET', url: page.pathname + page.search });
  const back = await s.app.inject({ method: 'GET', url: approved.headers.location! });
  return {
    start,
    back,
    cookie: cookieOf(back, 'ripristino'),
    location: String(back.headers.location),
    callback: String(approved.headers.location),
  };
}

const withCookie = (cookie: string | undefined) =>
  cookie ? { cookie: `ripristino=${cookie}` } : {};
const state = (cookie: string | undefined) =>
  s.app.inject({ method: 'GET', url: '/api/ripristino/stato', headers: withCookie(cookie) });
const choose = (cookie: string | undefined, nuovaPassword: string, azzeraSecondoFattore = false) =>
  s.app.inject({
    method: 'POST',
    url: '/api/ripristino/password',
    headers: withCookie(cookie),
    payload: { nuovaPassword, azzeraSecondoFattore },
  });
const access = (username: string, password: string) =>
  s.app.inject({
    method: 'POST',
    url: '/api/accesso',
    payload: { username, password, postazione: 'studio' },
    remoteAddress: '10.31.0.1',
  });
const doctorCf = async (userId: string) =>
  (
    await t.db
      .select({ cf: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId))
  )[0]!.cf!;
const userRow = async (id: string) =>
  (await t.db.select().from(appUser).where(eq(appUser.id, id)))[0]!;
/** Il motivo del ritorno, nell'indirizzo: solo un codice, mai un testo (D193). */
const refusalOf = (location: string) =>
  new URL(location, 'http://localhost').searchParams.get('motivo');
/** Lo stesso codice per nome sconosciuto, utente escluso e identità diversa. */
const REFUSED: ReturnFailure = 'non-possibile';

describe('ripristino delle credenziali con SPID o CIE (D189)', () => {
  it('il medico bloccato entra con SPID e sceglie una password nuova: sbloccato, sessioni chiuse, secondo fattore tenuto', async () => {
    const doctor = s.users.titolare;
    const session = await login(s, 'titolare');
    await t.db
      .update(appUser)
      .set({ failedLogins: 49, lockedUntil: new Date(s.clock.now().getTime() + 600_000) })
      .where(eq(appUser.id, doctor.id));
    const r = await spid(doctor.username, (await doctorCf(doctor.id)).toLowerCase());
    expect(r.location).toBe('/ripristino');
    expect(r.cookie).toBeTruthy();
    const st = await state(r.cookie);
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json()).toMatchObject({
      nomeUtente: doctor.username,
      metodo: 'spid',
      secondoFattoreAttivo: true,
      lunghezzaMinima: 12,
    });
    expect(st.json().bloccatoFinoA).not.toBeNull();
    // Una password che non va non consuma il passaggio.
    expect((await choose(r.cookie, 'corta')).json().errore).toMatch(/almeno 12 caratteri/);
    expect((await choose(r.cookie, PASSWORD)).json().errore).toBe(
      'La nuova password deve essere diversa da quella di prima',
    );
    const done = await choose(r.cookie, 'la password ritrovata con spid');
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ stato: 'ok', secondoFattoreAzzerato: false });
    expect(done.json().sessioniChiuse).toBeGreaterThanOrEqual(1);
    // Il passaggio vale una volta; la sessione di prima è chiusa; il conto è sbloccato.
    expect((await state(r.cookie)).json().errore).toBe(RECOVERY_EXPIRED);
    expect(
      (await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie: session } }))
        .statusCode,
    ).toBe(401);
    expect(await userRow(doctor.id)).toMatchObject({
      lockedUntil: null,
      failedLogins: 0,
      mustChangePassword: false,
    });
    expect((await access(doctor.username, PASSWORD)).statusCode).toBe(401);
    expect((await access(doctor.username, 'la password ritrovata con spid')).json().passo).toBe(
      'secondo-fattore',
    );
    // Nel registro di amministrazione: chi, come, che cosa; mai la password.
    const admin = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, doctor.id), eq(accessLog.action, 'amministrazione')));
    expect(admin.map((a) => a.details)).toContainEqual(
      expect.objectContaining({
        area: 'utenti',
        azione: 'ripristino',
        tramite: 'SPID o CIE',
        campi: ['password', 'blocco'],
      }),
    );
    expect(JSON.stringify(admin)).not.toMatch(/ritrovata/);
  });

  it('con un’identità diversa, o con un nome sconosciuto, il ripristino non si apre, con lo stesso messaggio', async () => {
    const other = await spid(s.users.collega.username, STRANGER_CF);
    // Nessun passaggio: il cookie del ripristino, se c'era, si svuota.
    expect(other.cookie).toBeFalsy();
    expect(refusalOf(other.location)).toBe(REFUSED);
    const unknown = await spid('nessuno.cosi', STRANGER_CF);
    // L'avvio risponde come per un nome vero: chi prova non sa se l'utente c'è.
    expect(unknown.start.statusCode).toBe(200);
    expect(Object.keys(unknown.start.json())).toEqual(['indirizzo']);
    expect(refusalOf(unknown.location)).toBe(REFUSED);
    const refused = await t.db
      .select()
      .from(accessLog)
      .where(eq(accessLog.action, 'ripristino_rifiutato'))
      .orderBy(asc(accessLog.seq));
    expect(refused.map((r) => (r.details as { motivo: string }).motivo)).toEqual([
      'identità diversa da quella dell’utente',
      'utente sconosciuto o escluso',
    ]);
  });

  it('la segreteria ripristina solo dopo aver collegato la sua identità, a sessione aperta e con il codice', async () => {
    const secretary = s.users.segreteria;
    expect(refusalOf((await spid(secretary.username, SECRETARY_CF)).location)).toBe(REFUSED);
    const cookie = await login(s, 'segreteria');
    const get = () =>
      s.app.inject({ method: 'GET', url: '/api/profilo/identita', headers: { cookie } });
    expect((await get()).json()).toMatchObject({
      disponibile: true,
      perIlMedico: false,
      puoRipristinare: true,
      collegata: false,
    });
    const start = (codice: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/profilo/identita',
        headers: { cookie },
        payload: { codice },
      });
    // Senza il codice di adesso, niente: e il codice sbagliato conta.
    expect((await start('000000')).statusCode).toBe(401);
    expect((await userRow(secretary.id)).failedCodes).toBe(1);
    s.clock.advance(30_000);
    const ok = await start(totp(s.secrets.get(secretary.id)!, s.clock.now().getTime()));
    expect(ok.statusCode, ok.body).toBe(200);
    const page = new URL(ok.json<{ indirizzo: string }>().indirizzo, 'http://localhost');
    page.pathname += '/esito';
    page.searchParams.set('azione', 'cie');
    page.searchParams.set('codice_fiscale', SECRETARY_CF);
    const approved = await s.app.inject({ method: 'GET', url: page.pathname + page.search });
    const back = await s.app.inject({
      method: 'GET',
      url: approved.headers.location!,
      headers: { cookie },
    });
    expect(back.headers.location).toBe('/profilo/identita?collegamento=ok');
    expect((await get()).json()).toMatchObject({ collegata: true, codiceFiscale: SECRETARY_CF });
    expect((await userRow(secretary.id)).failedCodes).toBe(0);
    // Ora il ripristino vale, anche azzerando il secondo fattore.
    const r = await spid(secretary.username, SECRETARY_CF);
    expect(r.cookie).toBeTruthy();
    const done = await choose(r.cookie, 'la segreteria ricomincia da capo', true);
    expect(done.json()).toMatchObject({ stato: 'ok', secondoFattoreAzzerato: true });
    expect(
      (await access(secretary.username, 'la segreteria ricomincia da capo')).json().passo,
    ).toBe('attiva-secondo-fattore');
  });

  it('il medico non collega nulla; l’amministratore e chi è in attesa non ripristinano da sé', async () => {
    const doctorCookie = await login(s, 'collega');
    const link = (cookie: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/profilo/identita',
        headers: { cookie },
        payload: { codice: '000000' },
      });
    expect((await link(doctorCookie)).statusCode).toBe(409);
    const adminCookie = await login(s, 'amministratore');
    expect((await link(adminCookie)).statusCode).toBe(403);
    expect(refusalOf((await spid(s.users.amministratore.username, STRANGER_CF)).location)).toBe(
      REFUSED,
    );
    // Il sostituto in attesa di conferma: nemmeno con la sua identità.
    const substitute = s.users.sostituto;
    await t.db
      .update(appUser)
      .set({ awaitingConfirmation: true })
      .where(eq(appUser.id, substitute.id));
    try {
      expect(
        refusalOf((await spid(substitute.username, await doctorCf(substitute.id))).location),
      ).toBe(REFUSED);
    } finally {
      await t.db
        .update(appUser)
        .set({ awaitingConfirmation: false })
        .where(eq(appUser.id, substitute.id));
    }
    // Messo in attesa dopo il riconoscimento: il passaggio non vale più.
    const r = await spid(substitute.username, await doctorCf(substitute.id));
    expect(r.cookie).toBeTruthy();
    await t.db
      .update(appUser)
      .set({ awaitingConfirmation: true })
      .where(eq(appUser.id, substitute.id));
    try {
      expect((await choose(r.cookie, 'una password che non entra')).statusCode).toBe(401);
    } finally {
      await t.db
        .update(appUser)
        .set({ awaitingConfirmation: false })
        .where(eq(appUser.id, substitute.id));
    }
  });

  it('la richiesta vale una volta e dieci minuti, il passaggio per la password anche', async () => {
    const doctor = s.users.collega;
    const cf = await doctorCf(doctor.id);
    const late = await spid(doctor.username, cf, {
      afterStart: () => s.clock.advance(11 * 60_000),
    });
    expect(refusalOf(late.location)).toBe('non-riconosciuta');
    const r = await spid(doctor.username, cf);
    expect(r.cookie).toBeTruthy();
    const again = await s.app.inject({ method: 'GET', url: r.callback! });
    expect(refusalOf(String(again.headers.location))).toBe('non-riconosciuta');
    s.clock.advance(11 * 60_000);
    expect((await state(r.cookie)).statusCode).toBe(401);
    expect((await choose(r.cookie, 'troppo tardi per questa')).statusCode).toBe(401);
  });

  it('gli avvii contano sulla provenienza come le password sbagliate (D188)', async () => {
    const start = () =>
      s.app.inject({
        method: 'POST',
        url: '/api/ripristino',
        payload: { nomeUtente: s.users.collega.username, postazione: 'pc-ripristini' },
        remoteAddress: '10.40.0.1',
      });
    for (let i = 0; i < 6; i++) expect((await start()).statusCode).toBe(200);
    const waiting = await start();
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json().errore).toBe(
      'Troppe password sbagliate da questa postazione: riprova tra 2 secondi',
    );
  });

  it('il simulatore rimanda solo agli indirizzi di ritorno del programma, mai fuori (D193)', async () => {
    const common = { client_id: 'SIMULATORE', state: 'qualunque', code_challenge: 'a'.repeat(43) };
    for (const redirect of [
      '//esempio.invalid/raccolta',
      '/\\esempio.invalid/raccolta',
      'https://esempio.invalid/raccolta',
      '/api/altro/ritorno',
    ]) {
      const page = await s.app.inject({
        method: 'GET',
        url: `/api/simulatore/identita-digitale?${new URLSearchParams({
          ...common,
          response_type: 'code',
          code_challenge_method: 'S256',
          redirect_uri: redirect,
        }).toString()}`,
      });
      expect(page.statusCode, redirect).toBe(400);
      const out = await s.app.inject({
        method: 'GET',
        url: `/api/simulatore/identita-digitale/esito?${new URLSearchParams({
          ...common,
          redirect_uri: redirect,
          azione: 'annulla',
        }).toString()}`,
      });
      expect(out.statusCode, redirect).toBe(400);
      expect(out.headers.location, redirect).toBeUndefined();
    }
    // Il ritorno del programma va.
    const ok = await s.app.inject({
      method: 'GET',
      url: `/api/simulatore/identita-digitale/esito?${new URLSearchParams({
        ...common,
        redirect_uri: '/api/ripristino/ritorno',
        azione: 'annulla',
      }).toString()}`,
    });
    expect(ok.statusCode).toBe(302);
    expect(String(ok.headers.location)).toMatch(/^\/api\/ripristino\/ritorno\?/);
  });
});

describe('ripristino in produzione con il simulatore (D189)', () => {
  it('ripristino e collegamento sono spenti: il simulatore riconosce chiunque come chiunque', async () => {
    const app = buildApp({
      db: t.db,
      config: {
        encryptionKey: s.encryptionKey,
        sessionMaxHours: 12,
        cookieSecure: false,
        environment: 'produzione',
      },
      now: s.clock.now,
    });
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/ripristino',
        payload: { nomeUtente: s.users.titolare.username, postazione: 'casa' },
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().errore).toBe(IDENTITY_UNAVAILABLE);
      const back = await app.inject({
        method: 'GET',
        url: '/api/ripristino/ritorno?state=x&code=y',
      });
      expect(refusalOf(String(back.headers.location))).toBe('non-collegato');
    } finally {
      await app.close();
    }
  });
});
