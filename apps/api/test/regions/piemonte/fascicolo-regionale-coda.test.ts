import {
  FseGatewayClient,
  SIMULATED_FSE_AUDIENCE,
  SimulatedDocumentSigner,
  SimulatedFseGateway,
  type SimulatedFseOutcome,
} from '@mmg/integrations';
import {
  FSE_PUBLICATION_POLICY,
  RegionalFseClient,
  SimulatedRegionalFse,
  V09FsePublication,
  type RegionalFseTransport,
  type RegionalSoapRequest,
  type SimulatedRegionalOutcome,
} from '@mmg/regions/piemonte';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  doctorProfile,
  fseRegionalSend,
  fseSetting,
  fseTransmission,
  patient,
  pssDocument,
  pssFile,
  serviceCredential,
  serviceCredentialEvent,
} from '../../../src/db/schema';
import {
  createRegionalQueue,
  inQuietHours,
  LEASE_MS,
  nextAttempt,
  outsideQuietHours,
  romeHour,
} from '../../../src/fse/regional-queue';
import { regionalChoice } from '../../../src/regions/integrations';
import { createScenario, login, type Scenario } from '../../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-db';

/**
 * Coda verso il Fascicolo regionale con le politiche di invio della Regione (D280): la coda
 * nazionale con la pubblicazione del pacchetto del Piemonte (D297).
 */

interface Send {
  operazione: string;
  stato: string;
  tentativi: number;
  fase: string;
  prossimoTentativo: string | null;
  ultimoErrore: string | null;
}
interface Pss {
  id: string;
  stato: string;
  versione: number;
  oscurato: boolean;
  identificativoFascicolo: string | null;
  fascicolo: Send | null;
  ultimoProblema: { detail: string } | null;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
// I valori delle politiche di invio (4.1, 4.2), scritti qui e non presi dal codice: un valore
// sbagliato nel codice si vede.
const RETRY_DELAY_MS = 5 * MINUTE;
const FALLBACK_DAYS = 10;
const QUIET_UNTIL = 7;
const policy = FSE_PUBLICATION_POLICY;

describe('orari e tentativi delle politiche di invio (FSE-INT-SRS-01-V02)', () => {
  it('le politiche della Regione nel pacchetto: fermo fino alle 07, 3 secondi, 3 a 5 minuti, 10 giorni', () => {
    expect(FSE_PUBLICATION_POLICY).toEqual({
      quietUntilHour: QUIET_UNTIL,
      minIntervalMs: 3000,
      retries: 3,
      retryDelayMs: RETRY_DELAY_MS,
      fallbackDays: FALLBACK_DAYS,
    });
  });

  it('fermo dalle 00 alle 07 di Roma, anche con l’ora legale', () => {
    const quiet = policy.quietUntilHour;
    expect(inQuietHours(new Date('2026-11-18T23:30:00Z'), quiet)).toBe(true); // 00:30 a Roma
    expect(inQuietHours(new Date('2026-11-18T05:59:00Z'), quiet)).toBe(true); // 06:59
    expect(inQuietHours(new Date('2026-11-18T06:00:00Z'), quiet)).toBe(false); // 07:00
    expect(inQuietHours(new Date('2026-11-18T22:59:00Z'), quiet)).toBe(false); // 23:59
    expect(romeHour(new Date('2026-11-18T01:00:00Z'), QUIET_UNTIL).toISOString()).toBe(
      '2026-11-18T06:00:00.000Z',
    );
    // Ora legale: le 07 di Roma sono le 05 UTC.
    expect(romeHour(new Date('2026-07-01T01:00:00Z'), QUIET_UNTIL).toISOString()).toBe(
      '2026-07-01T05:00:00.000Z',
    );
    // Il giorno del cambio d'ora (29/3/2026, alle 02 si va alle 03).
    expect(romeHour(new Date('2026-03-29T00:30:00Z'), QUIET_UNTIL).toISOString()).toBe(
      '2026-03-29T05:00:00.000Z',
    );
    expect(outsideQuietHours(new Date('2026-11-18T01:00:00Z'), quiet).toISOString()).toBe(
      '2026-11-18T06:00:00.000Z',
    );
    expect(outsideQuietHours(new Date('2026-11-18T10:00:00Z'), quiet).toISOString()).toBe(
      '2026-11-18T10:00:00.000Z',
    );
  });

  it('il primo invio e tre ripetizioni a 5 minuti, poi dieci tentativi al giorno, poi «failed»', () => {
    let s = { attempts: 0, phase: 'ripetizione', queuedSince: null as Date | null };
    let at = new Date('2026-11-18T10:00:00Z');
    const times: string[] = [];
    for (;;) {
      const n = nextAttempt(s, at, policy);
      if (n === 'failed') break;
      times.push(`${n.phase} ${(n.at.getTime() - at.getTime()) / MINUTE}`);
      s = n;
      at = n.at;
    }
    expect(times).toEqual([
      'ripetizione 5',
      'ripetizione 5',
      'ripetizione 5',
      ...Array.from({ length: FALLBACK_DAYS }, () => `coda ${DAY / MINUTE}`),
    ]);
    // A 5 minuti dalla mezzanotte, la ripetizione va alle 07.
    const late = nextAttempt(
      { attempts: 0, phase: 'ripetizione', queuedSince: null },
      new Date('2026-11-18T22:58:00Z'),
      policy,
    );
    expect(late !== 'failed' && late.at.toISOString()).toBe('2026-11-19T06:00:00.000Z');
  });
});

describe('coda verso il Fascicolo regionale (V09, D280)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let regional: SimulatedRegionalOutcome = 'ok';
  let publication: SimulatedFseOutcome = 'ok';
  let statusMode: SimulatedFseOutcome = 'ok';
  let enrolled = true;
  let pinAccepted = true;
  /** Il Fascicolo lavora il messaggio ma la risposta si perde: il tempo scade. */
  let loseResponse = false;
  const times: number[] = [];
  let regionalClient: RegionalFseClient;

  beforeAll(async () => {
    t = await createTestDatabase();
    let clock = () => new Date();
    const now = () => clock();
    const gateway = new SimulatedFseGateway({
      now,
      decide: (op) =>
        op === 'publication' || op === 'replacement'
          ? publication
          : op === 'status'
            ? statusMode
            : 'ok',
    });
    const sim = new SimulatedRegionalFse({
      gateway,
      now,
      decide: () => regional,
      patient: () => ({ enrolled, consent: true }),
      credentials: (u, p, pin) => !!u && !!p && !!pin && pinAccepted,
    });
    // Il trasporto che guarda passare i messaggi: per i 3 secondi fra due invii (4.3).
    const spy: RegionalFseTransport = {
      environment: 'simulator',
      send: async (req: RegionalSoapRequest) => {
        times.push(Date.now());
        const res = await sim.send(req);
        return loseResponse ? { error: 'timeout' as const } : res;
      },
    };
    s = await createScenario(
      t.db,
      {},
      {
        fse: {
          gateway: new FseGatewayClient(gateway, gateway.issueCredentials('Prova'), now),
          audience: SIMULATED_FSE_AUDIENCE,
          signer: new SimulatedDocumentSigner({ now }),
          regional: new V09FsePublication(
            (regionalClient = new RegionalFseClient(spy, {
              encryptionCertificate: sim.encryptionCertificate,
              application: { id: 'PROVA', vendor: 'PROVA', version: '0' },
            })),
          ),
        },
        // Il fermo notturno vale anche con il simulatore, per provarlo; 120 ms fra due messaggi.
        fseQueue: { intervalMs: null, minIntervalMs: 120, quietHours: true },
        // Le 11 di Roma.
        clockAt: new Date('2026-11-18T10:00:00Z'),
      },
    );
    clock = () => s.clock.now();
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const base = () => `/api/pazienti/${s.richPatient}/profilo-sanitario`;
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, cookie = doctor) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await req(method, url, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<T>();
  };
  /** Una versione nuova, validata: pronta da firmare. */
  async function validated() {
    const draft = await ok<Pss>('POST', `${base()}/bozza`);
    await ok('POST', `${base()}/${draft.id}/valida`, { confermo: true });
    return draft;
  }
  const publish = (id: string) => ok<Pss>('POST', `${base()}/${id}/firma-e-pubblica`);
  /**
   * I messaggi al Fascicolo regionale nel registro, nell'ordine in cui sono stati scritti. Con
   * l'orologio fermo delle prove l'ora è spesso la stessa: l'ordine lo dà la transazione che ha
   * scritto la riga (ognuna nella sua), non la posizione nel database, che può cambiare.
   */
  const regionalCalls = async (id: string) =>
    (
      await t.db
        .select()
        .from(fseTransmission)
        .where(eq(fseTransmission.documentId, id))
        .orderBy(asc(fseTransmission.at), sql`(xmin::text)::bigint`)
    )
      .filter((c) => c.operation.startsWith('regional_'))
      .map((c) => `${c.operation} ${c.outcome}`);
  const queue = () => s.app.fseRegionalQueue.kick();
  /** Sposta l'orologio e rientra: la sessione dura 12 ore. */
  async function later(ms: number) {
    s.clock.advance(ms);
    doctor = await login(s, 'titolare');
  }

  it('si pubblica: CREATE ed esito; con la versione dopo, ricerca e REPLACE a 120 ms di distanza', async () => {
    const v1 = await validated();
    const p1 = await publish(v1.id);
    expect(p1).toMatchObject({
      stato: 'published',
      fascicolo: { operazione: 'create', stato: 'done' },
    });
    expect(await regionalCalls(v1.id)).toEqual(['regional_create ok', 'regional_outcome ok']);
    times.length = 0;
    const v2 = await validated();
    const p2 = await publish(v2.id);
    expect(p2).toMatchObject({ stato: 'published', fascicolo: { operazione: 'replace' } });
    expect(await regionalCalls(v2.id)).toEqual([
      'regional_search ok',
      'regional_replace ok',
      'regional_outcome ok',
    ]);
    // Fra la ricerca e la sostituzione, e prima della richiesta dell'esito, almeno l'intervallo
    // della coda.
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(110);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(110);
  });

  it('dalle 00 alle 07 il Profilo resta in coda e parte alle 07', async () => {
    const v = await validated();
    // Le 01:30 di Roma del giorno dopo.
    await later(14.5 * 3_600_000 - 60_000);
    const queued = await publish(v.id);
    expect(queued).toMatchObject({ stato: 'signed', fascicolo: { stato: 'queued', tentativi: 0 } });
    expect(new Date(queued.fascicolo!.prossimoTentativo!).toISOString()).toBe(
      '2026-11-19T06:00:00.000Z',
    );
    expect(await regionalCalls(v.id)).toEqual([]);
    // «Riprova» di notte: la coda non manda, il messaggio parte alle 07.
    const retried = await ok<Pss>('POST', `${base()}/${v.id}/stato`);
    expect(retried.fascicolo).toMatchObject({ stato: 'queued' });
    expect(new Date(retried.fascicolo!.prossimoTentativo!).toISOString()).toBe(
      '2026-11-19T06:00:00.000Z',
    );
    expect(await regionalCalls(v.id)).toEqual([]);
    await later(5 * 3_600_000);
    await queue();
    expect(await regionalCalls(v.id)).toEqual([]);
    await later(31 * MINUTE);
    await queue();
    const after = await ok<{ versioni: Pss[] }>('GET', base());
    expect(after.versioni[0]).toMatchObject({ id: v.id, stato: 'published' });
  });

  it('rete assente: tre ripetizioni a 5 minuti, dieci giorni di coda, poi da segnalare al CSI', async () => {
    const v = await validated();
    regional = 'unreachable';
    const first = await publish(v.id);
    expect(first.fascicolo).toMatchObject({ stato: 'queued', tentativi: 1, fase: 'ripetizione' });
    expect(first.fascicolo!.ultimoErrore).toBe('Fascicolo regionale non raggiungibile');
    // Prima dei 5 minuti la coda non riprova.
    s.clock.advance(4 * MINUTE);
    await queue();
    expect(await regionalCalls(v.id)).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      s.clock.advance(RETRY_DELAY_MS);
      await queue();
    }
    expect(await regionalCalls(v.id)).toHaveLength(4);
    let [row] = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, v.id));
    expect(row).toMatchObject({ status: 'queued', phase: 'coda', attempts: 0 });
    for (let day = 0; day < FALLBACK_DAYS; day++) {
      await later(DAY);
      await queue();
    }
    expect(await regionalCalls(v.id)).toHaveLength(4 + FALLBACK_DAYS);
    [row] = await t.db.select().from(fseRegionalSend).where(eq(fseRegionalSend.documentId, v.id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('supporto.fse@csi.it');
    // Un altro giro non lo manda più; «Riprova» sì. Dopo 5 giorni il Gateway non lo pubblica.
    await later(DAY);
    await queue();
    expect(await regionalCalls(v.id)).toHaveLength(4 + FALLBACK_DAYS);
    regional = 'ok';
    const retried = await ok<Pss>('POST', `${base()}/${v.id}/stato`);
    expect(retried.stato).toBe('rejected');
    expect(retried.fascicolo!.ultimoErrore).toMatch(/Scartato dal Fascicolo regionale: .*5 days/);
  });

  it('errore di sistema (INI-9000): si ripete; assistito non iscritto: si corregge, non si ripete', async () => {
    regional = 'system-error';
    const v = await validated();
    const sent = await publish(v.id);
    expect(sent.fascicolo).toMatchObject({ stato: 'queued', tentativi: 1 });
    expect(sent.fascicolo!.ultimoErrore).toContain('INI-9000');
    regional = 'ok';
    enrolled = false;
    await later(RETRY_DELAY_MS);
    await queue();
    let seen = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    expect(seen.fascicolo).toMatchObject({ stato: 'to_fix' });
    expect(seen.fascicolo!.ultimoErrore).toContain('SIM_NON_ISCRITTO');
    // Da correggere: il tempo che passa non lo rimanda.
    const calls = (await regionalCalls(v.id)).length;
    await later(RETRY_DELAY_MS * 2);
    await queue();
    expect(await regionalCalls(v.id)).toHaveLength(calls);
    enrolled = true;
    seen = await ok<Pss>('POST', `${base()}/${v.id}/stato`);
    expect(seen.stato).toBe('published');
  });

  it('credenziali: senza quelle RUPAR o con il PIN rifiutato, da correggere; il rifiuto si annota', async () => {
    const v = await validated();
    const saved = await t.db
      .select()
      .from(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    pinAccepted = false;
    const refused = await publish(v.id);
    expect(refused.fascicolo).toMatchObject({ stato: 'to_fix' });
    expect(refused.fascicolo!.ultimoErrore).toContain('Credenziali dei servizi');
    const events = await t.db
      .select()
      .from(serviceCredentialEvent)
      .where(eq(serviceCredentialEvent.userId, s.users.titolare.id));
    expect(events.map((e) => e.event)).toContain('credenziali_rifiutate');
    pinAccepted = true;
    await t.db
      .delete(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    const missing = await ok<Pss>('POST', `${base()}/${v.id}/stato`);
    expect(missing.fascicolo!.ultimoErrore).toContain('utente, password e PIN RUPAR');
    await t.db.insert(serviceCredential).values(saved);
    expect((await ok<Pss>('POST', `${base()}/${v.id}/stato`)).stato).toBe('published');
  });

  it('il Gateway non pubblica: «KO», il Profilo è scartato dal Fascicolo; se ne prepara un altro', async () => {
    const v = await validated();
    publication = 'internal-error';
    const p = await publish(v.id);
    publication = 'ok';
    expect(p.stato).toBe('rejected');
    expect(p.ultimoProblema!.detail).toContain('Gateway');
    // La risposta della Regione è definitiva: il messaggio è chiuso e «Riprova» non serve.
    expect(p.fascicolo).toMatchObject({ stato: 'done' });
    const again = await req('POST', `${base()}/${v.id}/stato`);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ errore: string }>().errore).toContain('preparane una versione nuova');
    const next = await validated();
    expect(next.stato).toBe('draft');
    expect((await publish(next.id)).stato).toBe('published');
  });

  it('«ELAB»: la coda richiede l’esito da sé, dopo un minuto', async () => {
    const v = await validated();
    statusMode = 'ini-pending';
    publication = 'ini-pending';
    const p = await publish(v.id);
    expect(p).toMatchObject({ stato: 'submitted', fascicolo: { stato: 'waiting' } });
    statusMode = 'ok';
    publication = 'ok';
    await queue();
    expect((await ok<{ inLavorazione: Pss | null }>('GET', base())).inLavorazione!.stato).toBe(
      'submitted',
    );
    await later(MINUTE);
    await queue();
    const after = await ok<{ versioni: Pss[]; inLavorazione: Pss | null }>('GET', base());
    expect(after.inLavorazione).toBeNull();
    expect(after.versioni[0]).toMatchObject({ id: v.id, stato: 'published' });
  });

  it('oscuramento su richiesta dell’assistito e cancellazione: solo i metadati, poi il documento', async () => {
    const current = (await ok<{ versioni: Pss[] }>('GET', base())).versioni[0]!;
    expect(current.stato).toBe('published');
    const url = `${base()}/${current.id}`;
    expect((await req('POST', `${url}/oscuramento`, { oscurato: true })).statusCode).toBe(400);
    const obscured = await ok<Pss>('POST', `${url}/oscuramento`, {
      oscurato: true,
      richiestaAssistito: true,
    });
    expect(obscured).toMatchObject({
      oscurato: true,
      fascicolo: { operazione: 'update', stato: 'done' },
    });
    expect(
      (await req('POST', `${url}/oscuramento`, { oscurato: true, richiestaAssistito: true }))
        .statusCode,
    ).toBe(409);
    const update = (
      await t.db.select().from(fseTransmission).where(eq(fseTransmission.documentId, current.id))
    ).find((c) => c.operation === 'regional_update')!;
    expect(update.request).toContain('<tip:RegoleAccesso>P99</tip:RegoleAccesso>');
    expect(update.request).not.toContain('<documento>');
    const back = await ok<Pss>('POST', `${url}/oscuramento`, {
      oscurato: false,
      richiestaAssistito: true,
    });
    expect(back.oscurato).toBe(false);
    expect((await req('POST', `${url}/cancella`, {})).statusCode).toBe(400);
    const deleted = await ok<Pss>('POST', `${url}/cancella`, { confermo: true });
    expect(deleted).toMatchObject({
      stato: 'deleted',
      fascicolo: { operazione: 'delete', stato: 'done' },
    });
    // Con l'orologio fermo i messaggi restano in ordine: ognuno dopo quello di prima (3.1).
    const sends = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, current.id))
      .orderBy(asc(fseRegionalSend.createdAt));
    expect(sends.slice(-3).map((x) => x.operation)).toEqual(['update', 'update', 'delete']);
    expect(new Set(sends.map((x) => x.createdAt.getTime())).size).toBe(sends.length);
    expect((await req('POST', `${url}/cancella`, { confermo: true })).statusCode).toBe(409);
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(eq(accessLog.patientId, s.richPatient));
    expect(logged.map((l) => l.action)).toEqual(
      expect.arrayContaining(['oscuramento_profilo_sanitario', 'cancellazione_profilo_sanitario']),
    );
    // Dopo la cancellazione il Profilo nuovo è un documento nuovo (CREATE).
    const fresh = await validated();
    expect((await publish(fresh.id)).fascicolo).toMatchObject({ operazione: 'create' });
  });

  it('l’amministratore sospende gli invii (richiesta del CSI): restano in coda e partono alla ripresa', async () => {
    const admin = await login(s, 'amministratore');
    const put = (cookie: string, payload: object) =>
      s.app.inject({
        method: 'PUT',
        url: '/api/studio/fascicolo/invii',
        headers: { cookie },
        payload,
      });
    expect((await put(doctor, { sospesi: true })).statusCode).toBe(403);
    expect(
      (await put(admin, { sospesi: true, motivo: 'Richiesta del supporto del CSI' })).statusCode,
    ).toBe(200);
    const v = await validated();
    const p = await publish(v.id);
    expect(p).toMatchObject({ stato: 'signed', fascicolo: { stato: 'queued' } });
    expect(await regionalCalls(v.id)).toEqual([]);
    expect(
      (await ok<{ inviiSospesi: { motivo: string } | null }>('GET', base())).inviiSospesi,
    ).toMatchObject({
      motivo: 'Richiesta del supporto del CSI',
    });
    expect((await put(admin, { sospesi: false })).statusCode).toBe(200);
    await queue();
    expect((await ok<{ versioni: Pss[] }>('GET', base())).versioni[0]).toMatchObject({
      id: v.id,
      stato: 'published',
    });
    const admins = await t.db
      .select()
      .from(accessLog)
      .where(eq(accessLog.action, 'amministrazione'));
    expect(admins.map((a) => (a.details as { azione?: string }).azione)).toEqual(
      expect.arrayContaining(['sospensione_invii_fascicolo', 'ripresa_invii_fascicolo']),
    );
  });

  it('il sostituto non oscura né cancella il Profilo del titolare; il regime vuole un codice della Regione', async () => {
    const current = (await ok<{ versioni: Pss[] }>('GET', base())).versioni[0]!;
    expect(current.stato).toBe('published');
    const sostituto = await login(s, 'sostituto');
    const url = `${base()}/${current.id}`;
    const o = await req(
      'POST',
      `${url}/oscuramento`,
      { oscurato: true, richiestaAssistito: true },
      sostituto,
    );
    expect(o.statusCode).toBe(403);
    const d = await req('POST', `${url}/cancella`, { confermo: true }, sostituto);
    expect(d.statusCode).toBe(403);
    await t.db
      .update(fseSetting)
      .set({ administrativeRequest: 'AUTO' })
      .where(eq(fseSetting.studioId, s.studioId));
    const seen = await ok<{ mancano: string[] }>('GET', base());
    expect(seen.mancano.join(' ')).toContain('regime fra quelli della Regione');
    await t.db
      .update(fseSetting)
      .set({ administrativeRequest: 'SSN' })
      .where(eq(fseSetting.studioId, s.studioId));
  });

  it('nel database: dal cancellato non si torna indietro e l’OID del Fascicolo non cambia', async () => {
    const versions = (await ok<{ versioni: Pss[] }>('GET', base())).versioni;
    // Drizzle avvolge l'errore del database: il messaggio del trigger è nella causa.
    const refused = async (q: PromiseLike<unknown>) => {
      try {
        await q;
      } catch (e) {
        return String((e as { cause?: Error }).cause?.message ?? e);
      }
      return 'accettato';
    };
    const deleted = versions.find((v) => v.stato === 'deleted')!;
    expect(
      await refused(
        t.db.update(pssDocument).set({ status: 'published' }).where(eq(pssDocument.id, deleted.id)),
      ),
    ).toMatch(/passaggio non ammesso/);
    const published = versions.find((v) => v.stato === 'published')!;
    expect(
      await refused(
        t.db
          .update(pssDocument)
          .set({ regionalOid: '2.999^1' })
          .where(eq(pssDocument.id, published.id)),
      ),
    ).toMatch(/non cambia/);
    expect(await refused(t.db.delete(fseRegionalSend))).toMatch(/non si cancellano/);
  });

  it('in ordine: un messaggio aspetta quello fatto prima per lo stesso Profilo', async () => {
    const current = (await ok<{ versioni: Pss[] }>('GET', base())).versioni[0]!;
    const at = s.clock.now();
    // Due oscuramenti per lo stesso documento, il primo non ancora da mandare.
    const [first] = await t.db
      .insert(fseRegionalSend)
      .values({
        documentId: current.id,
        doctorUserId: s.users.titolare.id,
        operation: 'update',
        confidentiality: 'V',
        createdAt: new Date(at.getTime() - 2 * MINUTE),
        nextAttemptAt: new Date(at.getTime() + 60 * MINUTE),
      })
      .returning();
    const [second] = await t.db
      .insert(fseRegionalSend)
      .values({
        documentId: current.id,
        doctorUserId: s.users.titolare.id,
        operation: 'update',
        confidentiality: 'N',
        createdAt: new Date(at.getTime() - MINUTE),
        nextAttemptAt: at,
      })
      .returning();
    await queue();
    const status = async (id: string) =>
      (await t.db.select().from(fseRegionalSend).where(eq(fseRegionalSend.id, id)))[0]!.status;
    expect(await status(second!.id)).toBe('queued');
    await t.db
      .update(fseRegionalSend)
      .set({ nextAttemptAt: at })
      .where(eq(fseRegionalSend.id, first!.id));
    await queue();
    expect([await status(first!.id), await status(second!.id)]).toEqual(['done', 'done']);
    const [doc] = await t.db.select().from(pssDocument).where(eq(pssDocument.id, current.id));
    expect(doc!.confidentiality).toBe('N');
  });

  it('cancellazione con la risposta persa: al tentativo dopo «1103» vuol dire già cancellato', async () => {
    const v = await validated();
    expect((await publish(v.id)).stato).toBe('published');
    loseResponse = true;
    const sent = await ok<Pss>('POST', `${base()}/${v.id}/cancella`, { confermo: true });
    loseResponse = false;
    expect(sent).toMatchObject({
      stato: 'published',
      fascicolo: { stato: 'queued', tentativi: 1 },
    });
    await later(RETRY_DELAY_MS);
    await queue();
    const after = (await ok<{ versioni: Pss[] }>('GET', base())).versioni.find(
      (x) => x.id === v.id,
    )!;
    expect(after.stato).toBe('deleted');
    expect(after.fascicolo!.ultimoErrore).toContain('non è più nel Fascicolo');
  });

  it('«ELAB» per più di dieci giorni: da segnalare al CSI', async () => {
    const v = await validated();
    statusMode = 'ini-pending';
    publication = 'ini-pending';
    expect((await publish(v.id)).stato).toBe('submitted');
    await later(FALLBACK_DAYS * DAY + MINUTE);
    await queue();
    statusMode = 'ok';
    publication = 'ok';
    const [row] = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, v.id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('supporto.fse@csi.it');
    // «Riprova» chiede di nuovo l'esito: il Fascicolo ha finito.
    expect((await ok<Pss>('POST', `${base()}/${v.id}/stato`)).stato).toBe('published');
  });

  it('scartare: sì il Profilo firmato non preso in carico; no quello preso in carico', async () => {
    regional = 'unreachable';
    const v = await validated();
    expect((await publish(v.id)).fascicolo).toMatchObject({ stato: 'queued' });
    regional = 'ok';
    const discarded = await ok<Pss>('POST', `${base()}/${v.id}/scarta`);
    expect(discarded).toMatchObject({ stato: 'discarded', fascicolo: { stato: 'cancelled' } });
    await later(RETRY_DELAY_MS);
    await queue();
    expect(await regionalCalls(v.id)).toHaveLength(1);
    const w = await validated();
    statusMode = 'ini-pending';
    publication = 'ini-pending';
    expect((await publish(w.id)).stato).toBe('submitted');
    statusMode = 'ok';
    publication = 'ok';
    expect((await req('POST', `${base()}/${w.id}/scarta`)).statusCode).toBe(409);
    // Preso in carico, si chiude con l'esito: la prova dopo prepara una versione nuova.
    expect((await ok<Pss>('POST', `${base()}/${w.id}/stato`)).stato).toBe('published');
  });

  it('il messaggio si prende prima di mandarlo: un altro giro, «Riprova» e lo scarto aspettano', async () => {
    regional = 'unreachable';
    const v = await validated();
    expect((await publish(v.id)).fascicolo).toMatchObject({ stato: 'queued', tentativi: 1 });
    regional = 'ok';
    // Un altro giro, anche di un'altra istanza del servizio, lo sta mandando adesso.
    await t.db
      .update(fseRegionalSend)
      .set({
        nextAttemptAt: s.clock.now(),
        leaseUntil: new Date(s.clock.now().getTime() + LEASE_MS),
      })
      .where(eq(fseRegionalSend.documentId, v.id));
    await queue();
    expect(await regionalCalls(v.id)).toHaveLength(1);
    // «Riprova» non lo manda una seconda volta insieme all'altro giro.
    await ok('POST', `${base()}/${v.id}/stato`);
    expect(await regionalCalls(v.id)).toHaveLength(1);
    // Lo scartare aspetta che il giro finisca.
    const busy = await req('POST', `${base()}/${v.id}/scarta`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json<{ errore: string }>().errore).toContain('sta partendo');
    // Il giro si è interrotto: finita la prenotazione, la coda lo riprende.
    await later(LEASE_MS + 1000);
    await queue();
    // C'è la versione di prima: ricerca e sostituzione.
    expect(await regionalCalls(v.id)).toEqual([
      'regional_search unreachable',
      'regional_search ok',
      'regional_replace ok',
      'regional_outcome ok',
    ]);
    const [row] = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, v.id));
    expect(row).toMatchObject({ status: 'done', leaseUntil: null });
  });

  it('due istanze del servizio insieme: il messaggio parte una volta sola', async () => {
    regional = 'unreachable';
    const v = await validated();
    expect((await publish(v.id)).fascicolo).toMatchObject({ stato: 'queued' });
    regional = 'ok';
    await later(RETRY_DELAY_MS);
    // Un'altra istanza del servizio, con la sua coda, sullo stesso database.
    const other = createRegionalQueue({
      db: t.db,
      publication: regionalChoice(() => null, new V09FsePublication(regionalClient)),
      credentials: {
        authFor: () => Promise.resolve({ username: 'u', password: 'p', pin: '12345' }),
        authRefused: () => Promise.resolve(),
      },
      now: () => s.clock.now(),
      minIntervalMs: 0,
      quietHours: false,
    });
    await Promise.all([queue(), other.kick()]);
    expect(await regionalCalls(v.id)).toEqual([
      'regional_search unreachable',
      'regional_search ok',
      'regional_replace ok',
      'regional_outcome ok',
    ]);
  });

  it('due «Firma e pubblica» insieme: un PDF firmato e un messaggio solo', async () => {
    const v = await validated();
    const [a, b] = await Promise.all([publish(v.id), publish(v.id)]);
    expect(a.stato).toBe('published');
    expect(b.stato).toBe('published');
    const sends = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, v.id));
    expect(sends).toHaveLength(1);
    const signed = await t.db
      .select()
      .from(pssFile)
      .where(and(eq(pssFile.documentId, v.id), eq(pssFile.kind, 'signed_pdf')));
    expect(signed).toHaveLength(1);
    expect(await regionalCalls(v.id)).toEqual([
      'regional_search ok',
      'regional_replace ok',
      'regional_outcome ok',
    ]);
  });

  it('sostituzione senza la versione di prima nel Fascicolo regionale: da segnalare al CSI', async () => {
    // La versione pubblicata, tolta dal Fascicolo regionale fuori dal programma.
    const [last] = await t.db
      .select()
      .from(pssDocument)
      .where(and(eq(pssDocument.patientId, s.richPatient), eq(pssDocument.status, 'published')));
    const [d] = await t.db
      .select()
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    const [pt] = await t.db
      .select({ fiscalCode: patient.fiscalCode })
      .from(patient)
      .where(eq(patient.id, s.richPatient));
    const gone = await regionalClient.remove(
      {
        author: {
          fiscalCode: d!.fiscalCode!,
          firstName: d!.firstName!,
          lastName: d!.lastName!,
          aslCode: d!.aslCode!,
        },
        patientFiscalCode: pt!.fiscalCode,
        documentId: last!.regionalOid!,
      },
      { username: 'u', password: 'p', pin: '12345' },
    );
    expect(gone.outcome).toBe('accepted');
    const v = await validated();
    const r = await publish(v.id);
    expect(r).toMatchObject({
      stato: 'signed',
      fascicolo: { operazione: 'replace', stato: 'to_fix' },
    });
    expect(r.fascicolo!.ultimoErrore).toContain(last!.regionalOid!);
    expect(r.fascicolo!.ultimoErrore).toContain('supporto.fse@csi.it');
  });
});
