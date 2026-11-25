import { buildFiscalCode, type Role } from '@mmg/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINICAL_UNLOCK_REFUSAL, createUserAdminService } from '../src/admin/user-service';
import type { Actor } from '../src/auth/service';
import { accessLog, appUser, archive, doctorProfile, serviceSession } from '../src/db/schema';
import { base32Decode } from '../src/security/base32';
import { totp } from '../src/security/totp';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Codice fiscale inventato: luogo di nascita con la X, che nessun comune ha (D12). */
const cf = (surname: string, name: string, sex: 'M' | 'F') =>
  buildFiscalCode({ surname, name, birthDate: '1975-05-05', sex, placeCode: 'X001' });

const MUST_CHANGE = 'Cambia la password temporanea prima di continuare';
const NOT_ADMIN = 'Serve il ruolo di amministratore dello studio';

/**
 * Utenti e ruoli dello studio, password temporanea e cambio della password (tappa 14). Utenti
 * inventati; le password temporanee si raccolgono per controllare che non finiscano nel registro.
 */
describe('utenti e ruoli dello studio (tappa 14)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<string, string> = {};
  /** Ogni password vista nelle prove: nessuna deve finire nel registro. */
  const passwordsSeen: string[] = [];
  const secrets = new Map<string, Buffer>();

  beforeAll(async () => {
    t = await createTestDatabase();
    // Senza blocco per inattività: le prove fanno molti accessi e l'orologio avanza.
    s = await createScenario(t.db, { idleLockMinutes: null });
    cookies.admin = await login(s, 'amministratore');
    cookies.titolare = await login(s, 'titolare');
    cookies.segreteria = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (
    cookie: string | undefined,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) => s.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
  const admin = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    req(cookies.admin, method, url, payload);
  const access = (username: string, password: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username, password, postazione: 'postazione-prova' },
    });

  /**
   * Blocca il conto con cinque codici sbagliati sul passaggio aperto dalla password giusta: la
   * soglia bassa dello studio (D188). Le password sbagliate bloccano solo alla soglia alta.
   */
  async function lockWithCodes(username: string, password: string) {
    const body = (await access(username, password)).json<{ passaggio: string; segreto?: string }>();
    const passaggio = body.passaggio;
    // Il segreto: quello da attivare, quello di un accesso di questa prova o dello scenario.
    const scenarioUser = Object.values(s.users).find((u) => u.username === username);
    const secret = body.segreto
      ? base32Decode(body.segreto)
      : (secrets.get(username) ?? s.secrets.get(scenarioUser?.id ?? ''));
    const valid = new Set(
      secret ? [-30_000, 0, 30_000].map((d) => totp(secret, s.clock.now().getTime() + d)) : [],
    );
    const wrong = ['000000', '111111', '222222', '333333', '444444', '555555', '666666'];
    for (const codice of wrong.filter((c) => !valid.has(c)).slice(0, 5))
      await s.app.inject({
        method: 'POST',
        url: '/api/accesso/codice',
        payload: { passaggio, codice },
      });
  }

  /** Accesso completo con una password qualsiasi; il secondo fattore si attiva se serve. */
  async function loginAs(username: string, password: string): Promise<string> {
    const res = await access(username, password);
    if (res.statusCode !== 200) throw new Error(`Accesso di ${username} fallito: ${res.body}`);
    const body = res.json<{ passaggio: string; segreto?: string }>();
    if (body.segreto) secrets.set(username, base32Decode(body.segreto));
    s.clock.advance(30_000);
    const done = await s.app.inject({
      method: 'POST',
      url: '/api/accesso/codice',
      payload: {
        passaggio: body.passaggio,
        codice: totp(secrets.get(username)!, s.clock.now().getTime()),
      },
    });
    if (done.statusCode !== 200) throw new Error(`Codice di ${username} rifiutato: ${done.body}`);
    return `sessione=${done.cookies.find((c) => c.name === 'sessione')!.value}`;
  }

  async function createUser(payload: object) {
    const res = await admin('POST', '/api/studio/utenti', payload);
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    if (b.passwordTemporanea) passwordsSeen.push(b.passwordTemporanea);
    return {
      id: b.utente.id as string,
      username: b.utente.nomeUtente as string,
      password: b.passwordTemporanea as string | undefined,
      body: b,
    };
  }

  /**
   * Conferma del titolare per la richiesta che legge nel suo elenco: la password temporanea dei
   * nuovi utenti con i dati dei pazienti la riceve lui, non l'amministratore.
   */
  async function confirmByOwner(id: string): Promise<string> {
    const list = await req(cookies.titolare, 'GET', '/api/studio/utenti/da-confermare');
    expect(list.statusCode, list.body).toBe(200);
    const pending = list.json().utenti.find((x: { id: string }) => x.id === id);
    expect(pending, 'utente nell’elenco da confermare').toBeTruthy();
    const r = await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(r.statusCode, r.body).toBe(200);
    const password = r.json().passwordTemporanea as string;
    expect(password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    passwordsSeen.push(password);
    return password;
  }

  /** Utente con i dati dei pazienti: creato dall'amministratore, confermato dal titolare. */
  async function createConfirmed(payload: object) {
    const u = await createUser(payload);
    expect(u.password).toBeUndefined();
    return { ...u, password: await confirmByOwner(u.id) };
  }

  /** Primo accesso con la password temporanea e cambio subito: la sessione resta aperta. */
  async function firstAccess(username: string, temporary: string, chosen: string) {
    const cookie = await loginAs(username, temporary);
    const r = await req(cookie, 'POST', '/api/profilo/password', {
      passwordAttuale: temporary,
      nuovaPassword: chosen,
    });
    expect(r.statusCode, r.body).toBe(200);
    passwordsSeen.push(chosen);
    return cookie;
  }

  /** Righe del registro delle azioni di amministrazione: esito e dettagli. */
  const adminLog = async (): Promise<Record<string, unknown>[]> =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.action, 'amministrazione')))
    ).map((r) => ({ outcome: r.outcome, ...(r.details as Record<string, unknown>) }));

  const rolesOf = async (id: string) =>
    (await t.db.select({ roles: appUser.roles }).from(appUser).where(eq(appUser.id, id)))[0]!.roles;

  it('la segreteria e il medico non gestiscono utenti: 403 prima dei dati, e il rifiuto è registrato', async () => {
    const target = s.users.segreteria.id;
    const routes: ['GET' | 'POST' | 'PATCH', string, object?][] = [
      ['GET', '/api/studio/utenti'],
      ['POST', '/api/studio/utenti', { nomeUtente: 'abusivo', nome: 'X', ruoli: ['secretary'] }],
      // Corpo non valido: il permesso si controlla prima dei dati.
      ['POST', '/api/studio/utenti', { qualcosa: true }],
      ['PATCH', `/api/studio/utenti/${target}`, { nome: 'Altro nome' }],
      ['POST', `/api/studio/utenti/${target}/sospendi`],
      ['POST', `/api/studio/utenti/${target}/riattiva`],
      ['POST', `/api/studio/utenti/${target}/password-temporanea`],
      ['POST', `/api/studio/utenti/${target}/azzera-secondo-fattore`],
      ['POST', `/api/studio/utenti/${target}/sblocca`],
    ];
    const before = (await adminLog()).filter((e) => e.outcome === 'negato').length;
    for (const who of ['segreteria', 'titolare'] as const) {
      for (const [method, url, payload] of routes) {
        const r = await req(cookies[who], method, url, payload);
        expect(r.statusCode, `${who} ${method} ${url}`).toBe(403);
        expect(r.json().errore).toBe(NOT_ADMIN);
      }
    }
    // Senza sessione: 401, come ogni rotta non pubblica.
    expect((await req(undefined, 'GET', '/api/studio/utenti')).statusCode).toBe(401);
    const denied = (await adminLog()).filter((e) => e.outcome === 'negato');
    expect(denied.length - before).toBe(routes.length * 2);
    expect(denied.at(-1)).toMatchObject({ area: 'utenti', azione: 'sblocco', motivo: NOT_ADMIN });
  });

  it('elenco degli utenti: ruoli, stato, secondo fattore, dati del medico e archivio, senza segreti', async () => {
    const r = await admin('GET', '/api/studio/utenti');
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.ruoli.map((x: { codice: string }) => x.codice)).toEqual([
      'owner_doctor',
      'secretary',
      'substitute_doctor',
      'administrator',
    ]);
    const byName = (u: string) => b.utenti.find((x: { nomeUtente: string }) => x.nomeUtente === u);
    const titolare = byName(s.users.titolare.username);
    expect(titolare).toMatchObject({
      nome: 'Dott.ssa Elena Marchi',
      stato: 'attivo',
      secondoFattoreAttivo: true,
      passwordDaCambiare: false,
      bloccatoFinoA: null,
      ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
      medico: {
        codiceFiscale: buildFiscalCode({
          surname: 'Marchi',
          name: 'Elena',
          birthDate: '1970-01-01',
          sex: 'F',
          placeCode: 'X001',
        }),
        codiceRegionale: 'MMG-PROVA-1',
        asl: 'ASL di prova',
        nome: 'Elena',
        cognome: 'Marchi',
      },
      archivio: { id: s.archives.titolare, nome: 'Archivio Marchi' },
      io: false,
    });
    expect(byName(s.users.amministratore.username)).toMatchObject({
      io: true,
      medico: null,
      archivio: null,
    });
    expect(byName(s.users.collega.username).secondoFattoreAttivo).toBe(false);
    // Nessuna impronta, nessun segreto: né i nomi dei campi né i valori.
    expect(r.body).not.toMatch(
      /scrypt\$|passwordHash|password_hash|totpSecret|totp_secret|totpLastStep/,
    );
  });

  it('crea un utente: la password temporanea la riceve il titolare che conferma; al primo accesso va cambiata', async () => {
    const created = await createUser({
      nomeUtente: '  Carla.Neri ',
      nome: 'Carla Neri',
      email: 'carla.neri@esempio.invalid',
      ruoli: ['secretary'],
    });
    expect(created.username).toBe('carla.neri');
    // Segreteria: l'amministratore non riceve la password, l'utente aspetta il titolare.
    expect(created.password).toBeUndefined();
    expect(created.body.avvisi[0]).toMatch(/^In attesa della conferma di un medico titolare/);
    expect(created.body.utente).toMatchObject({
      stato: 'attivo',
      inAttesaDiConferma: true,
      richiestaDiConferma: { da: 'Andrea Conti' },
      ripristinoDalServizio: true,
      passwordDaCambiare: true,
      secondoFattoreAttivo: false,
      email: 'carla.neri@esempio.invalid',
      medico: null,
      archivio: null,
    });
    const u = { ...created, password: await confirmByOwner(created.id) };
    const listed = (await admin('GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === u.id);
    expect(listed).toMatchObject({
      inAttesaDiConferma: false,
      confermato: { da: 'Dott.ssa Elena Marchi' },
    });
    expect(JSON.stringify(listed)).not.toContain(u.password);

    // Primo accesso: password temporanea e secondo fattore, come sempre.
    const first = await access(u.username, u.password);
    expect(first.json().passo).toBe('attiva-secondo-fattore');
    const cookie = await loginAs(u.username, u.password);
    const io = await req(cookie, 'GET', '/api/io');
    expect(io.statusCode).toBe(200);
    expect(io.json()).toMatchObject({ devoCambiarePassword: true, nomeUtente: 'carla.neri' });
    // Tutto il resto aspetta il cambio della password.
    for (const [method, url] of [
      ['GET', '/api/pazienti'],
      ['GET', '/api/oggi'],
      ['GET', '/api/profilo/credenziali'],
      ['POST', '/api/aft'],
    ] as const) {
      const r = await req(cookie, method, url, method === 'POST' ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().errore).toBe(MUST_CHANGE);
    }
    const rules = await req(cookie, 'GET', '/api/profilo/password');
    expect(rules.json()).toEqual({ lunghezzaMinima: 12, lunghezzaMassima: 128, obbligato: true });

    const change = (passwordAttuale: string, nuovaPassword: string) =>
      req(cookie, 'POST', '/api/profilo/password', { passwordAttuale, nuovaPassword });
    expect((await change(u.password, 'corta')).json().errore).toMatch(/almeno 12 caratteri/);
    expect((await change(u.password, u.password)).json().errore).toMatch(/diversa/);
    expect((await change(u.password, 'x'.repeat(129))).json().errore).toMatch(/al massimo 128/);
    const wrong = await change('non-e-questa-la-password', 'una frase lunga e nuova');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errore).toBe('La password attuale non è corretta');
    const [afterWrong] = await t.db.select().from(appUser).where(eq(appUser.id, u.id));
    // A sessione aperta conta fra i codici sbagliati, con la soglia bassa (D188).
    expect([afterWrong!.failedLogins, afterWrong!.failedCodes]).toEqual([0, 1]);

    const ok = await change(u.password, 'una frase lunga e nuova');
    expect(ok.statusCode, ok.body).toBe(200);
    passwordsSeen.push('una frase lunga e nuova');
    expect((await req(cookie, 'GET', '/api/pazienti')).statusCode).toBe(200);
    expect((await req(cookie, 'GET', '/api/io')).json().devoCambiarePassword).toBe(false);
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, u.id));
    expect(row!.mustChangePassword).toBe(false);
    expect(row!.passwordChangedAt).not.toBeNull();
    expect(row!.failedLogins).toBe(0);
    // La password temporanea non vale più; quella nuova sì.
    expect((await access(u.username, u.password)).statusCode).toBe(401);
    expect((await access(u.username, 'una frase lunga e nuova')).json().passo).toBe(
      'secondo-fattore',
    );

    const log = await adminLog();
    expect(log).toContainEqual(
      expect.objectContaining({
        outcome: 'riuscito',
        area: 'utenti',
        azione: 'creazione',
        utente: 'carla.neri',
        utenteId: u.id,
        ruoliPrima: [],
        ruoliDopo: ['secretary'],
        campi: ['nomeUtente', 'nome', 'ruoli', 'email'],
      }),
    );
    const changes = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, u.id), eq(accessLog.action, 'cambio_password')));
    // Il tentativo fallito porta anche l'indirizzo della richiesta, che chi accede non sceglie.
    expect(changes.map((c) => [c.outcome, c.details])).toEqual([
      ['fallito', { motivo: 'password attuale errata', indirizzo: '127.0.0.1' }],
      ['riuscito', { obbligato: true, altreSessioniChiuse: 0 }],
    ]);
  });

  it('con la password temporanea si può sempre uscire', async () => {
    const u = await createConfirmed({
      nomeUtente: 'uscita.prova',
      nome: 'Uscita Prova',
      ruoli: ['secretary'],
    });
    const cookie = await loginAs(u.username, u.password);
    expect((await req(cookie, 'POST', '/api/uscita', {})).statusCode).toBe(200);
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(401);
  });

  it('nome utente unico e dati del medico controllati', async () => {
    const post = (payload: object) => admin('POST', '/api/studio/utenti', payload);
    const dup = await post({
      nomeUtente: s.users.segreteria.username,
      nome: 'Doppio',
      ruoli: ['secretary'],
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().errore).toBe('Nome utente già in uso: scegline un altro');
    // Lo stesso nome con le maiuscole è lo stesso nome: l'accesso lo legge in minuscolo.
    expect(
      (await post({ nomeUtente: 'CARLA.NERI', nome: 'Doppio', ruoli: ['secretary'] })).statusCode,
    ).toBe(409);
    expect((await post({ nomeUtente: 'ab', nome: 'Corto', ruoli: ['secretary'] })).statusCode).toBe(
      400,
    );
    expect((await post({ nomeUtente: 'nessun.ruolo', nome: 'X', ruoli: [] })).statusCode).toBe(400);
    const noDoctor = await post({
      nomeUtente: 'medico.senza.dati',
      nome: 'X',
      ruoli: ['owner_doctor'],
    });
    expect(noDoctor.statusCode).toBe(400);
    expect(noDoctor.json().errore).toBe('Per un medico servono nome, cognome e codice fiscale');
    const good = cf('Bruni', 'Sara', 'F');
    const wrongCheck = `${good.slice(0, 15)}${good[15] === 'A' ? 'B' : 'A'}`;
    const bad = await post({
      nomeUtente: 'medico.cf.errato',
      nome: 'Dott.ssa Sara Bruni',
      ruoli: ['substitute_doctor'],
      medico: { codiceFiscale: wrongCheck, nome: 'Sara', cognome: 'Bruni' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errore).toMatch(/^Codice fiscale del medico: non è valido/);
    const secretaryWithDoctor = await post({
      nomeUtente: 'segreteria.medico',
      nome: 'X',
      ruoli: ['secretary'],
      medico: { codiceFiscale: good, nome: 'Sara', cognome: 'Bruni' },
    });
    expect(secretaryWithDoctor.statusCode).toBe(400);
    // Il codice fiscale e il codice regionale di un medico sono suoi, nello studio.
    const [titolare] = await t.db
      .select()
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    const sameCf = await post({
      nomeUtente: 'doppione.cf',
      nome: 'X',
      ruoli: ['substitute_doctor'],
      medico: { codiceFiscale: titolare!.fiscalCode, nome: 'Elena', cognome: 'Marchi' },
    });
    expect(sameCf.statusCode).toBe(409);
    const sameRegional = await post({
      nomeUtente: 'doppione.regionale',
      nome: 'X',
      ruoli: ['substitute_doctor'],
      medico: {
        codiceFiscale: good,
        nome: 'Sara',
        cognome: 'Bruni',
        codiceRegionale: 'MMG-PROVA-1',
      },
    });
    expect(sameRegional.statusCode).toBe(409);
    expect(sameRegional.json().errore).toBe('Codice regionale già di un altro medico dello studio');
  });

  it('un titolare nuovo ha la riga del medico e il suo archivio', async () => {
    const u = await createConfirmed({
      nomeUtente: 'luca.verdi',
      nome: 'Dott. Luca Verdi',
      ruoli: ['owner_doctor'],
      medico: {
        codiceFiscale: cf('Verdi', 'Luca', 'M').toLowerCase(),
        nome: 'Luca',
        cognome: 'Verdi',
        codiceRegionale: 'MMG-PROVA-9',
        asl: 'ASL di prova',
      },
    });
    expect(u.body.utente.medico).toEqual({
      codiceFiscale: cf('Verdi', 'Luca', 'M'),
      codiceRegionale: 'MMG-PROVA-9',
      codiceAsl: null,
      asl: 'ASL di prova',
      nome: 'Luca',
      cognome: 'Verdi',
      correzioneCodiceFiscale: null,
    });
    expect(u.body.utente.archivio.nome).toBe('Archivio di Luca Verdi');
    const arcs = await t.db.select().from(archive).where(eq(archive.ownerUserId, u.id));
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.studioId).toBe(s.studioId);
    // Dopo il cambio della password il titolare nuovo vede il suo archivio.
    const cookie = await firstAccess(u.username, u.password, 'archivio nuovo e vuoto');
    expect((await req(cookie, 'GET', '/api/io')).json().archivio).toEqual({
      id: arcs[0]!.id,
      nome: 'Archivio di Luca Verdi',
    });
  });

  it('ruoli: il titolare porta il suo archivio; togliere un ruolo non cancella nulla, e lo dice', async () => {
    const u = await createUser({
      nomeUtente: 'giulia.rossi',
      nome: 'Dott.ssa Giulia Rossi',
      ruoli: ['substitute_doctor'],
      medico: { codiceFiscale: cf('Rossi', 'Giulia', 'F'), nome: 'Giulia', cognome: 'Rossi' },
    });
    expect(u.body.utente.archivio).toBeNull();
    const patch = (payload: object) => admin('PATCH', `/api/studio/utenti/${u.id}`, payload);

    const add = await patch({ ruoli: ['substitute_doctor', 'owner_doctor'] });
    expect(add.statusCode, add.body).toBe(200);
    // L'archivio prima; poi l'attesa, che continua con una richiesta nuova (utente non confermato).
    expect(add.json().avvisi).toEqual([
      'Creato l’archivio «Archivio di Giulia Rossi», vuoto.',
      'L’utente resta in attesa della conferma di un medico titolare: la richiesta ha la data di adesso.',
    ]);
    expect(add.json().utente.archivio.nome).toBe('Archivio di Giulia Rossi');
    expect(add.json().utente.inAttesaDiConferma).toBe(true);

    const remove = await patch({ ruoli: ['substitute_doctor'] });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().avvisi[0]).toMatch(/resta con tutti i suoi dati/);
    expect(remove.json().utente.archivio.nome).toBe('Archivio di Giulia Rossi');

    const back = await patch({ ruoli: ['owner_doctor', 'substitute_doctor'] });
    expect(back.json().avvisi[0]).toBe(
      'L’archivio «Archivio di Giulia Rossi» torna al suo titolare.',
    );
    expect(await t.db.select().from(archive).where(eq(archive.ownerUserId, u.id))).toHaveLength(1);

    const noDoctor = await patch({ ruoli: ['secretary'] });
    expect(noDoctor.json().avvisi).toContain(
      'I dati del medico restano registrati: non si cancella nulla.',
    );
    expect(
      await t.db.select().from(doctorProfile).where(eq(doctorProfile.userId, u.id)),
    ).toHaveLength(1);

    // Dati del medico e nome: nel registro i nomi dei campi, non i valori.
    const edit = await patch({
      nome: 'Dott.ssa Giulia Rossi Bianchi',
      email: 'giulia.rossi@esempio.invalid',
      ruoli: ['substitute_doctor'],
      medico: {
        codiceFiscale: cf('Rossi', 'Giulia', 'F'),
        nome: 'Giulia',
        cognome: 'Rossi',
        codiceRegionale: 'MMG-PROVA-8',
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().utente.medico.codiceRegionale).toBe('MMG-PROVA-8');
    expect((await patch({ ruoli: ['substitute_doctor'] })).json().errore).toBe(
      'Niente da cambiare',
    );
    const last = (await adminLog()).filter((e) => e.utente === 'giulia.rossi').at(-1);
    expect(last).toMatchObject({
      azione: 'modifica',
      ruoliPrima: ['secretary'],
      ruoliDopo: ['substitute_doctor'],
      campi: ['nome', 'email', 'ruoli', 'medico.codiceRegionale'],
    });
  });

  it('codice ASL del medico: solo dall’elenco del Ministero per la regione dello studio; cambiarlo chiude la sessione RUPAR (D267)', async () => {
    const list = await admin('GET', '/api/studio/utenti');
    const units = list.json().aziendeSanitarie;
    expect(units.regione).toBe('PIEMONTE');
    expect(units.elenco.map((a: { codice: string }) => a.codice)).toEqual([
      '203',
      '204',
      '205',
      '206',
      '207',
      '208',
      '209',
      '210',
      '211',
      '212',
      '213',
      '301',
    ]);
    const collega = s.users.collega;
    const sessions = () =>
      t.db
        .select({ service: serviceSession.service })
        .from(serviceSession)
        .where(eq(serviceSession.userId, collega.id));
    expect((await sessions()).map((r) => r.service).sort()).toEqual([
      'rupar_piemonte',
      'sistema_ts',
    ]);
    // Lo stesso codice fiscale dello scenario: qui cambia solo il codice ASL.
    const scenarioCf = buildFiscalCode({
      surname: 'Serra',
      name: 'Paolo',
      birthDate: '1970-01-01',
      sex: 'M',
      placeCode: 'X001',
    });
    const medico = (codiceAsl?: string) => ({
      medico: {
        codiceFiscale: scenarioCf,
        nome: 'Paolo',
        cognome: 'Serra',
        codiceRegionale: 'MMG-PROVA-2',
        asl: 'ASL di prova',
        ...(codiceAsl === undefined ? {} : { codiceAsl }),
      },
    });
    const patch = (payload: object) => admin('PATCH', `/api/studio/utenti/${collega.id}`, payload);
    // Prima nome e cognome, che lo scenario non ha, con l'ASL di adesso: le sessioni restano.
    expect((await patch(medico('301'))).statusCode).toBe(200);
    expect((await sessions()).length).toBe(2);
    // 321 è un'ATS della Lombardia, non un'ASL del Piemonte; 30 non ha tre cifre.
    const wrong = await patch(medico('321'));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errore).toBe(
      "Codice ASL 321: non è nell'elenco delle ASL del Ministero della Salute per la regione PIEMONTE",
    );
    expect((await patch(medico('30'))).statusCode).toBe(400);
    const ok = await patch(medico('203'));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().utente.medico.codiceAsl).toBe('203');
    // La sessione RUPAR era del client_id con l'ASL di prima: si chiude; quella del Sistema TS no.
    expect((await sessions()).map((r) => r.service)).toEqual(['sistema_ts']);
    expect(ok.json().avvisi.join(' ')).toMatch(/Codice ASL/);
    const last = (await adminLog()).filter((e) => e.utente === collega.username).at(-1);
    expect(last).toMatchObject({ azione: 'modifica', campi: ['medico.codiceAsl'] });
    // Senza il campo il codice resta com'è: chi non lo conosce non lo cancella per sbaglio.
    expect((await patch(medico())).json().errore).toBe('Niente da cambiare');
    // Vuoto lo toglie: torna «da completare».
    const cleared = await patch(medico(''));
    expect(cleared.json().utente.medico.codiceAsl).toBeNull();
    expect((await patch(medico('301'))).statusCode).toBe(200);
  });

  it('nessuno cambia i propri ruoli; il proprio nome sì', async () => {
    const me = s.users.amministratore.id;
    const own = await admin('PATCH', `/api/studio/utenti/${me}`, {
      ruoli: ['administrator', 'secretary'],
    });
    expect(own.statusCode).toBe(403);
    expect(own.json().errore).toBe('Non puoi cambiare i tuoi ruoli: lo fa un altro amministratore');
    expect(await rolesOf(me)).toEqual(['administrator']);
    expect((await adminLog()).at(-1)).toMatchObject({
      outcome: 'negato',
      azione: 'modifica',
      utente: s.users.amministratore.username,
    });
    const name = await admin('PATCH', `/api/studio/utenti/${me}`, {
      nome: 'Andrea Conti',
      email: 'amministrazione@esempio.invalid',
      ruoli: ['administrator'],
    });
    expect(name.statusCode, name.body).toBe(200);
  });

  it('non si toglie l’ultimo amministratore attivo, nemmeno con due richieste incrociate', async () => {
    const service = createUserAdminService({ db: t.db, now: s.clock.now });
    const actor = (userId: string, roles: Role[]): Actor => ({
      userId,
      studioId: s.studioId,
      roles,
      displayName: 'Amministratore di prova',
      sessionId: '00000000-0000-4000-8000-000000000000',
      workstation: 'postazione-prova',
      mustChangePassword: false,
    });
    const a = actor(s.users.amministratore.id, ['administrator']);
    // Il servizio controlla il permesso anche senza la rotta.
    const secretary = actor(s.users.segreteria.id, ['secretary']);
    for (const call of [
      () => service.list(secretary),
      () => service.create(secretary, { nomeUtente: 'abusivo', nome: 'X', ruoli: ['secretary'] }),
      () => service.update(secretary, a.userId, { nome: 'X' }),
      () => service.setStatus(secretary, a.userId, false),
      () => service.resetPassword(secretary, a.userId),
      () => service.resetSecondFactor(secretary, a.userId),
      () => service.unlock(secretary, a.userId),
    ])
      await expect(call()).rejects.toMatchObject({ statusCode: 403, message: NOT_ADMIN });
    const created = await service.create(a, {
      nomeUtente: 'secondo.amministratore',
      nome: 'Secondo Amministratore',
      ruoli: ['administrator'],
    });
    // Solo amministratore: nessuna conferma, la password la riceve l'amministratore.
    expect(created.passwordTemporanea).toBeDefined();
    passwordsSeen.push(created.passwordTemporanea!);
    // B ha superato il controllo del ruolo quando era ancora amministratore.
    const b = actor(created.utente.id, ['administrator']);
    await service.update(a, b.userId, { ruoli: ['secretary'] });
    await expect(service.update(b, a.userId, { ruoli: ['secretary'] })).rejects.toMatchObject({
      statusCode: 409,
      message:
        'Serve almeno un amministratore attivo nello studio: prima dai il ruolo a un altro utente',
    });
    await expect(service.setStatus(b, a.userId, false)).rejects.toMatchObject({ statusCode: 409 });
    expect(await rolesOf(a.userId)).toEqual(['administrator']);

    // Due richieste insieme, ognuna toglie il ruolo all'altro: una sola passa. Perché si
    // sovrappongano davvero, la prova tiene il blocco con cui il registro mette in fila le sue
    // righe (migrazione 0002): la prima richiesta resta aperta finché la seconda non è partita.
    await service.update(a, b.userId, { ruoli: ['administrator'] });
    const waiting = async (n: number) => {
      for (let i = 0; i < 400; i++) {
        const { rows } = await t.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (rows[0]!.n >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Non ci sono ${n} transazioni in attesa di un blocco`);
    };
    const holder = await t.pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const first = service.update(a, b.userId, { ruoli: ['secretary'] });
      await waiting(1);
      const second = service.update(b, a.userId, { ruoli: ['secretary'] });
      await waiting(2);
      await holder.query('commit');
      results = await Promise.allSettled([first, second]);
    } finally {
      holder.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const admins = await t.db
      .select({ roles: appUser.roles })
      .from(appUser)
      .where(eq(appUser.studioId, s.studioId));
    expect(admins.filter((x) => x.roles.includes('administrator'))).toHaveLength(1);
    // Il rifiuto è nel registro, con l'utente e il motivo.
    expect((await adminLog()).filter((e) => e.outcome === 'negato').at(-1)).toMatchObject({
      azione: 'modifica',
      motivo: expect.stringMatching(/^Serve almeno un amministratore attivo/),
    });
    // Torna com'era: l'amministratore dello scenario resta l'unico.
    if ((await rolesOf(b.userId)).includes('administrator'))
      await service.update(b, a.userId, { ruoli: ['administrator'] });
    expect(await rolesOf(a.userId)).toEqual(['administrator']);
  });

  it('la sospensione chiude le sessioni e impedisce l’accesso; la riattivazione non le riapre', async () => {
    const u = await createConfirmed({
      nomeUtente: 'da.sospendere',
      nome: 'Da Sospendere',
      ruoli: ['secretary'],
    });
    const cookie = await firstAccess(u.username, u.password, 'prima della sospensione');
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(200);

    const own = await admin('POST', `/api/studio/utenti/${s.users.amministratore.id}/sospendi`);
    expect(own.statusCode).toBe(403);
    expect(own.json().errore).toBe('Non puoi sospendere il tuo utente');

    const suspended = await admin('POST', `/api/studio/utenti/${u.id}/sospendi`);
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(suspended.json()).toMatchObject({ sessioniChiuse: 1, utente: { stato: 'sospeso' } });
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(401);
    const denied = await access(u.username, 'prima della sospensione');
    expect(denied.statusCode).toBe(401);
    expect(denied.json().errore).toBe('Nome utente o password non validi');
    expect((await admin('POST', `/api/studio/utenti/${u.id}/sospendi`)).statusCode).toBe(409);

    const active = await admin('POST', `/api/studio/utenti/${u.id}/riattiva`);
    expect(active.statusCode).toBe(200);
    expect(active.json().utente.stato).toBe('attivo');
    // La sessione di prima resta chiusa: si rientra con un accesso nuovo.
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(401);
    const again = await loginAs(u.username, 'prima della sospensione');
    expect((await req(again, 'GET', '/api/io')).statusCode).toBe(200);
    expect((await adminLog()).filter((e) => e.utente === u.username).map((e) => e.azione)).toEqual([
      'creazione',
      'conferma',
      'sospensione',
      'riattivazione',
    ]);
  });

  it('password temporanea nuova: no per la segreteria; per un amministratore la vecchia non vale, le sessioni si chiudono', async () => {
    // Segreteria: l'amministratore non le dà una password, che gli farebbe vedere i pazienti.
    const secretary = s.users.segreteria;
    const [before] = await t.db.select().from(appUser).where(eq(appUser.id, secretary.id));
    const refused = await admin('POST', `/api/studio/utenti/${secretary.id}/password-temporanea`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().errore).toMatch(/li ripristina chi gestisce il servizio, sul server/);
    expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(200);
    const [after] = await t.db.select().from(appUser).where(eq(appUser.id, secretary.id));
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect((await adminLog()).at(-1)).toMatchObject({
      outcome: 'negato',
      azione: 'password_temporanea',
      utente: secretary.username,
    });

    const own = await admin(
      'POST',
      `/api/studio/utenti/${s.users.amministratore.id}/password-temporanea`,
    );
    expect(own.statusCode).toBe(403);

    // Un altro amministratore, senza dati dei pazienti: la password temporanea si dà.
    const other = await createUser({
      nomeUtente: 'terzo.amministratore',
      nome: 'Terzo Amministratore',
      ruoli: ['administrator'],
    });
    const otherCookie = await firstAccess(other.username, other.password!, 'amministrazione mia');
    const r = await admin('POST', `/api/studio/utenti/${other.id}/password-temporanea`);
    expect(r.statusCode, r.body).toBe(200);
    const temporary = r.json().passwordTemporanea as string;
    passwordsSeen.push(temporary);
    expect(r.json()).toMatchObject({ sessioniChiuse: 1, utente: { passwordDaCambiare: true } });
    expect((await req(otherCookie, 'GET', '/api/io')).statusCode).toBe(401);
    expect((await access(other.username, 'amministrazione mia')).statusCode).toBe(401);
    // Secondo fattore già attivo: chiede il codice, poi solo il cambio della password.
    expect((await access(other.username, temporary)).json().passo).toBe('secondo-fattore');
    const cookie = await loginAs(other.username, temporary);
    expect((await req(cookie, 'GET', '/api/studio/utenti')).json().errore).toBe(MUST_CHANGE);
    expect(
      (
        await req(cookie, 'POST', '/api/profilo/password', {
          passwordAttuale: temporary,
          nuovaPassword: 'amministrazione di nuovo al lavoro',
        })
      ).statusCode,
    ).toBe(200);
    passwordsSeen.push('amministrazione di nuovo al lavoro');
    expect((await req(cookie, 'GET', '/api/studio/utenti')).statusCode).toBe(200);
  });

  it('azzeramento del secondo fattore: no per il medico; per un amministratore sessioni chiuse e si riattiva', async () => {
    // Medico titolare: l'amministratore non lo azzera (attiverebbe il codice sul suo telefono).
    const doctor = s.users.titolare;
    const refused = await admin('POST', `/api/studio/utenti/${doctor.id}/azzera-secondo-fattore`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().errore).toMatch(/li ripristina chi gestisce il servizio, sul server/);
    expect((await req(cookies.titolare, 'GET', '/api/io')).statusCode).toBe(200);
    const [row] = await t.db.select().from(appUser).where(eq(appUser.id, doctor.id));
    expect(row!.totpEnabledAt).not.toBeNull();

    const own = await admin(
      'POST',
      `/api/studio/utenti/${s.users.amministratore.id}/azzera-secondo-fattore`,
    );
    expect(own.statusCode).toBe(403);
    const other = await createUser({
      nomeUtente: 'quarto.amministratore',
      nome: 'Quarto Amministratore',
      ruoli: ['administrator'],
    });
    const cookie = await firstAccess(other.username, other.password!, 'il secondo fattore mio');
    const r = await admin('POST', `/api/studio/utenti/${other.id}/azzera-secondo-fattore`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ sessioniChiuse: 1, utente: { secondoFattoreAttivo: false } });
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(401);
    const [reset] = await t.db.select().from(appUser).where(eq(appUser.id, other.id));
    expect(reset!.totpSecretEnc).toBeNull();
    expect(reset!.totpEnabledAt).toBeNull();
    expect(
      (await admin('POST', `/api/studio/utenti/${other.id}/azzera-secondo-fattore`)).statusCode,
    ).toBe(409);
    // La password resta quella: al prossimo accesso si attiva un segreto nuovo.
    const next = await access(other.username, 'il secondo fattore mio');
    expect(next.json().passo).toBe('attiva-secondo-fattore');
    const again = await loginAs(other.username, 'il secondo fattore mio');
    expect((await req(again, 'GET', '/api/io')).statusCode).toBe(200);
  });

  it('sblocco: tentativi a zero, blocco tolto; per medici e segreteria no', async () => {
    // Un altro amministratore, senza dati dei pazienti: lo sblocca l'amministratore.
    const other = await createUser({
      nomeUtente: 'amministratore.bloccato',
      nome: 'Amministratore Bloccato',
      ruoli: ['administrator'],
    });
    const chosen = 'la password del bloccato';
    await firstAccess(other.username, other.password!, chosen);
    expect((await admin('POST', `/api/studio/utenti/${other.id}/sblocca`)).statusCode).toBe(409);
    await lockWithCodes(other.username, chosen);
    expect((await access(other.username, chosen)).json().errore).toMatch(/bloccato/);
    const listed = (await admin('GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === other.id);
    expect(listed.bloccatoFinoA).not.toBeNull();
    expect(
      (await admin('POST', `/api/studio/utenti/${s.users.amministratore.id}/sblocca`)).statusCode,
    ).toBe(403);
    const r = await admin('POST', `/api/studio/utenti/${other.id}/sblocca`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().utente).toMatchObject({
      bloccatoFinoA: null,
      tentativiFalliti: 0,
      codiciSbagliati: 0,
    });
    expect((await access(other.username, chosen)).statusCode).toBe(200);

    // Un medico titolare bloccato: l'amministratore no, lo sblocca il server o la fine del blocco.
    const doctor = s.users.collega;
    await lockWithCodes(doctor.username, PASSWORD);
    const refused = await admin('POST', `/api/studio/utenti/${doctor.id}/sblocca`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().errore).toBe(CLINICAL_UNLOCK_REFUSAL);
    expect((await access(doctor.username, PASSWORD)).json().errore).toMatch(/bloccato/);
    s.clock.advance(16 * 60_000);
    expect((await access(doctor.username, PASSWORD)).statusCode).toBe(200);
  });

  it('cambio volontario: le altre sessioni si chiudono, quella in uso resta; gli errori bloccano', async () => {
    const u = await createConfirmed({
      nomeUtente: 'due.sessioni',
      nome: 'Due Sessioni',
      ruoli: ['secretary'],
    });
    const first = await firstAccess(u.username, u.password, 'la prima password scelta');
    const second = await loginAs(u.username, 'la prima password scelta');
    // Il nome utente (12 caratteri) non vale come password, nemmeno con le maiuscole.
    const sameAsName = await req(first, 'POST', '/api/profilo/password', {
      passwordAttuale: 'la prima password scelta',
      nuovaPassword: 'Due.Sessioni',
    });
    expect(sameAsName.json().errore).toBe('La password non può essere il nome utente');
    const r = await req(first, 'POST', '/api/profilo/password', {
      passwordAttuale: 'la prima password scelta',
      nuovaPassword: 'la seconda password scelta',
    });
    expect(r.statusCode, r.body).toBe(200);
    passwordsSeen.push('la seconda password scelta');
    expect(r.json().altreSessioniChiuse).toBe(1);
    expect((await req(first, 'GET', '/api/io')).statusCode).toBe(200);
    expect((await req(second, 'GET', '/api/io')).statusCode).toBe(401);
    expect((await req(first, 'GET', '/api/profilo/password')).json().obbligato).toBe(false);

    // Da una sessione aperta non si provano password a volontà: 5 errori bloccano l'utente. Il
    // quinto, che blocca, risponde già 429, come la password giusta con l'utente bloccato: chi
    // prova (anche con molte richieste insieme) non sa se aveva indovinato.
    for (let i = 0; i < 5; i++) {
      const wrong = await req(first, 'POST', '/api/profilo/password', {
        passwordAttuale: `tentativo-${i}`,
        nuovaPassword: 'una terza password scelta',
      });
      expect(wrong.statusCode, `errore ${i + 1}`).toBe(i < 4 ? 400 : 429);
    }
    const locked = await req(first, 'POST', '/api/profilo/password', {
      passwordAttuale: 'la seconda password scelta',
      nuovaPassword: 'una terza password scelta',
    });
    expect(locked.statusCode).toBe(429);
    expect((await access(u.username, 'la seconda password scelta')).json().errore).toMatch(
      /bloccato/,
    );
  });

  it('nessuna password, impronta o segreto nel registro', async () => {
    const rows = await t.db.select().from(accessLog).where(eq(accessLog.studioId, s.studioId));
    const text = JSON.stringify(rows.map((r) => r.details));
    expect(passwordsSeen.length).toBeGreaterThan(8);
    for (const p of passwordsSeen) expect(text).not.toContain(p);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/scrypt\$|totp/i);
  });
});
