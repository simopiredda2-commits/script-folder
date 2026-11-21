import {
  SimulatedSickLeaveGateway,
  type ServiceAuth,
  type SickLeaveGateway,
  type SickLeaveMessage,
} from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, certificateSubmission, patient, sickLeaveCertificate } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { studioDate } from '../src/prescriptions/rules-check';
import { studioDayFrom } from './helpers/dates';
import { pdfText } from './helpers/pdf-text';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * L'INPS delle prove: risponde come il simulatore, ma può tenere fermo un invio finché la prova
 * non apre. Così la risposta arriva dopo che il medico ne ha segnato l'esito a mano.
 */
class GatedInps implements SickLeaveGateway {
  readonly environment;
  calls = 0;
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};
  constructor(private readonly inner: SimulatedSickLeaveGateway) {
    this.environment = inner.environment;
  }
  hold() {
    this.gate = new Promise((r) => (this.open = r));
  }
  release() {
    this.open();
    this.gate = null;
  }
  async send(message: SickLeaveMessage, auth: ServiceAuth) {
    this.calls += 1;
    if (this.gate) await this.gate;
    return this.inner.send(message, auth);
  }
  rectify(...args: Parameters<SickLeaveGateway['rectify']>) {
    return this.inner.rectify(...args);
  }
  cancel(...args: Parameters<SickLeaveGateway['cancel']>) {
    return this.inner.cancel(...args);
  }
}

const norm = (text: string) => text.replace(/\s+/g, ' ');

/**
 * Un certificato di malattia rimasto «in invio» perché il servizio si è fermato mentre aspettava
 * l'INPS (D233): dopo 15 minuti il medico ne segna l'esito chiesto all'INPS. Orologio fermo;
 * lavoratore inventato.
 */
describe('certificato rimasto «in invio» (D233)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const inps = new GatedInps(new SimulatedSickLeaveGateway({ now: () => s.clock.now() }));
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
        sickLeaveGateway: inps,
        sendTimeoutMs: 60_000,
      },
    );
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    // Residenza inventata del lavoratore, che il certificato vuole.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({
          residenceStreet: 'Via dei Prova',
          residenceNumber: '1',
          residencePostalCode: '10121',
          residenceTown: 'Torino',
          residenceProvince: 'TO',
          birthDate: '1980-05-05',
        })
        .where(eq(patient.id, s.richPatient)),
    );
  });
  afterAll(async () => {
    inps.release();
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
    (await t.db.select().from(sickLeaveCertificate).where(eq(sickLeaveCertificate.id, id)))[0]!;
  const draft = async () => {
    const res = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/certificati`, {
      tipo: 'I',
      visita: 'A',
      dataInizio: studioDate(s.clock.now()),
      dataFine: studioDayFrom(s.clock.now(), 2),
      codiceDiagnosi: '487.1',
      noteDiagnosi: 'Sindrome influenzale di prova',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** Come dopo un arresto del servizio: firmato, «in invio», e nessun esito scritto. */
  const stuck = async () => {
    const id = await draft();
    await t.db
      .update(sickLeaveCertificate)
      .set({ status: 'sending', signedBy: s.users.titolare.id, signedAt: s.clock.now() })
      .where(eq(sickLeaveCertificate.id, id));
    return id;
  };
  const settle = (who: Who, id: string, payload: object) =>
    req(who, 'POST', `/api/certificati/${id}/esito-invio`, payload);
  const view = async (id: string) =>
    (await req('titolare', 'GET', `/api/certificati/${id}`)).json<{
      stato: string;
      invioInterrotto: boolean;
      inviatoIl: string | null;
      protocollo: string | null;
    }>();
  const manualRows = (id: string) =>
    t.db
      .select()
      .from(certificateSubmission)
      .where(
        and(
          eq(certificateSubmission.certificateId, id),
          eq(certificateSubmission.operation, 'esito'),
        ),
      );

  it('da meno di 15 minuti: l’esito non si segna; dopo, il certificato si dice interrotto', async () => {
    const id = await stuck();
    s.clock.advance(14 * 60_000);
    expect((await view(id)).invioInterrotto).toBe(false);
    const early = await settle('titolare', id, { esito: 'non_arrivato' });
    expect(early.statusCode).toBe(409);
    expect(early.json().errore).toMatch(/meno di 15 minuti: potrebbe essere ancora in corso/);
    s.clock.advance(2 * 60_000);
    expect(await view(id)).toMatchObject({ stato: 'sending', invioInterrotto: true });
  });

  it('«non è arrivato»: torna da inviare; la segreteria no; nel registro', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    expect((await settle('segreteria', id, { esito: 'non_arrivato' })).statusCode).toBe(403);
    const res = await settle('titolare', id, { esito: 'non_arrivato' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'error', protocollo: null });
    expect(await row(id)).toMatchObject({ status: 'error', lastErrorKind: 'unreachable' });
    expect((await manualRows(id))[0]).toMatchObject({
      environment: 'manuale',
      outcome: 'unreachable',
      userId: s.users.titolare.id,
    });
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, s.richPatient),
          eq(accessLog.action, 'certificato_esito_invio'),
          eq(accessLog.userId, s.users.titolare.id),
        ),
      );
    expect(logged.map((l) => l.outcome)).toContain('consentito');
    // Si rimanda: l'INPS ora risponde e il certificato parte.
    const again = await req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
    expect(again.json(), again.body).toMatchObject({ esito: 'accepted' });
    expect((await row(id)).status).toBe('sent');
  });

  it('«è arrivato» con il protocollo: inviato, ricevuto all’ora dell’invio, con copia e attestato', async () => {
    const id = await stuck();
    const signedAt = (await row(id)).signedAt!;
    s.clock.advance(20 * 60_000);
    const res = await settle('titolare', id, { esito: 'arrivato', protocollo: 'MAN000000001' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'sent', protocollo: 'MAN000000001' });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'sent', protocol: 'MAN000000001', lastErrorKind: null });
    expect(r.receivedAt!.getTime()).toBe(signedAt.getTime());
    expect(r.snapshot).not.toBeNull();
    const copy = await req('titolare', 'GET', `/api/certificati/${id}/copia`);
    expect(copy.statusCode, copy.body.slice(0, 200)).toBe(200);
    expect(norm(await pdfText(copy.rawPayload))).toContain('MAN000000001');
    expect((await manualRows(id))[0]).toMatchObject({ outcome: 'accepted' });
  });

  it('un protocollo con spazi o segni non entra; un certificato non «in invio» non ha esito', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const bad = await settle('titolare', id, { esito: 'arrivato', protocollo: 'MAN 01-X' });
    expect(bad.statusCode).toBe(400);
    expect((await row(id)).status).toBe('sending');
    expect((await settle('titolare', id, { esito: 'non_arrivato' })).statusCode).toBe(200);
    const done = await settle('titolare', id, { esito: 'non_arrivato' });
    expect(done.statusCode).toBe(409);
    expect(done.json().errore).toMatch(/Nessun invio senza risposta da chiudere/);
  });

  it('due esiti insieme: ne passa uno solo', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const [a, b] = await Promise.all([
      settle('titolare', id, { esito: 'arrivato', protocollo: 'MAN000000002' }),
      settle('titolare', id, { esito: 'non_arrivato' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await manualRows(id)).toHaveLength(1);
    // Vale l'esito che è passato: arrivato, inviato; non arrivato, di nuovo da inviare.
    expect((await row(id)).status).toBe(a.statusCode === 200 ? 'sent' : 'error');
  });

  it('la risposta tardiva dell’invio di prima non cambia il certificato segnato a mano', async () => {
    const id = await draft();
    inps.hold();
    const before = inps.calls;
    const sending = req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
    for (let i = 0; inps.calls === before; i++) {
      if (i > 500) throw new Error('L’INPS non è stato chiamato');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await row(id)).status).toBe('sending');
    s.clock.advance(16 * 60_000);
    expect((await settle('titolare', id, { esito: 'non_arrivato' })).statusCode).toBe(200);
    inps.release();
    const late = await sending;
    expect(late.statusCode).toBe(409);
    expect(late.json().errore).toMatch(/l’esito di questo invio è stato segnato a mano/);
    expect(await row(id)).toMatchObject({
      status: 'error',
      lastErrorKind: 'unreachable',
      protocol: null,
    });
    const rows = await t.db
      .select()
      .from(certificateSubmission)
      .where(eq(certificateSubmission.certificateId, id));
    expect(rows.map((x) => `${x.operation}:${x.outcome}`).sort()).toEqual([
      'esito:unreachable',
      'invio:accepted',
    ]);
  });

  it('copia e attestato con i dati partiti alla firma, anche se il lavoratore cambia intanto (D239)', async () => {
    const id = await draft();
    inps.hold();
    const before = inps.calls;
    const sending = req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
    for (let i = 0; inps.calls === before; i++) {
      if (i > 500) throw new Error('L’INPS non è stato chiamato');
      await new Promise((r) => setTimeout(r, 10));
    }
    const [pt] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    // Fotografato alla firma, prima della chiamata all'INPS.
    const atClaim = (await row(id)).snapshot as { worker: { lastName: string } } | null;
    expect(atClaim?.worker.lastName).toBe(pt!.lastName);
    // Intanto il cognome cambia; poi il servizio resta fermo e il medico segna l'esito.
    await t.db
      .update(patient)
      .set({ lastName: 'Cognomecambiato' })
      .where(eq(patient.id, s.richPatient));
    try {
      s.clock.advance(16 * 60_000);
      const res = await settle('titolare', id, { esito: 'arrivato', protocollo: 'MAN000000009' });
      expect(res.statusCode, res.body).toBe(200);
      const copy = await req('titolare', 'GET', `/api/certificati/${id}/copia`);
      expect(copy.statusCode, copy.body.slice(0, 200)).toBe(200);
      const text = norm(await pdfText(copy.rawPayload)).toLowerCase();
      expect(text).toContain(pt!.lastName.toLowerCase());
      expect(text).not.toContain('cognomecambiato');
    } finally {
      await t.db
        .update(patient)
        .set({ lastName: pt!.lastName })
        .where(eq(patient.id, s.richPatient));
      inps.release();
    }
    expect((await sending).statusCode).toBe(409);
  });
});
