import {
  SimulatedReminderSender,
  SimulatedSickLeaveGateway,
  type SimulatedSickLeaveOutcome,
} from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  certificateDelivery,
  certificateSubmission,
  patient,
  serviceCredential,
  serviceSession,
  sickLeaveCertificate,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { RELEASE_FOOTER } from '../src/certificates/pdf';
import { studioDate } from '../src/prescriptions/rules-check';
import { pdfText } from './helpers/pdf-text';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

const DAY = 86_400_000;
const norm = (text: string) => text.replace(/\s+/g, ' ');

interface CertView {
  id: string;
  stato: string;
  tipo: string;
  dataInizio: string;
  dataFine: string;
  protocollo: string | null;
  rettificaDi: string | null;
  annullabile: boolean;
  rettificabile: boolean;
  errore: { tipo: string; codice: string | null; messaggio: string } | null;
  residenza: { via: string; civico: string; cap: string; comune: string; provincia: string };
}

describe('certificati di malattia INPS (tappa 8)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  let outcome: SimulatedSickLeaveOutcome = 'accepted';
  const inps = new SimulatedSickLeaveGateway({ decide: () => outcome, now: () => s.clock.now() });
  const sender = new SimulatedReminderSender();
  const today = () => studioDate(s.clock.now());
  const plus = (n: number) => studioDayFrom(s.clock.now(), n);

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { sickLeaveGateway: inps, reminderSender: sender });
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const)
      c[who] = await login(s, who);
    // Recapiti e residenza inventati del lavoratore, per le consegne e la copia.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({
          email: 'lavoratore@esempio.invalid',
          phone: '+39 000 0000001',
          employerEmail: 'datore@esempio.invalid',
          residenceStreet: 'Via dei Prova',
          residenceNumber: '',
          residencePostalCode: '10121',
          residenceTown: 'Torino',
          residenceProvince: 'to',
          birthDate: '1980-05-05',
        })
        .where(eq(patient.id, s.richPatient)),
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, who = 'titolare', payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const create = async (body: object = {}, who = 'titolare') => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/certificati`, who, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<CertView>();
  };
  const good = () => ({
    tipo: 'I',
    visita: 'A',
    dataInizio: today(),
    dataFine: plus(2),
    codiceDiagnosi: '487.1',
    noteDiagnosi: 'Sindrome influenzale di prova',
  });
  const send = (id: string, who = 'titolare') =>
    req('POST', `/api/certificati/${id}/invia`, who, {});
  const sent = async (body: object = good()) => {
    const draft = await create(body);
    const res = await send(draft.id);
    expect(res.json(), res.body).toMatchObject({ esito: 'accepted' });
    return (await req('GET', `/api/certificati/${draft.id}`)).json<CertView>();
  };
  const pdf = async (id: string, which: 'copia' | 'attestato') => {
    const res = await req('GET', `/api/certificati/${id}/${which}`);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    return norm(await pdfText(res.rawPayload));
  };

  it('solo il medico: la segreteria non vede e non prepara certificati, e resta nel registro', async () => {
    expect(
      (await req('GET', `/api/pazienti/${s.richPatient}/certificati`, 'segreteria')).statusCode,
    ).toBe(403);
    expect(
      (await req('POST', `/api/pazienti/${s.richPatient}/certificati`, 'segreteria', {}))
        .statusCode,
    ).toBe(403);
    const [last] = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'certificato_bozza')),
      );
    expect(last!.outcome).toBe('negato');
  });

  it('la bozza parte dalla residenza in anagrafica, con la provincia in maiuscolo', async () => {
    const d = await create();
    expect(d).toMatchObject({
      stato: 'draft',
      tipo: 'I',
      dataInizio: today(),
      dataFine: today(),
      residenza: {
        via: 'Via dei Prova',
        civico: '',
        cap: '10121',
        comune: 'Torino',
        provincia: 'TO',
      },
    });
  });

  it('i controlli dell’INPS prima dell’invio, con i suoi codici; nessun invio se ce n’è uno', async () => {
    const d = await create({
      ...good(),
      dataRilascio: plus(-3),
      dataFine: plus(120),
      codiceDiagnosi: 'XYZ',
      residenza: { via: 'V', cap: '101', comune: 'Torino', provincia: 'TO' },
    });
    const before = inps.received.length;
    const res = await send(d.id);
    expect(res.statusCode).toBe(422);
    const codes = res
      .json<{ dettagli: { problemi: { code: string }[] } }>()
      .dettagli.problemi.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['26', '25', '43', '421', '437']));
    expect(inps.received.length).toBe(before);
    const check = await req('POST', `/api/certificati/${d.id}/controlla`);
    expect(check.json<{ problemi: unknown[] }>().problemi.length).toBe(codes.length);
  });

  it('invio: protocollo e data di ricezione; senza credenziali nel messaggio; civico «SNC»', async () => {
    const cert = await sent();
    expect(cert).toMatchObject({ stato: 'sent', protocollo: expect.stringMatching(/^SIM\d{9}$/) });
    const msg = inps.received.at(-1)!;
    expect(msg.residence).toMatchObject({ number: 'SNC', province: 'TO' });
    expect(msg.sickness).toMatchObject({ type: 'I', visit: 'A', diagnosisCode: '487.1' });
    expect(inps.receivedAuth.at(-1)).toEqual({
      operation: 'invio',
      username: `sistema_ts-${s.users.titolare.username}`,
    });
    const [sub] = await t.db
      .select()
      .from(certificateSubmission)
      .where(eq(certificateSubmission.certificateId, cert.id));
    expect(sub).toMatchObject({
      operation: 'invio',
      outcome: 'accepted',
      environment: 'simulator',
    });
    expect(JSON.stringify(sub!.request)).not.toMatch(/parola-di-prova|password|"pin"/);
  });

  it('per i certificati basta la credenziale del Sistema TS, senza codice di sessione (D102)', async () => {
    await t.db
      .delete(serviceSession)
      .where(
        and(
          eq(serviceSession.userId, s.users.titolare.id),
          eq(serviceSession.service, 'sistema_ts'),
        ),
      );
    await sent();
  });

  it('senza credenziali del Sistema TS l’invio si ferma prima, e il certificato resta in bozza', async () => {
    await t.db
      .delete(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.collega.id),
          eq(serviceCredential.service, 'sistema_ts'),
        ),
      );
    c.collega = await login(s, 'collega');
    // Il collega ha un suo archivio: un suo paziente, adulto, con la residenza completa.
    const pid = s.patients.collega[0]!;
    await withActor(t.db, s.users.collega.id, (tx) =>
      tx.update(patient).set({ birthDate: '1980-01-01' }).where(eq(patient.id, pid)),
    );
    const d = await req('POST', `/api/pazienti/${pid}/certificati`, 'collega', {
      ...good(),
      residenza: {
        via: 'Via di Prova',
        civico: '3',
        cap: '10100',
        comune: 'Torino',
        provincia: 'TO',
      },
    });
    expect(d.statusCode, d.body).toBe(201);
    const before = inps.received.length;
    const res = await send(d.json<CertView>().id, 'collega');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      dettagli: { codice: 'CREDENZIALI_MANCANTI', servizio: 'sistema-ts' },
    });
    expect(inps.received.length).toBe(before);
  });

  it('il sostituto firma con le proprie credenziali del Sistema TS', async () => {
    const d = await create(good(), 'sostituto');
    expect((await send(d.id, 'sostituto')).json()).toMatchObject({ esito: 'accepted' });
    expect(inps.receivedAuth.at(-1)!.username).toBe(`sistema_ts-${s.users.sostituto.username}`);
  });

  it('INPS non raggiungibile: errore, poi si riprova; rifiutato: si corregge e si rimanda', async () => {
    const d = await create(good());
    outcome = 'unreachable';
    expect((await send(d.id)).json()).toMatchObject({ esito: 'unreachable' });
    outcome = 'accepted';
    expect((await send(d.id)).json()).toMatchObject({ esito: 'accepted' });
    const r = await create(good());
    outcome = 'rejected';
    expect((await send(r.id)).json()).toMatchObject({ esito: 'rejected' });
    outcome = 'accepted';
    expect((await send(r.id)).statusCode).toBe(409);
    expect(
      (await req('PUT', `/api/certificati/${r.id}`, 'titolare', { noteDiagnosi: 'Corretta' }))
        .statusCode,
    ).toBe(200);
    expect((await send(r.id)).json()).toMatchObject({ esito: 'accepted' });
  });

  it('copia per il lavoratore (allegato A): tutti i dati inviati, DataRicezione e IdCertificato', async () => {
    const cert = await sent();
    const text = await pdf(cert.id, 'copia');
    for (const part of [
      'Copia cartacea per il lavoratore',
      'Certificato di malattia telematico',
      `Protocollo ${cert.protocollo}`,
      'DATI DEL MEDICO',
      'Dott.ssa Elena Marchi',
      'MMG-PROVA-1',
      'DATI DIAGNOSI',
      'Cod. Nosologico 487.1',
      'Sindrome influenzale di prova',
      '[X] Inizio',
      '[X] Ambulatoriale',
      'RESIDENZA O DOMICILIO ABITUALE',
      'Via dei Prova',
      'n. SNC',
      'DataRicezione',
      `IdCertificato ${cert.protocollo}`,
      RELEASE_FOOTER,
    ])
      expect(text, part).toContain(norm(part));
  });

  it('attestato per il datore di lavoro (allegato B): senza diagnosi e senza tipo di visita', async () => {
    const cert = await sent();
    const text = await pdf(cert.id, 'attestato');
    expect(text).toContain('Copia cartacea per il datore di lavoro');
    expect(text).toContain('Attestato di malattia telematico');
    expect(text).toContain(`Protocollo ${cert.protocollo}`);
    for (const absent of [
      '487.1',
      'Sindrome influenzale',
      'DATI DIAGNOSI',
      'Visita',
      'Ambulatoriale',
      'Agevolazioni',
    ])
      expect(text, absent).not.toContain(absent);
    // Aprire il PDF non è una consegna (audit D259): la consegna su carta la segna chi la fa.
    const rows = () =>
      t.db.select().from(certificateDelivery).where(eq(certificateDelivery.certificateId, cert.id));
    expect(await rows()).toEqual([]);
    const paper = await req('POST', `/api/certificati/${cert.id}/consegna-carta`, 'titolare', {
      documento: 'attestato',
    });
    expect(paper.statusCode, paper.body).toBe(200);
    expect((await rows()).map((r) => [r.channel, r.outcome])).toEqual([
      ['stampa_attestato', 'consegnato'],
    ]);
    for (const bad of [{}, { documento: 'ricetta' }])
      expect(
        (await req('POST', `/api/certificati/${cert.id}/consegna-carta`, 'titolare', bad))
          .statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    // Una bozza non si consegna.
    const draft = await create(good());
    const early = await req('POST', `/api/certificati/${draft.id}/consegna-carta`, 'titolare', {
      documento: 'copia',
    });
    expect(early.statusCode).toBe(409);
  });

  it('la copia resta quella dell’invio anche se poi cambia l’anagrafica', async () => {
    const cert = await sent();
    const before = await pdf(cert.id, 'copia');
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(patient).set({ lastName: 'Cambiato' }).where(eq(patient.id, s.richPatient)),
    );
    expect(await pdf(cert.id, 'copia')).toBe(before);
  });

  it('continuazione: dal giorno dopo la fine della prognosi, con gli stessi dati', async () => {
    const cert = await sent();
    const cont = await create({ continuaDa: cert.id });
    expect(cont).toMatchObject({
      tipo: 'C',
      dataInizio: studioDate(new Date(Date.parse(`${cert.dataFine}T12:00:00Z`) + DAY)),
    });
    const [row] = await t.db
      .select()
      .from(sickLeaveCertificate)
      .where(eq(sickLeaveCertificate.id, cont.id));
    expect(row!.diagnosisCode).toBe('487.1');
  });

  it('rettifica: solo per anticipare la fine; certificato nuovo con protocollo nuovo; il vecchio non vale più', async () => {
    const cert = await sent({ ...good(), dataFine: plus(5) });
    expect(
      (
        await req('POST', `/api/certificati/${cert.id}/rettifica`, 'titolare', {
          dataFine: plus(7),
        })
      ).statusCode,
    ).toBe(409);
    const res = await req('POST', `/api/certificati/${cert.id}/rettifica`, 'titolare', {
      dataFine: plus(1),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { protocollo, certificato } = res.json<{ protocollo: string; certificato: string }>();
    expect(protocollo).not.toBe(cert.protocollo);
    const old = (await req('GET', `/api/certificati/${cert.id}`)).json<CertView>();
    const fresh = (await req('GET', `/api/certificati/${certificato}`)).json<CertView>();
    expect(old.stato).toBe('rectified');
    expect(fresh).toMatchObject({ stato: 'sent', dataFine: plus(1), rettificaDi: cert.protocollo });
    expect(await pdf(certificato, 'copia')).toContain(
      `Rettifica del certificato protocollo ${cert.protocollo}`,
    );
    expect((await req('GET', `/api/certificati/${cert.id}/copia`)).statusCode).toBe(409);
  });

  it('consegne: email al lavoratore con copia e attestato, SMS con i dati essenziali, al datore solo il protocollo', async () => {
    const cert = await sent();
    const email = await req('POST', `/api/certificati/${cert.id}/consegna`, 'titolare', {
      canale: 'email',
    });
    expect(email.json(), email.body).toMatchObject({
      esito: 'consegnato',
      recapito: 'lavoratore@esempio.invalid',
    });
    const mail = sender.emails.at(-1)!;
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      `certificato-${cert.protocollo}.pdf`,
      `attestato-${cert.protocollo}.pdf`,
    ]);
    expect(mail.text).not.toMatch(/487|influenzale/i);
    await req('POST', `/api/certificati/${cert.id}/consegna`, 'titolare', { canale: 'sms' });
    const sms = sender.sms.at(-1)!.text;
    for (const part of [cert.protocollo!, 'rilasciato il', '(3 giorni)', 'Dott.ssa Elena Marchi'])
      expect(sms, part).toContain(part);
    expect(sms).not.toMatch(/487|influenzale/i);
    // Al datore di lavoro: solo se lo chiede il lavoratore, e solo il protocollo (D88).
    expect(
      (
        await req('POST', `/api/certificati/${cert.id}/consegna`, 'titolare', {
          canale: 'email_datore',
        })
      ).statusCode,
    ).toBe(400);
    const emp = await req('POST', `/api/certificati/${cert.id}/consegna`, 'titolare', {
      canale: 'email_datore',
      richiestaDelLavoratore: true,
    });
    expect(emp.json()).toMatchObject({ recapito: 'datore@esempio.invalid' });
    const toEmployer = sender.emails.at(-1)!;
    expect(toEmployer.attachments).toEqual([]);
    expect(toEmployer.text).toContain(cert.protocollo!);
    // Protocollo e nome del lavoratore come all'invio, come nell'attestato (D108); mai la diagnosi.
    expect(toEmployer.text).not.toMatch(/487|influenzale|diagnosi|Marchi/i);
    const [row] = await t.db
      .select()
      .from(sickLeaveCertificate)
      .where(eq(sickLeaveCertificate.id, cert.id));
    const worker = (row!.snapshot as { worker: { firstName: string; lastName: string } }).worker;
    expect(toEmployer.text).toContain(`${worker.firstName} ${worker.lastName}`);
    expect(toEmployer.subject).not.toContain(worker.lastName);
    const list = (await req('GET', `/api/certificati/${cert.id}/consegne`)).json<{
      consegne: { canale: string }[];
    }>();
    expect(list.consegne.map((d) => d.canale)).toEqual([
      'email_lavoratore',
      'sms_lavoratore',
      'email_datore',
    ]);
  });

  it('annullamento: entro il giorno dopo il rilascio; dopo no; una bozza si annulla solo qui', async () => {
    const cert = await sent();
    const draft = await create(good());
    const local = await req('POST', `/api/certificati/${draft.id}/annulla`, 'titolare', {
      motivo: 'Preparato per errore',
    });
    expect(local.json()).toMatchObject({ esito: 'accepted', protocollo: null });
    s.clock.advance(2 * DAY);
    for (const who of ['titolare'] as const) c[who] = await login(s, who);
    const late = await req('POST', `/api/certificati/${cert.id}/annulla`, 'titolare', {
      motivo: 'Troppo tardi',
    });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ errore: string }>().errore).toMatch(/giorno successivo/);
    const fresh = await sent();
    const ok = await req('POST', `/api/certificati/${fresh.id}/annulla`, 'titolare', {
      motivo: 'Inviato per errore',
    });
    expect(ok.json(), ok.body).toMatchObject({
      esito: 'accepted',
      protocollo: expect.stringMatching(/^SIM/),
    });
    expect((await req('GET', `/api/certificati/${fresh.id}`)).json<CertView>().stato).toBe(
      'cancelled',
    );
  });

  it('invii all’INPS e consegne non si modificano e non si cancellano', async () => {
    for (const table of ['certificate_submission', 'certificate_delivery']) {
      for (const statement of [`update ${table} set outcome = 'x'`, `delete from ${table}`]) {
        let message = '';
        try {
          await t.db.execute(sql.raw(statement));
        } catch (err) {
          const e = err as { message: string; cause?: { message: string } };
          message = e.cause?.message ?? e.message;
        }
        expect(message, statement).toMatch(/non si modificano/);
      }
    }
  });

  it('rettifica dopo la fine della prognosi: non ammessa', async () => {
    const cert = await sent({ ...good(), dataFine: plus(1) });
    s.clock.advance(3 * DAY);
    c.titolare = await login(s, 'titolare');
    const res = await req('POST', `/api/certificati/${cert.id}/rettifica`, 'titolare', {
      dataFine: studioDayFrom(s.clock.now(), -2),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ errore: string }>().errore).toMatch(/entro la fine della prognosi/);
  });
});
