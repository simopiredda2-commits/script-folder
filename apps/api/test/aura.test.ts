import { SimulatedAura } from '@mmg/integrations';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createAuraService, NOT_IN_AURA } from '../src/aura/service';
import {
  accessLog,
  appUser,
  auraChange,
  auraLink,
  auraSyncRun,
  auraSyncRunStudio,
  doctorProfile,
  exemption,
  patient,
  patientChoice,
  studio,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Drizzle avvolge l'errore di Postgres: il messaggio del trigger sta in `cause`. */
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
 * AURA, l'anagrafe regionale degli assistiti (D197): esenzioni e scelte del medico lette dal
 * simulatore, allineate a ogni controllo (subito, alle variazioni, ogni notte), con le righe a mano
 * intatte, quelle tolte in AURA annullate con il motivo e ogni variazione registrata.
 */
describe('AURA: esenzioni e scelte dall’anagrafe regionale (D197)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let aura: SimulatedAura;
  let cookie: string;
  let cf: string;
  let doctorCf: string;
  let auraId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    aura = new SimulatedAura();
    s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    cookie = await login(s, 'titolare');
    [{ cf }] = (await t.db
      .select({ cf: patient.fiscalCode })
      .from(patient)
      .where(eq(patient.id, s.richPatient))) as [{ cf: string }];
    const [d] = await t.db
      .select({ cf: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    doctorCf = d!.cf!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const call = (method: 'GET' | 'POST', url: string, who = cookie) =>
    s.app.inject({ method, url, headers: { cookie: who } });
  const sync = (who = cookie) => call('POST', `/api/pazienti/${s.richPatient}/aura`, who);
  /** Esenzioni di AURA in vigore nella cartella (le annullate restano, ma non contano). */
  const fromAura = () =>
    t.db
      .select()
      .from(exemption)
      .where(
        and(
          eq(exemption.patientId, s.richPatient),
          eq(exemption.source, 'aura'),
          isNull(exemption.annulledAt),
        ),
      )
      .orderBy(asc(exemption.code));
  const changes = () =>
    t.db
      .select()
      .from(auraChange)
      .where(eq(auraChange.patientId, s.richPatient))
      .orderBy(asc(auraChange.at), asc(auraChange.description));
  /** Le variazioni arrivano senza aspettare la risposta: si aspetta che siano applicate. */
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('La variazione di AURA non è arrivata');
  }

  it('assistito che AURA non conosce: nulla cambia, e il motivo resta', async () => {
    const res = await sync();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ esito: 'non_trovato', variazioni: 0 });
    expect(res.json().stato).toMatchObject({
      disponibile: true,
      idAura: null,
      esito: 'non_trovato',
    });
    expect(await fromAura()).toEqual([]);
  });

  it('esenzioni e scelta arrivano da AURA, con la provenienza; quelle a mano restano', async () => {
    // Un medico di un altro studio dello stesso servizio, con il suo codice fiscale (inventato).
    const [elsewhere] = await t.db.insert(studio).values({ name: 'Studio vicino' }).returning();
    const [doc] = await t.db
      .insert(appUser)
      .values({
        studioId: elsewhere!.id,
        username: 'medico-altro-studio',
        displayName: 'Medico di un altro studio',
        passwordHash: 'non-usata',
        roles: ['owner_doctor'],
      })
      .returning();
    const elsewhereCf = 'MDCLTR70A01X000Z';
    await t.db.insert(doctorProfile).values({ userId: doc!.id, fiscalCode: elsewhereCf });
    const manual = await t.db
      .insert(exemption)
      .values({ patientId: s.richPatient, code: 'E01', validFrom: '2026-01-01', source: 'manual' })
      .returning();
    auraId = aura.register({
      fiscalCode: cf,
      lastName: 'Inventato',
      firstName: 'Paziente',
      birthDate: '1960-01-01',
      exemptions: [
        { code: '013', prescriptionCode: null, validFrom: '2025-01-01', validTo: null },
        { code: '048', prescriptionCode: '048', validFrom: '2026-01-01', validTo: '2027-01-01' },
      ],
      choices: [
        {
          doctorFiscalCode: doctorCf,
          chosenOn: '2024-03-01',
          expiresOn: null,
          endedOn: null,
          endReason: null,
        },
        // Un medico di un altro studio dello stesso servizio: non entra.
        {
          doctorFiscalCode: elsewhereCf,
          chosenOn: '2020-01-01',
          expiresOn: null,
          endedOn: '2024-02-29',
          endReason: 'revoca',
        },
      ],
    });
    // Nello scenario il paziente principale è in carico (D199): due esenzioni e una scelta.
    const res = await sync();
    expect(res.json()).toMatchObject({ esito: 'aggiornato', variazioni: 3 });
    expect(res.json().stato).toMatchObject({ idAura: auraId, esito: 'aggiornato' });
    expect((await fromAura()).map((e) => [e.code, e.validTo])).toEqual([
      ['013', null],
      ['048', '2027-01-01'],
    ]);
    const choices = await t.db
      .select()
      .from(patientChoice)
      .where(and(eq(patientChoice.patientId, s.richPatient), eq(patientChoice.source, 'aura')));
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ doctorUserId: s.users.titolare.id, chosenOn: '2024-03-01' });
    // L'esenzione a mano non si tocca.
    const [still] = await t.db.select().from(exemption).where(eq(exemption.id, manual[0]!.id));
    expect(still).toMatchObject({ code: 'E01', source: 'manual', annulledAt: null });
    // Nel pannello: provenienza AURA, e le righe di AURA non si modificano a mano.
    const view = (await call('GET', `/api/pazienti/${s.richPatient}/amministrazione`)).json();
    const e013 = view.esenzioni.find((e: { codice: string }) => e.codice === '013');
    expect(e013).toMatchObject({ fonte: 'AURA', daAura: true });
    const patch = await s.app.inject({
      method: 'PATCH',
      url: `/api/pazienti/${s.richPatient}/esenzioni/${e013.id}`,
      headers: { cookie },
      payload: { al: '2026-12-31' },
    });
    expect(patch.statusCode).toBe(409);
    expect((await changes()).map((c) => [c.kind, c.change, c.trigger])).toEqual(
      expect.arrayContaining([
        ['esenzione', 'nuova', 'manuale'],
        ['esenzione', 'nuova', 'manuale'],
        ['scelta', 'nuova', 'manuale'],
      ]),
    );
  });

  it('una variazione in AURA arriva da sola: scadenza cambiata, esenzione tolta, scelta revocata', async () => {
    aura.setExemption(auraId, {
      code: '013',
      prescriptionCode: null,
      validFrom: '2025-01-01',
      validTo: '2026-12-31',
    });
    await until(
      async () => (await fromAura()).find((e) => e.code === '013')?.validTo === '2026-12-31',
    );
    aura.removeExemption(auraId, '048', '2026-01-01');
    await until(async () => (await fromAura()).length === 1);
    // Tolta in AURA: non si cancella, resta annullata con il motivo (dalla notifica, senza autore).
    const [gone] = await t.db
      .select()
      .from(exemption)
      .where(and(eq(exemption.patientId, s.richPatient), eq(exemption.code, '048')));
    expect(gone).toMatchObject({ source: 'aura', annulReason: NOT_IN_AURA, annulledBy: null });
    expect(gone!.annulledAt).not.toBeNull();
    const panel = (await call('GET', `/api/pazienti/${s.richPatient}/amministrazione`)).json();
    expect(panel.esenzioni.map((e: { codice: string }) => e.codice)).not.toContain('048');
    aura.setChoice(auraId, {
      doctorFiscalCode: doctorCf,
      chosenOn: '2024-03-01',
      expiresOn: null,
      endedOn: '2026-11-15',
      endReason: 'revoca',
    });
    await until(async () => {
      const [c] = await t.db
        .select()
        .from(patientChoice)
        .where(and(eq(patientChoice.patientId, s.richPatient), eq(patientChoice.source, 'aura')));
      return c?.endedOn === '2026-11-15';
    });
    const byNotice = (await changes()).filter((c) => c.trigger === 'notifica');
    expect(byNotice.map((c) => [c.kind, c.change])).toEqual(
      expect.arrayContaining([
        ['esenzione', 'cambiata'],
        ['esenzione', 'tolta'],
        ['scelta', 'cambiata'],
      ]),
    );
    expect(byNotice.find((c) => c.change === 'tolta')!.description).toMatch(
      /048.*non c’è più in AURA/,
    );
    expect(byNotice.find((c) => c.kind === 'scelta')!.description).toMatch(
      /cessata il 15\/11\/2026 \(revoca\)/,
    );
  });

  it('senza rete i dati restano quelli di prima, con il motivo', async () => {
    aura.setUnreachable(true);
    try {
      const res = await sync();
      expect(res.json()).toMatchObject({ esito: 'non_raggiungibile', variazioni: 0 });
      expect(res.json().stato.messaggio).toMatch(/non raggiungibile/);
      expect(await fromAura()).toHaveLength(1);
    } finally {
      aura.setUnreachable(false);
    }
  });

  it('un identificativo che risponde con un altro codice fiscale non cambia nulla', async () => {
    const other = aura.register({
      fiscalCode: 'ZZZZZZ00Z00Z000Z',
      lastName: 'Altro',
      firstName: 'Assistito',
      birthDate: '1950-01-01',
      exemptions: [{ code: '031', prescriptionCode: null, validFrom: '2020-01-01', validTo: null }],
      choices: [],
    });
    await t.db.update(auraLink).set({ auraId: other }).where(eq(auraLink.patientId, s.richPatient));
    const res = await sync();
    expect(res.json()).toMatchObject({ esito: 'rifiutato', variazioni: 0 });
    expect((await fromAura()).map((e) => e.code)).toEqual(['013']);
    // Il controllo dopo ritrova l'assistito giusto dal codice fiscale.
    expect((await sync()).json()).toMatchObject({ esito: 'aggiornato', stato: { idAura: auraId } });
  });

  it('solo chi scrive nell’archivio aggiorna; ogni controllo resta nel registro', async () => {
    expect((await sync(await login(s, 'amministratore'))).statusCode).toBe(403);
    expect((await sync(await login(s, 'collega'))).statusCode).toBe(403);
    const rows = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'aggiornamento_aura')),
      );
    expect(rows.some((r) => r.outcome === 'negato')).toBe(true);
    expect(rows.some((r) => r.outcome === 'riuscito')).toBe(true);
  });

  it('variazioni recenti: le vede chi vede il paziente, e la lettura resta nel registro', async () => {
    const mine = (await call('GET', '/api/aura/variazioni?giorni=7')).json();
    expect(mine.variazioni.length).toBeGreaterThan(0);
    expect(
      mine.variazioni.every((v: { paziente: { id: string } }) => v.paziente.id === s.richPatient),
    ).toBe(true);
    const other = (await call('GET', '/api/aura/variazioni', await login(s, 'collega'))).json();
    expect(other.variazioni).toEqual([]);
    const read = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, s.richPatient),
          eq(accessLog.action, 'lettura_variazioni_aura'),
        ),
      );
    expect(read.length).toBeGreaterThan(0);
  });

  it('le variazioni non si modificano e non si cancellano; le righe annullate restano come sono', async () => {
    await rejectsWith(
      t.db.execute(sql`update aura_change set description = 'altro'`),
      /non si modificano/,
    );
    await rejectsWith(t.db.execute(sql`delete from aura_change`), /non si modificano/);
    await rejectsWith(t.db.execute(sql`truncate aura_change`), /non si cancellano/);
    const [gone] = await t.db
      .select()
      .from(exemption)
      .where(and(eq(exemption.patientId, s.richPatient), eq(exemption.code, '048')));
    await rejectsWith(
      t.db.execute(sql`update exemption set valid_to = '2030-01-01' where id = ${gone!.id}`),
      /esenzione annullata non si modifica/,
    );
    await rejectsWith(
      t.db.execute(sql`delete from exemption where id = ${gone!.id}`),
      /non si cancellano/,
    );
    // Annullamento a metà (senza motivo): il database lo rifiuta.
    const [live] = await fromAura();
    await rejectsWith(
      t.db.execute(sql`update exemption set annulled_at = now() where id = ${live!.id}`),
      /exemption_annulment_complete/,
    );
    const [choice] = await t.db
      .select()
      .from(patientChoice)
      .where(and(eq(patientChoice.patientId, s.richPatient), eq(patientChoice.source, 'aura')));
    await rejectsWith(
      t.db.execute(
        sql`update patient_choice set annulled_at = now(), annul_reason = '' where id = ${choice!.id}`,
      ),
      /patient_choice_annulment_complete/,
    );
    // Il pannello non modifica un'esenzione annullata.
    const patch = await s.app.inject({
      method: 'PATCH',
      url: `/api/pazienti/${s.richPatient}/esenzioni/${gone!.id}`,
      headers: { cookie },
      payload: { al: '2026-12-31' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().errore).toMatch(/annullata/);
  });

  it('il giro di ogni notte controlla i pazienti attivi; lo studio vede solo i suoi numeri', async () => {
    const service = createAuraService({
      db: t.db,
      gateway: aura,
      environment: 'prova',
      now: s.clock.now,
    });
    // Il collegamento ha lo storico dei cambi di stato; un controllo che non cambia nulla non lo
    // allunga e non scrive nel registro degli accessi.
    const history = async () =>
      Number(
        (
          await t.db.execute<{ n: string }>(sql`
            select count(*)::text as n from change_history
            where table_name = 'aura_link'
              and row_id = (select id::text from aura_link where patient_id = ${s.richPatient})`)
        ).rows[0]!.n,
      );
    const logged = async () =>
      (
        await t.db
          .select()
          .from(accessLog)
          .where(
            and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'aggiornamento_aura')),
          )
      ).length;
    const [h0, l0] = [await history(), await logged()];
    expect(h0).toBeGreaterThan(1);
    const run = await service.syncAll('notte');
    expect([await history(), await logged()]).toEqual([h0, l0]);
    await rejectsWith(
      t.db.execute(sql`delete from aura_link where patient_id = ${s.richPatient}`),
      /non si cancellano/,
    );
    // In carico, e i revocati già collegati ad AURA (D198): qui il paziente di prima, revocato
    // quando AURA ha detto cessata la scelta del titolare.
    const active = await t.db
      .select({ id: patient.id })
      .from(patient)
      .leftJoin(auraLink, eq(auraLink.patientId, patient.id))
      .where(
        and(
          eq(patient.studioId, s.studioId),
          or(
            eq(patient.status, 'active'),
            and(eq(patient.status, 'revoked'), isNotNull(auraLink.auraId)),
          ),
        ),
      );
    expect(active.map((a) => a.id)).toContain(s.richPatient);
    expect(run.patients).toBe(active.length);
    expect(run.failed).toBe(0);
    const [stored] = await t.db.select().from(auraSyncRun).where(eq(auraSyncRun.id, run.id));
    expect(stored!.finishedAt).not.toBeNull();
    // Un altro studio dello stesso servizio: i suoi numeri non si vedono da qui.
    const [other] = await t.db.insert(studio).values({ name: 'Altro studio' }).returning();
    await t.db
      .insert(auraSyncRunStudio)
      .values({ runId: run.id, studioId: other!.id, patients: 99, changed: 9, failed: 1 });
    await t.db
      .update(auraSyncRun)
      .set({ patients: run.patients + 99, changed: run.changed + 9, failed: run.failed + 1 })
      .where(eq(auraSyncRun.id, run.id));
    const res = await call('GET', '/api/studio/servizio', await login(s, 'amministratore'));
    expect(res.statusCode, res.body).toBe(200);
    const status = res.json();
    expect(status.aura).toMatchObject({
      disponibile: true,
      ultimoGiro: { pazienti: active.length, nonRiusciti: 0 },
    });
    expect(status.collegamenti.map((c: { codice: string }) => c.codice)).toContain('aura');
  });
});

/** Un'anagrafe che non manda notifiche: le variazioni si vedono solo rileggendo il paziente. */
class SilentAura extends SimulatedAura {
  override onNotification(): () => void {
    return () => undefined;
  }
}

describe('AURA prima dei controlli di una ricetta con esenzione (D197)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const aura = new SilentAura();

  beforeAll(async () => {
    t = await createTestDatabase();
    // Sessione lunga: la prova fa passare più di dieci minuti.
    s = await createScenario(t.db, { idleLockMinutes: 30 }, { aura: { gateway: aura } });
    cookie = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, payload, headers: { cookie } });
  const r9 = async (id: string) => {
    const res = await post(`/api/ricette/${id}/controlla`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ problemi: { ruleId: string }[] }>().problemi.filter((p) => p.ruleId === 'R9');
  };

  it('dati di più di dieci minuti: si rilegge AURA, e un’esenzione tolta non vale più', async () => {
    const [{ cf }] = (await t.db
      .select({ cf: patient.fiscalCode })
      .from(patient)
      .where(eq(patient.id, s.richPatient))) as [{ cf: string }];
    const auraId = aura.register({
      fiscalCode: cf,
      lastName: 'Inventato',
      firstName: 'Paziente',
      birthDate: '1960-01-01',
      exemptions: [{ code: '048', prescriptionCode: null, validFrom: '2026-01-01', validTo: null }],
      choices: [],
    });
    expect((await post(`/api/pazienti/${s.richPatient}/aura`)).json()).toMatchObject({
      esito: 'aggiornato',
    });
    const draft = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      exemptionCode: '048',
      lines: [
        {
          drugName: 'Farmaco di prova 5 mg',
          activeIngredient: 'principio di prova',
          quantity: 1,
        },
      ],
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json<{ id: string }>().id;
    expect(await r9(id)).toEqual([]);

    // L'ASL toglie l'esenzione; la notifica non arriva.
    aura.removeExemption(auraId, '048', '2026-01-01');
    // Dati di pochi minuti fa: valgono, AURA non si rilegge.
    expect(await r9(id)).toEqual([]);
    // Dopo dieci minuti si rilegge AURA prima dei controlli: l'esenzione è annullata e R9 blocca.
    s.clock.advance(11 * 60_000);
    expect(await r9(id)).toHaveLength(1);
    const changes = await t.db
      .select()
      .from(auraChange)
      .where(and(eq(auraChange.patientId, s.richPatient), eq(auraChange.trigger, 'ricetta')));
    expect(changes.map((c) => [c.kind, c.change, c.subject])).toEqual([
      ['esenzione', 'tolta', '048'],
    ]);
  });
});

describe('AURA in produzione con il simulatore: spenta (D197)', () => {
  it('nessun controllo, e il motivo detto', async () => {
    const t = await createTestDatabase();
    const s = await createScenario(t.db);
    const app = buildApp({
      db: t.db,
      config: {
        encryptionKey: s.encryptionKey,
        sessionMaxHours: 12,
        cookieSecure: false,
        environment: 'produzione',
      },
      now: s.clock.now,
      secondFactor: s.secondFactor,
      aura: { gateway: new SimulatedAura() },
    });
    try {
      const service = createAuraService({
        db: t.db,
        gateway: new SimulatedAura(),
        environment: 'produzione',
        now: s.clock.now,
      });
      expect(service.available()).toBe(false);
      expect(await service.syncPatient(s.richPatient, 'manuale')).toMatchObject({
        outcome: 'spento',
      });
      expect((await service.syncAll('notte')).message).toMatch(/non è ancora collegata/);
      const users = await app.inject({ method: 'GET', url: '/api/salute' });
      expect(users.statusCode).toBe(200);
    } finally {
      await app.close();
      await s.app.close();
      await t.drop();
    }
  });
});
