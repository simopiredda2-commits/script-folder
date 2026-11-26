import { createHash, randomBytes } from 'node:crypto';
import { SimulatedGateway, SimulatedReminderSender, type DeliveryResult } from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  delegation,
  doctorProfile,
  patient,
  patientChoice,
  prescription,
  prescriptionDocument,
  refDrugTransparency,
  referenceDataset,
  reminderDelivery,
  therapy,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { nreParts } from '../src/reminders/pdf';
import {
  buildPromemoriaData,
  NO_NOTE,
  OBSCURED_TEXT_2024,
  RELEASE_TEXT_2024,
  SSN_RECIPE_TYPE,
  type PromemoriaDataV2,
} from '../src/reminders/promemoria';
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
  let dpcPhrase: string | null = null;
  let deliveryOutcome: DeliveryResult['outcome'] = 'sent';
  /** Un guasto dove si fissano i dati del promemoria, dopo che il SAR ha accettato (D232). */
  let failPromemoria = false;
  const sar = new SimulatedGateway('sar', {
    omitAuthCode: () => omitAuthCode,
    receiptMessages: () => (dpcPhrase ? [{ code: '0196', text: dpcPhrase }] : []),
  });
  const ts = new SimulatedGateway('sistema_ts');
  const sender = new SimulatedReminderSender({ decide: () => deliveryOutcome });
  let pt: typeof patient.$inferSelect;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: ts },
        preSendChecks: noRules,
        reminderSender: sender,
        buildPromemoria: (...args) =>
          failPromemoria
            ? Promise.reject(new Error('guasto di prova'))
            : buildPromemoriaData(...args),
      },
    );
    for (const who of ['titolare', 'segreteria', 'amministratore'] as const)
      c[who] = await login(s, who);
    pt = (await t.db.select().from(patient).where(eq(patient.id, s.richPatient)))[0]!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, who = 'titolare', payload?: object) =>
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
    // Versione 2: le specifiche di stampa del Sistema TS del 28/02/2024 (D217).
    const data = JSON.parse(doc!.content) as PromemoriaDataV2;
    expect(data).toMatchObject({
      versione: 2,
      regione: 'REGIONE PIEMONTE',
      nre: p.nre,
      codiceAutenticazione: p.authCode,
      esenzione: 'NON ESENTE',
      numeroConfezioniPrestazioni: 3,
      tipoRicetta: SSN_RECIPE_TYPE,
      priorita: null,
      validitaGiorni: null,
      dicitura: RELEASE_TEXT_2024,
    });
    expect(data.assistito).toMatchObject({
      codiceFiscale: pt.fiscalCode,
      cognomeNome: `${pt.lastName} ${pt.firstName}`,
      cap: pt.residencePostalCode,
      citta: pt.residenceTown,
      provincia: pt.residenceProvince,
      oscurato: false,
    });
    expect(data.righe).toEqual([
      { prescrizione: ['Farmaco di prova 5 mg'], dettagli: null, quantita: 2, nota: '13' },
      { prescrizione: ['Secondo farmaco di prova'], dettagli: null, quantita: 1, nota: NO_NOTE },
    ]);
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
    const [first, second] = nreParts(p.nre!);
    for (const expected of [
      'SERVIZIO SANITARIO NAZIONALE',
      'RICETTA ELETTRONICA – PROMEMORIA PER L’ASSISTITO',
      'REGIONE PIEMONTE',
      // Campo 2: due codici, tra asterischi; campo 9: il codice fiscale.
      `*${first}*`,
      `*${second}*`,
      `*${pt.fiscalCode}*`,
      `COGNOME E NOME /INIZIALI DELL’ASSISTITO: ${pt.lastName} ${pt.firstName}`,
      'ESENZIONE: P00',
      'PRESCRIZIONE QTA NOTA',
      'Farmaco di prova 5 mg 2 13',
      `Secondo farmaco di prova 1 ${NO_NOTE}`,
      `TIPO RICETTA: ${SSN_RECIPE_TYPE}`,
      `CODICE AUTENTICAZIONE: ${p.authCode!}`,
      'COGNOME E NOME DEL MEDICO: MMG-PROVA-1 - DOTT.SSA ELENA MARCHI',
      RELEASE_TEXT_2024,
    ]) {
      expect(text, expected).toContain(expected);
    }
    // Aprire il PDF non è una consegna (audit D259): resta nel registro degli accessi.
    const delivered = () =>
      t.db.select().from(reminderDelivery).where(eq(reminderDelivery.prescriptionId, id));
    expect(await delivered()).toEqual([]);
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'stampa_promemoria')),
      );
    expect(logged.length).toBeGreaterThan(0);
    // La consegna su carta la segna chi ha dato il foglio, anche la segreteria.
    const paper = await req('POST', `/api/ricette/${id}/promemoria/consegna-carta`, 'segreteria', {
      formato: 'nre',
    });
    expect(paper.statusCode, paper.body).toBe(200);
    expect(await delivered()).toEqual([
      expect.objectContaining({
        channel: 'stampa_nre',
        outcome: 'consegnato',
        userId: s.users.segreteria.id,
      }),
    ]);
    const rows = (await req('GET', `/api/ricette/${id}/promemoria/consegne`)).json().consegne;
    expect(rows).toEqual([expect.objectContaining({ canale: 'stampa_nre', esito: 'consegnato' })]);
    for (const bad of [{}, { formato: 'tutto' }, { formato: 'nre', altro: 1 }])
      expect(
        (await req('POST', `/api/ricette/${id}/promemoria/consegna-carta`, 'titolare', bad))
          .statusCode,
        JSON.stringify(bad),
      ).toBe(400);
  });

  it('consegna su carta solo di ciò che per la ricetta si può dare (audit D259)', async () => {
    // Non inviata: niente da consegnare.
    const draftId = await draft(pharma());
    const early = await req(
      'POST',
      `/api/ricette/${draftId}/promemoria/consegna-carta`,
      'titolare',
      {
        formato: 'completo',
      },
    );
    expect(early.statusCode).toBe(409);
    // Ricetta bianca inviata senza il promemoria del SAC (come dopo un esito segnato a mano): il
    // foglio con l'NRE non c'è mai, e senza il PDF del SAC nemmeno il promemoria.
    const white = await draft({ ...pharma(), kind: 'white' });
    await t.db
      .update(prescription)
      .set({ status: 'sent', nre: 'X01234567890', pinNrbe: '1234', sentAt: new Date() })
      .where(eq(prescription.id, white));
    for (const formato of ['nre', 'completo'] as const) {
      const res = await req('POST', `/api/ricette/${white}/promemoria/consegna-carta`, 'titolare', {
        formato,
      });
      expect(res.statusCode, formato).toBe(409);
    }
    expect(
      await t.db.select().from(reminderDelivery).where(eq(reminderDelivery.prescriptionId, white)),
    ).toEqual([]);
  });

  it('solo NRE: numero, codice fiscale e codice di autenticazione, senza i farmaci', async () => {
    const id = await sent(pharma());
    const p = await row(id);
    const res = await req('GET', `/api/ricette/${id}/promemoria?formato=nre`);
    expect(res.statusCode, res.body).toBe(200);
    const text = norm(await pdfText(res.rawPayload));
    const [first, second] = nreParts(p.nre!);
    expect(text).toContain(`*${first}*`);
    expect(text).toContain(`*${second}*`);
    expect(text).toContain(`*${pt.fiscalCode}*`);
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
    expect(text).toContain(OBSCURED_TEXT_2024);
    expect(text).not.toContain(`${pt.lastName} ${pt.firstName}`);
    if (pt.residenceTown) expect(text).not.toContain(pt.residenceTown);
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

  it('se i dati del promemoria non si fissano, la ricetta partita ha il suo NRE e non resta «in invio» (D232)', async () => {
    failPromemoria = true;
    try {
      const id = await draft(pharma());
      const res = await req('POST', `/api/ricette/${id}/firma-e-invia`, 'titolare', {});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        esito: 'accepted',
        messaggio: expect.stringMatching(/il promemoria non si stampa/),
      });
      const p = await row(id);
      expect(p.status).toBe('sent');
      expect(p.nre).toBeTruthy();
      expect(p.authCode).toBeTruthy();
      expect(await docs(id)).toEqual([]);
      expect((await req('GET', `/api/ricette/${id}/promemoria`)).statusCode).toBe(409);
    } finally {
      failPromemoria = false;
    }
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

  it('ricetta specialistica: codici, validità, tipo di accesso, priorità e quesito (D217)', async () => {
    const id = await sent({
      kind: 'specialist_ssn',
      accessType: 'subsequent',
      priority: 'D',
      diagnosticQuestion: 'Quesito di prova',
      lines: [
        {
          serviceCode: '89.7.1',
          serviceNationalCode: '89.7',
          serviceDescription: 'Visita di prova',
          quantity: 1,
        },
      ],
    });
    const text = norm(
      await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
    );
    // 17A: codice nomenclatore (codice catalogo) – descrizione; 18A: tipologia di accesso.
    expect(text).toContain('89.7 (89.7.1) – Visita di prova ALTRA TIPOLOGIA DI ACCESSO 1 ---');
    expect(text).toContain('PRESCRIZIONE VALIDA 180 GIORNI AI FINI DELLA PRENOTAZIONE');
    expect(text).toContain(
      'PRIORITA’PRESCRIZIONE(U,B,D,P): Entro 30 (visite), entro 60 gg (visite strumentali)',
    );
    expect(text).toContain('QUESITO DIAGNOSTICO: Quesito di prova');
  });

  it('ricetta specialistica di primo accesso: 60 giorni per prenotare, come la regola R1 (D260)', async () => {
    const id = await sent({
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'B',
      diagnosticQuestion: 'Quesito di prova',
      lines: [
        {
          serviceCode: '89.7.1',
          serviceNationalCode: '89.7',
          serviceDescription: 'Visita di prova',
          quantity: 1,
        },
      ],
    });
    const text = norm(
      await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
    );
    expect(text).toContain('89.7 (89.7.1) – Visita di prova PRIMO ACCESSO 1 ---');
    // I giorni della regione dello studio, dalle regole in vigore alla data con le sue aggiunte (D296).
    expect(text).toContain('PRESCRIZIONE VALIDA 60 GIORNI AI FINI DELLA PRENOTAZIONE');
  });

  it('farmaco della lista di trasparenza: gruppo di equivalenza, AIC, non sostituibile, DPC', async () => {
    const [dataset] = await t.db
      .insert(referenceDataset)
      .values({
        kind: 'farmaci_trasparenza',
        series: 'trasparenza-prova-promemoria',
        title: 'Lista di trasparenza di prova',
        mappingVersion: 'prova',
        origin: 'sync',
        sha256: randomBytes(32).toString('hex'),
        bytes: 1,
        validFrom: '2026-01-01',
        validFromBasis: 'scaricamento',
        rows: 1,
        importedBy: 'prova',
      })
      .returning();
    await t.db.insert(refDrugTransparency).values({
      datasetId: dataset!.id,
      aic: '099999019',
      activeIngredient: 'Principio di prova',
      referencePack: "28 UNITA' 5 MG - USO ORALE",
      name: 'FARMACO EQUIVALENTE DI PROVA',
      equivalenceGroup: 'ZZ1',
    });
    dpcPhrase = 'Frase di prova sui farmaci in distribuzione per conto';
    try {
      const id = await sent({
        kind: 'pharma_ssn',
        lines: [
          {
            drugAic: '099999019',
            drugName: 'FARMACO EQUIVALENTE DI PROVA 5 MG',
            quantity: 1,
            notSubstitutable: true,
            // Dalla versione delle regole 2026-11-25.1 la motivazione è il codice (D273).
            notSubstitutableCode: '1',
            notSubstitutableReason: 'motivazione di prova',
          },
        ],
      });
      const [doc] = await docs(id);
      const data = JSON.parse(doc!.content) as PromemoriaDataV2;
      expect(data.righe).toEqual([
        {
          prescrizione: [
            "ZZ1 - PRINCIPIO DI PROVA 28 UNITA' 5 MG - USO ORALE",
            '099999019 - FARMACO EQUIVALENTE DI PROVA 5 MG',
          ],
          dettagli: 'NON SOSTITUIBILE - motivazione 1 - motivazione di prova',
          quantita: 1,
          nota: NO_NOTE,
        },
      ]);
      expect(data.fraseDpc).toBe(dpcPhrase);
      const text = norm(
        await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
      );
      expect(text).toContain("ZZ1 - PRINCIPIO DI PROVA 28 UNITA' 5 MG - USO ORALE");
      expect(text).toContain('099999019 - FARMACO EQUIVALENTE DI PROVA 5 MG');
      expect(text).toContain('NON SOSTITUIBILE - motivazione 1 - motivazione di prova');
      expect(text).toContain(dpcPhrase);
    } finally {
      dpcPhrase = null;
    }
  });

  it('farmaco con l’AIC e senza il nome: sul promemoria l’AIC partito al SAR, mai una riga vuota (D232)', async () => {
    const id = await sent({ kind: 'pharma_ssn', lines: [{ drugAic: '012345678', quantity: 1 }] });
    const [doc] = await docs(id);
    const data = JSON.parse(doc!.content) as PromemoriaDataV2;
    expect(data.righe.map((r) => r.prescrizione)).toEqual([['012345678']]);
    const text = norm(
      await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
    );
    expect(text).toContain('012345678');
  });

  it('terapia suggerita dallo specialista: campo 14 «SUGG», una volta per ricetta', async () => {
    const [th] = await t.db
      .select()
      .from(therapy)
      .where(and(eq(therapy.patientId, pt.id), eq(therapy.drugName, 'Farmaco di prova 5 mg')));
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(therapy).set({ suggestedS: true }).where(eq(therapy.id, th!.id)),
    );
    try {
      const id = await sent({
        kind: 'pharma_ssn',
        lines: [{ therapyId: th!.id, drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
      });
      const [doc] = await docs(id);
      expect((JSON.parse(doc!.content) as PromemoriaDataV2).tipologia).toBe('S');
      const text = norm(
        await pdfText((await req('GET', `/api/ricette/${id}/promemoria`)).rawPayload),
      );
      expect(text).toContain('TIPOLOGIA PRESCRIZIONE(S,H): SUGG');
    } finally {
      await withActor(t.db, s.users.titolare.id, (tx) =>
        tx.update(therapy).set({ suggestedS: false }).where(eq(therapy.id, th!.id)),
      );
    }
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
    const attached = await pdfText(mail.attachments[0]!.content);
    for (const part of nreParts(p.nre!)) expect(attached).toContain(`*${part}*`);
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

  it('anteprima prima della firma (D253): «BOZZA – NON VALIDA» al posto dell’NRE, nessuna consegna', async () => {
    const draftId = await draft(pharma({ exemptionCode: 'P00' }));
    const preview = (id: string, who = 'titolare') =>
      req('GET', `/api/ricette/${id}/promemoria/anteprima`, who);
    const res = await preview(draftId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const text = norm(await pdfText(res.rawPayload));
    for (const expected of [
      'RICETTA ELETTRONICA – PROMEMORIA PER L’ASSISTITO',
      'BOZZA – NON VALIDA',
      `COGNOME E NOME /INIZIALI DELL’ASSISTITO: ${pt.lastName} ${pt.firstName}`,
      'ESENZIONE: P00',
    ])
      expect(text).toContain(expected);
    // Nessun codice a barre dell'NRE: fra asterischi c'è solo il codice fiscale.
    expect(text.match(/\*[A-Z0-9]+\*/g)).toEqual([`*${pt.fiscalCode}*`]);
    // La segreteria la vede con il medico scelto dal paziente; senza una scelta in corso, no.
    expect((await preview(draftId, 'segreteria')).statusCode).toBe(409);
    await t.db.insert(patientChoice).values({
      patientId: s.richPatient,
      doctorUserId: s.users.titolare.id,
      chosenOn: '2026-01-01',
      source: 'manual',
    });
    expect((await preview(draftId, 'segreteria')).statusCode).toBe(200);
    // Non è una consegna, e la ricetta resta com'era.
    expect(
      await t.db
        .select()
        .from(reminderDelivery)
        .where(eq(reminderDelivery.prescriptionId, draftId)),
    ).toEqual([]);
    expect((await row(draftId)).status).toBe('draft');
    // Inviata: niente anteprima, c'è il promemoria vero. Ricetta bianca: lo fa il SAC.
    expect((await preview(await sent(pharma()))).statusCode).toBe(409);
    expect((await preview(await draft({ ...pharma(), kind: 'white' }))).statusCode).toBe(409);
  });

  it('carta: A5 orizzontale per difetto; A4 se lo studio sceglie A4, anche per l’email (D222)', async () => {
    const size = async (bytes: Uint8Array) => {
      const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
      return [Math.round(width * 100) / 100, Math.round(height * 100) / 100];
    };
    const A5_LANDSCAPE = [595.28, 419.53];
    const A4 = [595.28, 841.89];
    const reminder = (id: string, query = '') =>
      req('GET', `/api/ricette/${id}/promemoria${query}`).then((r) => new Uint8Array(r.rawPayload));
    const setPaper = async (carta: string | null) => {
      const res = await req('PUT', '/api/stampa/impostazioni', 'amministratore', {
        postazione: null,
        tipo: 'promemoria',
        stampante: null,
        carta,
        copie: null,
        variante: null,
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    const id = await sent(pharma());
    // La carta che il pannello annuncia è quella su cui il promemoria esce (D232).
    const announced = async () =>
      (await req('GET', `/api/ricette/${id}/promemoria/consegne`)).json<{ carta: string }>().carta;
    expect(await announced()).toBe('A5');
    expect(await size(await reminder(id))).toEqual(A5_LANDSCAPE);
    expect(await size(await reminder(id, '?formato=nre'))).toEqual(A5_LANDSCAPE);
    try {
      await setPaper('A4');
      expect(await announced()).toBe('A4');
      expect(await size(await reminder(id))).toEqual(A4);
      expect(await size(await reminder(id, '?formato=nre'))).toEqual(A4);
      const before = sender.emails.length;
      const mail = await req('POST', `/api/ricette/${id}/promemoria/invio`, 'titolare', {
        canale: 'email',
        destinatario: 'paziente',
      });
      expect(mail.statusCode, mail.body).toBe(200);
      expect(await size(sender.emails[before]!.attachments[0]!.content)).toEqual(A4);
    } finally {
      await setPaper(null);
    }
    expect(await size(await reminder(id))).toEqual(A5_LANDSCAPE);
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
