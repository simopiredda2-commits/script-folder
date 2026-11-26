/**
 * Ricette già inviate nella dimostrazione (D256). Ogni paziente del medico con terapie croniche
 * ha una ricetta mandata nei giorni scorsi per le sue terapie, già archiviata dalla pagina Ricette
 * (D254). Così i farmaci prescritti mostrano la data e le confezioni dell'ultima ricetta
 * (D249) e lo storico del paziente ha le ricette con l'NRE e il promemoria.
 *
 * Come gli invii rimasti senza risposta (invii.ts), lo stato si scrive nel database prima
 * dell'avvio. L'NRE e il codice di autenticazione sono del simulatore («SIM»), di una serie che
 * il simulatore non usa per i nuovi invii. Pazienti inventati (regola 1), nessun invio vero
 * (regola 7).
 */
import { rulesetAt } from '@mmg/rules';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../../api/src/db/client';
import {
  appUser,
  archive,
  patient,
  prescription,
  prescriptionCheck,
  prescriptionLine,
  therapy,
} from '../../../api/src/db/schema';
import { withActor } from '../../../api/src/db/tx';
import { studioDate } from '../../../api/src/prescriptions/rules-check';
import { archiveRegion } from '../../../api/src/regions/region';

const DAY = 86_400_000;
/**
 * Quanti giorni indietro si può andare: una ricetta inviata dal programma ha il controllo delle
 * regole in vigore quel giorno, quindi non è più vecchia della prima versione delle regole. Prima
 * ci sono le ricette fatte con un altro programma, già nei dati dimostrativi (D176).
 */
function daysWithRules(now: number): number {
  let back = 0;
  for (let d = 1; d <= 70; d++) {
    try {
      rulesetAt(studioDate(new Date(now - d * DAY)));
      back = d;
    } catch {
      break;
    }
  }
  return back;
}
/** Una serie di NRE che il simulatore non raggiunge: parte da 9 miliardi di miliardi. */
const nre = (n: number) => `SIMR9${String(n).padStart(11, '0')}`;
const authCode = (n: number) => `SIMAUT9${String(n).padStart(23, '0')}`;

export async function prepareSentPrescriptions(db: Database): Promise<number> {
  const [doctor] = await db.select().from(appUser).where(eq(appUser.username, 'medico'));
  const [own] = await db
    .select({ id: archive.id })
    .from(archive)
    .where(eq(archive.ownerUserId, doctor!.id));
  // La versione delle regole con le aggiunte della regione dello studio, come nel controllo (D296).
  const region = await archiveRegion(db, own!.id);
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
    .orderBy(asc(patient.lastName), asc(patient.firstName), asc(therapy.drugName));
  const byPatient = new Map<
    string,
    { p: typeof patient.$inferSelect; ts: (typeof rows)[number]['t'][] }
  >();
  for (const r of rows) {
    const entry = byPatient.get(r.p.id) ?? { p: r.p, ts: [] };
    entry.ts.push(r.t);
    byPatient.set(r.p.id, entry);
  }

  const now = Date.now();
  const back = daysWithRules(now);
  if (back === 0) return 0;
  let count = 0;
  await withActor(db, doctor!.id, async (tx) => {
    for (const [i, { ts }] of [...byPatient.values()].entries()) {
      // Distribuite sui giorni con le regole, da ieri all'indietro; mai oggi.
      const sentAt = new Date(now - (1 + ((i * 3) % back)) * DAY);
      // Preparata e controllata poco prima della firma, archiviata il giorno dopo.
      const preparedAt = new Date(sentAt.getTime() - 10 * 60_000);
      const checkedAt = new Date(sentAt.getTime() - 60_000);
      const archivedAt = new Date(Math.min(sentAt.getTime() + DAY, now - 60_000));
      const version = rulesetAt(studioDate(sentAt), undefined, region).version;
      count += 1;
      const [rx] = await tx
        .insert(prescription)
        .values({
          patientId: ts[0]!.patientId,
          archiveId: own!.id,
          kind: 'pharma_ssn',
          status: 'sent',
          nre: nre(count),
          authCode: authCode(count),
          sacDoctorName: doctor!.displayName,
          preparedBy: doctor!.id,
          preparedAt,
          signedBy: doctor!.id,
          signedAt: sentAt,
          sentAt,
          rulesVersion: version,
          archivedAt,
          archivedBy: doctor!.id,
        })
        .returning({ id: prescription.id });
      await tx.insert(prescriptionCheck).values({
        prescriptionId: rx!.id,
        userId: doctor!.id,
        at: checkedAt,
        rulesVersion: version,
        outcome: 'superato',
        issues: [],
        reasons: {},
        confirmedAifaNotes: [],
      });
      // Una riga per terapia, al massimo due: una o due confezioni, alternate fra i pazienti.
      for (const [k, t] of ts.slice(0, 2).entries())
        await tx.insert(prescriptionLine).values({
          prescriptionId: rx!.id,
          position: k + 1,
          therapyId: t.id,
          drugAic: t.drugAic,
          drugName: t.drugName,
          activeIngredient: t.activeIngredient,
          byActiveIngredient: t.byActiveIngredient,
          quantity: 1 + ((i + k) % 2),
        });
    }
  });
  return count;
}
