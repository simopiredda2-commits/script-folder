import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exemption, refExemption, referenceDataset } from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Current {
  codice: string;
  descrizione: string | null;
  al: string | null;
}

/**
 * La fascia della cartella mostra le esenzioni in corso (D244): valide oggi, una per codice
 * (quella che dura di più), con la descrizione del catalogo delle esenzioni in vigore e la
 * scadenza. Il campo di sempre, con tutte le esenzioni non annullate, non cambia.
 */
describe('esenzioni in corso nella fascia della cartella (D244)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  const day = (offset: number) =>
    studioDate(new Date(s.clock.now().getTime() + offset * 86_400_000));
  const dataset = async (series: string, validFrom: string, rows: [string, string][]) => {
    const [ds] = await t.db
      .insert(referenceDataset)
      .values({
        kind: 'esenzioni',
        series,
        title: 'Catalogo delle esenzioni di prova',
        mappingVersion: '1',
        origin: 'trascrizione',
        sha256: `prova-${series}`,
        bytes: 1,
        validFrom,
        validFromBasis: 'atto',
        rows: rows.length,
        importedBy: 'prova',
      })
      .returning();
    await t.db
      .insert(refExemption)
      .values(rows.map(([code, description]) => ({ datasetId: ds!.id, code, description })));
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    // Il catalogo in vigore oggi, e uno che varrà fra dieci giorni con un'altra descrizione.
    await dataset('esenzioni-in-vigore', day(-60), [
      ['013', 'Descrizione di prova dell’esenzione 013'],
      ['048', 'Descrizione di prova dell’esenzione 048'],
      ['031', 'Descrizione di prova dell’esenzione 031'],
    ]);
    await dataset('esenzioni-future', day(10), [['013', 'Descrizione futura dell’esenzione 013']]);
    const patientId = s.richPatient;
    await t.db.insert(exemption).values([
      // Lo stesso codice due volte: vale quella senza scadenza.
      { patientId, code: '013', validFrom: day(-100), validTo: day(30), source: 'manual' },
      { patientId, code: '013', validFrom: day(-10), source: 'manual' },
      { patientId, code: '048', validFrom: day(-5), validTo: day(200), source: 'manual' },
      // Scaduta ieri, comincia fra cinque giorni, annullata: non sono in corso.
      { patientId, code: '031', validFrom: day(-400), validTo: day(-1), source: 'manual' },
      { patientId, code: 'E01', validFrom: day(5), source: 'manual' },
      {
        patientId,
        code: '048',
        validFrom: day(-5),
        source: 'manual',
        annulledAt: s.clock.now(),
        annulReason: 'Registrata per errore',
      },
    ]);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('valide oggi, una per codice, con la descrizione in vigore e la scadenza', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${s.richPatient}`,
      headers: { cookie: doctor },
    });
    expect(res.statusCode, res.body).toBe(200);
    const summary = res.json<{
      riepilogo: { esenzioni: { codice: string }[]; esenzioniInCorso: Current[] };
    }>().riepilogo;
    expect(summary.esenzioniInCorso).toEqual([
      { codice: '013', descrizione: 'Descrizione di prova dell’esenzione 013', al: null },
      { codice: '048', descrizione: 'Descrizione di prova dell’esenzione 048', al: day(200) },
      // L'esenzione dello scenario: in corso, ma non nel catalogo di prova.
      { codice: 'P00', descrizione: null, al: null },
    ]);
    // Il campo di sempre: tutte le esenzioni non annullate, anche scadute e future.
    expect(summary.esenzioni.map((e) => e.codice).sort()).toEqual([
      '013',
      '013',
      '031',
      '048',
      'E01',
      'P00',
    ]);
  });
});
