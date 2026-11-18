import { SimulatedGateway } from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prescription, prescriptionCheck, prescriptionLine, therapy } from '../src/db/schema';
import { createRulesCheck } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

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
    expect(body.dettagli.versioneRegole).toBe('2026-11-18.2');
    expect(body.dettagli.problemi.some((p: { ruleId: string }) => p.ruleId === 'R2')).toBe(true);
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(row!.status).toBe('draft');
    const [c] = await checks(id);
    expect(c!.outcome).toBe('bloccato');
    expect(c!.rulesVersion).toBe('2026-11-18.2');
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
    expect(row!.rulesVersion).toBe('2026-11-18.2');
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
});
