import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  refDpcDrug,
  refDrug,
  refDrugClass,
  referenceDataset,
  therapeuticPlan,
  therapy,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { ReferenceData, type TherapyFacts } from '../src/reference/lookup';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

// Confezioni inventate (9 cifre, come gli AIC), in versioni costruite a mano: il 01/10/2026 e il
// 01/11/2026, più una futura che alla data non vale.
const STABLE = '090000011';
const SUSPENDED = '090000023';
const GONE = '090000035';
const RECLASSED = '090000047';
const DECLASSED = '090000086';
const NOTE_DRUG = '090000050';
const PLAN_DRUG = '090000062';
const MANUAL = '090000074';
const DATE = '2026-11-20';

const NOTE = { activeIngredient: 'PRINCIPIO NOTA', atc: 'X01AA01' };
const NO_NOTE = { activeIngredient: 'PRINCIPIO SENZA NOTA', atc: 'X01AA02' };
const PLAN = { activeIngredient: 'PRINCIPIO PIANO', atc: 'X02AA02' };
const ALWAYS_PLAN = { activeIngredient: 'PRINCIPIO PIANO DA SEMPRE', atc: 'X02AA03' };

const TEXT = {
  sospesa:
    'confezione sospesa secondo l’anagrafica AIFA delle confezioni (versione del 01/11/2026)',
  uscita:
    'non è più nell’anagrafica AIFA delle confezioni (versione del 01/11/2026); c’era in quella del 01/10/2026',
  classeH:
    'negli elenchi AIFA è passato dalla classe A alla classe H (versione del 01/11/2026); nella terapia è segnato in classe A',
  fuoriA:
    'non è più nell’elenco AIFA dei farmaci di classe A (versione del 01/11/2026); nella terapia è segnato in classe A',
  nota: 'nell’elenco DPC la nota AIFA è ora la 200 (versione del 01/11/2026); nella terapia è segnata la 100',
  notaTolta:
    'nell’elenco DPC la nota AIFA non c’è più (versione del 01/11/2026); nella terapia è segnata la 300',
  piano:
    'l’elenco DPC chiede il piano terapeutico (versione del 01/11/2026); la terapia non ha un piano collegato',
};

const facts = (id: string, over: Partial<TherapyFacts> = {}): TherapyFacts => ({
  id,
  drugAic: null,
  drugClass: null,
  aifaNote: null,
  activeIngredient: null,
  atc: null,
  hasPlan: false,
  ...over,
});

interface ChangedDrug {
  aic: string;
  farmaco: string;
  tipo: string;
  testo: string;
  pazienti: { id: string; nome: string; cognome: string }[];
}

describe('variazioni AIFA sui farmaci in terapia (A7, D205)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let ref: ReferenceData;
  let n = 0;

  /** Una versione di una banca dati, scritta a mano. */
  async function version(kind: string, series: string, validFrom: string) {
    const [d] = await t.db
      .insert(referenceDataset)
      .values({
        kind,
        series,
        title: series,
        mappingVersion: 'prova',
        origin: 'sync',
        sha256: `prova-${++n}`,
        bytes: 1,
        validFrom,
        validFromBasis: 'scaricamento',
        rows: 0,
        importedBy: 'prova',
      })
      .returning();
    return d!.id;
  }
  const drugs = (datasetId: string, rows: [string, string][]) =>
    t.db
      .insert(refDrug)
      .values(rows.map(([aic, adminState]) => ({ datasetId, aic, name: aic, adminState })));
  const classes = (datasetId: string, drugClass: 'A' | 'H', aics: string[]) =>
    aics.length
      ? t.db.insert(refDrugClass).values(aics.map((aic) => ({ datasetId, aic, drugClass })))
      : Promise.resolve();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    ref = new ReferenceData(t.db);
  }, 60_000);
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('senza le banche dati: nessuna variazione', async () => {
    const out = await ref.aifaChanges(
      [
        facts('a', { drugAic: SUSPENDED }),
        facts('b', { drugAic: RECLASSED, drugClass: 'A' }),
        facts('c', { drugAic: NOTE_DRUG, aifaNote: '100', ...NOTE }),
        facts('d', { drugAic: PLAN_DRUG, ...PLAN }),
      ],
      DATE,
    );
    expect([...out.entries()]).toEqual([]);
  });

  it('confezione sospesa o uscita dall’anagrafica, alla data e con la versione', async () => {
    const all = [STABLE, SUSPENDED, GONE, RECLASSED, DECLASSED, NOTE_DRUG, PLAN_DRUG, MANUAL];
    const v1 = await version('farmaci', 'aifa-anagrafica', '2026-10-01');
    await drugs(
      v1,
      all.map((a) => [a, 'Autorizzata']),
    );
    const v2 = await version('farmaci', 'aifa-anagrafica', '2026-11-01');
    await drugs(
      v2,
      all.filter((a) => a !== GONE).map((a) => [a, a === SUSPENDED ? 'Sospesa' : 'Autorizzata']),
    );
    // Una versione futura: alla data non vale.
    const v3 = await version('farmaci', 'aifa-anagrafica', '2099-01-01');
    await drugs(
      v3,
      all.map((a) => [a, 'Sospesa']),
    );
    const therapies = [
      facts('stabile', { drugAic: STABLE }),
      facts('sospesa', { drugAic: SUSPENDED }),
      facts('uscita', { drugAic: GONE }),
      // Mai stata nell'anagrafica: assente non vuol dire uscita.
      facts('mai', { drugAic: '099999999' }),
    ];
    const out = await ref.aifaChanges(therapies, DATE);
    expect(Object.fromEntries(out)).toEqual({
      sospesa: [{ kind: 'sospesa', since: '2026-11-01', text: TEXT.sospesa }],
      uscita: [{ kind: 'anagrafica', since: '2026-11-01', text: TEXT.uscita }],
    });
    // Prima della versione del 01/11/2026 non c'è nulla da dire.
    expect([...(await ref.aifaChanges(therapies, '2026-10-15')).entries()]).toEqual([]);
    // L'anagrafica senza elenchi di classe in vigore: la classe resta non nota, la R8 tace (D261).
    expect((await ref.drugs([STABLE], DATE)).get(STABLE)!.facts).not.toHaveProperty('listedClass');
  });

  it('classe: dagli elenchi di classe, solo se la scheda ha la classe di una versione superata', async () => {
    const a1 = await version('farmaci_classe', 'aifa-classe-a', '2026-10-01');
    await classes(a1, 'A', [STABLE, RECLASSED, DECLASSED]);
    const h1 = await version('farmaci_classe', 'aifa-classe-h', '2026-10-01');
    void h1;
    const a2 = await version('farmaci_classe', 'aifa-classe-a', '2026-11-01');
    await classes(a2, 'A', [STABLE]);
    const h2 = await version('farmaci_classe', 'aifa-classe-h', '2026-11-01');
    await classes(h2, 'H', [RECLASSED]);
    const out = await ref.aifaChanges(
      [
        facts('in-h', { drugAic: RECLASSED, drugClass: 'A' }),
        facts('fuori-a', { drugAic: DECLASSED, drugClass: 'A' }),
        // La scheda già aggiornata: niente da dire.
        facts('aggiornata', { drugAic: RECLASSED, drugClass: 'H' }),
        facts('stabile', { drugAic: STABLE, drugClass: 'A' }),
        // Scritta a mano: in classe A nella scheda, mai negli elenchi di classe A.
        facts('a-mano', { drugAic: MANUAL, drugClass: 'A' }),
        facts('senza-classe', { drugAic: DECLASSED, drugClass: null }),
      ],
      DATE,
    );
    expect(Object.fromEntries(out)).toEqual({
      'in-h': [{ kind: 'classe', since: '2026-11-01', text: TEXT.classeH }],
      'fuori-a': [{ kind: 'classe', since: '2026-11-01', text: TEXT.fuoriA }],
    });
    // Con gli elenchi in vigore: la classe degli elenchi alla data, o null se non c'è (D261).
    const now = await ref.drugs([STABLE, RECLASSED, DECLASSED], DATE);
    expect(now.get(STABLE)!.facts.listedClass).toBe('A');
    expect(now.get(RECLASSED)!.facts.listedClass).toBe('H');
    expect(now.get(DECLASSED)!.facts.listedClass).toBeNull();
    // Il 15/10 vale la versione del 01/10, dove DECLASSED era ancora in classe A.
    expect((await ref.drugs([DECLASSED], '2026-10-15')).get(DECLASSED)!.facts.listedClass).toBe(
      'A',
    );
  });

  it('nota e piano: dall’elenco DPC, per principio attivo o ATC', async () => {
    const d1 = await version('farmaci_dpc', 'dpc-prova', '2026-10-01');
    await t.db.insert(refDpcDrug).values([
      { datasetId: d1, ...NOTE, aifaNote: '100', planRequired: false },
      { datasetId: d1, ...NO_NOTE, aifaNote: '300', planRequired: null },
      { datasetId: d1, ...PLAN, aifaNote: null, planRequired: false },
      { datasetId: d1, ...ALWAYS_PLAN, aifaNote: null, planRequired: true },
    ]);
    const d2 = await version('farmaci_dpc', 'dpc-prova', '2026-11-01');
    await t.db.insert(refDpcDrug).values([
      { datasetId: d2, ...NOTE, aifaNote: '200', planRequired: false },
      { datasetId: d2, ...NO_NOTE, aifaNote: null, planRequired: null },
      { datasetId: d2, ...PLAN, aifaNote: null, planRequired: true },
      { datasetId: d2, ...ALWAYS_PLAN, aifaNote: null, planRequired: true },
    ]);
    const out = await ref.aifaChanges(
      [
        facts('nota', { drugAic: NOTE_DRUG, aifaNote: '100', ...NOTE }),
        // Per principio attivo, senza ATC e con le minuscole.
        facts('nota-tolta', {
          drugAic: NOTE_DRUG,
          aifaNote: ' 300 ',
          activeIngredient: 'principio senza nota',
        }),
        facts('nota-aggiornata', { drugAic: NOTE_DRUG, aifaNote: '200', ...NOTE }),
        // Una nota che nessuna versione ha mai avuto: la scheda è stata scritta a mano.
        facts('nota-a-mano', { drugAic: NOTE_DRUG, aifaNote: '999', ...NOTE }),
        facts('senza-nota', { drugAic: NOTE_DRUG, ...NOTE }),
        facts('piano', { drugAic: PLAN_DRUG, atc: PLAN.atc }),
        facts('con-piano', { drugAic: PLAN_DRUG, ...PLAN, hasPlan: true }),
      ],
      DATE,
    );
    expect(Object.fromEntries(out)).toEqual({
      nota: [{ kind: 'nota', since: '2026-11-01', text: TEXT.nota }],
      'nota-tolta': [{ kind: 'nota', since: '2026-11-01', text: TEXT.notaTolta }],
      piano: [{ kind: 'piano', since: '2026-11-01', text: TEXT.piano }],
    });
  });

  it('il piano chiesto da sempre non è una variazione; prima della versione nuova, nemmeno l’altro', async () => {
    const always = [facts('sempre', { drugAic: PLAN_DRUG, ...ALWAYS_PLAN })];
    expect([...(await ref.aifaChanges(always, DATE)).entries()]).toEqual([]);
    const before = [facts('piano', { drugAic: PLAN_DRUG, ...PLAN })];
    expect([...(await ref.aifaChanges(before, '2026-10-15')).entries()]).toEqual([]);
  });

  describe('in Oggi e nella cartella', () => {
    let p1: string;
    let p2: string;
    let p3: string;

    beforeAll(async () => {
      [, p1, p2, p3] = s.patients.titolare as [string, string, string, string];
      const base = {
        kind: 'chronic' as const,
        startOn: '2026-01-01',
        createdBy: s.users.titolare.id,
      };
      await withActor(t.db, s.users.titolare.id, async (tx) => {
        const [plan] = await tx
          .insert(therapeuticPlan)
          .values({
            patientId: p1,
            drugName: 'FARMACO CON PIANO',
            grantedOn: '2026-11-02',
            expiresOn: '2027-11-01',
            createdBy: s.users.titolare.id,
          })
          .returning();
        await tx.insert(therapy).values([
          { ...base, patientId: p1, drugAic: SUSPENDED, drugName: 'FARMACO SOSPESO' },
          // Due schede dello stesso farmaco: il paziente compare una volta.
          { ...base, patientId: p1, drugAic: SUSPENDED, drugName: 'FARMACO SOSPESO' },
          { ...base, patientId: p2, drugAic: SUSPENDED, drugName: 'FARMACO SOSPESO' },
          {
            ...base,
            patientId: p2,
            drugAic: RECLASSED,
            drugName: 'FARMACO RICLASSIFICATO',
            drugClass: 'A',
          },
          // Conclusa: la variazione non la riguarda più.
          {
            ...base,
            patientId: p1,
            drugAic: GONE,
            drugName: 'FARMACO USCITO',
            status: 'ended' as const,
            endOn: '2026-10-31',
          },
          // Riservata: solo chi legge le terapie riservate.
          {
            ...base,
            patientId: p3,
            drugAic: GONE,
            drugName: 'FARMACO USCITO',
            reserved: true,
          },
          {
            ...base,
            patientId: p1,
            drugAic: PLAN_DRUG,
            drugName: 'FARMACO CON PIANO',
            ...PLAN,
            therapeuticPlanId: plan!.id,
          },
          { ...base, patientId: p2, drugAic: PLAN_DRUG, drugName: 'FARMACO CON PIANO', ...PLAN },
        ]);
      });
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
    // I pazienti in ordine di identificativo: lo scenario li genera diversi a ogni giro.
    const today = async (who: keyof Scenario['users']) =>
      ((await get(who, '/api/oggi')).code.variazioniAifa as ChangedDrug[]).map((d) => ({
        ...d,
        pazienti: d.pazienti.map((p) => p.id).sort((a, b) => a.localeCompare(b)),
      }));

    it('Oggi: una voce per farmaco e variazione, con i pazienti; le riservate solo a chi le legge', async () => {
      const entries = await today('titolare');
      expect(entries).toEqual([
        {
          aic: PLAN_DRUG,
          farmaco: 'FARMACO CON PIANO',
          tipo: 'piano',
          testo: TEXT.piano,
          pazienti: [p2],
        },
        {
          aic: RECLASSED,
          farmaco: 'FARMACO RICLASSIFICATO',
          tipo: 'classe',
          testo: TEXT.classeH,
          pazienti: [p2],
        },
        {
          aic: SUSPENDED,
          farmaco: 'FARMACO SOSPESO',
          tipo: 'sospesa',
          testo: TEXT.sospesa,
          pazienti: [p1, p2].sort((a, b) => a.localeCompare(b)),
        },
        {
          aic: GONE,
          farmaco: 'FARMACO USCITO',
          tipo: 'anagrafica',
          testo: TEXT.uscita,
          pazienti: [p3],
        },
      ]);
      // La segreteria legge le terapie dell'archivio, non quelle riservate.
      const secretary = await today('segreteria');
      expect(secretary.map((e) => e.aic)).toEqual([PLAN_DRUG, RECLASSED, SUSPENDED]);
      // Un altro archivio: niente.
      expect(await today('collega')).toEqual([]);
    });

    it('cartella: le variazioni sulle terapie in corso, non su quelle concluse', async () => {
      const { terapie } = await get('titolare', `/api/pazienti/${p1}/terapie`);
      const pick = (x: { drugName: string; status: string; aifaChanges: unknown }) => [
        x.drugName,
        x.status,
        x.aifaChanges,
      ];
      expect(terapie.map(pick)).toEqual([
        ['FARMACO CON PIANO', 'active', []],
        [
          'FARMACO SOSPESO',
          'active',
          [{ kind: 'sospesa', since: '2026-11-01', text: TEXT.sospesa }],
        ],
        [
          'FARMACO SOSPESO',
          'active',
          [{ kind: 'sospesa', since: '2026-11-01', text: TEXT.sospesa }],
        ],
        ['FARMACO USCITO', 'ended', []],
      ]);
    });

    const post = async (who: keyof Scenario['users'], url: string) =>
      s.app.inject({
        method: 'POST',
        url,
        payload: {},
        headers: { cookie: await login(s, who) },
      });

    it('aggiornare la scheda dalla banca dati (D208) chiude la variazione di classe; il resto resta', async () => {
      const { terapie } = await get('titolare', `/api/pazienti/${p2}/terapie`);
      const reclassed = terapie.find((x: { drugAic: string }) => x.drugAic === RECLASSED);
      const res = await post(
        'titolare',
        `/api/pazienti/${p2}/terapie/${reclassed.id}/aggiorna-dati-farmaco`,
      );
      expect(res.statusCode, res.body).toBe(200);
      // In vigore: nell'elenco di classe H, senza nota e fuori dalla DPC.
      expect(res.json()).toEqual({
        id: reclassed.id,
        drugClass: 'H',
        aifaNote: null,
        dpc: false,
        equivalenceGroup: null,
      });
      const after = (await get('titolare', `/api/pazienti/${p2}/terapie`)).terapie.find(
        (x: { id: string }) => x.id === reclassed.id,
      );
      expect(after).toMatchObject({
        drugClass: 'H',
        drugName: 'FARMACO RICLASSIFICATO',
        startOn: '2026-01-01',
        aifaChanges: [],
      });
      expect((await today('titolare')).map((e) => e.aic)).toEqual([PLAN_DRUG, SUSPENDED, GONE]);
    });

    it('aggiornare la scheda: non una terapia conclusa, non senza AIC, non un farmaco che non c’è', async () => {
      const { terapie } = await get('titolare', `/api/pazienti/${p1}/terapie`);
      const ended = terapie.find((x: { status: string }) => x.status === 'ended');
      expect(
        (await post('titolare', `/api/pazienti/${p1}/terapie/${ended.id}/aggiorna-dati-farmaco`))
          .statusCode,
      ).toBe(409);
      const [noAic, unknown] = await withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .insert(therapy)
          .values([
            {
              patientId: p1,
              drugName: 'FARMACO SCRITTO A MANO',
              kind: 'chronic' as const,
              startOn: '2026-01-01',
              createdBy: s.users.titolare.id,
            },
            {
              patientId: p1,
              drugAic: '099999999',
              drugName: 'FARMACO SCONOSCIUTO',
              kind: 'chronic' as const,
              startOn: '2026-01-01',
              createdBy: s.users.titolare.id,
            },
          ])
          .returning({ id: therapy.id }),
      );
      const a = await post(
        'titolare',
        `/api/pazienti/${p1}/terapie/${noAic!.id}/aggiorna-dati-farmaco`,
      );
      expect(a.statusCode, a.body).toBe(400);
      const b = await post(
        'titolare',
        `/api/pazienti/${p1}/terapie/${unknown!.id}/aggiorna-dati-farmaco`,
      );
      expect(b.statusCode, b.body).toBe(404);
      // Un altro archivio: non si vede nemmeno.
      const other = await post(
        'collega',
        `/api/pazienti/${p1}/terapie/${noAic!.id}/aggiorna-dati-farmaco`,
      );
      expect(other.statusCode).toBe(403);
    });
  });
});
