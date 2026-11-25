import { composeNre, NRE_LOT_SIZE } from '@mmg/domain';
import { SimulatedGateway, type SimulatedOutcome } from '@mmg/integrations';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/auth/service';
import { doctorProfile, externalSubmission, nreLot, prescription, studio } from '../src/db/schema';
import { createNreLots, NRE_LOT_RESERVE } from '../src/prescriptions/nre-lots';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });
const noop = () => Promise.resolve();

/**
 * Lotti di NRE del medico (D269): la cartella numera da sé le ricette per il SAR, con i lotti che il
 * SAR le dà (SIRPED, «Cartelle cliniche MMG e PLS», V06, 3.2, 4.1 e 4.3.1).
 */
describe('lotti di NRE (D269)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  /** Esiti scelti dalla prova, invio per invio e lotto per lotto. */
  const sends: SimulatedOutcome[] = [];
  const lots: SimulatedOutcome[] = [];
  const sar = new SimulatedGateway('sar', {
    decide: () => sends.shift() ?? 'accepted',
    decideLot: () => lots.shift() ?? 'accepted',
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: noRules,
      },
    );
    for (const who of ['titolare', 'sostituto'] as const) c[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });
  beforeEach(() => {
    sends.length = 0;
    lots.length = 0;
  });

  const post = (who: string, url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, payload, headers: { cookie: c[who]! } });
  const row = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;
  const draft = async (kind = 'pharma_ssn') => {
    const res = await post('titolare', `/api/pazienti/${s.richPatient}/ricette`, {
      kind,
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const sign = (id: string, who = 'titolare') => post(who, `/api/ricette/${id}/firma-e-invia`);
  const lotsOf = (userId: string) =>
    t.db
      .select()
      .from(nreLot)
      .where(eq(nreLot.doctorUserId, userId))
      .orderBy(asc(nreLot.receivedAt), asc(nreLot.id));
  const exchanges = (id: string) =>
    t.db
      .select()
      .from(externalSubmission)
      .where(eq(externalSubmission.prescriptionId, id))
      .orderBy(asc(externalSubmission.id));

  it('alla prima firma chiede il lotto al SAR e la ricetta parte con il primo NRE', async () => {
    const id = await draft();
    const res = await sign(id);
    expect(res.json(), res.body).toMatchObject({ esito: 'accepted', avviso: null });
    const [lot] = await lotsOf(s.users.titolare.id);
    const [profile] = await t.db
      .select()
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    expect(lot).toMatchObject({
      environment: 'simulator',
      regionCode: '010',
      groupCode: 'ZZ',
      lotType: '4',
      size: NRE_LOT_SIZE,
      nextProgressive: 1,
      doctorFiscalCode: profile!.fiscalCode,
    });
    const r = await row(id);
    expect(r.nre).toBe(composeNre(lot!, 0));
    expect(r).toMatchObject({ assignedNre: r.nre, nreLotId: lot!.id });
    // Nel registro: la richiesta del lotto (regione, tipo 1, codice fiscale), poi l'invio.
    const [asked, sent] = await exchanges(id);
    expect(asked).toMatchObject({
      operation: 'lotto_nre',
      outcome: 'assigned',
      request: { regionCode: '010', lotType: '1', doctorFiscalCode: profile!.fiscalCode },
    });
    expect(sent).toMatchObject({ operation: 'invio', outcome: 'accepted' });
    expect((sent!.request as { nre: string }).nre).toBe(r.nre);
  });

  it('le ricette successive prendono i numeri in fila, senza chiedere altri lotti', async () => {
    const a = await draft();
    const b = await draft();
    expect((await sign(a)).json().esito).toBe('accepted');
    expect((await sign(b)).json().esito).toBe('accepted');
    const all = await lotsOf(s.users.titolare.id);
    expect(all).toHaveLength(1);
    expect((await row(a)).nre).toBe(composeNre(all[0]!, 1));
    expect((await row(b)).nre).toBe(composeNre(all[0]!, 2));
    expect((await exchanges(b)).map((x) => x.operation)).toEqual(['invio']);
  });

  it('due firme insieme non hanno mai lo stesso NRE', async () => {
    const ids = await Promise.all([draft(), draft(), draft(), draft()]);
    const results = await Promise.all(ids.map((id) => sign(id)));
    for (const r of results) expect(r.json(), r.body).toMatchObject({ esito: 'accepted' });
    const nres = await Promise.all(ids.map(async (id) => (await row(id)).nre));
    expect(new Set(nres).size).toBe(ids.length);
  });

  it('due firme della stessa ricetta: ne passa una, e il numero dell’altra torna al lotto', async () => {
    // Un lotto già c'è, anche se la prova gira da sola.
    expect((await sign(await draft())).json().esito).toBe('accepted');
    const id = await draft();
    const before = (await lotsOf(s.users.titolare.id))[0]!.nextProgressive;
    const [a, b] = await Promise.all([sign(id), sign(id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await lotsOf(s.users.titolare.id))[0]!.nextProgressive).toBe(before + 1);
    expect((await row(id)).nre).toBe(composeNre((await lotsOf(s.users.titolare.id))[0]!, before));
  });

  it('dopo un rifiuto la ricetta corretta riparte con lo stesso NRE (V06, 4.3.1, caso 3)', async () => {
    const id = await draft();
    sends.push('rejected');
    expect((await sign(id)).json().esito).toBe('rejected');
    const first = await row(id);
    expect(first).toMatchObject({ status: 'error', nre: null });
    expect(first.assignedNre).toMatch(/^010ZZ4\d{9}$/);
    const before = (await lotsOf(s.users.titolare.id))[0]!.nextProgressive;
    // La si corregge (torna in bozza) e la si rimanda: stesso numero, nessun numero nuovo preso.
    expect((await post('titolare', `/api/ricette/${id}/bozza`)).statusCode).toBe(200);
    expect((await sign(id)).json().esito).toBe('accepted');
    const after = await row(id);
    expect(after.nre).toBe(first.assignedNre);
    expect((await lotsOf(s.users.titolare.id))[0]!.nextProgressive).toBe(before);
  });

  it('l’eccezione di sistema del SAR è un esito incerto: si rimanda con lo stesso NRE', async () => {
    const id = await draft();
    sends.push('fault');
    const res = await sign(id);
    expect(res.json()).toMatchObject({ esito: 'timeout' });
    const first = await row(id);
    expect(first).toMatchObject({ status: 'error', lastErrorKind: 'timeout' });
    expect((await exchanges(id)).at(-1)).toMatchObject({ operation: 'invio', outcome: 'fault' });
    expect((await sign(id)).json().esito).toBe('accepted');
    expect((await row(id)).nre).toBe(first.assignedNre);
  });

  it('la ricetta bianca non usa i lotti: il numero lo dà il Sistema TS', async () => {
    const id = await draft('white');
    expect((await sign(id)).json().esito).toBe('accepted');
    const r = await row(id);
    expect(r.assignedNre).toBeNull();
    expect(r.nre).toMatch(/^SIMB/);
  });

  it('il sostituto firma con il suo lotto, legato al suo codice fiscale', async () => {
    const res = await post('sostituto', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    expect((await sign(id, 'sostituto')).json().esito).toBe('accepted');
    const [lot] = await lotsOf(s.users.sostituto.id);
    const [mine] = await lotsOf(s.users.titolare.id);
    expect(lot!.prefix).not.toBe(mine!.prefix);
    expect((await row(id)).nre).toBe(composeNre(lot!, 0));
  });

  it(`con meno di ${NRE_LOT_RESERVE} numeri chiede il lotto successivo e finisce prima il vecchio`, async () => {
    const [old] = await lotsOf(s.users.titolare.id);
    await t.db
      .update(nreLot)
      .set({ nextProgressive: NRE_LOT_SIZE - NRE_LOT_RESERVE + 10 })
      .where(eq(nreLot.id, old!.id));
    const id = await draft();
    expect((await sign(id)).json()).toMatchObject({ esito: 'accepted', avviso: null });
    const all = await lotsOf(s.users.titolare.id);
    expect(all).toHaveLength(2);
    expect((await row(id)).nre).toBe(composeNre(old!, NRE_LOT_SIZE - NRE_LOT_RESERVE + 10));
    expect(all[1]!.nextProgressive).toBe(0);
  });

  it('se il lotto non arriva ma restano numeri, la ricetta parte con l’avviso', async () => {
    const all = await lotsOf(s.users.titolare.id);
    // Restano 5 numeri nel primo lotto; il secondo si considera finito.
    await t.db
      .update(nreLot)
      .set({ nextProgressive: NRE_LOT_SIZE - 5 })
      .where(eq(nreLot.id, all[0]!.id));
    await t.db
      .update(nreLot)
      .set({ nextProgressive: NRE_LOT_SIZE })
      .where(eq(nreLot.id, all[1]!.id));
    const id = await draft();
    lots.push('unreachable');
    const res = await sign(id);
    expect(res.json()).toMatchObject({ esito: 'accepted' });
    expect(res.json().avviso).toMatch(/Restano 5 numeri di ricetta \(NRE\).*non è raggiungibile/);
    expect((await exchanges(id)).map((x) => [x.operation, x.outcome])).toEqual([
      ['lotto_nre', 'unreachable'],
      ['invio', 'accepted'],
    ]);
  });

  it('senza numeri e senza lotto la ricetta non parte, e il motivo si legge', async () => {
    await t.db
      .update(nreLot)
      .set({ nextProgressive: NRE_LOT_SIZE })
      .where(eq(nreLot.doctorUserId, s.users.titolare.id));
    const id = await draft();
    lots.push('timeout');
    const res = await sign(id);
    expect(res.statusCode).toBe(502);
    expect(res.json().errore).toMatch(
      /lotto di numeri di ricetta \(NRE\).*non ha risposto in tempo/,
    );
    const r = await row(id);
    expect(r).toMatchObject({ status: 'draft', assignedNre: null, sendingSnapshot: null });
    expect((await exchanges(id)).map((x) => x.operation)).toEqual(['lotto_nre']);
    // Il SAR risponde di nuovo: con il lotto nuovo la ricetta parte.
    expect((await sign(id)).json().esito).toBe('accepted');
    expect(await lotsOf(s.users.titolare.id)).toHaveLength(3);
  });

  it('un rifiuto del SAR al lotto ferma la firma con il codice della V06', async () => {
    await t.db
      .update(nreLot)
      .set({ nextProgressive: NRE_LOT_SIZE })
      .where(eq(nreLot.doctorUserId, s.users.titolare.id));
    const id = await draft();
    lots.push('rejected');
    const res = await sign(id);
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(/il SAR ha rifiutato la richiesta \(SIM-LOTTO/);
    expect((await row(id)).status).toBe('draft');
  });

  it('senza codice fiscale del medico o regione dello studio il lotto non si chiede', async () => {
    const [profile] = await t.db
      .select()
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    await t.db
      .update(doctorProfile)
      .set({ fiscalCode: null })
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    try {
      // La ricetta si ferma prima, per il promemoria: nessuna richiesta parte.
      const id = await draft();
      const res = await sign(id);
      expect(res.statusCode, res.body).toBe(409);
      expect(await exchanges(id)).toEqual([]);
      // Il lotto da solo dice che cosa manca e chi lo scrive.
      const lots = createNreLots({
        db: t.db,
        sar,
        environment: 'simulator',
        credentials: { authFor: () => Promise.reject(new Error('non serve')), authRefused: noop },
        timeoutMs: () => Promise.resolve(1000),
      });
      const actor = { userId: s.users.titolare.id, studioId: s.studioId } as Actor;
      await expect(lots.requestLot(actor, id)).rejects.toThrow(
        /Manca il codice fiscale del medico.*Utenti e ruoli/,
      );
      await t.db
        .update(doctorProfile)
        .set({ fiscalCode: profile!.fiscalCode })
        .where(eq(doctorProfile.userId, s.users.titolare.id));
      await t.db.update(studio).set({ regionName: null }).where(eq(studio.id, s.studioId));
      await expect(lots.requestLot(actor, id)).rejects.toThrow(
        /Manca la regione dello studio.*Dati dello studio/,
      );
    } finally {
      await t.db
        .update(doctorProfile)
        .set({ fiscalCode: profile!.fiscalCode })
        .where(eq(doctorProfile.userId, s.users.titolare.id));
      await t.db.update(studio).set({ regionName: 'PIEMONTE' }).where(eq(studio.id, s.studioId));
    }
  });

  it('«È arrivata» vuole il numero partito con l’invio (D233)', async () => {
    // Una ricetta partita con l'NRE del lotto e rimasta senza risposta: come dopo un arresto del
    // servizio, «in invio» da più di 15 minuti.
    const id = await draft();
    sends.push('timeout');
    expect((await sign(id)).json().esito).toBe('timeout');
    const nre = (await row(id)).assignedNre!;
    await t.db
      .update(prescription)
      .set({
        status: 'sending',
        signedBy: s.users.titolare.id,
        signedAt: new Date(s.clock.now().getTime() - 20 * 60_000),
      })
      .where(eq(prescription.id, id));
    // Un altro numero dello stesso lotto: l'ente non può averlo dato a questa ricetta.
    const other = `${nre.slice(0, 12)}${nre.endsWith('999') ? '998' : '999'}`;
    const wrong = await post('titolare', `/api/ricette/${id}/esito-invio`, {
      esito: 'arrivata',
      nre: other,
      codiceAutenticazione: 'MANAUT0001',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errore).toContain(`Il numero di questa ricetta è ${nre}`);
    const right = await post('titolare', `/api/ricette/${id}/esito-invio`, {
      esito: 'arrivata',
      nre,
      codiceAutenticazione: 'MANAUT0001',
    });
    expect(right.statusCode, right.body).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'sent', nre });
  });

  it('un lotto che non dà 1000 NRE della regione dello studio non si usa', async () => {
    const id = await draft();
    const auth = { username: 'utente-di-prova', password: 'parola-di-prova', pin: '1234' };
    const actor = { userId: s.users.titolare.id, studioId: s.studioId } as Actor;
    const before = (await lotsOf(s.users.titolare.id)).length;
    for (const lot of [
      { regionCode: '010', groupCode: 'ZZ', lotType: '4', lotCode: '12345' },
      { regionCode: '020', groupCode: 'ZZ', lotType: '4', lotCode: '123456' },
    ]) {
      const bad = createNreLots({
        db: t.db,
        sar: { requestLot: () => Promise.resolve({ outcome: 'assigned', lot, raw: lot }) },
        environment: 'simulator',
        credentials: { authFor: () => Promise.resolve(auth), authRefused: noop },
        timeoutMs: () => Promise.resolve(1000),
      });
      await expect(bad.requestLot(actor, id)).rejects.toThrow(
        /lotto che non si può usare: (Il codice del lotto non ha le 6 cifre|il codice della regione è 020)/,
      );
    }
    expect(await lotsOf(s.users.titolare.id)).toHaveLength(before);
    expect((await exchanges(id)).map((x) => [x.outcome, x.errorCode])).toEqual([
      ['rejected', 'LOTTO_NON_VALIDO'],
      ['rejected', 'LOTTO_NON_VALIDO'],
    ]);
  });

  it('un NRE non si dà mai a due ricette: lo vieta anche il database', async () => {
    const sent = await draft();
    expect((await sign(sent)).json().esito).toBe('accepted');
    const nre = (await row(sent)).assignedNre!;
    const id = await draft();
    await expect(
      t.db.update(prescription).set({ assignedNre: nre }).where(eq(prescription.id, id)),
    ).rejects.toThrow();
  });
});
