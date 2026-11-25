/**
 * Colleghi nella dimostrazione (D227).
 *
 * - **Una collega titolare nello stesso studio**, che così è una medicina di gruppo. Un paziente
 *   della Dott.ssa Marchi la sceglie in AURA (aura.ts): il cambio di medico dentro lo studio (D200)
 *   si decide in «Oggi».
 * - **Un altro studio, nella stessa AFT** della Dott.ssa Marchi, con il suo medico e un paziente che
 *   ha dato il consenso alla condivisione. La Dott.ssa Marchi consulta la sua scheda in Strumenti ›
 *   AFT (D161). Il medico dell'altro studio condivide i suoi pazienti; la Dott.ssa Marchi, come per
 *   difetto, no: lo può provare chi entra.
 *
 * Persone, studi e codici inventati (regola 1): luogo di nascita con la X, che nessun comune ha.
 * Tutto passa dai servizi del programma (AFT, voci, consensi), come lo farebbero i medici.
 */
import { buildFiscalCode, type Role } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { and, eq, isNull } from 'drizzle-orm';
import { createAftService } from '../../../api/src/aft/service';
import type { Actor } from '../../../api/src/auth/service';
import { insertEntry } from '../../../api/src/clinical/entries';
import type { Database } from '../../../api/src/db/client';
import {
  aftMember,
  appUser,
  archive,
  doctorProfile,
  patient,
  studio,
  therapy,
  workstation,
} from '../../../api/src/db/schema';
import { withActor } from '../../../api/src/db/tx';
import { insertConsent } from '../../../api/src/patients/privacy';
import { studioDate } from '../../../api/src/prescriptions/rules-check';
import { hashPassword } from '../../../api/src/security/password';
import type { AftHints } from '../protocol';

/** Gli utenti in più, con una nota per il riquadro: dove lavorano. */
export const COLLEAGUE_USERS: {
  username: string;
  displayName: string;
  roles: Role[];
  note: string;
}[] = [
  {
    username: 'collega',
    displayName: 'Dott.ssa Sara Galli',
    roles: ['owner_doctor'],
    note: 'nello stesso studio',
  },
  {
    username: 'medico.aft',
    displayName: 'Dott. Luca Rinaldi',
    roles: ['owner_doctor'],
    note: 'in un altro studio dell’AFT',
  },
];

const OTHER_STUDIO = 'Studio medico dimostrativo dell’AFT';
const AFT_NAME = 'AFT dimostrativa';
/** Seme del paziente dell'altro studio: sempre la stessa persona inventata. */
const AFT_PATIENT_SEED = 'paziente-dell-aft-della-dimostrazione';

const day = (offset: number) => studioDate(new Date(Date.now() + offset * 86_400_000));

function actorOf(u: typeof appUser.$inferSelect): Actor {
  return {
    userId: u.id,
    studioId: u.studioId,
    roles: u.roles,
    displayName: u.displayName,
    sessionId: 'dimostrazione',
    workstation: 'Ambulatorio',
    mustChangePassword: false,
  };
}

export interface Colleagues {
  /** Codice fiscale della collega: AURA lo usa per la scelta del paziente che cambia medico. */
  colleagueFiscalCode: string;
  colleagueName: string;
  aft: AftHints;
}

/** Dopo i dati dimostrativi e prima di AURA: colleghi, altro studio, paziente con il consenso, AFT. */
export async function prepareColleagues(db: Database, password: string): Promise<Colleagues> {
  const [owner] = await db.select().from(appUser).where(eq(appUser.username, 'medico'));
  const demoStudio = owner!.studioId;
  const passwordHash = await hashPassword(password);
  const user = (studioId: string, username: string) => {
    const u = COLLEAGUE_USERS.find((c) => c.username === username)!;
    return db
      .insert(appUser)
      .values({
        studioId,
        username: u.username,
        displayName: u.displayName,
        roles: u.roles,
        passwordHash,
      })
      .returning();
  };

  // La collega titolare: con due titolari attivi lo studio è una medicina di gruppo (come lo
  // vuole Strumenti › Studio), e lei ha il suo archivio.
  await db.update(studio).set({ kind: 'group' }).where(eq(studio.id, demoStudio));
  const [colleague] = await user(demoStudio, 'collega');
  const colleagueFiscalCode = buildFiscalCode({
    surname: 'Galli',
    name: 'Sara',
    birthDate: '1975-05-12',
    sex: 'F',
    placeCode: 'X001',
  });
  await db.insert(doctorProfile).values({
    userId: colleague!.id,
    regionalCode: 'DEMO-0003',
    asl: 'ASL dimostrativa',
    aslCode: '301',
    firstName: 'Sara',
    lastName: 'Galli',
    phone: '000 0000003',
    fiscalCode: colleagueFiscalCode,
  });
  await db.insert(archive).values({
    studioId: demoStudio,
    ownerUserId: colleague!.id,
    name: 'Archivio della Dott.ssa Galli',
  });

  // L'altro studio dell'AFT, con i dati inventati come quelli del primo (D12).
  const [other] = await db
    .insert(studio)
    .values({
      name: OTHER_STUDIO,
      kind: 'single',
      regionName: 'PIEMONTE',
      address: 'Via dell’Esempio 2',
      postalCode: '00000',
      municipality: 'Comune di prova',
      province: 'TO',
      phone: '000 0000010',
      email: 'studio.aft@example.org',
    })
    .returning();
  await db.insert(workstation).values({ studioId: other!.id, name: 'Ambulatorio', shared: true });
  const [aftDoctor] = await user(other!.id, 'medico.aft');
  await db.insert(doctorProfile).values({
    userId: aftDoctor!.id,
    regionalCode: 'DEMO-0101',
    asl: 'ASL dimostrativa',
    aslCode: '301',
    firstName: 'Luca',
    lastName: 'Rinaldi',
    phone: '000 0000011',
    fiscalCode: buildFiscalCode({
      surname: 'Rinaldi',
      name: 'Luca',
      birthDate: '1968-09-03',
      sex: 'M',
      placeCode: 'X001',
    }),
  });
  const [otherArchive] = await db
    .insert(archive)
    .values({ studioId: other!.id, ownerUserId: aftDoctor!.id, name: 'Archivio del Dott. Rinaldi' })
    .returning();

  // Il suo paziente: allergia, ipertensione, terapia; consenso alla condivisione, anche dei dati
  // di prima.
  const [p] = generatePatients({ seed: AFT_PATIENT_SEED, count: 1, minAge: 55 });
  await withActor(db, aftDoctor!.id, async (tx) => {
    const [row] = await tx
      .insert(patient)
      .values({
        studioId: other!.id,
        archiveId: otherArchive!.id,
        lastName: p!.lastName,
        firstName: p!.firstName,
        sex: p!.sex,
        birthDate: p!.birthDate,
        fiscalCode: p!.fiscalCode,
      })
      .returning({ id: patient.id });
    const id = row!.id;
    await insertEntry(tx, id, aftDoctor!.id, {
      tipo: 'allergia',
      data: day(-400),
      sostanza: 'Penicillina',
      reazione: 'Orticaria',
      daFarmaco: true,
      natura: 'allergia',
    });
    await insertEntry(tx, id, aftDoctor!.id, {
      tipo: 'problema',
      data: day(-900),
      descrizione: 'Ipertensione arteriosa essenziale',
      codice: '401.9',
      stato: 'attivo',
      cronico: true,
      categoria: 'diagnosi',
    });
    await tx.insert(therapy).values({
      patientId: id,
      drugName: 'Amlodipina 5 mg compresse',
      activeIngredient: 'AMLODIPINA',
      byActiveIngredient: true,
      kind: 'chronic',
      startOn: day(-880),
      createdBy: aftDoctor!.id,
    });
    for (const tipo of ['aft_condivisione', 'aft_condivisione_pregressi'] as const)
      await insertConsent(
        tx,
        id,
        aftDoctor!.id,
        { tipo, stato: 'dato', data: day(-30) },
        new Date(),
      );
  });

  // L'AFT: la Dott.ssa Marchi la crea e invita il Dott. Rinaldi, che accetta e condivide.
  const aft = createAftService({ db, now: () => new Date() });
  const aftId = await aft.create(actorOf(owner!), { nome: AFT_NAME });
  await aft.invite(actorOf(owner!), aftId, { codiceRegionale: 'DEMO-0101' });
  const [invitation] = await db
    .select({ id: aftMember.id })
    .from(aftMember)
    .where(
      and(
        eq(aftMember.aftId, aftId),
        eq(aftMember.userId, aftDoctor!.id),
        isNull(aftMember.joinedAt),
      ),
    );
  await aft.respond(actorOf(aftDoctor!), invitation!.id, true);
  await aft.setSharing(actorOf(aftDoctor!), aftId, true);

  return {
    colleagueFiscalCode,
    colleagueName: colleague!.displayName,
    aft: {
      name: AFT_NAME,
      colleague: aftDoctor!.displayName,
      studio: OTHER_STUDIO,
      patient: `${p!.firstName} ${p!.lastName}`,
      fiscalCode: p!.fiscalCode,
    },
  };
}
