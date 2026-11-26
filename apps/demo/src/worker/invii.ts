/**
 * Invii rimasti senza risposta nella dimostrazione (D233). Una ricetta e un certificato di
 * malattia sono «in invio» da 20 minuti, come se il servizio si fosse fermato mentre aspettava il
 * SAR e l'INPS: firmati dal medico, senza esito. Il medico ne segna l'esito chiesto all'ente, nella
 * pagina Ricette («Invii senza risposta») e nella scheda del certificato.
 *
 * Nella dimostrazione il servizio non si ferma: lo stato si scrive nel database prima dell'avvio,
 * come fanno le prove del servizio. Prima di AURA (aura.ts): con una ricetta aperta il paziente
 * non riceve il cambio di medico, che lo spostamento fermerebbe (D200). Paziente inventato
 * (regola 1), nessun invio vero (regola 7).
 */
import { rulesetAt } from '@mmg/rules';
import { and, desc, eq, like } from 'drizzle-orm';
import type { Database } from '../../../api/src/db/client';
import {
  appUser,
  archive,
  clinicalEntry,
  patient,
  prescription,
  prescriptionCheck,
  prescriptionLine,
  problemDetail,
  sickLeaveCertificate,
  therapy,
} from '../../../api/src/db/schema';
import { withActor } from '../../../api/src/db/tx';
import { archiveRegion, studioDate } from '../../../api/src/prescriptions/rules-check';
import type { InterruptedHints } from '../protocol';
import { withOpenItems } from './aura';

/** Da quanto sono «in invio»: oltre i 15 minuti dopo i quali si segna l'esito (D233). */
const STUCK_FOR_MINUTES = 20;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Il paziente più giovane del medico senza ricette né certificati aperti, non diabetico (AURA dà
 * l'esenzione a un diabetico) e con una terapia cronica attiva: la riga della ricetta.
 */
export async function prepareInterruptedSends(db: Database): Promise<InterruptedHints> {
  const [doctor] = await db.select().from(appUser).where(eq(appUser.username, 'medico'));
  const [own] = await db
    .select({ id: archive.id })
    .from(archive)
    .where(eq(archive.ownerUserId, doctor!.id));
  const open = await withOpenItems(db);
  const diabetics = new Set(
    (
      await db
        .select({ id: clinicalEntry.patientId })
        .from(problemDetail)
        .innerJoin(clinicalEntry, eq(clinicalEntry.id, problemDetail.entryId))
        .where(like(problemDetail.icdCode, '250%'))
    ).map((d) => d.id),
  );
  const rows = await db
    .select({ p: patient, t: therapy })
    .from(patient)
    .innerJoin(therapy, eq(therapy.patientId, patient.id))
    .where(
      and(
        eq(patient.archiveId, own!.id),
        eq(patient.status, 'active'),
        eq(therapy.kind, 'chronic'),
        eq(therapy.status, 'active'),
      ),
    )
    .orderBy(desc(patient.birthDate), patient.lastName, patient.firstName, therapy.drugName);
  const chosen = rows.find((r) => !open.has(r.p.id) && !diabetics.has(r.p.id));
  if (!chosen) throw new Error('Nessun paziente dimostrativo per gli invii senza risposta');
  const { p, t } = chosen;
  // Una seconda ricetta «in invio», di un altro paziente, per la ricetta rossa (D270): la prima
  // resta per «È arrivata».
  const second = rows.find((r) => r.p.id !== p.id && !open.has(r.p.id) && !diabetics.has(r.p.id));
  if (!second) throw new Error('Nessun paziente dimostrativo per la ricetta rossa');

  const signedAt = new Date(Date.now() - STUCK_FOR_MINUTES * 60_000);
  // Preparati e controllati prima della firma, come nel servizio (D239): l'ordine delle ore è
  // quello di un invio vero.
  const preparedAt = new Date(signedAt.getTime() - 10 * 60_000);
  const checkedAt = new Date(signedAt.getTime() - 60_000);
  const day = studioDate(signedAt);
  // La versione delle regole con le aggiunte della regione dello studio, come nel controllo (D296).
  const rulesVersion = rulesetAt(day, undefined, await archiveRegion(db, own!.id)).version;
  await withActor(db, doctor!.id, async (tx) => {
    const [red] = await tx
      .insert(prescription)
      .values({
        patientId: second.p.id,
        archiveId: own!.id,
        kind: 'pharma_ssn',
        status: 'sending',
        preparedBy: doctor!.id,
        preparedAt,
        signedBy: doctor!.id,
        signedAt,
      })
      .returning({ id: prescription.id });
    await tx.insert(prescriptionCheck).values({
      prescriptionId: red!.id,
      userId: doctor!.id,
      at: checkedAt,
      rulesVersion,
      outcome: 'superato',
      issues: [],
      reasons: {},
      confirmedAifaNotes: [],
    });
    await tx.insert(prescriptionLine).values({
      prescriptionId: red!.id,
      position: 1,
      therapyId: second.t.id,
      drugAic: second.t.drugAic,
      drugName: second.t.drugName,
      activeIngredient: second.t.activeIngredient,
      byActiveIngredient: second.t.byActiveIngredient,
      quantity: 1,
    });
    const [rx] = await tx
      .insert(prescription)
      .values({
        patientId: p.id,
        archiveId: own!.id,
        kind: 'pharma_ssn',
        status: 'sending',
        preparedBy: doctor!.id,
        preparedAt,
        signedBy: doctor!.id,
        signedAt,
      })
      .returning({ id: prescription.id });
    // Il controllo delle regole prima dell'invio, con la versione in vigore quel giorno: la
    // ricetta segnata come arrivata la porta con sé.
    await tx.insert(prescriptionCheck).values({
      prescriptionId: rx!.id,
      userId: doctor!.id,
      at: checkedAt,
      rulesVersion,
      outcome: 'superato',
      issues: [],
      reasons: {},
      confirmedAifaNotes: [],
    });
    await tx.insert(prescriptionLine).values({
      prescriptionId: rx!.id,
      position: 1,
      therapyId: t.id,
      drugAic: t.drugAic,
      drugName: t.drugName,
      activeIngredient: t.activeIngredient,
      byActiveIngredient: t.byActiveIngredient,
      quantity: 1,
    });
    await tx.insert(sickLeaveCertificate).values({
      patientId: p.id,
      archiveId: own!.id,
      status: 'sending',
      type: 'I',
      visit: 'A',
      releaseDate: day,
      startDate: day,
      endDate: addDays(day, 2),
      diagnosisCode: '487.1',
      diagnosisNotes: 'Sindrome influenzale (dimostrazione)',
      residence: {
        street: p.residenceStreet ?? '',
        number: p.residenceNumber ?? '',
        postalCode: p.residencePostalCode ?? '',
        town: p.residenceTown ?? '',
        province: (p.residenceProvince ?? '').toUpperCase(),
      },
      preparedBy: doctor!.id,
      signedBy: doctor!.id,
      signedAt,
      createdAt: preparedAt,
    });
  });
  return {
    patient: `${p.firstName} ${p.lastName}`,
    doctor: doctor!.displayName,
    redPatient: `${second.p.firstName} ${second.p.lastName}`,
  };
}
