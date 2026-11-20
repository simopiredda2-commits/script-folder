import { createHash } from 'node:crypto';
import { SimulatedGateway, SimulatedReminderSender, type DeliveryResult } from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  delegation,
  doctorProfile,
  patient,
  prescription,
  prescriptionDocument,
  reminderDelivery,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { OBSCURED_TEXT, RELEASE_TEXT, type PromemoriaData } from '../src/reminders/promemoria';
import { pdfFontNames } from './helpers/pdf-fonts';
import { pdfText } from './helpers/pdf-text';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });
const norm = (text: string) => text.replace(/\s+/g, ' ');

describe('promemoria della ricetta: stampa e invio (tappa 7)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  let omitAuthCode = false;
  let deliveryOutcome: DeliveryResult['outcome'] = 'sent';
  const sar = new SimulatedGateway('sar', { omitAuthCode: () => omitAuthCode });
  const ts = new SimulatedGateway('sistema_ts');
  const sender = new SimulatedReminderSender({ decide: () => deliveryOutcome });
  let pt: typeof patient.$inferSelect;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      { gateways: { sar, sistema_ts: ts }, preSendChecks: noRules, reminderSender: sender },
    );
    for (const who of ['titolare', 'segreteria'] as const) c[who] = await login(s, who);
    pt = (await t.db.select().from(patient).where(eq(patient.id, s.richPatient)))[0]!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST', url: string, who = 'titolare', payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const draft = async (body: object) => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, 'titolare', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const sent = async (body: object) => {
    const id = await draft(body);
    const res = await req('POST', `/api/ricette/${id}/firma-e-invia`, 'titolare', {});
    expect(res.statusCode, res.body).toBe(200);
    return id;
  };
  const pharma = (extra: object = {}) => ({
    kind: 'pharma_ssn',
    lines: [
      { drugName: 'Farmaco di prova 5 mg', quantity: 2, aifaNote: '13' },
      { drugName: 'Secondo farmaco di prova', quantity: 1 },
    ],
    ...extra,
  });
  const row = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;
  const docs = (id: string) =>
    t.db.select().from(prescriptionDocument).where(eq(prescriptionDocument.prescriptionId, id));

  it('ricetta SSN: codice di autenticazione e dati del promemoria fissati all’invio', async () => {
    const id = await sent(pharma());
    const p = await row(id);
    expect(p.authCode).toMatch(/^SIMAUT\d+$/);
    expect(p.sacDoctorName).toBe('Dott.ssa Elena Marchi');
    const [doc] = await docs(id);
    expect(doc!.kind).toBe('promemoria_dati');
    expect(doc!.sha256).toBe(createHash('sha256').update(doc!.content).digest('hex'));
    const data = JSON.parse(doc!.content) as PromemoriaData;
    expect(data).toMatchObject({
      intestazione: 'SERVIZIO SANITARIO NAZIONALE – REGIONE PIEMONTE',
      nre: p.nre,
      codiceAutenticazione: p.authCode,
      esenzione: 'NON ESENTE',
      numeroConfezioniPrestazioni: 3,
      dicitura: RELEASE_TEXT,
    });
    expect(data.assistito).toMatchObject({
      codiceFiscale: pt.fiscalCode,
      cognomeNome: `${pt.lastName} ${pt.firstName}`,
      oscurato: false,
    });
    expect(data.righe[0]).toMatchObject({ descrizione: 'Farmaco di prova 5 mg', notaAifa: '13' });
    expect(data.medico.codiceRegionale).toBe('MMG-PROVA-1');
    expect(data.medico.codiceFiscale).toMatch(/^[A-Z]{6}\d{2}[A-Z]\d{2}X\d{3}[A-Z]$/);
  });

  it('il PDF stampa i campi del modello, la riga piemontese del medico e il codice', async () => {
    const id = await sent(pharma({ exemptionCode: 'P00' }));
    const p = await row(id);
    const res = await req('GET', `/api/ricette/${id}/promemoria`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const text = norm(await pdfText(res.rawPayload));
    for (const expected of [
      'SERVIZIO SANITARIO NAZIONALE – REGIONE PIEMONTE',
      `NRE ${p.nre}`,
      `CF ${pt.fiscalCode}`,
      `${pt.lastName} ${pt.firstName}`,
      'P00',
      'Farmaco di prova 5 mg',
      'Codice di autenticazione',
      p.authCode!,
      'MMG-PROVA-1 - DOTT.SSA ELENA MARCHI',
      RELEASE_TEXT,
    ]) {
      expect(text, expected).toContain(expected);
    }
    // La stampa è una consegna: registrata, e nel registro degli accessi.
    const [d] = await t.db
      .select()
      .from(reminderDelivery)
      .where(eq(reminderDelivery.prescriptionId, id));
    expect(d).toMatchObject({ channel: 'stampa_promemoria', outcome: 'stampato' });
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'stampa_promemoria')),
      );
    expect(logged.length).toBeGreaterThan(0);
  });

  it('solo NRE: numero, codice fiscale e codice di autenticazione, senza i farmaci', async () => {
    const id = await sent(pharma());
    const p = await row(id);
    const res = await req('GET', `/api/ricette/${id}/promemoria?formato=nre`);
    expect(res.statusCode, res.body).toBe(200);
    const text = norm(await pdfText(res.rawPayload));
    expect(text).toContain(`NRE ${p.nre}`);
    expect(text).toContain(`CF ${pt.fiscalCode}`);
    expect(text).toContain(p.authCode!);
    expect(text).not.toContain('Farmaco di prova');
  });

  it('NRE e codice fiscale in chiaro con l’OCR-A incorporato, non più il Courier (D211)', async () => {
    const id = await sent(pharma());
    for (const query of ['', '?formato=nre']) {
      const res = await req('GET', `/api/ricette/${id}/promemoria${query}`);
      expect(res.statusCode, res.body).toBe(200);
      const fonts = await pdfFontNames(res.rawPayload);
      expect(
        fonts.filter((f) => /OCRA/.test(f)),
        fonts.join(', '),
      ).toHaveLength(1);
      expect(
        fonts.some((f) => /Courier/.test(f)),
        fonts.join(', '),
      ).toBe(false);
    }
  });

  it('oscuramento chiesto dal paziente: nome e indirizzo non compaiono', async () => {
    const id = await sent(pharma({ obscured: true }));
    expect(sar.received.at(-1)!.obscured).toBe(true);
    const text = norm(
      await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
    );
    expect(text).toContain(OBSCURED_TEXT);
    expect(text).not.toContain(`${pt.lastName} ${pt.firstName}`);
    expect(text).toContain(pt.fiscalCode);
  });

  it('ristampa identica ai dati dell’invio, anche se poi cambia l’anagrafica', async () => {
    const id = await sent(pharma());
    const first = (await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload;
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(patient).set({ residenceStreet: 'Via cambiata dopo' }).where(eq(patient.id, pt.id)),
    );
    const second = (await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload;
    expect(second.equals(first)).toBe(true);
    expect(await pdfText(second)).not.toContain('Via cambiata dopo');
  });

  it('senza codice di autenticazione la ricetta non vale e il promemoria non esce', async () => {
    omitAuthCode = true;
    try {
      const id = await draft(pharma());
      const res = await req('POST', `/api/ricette/${id}/firma-e-invia`, 'titolare', {});
      expect(res.json().esito).toBe('rejected');
      const p = await row(id);
      expect(p).toMatchObject({ status: 'error', lastErrorCode: 'SENZA_CODICE_AUTENTICAZIONE' });
      expect(await docs(id)).toEqual([]);
      expect((await req('GET', `/api/ricette/${id}/promemoria`)).statusCode).toBe(409);
    } finally {
      omitAuthCode = false;
    }
  });

  it('ricetta specialistica: tipo di accesso, priorità e quesito sul promemoria', async () => {
    const id = await sent({
      kind: 'specialist_ssn',
      accessType: 'subsequent',
      priority: 'D',
      diagnosticQuestion: 'Quesito di prova',
      lines: [{ serviceCode: '89.7', serviceDescription: 'Visita di prova', quantity: 1 }],
    });
    const text = norm(
      await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
    );
    expect(text).toContain('Visita di prova (89.7)');
    expect(text).toContain('Altra tipologia di accesso');
    expect(text).toContain('Quesito di prova');
  });

  it('ricetta bianca: si consegna solo il PDF del SAC, byte per byte; niente «solo NRE»', async () => {
    const id = await sent({
      kind: 'white',
      lines: [
        { drugName: 'Farmaco bianco di prova', quantity: 1, repeatCount: 3, validityMonths: 6 },
      ],
    });
    expect(ts.received.at(-1)!.lines[0]).toMatchObject({ repeatCount: 3, validityMonths: 6 });
    const p = await row(id);
    expect(p.pinNrbe).toMatch(/^S\d{4}$/);
    const [doc] = await docs(id);
    expect(doc).toMatchObject({ kind: 'promemoria_sac', mediaType: 'application/pdf' });
    const res = await req('GET', `/api/ricette/${id}/promemoria`);
    expect(res.statusCode).toBe(200);
    expect(createHash('sha256').update(res.rawPayload).digest('hex')).toBe(doc!.sha256);
    expect(await pdfText(res.rawPayload)).toContain('SIMULATORE');
    const nre = await req('GET', `/api/ricette/${id}/promemoria?formato=nre`);
    expect(nre.statusCode).toBe(409);
    expect(nre.json().errore).toMatch(/solo il promemoria prodotto dal SAC/);
  });

  it('la ripetibilità si indica solo sulla ricetta bianca', async () => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, 'titolare', {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova', quantity: 1, repeatCount: 2 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('email al paziente con il promemoria allegato; SMS solo con il numero', async () => {
    const id = await sent(pharma());
    const p = await row(id);
    const before = sender.emails.length;
    const res = await req('POST', `/api/ricette/${id}/promemoria/invio`, 'titolare', {
      canale: 'email',
      destinatario: 'paziente',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ esito: 'consegnato', recapito: pt.email });
    const mail = sender.emails[before]!;
    expect(mail.to).toBe(pt.email);
    expect(mail.attachments[0]!.contentType).toBe('application/pdf');
    expect(await pdfText(mail.attachments[0]!.content)).toContain(p.nre!);
    // Nel testo della email nessun dato clinico: è tutto nell'allegato.
    expect(mail.text).not.toContain('Farmaco');

    const sms = await req('POST', `/api/ricette/${id}/promemoria/invio`, 'titolare', {
      canale: 'sms',
      destinatario: 'paziente',
    });
    expect(sms.statusCode, sms.body).toBe(200);
    const text = sender.sms.at(-1)!.text;
    expect(text).toContain(`NRE ${p.nre}`);
    expect(text).not.toContain('Farmaco');

    const rows = (await req('GET', `/api/ricette/${id}/promemoria/consegne`)).json().consegne;
    expect(rows.map((r: { canale: string }) => r.canale)).toEqual(['sms', 'email']);
    expect(rows[0]).toMatchObject({ destinatario: 'paziente', esito: 'consegnato' });
  });

  it('a un delegato solo con una delega valida oggi (R16)', async () => {
    const id = await sent(pharma());
    const today = new Date().toISOString().slice(0, 10);
    const [valid, revoked] = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(delegation)
        .values([
          {
            patientId: pt.id,
            delegateName: 'Delegato di prova',
            delegateEmail: 'delegato@example.invalid',
            scope: 'ricette',
            validFrom: '2026-01-01',
          },
          {
            patientId: pt.id,
            delegateName: 'Delega revocata di prova',
            delegateEmail: 'revocato@example.invalid',
            scope: 'ricette',
            validFrom: '2026-01-01',
            revokedOn: today,
          },
        ])
        .returning(),
    );
    const to = (delega?: string) =>
      req('POST', `/api/ricette/${id}/promemoria/invio`, 'titolare', {
        canale: 'email',
        destinatario: 'delegato',
        ...(delega ? { delega } : {}),
      });
    expect((await to(valid!.id)).json()).toMatchObject({ recapito: 'delegato@example.invalid' });
    expect((await to(revoked!.id)).statusCode).toBe(409);
    expect((await to()).statusCode).toBe(400);
    // Una delega di un altro paziente non vale per questo.
    const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const [foreign] = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(delegation)
        .values({
          patientId: other,
          delegateName: 'Delegato di un altro',
          delegateEmail: 'altro@example.invalid',
          scope: 'ricette',
          validFrom: '2026-01-01',
        })
        .returning(),
    );
    expect((await to(foreign!.id)).statusCode).toBe(409);
  });

  it('se il servizio di invio non risponde: errore detto e consegna registrata come fallita', async () => {
    const id = await sent(pharma());
    deliveryOutcome = 'unreachable';
    try {
      const res = await req('POST', `/api/ricette/${id}/promemoria/invio`, 'titolare', {
        canale: 'sms',
        destinatario: 'paziente',
      });
      expect(res.statusCode).toBe(502);
    } finally {
      deliveryOutcome = 'sent';
    }
    const [d] = await t.db
      .select()
      .from(reminderDelivery)
      .where(eq(reminderDelivery.prescriptionId, id));
    expect(d).toMatchObject({ channel: 'sms', outcome: 'non_raggiungibile' });
  });

  it('la segreteria stampa il promemoria; una ricetta non inviata non ne ha', async () => {
    const id = await sent(pharma());
    expect((await req('GET', `/api/ricette/${id}/promemoria`, 'segreteria')).statusCode).toBe(200);
    const draftId = await draft(pharma());
    expect((await req('GET', `/api/ricette/${draftId}/promemoria`)).statusCode).toBe(409);
  });

  it('documenti e consegne non si modificano e non si cancellano', async () => {
    await expect(t.db.execute(sql`update prescription_document set kind = kind`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from reminder_delivery`)).rejects.toThrow();
  });
});

describe('prima dell’invio: il promemoria si deve poter fare', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const sar = new SimulatedGateway('sar');

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      { regionName: null },
      { gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') }, preSendChecks: noRules },
    );
    cookie = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const send = async () => {
    const d = await s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/ricette`,
      headers: { cookie },
      payload: { kind: 'pharma_ssn', lines: [{ drugName: 'Farmaco di prova', quantity: 1 }] },
    });
    return s.app.inject({
      method: 'POST',
      url: `/api/ricette/${d.json().id}/firma-e-invia`,
      headers: { cookie },
      payload: {},
    });
  };

  it('senza regione dello studio: fermo prima, nessun invio al SAR', async () => {
    const res = await send();
    expect(res.statusCode).toBe(409);
    expect(res.json().errore).toMatch(/Manca la regione dello studio/);
    expect(sar.received).toHaveLength(0);
  });

  it('senza codice fiscale del medico: fermo prima, nessun invio', async () => {
    await t.db.execute(sql`update studio set region_name = 'PIEMONTE'`);
    await t.db
      .update(doctorProfile)
      .set({ fiscalCode: null })
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    const res = await send();
    expect(res.statusCode).toBe(409);
    expect(res.json().errore).toMatch(/codice fiscale del medico/);
    expect(sar.received).toHaveLength(0);
  });
});

describe('tempo massimo di attesa dell’invio (D94)', () => {
  let t: TestDatabase;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        gateways: {
          sar: new SimulatedGateway('sar', { delayMs: 300 }),
          sistema_ts: new SimulatedGateway('sistema_ts'),
        },
        preSendChecks: noRules,
        sendTimeoutMs: 50,
      },
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('oltre il tempo la risposta vale come esito incerto, senza promemoria', async () => {
    const cookie = await login(s, 'titolare');
    const d = await s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/ricette`,
      headers: { cookie },
      payload: { kind: 'pharma_ssn', lines: [{ drugName: 'Farmaco di prova', quantity: 1 }] },
    });
    const id = d.json().id as string;
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/ricette/${id}/firma-e-invia`,
      headers: { cookie },
      payload: {},
    });
    expect(res.json().esito).toBe('timeout');
    const [p] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p).toMatchObject({ status: 'error', lastErrorKind: 'timeout' });
    expect(p!.lastErrorMessage).toMatch(/0\.05 secondi/);
  });
});
