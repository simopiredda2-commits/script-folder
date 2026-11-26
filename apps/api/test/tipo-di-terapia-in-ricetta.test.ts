import { SimulatedGateway, type SimulatedOutcome } from '@mmg/integrations';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalSubmission, prescriptionCheck, prescriptionLine, therapy } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { buildRuleContext, studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Il simulatore risponde con l'esito scelto dalla prova, ricetta per ricetta. */
function scripted() {
  const next: SimulatedOutcome[] = [];
  const decide = () => next.shift() ?? 'accepted';
  return {
    next,
    sar: new SimulatedGateway('sar', { decide }),
    ts: new SimulatedGateway('sistema_ts', { decide }),
  };
}

/**
 * Il tipo di terapia sulla riga della ricetta (D282, D283). Il medico segna tipo, tipologia S o H
 * e «Non rimborsabile SSN» sulla riga del farmaco; alla firma il programma crea la terapia o
 * aggiorna quella collegata. La segreteria segna una proposta, che il medico conferma o no.
 */
describe('tipo di terapia sulla riga della ricetta (D283)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let sim: ReturnType<typeof scripted>;
  const cookies: Record<string, string> = {};
  const ids = {} as Record<
    'update' | 'same' | 'confirm' | 'decline' | 'white' | 'otherPatient',
    string
  >;

  beforeAll(async () => {
    t = await createTestDatabase();
    sim = scripted();
    s = await createScenario(t.db, {}, { gateways: { sar: sim.sar, sistema_ts: sim.ts } });
    for (const who of ['titolare', 'segreteria'] as const) cookies[who] = await login(s, who);
    const add = (drugName: string, values: Partial<typeof therapy.$inferInsert> = {}) =>
      withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .insert(therapy)
          .values({
            patientId: s.richPatient,
            drugName,
            activeIngredient: 'principio di prova',
            kind: 'chronic',
            startOn: '2026-01-01',
            createdBy: s.users.titolare.id,
            ...values,
          })
          .returning({ id: therapy.id }),
      ).then((r) => r[0]!.id);
    ids.update = await add('Farmaco da aggiornare di prova');
    ids.same = await add('Farmaco uguale di prova', { suggestedS: true, suggestedByName: 'Dr. X' });
    ids.confirm = await add('Farmaco proposto e confermato di prova');
    ids.decline = await add('Farmaco proposto e non applicato di prova');
    ids.white = await add('Farmaco della bianca di prova', { notReimbursable: true });
    const other = s.patients.titolare.find((p) => p !== s.richPatient)!;
    const [o] = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(therapy)
        .values({
          patientId: other,
          drugName: 'Farmaco di un altro paziente',
          kind: 'chronic',
          startOn: '2026-01-01',
          createdBy: s.users.titolare.id,
        })
        .returning({ id: therapy.id }),
    );
    ids.otherPatient = o!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (who: string, url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, headers: { cookie: cookies[who]! }, payload });
  const draft = (who: string, body: object) =>
    post(who, `/api/pazienti/${s.richPatient}/ricette`, { kind: 'pharma_ssn', ...body });
  const created = async (who: string, body: object) => {
    const res = await draft(who, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const linesOf = (prescriptionId: string) =>
    t.db.select().from(prescriptionLine).where(eq(prescriptionLine.prescriptionId, prescriptionId));
  const therapyOf = async (id: string) =>
    (await t.db.select().from(therapy).where(eq(therapy.id, id)))[0]!;
  /** Il messaggio partito per ultimo con la ricetta. */
  const sentMessage = async (prescriptionId: string) => {
    const [row] = await t.db
      .select()
      .from(externalSubmission)
      .where(
        and(
          eq(externalSubmission.prescriptionId, prescriptionId),
          eq(externalSubmission.operation, 'invio'),
        ),
      )
      .orderBy(desc(externalSubmission.at))
      .limit(1);
    return row!.request as { prescriptionIndication?: 'S' | 'H' | null };
  };

  it('un farmaco senza terapia, segnato cronico con la S: alla firma la terapia c’è e la riga la prende', async () => {
    const id = await created('titolare', {
      exemptionCode: 'P00',
      lines: [
        {
          drugName: 'Farmaco nuovo di prova 10 mg',
          drugAic: '900000201',
          activeIngredient: 'principio nuovo di prova',
          quantity: 2,
          posologyText: '1 compressa la sera',
          therapyChoice: {
            kind: 'chronic',
            typology: 'S',
            suggestedByName: 'Dr. Specialista di prova',
            suggestedByFacility: 'Ambulatorio di prova',
            suggestedOn: '2026-11-20',
          },
        },
      ],
    });
    // Prima della firma la terapia non c'è: la bozza può ancora essere lasciata.
    const before = await t.db
      .select()
      .from(therapy)
      .where(eq(therapy.drugName, 'Farmaco nuovo di prova 10 mg'));
    expect(before).toHaveLength(0);
    const res = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().esito).toBe('accepted');
    const [line] = await linesOf(id);
    expect(line!.therapyId).not.toBeNull();
    expect(line!.therapyChoiceAppliedAt).not.toBeNull();
    const made = await therapyOf(line!.therapyId!);
    expect(made).toMatchObject({
      patientId: s.richPatient,
      drugName: 'Farmaco nuovo di prova 10 mg',
      drugAic: '900000201',
      activeIngredient: 'principio nuovo di prova',
      kind: 'chronic',
      status: 'active',
      startOn: studioDate(s.clock.now()),
      endOn: null,
      packsPerPrescription: 2,
      // Il testo della posologia non si spezza: va nella frequenza, come per le terapie importate.
      frequency: '1 compressa la sera',
      dose: null,
      unitsPerDay: null,
      habitualExemptionCode: 'P00',
      suggestedS: true,
      hospitalH: false,
      suggestedByName: 'Dr. Specialista di prova',
      suggestedByFacility: 'Ambulatorio di prova',
      suggestedOn: '2026-11-20',
      notReimbursable: false,
      reserved: false,
      createdBy: s.users.titolare.id,
    });
    // La S della riga parte con la ricetta (indicazionePrescr).
    expect((await sentMessage(id)).prescriptionIndication).toBe('S');
  });

  it('sulla terapia collegata la scelta la aggiorna alla firma: ciclo con la fine, H', async () => {
    const id = await created('titolare', {
      lines: [
        {
          therapyId: ids.update,
          drugName: 'Farmaco da aggiornare di prova',
          activeIngredient: 'principio di prova',
          quantity: 1,
          therapyChoice: { kind: 'cycle', endOn: '2027-03-31', typology: 'H' },
        },
      ],
    });
    const [line] = await linesOf(id);
    expect(line).toMatchObject({
      therapyKind: 'cycle',
      therapyTypology: 'H',
      therapyProposedBy: null,
    });
    // Prima della firma la terapia è com'era.
    expect(await therapyOf(ids.update)).toMatchObject({ kind: 'chronic', hospitalH: false });
    const res = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(res.statusCode, res.body).toBe(200);
    expect(await therapyOf(ids.update)).toMatchObject({
      kind: 'cycle',
      endOn: '2027-03-31',
      hospitalH: true,
      suggestedS: false,
      notReimbursable: false,
    });
    expect((await sentMessage(id)).prescriptionIndication).toBe('H');
  });

  it('una scelta uguale alla terapia non resta sulla riga', async () => {
    const id = await created('titolare', {
      lines: [
        {
          therapyId: ids.same,
          drugName: 'Farmaco uguale di prova',
          quantity: 1,
          therapyChoice: { kind: 'chronic', typology: 'S', suggestedByName: 'Dr. X' },
        },
      ],
    });
    const [line] = await linesOf(id);
    expect(line).toMatchObject({ therapyKind: null, therapyTypology: null });
  });

  it('i controlli della scelta: suggeritore, fine del ciclo, ricetta bianca, prestazioni, paziente', async () => {
    const drug = { drugName: 'Farmaco di controllo', drugAic: '900000202', quantity: 1 };
    const cases: [object, number, RegExp][] = [
      [
        { lines: [{ ...drug, therapyChoice: { kind: 'chronic', typology: 'S' } }] },
        400,
        /medico suggeritore/,
      ],
      [{ lines: [{ ...drug, therapyChoice: { kind: 'cycle' } }] }, 400, /manca la data di fine/],
      [
        { lines: [{ ...drug, therapyChoice: { kind: 'cycle', endOn: '2020-01-31' } }] },
        400,
        /finisce prima di oggi/,
      ],
      [
        { lines: [{ ...drug, therapyChoice: { kind: 'chronic', notReimbursable: true } }] },
        400,
        /va in ricetta bianca/,
      ],
      // Una prestazione nella ricetta dei farmaci: la riga non è di un farmaco.
      [
        {
          lines: [
            {
              serviceCode: '89.7',
              serviceDescription: 'Visita di prova',
              quantity: 1,
              therapyChoice: { kind: 'chronic' },
            },
          ],
        },
        400,
        /solo sulle righe dei farmaci/,
      ],
      // Un farmaco nella ricetta specialistica: la ricetta non è dei farmaci.
      [
        { kind: 'specialist_ssn', lines: [{ ...drug, therapyChoice: { kind: 'chronic' } }] },
        400,
        /nella ricetta dei farmaci/,
      ],
      [
        {
          lines: [
            {
              therapyId: ids.otherPatient,
              drugName: 'Farmaco di un altro paziente',
              quantity: 1,
              therapyChoice: { kind: 'as_needed' },
            },
          ],
        },
        404,
        /Terapia non trovata/,
      ],
    ];
    for (const [body, code, message] of cases) {
      const res = await draft('titolare', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(code);
      expect(res.body, JSON.stringify(body)).toMatch(message);
    }
    // «Non rimborsabile SSN» in ricetta bianca va bene.
    const ok = await draft('titolare', {
      kind: 'white',
      lines: [{ ...drug, therapyChoice: { kind: 'as_needed', notReimbursable: true } }],
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  /** La segreteria prepara la ripetizione con una proposta e la manda alla firma. */
  async function proposed(therapyId: string, drugName: string) {
    const id = await created('segreteria', {
      lines: [
        {
          therapyId,
          drugName,
          quantity: 1,
          therapyChoice: {
            kind: 'chronic',
            typology: 'S',
            suggestedByName: 'Dr. Cardiologo di prova',
            suggestedByFacility: 'Ospedale di prova',
          },
        },
      ],
    });
    const [line] = await linesOf(id);
    expect(line).toMatchObject({
      therapyKind: 'chronic',
      therapyTypology: 'S',
      therapyProposedBy: s.users.segreteria.id,
      therapyProposalDecision: null,
    });
    const sent = await post('segreteria', `/api/ricette/${id}/da-firmare`);
    expect(sent.statusCode, sent.body).toBe(200);
    return { id, lineId: line!.id };
  }

  it('la proposta della segreteria ferma la firma finché il medico non decide; confermata, vale', async () => {
    const { id, lineId } = await proposed(ids.confirm, 'Farmaco proposto e confermato di prova');
    // Il controllo la mostra al medico, con la decisione da prendere.
    const check = await post('titolare', `/api/ricette/${id}/controlla`);
    expect(check.statusCode, check.body).toBe(200);
    const issue = check
      .json<{ problemi: { ruleId: string; severity: string; needs?: string; lineId?: string }[] }>()
      .problemi.find((p) => p.ruleId === 'PROPOSTA');
    expect(issue).toMatchObject({ severity: 'warn', needs: 'therapy_decision', lineId });
    // Senza decisione non parte, e la terapia resta com'è.
    const stopped = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(stopped.statusCode).toBe(422);
    expect(stopped.body).toMatch(/PROPOSTA/);
    expect(await therapyOf(ids.confirm)).toMatchObject({ suggestedS: false });
    // Confermata: la terapia si aggiorna e la S parte con la ricetta.
    const res = await post('titolare', `/api/ricette/${id}/firma-e-invia`, {
      proposte: { [lineId]: 'conferma' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await therapyOf(ids.confirm)).toMatchObject({
      suggestedS: true,
      suggestedByName: 'Dr. Cardiologo di prova',
      suggestedByFacility: 'Ospedale di prova',
    });
    const [line] = await linesOf(id);
    expect(line!.therapyProposalDecision).toBe('confirmed');
    expect((await sentMessage(id)).prescriptionIndication).toBe('S');
    // La decisione resta scritta nel controllo dell'invio.
    const checks = await t.db
      .select()
      .from(prescriptionCheck)
      .where(eq(prescriptionCheck.prescriptionId, id))
      .orderBy(desc(prescriptionCheck.at));
    expect(JSON.stringify(checks[0]!.issues)).toContain('Proposta della segreteria confermata');
  });

  it('il medico può non applicare la proposta: la ricetta parte con la terapia com’è', async () => {
    const { id, lineId } = await proposed(ids.decline, 'Farmaco proposto e non applicato di prova');
    const res = await post('titolare', `/api/ricette/${id}/firma-e-invia`, {
      proposte: { [lineId]: 'non_applicare' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await therapyOf(ids.decline)).toMatchObject({
      suggestedS: false,
      suggestedByName: null,
    });
    const [line] = await linesOf(id);
    expect(line!.therapyProposalDecision).toBe('declined');
    expect((await sentMessage(id)).prescriptionIndication).toBeNull();
  });

  it('le regole vedono già il tipo scelto; quello proposto solo confermato', async () => {
    const asNeeded = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(therapy)
        .values({
          patientId: s.richPatient,
          drugName: 'Farmaco al bisogno di prova',
          activeIngredient: 'principio di prova',
          kind: 'as_needed',
          startOn: '2026-01-01',
          createdBy: s.users.titolare.id,
        })
        .returning({ id: therapy.id }),
    ).then((r) => r[0]!.id);
    const kindSeen = async (id: string, proposals = {}) =>
      (
        await buildRuleContext({ db: t.db }, id, {
          reasons: {},
          confirmedAifaNotes: [],
          proposals,
        })
      ).prescription.lines[0]!.therapy?.kind;
    const mine = await created('titolare', {
      lines: [
        {
          therapyId: asNeeded,
          drugName: 'Farmaco al bisogno di prova',
          activeIngredient: 'principio di prova',
          quantity: 1,
          therapyChoice: { kind: 'chronic' },
        },
      ],
    });
    // Del medico: vale subito, per R4 e R11 che guardano la terapia cronica.
    expect(await kindSeen(mine)).toBe('chronic');
    // Della segreteria: la proposta vale solo confermata.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(prescriptionLine)
        .set({ therapyProposedBy: s.users.segreteria.id })
        .where(eq(prescriptionLine.prescriptionId, mine)),
    );
    expect(await kindSeen(mine)).toBe('as_needed');
    const [line] = await linesOf(mine);
    expect(await kindSeen(mine, { [line!.id]: 'confirmed' })).toBe('chronic');
    expect(await kindSeen(mine, { [line!.id]: 'declined' })).toBe('as_needed');
  });

  it('la scelta passa alla terapia una volta sola: un nuovo invio non la rifà', async () => {
    const id = await created('titolare', {
      kind: 'white',
      lines: [
        {
          therapyId: ids.white,
          drugName: 'Farmaco della bianca di prova',
          activeIngredient: 'principio di prova',
          quantity: 1,
          therapyChoice: { kind: 'as_needed', notReimbursable: true },
        },
      ],
    });
    // Il Sistema TS non risponde: la ricetta resta in errore, ma la scelta è fatta con la firma.
    sim.next.push('unreachable');
    const first = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(first.json().esito).toBe('unreachable');
    expect(await therapyOf(ids.white)).toMatchObject({ kind: 'as_needed' });
    // Intanto il medico cambia la scheda; il nuovo invio non la riporta indietro.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(therapy).set({ kind: 'chronic' }).where(eq(therapy.id, ids.white)),
    );
    const again = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(again.json().esito).toBe('accepted');
    expect(await therapyOf(ids.white)).toMatchObject({ kind: 'chronic' });
  });
});
