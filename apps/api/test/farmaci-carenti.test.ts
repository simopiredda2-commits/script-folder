import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings } from '@mmg/reference';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { therapy } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import {
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
  type ExampleSite,
} from '../src/reference/example-site';
import { importReferenceData } from '../src/reference/importer';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** AMLODIPINA TEVA ITALIA: nell'elenco AIFA dei carenti del 17/11/2026 (riga vera del sito d'esempio). */
const SHORT = '038548032';
/** AMLODIPINA DOC GENERICI: nelle liste, non fra i carenti. */
const NOT_SHORT = '038092019';
const TEXT =
  'nell’elenco AIFA dei farmaci carenti dal 02/11/2026 (Cessata commercializzazione definitiva); equivalente secondo l’elenco: sì';

interface ShortDrug {
  aic: string;
  farmaco: string;
  testo: string;
  pazienti: { id: string; nome: string; cognome: string }[];
}

describe('farmaci carenti in terapia (requisiti, «Banche dati» e A7; D202)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let site: ExampleSite;
  let work: string;
  let syncDir: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    site = await serveExampleSite();
    work = mkdtempSync(join(tmpdir(), 'mmg-carenti-'));
    syncDir = join(work, 'dati-pubblici');
    expect((await runSyncOnExample(site, syncDir)).code).toBe(0);
    s = await createScenario(t.db);
    const base = {
      kind: 'chronic' as const,
      startOn: '2026-01-01',
      createdBy: s.users.titolare.id,
    };
    // Il primo paziente del titolare è il paziente ricco.
    const [, p1, p2] = s.patients.titolare;
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.insert(therapy).values([
        { ...base, patientId: s.richPatient, drugAic: SHORT, drugName: 'AMLODIPINA TEVA ITALIA' },
        // Conclusa: la carenza non la riguarda più.
        {
          ...base,
          patientId: s.richPatient,
          drugAic: SHORT,
          drugName: 'AMLODIPINA TEVA ITALIA (conclusa)',
          endOn: '2026-06-30',
          status: 'ended' as const,
        },
        { ...base, patientId: s.richPatient, drugAic: NOT_SHORT, drugName: 'AMLODIPINA DOC' },
        // Due schede dello stesso farmaco: in Oggi il paziente compare una volta.
        {
          ...base,
          patientId: s.richPatient,
          drugAic: SHORT,
          drugName: 'AMLODIPINA TEVA ITALIA (seconda scheda)',
        },
        // Riservata: solo chi legge le terapie riservate.
        {
          ...base,
          patientId: p1!,
          drugAic: SHORT,
          drugName: 'AMLODIPINA TEVA ITALIA',
          reserved: true,
        },
        // Sospesa: si vede nella sua terapia, non fra le cose da fare di oggi.
        {
          ...base,
          patientId: p2!,
          drugAic: SHORT,
          drugName: 'AMLODIPINA TEVA ITALIA',
          status: 'suspended' as const,
        },
      ]),
    );
    await withActor(t.db, s.users.collega.id, (tx) =>
      tx.insert(therapy).values({
        ...base,
        createdBy: s.users.collega.id,
        patientId: s.patients.collega[0]!,
        drugAic: SHORT,
        drugName: 'AMLODIPINA TEVA ITALIA',
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await s?.app.close();
    await site?.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const get = async (who: keyof Scenario['users'], url: string) => {
    const res = await s.app.inject({
      method: 'GET',
      url,
      headers: { cookie: await login(s, who) },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const shortToday = async (who: keyof Scenario['users']) =>
    ((await get(who, '/api/oggi')).code.farmaciCarenti as ShortDrug[]).map((d) => ({
      ...d,
      pazienti: d.pazienti.map((p) => p.id),
    }));

  it('senza l’elenco dei carenti importato: nessuna carenza, né in terapia né in Oggi', async () => {
    expect(await shortToday('titolare')).toEqual([]);
    const { terapie } = await get('titolare', `/api/pazienti/${s.richPatient}/terapie`);
    expect(terapie.every((x: { shortage: unknown }) => x.shortage === null)).toBe(true);
  });

  it('con l’elenco: la terapia in corso ha la carenza con le parole dell’elenco; la conclusa no', async () => {
    await importReferenceData({
      db: t.db,
      syncDir,
      transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
      mappings: loadMappings(),
      importedBy: 'prova',
    });
    const { terapie } = await get('titolare', `/api/pazienti/${s.richPatient}/terapie`);
    const by = (name: string) => terapie.find((x: { drugName: string }) => x.drugName === name);
    expect(by('AMLODIPINA TEVA ITALIA').shortage).toEqual({
      since: '2026-11-02',
      expectedEnd: null,
      equivalentAvailable: true,
      reason: 'Cessata commercializzazione definitiva',
      aifaAdvice:
        'Per trattamento alternativo si consiglia di rivolgersi allo specialista o al M.M.G',
      aifaNote: expect.stringMatching(/^cessata commercializzazione definitiva/),
      text: TEXT,
    });
    expect(by('AMLODIPINA TEVA ITALIA (conclusa)').shortage).toBeNull();
    expect(by('AMLODIPINA DOC').shortage).toBeNull();
    expect(by('Farmaco di prova 5 mg').shortage).toBeNull();
    // La sospesa la mostra: si può riprendere.
    const other = await get('titolare', `/api/pazienti/${s.patients.titolare[2]}/terapie`);
    expect(other.terapie[0].shortage).toMatchObject({ since: '2026-11-02' });
  });

  it('Oggi: il farmaco carente con i pazienti dell’archivio che lo prendono, le riservate a chi le legge', async () => {
    const [, p1] = s.patients.titolare;
    const owner = await shortToday('titolare');
    expect(owner).toEqual([
      { aic: SHORT, farmaco: 'AMLODIPINA TEVA ITALIA', testo: TEXT, pazienti: expect.any(Array) },
    ]);
    // Il paziente ricco (una volta, con due schede) e quello con la terapia riservata; non la
    // sospesa, non l'altro archivio.
    expect([...owner[0]!.pazienti].sort()).toEqual([s.richPatient, p1!].sort());
    // La segreteria, condivisa, legge le terapie non riservate dei due archivi che l'hanno
    // confermata: il paziente ricco e quello del collega, non quello con la terapia riservata.
    const secretary = await shortToday('segreteria');
    expect(secretary).toHaveLength(1);
    expect([...secretary[0]!.pazienti].sort()).toEqual(
      [s.richPatient, s.patients.collega[0]!].sort(),
    );
    // Il collega vede il suo archivio.
    expect(await shortToday('collega')).toEqual([
      {
        aic: SHORT,
        farmaco: 'AMLODIPINA TEVA ITALIA',
        testo: TEXT,
        pazienti: [s.patients.collega[0]],
      },
    ]);
    // L'amministratore non legge le terapie: niente.
    expect(await shortToday('amministratore')).toEqual([]);
  });
});
