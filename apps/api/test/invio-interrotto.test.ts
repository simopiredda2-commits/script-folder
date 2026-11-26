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
  patient,
  prescription,
  prescriptionDocument,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { regionalGateway } from './helpers/regional-gateway';

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
  ricette: {
    id: string;
    firmataIl: string;
    firmataDa: string;
    esitoDal: string | null;
    codiceFiscaleInviato?: string | null;
  }[];
}

/**
 * Una ricetta rimasta «in invio» perché il servizio si è fermato mentre aspettava il SAR (D233):
 * dopo 15 minuti il medico ne segna l'esito chiesto all'ente. Orologio fermo; pazienti inventati.
 */
describe('ricetta rimasta «in invio» (D233)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const sar = new GatedGateway(regionalGateway());
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
        gateways: { regional: sar, sistema_ts: new SimulatedGateway('sistema_ts') },
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
  const draft = async (kind: 'pharma_ssn' | 'white' = 'pharma_ssn') => {
    const res = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind,
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** Come dopo un arresto del servizio: firmata, «in invio», e nessun esito scritto. */
  const stuck = async (kind: 'pharma_ssn' | 'white' = 'pharma_ssn') => {
    const id = await draft(kind);
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
  const available = async (id: string) =>
    (await req('titolare', 'GET', `/api/ricette/${id}/promemoria/consegne`)).json<{
      disponibile: unknown;
    }>().disponibile;
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
    // Già nella coda, con l'ora da cui l'esito si segna: chi ricarica la pagina la trova (D239).
    // Oggi la conta solo quando c'è da chiuderla.
    const signedAt = (await row(id)).signedAt!;
    expect((await inQueue(id))?.esitoDal).toBe(
      new Date(signedAt.getTime() + 15 * 60_000).toISOString(),
    );
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

  it('«è arrivata» senza il codice: la ricetta SSN non è valida, non si segna (D240)', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    for (const payload of [
      { esito: 'arrivata', nre: 'MAN000000000002' },
      { esito: 'arrivata', nre: 'MAN000000000002', codiceAutenticazione: null },
    ]) {
      const res = await settle('titolare', id, payload);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().errore).toMatch(
        /Senza il codice di autenticazione la ricetta SSN non è valida.*segna «Non è arrivata»/,
      );
    }
    // Un codice di soli spazi non è un codice.
    const blank = await settle('titolare', id, {
      esito: 'arrivata',
      nre: 'MAN000000000002',
      codiceAutenticazione: '   ',
    });
    expect(blank.statusCode).toBe(400);
    // Niente è cambiato: la ricetta resta «in invio», senza numero, e nel registro degli invii non
    // c'è un esito; è ancora fra gli invii senza risposta.
    expect(await row(id)).toMatchObject({ status: 'sending', nre: null, authCode: null });
    expect(await manualRows(id)).toEqual([]);
    expect(await inQueue(id)).toBeDefined();
    const docs = await t.db
      .select()
      .from(prescriptionDocument)
      .where(eq(prescriptionDocument.prescriptionId, id));
    expect(docs).toEqual([]);
    // Con il codice chiesto all'ente, sì: inviata, con il promemoria.
    const res = await settle('titolare', id, {
      esito: 'arrivata',
      nre: 'MAN000000000002',
      codiceAutenticazione: 'MANAUT0002B',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'sent', messaggio: null });
    expect(await available(id)).toMatchObject({ promemoria: true });
  });

  it('un NRE con segni o di forma sbagliata non entra; una ricetta non «in invio» non ha esito da segnare', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const bad = await settle('titolare', id, { esito: 'arrivata', nre: 'MAN 0001-X' });
    expect(bad.statusCode).toBe(400);
    // La forma dell'NRE secondo le specifiche del Sistema TS (audit D259): 15 caratteri, il sesto
    // da 0 a 7, gli ultimi 9 cifre. Anche con il codice di autenticazione non entra.
    for (const [nre, why] of [
      ['ABC', /L’NRE ha sempre 15 caratteri: qui ce ne sono 3/],
      ['MAN008000000001', /il sesto carattere è una cifra da 0 a 7/],
      ['MAN00000000000A', /gli ultimi 9 sono cifre/],
    ] as const) {
      const res = await settle('titolare', id, {
        esito: 'arrivata',
        nre,
        codiceAutenticazione: '1',
      });
      expect(res.statusCode, nre).toBe(400);
      expect(res.json().errore, nre).toMatch(why);
    }
    expect(await row(id)).toMatchObject({ status: 'sending', nre: null, authCode: null });
    expect(await manualRows(id)).toEqual([]);
    expect((await settle('titolare', id, { esito: 'non_arrivata' })).statusCode).toBe(200);
    const done = await settle('titolare', id, { esito: 'non_arrivata' });
    expect(done.statusCode).toBe(409);
    expect(done.json().errore).toMatch(/Nessun invio senza risposta da chiudere/);
  });

  it('due esiti insieme: ne passa uno solo', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const [a, b] = await Promise.all([
      settle('titolare', id, {
        esito: 'arrivata',
        nre: 'MAN000000000003',
        codiceAutenticazione: 'MANAUT0003',
      }),
      settle('titolare', id, { esito: 'non_arrivata' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await manualRows(id)).toHaveLength(1);
    const r = await row(id);
    // Vale l'esito che è passato: arrivata, inviata; non arrivata, di nuovo da inviare.
    expect(r.status).toBe(a.statusCode === 200 ? 'sent' : 'error');
  });

  it('«è arrivata» con l’NRE scritto in minuscolo e con gli spazi: si registra in maiuscolo e il promemoria si stampa (D239)', async () => {
    const id = await stuck();
    s.clock.advance(16 * 60_000);
    const res = await settle('titolare', id, {
      esito: 'arrivata',
      // Con gli spazi, come l'esempio delle specifiche («123 A0 0 4567890 12»).
      nre: ' man 00 0 0000000 11 ',
      codiceAutenticazione: 'MANAUT0002',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().nre).toBe('MAN000000000011');
    expect((await row(id)).nre).toBe('MAN000000000011');
    for (const url of [
      `/api/ricette/${id}/promemoria`,
      `/api/ricette/${id}/promemoria?formato=nre`,
    ])
      expect((await req('titolare', 'GET', url)).statusCode, url).toBe(200);
    expect(await available(id)).toEqual({
      promemoria: true,
      soloNre: true,
      email: true,
      sms: true,
      motivo: null,
    });
  });

  it('l’esito a mano registra la richiesta partita e il promemoria con il paziente di allora (D239)', async () => {
    const id = await draft();
    sar.hold();
    const before = sar.calls;
    const sending = req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    for (let i = 0; sar.calls === before; i++) {
      if (i > 500) throw new Error('Il SAR non è stato chiamato');
      await new Promise((r) => setTimeout(r, 10));
    }
    // L'invio è fotografato alla firma: messaggio e paziente come partono.
    const atClaim = (await row(id)).sendingSnapshot as {
      message: { patientFiscalCode: string };
      paziente: { lastName: string; fiscalCode: string };
    };
    const [pt] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    expect(atClaim.message.patientFiscalCode).toBe(pt!.fiscalCode);
    expect(atClaim.paziente).toMatchObject({ lastName: pt!.lastName, fiscalCode: pt!.fiscalCode });
    // Intanto cognome e codice fiscale cambiano (un errore corretto, inventato come il primo: la X
    // del luogo di nascita resta); poi il servizio resta fermo e il medico segna l'esito.
    await t.db
      .update(patient)
      .set({ lastName: 'Cognomecambiato', fiscalCode: `CGN${pt!.fiscalCode.slice(3)}` })
      .where(eq(patient.id, s.richPatient));
    // La coda dà il codice fiscale partito con l'invio: con quello la pagina controlla l'NRBE
    // (audit D259).
    expect((await inQueue(id))?.codiceFiscaleInviato).toBe(pt!.fiscalCode);
    s.clock.advance(16 * 60_000);
    const res = await settle('titolare', id, {
      esito: 'arrivata',
      nre: 'MAN000000000009',
      codiceAutenticazione: 'MANAUT0009',
    });
    expect(res.statusCode, res.body).toBe(200);
    const [manual] = await manualRows(id);
    expect((manual!.request as { ricetta: unknown }).ricetta).toEqual(atClaim.message);
    const [doc] = await t.db
      .select()
      .from(prescriptionDocument)
      .where(eq(prescriptionDocument.prescriptionId, id));
    const data = JSON.parse(doc!.content) as {
      assistito: { cognomeNome: string | null; codiceFiscale: string };
    };
    expect(data.assistito).toMatchObject({
      cognomeNome: `${pt!.lastName} ${pt!.firstName}`,
      codiceFiscale: pt!.fiscalCode,
    });
    expect((await row(id)).sendingSnapshot).toBeNull();
    await t.db
      .update(patient)
      .set({ lastName: pt!.lastName, fiscalCode: pt!.fiscalCode })
      .where(eq(patient.id, s.richPatient));
    sar.release();
    expect((await sending).statusCode).toBe(409);
  });

  it('ricetta bianca: «è arrivata» con NRBE e PIN, senza il promemoria del Sistema TS (D239)', async () => {
    const id = await stuck('white');
    s.clock.advance(16 * 60_000);
    // L'NRBE del paziente con il codice fiscale comincia con la lettera di controllo del codice
    // fiscale mandato con la ricetta, poi una cifra e 10 cifre (DM 1/12/2022, audit D259).
    const [pt] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    const letter = pt!.fiscalCode[15]!;
    const other = letter === 'A' ? 'B' : 'A';
    const nrbe = `${letter}00000000001`;
    for (const [nre, why] of [
      ['NRBE00000001', /il primo carattere è una lettera, il secondo una lettera o una cifra/],
      ['NRBE0001', /L’NRBE ha sempre 12 caratteri: qui ce ne sono 8/],
      [`${other}00000000001`, new RegExp(`codice fiscale \\(${letter}\\) seguita da una cifra`)],
    ] as const) {
      const res = await settle('titolare', id, { esito: 'arrivata', nre, pin: '1234' });
      expect(res.statusCode, nre).toBe(400);
      expect(res.json().errore, nre).toMatch(why);
    }
    expect(await manualRows(id)).toEqual([]);
    const missing = await settle('titolare', id, { esito: 'arrivata', nre: nrbe });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errore).toMatch(/servono il numero \(NRBE\) e il PIN/);
    const res = await settle('titolare', id, {
      esito: 'arrivata',
      nre: nrbe,
      pin: '1234',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().messaggio).toMatch(
      /NRBE e PIN si dettano al paziente o gli si mandano per SMS/,
    );
    expect(await row(id)).toMatchObject({ status: 'sent', pinNrbe: '1234', authCode: null });
    expect((await manualRows(id))[0]!.request).toMatchObject({ esito: 'arrivata', pin: '1234' });
    // Il promemoria del Sistema TS non c'è: solo l'SMS con NRBE e PIN.
    expect(await available(id)).toEqual({
      promemoria: false,
      soloNre: false,
      email: false,
      sms: true,
      motivo: expect.stringMatching(/NRBE e PIN si dettano al paziente o gli si mandano per SMS/),
    });
  });

  it('ricetta accettata senza i dati del promemoria: niente PDF né email, l’SMS con il numero sì (D239)', async () => {
    // Come una ricetta accettata dal SAR di cui i dati del promemoria non si sono fissati (D232).
    const id = await stuck();
    await t.db
      .update(prescription)
      .set({
        status: 'sent',
        nre: 'MAN000000000010',
        authCode: 'MANAUT0010',
        sentAt: s.clock.now(),
      })
      .where(eq(prescription.id, id));
    expect(await available(id)).toEqual({
      promemoria: false,
      soloNre: false,
      email: false,
      sms: true,
      motivo: expect.stringMatching(/I dati del promemoria non si sono potuti fissare/),
    });
    expect((await req('titolare', 'GET', `/api/ricette/${id}/promemoria`)).statusCode).not.toBe(
      200,
    );
    const sms = await req('titolare', 'POST', `/api/ricette/${id}/promemoria/invio`, {
      canale: 'sms',
      destinatario: 'paziente',
    });
    expect(sms.statusCode, sms.body).toBe(200);
  });

  it('ricetta bianca senza il PIN: l’SMS non parte, e la pagina lo sa prima (D239)', async () => {
    const id = await stuck('white');
    await t.db
      .update(prescription)
      .set({ status: 'sent', nre: 'NRBE00000010', pinNrbe: null, sentAt: s.clock.now() })
      .where(eq(prescription.id, id));
    expect(await available(id)).toEqual({
      promemoria: false,
      soloNre: false,
      email: false,
      sms: false,
      motivo: expect.stringMatching(/chiedi NRBE e PIN al Sistema TS/),
    });
    const sms = await req('titolare', 'POST', `/api/ricette/${id}/promemoria/invio`, {
      canale: 'sms',
      destinatario: 'paziente',
    });
    expect(sms.statusCode).toBe(409);
    expect(sms.json().errore).toMatch(/Manca il PIN della ricetta bianca/);
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
