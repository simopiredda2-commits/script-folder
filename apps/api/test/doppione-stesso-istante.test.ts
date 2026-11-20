import { randomBytes } from 'node:crypto';
import { generatePatients } from '@mmg/fixtures';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, patient } from '../src/db/schema';
import { inOrderAtTheGate } from './helpers/cancello';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Due registrazioni dello stesso codice fiscale nello stesso istante (D229). Tutte e due passano il
 * controllo del doppione, perché nessuna delle due ha ancora finito; l'indice unico dello studio
 * ferma la seconda. La seconda riceve la stessa risposta del doppione di sempre, e il suo rifiuto
 * resta nel registro degli accessi, come gli altri (D226). Il cancello (helpers/cancello.ts) le
 * ferma dopo il controllo e le fa scrivere una dopo l'altra. Pazienti inventati.
 */

let t: TestDatabase;
let s: Scenario;
/** Il client della prova: tiene il cancello, fuori dal gruppo di connessioni del servizio. */
let monitor: pg.Client;
const cookies = {} as Record<'titolare' | 'collega' | 'segreteria', string>;
const sfx = randomBytes(2).toString('hex');

beforeAll(async () => {
  t = await createTestDatabase();
  monitor = new pg.Client({ connectionString: t.url });
  await monitor.connect();
  s = await createScenario(t.db, { idleLockMinutes: null }, { loginSources: null });
  cookies.titolare = await login(s, 'titolare');
  cookies.collega = await login(s, 'collega');
  cookies.segreteria = await login(s, 'segreteria');
});
afterAll(async () => {
  await s?.app.close();
  await monitor?.end();
  await t?.drop();
});

const person = (n: number) => {
  const [p] = generatePatients({ seed: `doppione-${sfx}-${n}`, count: 1 });
  return {
    cognome: p!.lastName,
    nome: p!.firstName,
    sesso: p!.sex,
    nascita: p!.birthDate,
    luogoNascitaCodice: p!.birthPlace.code,
    luogoNascita: p!.birthPlace.name,
    codiceFiscale: p!.fiscalCode,
  };
};

type Who = keyof typeof cookies;
const send = (who: Who, url: string, payload: object) =>
  s.app.inject({ method: 'POST', url, headers: { cookie: cookies[who] }, payload });
/** «Nuovo paziente», come passo del cancello. */
const newPatient = (who: Who, archive: string, identita: ReturnType<typeof person>) => ({
  userId: s.users[who].id,
  send: () => send(who, '/api/pazienti', { archivioId: archive, identita }),
});
/** La correzione del codice fiscale di un paziente, come passo del cancello. */
const correction = (who: Who, patientId: string, fiscalCode: string) => ({
  userId: s.users[who].id,
  send: () =>
    send(who, `/api/pazienti/${patientId}/identita`, {
      codiceFiscale: fiscalCode,
      motivo: 'Codice fiscale scritto male alla registrazione',
    }),
});

/** Le righe del registro di un'azione su un paziente, con chi le ha fatte. */
const logRows = (patientId: string, action: string) =>
  t.db
    .select({ userId: accessLog.userId, outcome: accessLog.outcome, details: accessLog.details })
    .from(accessLog)
    .where(and(eq(accessLog.patientId, patientId), eq(accessLog.action, action)));

const withCode = (fiscalCode: string) =>
  t.db.select().from(patient).where(eq(patient.fiscalCode, fiscalCode));

/** Un paziente registrato prima, con un codice fiscale suo: quello da correggere. */
async function registered(n: number) {
  const res = await send('titolare', '/api/pazienti', {
    archivioId: s.archives.titolare,
    identita: person(n),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const DUPLICATE = { motivo: 'codice fiscale già registrato per questo paziente' };

describe('due registrazioni dello stesso codice fiscale nello stesso istante (D229)', () => {
  it('nello stesso archivio: la prima entra; la seconda riceve la risposta del doppione, con il paziente, e il rifiuto è nel registro', async () => {
    const p = person(1);
    const [first, second] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      newPatient('titolare', s.archives.titolare, p),
      newPatient('segreteria', s.archives.titolare, p),
    ]);
    expect(first!.statusCode, first!.body).toBe(201);
    const id = first!.json<{ id: string }>().id;
    // La stessa risposta di un doppione arrivato dopo: chi è, con il collegamento alla cartella.
    expect(second!.statusCode, second!.body).toBe(409);
    expect(second!.json()).toMatchObject({
      errore: expect.stringMatching(/^Il codice fiscale è già registrato: /),
      dettagli: { paziente: { id, cognome: p.cognome, nome: p.nome } },
    });
    expect((await withCode(p.codiceFiscale)).map((r) => r.id)).toEqual([id]);
    // Nel registro del paziente: chi l'ha registrato e chi è arrivato secondo.
    const log = await logRows(id, 'nuovo_paziente');
    expect(log).toHaveLength(2);
    expect(log).toContainEqual(
      expect.objectContaining({ userId: s.users.titolare.id, outcome: 'consentito' }),
    );
    expect(log).toContainEqual({
      userId: s.users.segreteria.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: true },
    });
  });

  it('in due archivi: chi arriva secondo non vede l’altro archivio, e la risposta non dice di chi è', async () => {
    const p = person(2);
    const [first, second] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      newPatient('titolare', s.archives.titolare, p),
      newPatient('collega', s.archives.collega, p),
    ]);
    expect(first!.statusCode, first!.body).toBe(201);
    expect(second!.statusCode, second!.body).toBe(409);
    expect(second!.json()).toMatchObject({
      errore: expect.stringMatching(/in un archivio che non puoi vedere/),
      dettagli: { paziente: null },
    });
    const id = first!.json<{ id: string }>().id;
    expect(await logRows(id, 'nuovo_paziente')).toContainEqual({
      userId: s.users.collega.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: false },
    });
  });

  it('la correzione del codice fiscale arriva dopo un paziente nuovo con lo stesso codice: 409 con il paziente, e il rifiuto nel registro', async () => {
    const corrected = await registered(3);
    const p = person(4);
    const [created, fix] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      newPatient('segreteria', s.archives.titolare, p),
      correction('titolare', corrected, p.codiceFiscale),
    ]);
    expect(created!.statusCode, created!.body).toBe(201);
    const id = created!.json<{ id: string }>().id;
    expect(fix!.statusCode, fix!.body).toBe(409);
    expect(fix!.json()).toMatchObject({ dettagli: { paziente: { id } } });
    expect((await withCode(p.codiceFiscale)).map((r) => r.id)).toEqual([id]);
    // Il tentativo resta nel registro del paziente che ha quel codice fiscale.
    expect(await logRows(id, 'correzione_identita')).toContainEqual({
      userId: s.users.titolare.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: true },
    });
  });

  it('il paziente nuovo arriva dopo la correzione: è lui il doppione, del paziente corretto', async () => {
    const corrected = await registered(5);
    const p = person(6);
    const [fix, created] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      correction('titolare', corrected, p.codiceFiscale),
      newPatient('segreteria', s.archives.titolare, p),
    ]);
    expect(fix!.statusCode, fix!.body).toBe(200);
    expect(created!.statusCode, created!.body).toBe(409);
    expect(created!.json()).toMatchObject({ dettagli: { paziente: { id: corrected } } });
    expect((await withCode(p.codiceFiscale)).map((r) => r.id)).toEqual([corrected]);
    expect(await logRows(corrected, 'nuovo_paziente')).toContainEqual({
      userId: s.users.segreteria.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: true },
    });
  });

  it('tre insieme: la prima entra; le altre due ricevono la risposta del doppione, ognuna con la sua riga nel registro', async () => {
    const p = person(7);
    const [first, second, third] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      newPatient('titolare', s.archives.titolare, p),
      newPatient('segreteria', s.archives.titolare, p),
      newPatient('collega', s.archives.collega, p),
    ]);
    expect(first!.statusCode, first!.body).toBe(201);
    const id = first!.json<{ id: string }>().id;
    expect(second!.statusCode, second!.body).toBe(409);
    expect(second!.json()).toMatchObject({ dettagli: { paziente: { id } } });
    // La collega non vede l'archivio del titolare: la risposta non dice di chi è.
    expect(third!.statusCode, third!.body).toBe(409);
    expect(third!.json()).toMatchObject({ dettagli: { paziente: null } });
    expect((await withCode(p.codiceFiscale)).map((r) => r.id)).toEqual([id]);
    const log = await logRows(id, 'nuovo_paziente');
    expect(log).toContainEqual({
      userId: s.users.segreteria.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: true },
    });
    expect(log).toContainEqual({
      userId: s.users.collega.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: false },
    });
  });

  it('due correzioni insieme dello stesso codice fiscale su due pazienti: la prima riesce, la seconda è un doppione del primo', async () => {
    const a = await registered(8);
    const b = await registered(9);
    const p = person(10);
    const [fixA, fixB] = await inOrderAtTheGate(monitor, p.codiceFiscale, [
      correction('titolare', a, p.codiceFiscale),
      correction('segreteria', b, p.codiceFiscale),
    ]);
    expect(fixA!.statusCode, fixA!.body).toBe(200);
    expect(fixB!.statusCode, fixB!.body).toBe(409);
    expect(fixB!.json()).toMatchObject({ dettagli: { paziente: { id: a } } });
    expect((await withCode(p.codiceFiscale)).map((r) => r.id)).toEqual([a]);
    // Il secondo paziente resta com'era.
    const [other] = await t.db.select().from(patient).where(eq(patient.id, b));
    expect(other!.fiscalCode).not.toBe(p.codiceFiscale);
    expect(await logRows(a, 'correzione_identita')).toContainEqual({
      userId: s.users.segreteria.id,
      outcome: 'negato',
      details: { ...DUPLICATE, visibile: true },
    });
  });
});
