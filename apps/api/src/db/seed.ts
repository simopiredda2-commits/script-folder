/**
 * Dati dimostrativi per lo sviluppo: uno studio inventato, i suoi utenti e pazienti inventati.
 *
 *   pnpm db:seed
 *
 * Idempotente: se gli utenti dimostrativi esistono già, non fa nulla. Le password sono casuali
 * e si leggono solo qui, una volta: nessuna credenziale sta nel repository. Il secondo fattore
 * si attiva al primo accesso.
 */
import { randomBytes } from 'node:crypto';
import type { Role } from '@mmg/domain';
import { generatePatients, Random } from '@mmg/fixtures';
import { inArray } from 'drizzle-orm';
import { loadConfig } from '../config';
import { hashPassword } from '../security/password';
import { createDatabase, createPool } from './client';
import { runMigrations } from './migrate';
import {
  allergyDetail,
  appUser,
  archive,
  archiveGrant,
  clinicalEntry,
  diaryDetail,
  doctorProfile,
  exemption,
  measurementDetail,
  patient,
  problemDetail,
  studio,
  therapy,
} from './schema';
import { withActor } from './tx';

const DEMO_USERS: { username: string; displayName: string; roles: Role[] }[] = [
  {
    username: 'medico',
    displayName: 'Dott.ssa Elena Marchi',
    roles: ['owner_doctor', 'administrator'],
  },
  { username: 'segreteria', displayName: 'Lucia Bassi', roles: ['secretary'] },
  { username: 'sostituto', displayName: 'Dott. Marco Fiore', roles: ['substitute_doctor'] },
  { username: 'amministratore', displayName: 'Andrea Conti', roles: ['administrator'] },
];

/** Dati clinici inventati, scelti dal generatore deterministico. */
const PROBLEMS = [
  { code: '401.9', description: 'Ipertensione essenziale, non specificata' },
  { code: '250.00', description: 'Diabete mellito tipo 2 senza complicanze' },
  { code: '272.0', description: 'Ipercolesterolemia pura' },
];
const DRUGS = [
  'Farmaco dimostrativo A 5 mg',
  'Farmaco dimostrativo B 10 mg',
  'Farmaco dimostrativo C 20 mg',
];

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDatabase(pool);

try {
  await runMigrations(pool);
  const existing = await db
    .select({ username: appUser.username })
    .from(appUser)
    .where(
      inArray(
        appUser.username,
        DEMO_USERS.map((u) => u.username),
      ),
    );
  if (existing.length > 0) {
    console.log('Dati dimostrativi già presenti: niente da fare.');
    process.exit(0);
  }

  const [st] = await db
    .insert(studio)
    .values({ name: 'Studio medico dimostrativo', kind: 'single' })
    .returning();
  const passwords = new Map<string, string>();
  const users = new Map<string, string>();
  for (const u of DEMO_USERS) {
    const password = randomBytes(12).toString('base64url');
    passwords.set(u.username, password);
    const [row] = await db
      .insert(appUser)
      .values({ studioId: st!.id, ...u, passwordHash: await hashPassword(password) })
      .returning();
    users.set(u.username, row!.id);
  }
  const doctorId = users.get('medico')!;
  await db
    .insert(doctorProfile)
    .values({ userId: doctorId, regionalCode: 'DEMO-0001', asl: 'ASL dimostrativa' });
  const [arc] = await db
    .insert(archive)
    .values({ studioId: st!.id, ownerUserId: doctorId, name: 'Archivio della Dott.ssa Marchi' })
    .returning();
  const now = Date.now();
  await db.insert(archiveGrant).values({
    archiveId: arc!.id,
    granteeUserId: users.get('sostituto')!,
    kind: 'substitution',
    validFrom: new Date(now),
    validTo: new Date(now + 14 * 86_400_000),
    reason: 'Sostituzione dimostrativa di due settimane',
    grantedBy: doctorId,
  });

  const people = generatePatients({ seed: 'demo', count: 40 });
  const rnd = new Random('demo-clinica');
  await withActor(db, doctorId, async (tx) => {
    for (const p of people) {
      const [row] = await tx
        .insert(patient)
        .values({
          studioId: st!.id,
          archiveId: arc!.id,
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
        })
        .returning();
      const pid = row!.id;
      if (!rnd.chance(0.6)) continue;
      const entry = async (kind: typeof clinicalEntry.$inferInsert.kind, reserved = false) => {
        const [e] = await tx
          .insert(clinicalEntry)
          .values({
            patientId: pid,
            kind,
            occurredOn: '2026-10-15',
            authorUserId: doctorId,
            reserved,
          })
          .returning();
        return e!.id;
      };
      const problem = rnd.pick(PROBLEMS);
      const problemId = await entry('problem');
      await tx
        .insert(problemDetail)
        .values({ entryId: problemId, icdCode: problem.code, description: problem.description });
      await tx.insert(diaryDetail).values({
        entryId: await entry('diary'),
        contactType: 'office',
        text: 'Controllo periodico. Nota dimostrativa: paziente inventato.',
      });
      await tx.insert(measurementDetail).values({
        entryId: await entry('measurement'),
        measure: 'pressione_sistolica',
        value: String(rnd.int(115, 160)),
        unit: 'mmHg',
      });
      if (rnd.chance(0.3)) {
        await tx.insert(allergyDetail).values({
          entryId: await entry('allergy'),
          substance: 'Sostanza dimostrativa',
          drugRelated: true,
        });
      }
      if (rnd.chance(0.4)) {
        await tx
          .insert(exemption)
          .values({ patientId: pid, code: 'DEMO', validFrom: '2026-01-01', source: 'manual' });
      }
      await tx.insert(therapy).values({
        patientId: pid,
        drugName: rnd.pick(DRUGS),
        kind: 'chronic',
        startOn: '2026-01-01',
        dose: '1',
        doseUnit: 'compressa',
        frequency: 'una volta al giorno',
        indicationEntryId: problemId,
        reserved: rnd.chance(0.1),
        createdBy: doctorId,
      });
    }
  });

  console.log('Dati dimostrativi creati: studio, 4 utenti, 40 pazienti inventati.\n');
  console.log('Credenziali (mostrate solo ora; il secondo fattore si attiva al primo accesso):');
  for (const u of DEMO_USERS)
    console.log(`  ${u.username.padEnd(15)} ${passwords.get(u.username)}`);
} finally {
  await pool.end();
}
