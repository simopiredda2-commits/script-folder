import { buildFiscalCode } from '@mmg/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, allergyDetail, clinicalEntry, doctorProfile, patient } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message: string; cause?: { message: string } };
    expect(e.cause?.message ?? e.message).toMatch(pattern);
    return;
  }
  throw new Error(`Doveva fallire con ${pattern}`);
}

/**
 * Condivisione tra i medici dell'AFT (tappa 12, D161): due studi diversi, ognuno con i suoi
 * titolari. Pazienti e medici inventati.
 */
describe('condivisione tra i medici dell’AFT (D161)', () => {
  let t: TestDatabase;
  let a: Scenario;
  let b: Scenario;
  const cookies: Record<string, string> = {};
  let aftId = '';
  let cf = '';

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createScenario(t.db, { name: 'Studio A di prova' });
    b = await createScenario(t.db, { name: 'Studio B di prova' });
    // Codici regionali distinti nel secondo studio (lo scenario usa sempre gli stessi).
    await t.db
      .update(doctorProfile)
      .set({ regionalCode: 'MMG-PROVA-B1' })
      .where(eq(doctorProfile.userId, b.users.titolare.id));
    await t.db
      .update(doctorProfile)
      .set({ regionalCode: 'MMG-PROVA-B2' })
      .where(eq(doctorProfile.userId, b.users.collega.id));
    cookies.aTitolare = await login(a, 'titolare');
    cookies.aSegreteria = await login(a, 'segreteria');
    cookies.bTitolare = await login(b, 'titolare');
    cookies.bCollega = await login(b, 'collega');
    const [p] = await t.db.select().from(patient).where(eq(patient.id, a.richPatient));
    cf = p!.fiscalCode;
    // Una voce oscurata su richiesta del paziente: non va mai ai colleghi (D116).
    await withActor(t.db, a.users.titolare.id, async (tx) => {
      const [e] = await tx
        .insert(clinicalEntry)
        .values({
          patientId: a.richPatient,
          kind: 'allergy',
          occurredOn: '2026-11-11',
          authorUserId: a.users.titolare.id,
          obscured: true,
        })
        .returning();
      await tx
        .insert(allergyDetail)
        .values({ entryId: e!.id, substance: 'Sostanza oscurata di prova', drugRelated: false });
    });
  });
  afterAll(async () => {
    await a?.app.close();
    await b?.app.close();
    await t?.drop();
  });

  const req = (
    s: Scenario,
    cookie: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie }, payload });
  const consult = (motivo = 'Visita nell’ambulatorio serale dell’AFT') =>
    req(b, cookies.bTitolare!, 'POST', '/api/aft/consultazione', { codiceFiscale: cf, motivo });
  const lastLog = async () =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(
          and(eq(accessLog.patientId, a.richPatient), eq(accessLog.action, 'consultazione_aft')),
        )
    ).at(-1);

  it('un titolare crea l’AFT e invita un medico di un altro studio: entra solo se accetta', async () => {
    expect(
      (await req(a, cookies.aSegreteria!, 'POST', '/api/aft', { nome: 'AFT di prova' })).statusCode,
    ).toBe(403);
    const created = await req(a, cookies.aTitolare!, 'POST', '/api/aft', { nome: 'AFT di prova' });
    expect(created.statusCode, created.body).toBe(201);
    aftId = created.json<{ id: string }>().id;
    // Una sola AFT per medico.
    expect(
      (await req(a, cookies.aTitolare!, 'POST', '/api/aft', { nome: 'Altra AFT' })).statusCode,
    ).toBe(409);
    expect(
      (
        await req(a, cookies.aTitolare!, 'POST', `/api/aft/${aftId}/inviti`, {
          codiceRegionale: 'NON-ESISTE',
        })
      ).statusCode,
    ).toBe(404);
    const invited = await req(a, cookies.aTitolare!, 'POST', `/api/aft/${aftId}/inviti`, {
      codiceRegionale: 'MMG-PROVA-B1',
    });
    expect(invited.statusCode, invited.body).toBe(201);
    // Chi non è membro non invita.
    expect(
      (
        await req(b, cookies.bCollega!, 'POST', `/api/aft/${aftId}/inviti`, {
          codiceRegionale: 'MMG-PROVA-B2',
        })
      ).statusCode,
    ).toBe(403);
    // Invito in attesa: non è ancora membro, e non consulta.
    const pending = (await req(b, cookies.bTitolare!, 'GET', '/api/aft')).json<{
      aft: unknown;
      inviti: { id: string; aft: string }[];
    }>();
    expect(pending.aft).toBeNull();
    expect(pending.inviti).toEqual([expect.objectContaining({ aft: 'AFT di prova' })]);
    expect((await consult()).statusCode).toBe(403);
    const accepted = await req(
      b,
      cookies.bTitolare!,
      'POST',
      `/api/aft/inviti/${pending.inviti[0]!.id}/accetta`,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    const view = (await req(a, cookies.aTitolare!, 'GET', '/api/aft')).json<{
      aft: { membri: { nome: string; studio: string; stato: string; condivide: boolean }[] };
    }>();
    // Gli scenari danno lo stesso nome ai titolari dei due studi: li distingue lo studio.
    expect(view.aft.membri.map((m) => [m.studio, m.stato, m.condivide]).sort()).toEqual([
      ['Studio A di prova', 'membro', false],
      ['Studio B di prova', 'membro', false],
    ]);
  });

  it('un titolare mai confermato di un altro studio, con lo stesso codice regionale, non blocca l’invito e non lo riceve (terza revisione)', async () => {
    // L'amministratore dello studio A crea un titolare con il codice regionale della collega del
    // secondo studio: resta in attesa di conferma (D179).
    const admin = await login(a, 'amministratore');
    // L'accesso fa avanzare l'orologio del primo studio: il secondo si rimette pari, perché le
    // prove dopo confrontano gli istanti dei due studi (uscita dall'AFT).
    const lag = a.clock.now().getTime() - b.clock.now().getTime();
    if (lag > 0) b.clock.advance(lag);
    const fake = await req(a, admin, 'POST', '/api/studio/utenti', {
      nomeUtente: 'titolare.finto.aft',
      nome: 'Dott. Finto',
      ruoli: ['owner_doctor'],
      medico: {
        // Codice fiscale inventato: luogo di nascita con la X, che nessun comune ha (D12).
        codiceFiscale: buildFiscalCode({
          surname: 'Finto',
          name: 'Marco',
          birthDate: '1970-01-01',
          sex: 'M',
          placeCode: 'X001',
        }),
        nome: 'Marco',
        cognome: 'Finto',
        codiceRegionale: 'MMG-PROVA-B2',
      },
    });
    expect(fake.statusCode, fake.body).toBe(201);
    expect(fake.json<{ utente: { inAttesaDiConferma: boolean } }>().utente.inAttesaDiConferma).toBe(
      true,
    );
    // L'invito va alla collega vera.
    const invited = await req(a, cookies.aTitolare!, 'POST', `/api/aft/${aftId}/inviti`, {
      codiceRegionale: 'MMG-PROVA-B2',
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const pending = (await req(b, cookies.bCollega!, 'GET', '/api/aft')).json<{
      inviti: { id: string; aft: string }[];
    }>();
    expect(pending.inviti).toEqual([expect.objectContaining({ aft: 'AFT di prova' })]);
    // La collega rifiuta: le prove dopo partono come prima.
    const refused = await req(
      b,
      cookies.bCollega!,
      'POST',
      `/api/aft/inviti/${pending.inviti[0]!.id}/rifiuta`,
    );
    expect(refused.statusCode, refused.body).toBe(200);
  });

  it('senza condivisione o senza consenso non si vede nulla, e il tentativo va nel registro', async () => {
    // Il medico curante non condivide ancora.
    const notSharing = await consult();
    expect(notSharing.statusCode).toBe(404);
    expect(notSharing.json<{ errore: string }>().errore).toMatch(/Nessun riepilogo condiviso/);
    expect(await lastLog()).toMatchObject({
      studioId: a.studioId,
      userId: b.users.titolare.id,
      outcome: 'negato',
      details: expect.objectContaining({
        regola: 'Il medico curante non condivide i suoi pazienti nell’AFT',
        motivoDellAccesso: 'Visita nell’ambulatorio serale dell’AFT',
        studio: 'Studio B di prova',
      }),
    });
    expect(
      (
        await req(a, cookies.aTitolare!, 'POST', `/api/aft/${aftId}/condivisione`, {
          condivide: true,
        })
      ).statusCode,
    ).toBe(200);
    // Condivide, ma il paziente non ha dato il consenso: la stessa risposta per chi consulta.
    const noConsent = await consult();
    expect(noConsent.statusCode).toBe(404);
    expect(await lastLog()).toMatchObject({
      outcome: 'negato',
      details: expect.objectContaining({
        regola: 'Il paziente non ha dato il consenso alla condivisione nell’AFT',
      }),
    });
  });

  it('con il consenso il collega vede il riepilogo, senza voci riservate e oscurate', async () => {
    const given = await req(
      a,
      cookies.aSegreteria!,
      'POST',
      `/api/pazienti/${a.richPatient}/consensi`,
      {
        tipo: 'aft_condivisione',
        stato: 'dato',
        data: '2026-11-18',
      },
    );
    expect(given.statusCode, given.body).toBe(201);
    // Il motivo dell'accesso serve.
    expect((await consult('visita')).statusCode).toBe(400);
    // Senza il consenso per il pregresso, solo le voci dal giorno del consenso (Garante, par. 3):
    // le voci del paziente di prova sono tutte precedenti.
    const onlyNew = await consult();
    expect(onlyNew.statusCode, onlyNew.body).toBe(200);
    expect(onlyNew.json<{ soloDal: string; riepilogo: Record<string, string[]> }>()).toMatchObject({
      soloDal: '2026-11-18',
      riepilogo: { allergie: [], problemi: [], terapie: [], parametri: [] },
    });
    const previous = await req(
      a,
      cookies.aSegreteria!,
      'POST',
      `/api/pazienti/${a.richPatient}/consensi`,
      { tipo: 'aft_condivisione_pregressi', stato: 'dato', data: '2026-11-18' },
    );
    expect(previous.statusCode, previous.body).toBe(201);
    const res = await consult();
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      medicoCurante: string;
      riepilogo: Record<string, string[]>;
    }>();
    expect(body.medicoCurante).toBe('Dott.ssa Elena Marchi');
    const all = JSON.stringify(body.riepilogo);
    expect(all).toContain('Sostanza di prova');
    expect(all).toContain('Problema di prova');
    expect(all).toContain('Farmaco di prova 5 mg');
    expect(all).not.toContain('Sostanza oscurata di prova');
    expect(all).not.toContain('Farmaco riservato di prova');
    // Nemmeno un indizio che qualcosa è oscurato o riservato.
    expect(res.body).not.toMatch(/oscurat|riservat|esclus/i);
    expect(await lastLog()).toMatchObject({ outcome: 'consentito', studioId: a.studioId });
    // Il medico curante vede chi ha consultato, da quale studio, perché e con quale esito.
    const seen = (await req(a, cookies.aTitolare!, 'GET', '/api/aft/consultazioni')).json<{
      consultazioni: { medico: string; studio: string; motivo: string; esito: string }[];
    }>();
    expect(seen.consultazioni[0]).toMatchObject({
      medico: 'Dott.ssa Elena Marchi',
      esito: 'consentito',
      studio: 'Studio B di prova',
      motivo: 'Visita nell’ambulatorio serale dell’AFT',
    });
    expect(seen.consultazioni.map((c) => c.esito)).toEqual([
      'consentito',
      'consentito',
      'negato',
      'negato',
    ]);
  });

  it('il collega registra l’attività svolta: registro di AFT e cronologia del medico curante', async () => {
    const activity = (body: object) =>
      req(b, cookies.bTitolare!, 'POST', '/api/aft/attivita', { codiceFiscale: cf, ...body });
    // Non nel futuro.
    expect(
      (
        await activity({
          tipologia: 'ambulatorio',
          esito: 'Visita di prova',
          quando: '2099-01-01T10:00:00+01:00',
        })
      ).statusCode,
    ).toBe(400);
    const done = await activity({
      tipologia: 'ambulatorio',
      esito: 'Controllo pressorio di prova nella norma',
      note: 'Nota di prova per il medico curante',
    });
    expect(done.statusCode, done.body).toBe(201);
    // Il medico curante la vede tra le attività dei colleghi e nella cronologia della cartella.
    const list = (await req(a, cookies.aTitolare!, 'GET', '/api/aft/attivita')).json<{
      attivita: { tipologia: string; esito: string; medico: string }[];
    }>();
    expect(list.attivita[0]).toMatchObject({
      tipologia: 'Visita in ambulatorio',
      esito: 'Controllo pressorio di prova nella norma',
    });
    const timeline = (
      await req(a, cookies.aTitolare!, 'GET', `/api/pazienti/${a.richPatient}/cronologia`)
    ).json<{ cronologia: { tipo: string; titolo: string; testo: string }[] }>();
    expect(timeline.cronologia.find((x) => x.tipo === 'aft_activity')).toMatchObject({
      titolo: 'Collega dell’AFT: Visita in ambulatorio',
      testo: 'Controllo pressorio di prova nella norma. Nota di prova per il medico curante',
    });
    // Il registro di AFT non si modifica.
    await rejectsWith(
      t.db.execute(sql`update aft_activity set outcome = 'altro'`),
      /registro di AFT non si modifica/,
    );
    await rejectsWith(
      t.db.execute(sql`delete from aft_activity`),
      /registro di AFT non si modifica/,
    );
    // Chi ha visto o annotato i dati del paziente: per rispondere alla sua richiesta.
    const own = await req(
      a,
      cookies.aTitolare!,
      'GET',
      `/api/pazienti/${a.richPatient}/consultazioni-aft`,
    );
    expect(own.statusCode, own.body).toBe(200);
    expect(
      own.json<{ consultazioni: { azione: string; studio: string }[] }>().consultazioni[0],
    ).toMatchObject({ azione: 'Attività registrata', studio: 'Studio B di prova' });
    // La segreteria no: il registro lo legge il titolare.
    expect(
      (
        await req(
          a,
          cookies.aSegreteria!,
          'GET',
          `/api/pazienti/${a.richPatient}/consultazioni-aft`,
        )
      ).statusCode,
    ).toBe(403);
  });

  it('chi non è nell’AFT, la revoca del consenso e l’uscita chiudono l’accesso', async () => {
    // Un medico dello studio B non invitato.
    expect(
      (
        await req(b, cookies.bCollega!, 'POST', '/api/aft/consultazione', {
          codiceFiscale: cf,
          motivo: 'Visita nell’ambulatorio serale dell’AFT',
        })
      ).statusCode,
    ).toBe(403);
    const privacy = (
      await req(a, cookies.aTitolare!, 'GET', `/api/pazienti/${a.richPatient}/privacy`)
    ).json<{ consensi: { id: string; tipo: string; inVigore: boolean }[] }>();
    const current = privacy.consensi.find((c) => c.tipo === 'aft_condivisione' && c.inVigore)!;
    const revoked = await req(
      a,
      cookies.aTitolare!,
      'POST',
      `/api/pazienti/${a.richPatient}/consensi/${current.id}/revoca`,
      { data: '2026-11-19' },
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await consult()).statusCode).toBe(404);
    expect((await lastLog())!.details).toMatchObject({
      regola: 'Il paziente ha revocato il consenso alla condivisione nell’AFT',
    });
    // Senza consenso non si registra nemmeno l'attività svolta.
    expect(
      (
        await req(b, cookies.bTitolare!, 'POST', '/api/aft/attivita', {
          codiceFiscale: cf,
          tipologia: 'telefono',
          esito: 'Contatto telefonico di prova',
        })
      ).statusCode,
    ).toBe(404);
    await req(a, cookies.aTitolare!, 'POST', `/api/pazienti/${a.richPatient}/consensi`, {
      tipo: 'aft_condivisione',
      stato: 'dato',
      data: '2026-11-19',
    });
    expect((await consult()).statusCode).toBe(200);
    // Il medico curante esce dall'AFT: la condivisione finisce subito.
    expect((await req(a, cookies.aTitolare!, 'POST', `/api/aft/${aftId}/esci`)).statusCode).toBe(
      200,
    );
    expect((await consult()).statusCode).toBe(404);
    expect((await lastLog())!.details).toMatchObject({
      regola: 'Il medico curante non è nella tua AFT, o non lo sei tu',
    });
  });
});
