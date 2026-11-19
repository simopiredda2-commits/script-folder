/**
 * Condivisione tra i medici dell'AFT che usano il programma (tappa 12, D161).
 *
 * Un medico dell'AFT vede il riepilogo di un paziente di un collega solo se:
 * - tutti e due sono membri attivi della stessa AFT;
 * - il medico curante ha attivato la condivisione dei suoi pazienti nell'AFT;
 * - il paziente ha dato il consenso alla condivisione nell'AFT, e non l'ha revocato;
 * - chi consulta scrive il motivo dell'accesso.
 *
 * Si vede solo il riepilogo, senza le voci oscurate e riservate; ogni consultazione, consentita o
 * negata, va nel registro degli accessi del medico curante. Le fonti sono in `docs/aft.md`.
 */

/** Appartenenza di un medico a un'AFT, in un periodo. */
export interface AftMembership {
  aftId: string;
  userId: string;
  /** Inizio dell'appartenenza (accettazione dell'invito o creazione dell'AFT). */
  since: Date;
  /** Uscita dall'AFT; null se è ancora membro. */
  until: Date | null;
  /** Il medico condivide i suoi pazienti che hanno dato il consenso. */
  sharing: boolean;
}

/** Stato dell'ultimo consenso del paziente alla condivisione nell'AFT; null se non espresso. */
export type AftConsentState = 'given' | 'refused' | 'revoked' | null;

/** Chiave del consenso del paziente alla condivisione nell'AFT (vedi `CONSENT_KINDS`). */
export const AFT_CONSENT_KEY = 'aft_condivisione';

/** Lunghezza minima del motivo dell'accesso: una frase, non una sigla. */
export const AFT_REASON_MIN = 10;

export interface AftAccessInput {
  /** Chi consulta: deve essere un medico titolare. */
  actor: { userId: string; ownerDoctor: boolean };
  /** Medico curante del paziente (titolare dell'archivio). */
  ownerUserId: string;
  /** Appartenenze di chi consulta e del medico curante. */
  memberships: readonly AftMembership[];
  consent: AftConsentState;
  reason: string;
  now: Date;
}

export interface AftAccessDecision {
  allowed: boolean;
  /** Motivo in chiaro, per l'interfaccia e per il registro degli accessi. */
  reason: string;
  /** L'AFT in comune, se c'è. */
  aftId?: string;
}

const active = (m: AftMembership, now: Date) =>
  m.since.getTime() <= now.getTime() && (m.until === null || m.until.getTime() > now.getTime());

/** Decide una consultazione del riepilogo di un paziente di un collega dell'AFT. */
export function aftAccess(input: AftAccessInput): AftAccessDecision {
  const { actor, ownerUserId, memberships, now } = input;
  if (!actor.ownerDoctor)
    return { allowed: false, reason: 'Consultano i colleghi dell’AFT solo i medici titolari' };
  if (actor.userId === ownerUserId)
    return { allowed: false, reason: 'È un tuo paziente: aprilo dalla tua cartella' };
  const mine = memberships.filter((m) => m.userId === actor.userId && active(m, now));
  const theirs = memberships.filter((m) => m.userId === ownerUserId && active(m, now));
  const common = theirs.find((t) => mine.some((m) => m.aftId === t.aftId));
  if (!common)
    return { allowed: false, reason: 'Il medico curante non è nella tua AFT, o non lo sei tu' };
  if (!common.sharing)
    return {
      allowed: false,
      reason: 'Il medico curante non condivide i suoi pazienti nell’AFT',
      aftId: common.aftId,
    };
  if (input.consent !== 'given')
    return {
      allowed: false,
      reason:
        input.consent === 'revoked'
          ? 'Il paziente ha revocato il consenso alla condivisione nell’AFT'
          : input.consent === 'refused'
            ? 'Il paziente ha negato il consenso alla condivisione nell’AFT'
            : 'Il paziente non ha dato il consenso alla condivisione nell’AFT',
      aftId: common.aftId,
    };
  if (input.reason.trim().length < AFT_REASON_MIN)
    return {
      allowed: false,
      reason: `Scrivi il motivo dell’accesso (almeno ${AFT_REASON_MIN} caratteri)`,
      aftId: common.aftId,
    };
  return {
    allowed: true,
    reason: 'Collega dell’AFT, con il consenso del paziente',
    aftId: common.aftId,
  };
}
