import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, historicalPrescription, therapy } from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface DrugEntry {
  chiave: string;
  storico: Record<string, string>;
  farmaco: string;
  principioAttivo: string | null;
  aic: string | null;
  terapia: {
    id: string;
    tipo: string;
    stato: string;
    tipologia: 'S' | 'H' | null;
    riservata: boolean;
  } | null;
  ricette: number;
  prescritte: number;
  inPreparazione: number;
  annullate: number;
  ultimaIl: string | null;
  ultimi12Mesi: number;
  ultimaPrescrizione: { il: string; quantita: number | null; altroProgramma: boolean } | null;
}

interface ServiceEntry {
  chiave: string;
  storico: Record<string, string>;
  codice: string | null;
  descrizione: string;
  gruppo: 'visita' | 'altro';
  ricette: number;
  prescritte: number;
  ultimi12Mesi: number;
}

/**
 * Tutti i farmaci e tutte le prestazioni prescritti restano nella cartella, ognuno con il suo
 * storico (D152). Prova centrale: per ogni voce, lo storico che la voce apre mostra proprio le
 * ricette che la voce conta.
 */
describe('farmaci e prestazioni prescritti nella cartella (D152)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  const ids: Record<string, string> = {};

  const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const draft = async (body: object) => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, doctor, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const send = async (id: string) => {
    const res = await req('POST', `/api/ricette/${id}/firma-e-invia`, doctor, {});
    expect(res.statusCode, res.body).toBe(200);
  };
  const drugs = async (cookie = doctor) => {
    const res = await req('GET', `/api/pazienti/${s.richPatient}/farmaci-prescritti`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ farmaci: DrugEntry[] }>().farmaci;
  };
  const services = async (cookie = doctor) => {
    const res = await req('GET', `/api/pazienti/${s.richPatient}/prestazioni-prescritte`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ prestazioni: ServiceEntry[] }>().prestazioni;
  };
  const history = async (query: Record<string, string>, cookie = doctor) => {
    const res = await req(
      'GET',
      `/api/pazienti/${s.richPatient}/storico-prescrizioni?${new URLSearchParams(query)}`,
      cookie,
    );
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ voci: { ricetta: { id: string } }[]; ultimi12Mesi: number }>();
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    const existing = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    ids.chronic = existing.find((r) => !r.reserved)!.id;
    ids.reserved = existing.find((r) => r.reserved)!.id;
    const add = (values: Partial<typeof therapy.$inferInsert> & { drugName: string }) =>
      withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .insert(therapy)
          .values({
            patientId: s.richPatient,
            kind: 'chronic',
            startOn: '2026-01-01',
            createdBy: s.users.titolare.id,
            ...values,
          })
          .returning(),
      ).then((r) => r[0]!.id);
    ids.cycle = await add({
      drugName: 'Ciclo di prova 500 mg',
      drugAic: '900000011',
      activeIngredient: 'principio del ciclo',
      kind: 'cycle',
      endOn: '2026-12-31',
    });
    ids.asNeeded = await add({
      drugName: 'Al bisogno di prova',
      activeIngredient: 'principio al bisogno',
      kind: 'as_needed',
      suggestedS: true,
      suggestedByName: 'Specialista di prova',
    });
    ids.suspended = await add({
      drugName: 'Sospeso di prova',
      activeIngredient: 'principio sospeso',
      status: 'suspended',
      suspendedReason: 'Motivo di prova',
    });

    const pharma = (lines: object[]) => draft({ kind: 'pharma_ssn', lines });
    const chronicLine = {
      therapyId: ids.chronic,
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'principio di prova',
    };
    await send(await pharma([{ ...chronicLine, quantity: 2 }]));
    await send(await pharma([{ ...chronicLine, quantity: 1 }]));
    // Senza terapia, ma con il principio della terapia cronica: è di quella terapia.
    await send(
      await draft({
        kind: 'white',
        lines: [{ drugName: 'Altro marchio', activeIngredient: 'Principio di prova', quantity: 1 }],
      }),
    );
    // Senza terapia ma con l'AIC del ciclo: è del ciclo.
    await send(
      await pharma([
        {
          drugName: 'Ciclo di prova 500 mg',
          drugAic: '900000011',
          activeIngredient: 'principio del ciclo',
          quantity: 1,
        },
        {
          therapyId: ids.asNeeded,
          drugName: 'Al bisogno di prova',
          activeIngredient: 'principio al bisogno',
          quantity: 1,
        },
      ]),
    );
    // Prescrizioni occasionali, senza terapia in cartella: per AIC, per principio, per nome.
    await send(
      await pharma([
        {
          drugName: 'Occasionale per AIC 10 mg',
          drugAic: '900000029',
          activeIngredient: 'principio occasionale',
          quantity: 1,
        },
      ]),
    );
    await pharma([
      {
        drugName: 'Occasionale per AIC 10 mg',
        drugAic: '900000029',
        activeIngredient: 'principio occasionale',
        quantity: 1,
      },
    ]);
    // Un'altra confezione dello stesso principio, con un altro AIC: è un'altra voce, con le
    // sue ricette (per AIC, non per principio).
    await send(
      await pharma([
        {
          drugName: 'Occasionale per AIC 20 mg',
          drugAic: '900000037',
          activeIngredient: 'principio occasionale',
          quantity: 1,
        },
      ]),
    );
    await send(
      await pharma([
        {
          drugName: 'PRINCIPIO SOLO 20MG',
          activeIngredient: 'principio solo',
          byActiveIngredient: true,
          quantity: 1,
        },
      ]),
    );
    await send(
      await draft({ kind: 'white', lines: [{ drugName: 'Galenico scritto a mano', quantity: 1 }] }),
    );
    // La terapia riservata, con una sua ricetta.
    await send(
      await pharma([
        {
          therapyId: ids.reserved,
          drugName: 'Farmaco riservato di prova',
          activeIngredient: 'principio riservato',
          quantity: 1,
        },
      ]),
    );

    const spec = (lines: object[]) =>
      draft({
        kind: 'specialist_ssn',
        accessType: 'first',
        priority: 'P',
        diagnosticQuestion: 'Quesito di prova',
        lines,
      });
    await send(
      await spec([
        {
          serviceCode: '89.7',
          serviceNationalCode: '89.7',
          serviceDescription: 'Visita di prova',
          quantity: 1,
        },
      ]),
    );
    await spec([
      {
        serviceCode: '89.7',
        serviceNationalCode: '89.7',
        serviceDescription: 'Visita di prova',
        quantity: 1,
      },
    ]);
    // Senza codice la ricetta non parte (R10): resta in bozza, ma resta nella cartella.
    await spec([{ serviceDescription: 'Visita chirurgica - primo accesso', quantity: 1 }]);
    await send(
      await spec([
        {
          serviceCode: 'PR.01',
          serviceNationalCode: 'PR.01',
          serviceDescription: 'ESAME DI PROVA DEL SANGUE',
          quantity: 1,
        },
        {
          serviceCode: 'PR.02',
          serviceNationalCode: 'PR.02',
          serviceDescription: 'INTERVENTO DI PROVA. INCLUSO: DUE VISITE DI CONTROLLO',
          quantity: 1,
        },
      ]),
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('ogni voce apre lo storico delle ricette che conta (stesse regole di D65)', async () => {
    const list = await drugs();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      const h = await history(entry.storico);
      const prescriptions = new Set(h.voci.map((v) => v.ricetta.id));
      expect(prescriptions.size, entry.chiave).toBe(entry.ricette);
      expect(h.ultimi12Mesi, entry.chiave).toBe(entry.ultimi12Mesi);
    }
  });

  it('le terapie, anche senza ricette, con tipo, stato e tipologia sulla ricetta', async () => {
    const list = await drugs();
    const byTherapy = (id: string) => list.find((e) => e.terapia?.id === id)!;
    // Due ricette sue, una senza terapia con lo stesso principio, e la bozza dello scenario.
    expect(byTherapy(ids.chronic!)).toMatchObject({
      terapia: { tipo: 'chronic', stato: 'active', tipologia: null },
      ricette: 4,
      prescritte: 3,
      inPreparazione: 1,
      ultimi12Mesi: 4,
    });
    expect(byTherapy(ids.cycle!)).toMatchObject({ terapia: { tipo: 'cycle' }, ricette: 1 });
    expect(byTherapy(ids.asNeeded!)).toMatchObject({
      terapia: { tipo: 'as_needed', tipologia: 'S' },
      ricette: 1,
    });
    expect(byTherapy(ids.suspended!)).toMatchObject({
      terapia: { stato: 'suspended' },
      ricette: 0,
      ultimaIl: null,
    });
  });

  it('le prescrizioni senza terapia: una voce per AIC, per principio attivo o per nome', async () => {
    const occasional = (await drugs()).filter((e) => !e.terapia);
    expect(occasional.map((e) => e.storico)).toEqual([
      { farmaco: 'Galenico scritto a mano' },
      { aic: '900000029' },
      { aic: '900000037' },
      { principio: 'principio solo' },
    ]);
    const byAic = occasional.find((e) => e.aic === '900000029')!;
    expect(byAic).toMatchObject({ ricette: 2, prescritte: 1, inPreparazione: 1 });
    expect(occasional.find((e) => e.aic === '900000037')).toMatchObject({ ricette: 1 });
  });

  it('la segreteria non vede la terapia riservata, né le sue righe sotto un altro nome', async () => {
    const forDoctor = await drugs();
    expect(forDoctor.some((e) => e.terapia?.id === ids.reserved)).toBe(true);
    const forSecretary = await drugs(secretary);
    expect(JSON.stringify(forSecretary)).not.toMatch(/Farmaco riservato|principio riservato/i);
    expect(forSecretary).toHaveLength(forDoctor.length - 1);
  });

  it('le prestazioni: per codice o per descrizione, divise in visite ed esami', async () => {
    const list = await services();
    expect(list.map((e) => [e.codice, e.descrizione, e.gruppo, e.ricette, e.prescritte])).toEqual([
      ['PR.01', 'ESAME DI PROVA DEL SANGUE', 'altro', 1, 1],
      ['PR.02', 'INTERVENTO DI PROVA. INCLUSO: DUE VISITE DI CONTROLLO', 'altro', 1, 1],
      [null, 'Visita chirurgica - primo accesso', 'visita', 1, 0],
      ['89.7', 'Visita di prova', 'visita', 2, 1],
    ]);
    for (const entry of list) {
      const h = await history(entry.storico);
      expect(new Set(h.voci.map((v) => v.ricetta.id)).size, entry.chiave).toBe(entry.ricette);
      expect(h.ultimi12Mesi, entry.chiave).toBe(entry.ultimi12Mesi);
    }
  });

  it('lo storico di un farmaco scritto a mano, per nome', async () => {
    const h = await history({ farmaco: 'galenico SCRITTO a mano' });
    expect(h.voci).toHaveLength(1);
  });

  it('ogni lettura è registrata', async () => {
    await drugs();
    await services();
    for (const action of ['lettura_farmaci_prescritti', 'lettura_prestazioni_prescritte']) {
      const logged = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, action)));
      expect(logged.length, action).toBeGreaterThan(0);
    }
  });
  it('l’ultima ricetta di ogni farmaco con le sue confezioni, e l’elenco dalla più recente (D245)', async () => {
    const pharma = (lines: object[]) => draft({ kind: 'pharma_ssn', lines });
    const day = () => studioDate(s.clock.now());
    // Giorni dopo: la sessione di prima è scaduta, si rientra.
    const later = async (days: number) => {
      s.clock.advance(days * 86_400_000);
      doctor = await login(s, 'titolare');
    };
    const first = day();
    const before = await drugs();
    // Tutte le ricette dello stesso giorno: a parità, per nome; la terapia mai prescritta in fondo.
    expect(before.find((e) => e.terapia?.id === ids.suspended)!.ultimaPrescrizione).toBeNull();
    expect(before.filter((e) => e.terapia).at(-1)!.terapia!.id).toBe(ids.suspended);
    expect(before.find((e) => e.aic === '900000029')!.ultimaPrescrizione).toEqual({
      il: first,
      quantita: 1,
      altroProgramma: false,
    });

    await later(2);
    const second = day();
    await send(
      await pharma([
        {
          drugName: 'Occasionale per AIC 20 mg',
          drugAic: '900000037',
          activeIngredient: 'principio occasionale',
          quantity: 2,
        },
      ]),
    );
    // Due righe dello stesso farmaco nella stessa ricetta: le confezioni si sommano.
    await send(
      await draft({
        kind: 'white',
        lines: [
          { therapyId: ids.cycle, drugName: 'Ciclo di prova 500 mg', quantity: 2 },
          { therapyId: ids.cycle, drugName: 'Ciclo di prova 500 mg', quantity: 1 },
        ],
      }),
    );
    // Un farmaco prescritto solo con il programma di prima: la sua ultima ricetta è quella.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.insert(historicalPrescription).values({
        patientId: s.richPatient,
        archiveId: s.archives.titolare,
        kind: 'farmaco',
        prescribedOn: second,
        drugName: 'Farmaco solo passato',
        quantity: 2,
        sourceProgram: 'Programma di prova',
        recordedBy: s.users.titolare.id,
      }),
    );
    // Una bozza più recente non è una ricetta prescritta.
    await later(1);
    await pharma([
      {
        drugName: 'Occasionale per AIC 10 mg',
        drugAic: '900000029',
        activeIngredient: 'principio occasionale',
        quantity: 2,
      },
    ]);
    // Una ricetta fatta con un altro programma, la più recente di tutte, senza le confezioni.
    await later(1);
    const third = day();
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.insert(historicalPrescription).values({
        patientId: s.richPatient,
        archiveId: s.archives.titolare,
        kind: 'farmaco',
        prescribedOn: third,
        drugName: 'PRINCIPIO SOLO 20MG',
        activeIngredient: 'principio solo',
        sourceProgram: 'Programma di prova',
        recordedBy: s.users.titolare.id,
      }),
    );

    const after = await drugs();
    const last = (pick: (e: DrugEntry) => boolean) => after.find(pick)!.ultimaPrescrizione;
    expect(last((e) => e.aic === '900000037')).toEqual({
      il: second,
      quantita: 2,
      altroProgramma: false,
    });
    expect(last((e) => e.terapia?.id === ids.cycle)).toEqual({
      il: second,
      quantita: 3,
      altroProgramma: false,
    });
    expect(last((e) => e.aic === '900000029')).toEqual({
      il: first,
      quantita: 1,
      altroProgramma: false,
    });
    expect(last((e) => e.storico.farmaco === 'Farmaco solo passato')).toEqual({
      il: second,
      quantita: 2,
      altroProgramma: true,
    });
    expect(last((e) => e.storico.principio === 'principio solo')).toEqual({
      il: third,
      quantita: null,
      altroProgramma: true,
    });
    // Le terapie, poi le voci senza terapia: in ogni parte dalla più recente.
    expect(after.filter((e) => e.terapia)[0]!.terapia!.id).toBe(ids.cycle);
    expect(after.filter((e) => !e.terapia).map((e) => e.storico)).toEqual([
      { principio: 'principio solo' },
      { farmaco: 'Farmaco solo passato' },
      { aic: '900000037' },
      { farmaco: 'Galenico scritto a mano' },
      { aic: '900000029' },
    ]);
  });

  it('una bozza mai partita, o annullata, non mette un farmaco fra i prescritti (audit, D259)', async () => {
    const solo = {
      drugName: 'Solo in bozza 5 mg',
      drugAic: '900000110',
      activeIngredient: 'principio in bozza',
      quantity: 1,
    };
    const kept = await draft({ kind: 'pharma_ssn', lines: [solo] });
    expect((await drugs()).find((e) => e.aic === '900000110')).toBeUndefined();
    // Annullata («Nuova ricetta da capo», «Modifica la ricetta»): nemmeno.
    const cancelled = await req('POST', `/api/ricette/${kept}/annulla`, doctor, {
      motivo: 'Lasciata con «Nuova ricetta da capo»',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await drugs()).find((e) => e.aic === '900000110')).toBeUndefined();
    // Inviata: c'è, e conta anche la bozza annullata, come il suo storico.
    await send(await draft({ kind: 'pharma_ssn', lines: [solo] }));
    const entry = (await drugs()).find((e) => e.aic === '900000110')!;
    expect(entry).toMatchObject({ prescritte: 1, annullate: 1, terapia: null });
  });
});
