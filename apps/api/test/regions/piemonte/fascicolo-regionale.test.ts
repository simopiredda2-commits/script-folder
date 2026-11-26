import type { FseAccessRequest, FseAccessResult, RegionalFseAccess } from '@mmg/integrations';
import { SimulatedRegionalFseAccess, type FseAccessErrorCode } from '@mmg/regions/piemonte';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app';
import {
  accessLog,
  patient,
  serviceCredential,
  serviceCredentialEvent,
} from '../../../src/db/schema';
import { createScenario, login, type Scenario } from '../../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-db';

type Decision = 'success' | 'unreachable' | FseAccessErrorCode;

/**
 * Aprire il Fascicolo regionale dalla cartella (D220), con il simulatore del modulo di accesso del
 * CSI (LCCE V13): chi può, che cosa si registra, le credenziali RUPAR del medico, gli errori delle
 * specifiche, la pagina simulata con il token che vale una volta.
 */
describe('apertura del Fascicolo regionale dalla cartella (D220, LCCE V13)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let decision: Decision = 'success';
  const access = new SimulatedRegionalFseAccess({ decide: () => decision });
  const cookies = { titolare: '', collega: '', segreteria: '', sostituto: '', amministratore: '' };
  type Who = keyof typeof cookies;
  let pt: typeof patient.$inferSelect;

  const open = (who: Who, payload: Record<string, unknown> = {}, patientId = pt.id) =>
    s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${patientId}/fascicolo-regionale`,
      headers: { cookie: cookies[who] },
      payload,
    });
  const page = (url: string, who: Who = 'titolare', remoteAddress = '127.0.0.1') =>
    s.app.inject({ method: 'GET', url, headers: { cookie: cookies[who] }, remoteAddress });
  const lastLog = async (userId: string) => {
    const [row] = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.userId, userId), eq(accessLog.action, 'apertura_fascicolo_regionale')),
      )
      .orderBy(desc(accessLog.id))
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { fseAccess: access });
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    const [row] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    pt = row!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('il medico chiede il token con le sue credenziali RUPAR e apre la pagina una volta sola', async () => {
    decision = 'success';
    const before = access.received.length;
    const res = await open('titolare');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ indirizzo: string; simulato: boolean }>();
    expect(body.simulato).toBe(true);
    expect(body.indirizzo).toMatch(/^\/api\/simulatori\/fascicolo\?token=[0-9a-f-]{36}$/);
    // Al servizio vanno il codice fiscale del paziente, l'IP di chi chiede, ruolo e applicazione.
    expect(access.received.slice(before)).toEqual([
      {
        patientFiscalCode: pt.fiscalCode,
        clientIp: '127.0.0.1',
        documentType: null,
        role: 'MMG',
        application: 'DMAWACCE',
      },
    ]);
    // Ogni apertura resta nel registro degli accessi alla cartella.
    expect(await lastLog(s.users.titolare.id)).toMatchObject({
      patientId: pt.id,
      outcome: 'consentito',
      details: { permesso: 'fse.consult' },
    });
    // Il token vale una volta; l'IP di chi apre si traccia, non si confronta (V13, 2.2): anche da
    // un altro indirizzo la pagina si apre.
    const ok = await page(body.indirizzo, 'titolare', '198.51.100.7');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/html/);
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toContain(`Fascicolo dell’assistito ${pt.fiscalCode}`);
    const again = await page(body.indirizzo);
    expect(again.statusCode).toBe(403);
    expect(again.body).toContain('Token di autenticazione non valido (WEB_001)');
  });

  it('con il filtro dei documenti: solo i tipi delle specifiche', async () => {
    decision = 'success';
    const res = await open('titolare', { tipoDocumento: '11502-2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(access.received.at(-1)).toMatchObject({ documentType: '11502-2' });
    const shown = await page(res.json<{ indirizzo: string }>().indirizzo);
    expect(shown.body).toContain('con i documenti di tipo REFERTO DI LABORATORIO');
    const before = access.received.length;
    const wrong = await open('titolare', { tipoDocumento: 'XYZ' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errore).toMatch(/non previsto dalle specifiche/);
    // Nemmeno i nomi che ogni oggetto ha dal suo prototipo (D232).
    for (const tipoDocumento of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await open('titolare', { tipoDocumento });
      expect(res.statusCode, tipoDocumento).toBe(400);
    }
    // Nessuna richiesta parte con un tipo sbagliato; il tentativo resta nel registro.
    expect(access.received.length).toBe(before);
    expect((await lastLog(s.users.titolare.id))?.outcome).toBe('consentito');
  });

  it('il sostituto autorizzato sull’archivio apre con le sue credenziali; segreteria, amministratore e collega no', async () => {
    decision = 'success';
    const res = await open('sostituto');
    expect(res.statusCode, res.body).toBe(200);
    expect(await lastLog(s.users.sostituto.id)).toMatchObject({ outcome: 'consentito' });
    for (const who of ['segreteria', 'amministratore', 'collega'] as const) {
      const before = access.received.length;
      const denied = await open(who);
      expect(denied.statusCode, who).toBe(403);
      expect(access.received.length).toBe(before);
      expect(await lastLog(s.users[who].id)).toMatchObject({ patientId: pt.id, outcome: 'negato' });
    }
  });

  it('gli errori del servizio arrivano al medico con il codice delle specifiche', async () => {
    decision = 'FSE_ER_505';
    const consent = await open('titolare');
    expect(consent.statusCode).toBe(422);
    expect(consent.json()).toEqual({
      errore: 'Il paziente non ha fornito il consenso alla consultazione (FSE_ER_505)',
      dettagli: { codiceFascicolo: 'FSE_ER_505' },
    });
    decision = 'unreachable';
    const down = await open('titolare');
    expect(down.statusCode).toBe(503);
    expect(down.json().errore).toMatch(/non raggiungibile.*riprova più tardi/);
  });

  it('credenziali rifiutate dalla Regione: si annota e si porta il medico alle credenziali', async () => {
    decision = 'AUTH_ER_501';
    const res = await open('titolare');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      errore: expect.stringMatching(
        /Errore di autenticazione \(AUTH_ER_501\).*«Credenziali dei servizi»/,
      ),
      dettagli: {
        codice: 'CREDENZIALI_RIFIUTATE',
        servizio: 'rupar',
        codiceFascicolo: 'AUTH_ER_501',
      },
    });
    const events = await t.db
      .select()
      .from(serviceCredentialEvent)
      .where(
        and(
          eq(serviceCredentialEvent.userId, s.users.titolare.id),
          eq(serviceCredentialEvent.event, 'credenziali_rifiutate'),
        ),
      );
    expect(events.map((e) => [e.service, e.detail])).toEqual([
      ['rupar_piemonte', 'AUTH_ER_501: Errore di autenticazione'],
    ]);
  });

  it('PIN o credenziali mancanti per la Regione (V13: AUTH_ER_510, AUTH_ER_516): come le credenziali rifiutate', async () => {
    for (const code of ['AUTH_ER_510', 'AUTH_ER_516'] as const) {
      decision = code;
      const res = await open('titolare');
      expect(res.statusCode, code).toBe(422);
      expect(res.json(), code).toMatchObject({
        errore: expect.stringMatching(/«Credenziali dei servizi»/),
        dettagli: { codice: 'CREDENZIALI_RIFIUTATE', servizio: 'rupar', codiceFascicolo: code },
      });
    }
    // Un altro errore della tabella 1 non porta alle credenziali.
    decision = 'AUTH_ER_502';
    const role = await open('titolare');
    expect(role.statusCode).toBe(422);
    expect(role.json()).toEqual({
      errore: 'Ruolo non valido (AUTH_ER_502)',
      dettagli: { codiceFascicolo: 'AUTH_ER_502' },
    });
    // Si annotano come le credenziali rifiutate.
    const events = await t.db
      .select()
      .from(serviceCredentialEvent)
      .where(
        and(
          eq(serviceCredentialEvent.userId, s.users.titolare.id),
          eq(serviceCredentialEvent.event, 'credenziali_rifiutate'),
        ),
      );
    expect(events.map((e) => e.detail)).toEqual(
      expect.arrayContaining([
        'AUTH_ER_510: Il parametro Pin del richiedente deve essere valorizzato',
        'AUTH_ER_516: Le credenziali devono essere valorizzate',
      ]),
    );
  });

  it('senza credenziali RUPAR la richiesta non parte', async () => {
    decision = 'success';
    await t.db
      .delete(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    const before = access.received.length;
    const res = await open('titolare');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      errore: expect.stringMatching(/Mancano le credenziali RUPAR Piemonte/),
      dettagli: { codice: 'CREDENZIALI_MANCANTI', servizio: 'rupar' },
    });
    expect(access.received.length).toBe(before);
  });
});

describe('Fascicolo regionale fuori dal simulatore (D220)', () => {
  let t: TestDatabase;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('con il simulatore, in produzione, l’apertura è spenta e il simulatore non sente niente', async () => {
    const simulator = new SimulatedRegionalFseAccess();
    const app = buildApp({
      db: t.db,
      config: {
        encryptionKey: s.encryptionKey,
        sessionMaxHours: 12,
        cookieSecure: false,
        environment: 'produzione',
      },
      now: s.clock.now,
      secondFactor: s.secondFactor,
      fseAccess: simulator,
    });
    try {
      const cookie = await login(s, 'titolare');
      const res = await app.inject({
        method: 'POST',
        url: `/api/pazienti/${s.richPatient}/fascicolo-regionale`,
        headers: { cookie },
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().errore).toMatch(/non è ancora attivo: si attiva con il CSI Piemonte/);
      expect(simulator.received).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('con un collegamento vero la pagina simulata non c’è', async () => {
    const calls: FseAccessRequest[] = [];
    const real: RegionalFseAccess = {
      environment: 'test',
      documentTypes: {},
      texts: {
        intro: 'Introduzione (prova)',
        simulated: 'Simulato (prova)',
        notActive: 'Non attivo (prova)',
        credentials: 'Controlla le credenziali (prova)',
      },
      credentialService: 'prova',
      authenticate: (request): Promise<FseAccessResult> => {
        calls.push(request);
        return Promise.resolve({ outcome: 'success', url: 'https://regione.invalid/fse?token=1' });
      },
    };
    const app = buildApp({
      db: t.db,
      config: { encryptionKey: s.encryptionKey, sessionMaxHours: 12, cookieSecure: false },
      now: s.clock.now,
      secondFactor: s.secondFactor,
      fseAccess: real,
    });
    try {
      const cookie = await login(s, 'titolare');
      const res = await app.inject({
        method: 'POST',
        url: `/api/pazienti/${s.richPatient}/fascicolo-regionale`,
        headers: { cookie },
        payload: {},
      });
      expect(res.json()).toEqual({
        indirizzo: 'https://regione.invalid/fse?token=1',
        simulato: false,
      });
      expect(calls).toHaveLength(1);
      const sim = await app.inject({
        method: 'GET',
        url: '/api/simulatori/fascicolo?token=1',
        headers: { cookie },
      });
      expect(sim.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
