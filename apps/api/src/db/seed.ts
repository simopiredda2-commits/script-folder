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
import { buildFiscalCode, type Role } from '@mmg/domain';
import { generatePatients, Random } from '@mmg/fixtures';
import { inArray } from 'drizzle-orm';
import { loadConfig } from '../config';
import { storeCredentials } from '../credentials/service';
import { startOfStudioDay } from '../http/today-routes';
import { studioDate } from '../prescriptions/rules-check';
import { hashPassword } from '../security/password';
import { createDatabase, createPool } from './client';
import { runMigrations } from './migrate';
import {
  allergyDetail,
  appointment,
  appUser,
  archive,
  archiveGrant,
  clinicalEntry,
  diaryDetail,
  doctorProfile,
  exemption,
  labResultDetail,
  measurementDetail,
  patient,
  prescription,
  prescriptionLine,
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
// Con principio attivo: la ricetta lo riporta sempre (R13). Il primo è un farmaco della banca dati
// d'esempio (pnpm banche-dati:importa -- --esempio), con il suo AIC.
const DRUGS = [
  {
    drugName: 'PROVALINA 28 compresse 5 mg',
    drugAic: '900000011',
    activeIngredient: 'principio di prova',
  },
  {
    drugName: 'Farmaco dimostrativo B 10 mg',
    drugAic: null,
    activeIngredient: 'principio dimostrativo B',
  },
  {
    drugName: 'Farmaco dimostrativo C 20 mg',
    drugAic: null,
    activeIngredient: 'principio dimostrativo C',
  },
];
/** Primi pazienti con un appuntamento oggi, ogni quarto d'ora dalle 8:30. */
const APPOINTMENTS_TODAY = 8;
const QUARTER_MS = 15 * 60_000;
const FIRST_APPOINTMENT_MS = 8.5 * 3_600_000;
/** Pazienti per cui la segreteria ha preparato una ricetta da firmare. */
const TO_SIGN = 3;

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
    .values({ name: 'Studio medico dimostrativo', kind: 'single', regionName: 'PIEMONTE' })
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
  await db.insert(doctorProfile).values({
    userId: doctorId,
    regionalCode: 'DEMO-0001',
    asl: 'ASL dimostrativa',
    // Recapiti inventati, su domini riservati agli esempi (.invalid).
    firstName: 'Elena',
    lastName: 'Marchi',
    phone: '000 0000001',
    email: 'studio.marchi@esempio.invalid',
    pec: 'elena.marchi@pec.esempio.invalid',
    // Inventato: luogo di nascita con la X, che nessun comune ha (D12).
    fiscalCode: buildFiscalCode({
      surname: 'Marchi',
      name: 'Elena',
      birthDate: '1970-01-01',
      sex: 'F',
      placeCode: 'X001',
    }),
  });
  // Anche il sostituto firma a nome suo: gli serve il profilo con il codice fiscale (inventato).
  await db.insert(doctorProfile).values({
    userId: users.get('sostituto')!,
    regionalCode: 'DEMO-0002',
    asl: 'ASL dimostrativa',
    firstName: 'Marco',
    lastName: 'Fiore',
    phone: '000 0000002',
    fiscalCode: buildFiscalCode({
      surname: 'Fiore',
      name: 'Marco',
      birthDate: '1970-01-01',
      sex: 'M',
      placeCode: 'X001',
    }),
  });
  // Credenziali dei servizi inventate (D100): i simulatori ne controllano solo la forma. La
  // password RUPAR del medico risulta cambiata 80 giorni fa, per mostrare l'avviso di scadenza.
  const daysAgo = (n: number) => studioDate(new Date(Date.now() - n * 86_400_000));
  for (const [username, ruparChangedOn] of [
    ['medico', daysAgo(80)],
    ['sostituto', daysAgo(0)],
  ] as const) {
    for (const service of ['sistema_ts', 'rupar_piemonte'] as const) {
      await storeCredentials(db, config.encryptionKey, {
        userId: users.get(username)!,
        service,
        secret: {
          username: `${service === 'sistema_ts' ? 'TS' : 'RUPAR'}-DEMO-${username.toUpperCase()}`,
          password: randomBytes(12).toString('base64url'),
          pin: String(randomBytes(2).readUInt16BE() % 10_000).padStart(4, '0'),
        },
        passwordChangedOn: service === 'rupar_piemonte' ? ruparChangedOn : daysAgo(0),
      });
    }
  }
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
  const midnight = startOfStudioDay(studioDate(new Date())).getTime();
  const secretaryId = users.get('segreteria')!;
  const toSign: { patientId: string; therapyId: string; drug: (typeof DRUGS)[number] }[] = [];
  await withActor(db, doctorId, async (tx) => {
    for (const [index, p] of people.entries()) {
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
      if (index < APPOINTMENTS_TODAY) {
        const startsAt = new Date(midnight + FIRST_APPOINTMENT_MS + index * QUARTER_MS);
        await tx.insert(appointment).values({
          studioId: st!.id,
          patientId: pid,
          doctorUserId: doctorId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + QUARTER_MS),
          kind: index % 4 === 3 ? 'home' : 'office',
          notes: 'Appuntamento dimostrativo',
          createdBy: secretaryId,
        });
      }
      if (index >= APPOINTMENTS_TODAY && !rnd.chance(0.6)) continue;
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
        measure: 'Pressione sistolica',
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
      if (rnd.chance(0.4)) {
        for (const [occurredOn, value] of [
          ['2026-05-12', String(rnd.int(80, 130))],
          ['2026-11-10', String(rnd.int(80, 130))],
        ]) {
          const [lab] = await tx
            .insert(clinicalEntry)
            .values({
              patientId: pid,
              kind: 'lab_result',
              occurredOn: occurredOn!,
              authorUserId: doctorId,
            })
            .returning();
          await tx.insert(labResultDetail).values({
            entryId: lab!.id,
            analyte: 'Esame dimostrativo',
            value: value!,
            unit: 'unità',
            referenceText: 'intervallo dimostrativo',
          });
        }
      }
      const drug = rnd.pick(DRUGS);
      const [ther] = await tx
        .insert(therapy)
        .values({
          patientId: pid,
          ...drug,
          kind: 'chronic',
          startOn: '2026-01-01',
          dose: '1',
          doseUnit: 'compressa',
          frequency: 'una volta al giorno',
          indicationEntryId: problemId,
          reserved: rnd.chance(0.1),
          createdBy: doctorId,
        })
        .returning();
      if (toSign.length < TO_SIGN && !ther!.reserved) {
        toSign.push({ patientId: pid, therapyId: ther!.id, drug });
      }
    }
  });

  // Ripetizioni preparate dalla segreteria, in attesa della firma del medico.
  await withActor(db, secretaryId, async (tx) => {
    for (const r of toSign) {
      const [rx] = await tx
        .insert(prescription)
        .values({
          patientId: r.patientId,
          archiveId: arc!.id,
          kind: 'pharma_ssn',
          status: 'to_sign',
          preparedBy: secretaryId,
        })
        .returning();
      await tx.insert(prescriptionLine).values({
        prescriptionId: rx!.id,
        position: 1,
        therapyId: r.therapyId,
        drugAic: r.drug.drugAic,
        drugName: r.drug.drugName,
        activeIngredient: r.drug.activeIngredient,
        quantity: 1,
        posologyText: '1 compressa una volta al giorno',
      });
    }
  });

  console.log(
    `Dati dimostrativi creati: studio, 4 utenti, 40 pazienti inventati, ${APPOINTMENTS_TODAY} appuntamenti oggi, ${toSign.length} ricette da firmare.`,
  );
  console.log('Banche dati d’esempio: pnpm banche-dati:importa -- --esempio\n');
  console.log('Credenziali (mostrate solo ora; il secondo fattore si attiva al primo accesso):');
  for (const u of DEMO_USERS)
    console.log(`  ${u.username.padEnd(15)} ${passwords.get(u.username)}`);
} finally {
  await pool.end();
}
