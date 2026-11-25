import { SimulatedGateway, type SimulatedOutcome } from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  externalSubmission,
  prescription,
  prescriptionLine,
  therapy,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Il simulatore risponde con l'esito scelto dalla prova, ricetta per ricetta. */
function scripted() {
  const next: SimulatedOutcome[] = [];
  const cancels: SimulatedOutcome[] = [];
  const decide = () => next.shift() ?? 'accepted';
  const decideCancel = () => cancels.shift() ?? 'accepted';
  return {
    next,
    cancels,
    sar: new SimulatedGateway('sar', { decide, decideCancel }),
    ts: new SimulatedGateway('sistema_ts', { decide, decideCancel }),
  };
}

describe('ciclo della ricetta', () => {
  let t: TestDatabase;
  let s: Scenario;
  let sim: ReturnType<typeof scripted>;
  const c: Record<string, string> = {};
  let chronicTherapy: string;
  let reservedTherapy: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    sim = scripted();
    s = await createScenario(t.db, {}, { gateways: { sar: sim.sar, sistema_ts: sim.ts } });
    for (const who of ['titolare', 'segreteria', 'sostituto', 'collega'] as const) {
      c[who] = await login(s, who);
    }
    const ts = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    chronicTherapy = ts.find((x) => !x.reserved)!.id;
    reservedTherapy = ts.find((x) => x.reserved)!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (who: string, url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, payload, headers: { cookie: c[who]! } });
  const get = (who: string, url: string) =>
    s.app.inject({ method: 'GET', url, headers: { cookie: c[who]! } });
  const status = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;
  const newDraft = async (who = 'titolare', kind = 'pharma_ssn') => {
    const res = await post(who, `/api/pazienti/${s.richPatient}/ricette`, {
      kind,
      lines: [
        { drugName: 'Farmaco di prova 5 mg', activeIngredient: 'principio di prova', quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };

  it('il medico prepara una bozza, la mette da firmare, la firma: inviata con NRE', async () => {
    const id = await newDraft();
    expect((await status(id)).status).toBe('draft');
    expect((await post('titolare', `/api/ricette/${id}/da-firmare`)).statusCode).toBe(200);
    expect((await status(id)).status).toBe('to_sign');
    const sent = await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(sent.json()).toMatchObject({ esito: 'accepted' });
    const row = await status(id);
    expect(row.status).toBe('sent');
    // L'NRE è del lotto del medico, dato dal simulatore del SAR con il raggruppamento «ZZ» (D269).
    expect(row.nre).toMatch(/^010ZZ4\d{9}$/);
    expect(row.assignedNre).toBe(row.nre);
    expect(row.signedBy).toBe(s.users.titolare.id);
  });

  it('ogni invio esterno conserva richiesta, risposta ed esito, e non si modifica', async () => {
    // Il primo è la richiesta del lotto di NRE (D269); poi l'invio della ricetta.
    const rows = await t.db
      .select()
      .from(externalSubmission)
      .where(eq(externalSubmission.operation, 'invio'));
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0]!;
    expect(r.system).toBe('sar');
    expect(r.environment).toBe('simulator');
    expect(JSON.stringify(r.request)).toContain('Farmaco di prova');
    expect(r.outcome).toBe('accepted');
    await expect(t.db.execute(sql`update external_submission set outcome = 'x'`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from external_submission`)).rejects.toThrow();
  });

  it('la segreteria prepara la ripetizione di una cronica: va nella coda «da firmare» del medico', async () => {
    const res = await post('segreteria', `/api/pazienti/${s.richPatient}/ricette/ripeti`, {
      terapie: [chronicTherapy],
    });
    expect(res.statusCode, res.body).toBe(201);
    const [id] = res.json<{ ricette: string[] }>().ricette;
    const row = await status(id!);
    expect(row.status).toBe('to_sign');
    expect(row.preparedBy).toBe(s.users.segreteria.id);
    const queue = (await get('titolare', '/api/ricette/da-firmare')).json();
    const group = queue.pazienti.find(
      (g: { paziente: { id: string } }) => g.paziente.id === s.richPatient,
    );
    expect(group.ricette.map((r: { id: string }) => r.id)).toContain(id);
    // La segreteria non firma.
    expect((await post('segreteria', `/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(403);
    // Il medico sì: la ricetta è a nome suo.
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'accepted',
    );
    expect((await status(id!)).signedBy).toBe(s.users.titolare.id);
  });

  it('ripetizioni raggruppate: stesso tipo ed esenzione, entro il limite di confezioni di R2', async () => {
    const mk = async (name: string, extra: Partial<typeof therapy.$inferInsert> = {}) => {
      const [row] = await t.db
        .insert(therapy)
        .values({
          patientId: s.richPatient,
          drugName: name,
          activeIngredient: `principio ${name}`,
          kind: 'chronic',
          startOn: '2026-01-01',
          createdBy: s.users.titolare.id,
          ...extra,
        })
        .returning();
      return row!.id;
    };
    const a = await mk('A');
    const b = await mk('B');
    const cc = await mk('C');
    const d = await mk('D', { packsPerPrescription: 2 });
    const w = await mk('W', { notReimbursable: true });
    const e = await mk('E', { habitualExemptionCode: '048' });
    const res = await post('segreteria', `/api/pazienti/${s.richPatient}/ricette/ripeti`, {
      terapie: [a, b, cc, d, w, e],
    });
    expect(res.statusCode, res.body).toBe(201);
    const ids = res.json<{ ricette: string[] }>().ricette;
    const contents = [];
    for (const id of ids) {
      const row = await status(id);
      const lines = await t.db
        .select({ therapyId: prescriptionLine.therapyId })
        .from(prescriptionLine)
        .where(eq(prescriptionLine.prescriptionId, id));
      contents.push({
        kind: row.kind,
        exemption: row.exemptionCode,
        therapies: lines.map((l) => l.therapyId).sort(),
      });
      expect(row.status).toBe('to_sign');
    }
    expect(contents).toEqual([
      { kind: 'pharma_ssn', exemption: null, therapies: [a, b].sort() },
      { kind: 'pharma_ssn', exemption: null, therapies: [cc] },
      { kind: 'pharma_ssn', exemption: null, therapies: [d] },
      { kind: 'white', exemption: null, therapies: [w] },
      { kind: 'pharma_ssn', exemption: '048', therapies: [e] },
    ]);
  });

  it('la segreteria non ripete terapie riservate né prepara ricette nuove', async () => {
    const reserved = await post('segreteria', `/api/pazienti/${s.richPatient}/ricette/ripeti`, {
      terapie: [reservedTherapy],
    });
    expect(reserved.statusCode).toBe(403);
    const fresh = await post('segreteria', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Altro farmaco', quantity: 1 }],
    });
    expect(fresh.statusCode).toBe(403);
  });

  it('la segreteria non ripete una terapia al bisogno', async () => {
    await t.db.update(therapy).set({ kind: 'as_needed' }).where(eq(therapy.id, chronicTherapy));
    try {
      const res = await post('segreteria', `/api/pazienti/${s.richPatient}/ricette/ripeti`, {
        terapie: [chronicTherapy],
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await t.db.update(therapy).set({ kind: 'chronic' }).where(eq(therapy.id, chronicTherapy));
    }
  });

  it('il sostituto firma a nome suo', async () => {
    const id = await newDraft();
    expect((await post('sostituto', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'accepted',
    );
    expect((await status(id)).signedBy).toBe(s.users.sostituto.id);
    const last = sim.sar.received.at(-1)!;
    expect(last.doctor.userId).toBe(s.users.sostituto.id);
  });

  it('un collega senza autorizzazione non firma le ricette dell’archivio', async () => {
    const id = await newDraft();
    expect((await post('collega', `/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(403);
  });

  it('se il SAR rifiuta: errore con il motivo; si corregge in bozza e si reinvia', async () => {
    const id = await newDraft();
    sim.next.push('rejected');
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'rejected',
    );
    let row = await status(id);
    expect(row.status).toBe('error');
    expect(row.lastErrorKind).toBe('rejected');
    expect(row.lastErrorMessage).toMatch(/rifiutata/);
    // Non si reinvia così com'è.
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(409);
    // Compare negli invii non riusciti.
    const failed = (await get('titolare', '/api/ricette/non-inviate')).json();
    expect(JSON.stringify(failed)).toContain(id);
    expect((await post('titolare', `/api/ricette/${id}/bozza`)).statusCode).toBe(200);
    row = await status(id);
    expect(row.status).toBe('draft');
    expect(row.lastErrorMessage).toBeNull();
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'accepted',
    );
  });

  it('se il SAR non risponde: errore di rete e ripiego sulla ricetta rossa', async () => {
    const id = await newDraft();
    sim.next.push('unreachable');
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'unreachable',
    );
    expect((await status(id)).lastErrorKind).toBe('unreachable');
    const paper = await post('titolare', `/api/ricette/${id}/ricetta-rossa`);
    expect(paper.statusCode, paper.body).toBe(200);
    expect(paper.json().stampa.lines[0].drugName).toBe('Farmaco di prova 5 mg');
    const row = await status(id);
    expect(row.status).toBe('paper');
    expect(row.paperPrintedBy).toBe(s.users.titolare.id);
    // Stampata su carta, non si invia più.
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).statusCode).toBe(409);
  });

  it('se l’esito è incerto: niente ricetta rossa, si riprova l’invio', async () => {
    const id = await newDraft();
    sim.next.push('timeout');
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'timeout',
    );
    const paper = await post('titolare', `/api/ricette/${id}/ricetta-rossa`);
    expect(paper.statusCode).toBe(409);
    expect(paper.json().errore).toMatch(/incerto/);
    expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
      'accepted',
    );
  });

  it('un errore imprevisto dell’adattatore vale come esito incerto', async () => {
    const id = await newDraft();
    const original = sim.sar.send.bind(sim.sar);
    sim.sar.send = () => Promise.reject(new Error('guasto di prova'));
    try {
      expect((await post('titolare', `/api/ricette/${id}/firma-e-invia`)).json().esito).toBe(
        'timeout',
      );
    } finally {
      sim.sar.send = original;
    }
    expect((await status(id)).lastErrorKind).toBe('timeout');
  });

  it('annullamento di una ricetta inviata: passa dal SAR; se il SAR non risponde resta inviata', async () => {
    const id = await newDraft();
    await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    sim.cancels.push('unreachable');
    const down = await post('titolare', `/api/ricette/${id}/annulla`, { motivo: 'Prova' });
    expect(down.statusCode).toBe(503);
    expect((await status(id)).status).toBe('sent');
    expect((await post('titolare', `/api/ricette/${id}/annulla`, { motivo: '' })).statusCode).toBe(
      400,
    );
    const ok = await post('titolare', `/api/ricette/${id}/annulla`, {
      motivo: 'Errore di posologia',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await status(id);
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('Errore di posologia');
    expect(
      (await post('titolare', `/api/ricette/${id}/annulla`, { motivo: 'Di nuovo' })).statusCode,
    ).toBe(409);
    const ops = await t.db
      .select({ op: externalSubmission.operation, outcome: externalSubmission.outcome })
      .from(externalSubmission)
      .where(eq(externalSubmission.prescriptionId, id));
    // Ogni annullamento chiede prima lo stato all'ente (D70): anche la verifica resta registrata.
    expect(ops).toEqual([
      { op: 'invio', outcome: 'accepted' },
      { op: 'stato', outcome: 'ok' },
      { op: 'annullamento', outcome: 'unreachable' },
      { op: 'stato', outcome: 'ok' },
      { op: 'annullamento', outcome: 'accepted' },
    ]);
  });

  it('annullamento di una bozza: solo locale, con il motivo, senza passare dal SAR', async () => {
    const id = await newDraft();
    const before = sim.sar.received.length;
    expect(
      (await post('titolare', `/api/ricette/${id}/annulla`, { motivo: 'Non serve più' }))
        .statusCode,
    ).toBe(200);
    expect((await status(id)).status).toBe('cancelled');
    expect(sim.sar.received.length).toBe(before);
  });

  it('la ricetta bianca va al Sistema TS', async () => {
    const id = await newDraft('titolare', 'white');
    await post('titolare', `/api/ricette/${id}/firma-e-invia`);
    expect(sim.ts.received.at(-1)!.localId).toBe(id);
    expect((await status(id)).nre).toMatch(/^SIMB/);
  });

  it('le operazioni sulle ricette finiscono nel registro degli accessi', async () => {
    const actions = (
      await t.db
        .select({ a: accessLog.action })
        .from(accessLog)
        .where(and(eq(accessLog.patientId, s.richPatient)))
    ).map((r) => r.a);
    for (const a of [
      'ricetta_bozza',
      'ricetta_ripetizione',
      'ricetta_da_firmare',
      'ricetta_firma_invio',
      'ricetta_annullamento',
      'ricetta_cartacea',
    ]) {
      expect(actions).toContain(a);
    }
  });
});

describe('controlli prima dell’invio', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('un controllo che blocca ferma l’invio e lascia la ricetta com’era', async () => {
    const sar = new SimulatedGateway('sar');
    const s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: () =>
          Promise.resolve({
            issues: [{ ruleId: 'R2', severity: 'block', message: 'Troppe confezioni' }],
            rulesVersion: 'prova-1',
          }),
      },
    );
    const cookie = await login(s, 'titolare');
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/ricette/${s.draftPrescription}/firma-e-invia`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(/R2/);
    expect(sar.received).toHaveLength(0);
    const [row] = await t.db
      .select()
      .from(prescription)
      .where(eq(prescription.id, s.draftPrescription));
    expect(row!.status).toBe('draft');
    await s.app.close();
  });

  it('due firme contemporanee della stessa ricetta: parte un solo invio', async () => {
    // Barriera: le due richieste leggono la ricetta in bozza e aspettano l'una l'altra nei
    // controlli prima dell'invio; poi provano insieme a prenderla in carico.
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const sar = new SimulatedGateway('sar');
    const s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await gate;
          return { issues: [], rulesVersion: null };
        },
      },
    );
    const cookie = await login(s, 'titolare');
    const send = () =>
      s.app.inject({
        method: 'POST',
        url: `/api/ricette/${s.draftPrescription}/firma-e-invia`,
        headers: { cookie },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(sar.received).toHaveLength(1);
    await s.app.close();
  });

  it('controllo e firma insieme (D229): la firma non aspetta il controllo, la ricetta parte una volta e il controllo risponde', async () => {
    // Il controllo che parte con il pannello dell'invio e la firma premuta subito dopo: con una
    // barriera, tutte e due sono nei controlli prima dell'invio nello stesso momento.
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const sar = new SimulatedGateway('sar');
    const s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await gate;
          return { issues: [], rulesVersion: 'prova-insieme' };
        },
      },
    );
    const cookie = await login(s, 'titolare');
    const post = (action: string) =>
      s.app.inject({
        method: 'POST',
        url: `/api/ricette/${s.draftPrescription}/${action}`,
        headers: { cookie },
      });
    const [checked, signed] = await Promise.all([post('controlla'), post('firma-e-invia')]);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toMatchObject({ versioneRegole: 'prova-insieme', bloccanti: 0 });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().esito).toBe('accepted');
    expect(sar.received).toHaveLength(1);
    await s.app.close();
  });

  it('con i controlli superati, la ricetta registra la versione delle regole', async () => {
    const s = await createScenario(
      t.db,
      {},
      { preSendChecks: () => Promise.resolve({ issues: [], rulesVersion: 'prova-2' }) },
    );
    const cookie = await login(s, 'titolare');
    await s.app.inject({
      method: 'POST',
      url: `/api/ricette/${s.draftPrescription}/firma-e-invia`,
      headers: { cookie },
    });
    const [row] = await t.db
      .select()
      .from(prescription)
      .where(eq(prescription.id, s.draftPrescription));
    expect(row!.status).toBe('sent');
    expect(row!.rulesVersion).toBe('prova-2');
    await s.app.close();
  });
});
