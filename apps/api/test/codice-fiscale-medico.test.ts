import { buildFiscalCode } from '@mmg/domain';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FISCAL_CODE_PENDING_NOTICE } from '../src/admin/user-service';
import { accessLog, doctorProfile } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Codice fiscale del medico corretto dall'amministratore (D181, problema 12): resta in sospeso,
 * e vale quello di prima, finché il medico non lo conferma dal programma. Medici inventati.
 */
describe('codice fiscale del medico corretto dall’amministratore (tappa 16)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { idleLockMinutes: null });
    for (const who of ['amministratore', 'collega', 'sostituto', 'segreteria'] as const)
      cookies[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const cf = (surname: string, name: string, birthDate: string) =>
    buildFiscalCode({ surname, name, birthDate, sex: 'M', placeCode: 'X101' });
  const profile = async (userId: string) =>
    (await t.db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId)))[0]!;
  const lastAdminEntry = async () => {
    const rows = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.action, 'amministrazione')))
      .orderBy(asc(accessLog.seq));
    const r = rows.at(-1)!;
    return { userId: r.userId, outcome: r.outcome, ...(r.details as Record<string, unknown>) };
  };
  /** L'amministratore corregge il codice fiscale, con gli altri dati del medico com'erano. */
  async function propose(userId: string, codiceFiscale: string) {
    const p = await profile(userId);
    return req(cookies.amministratore!, 'PATCH', `/api/studio/utenti/${userId}`, {
      medico: {
        codiceFiscale,
        // I medici dello scenario non hanno nome e cognome separati: se ne danno di inventati.
        nome: p.firstName ?? 'Paolo',
        cognome: p.lastName ?? 'Prova',
        codiceRegionale: p.regionalCode ?? '',
        asl: p.asl ?? '',
      },
    });
  }
  const decide = (who: string, what: 'conferma' | 'rifiuta', proposto: string) =>
    req(cookies[who]!, 'POST', `/api/profilo/codice-fiscale/${what}`, { proposto });

  it('in sospeso: vale il codice di prima; l’amministratore lo vede, il medico lo conferma lui', async () => {
    const doctor = s.users.collega;
    const before = (await profile(doctor.id)).fiscalCode;
    const corrected = cf('Serra', 'Paolo', '1971-02-02');
    const r = await propose(doctor.id, corrected);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().avvisi).toEqual([FISCAL_CODE_PENDING_NOTICE]);
    expect(r.json().utente.medico).toMatchObject({
      codiceFiscale: before,
      correzioneCodiceFiscale: { proposto: corrected, da: 'Andrea Conti' },
    });
    // Nel database, e quindi per promemoria, SAR e Sistema TS, resta il codice di prima.
    expect(await profile(doctor.id)).toMatchObject({
      fiscalCode: before,
      pendingFiscalCode: corrected,
      pendingFiscalCodeBy: s.users.amministratore.id,
    });
    // La segreteria, o un altro medico, non decide per lui: ognuno decide solo la sua.
    expect((await decide('segreteria', 'conferma', corrected)).statusCode).toBe(403);
    expect((await decide('sostituto', 'conferma', corrected)).json().errore).toBe(
      'Nessuna correzione del codice fiscale da confermare',
    );
    expect((await profile(doctor.id)).fiscalCode).toBe(before);
    // Lo stesso codice di prima, rimandato con un'altra modifica, non ritira la correzione.
    const again = await propose(doctor.id, before!);
    expect(again.statusCode).toBe(400);
    expect((await profile(doctor.id)).pendingFiscalCode).toBe(corrected);

    const ok = await decide('collega', 'conferma', corrected);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await profile(doctor.id)).toMatchObject({
      fiscalCode: corrected,
      pendingFiscalCode: null,
      pendingFiscalCodeBy: null,
      pendingFiscalCodeAt: null,
    });
    expect((await req(cookies.collega!, 'GET', '/api/io')).json().codiceFiscaleDaConfermare).toBe(
      false,
    );
  });

  it('il medico la rifiuta: resta il codice di prima, e il registro lo dice', async () => {
    const doctor = s.users.collega;
    const before = (await profile(doctor.id)).fiscalCode!;
    const wrong = cf('Errato', 'Paolo', '1971-02-03');
    expect((await propose(doctor.id, wrong)).statusCode).toBe(200);
    const no = await decide('collega', 'rifiuta', wrong);
    expect(no.statusCode, no.body).toBe(200);
    expect(no.json().avvisi[0]).toMatch(/^Correzione rifiutata: resta il codice fiscale di prima/);
    expect(await profile(doctor.id)).toMatchObject({ fiscalCode: before, pendingFiscalCode: null });
    expect(await lastAdminEntry()).toMatchObject({
      userId: doctor.id,
      outcome: 'riuscito',
      area: 'profilo',
      azione: 'rifiuto_codice_fiscale',
      utente: doctor.username,
      campi: ['medico.codiceFiscale'],
      propostaDa: s.users.amministratore.username,
    });
    // Nel registro i nomi dei campi, mai i valori.
    expect(JSON.stringify(await lastAdminEntry())).not.toContain(wrong);
  });

  it('si decide su quella che si ha davanti: cambiata o ritirata nel frattempo, no', async () => {
    const doctor = s.users.collega;
    const first = cf('Primo', 'Paolo', '1971-02-04');
    const second = cf('Secondo', 'Paolo', '1971-02-05');
    expect((await propose(doctor.id, first)).statusCode).toBe(200);
    expect((await propose(doctor.id, second)).statusCode).toBe(200);
    const stale = await decide('collega', 'conferma', first);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errore).toBe('La correzione è cambiata nel frattempo: rileggi la pagina');
    expect((await profile(doctor.id)).pendingFiscalCode).toBe(second);
    // L'amministratore la ritira: il medico non ha più niente da confermare.
    const withdrawn = await req(
      cookies.amministratore!,
      'POST',
      `/api/studio/utenti/${doctor.id}/codice-fiscale/ritira`,
    );
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json().utente.medico.correzioneCodiceFiscale).toBeNull();
    expect(await lastAdminEntry()).toMatchObject({
      userId: s.users.amministratore.id,
      azione: 'ritiro_codice_fiscale',
      utente: doctor.username,
    });
    expect((await decide('collega', 'conferma', second)).json().errore).toBe(
      'Nessuna correzione del codice fiscale da confermare',
    );
    const twice = await req(
      cookies.amministratore!,
      'POST',
      `/api/studio/utenti/${doctor.id}/codice-fiscale/ritira`,
    );
    expect(twice.statusCode).toBe(409);
    // Solo l'amministratore ritira.
    expect(
      (await req(cookies.collega!, 'POST', `/api/studio/utenti/${doctor.id}/codice-fiscale/ritira`))
        .statusCode,
    ).toBe(403);
  });

  it('un codice proposto per un medico non si dà a un altro; alla conferma si ricontrolla', async () => {
    const a = s.users.collega;
    const b = s.users.sostituto;
    const shared = cf('Comune', 'Paolo', '1971-02-06');
    expect((await propose(a.id, shared)).statusCode).toBe(200);
    const taken = await propose(b.id, shared);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().errore).toBe('Codice fiscale già di un altro utente dello studio');
    // Dati di prima, scritti senza il programma: un altro medico ha già quel codice.
    await t.db
      .update(doctorProfile)
      .set({ fiscalCode: shared })
      .where(eq(doctorProfile.userId, b.id));
    const clash = await decide('collega', 'conferma', shared);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().errore).toMatch(/^Codice fiscale già di un altro utente dello studio/);
    expect((await profile(a.id)).pendingFiscalCode).toBe(shared);
  });
});
