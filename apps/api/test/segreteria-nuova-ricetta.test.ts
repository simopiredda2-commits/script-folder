import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, prescription, prescriptionLine, therapy } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * La segreteria nella «Nuova ricetta» (audit con Cowork, D259). Per i requisiti («Ruoli») la
 * segreteria prepara solo le ripetizioni delle terapie croniche. «Ripeti le terapie scelte» lo
 * faceva già; dalla «Nuova ricetta» il servizio rispondeva sempre «Azione riservata al medico»,
 * anche con una terapia cronica. Ora la bozza passa se ogni riga è una terapia cronica in corso e
 * non riservata del paziente, con farmaco e posologia presi dalla terapia.
 */
describe('la segreteria prepara dalla «Nuova ricetta» (D259)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<string, string> = {};
  let chronic: { id: string; drugName: string };
  let reserved: string;
  let asNeeded: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    for (const who of ['titolare', 'segreteria'] as const) cookies[who] = await login(s, who);
    const ts = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    const c = ts.find((x) => !x.reserved && x.kind === 'chronic')!;
    chronic = { id: c.id, drugName: c.drugName };
    reserved = ts.find((x) => x.reserved)!.id;
    const [n] = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(therapy)
        .values({
          patientId: s.richPatient,
          drugName: 'Farmaco al bisogno di prova',
          kind: 'as_needed',
          startOn: '2026-01-01',
          createdBy: s.users.titolare.id,
        })
        .returning({ id: therapy.id }),
    );
    asNeeded = n!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (who: string, url: string, payload: object) =>
    s.app.inject({ method: 'POST', url, headers: { cookie: cookies[who]! }, payload });
  const draft = (who: string, body: object) =>
    post(who, `/api/pazienti/${s.richPatient}/ricette`, { kind: 'pharma_ssn', ...body });

  it('con una terapia cronica la bozza c’è; farmaco e posologia vengono dalla terapia', async () => {
    const res = await draft('segreteria', {
      lines: [
        // Il browser manda un altro farmaco: conta la terapia, non quello che arriva.
        { therapyId: chronic.id, quantity: 2, drugName: 'ALTRO FARMACO', drugAic: '000000000' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    const [rx] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(rx).toMatchObject({ status: 'draft', preparedBy: s.users.segreteria.id });
    const lines = await t.db
      .select()
      .from(prescriptionLine)
      .where(eq(prescriptionLine.prescriptionId, id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      therapyId: chronic.id,
      drugName: chronic.drugName,
      drugAic: null,
      quantity: 2,
    });
    // Poi la manda alla firma del medico, come la ripetizione.
    const sent = await post('segreteria', `/api/ricette/${id}/da-firmare`, {});
    expect(sent.statusCode, sent.body).toBe(200);
    // La convalida resta sempre del medico (regola 5, Simone il 24/11/2026): la segreteria non
    // firma né invia la ricetta che ha preparato.
    const signed = await post('segreteria', `/api/ricette/${id}/firma-e-invia`, {});
    expect(signed.statusCode).toBe(403);
    const [after] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(after).toMatchObject({ status: 'to_sign', signedBy: null });
    // Nel registro degli accessi è una ripetizione, consentita.
    const log = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, s.users.segreteria.id),
          eq(accessLog.action, 'ricetta_ripetizione'),
          eq(accessLog.outcome, 'consentito'),
        ),
      );
    expect(log.length).toBeGreaterThan(0);
  });

  it('un farmaco della ricerca, senza terapia: rifiutato, con il perché', async () => {
    const res = await draft('segreteria', {
      lines: [{ quantity: 1, drugName: 'Farmaco libero', drugAic: '012345678' }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ errore: string }>().errore).toMatch(/solo le ripetizioni delle terapie/);
  });

  it('una terapia non cronica o riservata: rifiutata', async () => {
    for (const therapyId of [asNeeded, reserved]) {
      const res = await draft('segreteria', {
        lines: [{ therapyId, quantity: 1, drugName: 'come nel browser' }],
      });
      expect(res.statusCode, therapyId).toBe(403);
    }
    // Anche mescolata a una cronica.
    const mixed = await draft('segreteria', {
      lines: [
        { therapyId: chronic.id, quantity: 1, drugName: chronic.drugName },
        { therapyId: asNeeded, quantity: 1, drugName: 'come nel browser' },
      ],
    });
    expect(mixed.statusCode).toBe(403);
  });

  it('la ricetta specialistica resta del medico', async () => {
    const res = await draft('segreteria', {
      kind: 'specialist_ssn',
      lines: [{ therapyId: chronic.id, quantity: 1, drugName: chronic.drugName }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ errore: string }>().errore).toBe('Azione riservata al medico');
  });

  it('il tipo di ricetta segue la terapia: una terapia SSN non va in bianca', async () => {
    const res = await draft('segreteria', {
      kind: 'white',
      lines: [{ therapyId: chronic.id, quantity: 1, drugName: chronic.drugName }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errore: string }>().errore).toMatch(/va in ricetta SSN/);
  });

  it('il medico prepara come prima, anche un farmaco della ricerca', async () => {
    const res = await draft('titolare', {
      lines: [{ quantity: 1, drugName: 'Farmaco libero', activeIngredient: 'principio di prova' }],
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
