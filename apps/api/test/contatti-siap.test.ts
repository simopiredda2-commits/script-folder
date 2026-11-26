import {
  ACTIVITY_REGIMES,
  CONTACT_ACCESS_TYPES,
  CONTACT_MODES,
  PROBLEM_STATES,
  SIAP_ACT_KINDS,
} from '@mmg/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  appointment,
  clinicalEntry,
  diaryDetail,
  importBatch,
  importOrigin,
  patient,
  patientChoice,
  prescription,
  prescriptionLine,
  problemDetail,
  siapActivityRegime,
  siapAccessType,
  siapActKind,
  siapContact,
  siapContactMode,
  siapContactService,
  siapProblemState,
  sickLeaveCertificate,
  studio,
  templateCertificate,
  therapy,
  vaccinationDetail,
} from '../src/db/schema';
import { importPpipCatalog } from './helpers/ppip';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { rmSync } from 'node:fs';

interface Service {
  tipologia: number;
  dettaglio: number;
  quantita: number;
}
interface View {
  id: string | null;
  paziente: { id: string; cognome: string };
  giorno: string;
  stato: 'proposto' | 'confermato' | 'da_aggiornare' | 'scartato';
  atti: { tipo: string; id: string; descrizione: string; nuovo: boolean }[];
  attiTolti: number;
  proposta: {
    modalita: string;
    regime: string;
    accesso: string;
    problema: string;
    statoProblema: string;
    prestazioni: Service[];
  };
  aggiornamento: Service[] | null;
  contatto: null | {
    progressivo: number | null;
    struttura: { codice: string | null; tipo: string | null };
    modalita: string;
    accesso: string;
    problema: { codice: string; stato: string; apertoIl: string | null; voce: string | null };
    prestazioni: Service[];
    motivoScarto: string | null;
  };
}
interface Listing {
  struttura: { codice: string | null; tipo: string };
  contatti: View[];
  problemi: Record<string, { voce: string; codice: string; cronico: boolean }[]>;
  tipologie: { codice: number; dettagli: { codice: number }[] }[];
}

/**
 * Contatti del SIAP (D291): proposti dagli atti del medico, per paziente e giorno; confermati con
 * il progressivo del giorno nello studio, cambiati, scartati con il motivo. Studio, medici e
 * pazienti inventati; orologio fermo al 24/11/2026.
 */
describe('contatti del SIAP dagli atti del medico (D291)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let work = '';
  const DAY = '2026-11-24';
  const cookies: Record<string, string> = {};
  type Who = 'titolare' | 'collega' | 'segreteria' | 'sostituto' | 'amministratore';
  const req = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who]! },
      ...(payload ? { payload } : {}),
    });
  const list = async (who: Who, dal = DAY, al = DAY) => {
    const res = await req(who, 'GET', `/api/siap/contatti?dal=${dal}&al=${al}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Listing>();
  };
  let rich: string;
  let second: string;
  let onlyChoice: string;
  const at = new Date(`${DAY}T10:00:00Z`);

  const diary = async (patientId: string, author: string, contactType: 'office' | 'phone') => {
    const [e] = await t.db
      .insert(clinicalEntry)
      .values({ patientId, kind: 'diary', occurredOn: DAY, authorUserId: author })
      .returning();
    await t.db.insert(diaryDetail).values({ entryId: e!.id, contactType, text: 'Nota di prova.' });
    return e!.id;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { clockAt: new Date(`${DAY}T11:00:00Z`) });
    for (const who of ['titolare', 'collega', 'segreteria', 'sostituto', 'amministratore'] as const)
      cookies[who] = await login(s, who);
    work = (await importPpipCatalog(t.db)).work;
    rich = s.richPatient;
    const mine = await t.db
      .select()
      .from(patient)
      .where(eq(patient.archiveId, s.archives.titolare))
      .orderBy(patient.lastName, patient.firstName);
    [second, onlyChoice] = mine.filter((p) => p.id !== rich).map((p) => p.id) as [string, string];
    const tit = s.users.titolare.id;
    await t.db
      .update(studio)
      .set({ structureCode: 'PROVA1', structureType: 'gp_office' })
      .where(eq(studio.id, s.studioId));

    // Il paziente ricco, il 24/11: nota in studio, ricetta con un rinnovo e un farmaco nuovo,
    // certificato di malattia con la visita domiciliare, vaccino antinfluenzale, certificato
    // sportivo, prestazione aggiuntiva della segreteria, scelta che comincia e un appuntamento.
    await diary(rich, tit, 'office');
    const [chronic] = await t.db
      .select()
      .from(therapy)
      .where(and(eq(therapy.patientId, rich), eq(therapy.reserved, false)));
    const [rx] = await t.db
      .insert(prescription)
      .values({
        patientId: rich,
        archiveId: s.archives.titolare,
        kind: 'pharma_ssn',
        status: 'sent',
        preparedBy: tit,
        signedBy: tit,
        signedAt: at,
        sentAt: at,
      })
      .returning();
    await t.db.insert(prescriptionLine).values([
      {
        prescriptionId: rx!.id,
        position: 1,
        drugName: chronic!.drugName,
        quantity: 1,
        therapyId: chronic!.id,
        therapyKind: 'chronic',
      },
      { prescriptionId: rx!.id, position: 2, drugName: 'Farmaco nuovo di prova', quantity: 1 },
    ]);
    await t.db.insert(sickLeaveCertificate).values({
      patientId: rich,
      archiveId: s.archives.titolare,
      preparedBy: tit,
      status: 'sent',
      signedBy: tit,
      signedAt: at,
      type: 'I',
      visit: 'D',
      releaseDate: DAY,
      startDate: DAY,
      endDate: DAY,
      residence: { street: 'Via di Prova', number: '1' },
    });
    const [vx] = await t.db
      .insert(clinicalEntry)
      .values({ patientId: rich, kind: 'vaccination', occurredOn: DAY, authorUserId: tit })
      .returning();
    await t.db
      .insert(vaccinationDetail)
      .values({ entryId: vx!.id, vaccine: 'Antinfluenzale di prova', campaign: null });
    await t.db.insert(templateCertificate).values({
      patientId: rich,
      templateKey: 'sportivo-non-agonistico',
      templateTitle: 'Certificato sportivo di prova',
      templateVersion: '1',
      official: true,
      fields: [],
      paragraphs: [],
      signature: 'Firma di prova',
      layout: {} as never,
      issuedOn: DAY,
      issuedBy: tit,
    });
    const ppip = await req('segreteria', 'POST', `/api/pazienti/${rich}/ppip`, {
      data: DAY,
      luogo: 'studio',
      codice: 'A1',
      quantita: 2,
    });
    expect(ppip.statusCode, ppip.body).toBe(201);
    await t.db
      .insert(patientChoice)
      .values({ patientId: rich, doctorUserId: tit, chosenOn: DAY, source: 'manual' });
    await t.db.insert(appointment).values({
      studioId: s.studioId,
      patientId: rich,
      doctorUserId: tit,
      startsAt: new Date(`${DAY}T08:00:00Z`),
      endsAt: new Date(`${DAY}T08:20:00Z`),
      kind: 'office',
      status: 'done',
      createdBy: s.users.segreteria.id,
    });

    // Atti che non contano: annullati, importati, di un altro medico; una scelta da sola.
    const annulled = await diary(second, tit, 'office');
    await t.db
      .update(clinicalEntry)
      .set({ status: 'annulled', annulReason: 'Prova', annulledAt: at })
      .where(eq(clinicalEntry.id, annulled));
    const imported = await diary(second, tit, 'phone');
    const [batch] = await t.db
      .insert(importBatch)
      .values({
        studioId: s.studioId,
        archiveId: s.archives.titolare,
        userId: tit,
        fileName: 'prova.csv',
        fileSha256: '0'.repeat(64),
        fileSize: 1,
        format: 'csv',
        destination: 'diario',
        status: 'completed',
      })
      .returning();
    await t.db.insert(importOrigin).values({
      batchId: batch!.id,
      archiveId: s.archives.titolare,
      tableName: 'clinical_entry',
      rowId: imported,
      sourceKey: 'riga-1',
    });
    await diary(second, s.users.sostituto.id, 'phone');
    await t.db
      .insert(patientChoice)
      .values({ patientId: onlyChoice, doctorUserId: tit, chosenOn: DAY, source: 'manual' });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('i domini del database sono le chiavi del dominio, nello stesso ordine', () => {
    expect(siapContactMode.enumValues).toEqual([...CONTACT_MODES]);
    expect(siapActivityRegime.enumValues).toEqual([...ACTIVITY_REGIMES]);
    expect(siapAccessType.enumValues).toEqual([...CONTACT_ACCESS_TYPES]);
    expect(siapProblemState.enumValues).toEqual([...PROBLEM_STATES]);
    expect(siapActKind.enumValues).toEqual([...SIAP_ACT_KINDS]);
  });

  it('i contatti li vedono i medici: la segreteria e l’amministratore no, e il no resta nel registro', async () => {
    for (const who of ['segreteria', 'amministratore'] as const) {
      const res = await req(who, 'GET', `/api/siap/contatti?dal=${DAY}&al=${DAY}`);
      expect(res.statusCode, who).toBe(403);
      expect(res.body).toContain('i medici');
    }
    const denied = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'lettura_contatti_siap'), eq(accessLog.outcome, 'negato')));
    expect(denied).toHaveLength(2);
    const res = await req('segreteria', 'POST', '/api/siap/contatti/conferma', {
      paziente: rich,
      giorno: DAY,
    });
    expect(res.statusCode).toBe(403);
  });

  it('periodo: le due date, in ordine, al più 31 giorni', async () => {
    for (const q of [
      'dal=2026-11-24',
      'dal=2026-11-25&al=2026-11-24',
      'dal=2026-10-01&al=2026-11-24',
    ])
      expect((await req('titolare', 'GET', `/api/siap/contatti?${q}`)).statusCode, q).toBe(400);
    expect(
      (await req('titolare', 'GET', '/api/siap/contatti?dal=2026-10-25&al=2026-11-24')).statusCode,
    ).toBe(200);
  });

  it('la proposta dagli atti del giorno: attività, modalità, accesso e problema generico', async () => {
    const { contatti, struttura } = await list('titolare');
    expect(struttura).toEqual({ codice: 'PROVA1', tipo: 'gp_office' });
    // Il secondo paziente ha solo atti annullati, importati o del sostituto; la scelta da sola no.
    expect(contatti.map((c) => c.paziente.id)).toEqual([rich]);
    const c = contatti[0]!;
    expect(c).toMatchObject({ id: null, giorno: DAY, stato: 'proposto', contatto: null });
    expect(c.proposta).toEqual({
      // La nota in studio vale più della visita domiciliare del certificato.
      modalita: 'office',
      regime: 'choice',
      accesso: 'scheduled',
      problema: 'V70.0',
      statoProblema: 'unknown',
      prestazioni: [
        { tipologia: 0, dettaglio: 1, quantita: 1 },
        { tipologia: 1, dettaglio: 2, quantita: 1 },
        // A1, «Prima medicazione», due nella stessa registrazione.
        { tipologia: 5, dettaglio: 6, quantita: 2 },
        { tipologia: 6, dettaglio: 1, quantita: 1 },
        { tipologia: 6, dettaglio: 3, quantita: 1 },
        { tipologia: 7, dettaglio: 1, quantita: 1 },
        { tipologia: 8, dettaglio: 1, quantita: 1 },
        { tipologia: 8, dettaglio: 2, quantita: 1 },
      ],
    });
    expect(c.atti.map((a) => a.tipo).sort()).toEqual(
      ['certificate', 'choice', 'diary', 'pharma', 'ppip', 'sick_leave', 'vaccination'].sort(),
    );
    expect(c.atti.find((a) => a.tipo === 'pharma')!.descrizione).toBe(
      'Ricetta farmaceutica SSN, 2 farmaci',
    );
    // Il registro: una lettura per il paziente mostrato.
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.action, 'lettura_contatti_siap'), eq(accessLog.outcome, 'consentito')),
      );
    expect(logged.map((l) => l.patientId)).toContain(rich);
  });

  it('ogni medico vede i suoi: il sostituto la sua nota, il collega niente', async () => {
    const sub = await list('sostituto');
    expect(sub.contatti.map((c) => [c.paziente.id, c.proposta.modalita])).toEqual([
      [second, 'remote'],
    ]);
    expect((await list('collega')).contatti).toEqual([]);
  });

  let contactId = '';
  it('conferma con il problema scelto: progressivo 1, struttura fermata, prestazioni e atti', async () => {
    const { contatti, problemi } = await list('titolare');
    const c = contatti[0]!;
    const problem = problemi[rich]!.find((p) => p.codice === '000.0')!;
    const res = await req('titolare', 'POST', '/api/siap/contatti/conferma', {
      paziente: rich,
      giorno: DAY,
      modalita: c.proposta.modalita,
      accesso: c.proposta.accesso,
      problema: problem.voce,
      prestazioni: c.proposta.prestazioni,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ progressivo: 1 });
    contactId = res.json<{ id: string }>().id;
    const after = (await list('titolare')).contatti[0]!;
    expect(after).toMatchObject({ id: contactId, stato: 'confermato', aggiornamento: null });
    expect(after.contatto).toMatchObject({
      progressivo: 1,
      struttura: { codice: 'PROVA1', tipo: 'gp_office' },
      modalita: 'office',
      accesso: 'scheduled',
      problema: { codice: '000.0', stato: 'evolving', voce: problem.voce },
      prestazioni: c.proposta.prestazioni,
    });
    expect(after.atti.every((a) => !a.nuovo)).toBe(true);
    // La struttura cambiata dopo non cambia il contatto.
    await t.db.update(studio).set({ structureCode: 'PROVA2' }).where(eq(studio.id, s.studioId));
    expect((await list('titolare')).contatti[0]!.contatto!.struttura.codice).toBe('PROVA1');
    await t.db.update(studio).set({ structureCode: 'PROVA1' }).where(eq(studio.id, s.studioId));
  });

  it('un atto nuovo dopo la conferma: «da aggiornare», e la modifica lo porta dentro', async () => {
    await diary(rich, s.users.titolare.id, 'phone');
    const c = (await list('titolare')).contatti[0]!;
    expect(c.stato).toBe('da_aggiornare');
    expect(c.atti.filter((a) => a.nuovo).map((a) => a.descrizione)).toEqual([
      'Nota del diario, al telefono',
    ]);
    expect(c.aggiornamento).toContainEqual({ tipologia: 1, dettaglio: 4, quantita: 1 });
    const res = await req('titolare', 'PUT', `/api/siap/contatti/${contactId}`, {
      modalita: c.contatto!.modalita,
      accesso: c.contatto!.accesso,
      problema: c.contatto!.problema.voce,
      prestazioni: c.aggiornamento,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await list('titolare')).contatti[0]!;
    expect(after.stato).toBe('confermato');
    expect(after.contatto!.progressivo).toBe(1);
    expect(after.contatto!.prestazioni).toEqual(c.aggiornamento);
  });

  it('il contatto lo cambia solo il medico suo; uno confermato non si riconferma', async () => {
    const c = (await list('titolare')).contatti[0]!;
    const body = {
      modalita: 'home',
      accesso: 'direct',
      problema: null,
      prestazioni: c.contatto!.prestazioni,
    };
    const other = await req('sostituto', 'PUT', `/api/siap/contatti/${contactId}`, body);
    expect(other.statusCode).toBe(403);
    expect(other.body).toContain('di un altro medico');
    const again = await req('titolare', 'POST', '/api/siap/contatti/conferma', {
      paziente: rich,
      giorno: DAY,
      ...body,
    });
    expect(again.statusCode).toBe(409);
  });

  it('scelte non valide: attività fuori dall’allegato 2, ripetute, quantità, problema di un altro paziente, giorno senza atti', async () => {
    const base = {
      paziente: second,
      giorno: DAY,
      modalita: 'office',
      accesso: 'direct',
      problema: null,
      prestazioni: [{ tipologia: 1, dettaglio: 2, quantita: 1 }],
    };
    const confirm = (who: Who, body: object) =>
      req(who, 'POST', '/api/siap/contatti/conferma', { ...base, ...body });
    // Il titolare non ha atti validi con il secondo paziente quel giorno.
    expect((await confirm('titolare', {})).statusCode).toBe(409);
    const bad = [
      { prestazioni: [{ tipologia: 14, dettaglio: 1, quantita: 1 }] },
      { prestazioni: [{ tipologia: 9, dettaglio: 7, quantita: 1 }] },
      {
        prestazioni: [
          { tipologia: 1, dettaglio: 2, quantita: 1 },
          { tipologia: 1, dettaglio: 2, quantita: 2 },
        ],
      },
      { prestazioni: [{ tipologia: 1, dettaglio: 2, quantita: 10 }] },
      { prestazioni: [] },
      {
        prestazioni: Array.from({ length: 16 }, (_, i) => ({
          tipologia: 5,
          dettaglio: i + 1,
          quantita: 1,
        })),
      },
      { modalita: 'altrove' },
      { problema: (await t.db.select().from(problemDetail))[0]!.entryId },
    ];
    for (const b of bad)
      expect((await confirm('sostituto', b)).statusCode, JSON.stringify(b)).toBe(400);
    expect(await t.db.select().from(siapContact).where(eq(siapContact.patientId, second))).toEqual(
      [],
    );
  });

  it('scarto con il motivo, poi la conferma di nuovo: il progressivo libero si riprende', async () => {
    // Il sostituto ha la sua nota con il secondo paziente: conferma, scarta, riconferma.
    const body = {
      paziente: second,
      giorno: DAY,
      modalita: 'remote',
      accesso: 'direct',
      problema: null,
      prestazioni: [{ tipologia: 1, dettaglio: 4, quantita: 1 }],
    };
    const first = await req('sostituto', 'POST', '/api/siap/contatti/conferma', body);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ progressivo: 2 });
    const empty = await req('sostituto', 'POST', '/api/siap/contatti/scarta', {
      paziente: second,
      giorno: DAY,
      motivo: '  ',
    });
    expect(empty.statusCode).toBe(400);
    const discard = await req('sostituto', 'POST', '/api/siap/contatti/scarta', {
      paziente: second,
      giorno: DAY,
      motivo: 'Stesso episodio del giorno prima',
    });
    expect(discard.statusCode, discard.body).toBe(200);
    const c = (await list('sostituto')).contatti[0]!;
    expect(c).toMatchObject({ stato: 'scartato' });
    expect(c.contatto).toMatchObject({
      progressivo: null,
      motivoScarto: 'Stesso episodio del giorno prima',
    });
    const twice = await req('sostituto', 'POST', '/api/siap/contatti/scarta', {
      paziente: second,
      giorno: DAY,
      motivo: 'Ancora',
    });
    expect(twice.statusCode).toBe(409);
    const back = await req('sostituto', 'POST', '/api/siap/contatti/conferma', body);
    expect(back.statusCode, back.body).toBe(201);
    expect(back.json()).toMatchObject({ progressivo: 2 });
    // Un contatto si scarta senza averlo confermato: il proposto del giorno prima.
    const old = await list('titolare', '2026-11-10', '2026-11-10');
    expect(old.contatti.map((x) => [x.stato, x.proposta.modalita])).toEqual([
      ['proposto', 'office'],
    ]);
    expect(old.contatti[0]!.proposta.prestazioni).toEqual([
      { tipologia: 1, dettaglio: 2, quantita: 1 },
      { tipologia: 1, dettaglio: 4, quantita: 1 },
    ]);
    const skip = await req('titolare', 'POST', '/api/siap/contatti/scarta', {
      paziente: rich,
      giorno: '2026-11-10',
      motivo: 'Note di prova',
    });
    expect(skip.statusCode, skip.body).toBe(200);
    const [row] = await t.db
      .select()
      .from(siapContact)
      .where(and(eq(siapContact.patientId, rich), eq(siapContact.occurredOn, '2026-11-10')));
    expect(row).toMatchObject({ status: 'discarded', daySequence: null });
  });

  it('due conferme insieme prendono progressivi diversi', async () => {
    const pts = (
      await t.db.select().from(patient).where(eq(patient.archiveId, s.archives.titolare))
    )
      .map((p) => p.id)
      .filter((id) => id !== rich && id !== second)
      .slice(0, 2);
    for (const p of pts) await diary(p, s.users.titolare.id, 'office');
    const results = await Promise.all(
      pts.map((p) =>
        req('titolare', 'POST', '/api/siap/contatti/conferma', {
          paziente: p,
          giorno: DAY,
          modalita: 'office',
          accesso: 'direct',
          problema: null,
          prestazioni: [{ tipologia: 1, dettaglio: 2, quantita: 1 }],
        }),
      ),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    expect(results.map((r) => r.json<{ progressivo: number }>().progressivo).sort()).toEqual([
      3, 4,
    ]);
  });

  it('il database: un contatto non si cancella, e uno confermato ha il progressivo e i campi', async () => {
    const reject = async (q: PromiseLike<unknown>) => {
      try {
        await q;
        return null;
      } catch (e) {
        const err = e as { message?: string; cause?: { message?: string; constraint?: string } };
        return err.cause?.constraint ?? err.cause?.message ?? err.message ?? 'errore';
      }
    };
    expect(await reject(t.db.delete(siapContact).where(eq(siapContact.id, contactId)))).toMatch(
      /non si cancellano/,
    );
    expect(
      await reject(
        t.db.update(siapContact).set({ daySequence: null }).where(eq(siapContact.id, contactId)),
      ),
    ).toBe('siap_contact_decided');
    // Uno scartato ha il motivo: vuoto o assente, no.
    const [discarded] = await t.db
      .select()
      .from(siapContact)
      .where(eq(siapContact.status, 'discarded'));
    for (const discardReason of [null, '   '])
      expect(
        await reject(
          t.db.update(siapContact).set({ discardReason }).where(eq(siapContact.id, discarded!.id)),
        ),
        String(discardReason),
      ).toBe('siap_contact_decided');
    expect(
      await reject(
        t.db
          .update(siapContactService)
          .set({ quantity: 10 })
          .where(eq(siapContactService.contactId, contactId)),
      ),
    ).toBe('siap_contact_service_quantity');
    const history = await t.db.execute<{ n: string }>(
      sql`select count(*)::text as n from change_history where table_name = 'siap_contact' and row_id = ${contactId}`,
    );
    expect(Number(history.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});
