import {
  SimulatedGateway,
  type PrescriptionGateway,
  type PrescriptionMessage,
  type ServiceAuth,
} from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  appUser,
  externalSubmission,
  prescription,
  prescriptionDocument,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/**
 * Il SAR delle prove: risponde come il simulatore, ma può tenere fermo un invio finché la prova
 * non apre. Così la risposta arriva dopo che il medico ne ha segnato l'esito a mano.
 */
class GatedGateway implements PrescriptionGateway {
  readonly system;
  readonly environment;
  calls = 0;
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};
  constructor(private readonly inner: SimulatedGateway) {
    this.system = inner.system;
    this.environment = inner.environment;
  }
  hold() {
    this.gate = new Promise((r) => (this.open = r));
  }
  release() {
    this.open();
    this.gate = null;
  }
  async send(message: PrescriptionMessage, auth: ServiceAuth) {
    this.calls += 1;
    if (this.gate) await this.gate;
    return this.inner.send(message, auth);
  }
  cancel(...args: Parameters<PrescriptionGateway['cancel']>) {
    return this.inner.cancel(...args);
  }
  status(...args: Parameters<PrescriptionGateway['status']>) {
    return this.inner.status(...args);
  }
}

interface QueueGroup {
  paziente: { id: string };
  ricette: { id: string; firmataIl: string; firmataDa: string }[];
}

/**
 * Una ricetta rimasta «in invio» perché il servizio si è fermato mentre aspettava il SAR (D233):
 * dopo 15 minuti il medico ne segna l'esito chiesto all'ente. Orologio fermo; pazienti inventati.
 */
describe('ricetta rimasta «in invio» (D233)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const sar = new GatedGateway(new SimulatedGateway('sar'));
  const cookies = { titolare: '', segreteria: '' };
  type Who = keyof typeof cookies;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Senza il blocco per inattività: la prova fa passare l'orologio di più di 15 minuti. Un minuto
    // di attesa, in tempo vero: la risposta tenuta ferma dalla prova non scade prima.
    s = await createScenario(
      t.db,
      { idleLockMinutes: null },
      {
        clockAt: new Date('2026-11-20T10:00:00Z'),
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: noRules,
        sendTimeoutMs: 60_000,
      },
    );
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
  });
  afterAll(async () => {
    sar.release();
    await s?.app.close();
    await t?.drop();
  });

  const req = (who: Who, method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload !== undefined ? { payload } : {}),
    });
  const row = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;
  const draft = async () => {
    const res = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** Come dopo un arresto del servizio: firmata, «in invio», e nessun esito scritto. */
  const stuck = async () => {
    const id = await draft();
    await t.db
      .update(prescription)
      .set({ status: 'sending', signedBy: s.users.titolare.id, signedAt: s.clock.now() })
      .where(eq(prescription.id, id));
    return id;
  };
  const settle = (who: Who, id: string, payload: object) =>
    req(who, 'POST', `/api/ricette/${id}/esito-invio`, payload);
  const queue = async () =>
    (await req('titolare', 'GET', '/api/ricette/senza-risposta')).json<{
      pazienti: QueueGroup[];
    }>().pazienti;
  const inQueue = async (id: string) =>
    (await queue()).flatMap((g) => g.ricette).find((r) => r.id === id);
  const today = async () =>
    (await req('titolare', 'GET', '/api/oggi')).json<{ code: { senzaRisposta: number | null } }>()
      .code.senzaRisposta;
  const manualRows = (id: string) =>
    t.db
      .select()
      .from(externalSubmission)
      .where(
        and(eq(externalSubmission.prescriptionId, id), eq(externalSubmission.operation, 'esito')),
      );

  it('da meno di 15 minuti: l’esito non si segna, l’invio potrebbe essere ancora in corso', async () => {
    const id = await stuck();
    s.clock.advance(14 * 60_000);
    const res = await settle('titolare', id, { esito: 'non_arrivata' });
    expect(res.statusCode).toBe(409);
    expect(res.json().errore).toMatch(/meno di 15 minuti: potrebbe essere ancora in corso/);
    expect(await inQueue(id)).toBeUndefined();
    expect(await today()).toBe(0);
    expect((await row(id)).status).toBe('sending');
    s.clock.advance(2 * 60_000);
    // Ora sì: compare fra gli invii senza risposta e in Oggi; si chiude nella prova seguente.
    const [signer] = await t.db
      .select({ name: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.id, s.users.titolare.id));
    expect(await inQueue(id)).toMatchObject({ firmataDa: signer!.name });
    expect(await today()).toBe(1);
    expect((await settle('titolare', id, { esito: 'non_arrivata' })).statusCode).toBe(200);
  });

  it('«non è arrivata»: la ricetta torna da inviare, come quando il SAR non risponde; nel registro', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    // La segreteria prepara, non chiude gli invii: è del medico (regola 5).
    expect((await settle('segreteria', id, { esito: 'non_arrivata' })).statusCode).toBe(403);
    const res = await settle('titolare', id, { esito: 'non_arrivata' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'error', nre: null });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'error', lastErrorKind: 'unreachable', nre: null });
    const [manual] = await manualRows(id);
    expect(manual).toMatchObject({
      environment: 'manuale',
      outcome: 'unreachable',
      userId: s.users.titolare.id,
    });
    expect(manual!.request).toMatchObject({ esito: 'non_arrivata' });
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, s.richPatient),
          eq(accessLog.action, 'ricetta_esito_invio'),
          eq(accessLog.userId, s.users.titolare.id),
        ),
      );
    expect(logged.map((l) => l.outcome)).toContain('consentito');
    expect(await inQueue(id)).toBeUndefined();
    // Si rimanda: il SAR ora risponde e la ricetta parte.
    const again = await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(again.json()).toMatchObject({ esito: 'accepted' });
    expect((await row(id)).status).toBe('sent');
  });

  it('«è arrivata» con NRE e codice di autenticazione: inviata il giorno dell’invio, con il promemoria', async () => {
    const id = await stuck();
    const signedAt = (await row(id)).signedAt!;
    s.clock.advance(20 * 60_000);
    const res = await settle('titolare', id, {
      esito: 'arrivata',
      nre: 'MAN000000000001',
      codiceAutenticazione: 'MANAUT0001',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'sent', nre: 'MAN000000000001', messaggio: null });
    const r = await row(id);
    expect(r).toMatchObject({
      status: 'sent',
      nre: 'MAN000000000001',
      authCode: 'MANAUT0001',
      lastErrorKind: null,
    });
    expect(r.sentAt!.getTime()).toBe(signedAt.getTime());
    const docs = await t.db
      .select()
      .from(prescriptionDocument)
      .where(eq(prescriptionDocument.prescriptionId, id));
    expect(docs.map((d) => d.kind)).toEqual(['promemoria_dati']);
    const pdf = await req('titolare', 'GET', `/api/ricette/${id}/promemoria`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect((await manualRows(id))[0]).toMatchObject({ outcome: 'accepted' });
  });

  it('«è arrivata» senza il codice: inviata, senza promemoria, e lo si dice', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const res = await settle('titolare', id, { esito: 'arrivata', nre: 'MAN000000000002' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().messaggio).toMatch(
      /senza il codice di autenticazione il promemoria non si stampa/,
    );
    expect((await row(id)).status).toBe('sent');
    const docs = await t.db
      .select()
      .from(prescriptionDocument)
      .where(eq(prescriptionDocument.prescriptionId, id));
    expect(docs).toEqual([]);
    expect((await req('titolare', 'GET', `/api/ricette/${id}/promemoria`)).statusCode).not.toBe(
      200,
    );
  });

  it('un NRE con spazi o segni non entra; una ricetta non «in invio» non ha esito da segnare', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const bad = await settle('titolare', id, { esito: 'arrivata', nre: 'MAN 0001-X' });
    expect(bad.statusCode).toBe(400);
    expect((await row(id)).status).toBe('sending');
    expect((await settle('titolare', id, { esito: 'non_arrivata' })).statusCode).toBe(200);
    const done = await settle('titolare', id, { esito: 'non_arrivata' });
    expect(done.statusCode).toBe(409);
    expect(done.json().errore).toMatch(/Nessun invio senza risposta da chiudere/);
  });

  it('due esiti insieme: ne passa uno solo', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const [a, b] = await Promise.all([
      settle('titolare', id, { esito: 'arrivata', nre: 'MAN000000000003' }),
      settle('titolare', id, { esito: 'non_arrivata' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await manualRows(id)).toHaveLength(1);
    const r = await row(id);
    // Vale l'esito che è passato: arrivata, inviata; non arrivata, di nuovo da inviare.
    expect(r.status).toBe(a.statusCode === 200 ? 'sent' : 'error');
  });

  it('la risposta tardiva dell’invio di prima non cambia la ricetta segnata a mano', async () => {
    const id = await draft();
    sar.hold();
    const before = sar.calls;
    const sending = req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    for (let i = 0; sar.calls === before; i++) {
      if (i > 500) throw new Error('Il SAR non è stato chiamato');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await row(id)).status).toBe('sending');
    // Il servizio resta fermo: dopo 15 minuti il medico segna che la ricetta non è arrivata.
    s.clock.advance(16 * 60_000);
    expect((await settle('titolare', id, { esito: 'non_arrivata' })).statusCode).toBe(200);
    sar.release();
    const late = await sending;
    expect(late.statusCode).toBe(409);
    expect(late.json().errore).toMatch(/l’esito di questo invio è stato segnato a mano/);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'error', lastErrorKind: 'unreachable', nre: null });
    // La risposta arrivata tardi resta nel registro degli invii, accanto all'esito segnato a mano.
    const rows = await t.db
      .select()
      .from(externalSubmission)
      .where(eq(externalSubmission.prescriptionId, id));
    expect(rows.map((x) => `${x.operation}:${x.outcome}`).sort()).toEqual([
      'esito:unreachable',
      'invio:accepted',
    ]);
  });
});
