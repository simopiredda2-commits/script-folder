import type { AuraExemption, AuraGateway, AuraProfile, AuraRegistry } from '@mmg/integrations';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  archive,
  auraChange,
  auraDoctorChange,
  auraLink,
  auraNewPatient,
  auraSyncRun,
  auraSyncRunStudio,
  doctorProfile,
  exemption,
  patient,
  patientArchiveMove,
  patientChoice,
  prescription,
  sickLeaveCertificate,
} from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { studioDate } from '../prescriptions/rules-check';
import {
  registryDifferences,
  registryText,
  sameRegistry,
  type RegistryDifference,
} from './registry';
import { unrefTimer } from '../timers';

/**
 * Esenzioni e scelte del medico dall'anagrafe regionale AURA (D197). AURA è la fonte: le righe che
 * ne arrivano hanno la provenienza «AURA», nello studio non si modificano, e a ogni controllo si
 * allineano a quello che AURA dice adesso (nuove, cambiate, tolte). Una riga tolta in AURA non si
 * cancella: resta annullata, con il motivo. Le righe inserite a mano non si toccano. Ogni variazione
 * resta in `aura_change`, in parole.
 */

/** Motivo dell'annullamento di una riga che non c'è più in AURA. */
export const NOT_IN_AURA = 'Non c’è più in AURA';

export type AuraTrigger = 'notte' | 'notifica' | 'manuale' | 'ricetta';
export type AuraOutcome =
  'aggiornato' | 'non_trovato' | 'ambiguo' | 'non_raggiungibile' | 'rifiutato' | 'spento';

export interface AuraDeps {
  db: Database;
  gateway: AuraGateway;
  /** «prova» o «produzione» (D170): in produzione il simulatore non vale come AURA. */
  environment: string;
  now: () => Date;
}

export interface SyncResult {
  outcome: AuraOutcome;
  message: string | null;
  changes: number;
}

/** In produzione con il simulatore AURA è spenta: i dati del simulatore non sono veri. */
export const auraAvailable = (deps: Pick<AuraDeps, 'environment' | 'gateway'>) =>
  !(deps.environment === 'produzione' && deps.gateway.environment === 'simulator');

export const AURA_UNAVAILABLE =
  'AURA non è ancora collegata al servizio vero: esenzioni e scelte si inseriscono a mano';

const itDate = (iso: string) => iso.split('-').reverse().join('/');

/** Un'esenzione in parole, come la dice AURA. */
export function exemptionText(e: AuraExemption): string {
  const code =
    e.prescriptionCode && e.prescriptionCode !== e.code
      ? ` (in ricetta ${e.prescriptionCode})`
      : '';
  return `Esenzione ${e.code}${code} dal ${itDate(e.validFrom)}${e.validTo ? ` al ${itDate(e.validTo)}` : ', senza scadenza'}`;
}

function choiceText(
  doctor: string,
  c: {
    chosenOn: string;
    expiresOn: string | null;
    endedOn: string | null;
    endReason: string | null;
  },
): string {
  const end = c.endedOn
    ? `, cessata il ${itDate(c.endedOn)}${c.endReason ? ` (${c.endReason})` : ''}`
    : c.expiresOn
      ? `, in scadenza il ${itDate(c.expiresOn)}`
      : '';
  return `Scelta di ${doctor} dal ${itDate(c.chosenOn)}${end}`;
}

interface Change {
  kind: 'esenzione' | 'scelta' | 'anagrafica' | 'stato' | 'archivio';
  change: 'nuova' | 'cambiata' | 'tolta';
  subject: string;
  description: string;
}

/** Allinea le righe di AURA del paziente al profilo; restituisce le variazioni. */
async function reconcile(
  tx: Tx,
  p: { id: string; studioId: string },
  profile: AuraProfile,
  by: { at: Date; userId: string | null },
): Promise<Change[]> {
  const changes: Change[] = [];
  const annul = { annulledAt: by.at, annulledBy: by.userId, annulReason: NOT_IN_AURA };

  // Esenzioni: una riga per codice e data d'inizio.
  const key = (code: string, from: string) => `${code}|${from}`;
  const have = new Map(
    (
      await tx
        .select()
        .from(exemption)
        .where(
          and(
            eq(exemption.patientId, p.id),
            eq(exemption.source, 'aura'),
            isNull(exemption.annulledAt),
          ),
        )
    ).map((e) => [key(e.code, e.validFrom), e]),
  );
  const seen = new Set<string>();
  for (const e of profile.exemptions) {
    const k = key(e.code, e.validFrom);
    seen.add(k);
    const row = have.get(k);
    if (!row) {
      await tx.insert(exemption).values({
        patientId: p.id,
        code: e.code,
        validFrom: e.validFrom,
        validTo: e.validTo,
        prescriptionCode: e.prescriptionCode,
        source: 'aura',
      });
      changes.push({
        kind: 'esenzione',
        change: 'nuova',
        subject: e.code,
        description: exemptionText(e),
      });
    } else if (row.validTo !== e.validTo || row.prescriptionCode !== e.prescriptionCode) {
      await tx
        .update(exemption)
        .set({ validTo: e.validTo, prescriptionCode: e.prescriptionCode })
        .where(eq(exemption.id, row.id));
      changes.push({
        kind: 'esenzione',
        change: 'cambiata',
        subject: e.code,
        description: exemptionText(e),
      });
    }
  }
  for (const [k, row] of have) {
    if (seen.has(k)) continue;
    await tx.update(exemption).set(annul).where(eq(exemption.id, row.id));
    changes.push({
      kind: 'esenzione',
      change: 'tolta',
      subject: row.code,
      description: `${exemptionText({ code: row.code, prescriptionCode: row.prescriptionCode, validFrom: row.validFrom, validTo: row.validTo })}: non c’è più in AURA`,
    });
  }

  // Scelte: solo quelle con un medico dello studio, riconosciuto dal codice fiscale.
  const doctors = await tx
    .select({
      userId: doctorProfile.userId,
      fiscalCode: doctorProfile.fiscalCode,
      name: appUser.displayName,
    })
    .from(doctorProfile)
    .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
    .where(and(eq(appUser.studioId, p.studioId), isNotNull(doctorProfile.fiscalCode)));
  const byCf = new Map(doctors.map((d) => [d.fiscalCode!.toUpperCase(), d]));
  const nameOf = new Map(doctors.map((d) => [d.userId, d.name]));
  const ckey = (doctor: string, on: string) => `${doctor}|${on}`;
  const haveChoices = new Map(
    (
      await tx
        .select()
        .from(patientChoice)
        .where(
          and(
            eq(patientChoice.patientId, p.id),
            eq(patientChoice.source, 'aura'),
            isNull(patientChoice.annulledAt),
          ),
        )
    ).map((c) => [ckey(c.doctorUserId, c.chosenOn), c]),
  );
  const seenChoices = new Set<string>();
  for (const c of profile.choices) {
    const d = byCf.get(c.doctorFiscalCode.toUpperCase());
    if (!d) continue;
    const k = ckey(d.userId, c.chosenOn);
    seenChoices.add(k);
    const row = haveChoices.get(k);
    if (!row) {
      await tx.insert(patientChoice).values({
        patientId: p.id,
        doctorUserId: d.userId,
        chosenOn: c.chosenOn,
        expiresOn: c.expiresOn,
        endedOn: c.endedOn,
        endReason: c.endReason,
        source: 'aura',
      });
      changes.push({
        kind: 'scelta',
        change: 'nuova',
        subject: d.name,
        description: choiceText(d.name, c),
      });
    } else if (
      row.expiresOn !== c.expiresOn ||
      row.endedOn !== c.endedOn ||
      row.endReason !== c.endReason
    ) {
      await tx
        .update(patientChoice)
        .set({ expiresOn: c.expiresOn, endedOn: c.endedOn, endReason: c.endReason })
        .where(eq(patientChoice.id, row.id));
      changes.push({
        kind: 'scelta',
        change: 'cambiata',
        subject: d.name,
        description: choiceText(d.name, c),
      });
    }
  }
  for (const [k, row] of haveChoices) {
    if (seenChoices.has(k)) continue;
    await tx.update(patientChoice).set(annul).where(eq(patientChoice.id, row.id));
    const name = nameOf.get(row.doctorUserId) ?? 'un medico dello studio';
    changes.push({
      kind: 'scelta',
      change: 'tolta',
      subject: name,
      description: `${choiceText(name, row)}: non c’è più in AURA`,
    });
  }
  return changes;
}

/**
 * Stato del paziente secondo la scelta del titolare dell'archivio in AURA (D198). Scelta cessata e
 * nessuna in corso: «revocato», da solo; di nuovo una scelta in corso: «in carico». I pazienti
 * deceduti o temporanei non si toccano, e senza scelte di AURA per il titolare nulla cambia.
 */
async function alignStatus(
  tx: Tx,
  patientId: string,
  by: { at: Date; today: string },
): Promise<Change | null> {
  const [row] = await tx
    .select({ status: patient.status, owner: archive.ownerUserId, ownerName: appUser.displayName })
    .from(patient)
    .innerJoin(archive, eq(archive.id, patient.archiveId))
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .where(eq(patient.id, patientId));
  if (!row || (row.status !== 'active' && row.status !== 'revoked')) return null;
  const choices = await tx
    .select()
    .from(patientChoice)
    .where(
      and(
        eq(patientChoice.patientId, patientId),
        eq(patientChoice.doctorUserId, row.owner),
        eq(patientChoice.source, 'aura'),
        isNull(patientChoice.annulledAt),
      ),
    );
  const inForce = choices.find(
    (c) => c.chosenOn <= by.today && (!c.endedOn || c.endedOn > by.today),
  );
  const ended = choices
    .filter((c) => c.endedOn && c.endedOn <= by.today)
    .sort((a, b) => (a.endedOn! < b.endedOn! ? 1 : -1))[0];
  const set = async (status: 'active' | 'revoked') =>
    tx.update(patient).set({ status, updatedAt: by.at }).where(eq(patient.id, patientId));
  if (row.status === 'active' && !inForce && ended) {
    await set('revoked');
    return {
      kind: 'stato',
      change: 'cambiata',
      subject: 'Stato del paziente',
      description: `Paziente revocato: ${choiceText(row.ownerName, ended)}`,
    };
  }
  if (row.status === 'revoked' && inForce) {
    await set('active');
    return {
      kind: 'stato',
      change: 'cambiata',
      subject: 'Stato del paziente',
      description: `Paziente di nuovo in carico: ${choiceText(row.ownerName, inForce)}`,
    };
  }
  return null;
}

/** Le scelte di AURA che valgono oggi: iniziate, non cessate, non scadute. */
const inForceOn = (
  c: { chosenOn: string; endedOn: string | null; expiresOn: string | null },
  today: string,
) =>
  c.chosenOn <= today &&
  (!c.endedOn || c.endedOn > today) &&
  (!c.expiresOn || c.expiresOn >= today);

/**
 * Cambio di medico dentro lo studio (D200). Se la scelta di AURA che vale oggi, la più recente, è di
 * un altro medico dello studio, titolare di un altro archivio, lo spostamento si propone al
 * titolare dell'archivio dove il paziente sta. La stessa scelta, già proposta o già rifiutata, non
 * si ripropone; una scelta nuova sì. Senza una scelta così, con il paziente deceduto o già
 * nell'archivio del medico scelto, la proposta decade.
 */
async function proposeDoctorChange(
  tx: Tx,
  patientId: string,
  by: { at: Date; today: string },
): Promise<Change | null> {
  const [row] = await tx
    .select({
      studioId: patient.studioId,
      archiveId: patient.archiveId,
      status: patient.status,
      owner: archive.ownerUserId,
      ownerName: appUser.displayName,
    })
    .from(patient)
    .innerJoin(archive, eq(archive.id, patient.archiveId))
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .where(eq(patient.id, patientId));
  if (!row) return null;
  const [current] = await tx
    .select()
    .from(auraDoctorChange)
    .where(eq(auraDoctorChange.patientId, patientId));
  const withdraw = async () => {
    if (current?.status === 'da_decidere')
      await tx
        .update(auraDoctorChange)
        .set({ status: 'superato', detectedAt: by.at })
        .where(eq(auraDoctorChange.id, current.id));
    return null;
  };
  if (row.status === 'deceased') return withdraw();
  const choices = await tx
    .select({ c: patientChoice, archiveId: archive.id, name: appUser.displayName })
    .from(patientChoice)
    .innerJoin(
      archive,
      and(eq(archive.ownerUserId, patientChoice.doctorUserId), eq(archive.studioId, row.studioId)),
    )
    .innerJoin(appUser, eq(appUser.id, patientChoice.doctorUserId))
    .where(
      and(
        eq(patientChoice.patientId, patientId),
        eq(patientChoice.source, 'aura'),
        isNull(patientChoice.annulledAt),
      ),
    );
  const valid = choices.filter(({ c }) => inForceOn(c, by.today));
  const latest = valid.reduce<(typeof valid)[number] | null>(
    (a, b) => (!a || a.c.chosenOn < b.c.chosenOn ? b : a),
    null,
  );
  // Un medico con più archivi nello studio: non si sa in quale; nessuna proposta.
  const targets = latest ? valid.filter((v) => v.c.id === latest.c.id) : [];
  if (
    !latest ||
    targets.length !== 1 ||
    latest.c.doctorUserId === row.owner ||
    latest.archiveId === row.archiveId
  )
    return withdraw();
  const values = {
    studioId: row.studioId,
    fromArchiveId: row.archiveId,
    toArchiveId: latest.archiveId,
    toDoctorUserId: latest.c.doctorUserId,
    chosenOn: latest.c.chosenOn,
  };
  const same =
    !!current &&
    current.fromArchiveId === values.fromArchiveId &&
    current.toArchiveId === values.toArchiveId &&
    current.toDoctorUserId === values.toDoctorUserId &&
    current.chosenOn === values.chosenOn;
  if (same && (current.status === 'da_decidere' || current.status === 'non_spostato')) return null;
  if (current)
    await tx
      .update(auraDoctorChange)
      .set({
        ...values,
        status: 'da_decidere',
        detectedAt: by.at,
        decidedBy: null,
        decidedAt: null,
      })
      .where(eq(auraDoctorChange.id, current.id));
  else
    await tx
      .insert(auraDoctorChange)
      .values({ ...values, patientId, status: 'da_decidere', detectedAt: by.at });
  return {
    kind: 'archivio',
    change: 'nuova',
    subject: latest.name,
    description: `Scelta in AURA di ${latest.name} dal ${itDate(latest.c.chosenOn)}: lo spostamento nel suo archivio lo decide ${row.ownerName}`,
  };
}

/** Pratiche aperte che fermano lo spostamento (D200), in parole: «1 ricetta da firmare». */
const OPEN_PRESCRIPTIONS = ['draft', 'to_sign', 'sending', 'error'] as const;
const OPEN_CERTIFICATES = ['draft', 'sending', 'error'] as const;
const OPEN_LABEL: Record<string, string> = {
  draft: 'in bozza',
  to_sign: 'da firmare',
  sending: 'in invio',
  error: 'con un errore d’invio',
};

async function openItems(tx: Tx, patientId: string): Promise<string[]> {
  const rx = await tx
    .select({ status: prescription.status, n: count() })
    .from(prescription)
    .where(
      and(
        eq(prescription.patientId, patientId),
        inArray(prescription.status, [...OPEN_PRESCRIPTIONS]),
      ),
    )
    .groupBy(prescription.status);
  const certs = await tx
    .select({ status: sickLeaveCertificate.status, n: count() })
    .from(sickLeaveCertificate)
    .where(
      and(
        eq(sickLeaveCertificate.patientId, patientId),
        inArray(sickLeaveCertificate.status, [...OPEN_CERTIFICATES]),
      ),
    )
    .groupBy(sickLeaveCertificate.status);
  const words = (n: number, one: string, many: string, status: string) =>
    `${n} ${n === 1 ? one : many} ${OPEN_LABEL[status]}`;
  return [
    ...OPEN_PRESCRIPTIONS.flatMap((st) => {
      const r = rx.find((x) => x.status === st);
      return r ? [words(r.n, 'ricetta', 'ricette', st)] : [];
    }),
    ...OPEN_CERTIFICATES.flatMap((st) => {
      const r = certs.find((x) => x.status === st);
      return r ? [words(r.n, 'certificato', 'certificati', st)] : [];
    }),
  ];
}

/** Il cambio di medico come l'ha visto chi decide: medico scelto e data della scelta. */
export interface SeenDoctorChange {
  doctorUserId: string;
  chosenOn: string;
}

export function createAuraService(deps: AuraDeps) {
  const { db, gateway } = deps;

  async function record(
    tx: Tx,
    p: { id: string; studioId: string },
    outcome: AuraOutcome,
    fields: {
      auraId?: string | null;
      message?: string | null;
      updated?: boolean;
      registry?: AuraRegistry | null;
    },
  ) {
    const at = deps.now();
    const values = {
      patientId: p.id,
      checkedAt: at,
      outcome,
      message: fields.message ?? null,
      ...(fields.auraId !== undefined ? { auraId: fields.auraId } : {}),
      ...(fields.updated ? { updatedAt: at } : {}),
      ...(fields.registry !== undefined ? { registry: fields.registry } : {}),
    };
    await tx
      .insert(auraLink)
      .values(values)
      .onConflictDoUpdate({ target: auraLink.patientId, set: values });
  }

  /** Trova l'identificativo AURA dal codice fiscale: uno solo, o nessuno. */
  async function resolve(p: {
    id: string;
    studioId: string;
    fiscalCode: string;
  }): Promise<{ auraId: string } | { outcome: AuraOutcome; message: string }> {
    const found = await gateway.findByFiscalCode(p.fiscalCode);
    if (found.outcome === 'unreachable')
      return { outcome: 'non_raggiungibile', message: found.message };
    if (found.outcome === 'rejected') return { outcome: 'rifiutato', message: found.message };
    if (found.auraIds.length === 0)
      return {
        outcome: 'non_trovato',
        message: 'Nessun assistito in AURA con questo codice fiscale',
      };
    if (found.auraIds.length > 1)
      return {
        outcome: 'ambiguo',
        message: 'Più assistiti in AURA con questo codice fiscale: va chiarito con l’ASL',
      };
    return { auraId: found.auraIds[0]! };
  }

  /**
   * Controlla un paziente su AURA e allinea esenzioni e scelte. Senza rete, o se AURA non trova la
   * persona, i dati restano quelli di prima e il motivo resta nel collegamento.
   *
   * Un controllo alla volta per paziente, anche con più processi (D198): chi arriva dopo aspetta il
   * blocco e legge AURA dopo, così due notifiche vicine non registrano due volte la stessa
   * variazione e un profilo letto prima non annulla uno letto dopo.
   */
  async function syncPatient(
    patientId: string,
    trigger: AuraTrigger,
    userId: string | null = null,
  ): Promise<SyncResult> {
    if (!auraAvailable(deps)) return { outcome: 'spento', message: AURA_UNAVAILABLE, changes: 0 };
    return withActor(db, userId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`aura:${patientId}`}, 0))`,
      );
      const [p] = await tx
        .select({ id: patient.id, studioId: patient.studioId, fiscalCode: patient.fiscalCode })
        .from(patient)
        .where(eq(patient.id, patientId));
      if (!p) throw new Error('Paziente non trovato');
      const [link] = await tx.select().from(auraLink).where(eq(auraLink.patientId, p.id));

      let auraId = link?.auraId ?? null;
      let fetched = auraId ? await gateway.getProfile(auraId) : null;
      // Senza identificativo, o se AURA non lo riconosce più (profili unificati), si cerca per codice fiscale.
      if (!fetched || fetched.outcome === 'not_found') {
        const r = await resolve(p);
        if ('outcome' in r) {
          await record(tx, p, r.outcome, {
            message: r.message,
            ...(r.outcome === 'non_trovato' ? { auraId: null } : {}),
          });
          return { outcome: r.outcome, message: r.message, changes: 0 };
        }
        auraId = r.auraId;
        fetched = await gateway.getProfile(auraId);
      }
      if (fetched.outcome === 'unreachable' || fetched.outcome === 'rejected') {
        const outcome = fetched.outcome === 'unreachable' ? 'non_raggiungibile' : 'rifiutato';
        await record(tx, p, outcome, { message: fetched.message });
        return { outcome, message: fetched.message, changes: 0 };
      }
      if (fetched.outcome === 'not_found') {
        const message = 'L’assistito non c’è più in AURA con questo identificativo';
        await record(tx, p, 'non_trovato', { auraId: null, message });
        return { outcome: 'non_trovato', message, changes: 0 };
      }
      const profile = fetched.profile;
      if (profile.fiscalCode.toUpperCase() !== p.fiscalCode.toUpperCase()) {
        const message = 'AURA ha risposto con un altro codice fiscale: nulla è stato cambiato';
        await record(tx, p, 'rifiutato', { auraId: null, message });
        return { outcome: 'rifiutato', message, changes: 0 };
      }
      const at = deps.now();
      const registry = profile.registry ?? null;
      const list = await reconcile(tx, p, profile, { at, userId });
      // Anagrafica: le differenze con la cartella si registrano quando AURA manda dati nuovi; nella
      // cartella entrano solo se qualcuno le conferma dal pannello.
      if (registry && !sameRegistry(link?.registry, registry)) {
        const [full] = await tx.select().from(patient).where(eq(patient.id, p.id));
        const diffs = registryDifferences(registry, full!, link?.registryDismissed ?? {});
        if (diffs.length)
          list.push({
            kind: 'anagrafica',
            change: link?.registry ? 'cambiata' : 'nuova',
            subject: 'Anagrafica',
            description: registryText(diffs),
          });
      }
      const status = await alignStatus(tx, p.id, { at, today: studioDate(at) });
      if (status) list.push(status);
      const move = await proposeDoctorChange(tx, p.id, { at, today: studioDate(at) });
      if (move) list.push(move);
      if (list.length)
        await tx
          .insert(auraChange)
          .values(list.map((c) => ({ ...c, studioId: p.studioId, patientId: p.id, at, trigger })));
      // Nel registro: ogni controllo chiesto da una persona, e ogni volta che AURA cambia la cartella.
      // Il controllo di ogni notte e le notifiche senza variazioni non leggono né cambiano nulla.
      if (userId || list.length)
        await logAccess(tx, {
          studioId: p.studioId,
          userId,
          patientId: p.id,
          action: 'aggiornamento_aura',
          outcome: 'riuscito',
          details: { avvio: trigger, variazioni: list.length },
        });
      await record(tx, p, 'aggiornato', { auraId, updated: true, registry });
      return { outcome: 'aggiornato', message: null, changes: list.length };
    });
  }

  /**
   * Prima dei controlli di una ricetta con esenzione: se l'ultimo aggiornamento da AURA ha più di
   * `maxAgeMinutes`, si rilegge il paziente. Se AURA non risponde entro `timeoutMs`, valgono i dati
   * che ci sono: il controllo non si ferma per questo.
   */
  async function refreshIfStale(
    patientId: string,
    userId: string | null,
    { maxAgeMinutes = 10, timeoutMs = 3000 } = {},
  ): Promise<void> {
    if (!auraAvailable(deps)) return;
    const [link] = await db.select().from(auraLink).where(eq(auraLink.patientId, patientId));
    if (link?.updatedAt && deps.now().getTime() - link.updatedAt.getTime() < maxAgeMinutes * 60_000)
      return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      syncPatient(patientId, 'ricetta', userId),
      new Promise<void>((resolve) => {
        timer = unrefTimer(setTimeout(resolve, timeoutMs));
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Nuovi assistiti (D199). Per un assistito notificato da AURA si guardano le sue scelte che valgono
   * oggi o più avanti, con un medico titolare di uno studio del servizio (riconosciuto dal codice
   * fiscale, con il suo archivio). Nello studio dove il paziente c'è già (stesso codice fiscale) lo
   * si allinea; altrimenti entra fra i nuovi assistiti dell'archivio del medico, da registrare. Una
   * scelta che non vale più, o il decesso, lo toglie dall'elenco. Un assistito che medico o segreteria
   * hanno scelto di non registrare non si ripropone, finché AURA non manda una scelta nuova.
   * Un controllo alla volta per assistito, anche con più processi.
   */
  async function discover(auraId: string, synced: ReadonlySet<string> = new Set()) {
    if (!auraAvailable(deps)) return;
    const toSync: string[] = [];
    await withActor(db, null, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`aura-nuovo:${auraId}`}, 0))`,
      );
      const fetched = await gateway.getProfile(auraId);
      if (fetched.outcome !== 'found') return;
      const profile = fetched.profile;
      const at = deps.now();
      const today = studioDate(at);
      const fiscalCode = profile.fiscalCode.toUpperCase();
      const doctors = await tx
        .select({
          userId: doctorProfile.userId,
          fiscalCode: doctorProfile.fiscalCode,
          studioId: appUser.studioId,
          archiveId: archive.id,
        })
        .from(doctorProfile)
        .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
        .innerJoin(archive, eq(archive.ownerUserId, doctorProfile.userId))
        .where(isNotNull(doctorProfile.fiscalCode));
      const byCf = new Map(doctors.map((d) => [d.fiscalCode!.toUpperCase(), d]));
      // Per ogni studio la scelta più recente che vale; nessuna se AURA dice il decesso.
      const current = new Map<
        string,
        { doctor: (typeof doctors)[number]; choice: AuraProfile['choices'][number] }
      >();
      if (!profile.registry?.deceasedOn)
        for (const c of profile.choices) {
          const d = byCf.get(c.doctorFiscalCode.toUpperCase());
          const valid = (!c.endedOn || c.endedOn > today) && (!c.expiresOn || c.expiresOn >= today);
          if (!d || !valid) continue;
          const seen = current.get(d.studioId);
          if (!seen || seen.choice.chosenOn < c.chosenOn)
            current.set(d.studioId, { doctor: d, choice: c });
        }
      const rows = await tx.select().from(auraNewPatient).where(eq(auraNewPatient.auraId, auraId));
      const withdraw = (id: string) =>
        tx
          .update(auraNewPatient)
          .set({ status: 'superato', notifiedAt: at })
          .where(and(eq(auraNewPatient.id, id), eq(auraNewPatient.status, 'da_registrare')));
      for (const [studioId, { doctor, choice }] of current) {
        const row = rows.find((r) => r.studioId === studioId);
        const [already] = await tx
          .select({ id: patient.id })
          .from(patient)
          .where(and(eq(patient.studioId, studioId), eq(patient.fiscalCode, fiscalCode)));
        if (already) {
          // Il paziente c'è già: si collega e si allinea (dopo, fuori da questo blocco).
          if (!synced.has(already.id)) toSync.push(already.id);
          if (row) await withdraw(row.id);
          continue;
        }
        const values = {
          archiveId: doctor.archiveId,
          doctorUserId: doctor.userId,
          fiscalCode,
          lastName: profile.lastName,
          firstName: profile.firstName,
          birthDate: profile.birthDate,
          chosenOn: choice.chosenOn,
          expiresOn: choice.expiresOn,
          registry: profile.registry ?? null,
        };
        if (!row) {
          await tx
            .insert(auraNewPatient)
            .values({ ...values, studioId, auraId, status: 'da_registrare', notifiedAt: at });
          continue;
        }
        if (row.status === 'registrato') continue;
        // Una scelta nuova (altro medico o altra data) si ripropone, anche se la prima no.
        const sameChoice = row.doctorUserId === doctor.userId && row.chosenOn === choice.chosenOn;
        const status =
          row.status === 'non_registrato' && sameChoice ? 'non_registrato' : 'da_registrare';
        const changed =
          status !== row.status ||
          row.archiveId !== values.archiveId ||
          !sameChoice ||
          row.expiresOn !== values.expiresOn ||
          row.lastName !== values.lastName ||
          row.firstName !== values.firstName ||
          row.birthDate !== values.birthDate ||
          !sameRegistry(row.registry, values.registry);
        if (changed)
          await tx
            .update(auraNewPatient)
            .set({
              ...values,
              status,
              notifiedAt: at,
              ...(status === 'da_registrare' ? { decidedBy: null, decidedAt: null } : {}),
            })
            .where(eq(auraNewPatient.id, row.id));
      }
      // Dove la scelta non vale più, l'assistito esce dall'elenco.
      for (const row of rows) if (!current.has(row.studioId)) await withdraw(row.id);
    });
    for (const id of toSync) await syncPatient(id, 'notifica');
  }

  /** Differenze di oggi fra l'anagrafica di AURA e la cartella del paziente. */
  async function differences(patientId: string): Promise<RegistryDifference[]> {
    const [row] = await db
      .select({ p: patient, link: auraLink })
      .from(patient)
      .leftJoin(auraLink, eq(auraLink.patientId, patient.id))
      .where(eq(patient.id, patientId));
    if (!row) return [];
    return registryDifferences(row.link?.registry, row.p, row.link?.registryDismissed ?? {});
  }

  return {
    available: () => auraAvailable(deps),
    syncPatient,
    refreshIfStale,
    differences,
    discover,

    /** Nuovi assistiti da registrare negli archivi indicati (D199), con il nome del medico. */
    async newPatientsFor(studioId: string, archiveIds: readonly string[]) {
      if (archiveIds.length === 0) return [];
      return db
        .select({ c: auraNewPatient, doctor: appUser.displayName })
        .from(auraNewPatient)
        .innerJoin(appUser, eq(appUser.id, auraNewPatient.doctorUserId))
        .where(
          and(
            eq(auraNewPatient.studioId, studioId),
            inArray(auraNewPatient.archiveId, [...archiveIds]),
            eq(auraNewPatient.status, 'da_registrare'),
          ),
        )
        .orderBy(auraNewPatient.lastName, auraNewPatient.firstName);
    },

    /**
     * Cambi di medico da decidere nello studio (D200), con il medico scelto e il titolare
     * dell'archivio dove il paziente sta. Solo quelli con il paziente ancora in quell'archivio.
     */
    async pendingDoctorChanges(studioId: string) {
      const owner = alias(appUser, 'titolare_di_prima');
      return db
        .select({
          c: auraDoctorChange,
          lastName: patient.lastName,
          firstName: patient.firstName,
          toName: appUser.displayName,
          fromName: owner.displayName,
        })
        .from(auraDoctorChange)
        .innerJoin(
          patient,
          and(
            eq(patient.id, auraDoctorChange.patientId),
            eq(patient.archiveId, auraDoctorChange.fromArchiveId),
          ),
        )
        .innerJoin(appUser, eq(appUser.id, auraDoctorChange.toDoctorUserId))
        .innerJoin(archive, eq(archive.id, auraDoctorChange.fromArchiveId))
        .innerJoin(owner, eq(owner.id, archive.ownerUserId))
        .where(
          and(eq(auraDoctorChange.studioId, studioId), eq(auraDoctorChange.status, 'da_decidere')),
        )
        .orderBy(patient.lastName, patient.firstName);
    },

    /**
     * «Sposta» (D200): il paziente passa nell'archivio del medico scelto, con la cartella intera, e
     * lo stato si riallinea con la scelta del nuovo titolare. Il permesso lo controlla chi chiama.
     * Si sposta solo il cambio che chi decide ha visto, senza pratiche aperte, e non mentre un
     * controllo con AURA lavora sullo stesso paziente: chi clicca non aspetta il blocco.
     */
    async moveToChosenDoctor(
      changeId: string,
      actor: Pick<Actor, 'userId' | 'studioId' | 'workstation'>,
      seen: SeenDoctorChange,
    ) {
      return withActor(db, actor.userId, async (tx) => {
        const [first] = await tx
          .select({ patientId: auraDoctorChange.patientId })
          .from(auraDoctorChange)
          .where(eq(auraDoctorChange.id, changeId));
        if (!first) throw new HttpError(404, 'Cambio di medico non trovato');
        const lock = await tx.execute<{ preso: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`aura:${first.patientId}`}, 0)) as preso`,
        );
        if (!lock.rows[0]?.preso)
          throw new HttpError(
            409,
            'Controllo con AURA in corso per questo paziente: riprova tra poco',
          );
        const [c] = await tx
          .select()
          .from(auraDoctorChange)
          .where(eq(auraDoctorChange.id, changeId))
          .for('update');
        if (c!.status !== 'da_decidere')
          throw new HttpError(
            409,
            c!.status === 'spostato' ? 'Già spostato' : 'Non è più da decidere: ricarica la pagina',
          );
        if (c!.toDoctorUserId !== seen.doctorUserId || c!.chosenOn !== seen.chosenOn)
          throw new HttpError(409, 'AURA ha cambiato la scelta del paziente: ricarica la pagina');
        const [p] = await tx
          .select()
          .from(patient)
          .where(eq(patient.id, c!.patientId))
          .for('update');
        if (p!.archiveId !== c!.fromArchiveId)
          throw new HttpError(409, 'Il paziente non è più in questo archivio: ricarica la pagina');
        const open = await openItems(tx, p!.id);
        if (open.length)
          throw new HttpError(409, `Prima dello spostamento vanno chiuse: ${open.join(', ')}`, {
            aperte: open,
          });
        const at = deps.now();
        await tx
          .update(patient)
          .set({ archiveId: c!.toArchiveId, updatedAt: at })
          .where(eq(patient.id, p!.id));
        // Lo spostamento resta nello storico: dice chi aveva il paziente in un giorno (D240).
        await tx.insert(patientArchiveMove).values({
          studioId: p!.studioId,
          patientId: p!.id,
          fromArchiveId: c!.fromArchiveId,
          toArchiveId: c!.toArchiveId,
          movedAt: at,
          movedBy: actor.userId,
          doctorChangeId: c!.id,
        });
        await tx
          .update(auraDoctorChange)
          .set({ status: 'spostato', decidedBy: actor.userId, decidedAt: at })
          .where(eq(auraDoctorChange.id, c!.id));
        const [to] = await tx
          .select({ name: appUser.displayName })
          .from(appUser)
          .where(eq(appUser.id, c!.toDoctorUserId));
        const list: Change[] = [
          {
            kind: 'archivio',
            change: 'cambiata',
            subject: to!.name,
            description: `Spostato nell’archivio di ${to!.name}, scelto in AURA dal ${itDate(c!.chosenOn)}`,
          },
        ];
        const status = await alignStatus(tx, p!.id, { at, today: studioDate(at) });
        if (status) list.push(status);
        await tx.insert(auraChange).values(
          list.map((x) => ({
            ...x,
            studioId: p!.studioId,
            patientId: p!.id,
            at,
            trigger: 'manuale',
          })),
        );
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          patientId: p!.id,
          action: 'spostamento_archivio',
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: { da: c!.fromArchiveId, a: c!.toArchiveId, cambio: c!.id },
        });
        const [after] = await tx
          .select({ status: patient.status })
          .from(patient)
          .where(eq(patient.id, p!.id));
        return { patientId: p!.id, archiveId: c!.toArchiveId, status: after!.status };
      });
    },

    /**
     * «Non spostare» (D200): il paziente resta dov'è, e il cambio non si ripropone finché AURA non
     * manda una scelta nuova. Vale per il cambio che chi decide ha visto.
     */
    async keepInArchive(
      changeId: string,
      actor: Pick<Actor, 'userId' | 'studioId' | 'workstation'>,
      seen: SeenDoctorChange,
    ) {
      return withActor(db, actor.userId, async (tx) => {
        const [c] = await tx
          .select()
          .from(auraDoctorChange)
          .where(eq(auraDoctorChange.id, changeId))
          .for('update');
        if (!c) throw new HttpError(404, 'Cambio di medico non trovato');
        if (c.status !== 'da_decidere')
          throw new HttpError(409, 'Non è più da decidere: ricarica la pagina');
        if (c.toDoctorUserId !== seen.doctorUserId || c.chosenOn !== seen.chosenOn)
          throw new HttpError(409, 'AURA ha cambiato la scelta del paziente: ricarica la pagina');
        await tx
          .update(auraDoctorChange)
          .set({ status: 'non_spostato', decidedBy: actor.userId, decidedAt: deps.now() })
          .where(eq(auraDoctorChange.id, c.id));
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          patientId: c.patientId,
          action: 'cambio_medico_non_spostato',
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: { da: c.fromArchiveId, a: c.toArchiveId, cambio: c.id },
        });
        return { patientId: c.patientId };
      });
    },

    /** Valori di AURA da non usare: non si ripropongono finché AURA non ne manda altri. */
    async dismiss(patientId: string, entries: readonly { campo: string; inAura: string }[]) {
      const [link] = await db.select().from(auraLink).where(eq(auraLink.patientId, patientId));
      if (!link) return;
      const dismissed = { ...link.registryDismissed };
      for (const e of entries) dismissed[e.campo] = e.inAura;
      await db
        .update(auraLink)
        .set({ registryDismissed: dismissed })
        .where(eq(auraLink.patientId, patientId));
    },

    /**
     * Pazienti degli archivi indicati con differenze da confermare (il decesso per primo), per la
     * pagina Oggi.
     */
    async pendingForArchives(studioId: string, archiveIds: readonly string[]) {
      if (archiveIds.length === 0) return [];
      const rows = await db
        .select({ p: patient, link: auraLink })
        .from(auraLink)
        .innerJoin(patient, eq(patient.id, auraLink.patientId))
        .where(
          and(
            eq(patient.studioId, studioId),
            inArray(patient.archiveId, [...archiveIds]),
            isNotNull(auraLink.registry),
          ),
        );
      return rows
        .map(({ p, link }) => ({
          pazienteId: p.id,
          cognome: p.lastName,
          nome: p.firstName,
          differenze: registryDifferences(link.registry, p, link.registryDismissed),
        }))
        .filter((r) => r.differenze.length > 0)
        .map(({ differenze, ...r }) => ({
          ...r,
          campi: differenze.filter((d) => d.campo !== 'decesso').map((d) => d.etichetta),
          decesso: differenze.find((d) => d.campo === 'decesso')?.inAura ?? null,
        }))
        .sort(
          (a, b) =>
            Number(b.decesso !== null) - Number(a.decesso !== null) ||
            a.cognome.localeCompare(b.cognome, 'it') ||
            a.nome.localeCompare(b.nome, 'it'),
        );
    },

    /** Stato del collegamento e ultime variazioni di un paziente, per il pannello amministrativo. */
    async patientState(patientId: string) {
      const [link] = await db.select().from(auraLink).where(eq(auraLink.patientId, patientId));
      const changes = await db
        .select()
        .from(auraChange)
        .where(eq(auraChange.patientId, patientId))
        .orderBy(desc(auraChange.at))
        .limit(20);
      return {
        disponibile: auraAvailable(deps),
        ambiente: gateway.environment,
        idAura: link?.auraId ?? null,
        controllatoIl: link?.checkedAt.toISOString() ?? null,
        esito: link?.outcome ?? null,
        messaggio: link?.message ?? null,
        aggiornatoIl: link?.updatedAt?.toISOString() ?? null,
        differenze: await differences(patientId),
        variazioni: changes.map((c) => ({
          quando: c.at.toISOString(),
          tipo: c.kind,
          variazione: c.change,
          descrizione: c.description,
          avvio: c.trigger,
        })),
      };
    },

    /** Variazioni recenti dello studio, solo dei pazienti degli archivi indicati. */
    async recentChanges(studioId: string, archiveIds: readonly string[], days: number) {
      if (archiveIds.length === 0) return [];
      const since = new Date(deps.now().getTime() - days * 24 * 60 * 60 * 1000);
      return db
        .select({
          quando: auraChange.at,
          tipo: auraChange.kind,
          variazione: auraChange.change,
          descrizione: auraChange.description,
          pazienteId: patient.id,
          cognome: patient.lastName,
          nome: patient.firstName,
        })
        .from(auraChange)
        .innerJoin(patient, eq(patient.id, auraChange.patientId))
        .where(
          and(
            eq(auraChange.studioId, studioId),
            inArray(patient.archiveId, [...archiveIds]),
            gte(auraChange.at, since),
          ),
        )
        .orderBy(desc(auraChange.at))
        .limit(100);
    },

    /**
     * Il giro di ogni notte, o dal server: i pazienti in carico e i temporanei del servizio (D199), e
     * i revocati già collegati ad AURA (tornano in carico con una scelta nuova, D198). I numeri
     * restano in tutto e studio per studio: lo stato del servizio di uno studio mostra solo i suoi.
     */
    async syncAll(trigger: 'notte' | 'comando') {
      const startedAt = deps.now();
      const [run] = await db.insert(auraSyncRun).values({ trigger, startedAt }).returning();
      const byStudio = new Map<string, { patients: number; changed: number; failed: number }>();
      let message: string | null = null;
      if (!auraAvailable(deps)) message = AURA_UNAVAILABLE;
      else {
        const all = await db
          .select({ id: patient.id, studioId: patient.studioId })
          .from(patient)
          .leftJoin(auraLink, eq(auraLink.patientId, patient.id))
          .where(
            or(
              eq(patient.status, 'active'),
              // I temporanei hanno scelte a tempo, anche da AURA (D199): si allineano anche loro.
              eq(patient.status, 'temporary'),
              and(eq(patient.status, 'revoked'), isNotNull(auraLink.auraId)),
            ),
          );
        for (const { id, studioId } of all) {
          const n = byStudio.get(studioId) ?? { patients: 0, changed: 0, failed: 0 };
          byStudio.set(studioId, n);
          n.patients += 1;
          try {
            const r = await syncPatient(id, 'notte');
            if (r.changes) n.changed += 1;
            if (r.outcome === 'non_raggiungibile' || r.outcome === 'rifiutato') n.failed += 1;
          } catch {
            n.failed += 1;
          }
        }
      }
      const totals = [...byStudio.values()].reduce(
        (t, n) => ({
          patients: t.patients + n.patients,
          changed: t.changed + n.changed,
          failed: t.failed + n.failed,
        }),
        { patients: 0, changed: 0, failed: 0 },
      );
      if (byStudio.size)
        await db
          .insert(auraSyncRunStudio)
          .values([...byStudio].map(([studioId, n]) => ({ runId: run!.id, studioId, ...n })));
      const [done] = await db
        .update(auraSyncRun)
        .set({ finishedAt: deps.now(), ...totals, message })
        .where(eq(auraSyncRun.id, run!.id))
        .returning();
      return done!;
    },

    /** L'ultimo giro visto da uno studio: date e messaggio del giro, numeri solo dei suoi pazienti. */
    async lastRunForStudio(studioId: string) {
      const [run] = await db
        .select()
        .from(auraSyncRun)
        .orderBy(desc(auraSyncRun.startedAt))
        .limit(1);
      if (!run) return null;
      const [mine] = await db
        .select()
        .from(auraSyncRunStudio)
        .where(and(eq(auraSyncRunStudio.runId, run.id), eq(auraSyncRunStudio.studioId, studioId)));
      return {
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        message: run.message,
        patients: mine?.patients ?? 0,
        changed: mine?.changed ?? 0,
        failed: mine?.failed ?? 0,
      };
    },

    /** L'ultimo giro, per lo stato del servizio. */
    async lastRun() {
      const [row] = await db
        .select()
        .from(auraSyncRun)
        .orderBy(desc(auraSyncRun.startedAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Ascolta le variazioni di AURA: per ogni assistito notificato si controllano i pazienti
     * collegati. Una scelta notificata, o un assistito già fra i nuovi, passa anche dalla ricerca dei
     * nuovi assistiti (D199). Restituisce la funzione che smette di ascoltare.
     */
    listen(onError: (err: unknown) => void = () => undefined): () => void {
      return gateway.onNotification((n) => {
        void (async () => {
          const rows = await db
            .select({ patientId: auraLink.patientId })
            .from(auraLink)
            .where(eq(auraLink.auraId, n.auraId));
          for (const r of rows) await syncPatient(r.patientId, 'notifica');
          const known =
            n.event === 'scelta' ||
            (
              await db
                .select({ id: auraNewPatient.id })
                .from(auraNewPatient)
                .where(eq(auraNewPatient.auraId, n.auraId))
                .limit(1)
            ).length > 0;
          if (known) await discover(n.auraId, new Set(rows.map((r) => r.patientId)));
        })().catch(onError);
      });
    },
  };
}

export type AuraService = ReturnType<typeof createAuraService>;
