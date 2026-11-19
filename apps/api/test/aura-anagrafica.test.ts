import { SimulatedAura } from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuraService } from '../src/aura/service';
import { accessLog, auraChange, doctorProfile, exemption, patient } from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Risposte della fermata dopo l'unione della #11 (D198): il paziente passa a «revocato» da solo
 * quando AURA dice che la scelta del titolare dell'archivio è cessata, e torna in carico con una
 * scelta nuova; l'anagrafica di AURA si vede come differenze da confermare, e il decesso si
 * segnala in Oggi.
 */
describe('AURA: revoca e anagrafica da confermare (D198)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  let auraId: string;
  let ownerCf: string;
  let colleagueCf: string;
  const aura = new SimulatedAura();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    cookie = await login(s, 'titolare');
    const cf = async (userId: string) =>
      (
        await t.db
          .select({ cf: doctorProfile.fiscalCode })
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, userId))
      )[0]!.cf!;
    ownerCf = await cf(s.users.titolare.id);
    colleagueCf = await cf(s.users.collega.id);
    // Lo stato del paziente di esempio cambia da uno scenario all'altro: qui parte in carico.
    await t.db
      .update(patient)
      .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
      .where(eq(patient.id, s.richPatient));
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    auraId = aura.register({
      fiscalCode: rich!.fiscalCode,
      lastName: rich!.lastName,
      firstName: rich!.firstName,
      birthDate: rich!.birthDate,
      exemptions: [],
      choices: [
        {
          doctorFiscalCode: ownerCf,
          chosenOn: '2024-03-01',
          expiresOn: null,
          endedOn: null,
          endReason: null,
        },
      ],
    });
    const res = await post(`/api/pazienti/${s.richPatient}/aura`);
    expect(res.json()).toMatchObject({ esito: 'aggiornato' });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (url: string, payload?: object, who = cookie) =>
    s.app.inject({
      method: 'POST',
      url,
      headers: { cookie: who },
      ...(payload ? { payload } : {}),
    });
  const state = async () =>
    (
      await s.app.inject({
        method: 'GET',
        url: `/api/pazienti/${s.richPatient}/aura`,
        headers: { cookie },
      })
    ).json<{ differenze: { campo: string; nellaCartella: string | null; inAura: string }[] }>();
  const rich = async () =>
    (await t.db.select().from(patient).where(eq(patient.id, s.richPatient)))[0]!;
  const daysAgo = (n: number) => studioDate(new Date(s.clock.now().getTime() - n * 86_400_000));
  /** Le notifiche arrivano senza aspettare la risposta: si aspetta che siano applicate. */
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('La variazione di AURA non è arrivata');
  }
  const statusChanges = async () =>
    (
      await t.db
        .select()
        .from(auraChange)
        .where(and(eq(auraChange.patientId, s.richPatient), eq(auraChange.kind, 'stato')))
    ).map((c) => c.description);

  it('la scelta di un altro medico cessata non cambia lo stato', async () => {
    aura.setChoice(auraId, {
      doctorFiscalCode: colleagueCf,
      chosenOn: '2020-01-01',
      expiresOn: null,
      endedOn: daysAgo(30),
      endReason: 'revoca',
    });
    // Si aspetta la scelta del collega: quella del titolare c'era già.
    await until(async () =>
      (await t.db.select().from(auraChange).where(eq(auraChange.patientId, s.richPatient))).some(
        (c) => c.kind === 'scelta' && c.description.includes('01/01/2020'),
      ),
    );
    expect((await rich()).status).toBe('active');

    // Un altro paziente dell'archivio, con in AURA solo la scelta cessata del collega: in carico.
    const otherId = s.patients.titolare[1]!;
    await t.db
      .update(patient)
      .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
      .where(eq(patient.id, otherId));
    const [other] = await t.db.select().from(patient).where(eq(patient.id, otherId));
    aura.register({
      fiscalCode: other!.fiscalCode,
      lastName: other!.lastName,
      firstName: other!.firstName,
      birthDate: other!.birthDate,
      exemptions: [],
      choices: [
        {
          doctorFiscalCode: colleagueCf,
          chosenOn: '2020-01-01',
          expiresOn: null,
          endedOn: daysAgo(30),
          endReason: 'revoca',
        },
      ],
    });
    expect((await post(`/api/pazienti/${otherId}/aura`)).json()).toMatchObject({
      esito: 'aggiornato',
      variazioni: 1,
    });
    expect((await t.db.select().from(patient).where(eq(patient.id, otherId)))[0]!.status).toBe(
      'active',
    );
  });

  it('scelta del titolare cessata in AURA: il paziente è revocato da solo, e torna con una scelta nuova', async () => {
    aura.setChoice(auraId, {
      doctorFiscalCode: ownerCf,
      chosenOn: '2024-03-01',
      expiresOn: null,
      endedOn: daysAgo(4),
      endReason: 'revoca',
    });
    await until(async () => (await rich()).status === 'revoked');
    expect(await statusChanges()).toEqual([
      expect.stringMatching(/^Paziente revocato: Scelta di .+ cessata il .+ \(revoca\)$/),
    ]);
    // Torna dallo stesso medico: di nuovo in carico, da solo.
    aura.setChoice(auraId, {
      doctorFiscalCode: ownerCf,
      chosenOn: daysAgo(1),
      expiresOn: null,
      endedOn: null,
      endReason: null,
    });
    await until(async () => (await rich()).status === 'active');
    expect(await statusChanges()).toHaveLength(2);
    expect((await statusChanges())[1]).toMatch(/^Paziente di nuovo in carico: Scelta di /);
  });

  it('anagrafica diversa in AURA: si vede come differenza e non entra da sola', async () => {
    const before = await rich();
    expect(before.residenceProvince).toBeTruthy();
    aura.setRegistry(auraId, {
      asl: 'ASL TO5',
      residenceTown: 'MONCALIERI',
      // Lo stesso indirizzo, scritto in un altro modo: non è una differenza.
      residenceStreet: `  ${(before.residenceStreet ?? '').toUpperCase()}  `,
      // Un campo vuoto in AURA non propone di svuotare quello della cartella.
      residenceProvince: '   ',
    });
    await until(async () => (await state()).differenze.length > 0);
    const diffs = (await state()).differenze;
    expect(diffs.map((d) => [d.campo, d.inAura])).toEqual([
      ['residenzaComune', 'MONCALIERI'],
      ['asl', 'ASL TO5'],
    ]);
    expect(await rich()).toMatchObject({ asl: before.asl, residenceTown: before.residenceTown });
    const [arrived] = await t.db
      .select()
      .from(auraChange)
      .where(and(eq(auraChange.patientId, s.richPatient), eq(auraChange.kind, 'anagrafica')));
    expect(arrived!.description).toMatch(/da confermare: .*«MONCALIERI».*«ASL TO5»/);
  });

  it('usare il dato di AURA: con i controlli del pannello e il registro; un valore vecchio no', async () => {
    const stale = await post(`/api/pazienti/${s.richPatient}/aura/differenze`, {
      scelte: [{ campo: 'asl', inAura: 'ASL TO1', usa: true }],
    });
    expect(stale.statusCode).toBe(409);
    const res = await post(
      `/api/pazienti/${s.richPatient}/aura/differenze`,
      { scelte: [{ campo: 'asl', inAura: 'ASL TO5', usa: true }] },
      await login(s, 'segreteria'),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ campi: ['asl'], nonUsati: [] });
    expect((await rich()).asl).toBe('ASL TO5');
    expect((await state()).differenze.map((d) => d.campo)).toEqual(['residenzaComune']);
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, s.richPatient),
          eq(accessLog.action, 'modifica_dati_amministrativi'),
          eq(accessLog.outcome, 'riuscito'),
        ),
      );
    expect(logged.at(-1)!.details).toMatchObject({ campi: ['asl'], fonte: 'AURA' });
  });

  it('non usare un dato: non si ripropone, finché AURA non ne manda un altro', async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/aura/differenze`, {
      scelte: [{ campo: 'residenzaComune', inAura: 'MONCALIERI', usa: false }],
    });
    expect(res.json()).toMatchObject({ campi: [], nonUsati: ['residenzaComune'] });
    expect((await state()).differenze).toEqual([]);
    expect((await rich()).residenceTown).not.toBe('MONCALIERI');
    aura.setRegistry(auraId, { residenceTown: 'TRUFFARELLO' });
    await until(async () => (await state()).differenze.length > 0);
    expect((await state()).differenze.map((d) => [d.campo, d.inAura])).toEqual([
      ['residenzaComune', 'TRUFFARELLO'],
    ]);
  });

  it('solo chi scrive nell’archivio conferma le differenze', async () => {
    for (const who of ['collega', 'amministratore'] as const) {
      const res = await post(
        `/api/pazienti/${s.richPatient}/aura/differenze`,
        { scelte: [{ campo: 'residenzaComune', inAura: 'TRUFFARELLO', usa: true }] },
        await login(s, who),
      );
      expect(res.statusCode, who).toBe(403);
    }
    expect((await rich()).residenceTown).not.toBe('TRUFFARELLO');
  });

  it('decesso: segnalato in Oggi, confermato dal pannello con i suoi controlli', async () => {
    const tomorrow = studioDate(new Date(s.clock.now().getTime() + 86_400_000));
    aura.setRegistry(auraId, { deceasedOn: tomorrow });
    await until(async () => (await state()).differenze.some((d) => d.campo === 'decesso'));
    const future = await post(`/api/pazienti/${s.richPatient}/aura/differenze`, {
      scelte: [{ campo: 'decesso', inAura: tomorrow, usa: true }],
    });
    expect(future.statusCode).toBe(400);
    expect((await rich()).status).toBe('active');

    const died = daysAgo(2);
    aura.setRegistry(auraId, { deceasedOn: died });
    await until(async () =>
      (await state()).differenze.some((d) => d.campo === 'decesso' && d.inAura === died),
    );
    const today = (
      await s.app.inject({ method: 'GET', url: '/api/aura/variazioni', headers: { cookie } })
    ).json<{ daConfermare: { paziente: { id: string }; decesso: string | null }[] }>();
    expect(today.daConfermare[0]).toMatchObject({
      paziente: { id: s.richPatient },
      decesso: died,
    });
    // Chi non vede il paziente non lo vede nemmeno qui.
    const other = (
      await s.app.inject({
        method: 'GET',
        url: '/api/aura/variazioni',
        headers: { cookie: await login(s, 'collega') },
      })
    ).json<{ daConfermare: unknown[] }>();
    expect(other.daConfermare).toEqual([]);

    const res = await post(`/api/pazienti/${s.richPatient}/aura/differenze`, {
      scelte: [{ campo: 'decesso', inAura: died, usa: true }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await rich()).toMatchObject({ status: 'deceased', deceasedOn: died });
    expect((await state()).differenze.some((d) => d.campo === 'decesso')).toBe(false);
  });

  it('un paziente deceduto non torna «in carico» né «revocato» per AURA', async () => {
    aura.setChoice(auraId, {
      doctorFiscalCode: ownerCf,
      chosenOn: daysAgo(1),
      expiresOn: null,
      endedOn: daysAgo(0),
      endReason: 'decesso',
    });
    await until(async () =>
      (await t.db.select().from(auraChange).where(eq(auraChange.patientId, s.richPatient))).some(
        (c) => c.description.includes('(decesso)'),
      ),
    );
    expect((await rich()).status).toBe('deceased');
  });
});

/** Un'anagrafe che non manda notifiche: le variazioni si vedono solo con il giro di notte. */
class SilentAura extends SimulatedAura {
  override onNotification(): () => void {
    return () => undefined;
  }
}

describe('AURA di notte: anche i revocati collegati, per tornare in carico (D198)', () => {
  it('revocato da un giro, di nuovo in carico dal giro dopo', async () => {
    const t = await createTestDatabase();
    const aura = new SilentAura();
    const s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    try {
      await t.db
        .update(patient)
        .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
        .where(eq(patient.id, s.richPatient));
      const [p] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
      const [doc] = await t.db
        .select({ cf: doctorProfile.fiscalCode })
        .from(doctorProfile)
        .where(eq(doctorProfile.userId, s.users.titolare.id));
      const day = (n: number) => studioDate(new Date(s.clock.now().getTime() - n * 86_400_000));
      const auraId = aura.register({
        fiscalCode: p!.fiscalCode,
        lastName: p!.lastName,
        firstName: p!.firstName,
        birthDate: p!.birthDate,
        exemptions: [],
        choices: [
          {
            doctorFiscalCode: doc!.cf!,
            chosenOn: '2024-03-01',
            expiresOn: null,
            endedOn: day(3),
            endReason: 'revoca',
          },
        ],
      });
      const service = createAuraService({
        db: t.db,
        gateway: aura,
        environment: 'prova',
        now: s.clock.now,
      });
      await service.syncAll('notte');
      const status = async () =>
        (await t.db.select().from(patient).where(eq(patient.id, s.richPatient)))[0]!.status;
      expect(await status()).toBe('revoked');
      aura.setChoice(auraId, {
        doctorFiscalCode: doc!.cf!,
        chosenOn: day(1),
        expiresOn: null,
        endedOn: null,
        endReason: null,
      });
      await service.syncAll('notte');
      expect(await status()).toBe('active');
    } finally {
      await s.app.close();
      await t.drop();
    }
  });
});

/** Un'anagrafe lenta a rispondere: i controlli insieme si sovrappongono davvero. */
class SlowAura extends SilentAura {
  override async getProfile(auraId: string) {
    await new Promise((r) => setTimeout(r, 50));
    return super.getProfile(auraId);
  }
}

describe('AURA: un controllo alla volta per paziente (D198)', () => {
  it('tre controlli insieme: la stessa esenzione entra una volta sola', async () => {
    const t = await createTestDatabase();
    const aura = new SlowAura();
    const s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    try {
      await t.db
        .update(patient)
        .set({ status: 'active', deceasedOn: null, deathCauseIcd: null })
        .where(eq(patient.id, s.richPatient));
      const [p] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
      aura.register({
        fiscalCode: p!.fiscalCode,
        lastName: p!.lastName,
        firstName: p!.firstName,
        birthDate: p!.birthDate,
        exemptions: [
          { code: '013', prescriptionCode: null, validFrom: '2025-01-01', validTo: null },
        ],
        choices: [],
      });
      const service = createAuraService({
        db: t.db,
        gateway: aura,
        environment: 'prova',
        now: s.clock.now,
      });
      const results = await Promise.all(
        [1, 2, 3].map(() => service.syncPatient(s.richPatient, 'notifica')),
      );
      expect(results.map((r) => r.outcome)).toEqual(['aggiornato', 'aggiornato', 'aggiornato']);
      expect(results.map((r) => r.changes).sort()).toEqual([0, 0, 1]);
      const rows = await t.db
        .select()
        .from(exemption)
        .where(and(eq(exemption.patientId, s.richPatient), eq(exemption.source, 'aura')));
      expect(rows).toHaveLength(1);
      expect(
        await t.db.select().from(auraChange).where(eq(auraChange.patientId, s.richPatient)),
      ).toHaveLength(1);
    } finally {
      await s.app.close();
      await t.drop();
    }
  });
});
