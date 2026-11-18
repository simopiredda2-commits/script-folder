import { randomBytes, randomUUID } from 'node:crypto';
import { buildFiscalCode, type Role } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { SimulatedSecondFactor } from '@mmg/integrations';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app';
import { storeCredentials, storeSession } from '../../src/credentials/service';
import { studioDate } from '../../src/prescriptions/rules-check';
import type { Database } from '../../src/db/client';
import {
  allergyDetail,
  appUser,
  archive,
  archiveGrant,
  clinicalEntry,
  diaryDetail,
  doctorProfile,
  exemption,
  fseSetting,
  patient,
  prescription,
  sickLeaveCertificate,
  prescriptionLine,
  problemDetail,
  studio,
  therapy,
} from '../../src/db/schema';
import { withActor } from '../../src/db/tx';
import { base32Decode } from '../../src/security/base32';
import { hashPassword } from '../../src/security/password';
import { totp } from '../../src/security/totp';

/** Orologio delle prove: parte da adesso e si sposta a mano. */
export class Clock {
  private t = Date.now();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export const PASSWORD = 'password-di-prova-lunga';

export interface ScenarioUser {
  id: string;
  username: string;
  roles: Role[];
}

export interface Scenario {
  db: Database;
  app: FastifyInstance;
  clock: Clock;
  studioId: string;
  users: Record<
    'titolare' | 'collega' | 'segreteria' | 'sostituto' | 'amministratore',
    ScenarioUser
  >;
  archives: { titolare: string; collega: string };
  patients: { titolare: string[]; collega: string[] };
  /** Paziente del titolare con diario, allergia, problema, terapia normale e riservata. */
  richPatient: string;
  /** Bozza di ricetta del paziente ricco. */
  draftPrescription: string;
  /** Bozza di certificato di malattia del paziente ricco. */
  draftCertificate: string;
  /** Codici TOTP: il segreto di ogni utente dopo l'attivazione. */
  secrets: Map<string, Buffer>;
  /** Chiave dell'applicazione delle prove (credenziali cifrate). */
  encryptionKey: Buffer;
  /** Simulatori del secondo fattore (D102). */
  secondFactor: NonNullable<AppDeps['secondFactor']>;
}

/**
 * Studio di gruppo inventato: due titolari con archivi separati, segreteria condivisa,
 * un sostituto (autorizzato sull'archivio del titolare da ieri a domani), un amministratore.
 */
export async function createScenario(
  db: Database,
  settings: Partial<typeof studio.$inferInsert> = {},
  appOptions: Pick<
    AppDeps,
    | 'gateways'
    | 'preSendChecks'
    | 'reminderSender'
    | 'sendTimeoutMs'
    | 'secondFactor'
    | 'sickLeaveGateway'
    | 'regional'
    | 'fse'
  > = {},
): Promise<Scenario> {
  const clock = new Clock();
  const encryptionKey = randomBytes(32);
  const secondFactor = appOptions.secondFactor ?? {
    sistema_ts: new SimulatedSecondFactor('sistema_ts', { now: clock.now }),
    rupar_piemonte: new SimulatedSecondFactor('rupar_piemonte', { now: clock.now }),
  };
  const [st] = await db
    .insert(studio)
    .values({
      name: 'Studio associato di prova',
      kind: 'group',
      regionName: 'PIEMONTE',
      ...settings,
    })
    .returning();
  const studioId = st!.id;
  // Impostazioni del Fascicolo di prova: OID dell'arco 2.999, riservato agli esempi (tappa 11).
  await db.insert(fseSetting).values({
    studioId,
    documentIdRoot: '2.999.10.1',
    repositoryId: '2.999.10.2',
    submissionIdRoot: '2.999.10.3',
    custodianIdRoot: '2.999.10.4',
    custodianIdExtension: 'CUSTODE-PROVA',
    custodianName: 'Custode di prova',
    custodianStreet: 'Via del Custode 1',
    custodianCity: 'Comune di prova',
    custodianIstatCode: '999999',
    custodianProvince: 'XX',
    locality: 'STUDIO DI PROVA^^^^^&2.999.10.5&ISO^^^^000001',
    clinicalActivity: 'OBS',
    administrativeRequest: 'SSN',
  });
  const passwordHash = await hashPassword(PASSWORD);
  const suffix = randomBytes(3).toString('hex');

  const mk = async (key: string, displayName: string, roles: Role[]) => {
    const username = `${key}-${suffix}`;
    const [u] = await db
      .insert(appUser)
      .values({ studioId, username, displayName, passwordHash, roles })
      .returning();
    return { id: u!.id, username, roles };
  };
  const users = {
    titolare: await mk('titolare', 'Dott.ssa Elena Marchi', ['owner_doctor']),
    collega: await mk('collega', 'Dott. Paolo Serra', ['owner_doctor']),
    segreteria: await mk('segreteria', 'Lucia Bassi', ['secretary']),
    sostituto: await mk('sostituto', 'Dott. Marco Fiore', ['substitute_doctor']),
    amministratore: await mk('amministratore', 'Andrea Conti', ['administrator']),
  };
  // Codici fiscali inventati: luogo di nascita con la X, che nessun comune ha (D12).
  const doctorCf = (surname: string, name: string, sex: 'M' | 'F') =>
    buildFiscalCode({ surname, name, birthDate: '1970-01-01', sex, placeCode: 'X001' });
  await db.insert(doctorProfile).values([
    {
      userId: users.titolare.id,
      regionalCode: 'MMG-PROVA-1',
      asl: 'ASL di prova',
      fiscalCode: doctorCf('Marchi', 'Elena', 'F'),
      // Nome, cognome e recapiti per il Profilo Sanitario Sintetico (tappa 11); domini .invalid.
      firstName: 'Elena',
      lastName: 'Marchi',
      phone: '000 0000001',
      email: 'studio.marchi@esempio.invalid',
    },
    {
      userId: users.collega.id,
      regionalCode: 'MMG-PROVA-2',
      asl: 'ASL di prova',
      fiscalCode: doctorCf('Serra', 'Paolo', 'M'),
    },
    {
      userId: users.sostituto.id,
      regionalCode: 'MMG-PROVA-3',
      asl: 'ASL di prova',
      fiscalCode: doctorCf('Fiore', 'Marco', 'M'),
      firstName: 'Marco',
      lastName: 'Fiore',
      pec: 'marco.fiore@pec.esempio.invalid',
    },
  ]);
  // Credenziali inventate e un codice di sessione lungo, per le prove che non riguardano le
  // credenziali (D100–D102). Le prove delle credenziali partono da medici senza.
  const sessionUntil = new Date(clock.now().getTime() + 365 * 86_400_000);
  for (const [who, cf] of [
    [users.titolare, doctorCf('Marchi', 'Elena', 'F')],
    [users.collega, doctorCf('Serra', 'Paolo', 'M')],
    [users.sostituto, doctorCf('Fiore', 'Marco', 'M')],
  ] as const) {
    for (const service of ['sistema_ts', 'rupar_piemonte'] as const) {
      await storeCredentials(db, encryptionKey, {
        userId: who.id,
        service,
        secret: {
          username: `${service}-${who.username}`,
          password: 'parola-di-prova',
          pin: '0000',
        },
        passwordChangedOn: studioDate(clock.now()),
      });
      const token = randomUUID();
      await storeSession(db, encryptionKey, {
        userId: who.id,
        service,
        token,
        validUntil: sessionUntil,
      });
      const gw = secondFactor[service];
      if (gw instanceof SimulatedSecondFactor) gw.register(token, cf, sessionUntil);
    }
  }

  const [a1] = await db
    .insert(archive)
    .values({ studioId, ownerUserId: users.titolare.id, name: 'Archivio Marchi' })
    .returning();
  const [a2] = await db
    .insert(archive)
    .values({ studioId, ownerUserId: users.collega.id, name: 'Archivio Serra' })
    .returning();
  const day = 86_400_000;
  await db.insert(archiveGrant).values({
    archiveId: a1!.id,
    granteeUserId: users.sostituto.id,
    kind: 'substitution',
    validFrom: new Date(Date.now() - day),
    validTo: new Date(Date.now() + day),
    reason: 'Ferie del titolare',
    grantedBy: users.titolare.id,
  });

  const people = generatePatients({ seed: `scenario-${suffix}`, count: 8 });
  const insertPatients = async (list: typeof people, archiveId: string) => {
    const rows = await withActor(db, users.titolare.id, (tx) =>
      tx
        .insert(patient)
        .values(
          list.map((p) => ({
            studioId,
            archiveId,
            firstName: p.firstName,
            lastName: p.lastName,
            sex: p.sex,
            birthDate: p.birthDate,
            birthPlaceCode: p.birthPlace.code,
            birthPlaceName: p.birthPlace.name,
            fiscalCode: p.fiscalCode,
            phone: p.phone,
            email: p.email,
            residenceStreet: p.residence.street,
            residenceNumber: p.residence.number,
            residenceTown: p.residence.town,
            residenceProvince: p.residence.province,
            status: p.status,
          })),
        )
        .returning({ id: patient.id }),
    );
    return rows.map((r) => r.id);
  };
  const p1 = await insertPatients(people.slice(0, 5), a1!.id);
  const p2 = await insertPatients(people.slice(5), a2!.id);
  const rich = p1[0]!;

  await withActor(db, users.titolare.id, async (tx) => {
    const entry = async (
      kind: typeof clinicalEntry.$inferInsert.kind,
      extra: Partial<typeof clinicalEntry.$inferInsert> = {},
    ) => {
      const [e] = await tx
        .insert(clinicalEntry)
        .values({
          patientId: rich,
          kind,
          occurredOn: '2026-11-10',
          authorUserId: users.titolare.id,
          ...extra,
        })
        .returning();
      return e!.id;
    };
    await tx.insert(diaryDetail).values({
      entryId: await entry('diary'),
      contactType: 'office',
      text: 'Visita di controllo, paziente inventato.',
    });
    await tx.insert(diaryDetail).values({
      entryId: await entry('diary', { reserved: true }),
      contactType: 'phone',
      text: 'Nota riservata di prova.',
    });
    await tx.insert(allergyDetail).values({
      entryId: await entry('allergy'),
      substance: 'Sostanza di prova',
      drugRelated: true,
    });
    const problemId = await entry('problem');
    await tx
      .insert(problemDetail)
      .values({ entryId: problemId, icdCode: '000.0', description: 'Problema di prova' });
    await tx
      .insert(exemption)
      .values({ patientId: rich, code: 'P00', validFrom: '2026-01-01', source: 'manual' });
    await tx.insert(therapy).values([
      {
        patientId: rich,
        drugName: 'Farmaco di prova 5 mg',
        activeIngredient: 'principio di prova',
        kind: 'chronic',
        startOn: '2026-01-01',
        indicationEntryId: problemId,
        createdBy: users.titolare.id,
      },
      {
        patientId: rich,
        drugName: 'Farmaco riservato di prova',
        kind: 'chronic',
        startOn: '2026-01-01',
        reserved: true,
        createdBy: users.titolare.id,
      },
    ]);
  });

  // Una bozza di ricetta del titolare, per le rotte /api/ricette/:id.
  const [draft] = await withActor(db, users.titolare.id, async (tx) => {
    const rows = await tx
      .insert(prescription)
      .values({
        patientId: rich,
        archiveId: a1!.id,
        kind: 'pharma_ssn',
        preparedBy: users.titolare.id,
      })
      .returning({ id: prescription.id });
    await tx.insert(prescriptionLine).values({
      prescriptionId: rows[0]!.id,
      position: 1,
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'principio di prova',
      quantity: 1,
    });
    return rows;
  });
  const [certificate] = await withActor(db, users.titolare.id, (tx) =>
    tx
      .insert(sickLeaveCertificate)
      .values({
        patientId: rich,
        archiveId: a1!.id,
        preparedBy: users.titolare.id,
        type: 'I',
        visit: 'A',
        releaseDate: studioDate(clock.now()),
        startDate: studioDate(clock.now()),
        endDate: studioDate(clock.now()),
        residence: {
          street: 'Via di Prova',
          number: '1',
          postalCode: '10100',
          town: 'Torino',
          province: 'TO',
        },
      })
      .returning({ id: sickLeaveCertificate.id }),
  );

  const app = buildApp({
    db,
    config: { encryptionKey, sessionMaxHours: 12, cookieSecure: false },
    now: clock.now,
    ...appOptions,
    secondFactor,
  });
  return {
    db,
    app,
    clock,
    studioId,
    users,
    archives: { titolare: a1!.id, collega: a2!.id },
    patients: { titolare: p1, collega: p2 },
    richPatient: rich,
    draftPrescription: draft!.id,
    draftCertificate: certificate!.id,
    secrets: new Map(),
    encryptionKey,
    secondFactor,
  };
}

/** Accesso completo via HTTP: password, attivazione o verifica del secondo fattore. */
export async function login(s: Scenario, who: keyof Scenario['users']): Promise<string> {
  const user = s.users[who];
  const res = await s.app.inject({
    method: 'POST',
    url: '/api/accesso',
    payload: { username: user.username, password: PASSWORD, postazione: `postazione-${who}` },
  });
  if (res.statusCode !== 200) throw new Error(`Accesso di ${who} fallito: ${res.body}`);
  const body = res.json<{ passo: string; passaggio: string; segreto?: string }>();
  if (body.segreto) s.secrets.set(user.id, base32Decode(body.segreto));
  const secret = s.secrets.get(user.id)!;
  // Un codice vale una volta sola: ogni accesso usa l'intervallo successivo.
  s.clock.advance(30_000);
  const code = totp(secret, s.clock.now().getTime());
  const done = await s.app.inject({
    method: 'POST',
    url: '/api/accesso/codice',
    payload: { passaggio: body.passaggio, codice: code },
  });
  if (done.statusCode !== 200) throw new Error(`Secondo fattore di ${who} fallito: ${done.body}`);
  const cookie = done.cookies.find((c) => c.name === 'sessione');
  if (!cookie) throw new Error('Cookie di sessione mancante');
  return `sessione=${cookie.value}`;
}
