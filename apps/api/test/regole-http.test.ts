import { SimulatedGateway } from '@mmg/integrations';
import { regionalPackageKey } from '@mmg/regions';
import { rulesetAt } from '@mmg/rules';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  externalSubmission,
  historicalPrescription,
  prescription,
  prescriptionCheck,
  prescriptionDocument,
  prescriptionLine,
  studio,
  therapy,
} from '../src/db/schema';
import { buildRuleContext, createRulesCheck, studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * La versione delle regole in vigore oggi per la regione dello studio della prova, con le sue
 * aggiunte (D296): le prove non la scrivono a mano, così una versione nuova non le rompe.
 */
let region: string | null = null;
const currentRules = () => rulesetAt(studioDate(new Date()), undefined, region).version;

describe('regole di prescrizione prima dell’invio', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const sar = new SimulatedGateway('sar');

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        // Banca dati farmaci di prova: 28 unità per confezione (serve al contatore R11).
        preSendChecks: (id, actor, input) =>
          createRulesCheck({ db: t.db, drugFacts: () => ({ unitsPerPack: 28 }) })(id, actor, input),
      },
    );
    cookie = await login(s, 'titolare');
    const [place] = await t.db.select({ regionName: studio.regionName }).from(studio);
    region = regionalPackageKey(place!.regionName);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, payload, headers: { cookie } });
  const draft = async (body: object) => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const pharma = (extra: object = {}) => ({
    kind: 'pharma_ssn',
    lines: [
      {
        drugName: 'Farmaco di prova 5 mg',
        activeIngredient: 'principio di prova',
        quantity: 1,
        ...extra,
      },
    ],
  });
  const checks = (id: string) =>
    t.db.select().from(prescriptionCheck).where(eq(prescriptionCheck.prescriptionId, id));

  it('R2: 3 confezioni bloccano l’invio con i dettagli; il controllo resta registrato', async () => {
    const id = await draft(pharma({ quantity: 3 }));
    const res = await post(`/api/ricette/${id}/firma-e-invia`);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.errore).toMatch(/R2/);
    expect(body.dettagli.versioneRegole).toBe(currentRules());
    expect(body.dettagli.problemi.some((p: { ruleId: string }) => p.ruleId === 'R2')).toBe(true);
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(row!.status).toBe('draft');
    const [c] = await checks(id);
    expect(c!.outcome).toBe('bloccato');
    expect(c!.rulesVersion).toBe(currentRules());
  });

  it('R7: la nota AIFA va confermata; la conferma resta registrata con la versione delle regole', async () => {
    const id = await draft(pharma({ aifaNote: '13' }));
    const blocked = await post(`/api/ricette/${id}/firma-e-invia`);
    expect(blocked.statusCode).toBe(422);
    const issue = blocked
      .json()
      .dettagli.problemi.find((p: { ruleId: string }) => p.ruleId === 'R7');
    expect(issue.needs).toBe('aifa_confirmation');
    const [l] = await t.db
      .select()
      .from(prescriptionLine)
      .where(eq(prescriptionLine.prescriptionId, id));
    const ok = await post(`/api/ricette/${id}/firma-e-invia`, { confermeNote: [l!.id] });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(row!.status).toBe('sent');
    expect(row!.rulesVersion).toBe(currentRules());
    const passed = (await checks(id)).find((c) => c.outcome === 'superato')!;
    expect(passed.confirmedAifaNotes).toEqual([l!.id]);
  });

  it('R14: la specialistica senza quesito si ferma; il controllo senza invio lo dice prima', async () => {
    const id = await draft({
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      lines: [{ serviceCode: '89.7', serviceDescription: 'Visita di prova', quantity: 1 }],
    });
    const before = sar.received.length;
    const preview = await post(`/api/ricette/${id}/controlla`);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().problemi.some((p: { ruleId: string }) => p.ruleId === 'R14')).toBe(true);
    expect(sar.received.length).toBe(before);
    expect((await post(`/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(422);
  });

  describe('R23 · stupefacenti sulla ricetta del SSN (D272)', () => {
    // Codici AIC degli elenchi della circolare MEF e Salute del 14/05/2020: RITALIN (sezione A,
    // fuori dalla ricetta dematerializzata) e TEMGESIC (allegato III-bis, terapia del dolore).
    const ritalin = {
      drugAic: '035040017',
      drugName: 'RITALIN',
      activeIngredient: 'METILFENIDATO',
    };
    const temgesic = {
      drugAic: '025215043',
      drugName: 'TEMGESIC',
      activeIngredient: 'BUPRENORFINA CLORIDRATO',
    };

    it('sezione A dell’elenco del Ministero: «Firma e invia» si ferma e dice dove va', async () => {
      const id = await draft({ ...pharma(ritalin), exemptionCode: 'TDL01' });
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toMatch(
        /R23: RITALIN: nell'elenco degli stupefacenti della sezione A .*ricettario ministeriale a ricalco/,
      );
    });

    it('allegato III-bis senza il codice della terapia del dolore: si ferma', async () => {
      const id = await draft(pharma({ ...temgesic, posologyText: '1 compressa ogni 8 ore' }));
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toMatch(/R23: TEMGESIC: farmaco dell'allegato III-bis/);
    });

    it('terapia del dolore con TDL01: parte con posologia e telefono del medico nelle note, anche sul promemoria', async () => {
      const id = await draft({
        ...pharma({ ...temgesic, posologyText: '1 compressa ogni 8 ore' }),
        exemptionCode: 'TDL01',
      });
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode, res.body).toBe(200);
      // L'invio, non la richiesta del lotto di NRE che la prima firma può fare (D269).
      const [sent] = await t.db
        .select()
        .from(externalSubmission)
        .where(
          and(eq(externalSubmission.prescriptionId, id), eq(externalSubmission.operation, 'invio')),
        );
      const notes = 'Posologia: 1 compressa ogni 8 ore; tel. del medico 000 0000001';
      expect((sent!.request as { lines: { notes?: string }[] }).lines[0]!.notes).toBe(notes);
      const [doc] = await t.db
        .select()
        .from(prescriptionDocument)
        .where(eq(prescriptionDocument.prescriptionId, id));
      const data = JSON.parse(doc!.content) as { righe: { dettagli: string | null }[] };
      expect(data.righe[0]!.dettagli).toBe(notes);
    });

    it('la cartella dà alla ricetta i codici della terapia del dolore della regola in vigore', async () => {
      const res = await s.app.inject({
        method: 'GET',
        url: `/api/pazienti/${s.richPatient}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().codiciTerapiaDolore).toEqual(['TDL', 'TDL01']);
    });

    it('terapia del dolore senza posologia: si ferma e dice che cosa scrivere', async () => {
      const id = await draft({ ...pharma(temgesic), exemptionCode: 'TDL01' });
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toMatch(
        /R23: TEMGESIC: .*posologia e modalità di somministrazione/,
      );
    });
  });

  describe('R13 · codice della motivazione di non sostituibilità (D273)', () => {
    const named = {
      drugAic: '038092019',
      drugName: 'AMLODIPINA DOC GENERICI 5 MG',
      activeIngredient: 'AMLODIPINA BESILATO',
    };
    /** Il messaggio dell'invio, non la richiesta del lotto di NRE che la firma può fare (D269). */
    const sentMessage = async (id: string) => {
      const [sent] = await t.db
        .select()
        .from(externalSubmission)
        .where(
          and(eq(externalSubmission.prescriptionId, id), eq(externalSubmission.operation, 'invio')),
        );
      return sent!.request as {
        prescriptionIndication?: string | null;
        lines: Record<string, unknown>[];
      };
    };

    it('non sostituibile con la sola motivazione scritta: «Firma e invia» si ferma e dice i codici', async () => {
      const id = await draft(
        pharma({ ...named, notSubstitutable: true, notSubstitutableReason: 'Testo libero' }),
      );
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toMatch(
        /R13: AMLODIPINA DOC GENERICI 5 MG: la clausola di non sostituibilità richiede il codice della motivazione \(1, 2, 3, 4\)/,
      );
    });

    it('con il codice parte: il messaggio al SAR porta il codice e il nome con l’AIC', async () => {
      const id = await draft(
        pharma({ ...named, notSubstitutable: true, notSubstitutableCode: '3' }),
      );
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode, res.body).toBe(200);
      expect((await sentMessage(id)).lines[0]).toMatchObject({
        drugAic: '038092019',
        notSubstitutable: true,
        notSubstitutableCode: '3',
        byActiveIngredient: false,
      });
    });

    it('per principio attivo la clausola non vale: si ferma', async () => {
      const id = await draft(
        pharma({
          ...named,
          byActiveIngredient: true,
          notSubstitutable: true,
          notSubstitutableCode: '1',
        }),
      );
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toMatch(/R13: .*non per una prescrizione per principio attivo/);
    });

    it('la cartella dà alla scheda e alla ricetta i codici della regola in vigore', async () => {
      const res = await s.app.inject({
        method: 'GET',
        url: `/api/pazienti/${s.richPatient}`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(200);
      const reasons = res.json().motivazioniNonSostituibilita as { codice: string }[];
      expect(reasons.map((r) => r.codice)).toEqual(['1', '2', '3', '4']);
    });

    it('la terapia suggerita dallo specialista dà la tipologia S al messaggio (indicazionePrescr)', async () => {
      const created = await post(`/api/pazienti/${s.richPatient}/terapie`, {
        ...named,
        drugName: 'AMLODIPINA DOC GENERICI 5 MG COMPRESSE',
        kind: 'chronic',
        startOn: '2026-11-01',
        packsPerPrescription: 1,
        suggestedS: true,
        suggestedByName: 'Dott. Specialista di prova',
      });
      expect(created.statusCode, created.body).toBe(201);
      const therapyId = created.json<{ id: string }>().id;
      const id = await draft({
        kind: 'pharma_ssn',
        lines: [{ ...named, therapyId, quantity: 1 }],
      });
      const res = await post(`/api/ricette/${id}/firma-e-invia`);
      expect(res.statusCode, res.body).toBe(200);
      expect((await sentMessage(id)).prescriptionIndication).toBe('S');
      // Senza una terapia S o H la tipologia non c'è.
      const plain = await draft(pharma(named));
      expect((await post(`/api/ricette/${plain}/firma-e-invia`)).statusCode).toBe(200);
      expect((await sentMessage(plain)).prescriptionIndication ?? null).toBeNull();
    });
  });

  it('R9: un’esenzione non registrata per il paziente blocca', async () => {
    const id = await draft({ ...pharma(), exemptionCode: 'ZZZ' });
    const res = await post(`/api/ricette/${id}/firma-e-invia`);
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(/R9: Esenzione ZZZ/);
  });

  it('R15 e R16: canale non scelto dal paziente e recapito estraneo bloccano', async () => {
    const id = await draft({
      ...pharma(),
      reminderChannel: 'email',
      reminderContact: 'estraneo@example.org',
    });
    const res = await post(`/api/ricette/${id}/firma-e-invia`);
    expect(res.statusCode).toBe(422);
    const rules = res.json().dettagli.problemi.map((p: { ruleId: string }) => p.ruleId);
    expect(rules).toContain('R15');
    expect(rules).toContain('R16');
    // Ogni blocco spiega il perché e che cosa fare (seconda fermata).
    for (const p of res
      .json()
      .dettagli.problemi.filter((x: { ruleId: string }) => ['R15', 'R16'].includes(x.ruleId))) {
      expect(p.source).toBeTruthy();
      expect(p.remedy).toBeTruthy();
    }
    expect(res.json().errore).toMatch(/ — /);
  });

  it('R11 conta una ricetta fatta con un altro programma e lo dice; quella annullata no (D181)', async () => {
    const [ther] = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    await t.db.update(therapy).set({ unitsPerDay: '1' }).where(eq(therapy.id, ther!.id));
    const fiveDaysAgo = studioDate(new Date(Date.now() - 5 * 86_400_000));
    const imported = {
      patientId: s.richPatient,
      archiveId: s.archives.titolare,
      kind: 'farmaco',
      prescribedOn: fiveDaysAgo,
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'Principio di prova',
      quantity: 1,
      sourceProgram: 'Programma di prova',
      recordedBy: s.users.titolare.id,
    };
    const [wrong] = await t.db
      .insert(historicalPrescription)
      .values({ ...imported, annulledAt: new Date(), annulReason: 'Importata per errore' })
      .returning();
    expect(wrong).toBeDefined();
    const line = {
      therapyId: ther!.id,
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'principio di prova',
      quantity: 1,
    };
    const r11Of = async () => {
      const id = await draft({ kind: 'pharma_ssn', lines: [line] });
      const preview = await post(`/api/ricette/${id}/controlla`);
      expect(preview.statusCode, preview.body).toBe(200);
      const body = preview.json<{ problemi: { ruleId: string; message: string }[] }>();
      return body.problemi.filter((i) => i.ruleId === 'R11');
    };
    // Solo quella annullata: niente da dire.
    expect(await r11Of()).toEqual([]);
    await t.db.insert(historicalPrescription).values(imported);
    const [r11] = await r11Of();
    expect(r11!.message).toMatch(
      /^Farmaco di prova 5 mg: la ricetta del \d{2}\/\d{2}\/\d{4}, fatta con un altro programma \(Programma di prova\), copre fino al \d{2}\/\d{2}\/\d{4} compreso$/,
    );
  });

  it('R11: ricetta in anticipo sulla copertura: solo un’informazione, registrata con il controllo', async () => {
    const [ther] = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    await t.db.update(therapy).set({ unitsPerDay: '1' }).where(eq(therapy.id, ther!.id));
    const line = {
      therapyId: ther!.id,
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'principio di prova',
      quantity: 1,
    };
    const first = await draft({ kind: 'pharma_ssn', lines: [line] });
    expect((await post(`/api/ricette/${first}/firma-e-invia`)).statusCode).toBe(200);
    const second = await draft({ kind: 'pharma_ssn', lines: [line] });
    const sent = await post(`/api/ricette/${second}/firma-e-invia`);
    expect(sent.statusCode, sent.body).toBe(200);
    const passed = (await checks(second)).find((c) => c.outcome === 'superato')!;
    const issues = passed.issues as { ruleId: string; severity: string; message: string }[];
    const r11 = issues.find((i) => i.ruleId === 'R11')!;
    expect(r11.severity).toBe('info');
    expect(r11.message).toMatch(/copre fino al/);
  });

  it('D296: il contesto delle regole porta la regione dello studio; una regione senza pacchetto, nessuna', async () => {
    const id = await draft(pharma());
    const contextRegion = async () =>
      (await buildRuleContext({ db: t.db }, id, { reasons: {}, confirmedAifaNotes: [] })).region;
    expect(region).not.toBeNull();
    expect(await contextRegion()).toBe(region);
    const [place] = await t.db.select().from(studio);
    await t.db
      .update(studio)
      .set({ regionName: 'Regione inventata' })
      .where(eq(studio.id, place!.id));
    expect(await contextRegion()).toBeNull();
    await t.db
      .update(studio)
      .set({ regionName: place!.regionName })
      .where(eq(studio.id, place!.id));
  });

  it('D252: le unità per confezione della descrizione AIFA contano solo con la posologia nella stessa unità', async () => {
    const [ther] = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    const before = ther!.doseUnit;
    const id = await draft({
      kind: 'pharma_ssn',
      lines: [
        {
          therapyId: ther!.id,
          drugAic: ther!.drugAic,
          drugName: 'Farmaco di prova 5 mg',
          activeIngredient: 'principio di prova',
          quantity: 1,
        },
      ],
    });
    // Come dalla banca dati: «- 28 COMPRESSE».
    const drugFacts = () => ({ unitsPerPack: 28, packUnit: 'compressa' });
    const unitsWith = async (doseUnit: string | null) => {
      await t.db.update(therapy).set({ doseUnit }).where(eq(therapy.id, ther!.id));
      const ctx = await buildRuleContext({ db: t.db, drugFacts }, id, {
        reasons: {},
        confirmedAifaNotes: [],
      });
      return ctx.drugFacts(ther!.drugAic)?.unitsPerPack;
    };
    expect(await unitsWith('compressa')).toBe(28);
    expect(await unitsWith('compresse')).toBe(28);
    expect(await unitsWith('goccia')).toBeUndefined();
    expect(await unitsWith(null)).toBeUndefined();
    await t.db.update(therapy).set({ doseUnit: before }).where(eq(therapy.id, ther!.id));
  });
});
