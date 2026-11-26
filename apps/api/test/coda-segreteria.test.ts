import { SimulatedGateway, type SimulatedOutcome } from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveSecretary, patient, prescription, therapy } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { regionalGateway } from './helpers/regional-gateway';

interface QueueGroup {
  paziente: { id: string };
  ricette: { id: string; firmabile: boolean; errore: string | null }[];
}

/**
 * Le ricette in attesa viste dalla segreteria (D242): la pagina Ricette le promette, «Qui sotto le
 * ricette in attesa». La segreteria le vede in sola lettura negli archivi che l'hanno confermata,
 * senza quelle con una terapia riservata; firma e invio restano del medico (regola 5).
 */
describe('code delle ricette viste dalla segreteria (D242)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const next: SimulatedOutcome[] = [];
  const cookies: Record<string, string> = {};
  let chronic: string;
  let reserved: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    const decide = () => next.shift() ?? 'accepted';
    s = await createScenario(
      t.db,
      {},
      {
        gateways: {
          regional: regionalGateway({ decide }),
          sistema_ts: new SimulatedGateway('sistema_ts', { decide }),
        },
      },
    );
    for (const who of ['titolare', 'segreteria', 'collega', 'amministratore'] as const)
      cookies[who] = await login(s, who);
    const ts = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    chronic = ts.find((x) => !x.reserved && x.kind === 'chronic')!.id;
    reserved = ts.find((x) => x.reserved)!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (who: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who]! },
      ...(payload !== undefined ? { payload } : {}),
    });
  /** Le ricette di una coda, per chi la guarda. */
  const queue = async (who: string, path: string) => {
    const res = await req(who, 'GET', `/api/ricette/${path}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ pazienti: QueueGroup[] }>().pazienti.flatMap((g) => g.ricette);
  };
  const find = async (who: string, path: string, id: string) =>
    (await queue(who, path)).find((r) => r.id === id);
  /** Una ricetta del medico, messa da firmare. */
  const toSign = async (who: string, patientId: string, line: object) => {
    const res = await req(who, 'POST', `/api/pazienti/${patientId}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ quantity: 1, activeIngredient: 'principio di prova', ...line }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    expect((await req(who, 'POST', `/api/ricette/${id}/da-firmare`, {})).statusCode).toBe(200);
    return id;
  };

  it('la segreteria vede le ricette da firmare in sola lettura; il medico le firma', async () => {
    const res = await req('segreteria', 'POST', `/api/pazienti/${s.richPatient}/ricette/ripeti`, {
      terapie: [chronic],
    });
    expect(res.statusCode, res.body).toBe(201);
    const [prepared] = res.json<{ ricette: string[] }>().ricette;
    expect(await find('segreteria', 'da-firmare', prepared!)).toMatchObject({ firmabile: false });
    expect(await find('titolare', 'da-firmare', prepared!)).toMatchObject({ firmabile: true });
    // Vederla non basta per firmarla: firma e invio restano del medico.
    expect(
      (await req('segreteria', 'POST', `/api/ricette/${prepared}/firma-e-invia`, {})).statusCode,
    ).toBe(403);
  });

  it('una ricetta con una terapia riservata non compare alla segreteria, al medico sì', async () => {
    const id = await toSign('titolare', s.richPatient, {
      therapyId: reserved,
      drugName: 'Farmaco riservato di prova',
    });
    expect(await find('titolare', 'da-firmare', id)).toMatchObject({ firmabile: true });
    expect(await find('segreteria', 'da-firmare', id)).toBeUndefined();
    // Anche dalla cartella: la segreteria non la vede fra le ricette del paziente.
    const list = await req('segreteria', 'GET', `/api/pazienti/${s.richPatient}/ricette`);
    expect(list.json<{ ricette: { id: string }[] }>().ricette.map((r) => r.id)).not.toContain(id);
  });

  it('invii non riusciti e senza risposta: la segreteria li vede, li chiude il medico', async () => {
    const failed = await toSign('titolare', s.richPatient, { drugName: 'Farmaco di prova 5 mg' });
    next.push('rejected');
    const sent = await req('titolare', 'POST', `/api/ricette/${failed}/firma-e-invia`, {});
    expect(sent.json(), sent.body).toMatchObject({ esito: 'rejected' });
    expect(
      (await t.db.select().from(prescription).where(eq(prescription.id, failed)))[0]!.status,
    ).toBe('error');
    const seen = await find('segreteria', 'non-inviate', failed);
    expect(seen).toMatchObject({ firmabile: false });
    expect(seen!.errore).toBeTruthy();
    expect(await find('titolare', 'non-inviate', failed)).toMatchObject({ firmabile: true });

    const stuck = await toSign('titolare', s.richPatient, { drugName: 'Farmaco di prova 5 mg' });
    await t.db
      .update(prescription)
      .set({ status: 'sending', signedBy: s.users.titolare.id, signedAt: s.clock.now() })
      .where(eq(prescription.id, stuck));
    expect(await find('segreteria', 'senza-risposta', stuck)).toMatchObject({ firmabile: false });
    expect(await find('titolare', 'senza-risposta', stuck)).toMatchObject({ firmabile: true });
  });

  it('l’amministratore senza accesso clinico non vede le code', async () => {
    for (const path of ['da-firmare', 'non-inviate', 'senza-risposta', 'confermate'])
      expect(await queue('amministratore', path), path).toEqual([]);
  });

  it('confermate (D254): inviate in elenco, con l’NRE; «Archivia» toglie ciò che si vede, per tutti', async () => {
    const theirPatient = s.patients.collega[0]!;
    await t.db
      .update(patient)
      .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
      .where(eq(patient.id, theirPatient));
    const send = async (who: string, patientId: string, drugName: string) => {
      const id = await toSign(who, patientId, { drugName });
      const res = await req(who, 'POST', `/api/ricette/${id}/firma-e-invia`, {});
      expect(res.statusCode, res.body).toBe(200);
      return id;
    };
    const archive = async (who: string) => {
      const res = await req(who, 'POST', '/api/ricette/archivia-confermate', {});
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ archiviate: number }>().archiviate;
    };
    const sent = await send('titolare', s.richPatient, 'Farmaco confermato di prova');
    const theirs = await send('collega', theirPatient, 'Farmaco del collega di prova');
    const waiting = await toSign('titolare', s.richPatient, { drugName: 'Farmaco in attesa' });
    const seen = await find('titolare', 'confermate', sent);
    expect(seen).toMatchObject({ stato: 'sent', consegne: 0 });
    expect((seen as unknown as { nre: string }).nre).toMatch(/\S/);
    // Una consegna su carta: la ricetta la conta, e «Archivia» non chiede più (suggerimento S7).
    const paper = await req('titolare', 'POST', `/api/ricette/${sent}/promemoria/consegna-carta`, {
      formato: 'completo',
    });
    expect(paper.statusCode, paper.body).toBe(200);
    expect(await find('titolare', 'confermate', sent)).toMatchObject({ consegne: 1 });
    // La segreteria le vede anche lei; quelle da firmare non sono confermate.
    expect(await find('segreteria', 'confermate', sent)).toBeDefined();
    expect(await find('titolare', 'confermate', waiting)).toBeUndefined();
    // Il titolare archivia le sue: quelle del collega, che non vede, restano.
    expect(await archive('titolare')).toBeGreaterThan(0);
    expect(await find('titolare', 'confermate', sent)).toBeUndefined();
    expect(await find('segreteria', 'confermate', sent)).toBeUndefined();
    expect(await find('collega', 'confermate', theirs)).toBeDefined();
    expect(await find('titolare', 'da-firmare', waiting)).toBeDefined();
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, sent));
    expect(row).toMatchObject({ status: 'sent', archivedBy: s.users.titolare.id });
    expect(row!.archivedAt).not.toBeNull();
    // Restano nello storico del paziente.
    const list = await req('titolare', 'GET', `/api/pazienti/${s.richPatient}/ricette`);
    expect(list.json<{ ricette: { id: string }[] }>().ricette.map((r) => r.id)).toContain(sent);
    // Con niente da archiviare, niente cambia.
    expect(await archive('titolare')).toBe(0);
    // Due richieste insieme: ogni ricetta si archivia una volta sola.
    const twice = await send('titolare', s.richPatient, 'Farmaco archiviato due volte');
    const [a, b] = await Promise.all([archive('titolare'), archive('segreteria')]);
    expect(a + b).toBe(2);
    expect(await find('collega', 'confermate', theirs)).toBeUndefined();
    expect(await find('titolare', 'confermate', twice)).toBeUndefined();
  });

  // Ultima del file: toglie alla segreteria la conferma sull'archivio del collega.
  it('la segreteria vede le code degli archivi che l’hanno confermata, non degli altri', async () => {
    // Lo stato dei pazienti dello scenario cambia da un giro all'altro, e per un deceduto la
    // ricetta non si fa (R19): qui il paziente del collega è in carico (prove su GitHub del
    // 21/11/2026, giro 408).
    const theirPatient = s.patients.collega[0]!;
    await t.db
      .update(patient)
      .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
      .where(eq(patient.id, theirPatient));
    const theirs = await toSign('collega', theirPatient, {
      drugName: 'Farmaco di prova 5 mg',
    });
    expect(await find('segreteria', 'da-firmare', theirs)).toMatchObject({ firmabile: false });
    // Il titolare non firma per l'archivio del collega: non la vede.
    expect(await find('titolare', 'da-firmare', theirs)).toBeUndefined();
    await t.db.insert(archiveSecretary).values({
      archiveId: s.archives.collega,
      userId: s.users.segreteria.id,
      decision: 'rifiutata',
      decidedBy: s.users.collega.id,
      decidedAt: s.clock.now(),
    });
    expect(await find('segreteria', 'da-firmare', theirs)).toBeUndefined();
    expect(await find('collega', 'da-firmare', theirs)).toMatchObject({ firmabile: true });
  });

  it('in bozza (audit, D259): chi la prepara la ritrova, con il conto in Oggi; gli altri no', async () => {
    const today = async (who: string) =>
      (await req(who, 'GET', '/api/oggi')).json<{ code: { inBozza: number | null } }>().code
        .inBozza;
    const before = await today('titolare');
    const res = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ quantity: 1, activeIngredient: 'principio di prova', drugName: 'Bozza di prova' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    expect(await find('titolare', 'in-bozza', id)).toBeTruthy();
    expect(await today('titolare')).toBe((before ?? 0) + 1);
    // La bozza è del medico che l'ha preparata: né la segreteria né la collega la vedono qui.
    expect(await find('segreteria', 'in-bozza', id)).toBeUndefined();
    expect(await find('collega', 'in-bozza', id)).toBeUndefined();
    // Mandata alla firma esce dalle bozze ed entra fra le ricette da firmare.
    expect((await req('titolare', 'POST', `/api/ricette/${id}/da-firmare`, {})).statusCode).toBe(
      200,
    );
    expect(await find('titolare', 'in-bozza', id)).toBeUndefined();
    expect(await find('titolare', 'da-firmare', id)).toBeTruthy();
    expect(await today('titolare')).toBe(before);
    // L'amministratore senza ruolo clinico non ha bozze né conto.
    expect(await today('amministratore')).toBeNull();
  });
});
