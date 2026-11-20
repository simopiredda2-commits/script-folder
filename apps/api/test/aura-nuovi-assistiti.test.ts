import { generatePatients } from '@mmg/fixtures';
import { EMPTY_AURA_REGISTRY, SimulatedAura, type AuraChoice } from '@mmg/integrations';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  accessLog,
  appUser,
  auraLink,
  auraNewPatient,
  doctorProfile,
  exemption,
  patient,
  patientChoice,
} from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { ReferenceData } from '../src/reference/lookup';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface NewOne {
  id: string;
  cognome: string;
  nome: string;
  nascita: string;
  codiceFiscale: string;
  medico: string;
  sceltaDal: string;
  scadenza: string | null;
}

/**
 * Risposta della fermata dopo l'unione della #12 (D199): chi sceglie un medico dello studio e non è
 * ancora nel suo archivio compare fra i nuovi assistiti nella pagina Oggi, e medico o segreteria lo
 * registrano con un clic dai dati di AURA, o scelgono di non registrarlo.
 */
describe('AURA: nuovi assistiti (D199)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<'titolare' | 'collega' | 'segreteria', string> = {
    titolare: '',
    collega: '',
    segreteria: '',
  };
  let ownerCf: string;
  let colleagueCf: string;
  const aura = new SimulatedAura();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    for (const who of ['titolare', 'collega', 'segreteria'] as const)
      cookies[who] = await login(s, who);
    const cf = async (userId: string) =>
      (
        await t.db
          .select({ cf: doctorProfile.fiscalCode })
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, userId))
      )[0]!.cf!;
    ownerCf = await cf(s.users.titolare.id);
    colleagueCf = await cf(s.users.collega.id);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  type Who = keyof typeof cookies;
  const post = (url: string, who: Who = 'titolare', payload?: object) =>
    s.app.inject({
      method: 'POST',
      url,
      headers: { cookie: cookies[who] },
      ...(payload ? { payload } : {}),
    });
  const list = async (who: Who = 'titolare') => {
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/aura/nuovi',
      headers: { cookie: cookies[who] },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ nuovi: NewOne[] }>().nuovi;
  };
  const today = () => studioDate(s.clock.now());
  const day = (n: number) => studioDate(new Date(s.clock.now().getTime() + n * 86_400_000));
  /** Le notifiche arrivano senza aspettare la risposta: si aspetta che siano applicate. */
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('La notifica di AURA non è arrivata');
  }
  const rowsOf = (auraId: string) =>
    t.db.select().from(auraNewPatient).where(eq(auraNewPatient.auraId, auraId));
  const choice = (doctorFiscalCode: string, over: Partial<AuraChoice> = {}): AuraChoice => ({
    doctorFiscalCode,
    chosenOn: today(),
    expiresOn: null,
    endedOn: null,
    endReason: null,
    ...over,
  });

  /** Un assistito inventato in AURA, senza scelte: la scelta la manda poi l'ASL (notifica). */
  function person(seed: string) {
    const [p] = generatePatients({ seed: `nuovi-assistiti-${seed}`, count: 1, minAge: 18 });
    const auraId = aura.register({
      fiscalCode: p!.fiscalCode,
      lastName: p!.lastName.toUpperCase(),
      firstName: p!.firstName.toUpperCase(),
      birthDate: p!.birthDate,
      exemptions: [{ code: '013', prescriptionCode: null, validFrom: '2025-01-01', validTo: null }],
      choices: [],
      registry: {
        ...EMPTY_AURA_REGISTRY,
        residenceStreet: 'VIA IMMAGINARIA',
        residenceNumber: '3',
        residencePostalCode: '00000',
        residenceTown: 'COMUNE IMMAGINARIO',
        residenceProvince: 'XX',
        domicile: null,
        asl: 'ASL DI PROVA',
        district: null,
      },
    });
    return { p: p!, auraId };
  }
  /** Sceglie il medico in AURA e aspetta il nuovo assistito nell'elenco. */
  async function chooses(seed: string, c: (cf: string) => AuraChoice = (cf) => choice(cf)) {
    const who = person(seed);
    aura.setChoice(who.auraId, c(ownerCf));
    await until(async () => (await rowsOf(who.auraId)).length === 1);
    const [row] = await rowsOf(who.auraId);
    return { ...who, candidateId: row!.id };
  }

  it('una scelta nuova del titolare: fra i nuovi assistiti di chi scrive nel suo archivio, e la lettura resta nel registro', async () => {
    const { p, candidateId } = await chooses('a');
    const mine = (await list('titolare')).find((x) => x.id === candidateId);
    const [owner] = await t.db.select().from(appUser).where(eq(appUser.id, s.users.titolare.id));
    expect(mine).toMatchObject({
      cognome: p.lastName.toUpperCase(),
      nome: p.firstName.toUpperCase(),
      nascita: p.birthDate,
      codiceFiscale: p.fiscalCode,
      medico: owner!.displayName,
      sceltaDal: today(),
      scadenza: null,
    });
    // La segreteria scrive negli archivi di entrambi; il collega solo nel suo.
    expect((await list('segreteria')).map((x) => x.id)).toContain(candidateId);
    expect((await list('collega')).map((x) => x.id)).not.toContain(candidateId);
    const [log] = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.action, 'lettura_nuovi_assistiti_aura'),
          eq(accessLog.userId, s.users.titolare.id),
        ),
      )
      .orderBy(desc(accessLog.seq))
      .limit(1);
    expect((log!.details as { nuoviAssistiti: string[] }).nuoviAssistiti).toContain(candidateId);
  });

  it('«Registra»: nell’archivio del medico con i dati di AURA, collegato, con esenzione e scelta di AURA', async () => {
    const { p, auraId, candidateId } = await chooses('b');
    const res = await post(`/api/aura/nuovi/${candidateId}/registra`, 'segreteria');
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ aura: { esito: 'aggiornato' } });
    const id = res.json<{ id: string }>().id;
    const [row] = await t.db.select().from(patient).where(eq(patient.id, id));
    expect(row).toMatchObject({
      archiveId: s.archives.titolare,
      lastName: p.lastName.toUpperCase(),
      firstName: p.firstName.toUpperCase(),
      birthDate: p.birthDate,
      fiscalCode: p.fiscalCode,
      // Dal codice fiscale.
      sex: p.sex,
      birthPlaceCode: p.birthPlace.code,
      residenceStreet: 'VIA IMMAGINARIA',
      residencePostalCode: '00000',
      residenceTown: 'COMUNE IMMAGINARIO',
      residenceProvince: 'XX',
      asl: 'ASL DI PROVA',
      status: 'active',
    });
    const [link] = await t.db.select().from(auraLink).where(eq(auraLink.patientId, id));
    expect(link).toMatchObject({ auraId, outcome: 'aggiornato' });
    const ex = await t.db.select().from(exemption).where(eq(exemption.patientId, id));
    expect(ex.map((e) => [e.code, e.source])).toEqual([['013', 'aura']]);
    const ch = await t.db.select().from(patientChoice).where(eq(patientChoice.patientId, id));
    expect(ch.map((c) => [c.doctorUserId, c.source, c.expiresOn])).toEqual([
      [s.users.titolare.id, 'aura', null],
    ]);
    const [c] = await t.db.select().from(auraNewPatient).where(eq(auraNewPatient.id, candidateId));
    expect(c).toMatchObject({
      status: 'registrato',
      patientId: id,
      decidedBy: s.users.segreteria.id,
    });
    const [log] = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.patientId, id), eq(accessLog.action, 'nuovo_paziente')));
    expect(log).toMatchObject({ outcome: 'consentito', userId: s.users.segreteria.id });
    expect(log!.details).toMatchObject({ fonte: 'AURA', nuovoAssistito: candidateId });
    // Lo storico ha ogni cambio dell'assistito, e la riga non si cancella.
    const history = await t.db.execute<{ operation: string; status: string }>(sql`
      select operation, new_row ->> 'status' as status from change_history
      where table_name = 'aura_new_patient' and row_id = ${candidateId} order by id`);
    expect(history.rows.map((h) => [h.operation, h.status])).toEqual([
      ['INSERT', 'da_registrare'],
      ['UPDATE', 'registrato'],
    ]);
    await expect(
      t.db.delete(auraNewPatient).where(eq(auraNewPatient.id, candidateId)),
    ).rejects.toThrow();
    await expect(t.db.execute(sql`truncate aura_new_patient`)).rejects.toThrow();
    // «Registrato» vuol dire con il paziente: il database non accetta l'uno senza l'altro.
    await expect(
      t.db
        .update(auraNewPatient)
        .set({ patientId: null })
        .where(eq(auraNewPatient.id, candidateId)),
    ).rejects.toThrow();
    // Esce dall'elenco; un secondo clic lo dice.
    expect((await list('segreteria')).map((x) => x.id)).not.toContain(candidateId);
    const again = await post(`/api/aura/nuovi/${candidateId}/registra`, 'segreteria');
    expect(again.statusCode).toBe(409);
    expect(again.json().errore).toBe('Già registrato');
  });

  it('scelta temporanea in AURA: il paziente entra temporaneo, con la scelta e la scadenza di AURA', async () => {
    const until90 = day(90);
    const { candidateId } = await chooses('c', (cf) => choice(cf, { expiresOn: until90 }));
    expect((await list()).find((x) => x.id === candidateId)!.scadenza).toBe(until90);
    const res = await post(`/api/aura/nuovi/${candidateId}/registra`);
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    const [row] = await t.db.select().from(patient).where(eq(patient.id, id));
    expect(row!.status).toBe('temporary');
    const ch = await t.db.select().from(patientChoice).where(eq(patientChoice.patientId, id));
    // Una scelta sola, quella di AURA: nessuna copia a mano.
    expect(ch.map((c) => [c.source, c.chosenOn, c.expiresOn])).toEqual([
      ['aura', today(), until90],
    ]);
  });

  it('un dato di AURA che non passa i controlli del pannello resta fuori, e si vede come differenza', async () => {
    const who = person('l');
    aura.setRegistry(who.auraId, { residenceProvince: 'TORINO' });
    aura.setChoice(who.auraId, choice(ownerCf));
    await until(async () => (await rowsOf(who.auraId)).length === 1);
    const [row] = await rowsOf(who.auraId);
    const res = await post(`/api/aura/nuovi/${row!.id}/registra`);
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    const [p] = await t.db.select().from(patient).where(eq(patient.id, id));
    expect(p).toMatchObject({ residenceTown: 'COMUNE IMMAGINARIO', residenceProvince: null });
    const state = await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${id}/aura`,
      headers: { cookie: cookies.titolare },
    });
    expect(state.json<{ differenze: { campo: string; inAura: string }[] }>().differenze).toEqual([
      expect.objectContaining({ campo: 'residenzaProvincia', inAura: 'TORINO' }),
    ]);
  });

  it('«Non registrare»: esce dall’elenco e non torna con la stessa scelta; torna con una scelta nuova', async () => {
    const { auraId, candidateId } = await chooses('d');
    const res = await post(`/api/aura/nuovi/${candidateId}/non-registrare`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await list()).map((x) => x.id)).not.toContain(candidateId);
    const [log] = await t.db
      .select()
      .from(accessLog)
      .where(eq(accessLog.action, 'nuovo_assistito_non_registrato'))
      .orderBy(desc(accessLog.seq))
      .limit(1);
    expect(log).toMatchObject({ outcome: 'riuscito', userId: s.users.titolare.id });
    // AURA rimanda la stessa scelta (per esempio con l'anagrafica cambiata): resta fuori.
    aura.setRegistry(auraId, { residenceNumber: '5' });
    await until(async () => (await rowsOf(auraId))[0]!.registry?.residenceNumber === '5');
    expect((await rowsOf(auraId))[0]!.status).toBe('non_registrato');
    // Una scelta nuova, con un'altra data: si ripropone.
    aura.setChoice(auraId, choice(ownerCf, { chosenOn: day(1) }));
    await until(async () => (await rowsOf(auraId))[0]!.status === 'da_registrare');
    expect((await list()).map((x) => x.id)).toContain(candidateId);
    expect((await post(`/api/aura/nuovi/${candidateId}/non-registrare`)).statusCode).toBe(200);
    expect((await post(`/api/aura/nuovi/${candidateId}/non-registrare`)).statusCode).toBe(409);
  });

  it('la scelta cessata prima della registrazione, o il decesso, toglie l’assistito dall’elenco', async () => {
    const ended = await chooses('e');
    aura.setChoice(ended.auraId, choice(ownerCf, { endedOn: today(), endReason: 'revoca' }));
    await until(async () => (await rowsOf(ended.auraId))[0]!.status === 'superato');
    expect((await list()).map((x) => x.id)).not.toContain(ended.candidateId);
    const registerLate = await post(`/api/aura/nuovi/${ended.candidateId}/registra`);
    expect(registerLate.statusCode).toBe(409);
    expect(registerLate.json().errore).toMatch(/ricarica/);

    const died = await chooses('f');
    aura.setRegistry(died.auraId, { deceasedOn: day(-1) });
    await until(async () => (await rowsOf(died.auraId))[0]!.status === 'superato');
  });

  it('una scelta di un medico che non è dello studio non entra; quella del collega va nel suo archivio', async () => {
    const other = person('g');
    aura.setChoice(other.auraId, choice('MDCLTR70A01X000Z'));
    const colleague = person('h');
    aura.setChoice(colleague.auraId, choice(colleagueCf));
    await until(async () => (await rowsOf(colleague.auraId)).length === 1);
    expect(await rowsOf(other.auraId)).toEqual([]);
    const [row] = await rowsOf(colleague.auraId);
    expect(row).toMatchObject({ archiveId: s.archives.collega, doctorUserId: s.users.collega.id });
    expect((await list('collega')).map((x) => x.id)).toContain(row!.id);
    expect((await list('titolare')).map((x) => x.id)).not.toContain(row!.id);
  });

  it('se il paziente c’è già nello studio non entra fra i nuovi: si collega e si allinea', async () => {
    const existing = s.patients.titolare[1]!;
    const [p] = await t.db.select().from(patient).where(eq(patient.id, existing));
    const auraId = aura.register({
      fiscalCode: p!.fiscalCode,
      lastName: p!.lastName,
      firstName: p!.firstName,
      birthDate: p!.birthDate,
      exemptions: [],
      choices: [],
    });
    aura.setChoice(auraId, choice(ownerCf));
    await until(
      async () =>
        (await t.db.select().from(auraLink).where(eq(auraLink.patientId, existing)))[0]?.auraId ===
        auraId,
    );
    expect(await rowsOf(auraId)).toEqual([]);
  });

  it('permessi: il collega non registra né scarta nell’archivio del titolare (403, nel registro); un assistito che non c’è: 404', async () => {
    const { candidateId } = await chooses('i');
    const reg = await post(`/api/aura/nuovi/${candidateId}/registra`, 'collega');
    expect(reg.statusCode, reg.body).toBe(403);
    const skip = await post(`/api/aura/nuovi/${candidateId}/non-registrare`, 'collega');
    expect(skip.statusCode, skip.body).toBe(403);
    const denied = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, s.users.collega.id), eq(accessLog.outcome, 'negato')));
    expect(
      denied
        .filter((d) => (d.details as { nuovoAssistito?: string }).nuovoAssistito === candidateId)
        .map((d) => d.action),
    ).toEqual(expect.arrayContaining(['nuovo_paziente', 'nuovo_assistito_non_registrato']));
    expect(
      (
        await rowsOf(
          (await t.db.select().from(auraNewPatient).where(eq(auraNewPatient.id, candidateId)))[0]!
            .auraId,
        )
      )[0]!.status,
    ).toBe('da_registrare');
    const missing = await post(`/api/aura/nuovi/00000000-0000-4000-8000-000000000000/registra`);
    expect(missing.statusCode).toBe(404);
  });

  it('due «Registra» insieme: un paziente solo', async () => {
    const { p, candidateId } = await chooses('j');
    const both = await Promise.all([
      post(`/api/aura/nuovi/${candidateId}/registra`, 'titolare'),
      post(`/api/aura/nuovi/${candidateId}/registra`, 'segreteria'),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const rows = await t.db.select().from(patient).where(eq(patient.fiscalCode, p.fiscalCode));
    expect(rows).toHaveLength(1);
    // Chi arriva secondo non passa dalla registrazione: il blocco lo ferma prima.
    const loser = both.find((r) => r.statusCode === 409)!;
    expect(['Già registrato', 'Registrazione già in corso: ricarica la pagina tra poco']).toContain(
      loser.json().errore,
    );
  });

  it('registrato a mano nel frattempo: «Registra» lo dice con il paziente, e l’assistito esce dall’elenco', async () => {
    const { p, candidateId } = await chooses('k');
    const manual = await post('/api/pazienti', 'titolare', {
      identita: {
        cognome: p.lastName,
        nome: p.firstName,
        sesso: p.sex,
        nascita: p.birthDate,
        luogoNascitaCodice: p.birthPlace.code,
        codiceFiscale: p.fiscalCode,
      },
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const res = await post(`/api/aura/nuovi/${candidateId}/registra`);
    expect(res.statusCode).toBe(409);
    expect(res.json().dettagli.paziente.id).toBe(manual.json().id);
    const [c] = await t.db.select().from(auraNewPatient).where(eq(auraNewPatient.id, candidateId));
    expect(c!.status).toBe('superato');
    // Il tentativo resta nel registro di quel paziente, anche se la transazione è tornata indietro.
    const tried = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, manual.json().id as string),
          eq(accessLog.action, 'nuovo_paziente'),
          eq(accessLog.outcome, 'negato'),
        ),
      );
    expect(tried.map((r) => (r.details as { motivo?: string }).motivo)).toEqual([
      'codice fiscale già registrato per questo paziente',
    ]);
  });

  it('AURA cambia il codice fiscale mentre si registra (D226): 409, si ricarica, e nessun paziente', async () => {
    const { p, candidateId } = await chooses('n');
    const changed = `${p.fiscalCode.slice(0, -1)}${p.fiscalCode.endsWith('A') ? 'B' : 'A'}`;
    // Il comune di nascita si cerca prima della transazione: in quel momento AURA corregge il codice.
    const lookup = vi
      .spyOn(ReferenceData.prototype, 'municipality')
      .mockImplementationOnce(async () => {
        await t.db
          .update(auraNewPatient)
          .set({ fiscalCode: changed })
          .where(eq(auraNewPatient.id, candidateId));
        return null;
      });
    try {
      const res = await post(`/api/aura/nuovi/${candidateId}/registra`);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().errore).toBe('AURA ha cambiato il codice fiscale: ricarica la pagina');
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
    expect(
      await t.db
        .select()
        .from(patient)
        .where(inArray(patient.fiscalCode, [p.fiscalCode, changed])),
    ).toEqual([]);
    const [c] = await t.db.select().from(auraNewPatient).where(eq(auraNewPatient.id, candidateId));
    expect(c!.status).toBe('da_registrare');
  });

  it('una transazione sola (D226): se l’ultimo passo non riesce, il paziente non resta e l’assistito si registra dopo', async () => {
    const { p, candidateId } = await chooses('m');
    // Un guasto apposta all'ultimo passo: l'assistito che diventa «registrato».
    await t.pool.query(
      `create function guasto_di_prova() returns trigger language plpgsql as $$ begin raise exception 'guasto di prova'; end $$`,
    );
    await t.pool.query(
      `create trigger guasto_di_prova before update on aura_new_patient for each row when (new.status = 'registrato') execute function guasto_di_prova()`,
    );
    try {
      const failed = await post(`/api/aura/nuovi/${candidateId}/registra`);
      expect(failed.statusCode, failed.body).toBe(500);
    } finally {
      await t.pool.query('drop trigger guasto_di_prova on aura_new_patient');
      await t.pool.query('drop function guasto_di_prova()');
    }
    expect(await t.db.select().from(patient).where(eq(patient.fiscalCode, p.fiscalCode))).toEqual(
      [],
    );
    const [c] = await t.db.select().from(auraNewPatient).where(eq(auraNewPatient.id, candidateId));
    expect(c!.status).toBe('da_registrare');
    const again = await post(`/api/aura/nuovi/${candidateId}/registra`);
    expect(again.statusCode, again.body).toBe(201);
    expect(
      await t.db.select().from(patient).where(eq(patient.fiscalCode, p.fiscalCode)),
    ).toHaveLength(1);
  });
});
