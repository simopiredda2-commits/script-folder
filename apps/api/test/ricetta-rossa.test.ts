import { SimulatedGateway, type SimulatorOptions } from '@mmg/integrations';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dpcmPrescription,
  externalSubmission,
  prescription,
  serviceCredential,
} from '../src/db/schema';
import { DPCM_CHECK_MINUTES } from '../src/prescriptions/dpcm';
import { pdfText } from './helpers/pdf-text';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/**
 * Ricetta rossa in DPCM (D270): senza esito della ricetta dematerializzata si stampa sul modulo del
 * Poligrafico, con un NRE nuovo, e si manda al SAR in DPCM; la dematerializzata che può essere
 * arrivata si annulla (SIRPED, «Cartelle cliniche MMG e PLS», V06, 4.2 e 4.3.1). Numeri del modulo
 * inventati, nella forma del disciplinare del DM 17/3/2008.
 */
describe('ricetta rossa in DPCM (D270)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  /** Esiti scelti dalla prova, invio per invio; le altre opzioni del simulatore si cambiano qui. */
  const sends: ('accepted' | 'rejected' | 'unreachable' | 'timeout' | 'fault')[] = [];
  const options: SimulatorOptions = {
    decide: () => sends.shift() ?? 'accepted',
  };
  const sar = new SimulatedGateway('sar', options);
  let form = 1;
  /** Un modulo nuovo del ricettario: ente 010 (Piemonte), anno 26, ricettario 0001234. */
  const nextForm = () => `0102600012340${String(form++).padStart(2, '0')}`;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Senza il blocco per inattività: le prove dell'invio interrotto fanno passare 16 minuti.
    s = await createScenario(
      t.db,
      { idleLockMinutes: null },
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        preSendChecks: noRules,
        sendTimeoutMs: 100,
        // I 2 secondi fra un file e l'altro dello stesso medico (6.1.1), qui accorciati.
        dpcm: { intervalMs: null, minIntervalMs: 300 },
      },
    );
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const)
      c[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });
  beforeEach(() => {
    sends.length = 0;
    delete options.delayMs;
    delete options.decideDpcm;
    delete options.decideDpcmReceipt;
    delete options.decideCancel;
  });

  const req = (who: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: c[who]! },
      ...(payload !== undefined ? { payload } : {}),
    });
  const row = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;
  const red = async (id: string) =>
    (await t.db.select().from(dpcmPrescription).where(eq(dpcmPrescription.prescriptionId, id)))[0];
  const draft = async (kind: 'pharma_ssn' | 'specialist_ssn' | 'white' = 'pharma_ssn') => {
    const res = await req(
      'titolare',
      'POST',
      `/api/pazienti/${s.richPatient}/ricette`,
      kind === 'specialist_ssn'
        ? {
            kind,
            priority: 'P',
            accessType: 'first',
            diagnosticQuestion: 'Controllo della funzione renale',
            lines: [
              {
                serviceCode: '90.16.4_0',
                serviceNationalCode: '90.16.4',
                serviceDescription: 'CREATININA',
                quantity: 1,
              },
            ],
          }
        : { kind, lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }] },
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  /** Ricetta firmata e rimasta senza esito: il SAR non ha risposto in tempo. */
  const uncertain = async (kind: 'pharma_ssn' | 'specialist_ssn' = 'pharma_ssn') => {
    const id = await draft(kind);
    sends.push('timeout');
    const res = await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(res.json(), res.body).toMatchObject({ esito: 'timeout' });
    return id;
  };
  const print = (id: string, poligrafico = nextForm()) =>
    req('titolare', 'POST', `/api/ricette/${id}/ricetta-rossa`, { poligrafico });
  const runQueue = () => req('titolare', 'POST', '/api/ricette-rosse/invia', {});
  const exchanges = async (id: string) =>
    (
      await t.db
        .select()
        .from(externalSubmission)
        .where(eq(externalSubmission.prescriptionId, id))
        .orderBy(asc(externalSubmission.id))
    ).map((x) => [x.operation, x.outcome]);

  it('esito incerto: la ricetta dematerializzata non si rimanda, si stampa la ricetta rossa', async () => {
    const id = await uncertain();
    const again = await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().errore).toMatch(/si stampa la ricetta rossa/);
    const before = await row(id);
    const res = await print(id, '010260001234000');
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out).toMatchObject({
      stato: 'paper',
      poligrafico: '010260001234000',
      annullamentoDematerializzata: 'da_fare',
    });
    // Un NRE nuovo del lotto, non quello della dematerializzata (V06, 4.3.1, caso 4).
    expect(out.nre).toMatch(/^010ZZ4\d{9}$/);
    expect(out.nre).not.toBe(before.assignedNre);
    const r = await row(id);
    expect(r).toMatchObject({ status: 'paper', paperPrintedBy: s.users.titolare.id });
    const d = await red(id);
    expect(d).toMatchObject({
      status: 'to_send',
      dmNre: before.assignedNre,
      dmCancelStatus: 'pending',
    });
  });

  it('la coda annulla la dematerializzata arrivata, manda il file DPCM e ne legge l’esito', async () => {
    // Il SAR ha ricevuto la ricetta dematerializzata, ma la risposta è arrivata dopo l'attesa.
    const id = await draft();
    options.delayMs = 300;
    const sent = await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(sent.json(), sent.body).toMatchObject({ esito: 'timeout' });
    delete options.delayMs;
    await new Promise((r) => setTimeout(r, 350));
    expect((await print(id)).statusCode).toBe(200);
    const queued = await runQueue();
    expect(queued.statusCode, queued.body).toBe(200);
    let d = (await red(id))!;
    expect(d).toMatchObject({ dmCancelStatus: 'done', status: 'accepted' });
    expect(d.protocol).toMatch(/^99\d{21}$/);
    // Il file: TipoInvio RPS, Bar1 e Bar2 dal modulo, Ricetta1 con l'NRE nuovo (V06, 4.2.1).
    const xml = sar.dpcmFiles.find((f) => f.xml.includes(`<Ricetta1>${d.nre}</Ricetta1>`))!.xml;
    expect(xml).toContain('<TipoInvio>RPS</TipoInvio>');
    expect(xml).toContain(`<Bar1>${d.poligrafico.slice(0, 5)}</Bar1>`);
    expect(xml).toContain(`<Bar2>${d.poligrafico.slice(5)}</Bar2>`);
    expect(xml).toContain(`<Ricetta1>${d.nre}</Ricetta1>`);
    // Esito: la prima lettura dice «in attesa», la seconda «senza errori».
    s.clock.advance(DPCM_CHECK_MINUTES * 60_000);
    await runQueue();
    expect((await red(id))!).toMatchObject({ status: 'accepted', sendState: 1 });
    await runQueue();
    d = (await red(id))!;
    expect(d).toMatchObject({ status: 'ok', sendState: 2, messages: [] });
    expect(await exchanges(id)).toEqual([
      ['invio', 'timeout'],
      ['annullamento', 'accepted'],
      ['dpcm_invio', 'accepted'],
      ['dpcm_esito', 'ok'],
      ['dpcm_esito', 'ok'],
    ]);
  });

  it('la dematerializzata firmata dal sostituto si annulla a nome suo, con le sue credenziali', async () => {
    const id = await draft();
    options.delayMs = 300;
    const sent = await req('sostituto', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(sent.json(), sent.body).toMatchObject({ esito: 'timeout' });
    delete options.delayMs;
    await new Promise((r) => setTimeout(r, 350));
    // La ricetta rossa la stampa la titolare.
    expect((await print(id)).statusCode).toBe(200);
    expect((await red(id))!).toMatchObject({
      doctorUserId: s.users.titolare.id,
      dmDoctorUserId: s.users.sostituto.id,
    });
    await runQueue();
    expect((await red(id))!.dmCancelStatus).toBe('done');
    const [cancel] = await t.db
      .select()
      .from(externalSubmission)
      .where(
        and(
          eq(externalSubmission.prescriptionId, id),
          eq(externalSubmission.operation, 'annullamento'),
        ),
      );
    expect(cancel!.userId).toBe(s.users.sostituto.id);
  });

  it('con il SAR non raggiungibile la ricetta rossa non annulla niente: la ricetta non era arrivata', async () => {
    const id = await draft();
    sends.push('unreachable');
    expect(
      (await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {})).json(),
    ).toMatchObject({
      esito: 'unreachable',
    });
    const res = await print(id);
    expect(res.json()).toMatchObject({ stato: 'paper', annullamentoDematerializzata: null });
    expect(await red(id)).toMatchObject({ dmNre: null, dmCancelStatus: null });
  });

  it('il numero del modulo: 15 cifre, della regione dello studio, mai usato due volte', async () => {
    const id = await uncertain();
    const short = await print(id, '01026000123401');
    expect(short.statusCode).toBe(400);
    expect(short.json().errore).toMatch(/15 cifre/);
    const other = await print(id, '030260001234099');
    expect(other.statusCode).toBe(400);
    expect(other.json().errore).toMatch(/altro ente \(codice 030\)/);
    // Un modulo già usato per un'altra ricetta: la prova non dipende dalle prove di prima.
    const module = nextForm();
    expect((await print(await uncertain(), module)).statusCode).toBe(200);
    const used = await print(id, module);
    expect(used.statusCode).toBe(409);
    expect(used.json().errore).toMatch(/già stato usato/);
    // Nessun numero sprecato: la ricetta è ancora senza esito.
    expect((await row(id)).status).toBe('error');
  });

  it('due file dello stesso medico partono a distanza: 2 secondi, qui 300 ms (6.1.1)', async () => {
    const a = await uncertain();
    const b = await uncertain();
    expect((await print(a)).statusCode).toBe(200);
    expect((await print(b)).statusCode).toBe(200);
    expect((await runQueue()).statusCode).toBe(200);
    const times = (
      await t.db
        .select({ at: externalSubmission.at })
        .from(externalSubmission)
        .where(
          and(
            eq(externalSubmission.operation, 'dpcm_invio'),
            inArray(externalSubmission.prescriptionId, [a, b]),
          ),
        )
        .orderBy(asc(externalSubmission.at))
    ).map((x) => x.at.getTime());
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(280);
  });

  it('lo stesso modulo su due ricette lo vieta anche il database', async () => {
    const id = await uncertain();
    const module = nextForm();
    expect((await print(id, module)).statusCode).toBe(200);
    const [first] = await t.db
      .select()
      .from(dpcmPrescription)
      .where(eq(dpcmPrescription.prescriptionId, id));
    const other = await uncertain();
    const { id: firstId, ...copy } = first!;
    expect(firstId).toBeTruthy();
    await expect(
      t.db.insert(dpcmPrescription).values({
        ...copy,
        prescriptionId: other,
        nre: '010ZZ4999999999',
        nreLotId: null,
      }),
    ).rejects.toThrow();
    // Due stampe nello stesso istante sullo stesso modulo: una sola passa, l'altra lo dice.
    const third = await uncertain();
    const same = nextForm();
    const both = await Promise.all([print(other, same), print(third, same)]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json().errore).toMatch(/già stato usato/);
  });

  it('la specialistica va in DPCM con catalogo e tipo di accesso in Prescrizione2 (V06, 4.2.1)', async () => {
    const id = await uncertain('specialist_ssn');
    const out = (await print(id)).json();
    await runQueue();
    const xml = sar.dpcmFiles.find((f) => f.xml.includes(`<Ricetta1>${out.nre}</Ricetta1>`))!.xml;
    expect(xml).toContain('<TipoPrescrizione>P</TipoPrescrizione>');
    expect(xml).toContain('<CodProdPrest>90.16.4</CodProdPrest>');
    expect(xml).toContain('<Prescrizione2>CODCATPRESCR=90.16.4_0$TIPOACC=1$</Prescrizione2>');
    expect(xml).toContain(
      '<DescrizioneDiagnosi>Controllo della funzione renale</DescrizioneDiagnosi>',
    );
    expect(xml).toContain('<ClassePriorita>P</ClassePriorita>');
  });

  it('il SAR non raggiungibile: la ricetta rossa resta da mandare e la coda riprova da sé', async () => {
    const id = await uncertain();
    options.decideDpcmReceipt = () => 'unreachable';
    expect((await print(id)).statusCode).toBe(200);
    await runQueue();
    let d = (await red(id))!;
    expect(d.status).toBe('to_send');
    expect(d.lastError).toMatch(/non ancora mandata: il SAR non è raggiungibile/);
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(s.clock.now().getTime());
    delete options.decideDpcmReceipt;
    // Il SAR risponde di nuovo: «Invia adesso» la manda.
    await runQueue();
    d = (await red(id))!;
    expect(d.status).toBe('accepted');
    expect(d.attempts).toBe(2);
  });

  it('l’esito che non si legge si rilegge dopo 5 minuti, anche dopo un invio riprovato', async () => {
    const id = await uncertain();
    options.decideDpcmReceipt = () => 'unreachable';
    expect((await print(id)).statusCode).toBe(200);
    await runQueue();
    await runQueue();
    delete options.decideDpcmReceipt;
    await runQueue();
    expect((await red(id))!).toMatchObject({ status: 'accepted', attempts: 3 });
    const summary = sar.dpcmSummary.bind(sar);
    sar.dpcmSummary = () =>
      Promise.resolve({ outcome: 'unreachable', message: 'Servizio non raggiungibile (simulato)' });
    try {
      await runQueue();
    } finally {
      sar.dpcmSummary = summary;
    }
    const d = (await red(id))!;
    expect(d.lastError).toMatch(/Esito della ricetta rossa non ancora letto/);
    expect(d.nextAttemptAt!.getTime() - s.clock.now().getTime()).toBe(DPCM_CHECK_MINUTES * 60_000);
  });

  it('il giorno dopo la compilazione il SAR dà l’avviso 2090, che non si corregge', async () => {
    const id = await uncertain();
    options.decideDpcmReceipt = () => 'unreachable';
    expect((await print(id)).statusCode).toBe(200);
    await runQueue();
    delete options.decideDpcmReceipt;
    options.now = () => new Date(s.clock.now().getTime() + 86_400_000);
    options.dpcmPendingChecks = 0;
    try {
      await runQueue();
      await runQueue();
      const d = (await red(id))!;
      expect(d).toMatchObject({ status: 'warnings', sendState: 3 });
      expect(d.messages).toEqual([
        {
          code: '2090',
          description: 'Avviso: Data compilazione precedente alla data di ricezione',
        },
      ]);
    } finally {
      delete options.now;
      delete options.dpcmPendingChecks;
    }
  });

  it('errori scartanti: la ricetta rossa resta con i messaggi del SAR', async () => {
    const id = await uncertain();
    options.dpcmPendingChecks = 0;
    options.decideDpcm = () => ({
      state: 4,
      errors: [{ code: 'SIM-ERR', description: 'Errore scartante (simulato)' }],
    });
    try {
      expect((await print(id)).statusCode).toBe(200);
      await runQueue();
      await runQueue();
      const d = (await red(id))!;
      expect(d).toMatchObject({ status: 'discarded', sendState: 4 });
      expect(d.messages).toEqual([{ code: 'SIM-ERR', description: 'Errore scartante (simulato)' }]);
      const list = (await req('titolare', 'GET', '/api/ricette-rosse')).json().ricette;
      expect(list.find((x: { ricetta: string }) => x.ricetta === id)).toMatchObject({
        stato: 'discarded',
        messaggi: [{ code: 'SIM-ERR' }],
      });
    } finally {
      delete options.dpcmPendingChecks;
    }
  });

  it('l’elenco del medico: paziente, PDF e quelle da seguire, che Oggi conta (D270)', async () => {
    const toFollow = async (who = 'titolare') =>
      (await req(who, 'GET', '/api/oggi')).json<{ code: { ricetteRosse: number | null } }>().code
        .ricetteRosse;
    // SAR non raggiungibile: niente da annullare, così conta solo la ricetta scartata.
    const id = await draft();
    sends.push('unreachable');
    await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    const out = (await print(id)).json<{ nre: string; annullamentoDematerializzata: unknown }>();
    expect(out.annullamentoDematerializzata).toBeNull();
    const listed = async () =>
      (await req('titolare', 'GET', '/api/ricette-rosse'))
        .json<{
          ricette: { ricetta: string; nomePaziente: string; pdf: string; daSeguire: boolean }[];
        }>()
        .ricette.find((r) => r.ricetta === id)!;
    const mine = await listed();
    expect(mine).toMatchObject({
      pdf: `/api/ricette/${id}/ricetta-rossa.pdf`,
      stato: 'to_send',
      daSeguire: false,
    });
    expect(mine.nomePaziente).toMatch(/\S+ \S+/);
    // Appena stampata non chiede niente: parte da sola. Scartata dal SAR sì, e Oggi la conta.
    const before = (await toFollow())!;
    options.dpcmPendingChecks = 0;
    options.decideDpcm = (p) =>
      p.nre === out.nre
        ? { state: 4, errors: [{ code: 'SIM-ERR', description: 'Errore scartante (simulato)' }] }
        : undefined;
    try {
      await runQueue();
      await runQueue();
    } finally {
      delete options.dpcmPendingChecks;
    }
    expect(await listed()).toMatchObject({ stato: 'discarded', daSeguire: true });
    expect(await toFollow()).toBe(before + 1);
    // La segreteria non ha ricette rosse: l'elenco è vuoto e Oggi non le conta.
    expect((await req('segreteria', 'GET', '/api/ricette-rosse')).json().ricette).toEqual([]);
    expect(await toFollow('segreteria')).toBeNull();
  });

  it('senza credenziali RUPAR la ricetta rossa resta da mandare, con il motivo', async () => {
    const id = await uncertain();
    expect((await print(id)).statusCode).toBe(200);
    const saved = await t.db
      .select()
      .from(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    await t.db
      .delete(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    try {
      await runQueue();
      const d = (await red(id))!;
      expect(d.status).toBe('to_send');
      expect(d.lastError).toMatch(/Ricetta rossa non mandata: Mancano le credenziali RUPAR/);
    } finally {
      await t.db.insert(serviceCredential).values(saved);
    }
    await runQueue();
    expect((await red(id))!.status).toBe('accepted');
  });

  /** Come dopo un arresto del servizio: firmata, «in invio» con il suo NRE, e nessun esito. */
  const stuck = async (nre: string) => {
    const id = await draft();
    await t.db
      .update(prescription)
      .set({
        status: 'sending',
        signedBy: s.users.titolare.id,
        signedAt: s.clock.now(),
        assignedNre: nre,
      })
      .where(eq(prescription.id, id));
    return id;
  };

  it('invio interrotto: prima dei 15 minuti niente; poi la ricetta rossa, e la dematerializzata si annulla da sé (D233)', async () => {
    const id = await stuck('010ZZ4999990001');
    const early = await print(id);
    expect(early.statusCode).toBe(409);
    s.clock.advance(16 * 60_000);
    const res = await print(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().annullamentoDematerializzata).toBe('da_fare');
    expect(res.json().nre).not.toBe('010ZZ4999990001');
    expect((await red(id))!).toMatchObject({ dmNre: '010ZZ4999990001', dmCancelStatus: 'pending' });
    expect((await row(id)).status).toBe('paper');
  });

  it('l’ora della firma con i microsecondi non ferma la stampa: lo stesso invio si riconosce', async () => {
    const id = await stuck('010ZZ4999990003');
    // Postgres tiene i microsecondi, una data di JavaScript no: come un'ora scritta dal database.
    await t.db.execute(
      sql`update prescription set signed_at = signed_at + interval '250 microseconds' where id = ${id}`,
    );
    s.clock.advance(16 * 60_000);
    const res = await print(id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(id)).status).toBe('paper');
  });

  it('«Non è arrivata» per la farmaceutica: si stampa la ricetta rossa, senza annullare niente', async () => {
    const id = await stuck('010ZZ4999990002');
    s.clock.advance(16 * 60_000);
    const settled = await req('titolare', 'POST', `/api/ricette/${id}/esito-invio`, {
      esito: 'non_arrivata',
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect((await row(id)).lastErrorMessage).toMatch(/si stampa la ricetta rossa/);
    // La dematerializzata non si rimanda: come vuole la Regione (V06, 4.3.1).
    const again = await req('titolare', 'POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(again.statusCode).toBe(409);
    const res = await print(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().annullamentoDematerializzata).toBeNull();
  });

  it('il PDF sul modulo: NRE in chiaro, codice fiscale del paziente, «STAMPA PC» biffata', async () => {
    const id = await uncertain();
    const out = (await print(id)).json();
    const pdf = await req('titolare', 'GET', out.pdf);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const text = await pdfText(pdf.rawPayload);
    // Testo in OCR-A: chi lo estrae mette più spazi fra le parole.
    expect(text).toMatch(new RegExp(`NRE\\s+${out.nre}`));
    expect(text).toContain('1 x Farmaco di prova 5 mg');
  });

  it('la segreteria non stampa la ricetta rossa', async () => {
    const id = await uncertain();
    const res = await req('segreteria', 'POST', `/api/ricette/${id}/ricetta-rossa`, {
      poligrafico: nextForm(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('la ricetta bianca resta come prima: il ripiego solo con il Sistema TS non raggiungibile', async () => {
    const id = await draft('white');
    const res = await req('titolare', 'POST', `/api/ricette/${id}/ricetta-rossa`, {});
    expect(res.statusCode).toBe(409);
    expect(await red(id)).toBeUndefined();
  });

  it('nell’elenco del medico: quelle in corso sempre, quelle chiuse per 30 giorni', async () => {
    const open = await uncertain();
    const closed = await uncertain();
    expect((await print(open)).statusCode).toBe(200);
    expect((await print(closed)).statusCode).toBe(200);
    const old = new Date(s.clock.now().getTime() - 31 * 86_400_000);
    await t.db
      .update(dpcmPrescription)
      .set({ printedAt: old })
      .where(inArray(dpcmPrescription.prescriptionId, [open, closed]));
    await t.db
      .update(dpcmPrescription)
      .set({ status: 'ok', dmCancelStatus: 'done' })
      .where(eq(dpcmPrescription.prescriptionId, closed));
    const ids = (await req('titolare', 'GET', '/api/ricette-rosse'))
      .json<{ ricette: { ricetta: string }[] }>()
      .ricette.map((r) => r.ricetta);
    expect(ids).toContain(open);
    expect(ids).not.toContain(closed);
  });

  // Ultima: fa passare un giorno sull'orologio dello scenario.
  it('passate le 24 ore senza invio, la ricetta rossa è da seguire anche senza errori', async () => {
    const id = await uncertain();
    expect((await print(id)).statusCode).toBe(200);
    const follows = async () =>
      (await req('titolare', 'GET', '/api/ricette-rosse'))
        .json<{ ricette: { ricetta: string; daSeguire: boolean }[] }>()
        .ricette.find((r) => r.ricetta === id)!.daSeguire;
    expect(await follows()).toBe(false);
    s.clock.advance(25 * 3_600_000);
    // Dopo un giorno la sessione è scaduta: si rientra.
    c.titolare = await login(s, 'titolare');
    expect(await follows()).toBe(true);
  });
});
