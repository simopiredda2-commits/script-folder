import { SimulatedGateway } from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { patient, patientChoice, prescription, prescriptionCheck, therapy } from '../src/db/schema';
import { createRulesCheck, studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { regionalGateway } from './helpers/regional-gateway';

/** Giorno di oggi nello studio, spostato di `days` giorni (AAAA-MM-GG). */
const day = (days: number) => studioDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
const it_ = (iso: string) => iso.split('-').reverse().join('/');

describe('stato del paziente alla ricetta (R19, R20; D199)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const sar = regionalGateway();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { regional: sar, sistema_ts: new SimulatedGateway('sistema_ts') },
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
  const draft = async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [
        { drugName: 'Farmaco di prova 5 mg', activeIngredient: 'principio di prova', quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const setStatus = (
    status: 'active' | 'revoked' | 'deceased' | 'temporary',
    deceasedOn?: string,
  ) =>
    t.db
      .update(patient)
      .set({ status, deceasedOn: deceasedOn ?? null, deathCauseIcd: null })
      .where(eq(patient.id, s.richPatient));
  const choices = () =>
    t.db.select().from(patientChoice).where(eq(patientChoice.patientId, s.richPatient));
  const addChoice = async (chosenOn: string, expiresOn: string | null, endedOn?: string) => {
    const [c] = await t.db
      .insert(patientChoice)
      .values({
        patientId: s.richPatient,
        doctorUserId: s.users.titolare.id,
        chosenOn,
        expiresOn,
        endedOn: endedOn ?? null,
        endReason: endedOn ? 'revoca' : null,
        source: 'manual',
      })
      .returning();
    return c!;
  };
  const issues = async (id: string) => {
    const res = await post(`/api/ricette/${id}/controlla`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ problemi: { ruleId: string; severity: string; message: string }[] }>()
      .problemi;
  };
  const of = async (id: string, rule: string) =>
    (await issues(id)).filter((i) => i.ruleId === rule);

  beforeEach(async () => {
    // Ogni prova parte da un paziente in carico, senza scelte registrate.
    await setStatus('active');
    const mine = await choices();
    for (const c of mine.filter((x) => !x.annulledAt))
      await t.db
        .update(patientChoice)
        .set({ annulledAt: new Date(), annulledBy: s.users.titolare.id, annulReason: 'Prova' })
        .where(eq(patientChoice.id, c.id));
  });

  it('in carico: nessun problema di stato', async () => {
    const id = await draft();
    expect(await of(id, 'R19')).toEqual([]);
    expect(await of(id, 'R20')).toEqual([]);
  });

  it('deceduto: la bozza e la ripetizione non si fanno; una bozza di prima si ferma all’invio con R19', async () => {
    const before = await draft();
    const died = day(-2);
    await setStatus('deceased', died);
    const created = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().errore).toBe(
      `Il paziente risulta deceduto il ${it_(died)}: la ricetta non si fa`,
    );
    const [ther] = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    const repeat = await post(`/api/pazienti/${s.richPatient}/ricette/ripeti`, {
      terapie: [ther!.id],
    });
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json().errore).toMatch(/deceduto/);

    const sent = sar.received.length;
    // Un motivo non basta: R19 blocca.
    const res = await post(`/api/ricette/${before}/firma-e-invia`, { motivi: { R19: 'Prova' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(
      new RegExp(`^R19: Il paziente risulta deceduto il ${it_(died)}: la ricetta non si fa`),
    );
    expect(sar.received.length).toBe(sent);
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, before));
    expect(row!.status).toBe('draft');
    const [check] = await t.db
      .select()
      .from(prescriptionCheck)
      .where(eq(prescriptionCheck.prescriptionId, before));
    expect(check!.outcome).toBe('bloccato');
  });

  it('revocato: R20 chiede un motivo; con il motivo la ricetta parte e il motivo resta nel controllo', async () => {
    const id = await draft();
    const ended = day(-10);
    await addChoice('2020-01-01', null, ended);
    await setStatus('revoked');
    const [warn] = await of(id, 'R20');
    expect(warn).toMatchObject({
      severity: 'warn',
      message: `Paziente revocato: la scelta del medico è cessata il ${it_(ended)}. Serve un motivo per procedere`,
    });
    expect((await post(`/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(422);
    const ok = await post(`/api/ricette/${id}/firma-e-invia`, {
      motivi: { R20: 'Visita occasionale' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const passed = await t.db
      .select()
      .from(prescriptionCheck)
      .where(
        and(eq(prescriptionCheck.prescriptionId, id), eq(prescriptionCheck.outcome, 'superato')),
      );
    expect(passed[0]!.reasons).toEqual({ R20: 'Visita occasionale' });
  });

  it('temporaneo: nessun avviso finché la scelta vale; scaduta, o annullata, R20', async () => {
    const id = await draft();
    await setStatus('temporary');
    // Senza scelte: avviso.
    expect((await of(id, 'R20'))[0]!.message).toBe(
      'Paziente temporaneo senza una scelta in corso. Serve un motivo per procedere',
    );
    const c = await addChoice(day(-30), day(30));
    expect(await of(id, 'R20')).toEqual([]);
    // L'ultimo giorno della scelta vale ancora.
    await t.db
      .update(patientChoice)
      .set({ expiresOn: day(0) })
      .where(eq(patientChoice.id, c.id));
    expect(await of(id, 'R20')).toEqual([]);
    await t.db
      .update(patientChoice)
      .set({ expiresOn: day(-1) })
      .where(eq(patientChoice.id, c.id));
    expect((await of(id, 'R20'))[0]!.message).toBe(
      `Paziente temporaneo: la scelta è scaduta il ${it_(day(-1))}. Serve un motivo per procedere`,
    );
    // Una scelta annullata non vale, anche se nelle date sarebbe in corso.
    const annulled = await addChoice(day(-5), day(60));
    await t.db
      .update(patientChoice)
      .set({ annulledAt: new Date(), annulledBy: s.users.titolare.id, annulReason: 'Prova' })
      .where(eq(patientChoice.id, annulled.id));
    expect((await of(id, 'R20'))[0]!.severity).toBe('warn');
  });
});
