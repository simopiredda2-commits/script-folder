/**
 * AURA nella dimostrazione (D223). Il simulatore di sempre (regola 7), con i pazienti dimostrativi
 * iscritti e collegati, e alcune variazioni come le manderebbe AURA, da vedere in «Oggi»:
 *
 * - un'esenzione nuova per un paziente diabetico;
 * - un'anagrafica diversa (l'ASL), da confermare;
 * - un decesso segnalato, da confermare;
 * - una scelta cessata, che fa revocato il paziente;
 * - un nuovo assistito che ha scelto il medico.
 *
 * Le variazioni dei pazienti si applicano prima che il servizio ascolti AURA, con due giri in fila
 * (il primo collega, il secondo porta le variazioni): PGlite ha una sola sessione, e più notifiche
 * insieme si sovrapporrebbero (`database.ts`). Il nuovo assistito arriva dopo, con una notifica
 * sola. Persone, date e codici fiscali sono inventati (regola 1). Il cambio di medico dentro lo
 * studio (D200) non c'è: lo studio dimostrativo ha un solo medico titolare.
 */
import { generatePatients } from '@mmg/fixtures';
import { SimulatedAura } from '@mmg/integrations';
import { count, eq, inArray, like } from 'drizzle-orm';
import { createAuraService } from '../../../api/src/aura/service';
import type { Database } from '../../../api/src/db/client';
import {
  appUser,
  auraNewPatient,
  clinicalEntry,
  doctorProfile,
  patient,
  problemDetail,
} from '../../../api/src/db/schema';
import { studioDate } from '../../../api/src/prescriptions/rules-check';
import type { AuraHints } from '../protocol';

/** ASL diversa da quella dei pazienti dimostrativi: mostra l'anagrafica da confermare. */
export const AURA_DEMO_ASL = 'ASL dimostrativa est';

/** Seme del nuovo assistito: sempre la stessa persona inventata. */
const NEW_PATIENT_SEED = 'nuovo-assistito-della-dimostrazione';

export interface AuraDemo {
  gateway: SimulatedAura;
  /** Prima di buildApp: iscrive e collega i pazienti, poi applica le loro variazioni. */
  beforeStart(db: Database): Promise<Omit<AuraHints, 'newPatient'>>;
  /** Dopo app.ready, con l'ascolto attivo: il nuovo assistito, con la sua notifica. */
  afterStart(db: Database, idle: () => Promise<void>): Promise<Pick<AuraHints, 'newPatient'>>;
}

const day = (offset: number) => studioDate(new Date(Date.now() + offset * 86_400_000));

async function doctorFiscalCode(db: Database) {
  const [owner] = await db
    .select({ fiscalCode: doctorProfile.fiscalCode })
    .from(doctorProfile)
    .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
    .where(eq(appUser.username, 'medico'));
  return owner!.fiscalCode!;
}

export function createAuraDemo(): AuraDemo {
  const gateway = new SimulatedAura();
  return {
    gateway,

    async beforeStart(db) {
      const rows = await db
        .select({
          id: patient.id,
          fiscalCode: patient.fiscalCode,
          lastName: patient.lastName,
          firstName: patient.firstName,
          birthDate: patient.birthDate,
        })
        .from(patient)
        .where(inArray(patient.status, ['active', 'temporary']))
        .orderBy(patient.birthDate, patient.lastName);
      // In AURA come nel programma: nessuna esenzione o scelta di AURA, così il primo giro collega
      // tutti senza variazioni.
      const auraIds = new Map<string, string>();
      for (const p of rows)
        auraIds.set(
          p.id,
          gateway.register({
            fiscalCode: p.fiscalCode,
            lastName: p.lastName,
            firstName: p.firstName,
            birthDate: p.birthDate,
            exemptions: [],
            choices: [],
          }),
        );
      const setup = createAuraService({
        db,
        gateway,
        environment: 'prova',
        now: () => new Date(),
      });
      await setup.syncAll('comando');

      const name = (id: string | undefined) => {
        const p = rows.find((r) => r.id === id);
        return p ? `${p.firstName} ${p.lastName}` : null;
      };
      const used = new Set<string>();
      const pick = (candidates: string[]) => {
        const id = candidates.find((c) => !used.has(c) && auraIds.has(c));
        if (id) used.add(id);
        return id;
      };

      // Un diabetico (ICD-9-CM 250.x) riceve da AURA l'esenzione 013 (diabete mellito).
      const diabetics = new Set(
        (
          await db
            .select({ id: clinicalEntry.patientId })
            .from(problemDetail)
            .innerJoin(clinicalEntry, eq(clinicalEntry.id, problemDetail.entryId))
            .where(like(problemDetail.icdCode, '250%'))
        ).map((d) => d.id),
      );
      // Il primo diabetico in ordine di età, come gli altri: sempre lo stesso a ogni avvio.
      const withExemption = pick(rows.map((r) => r.id).filter((id) => diabetics.has(id)));
      if (withExemption)
        gateway.setExemption(auraIds.get(withExemption)!, {
          code: '013',
          prescriptionCode: null,
          validFrom: day(-20),
          validTo: null,
        });

      // Gli altri dal più anziano: il decesso al più anziano, poi revoca e anagrafica.
      const byAge = rows.map((r) => r.id);
      const deceased = pick(byAge);
      if (deceased) gateway.setRegistry(auraIds.get(deceased)!, { deceasedOn: day(-1) });
      const revoked = pick(byAge);
      if (revoked)
        gateway.setChoice(auraIds.get(revoked)!, {
          doctorFiscalCode: await doctorFiscalCode(db),
          chosenOn: '2019-03-01',
          expiresOn: null,
          endedOn: day(-2),
          endReason: 'Scelta di un altro medico',
        });
      const registry = pick(byAge);
      if (registry) gateway.setRegistry(auraIds.get(registry)!, { asl: AURA_DEMO_ASL });

      // Il secondo giro porta le variazioni, una alla volta.
      await setup.syncAll('comando');
      return {
        exemption: name(withExemption),
        registry: name(registry),
        deceased: name(deceased),
        revoked: name(revoked),
      };
    },

    async afterStart(db, idle) {
      // Un nuovo assistito (inventato) sceglie il medico: arriva fra i nuovi assistiti in «Oggi».
      const [nuovo] = generatePatients({ seed: NEW_PATIENT_SEED, count: 1, minAge: 30 });
      const newId = gateway.register({
        fiscalCode: nuovo!.fiscalCode,
        lastName: nuovo!.lastName,
        firstName: nuovo!.firstName,
        birthDate: nuovo!.birthDate,
        exemptions: [],
        choices: [],
      });
      gateway.setChoice(newId, {
        doctorFiscalCode: await doctorFiscalCode(db),
        chosenOn: day(0),
        expiresOn: null,
        endedOn: null,
        endReason: null,
      });
      // La notifica si applica da sola, un momento dopo: «Oggi» si apre quando è dentro.
      for (let i = 0; i < 400; i++) {
        await idle();
        const [news] = await db.select({ n: count() }).from(auraNewPatient);
        if (news!.n >= 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await idle();
      return { newPatient: `${nuovo!.firstName} ${nuovo!.lastName}` };
    },
  };
}
