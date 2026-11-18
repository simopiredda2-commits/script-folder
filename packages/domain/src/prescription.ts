/**
 * Ciclo di vita della ricetta (docs/requisiti.md, «Prescrizioni e ricette»):
 *
 *   bozza → da firmare → inviata → errore o annullata
 *
 * La segreteria prepara (bozze di ripetizione, che mette nella coda «da firmare»); il medico
 * firma e invia. Se il SAR rifiuta, la ricetta va in errore con il motivo in chiaro. Se SAR o
 * Sistema TS non rispondono, si stampa la ricetta rossa (ripiego cartaceo).
 *
 * «In invio» è uno stato tecnico di pochi istanti: impedisce di inviare due volte la stessa
 * ricetta mentre la risposta del SAR è in arrivo (decisione D36).
 */
export const PRESCRIPTION_STATUSES = [
  'draft',
  'to_sign',
  'sending',
  'sent',
  'error',
  'cancelled',
  'paper',
] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export const PRESCRIPTION_STATUS_LABELS: Record<PrescriptionStatus, string> = {
  draft: 'Bozza',
  to_sign: 'Da firmare',
  sending: 'In invio',
  sent: 'Inviata',
  error: 'Errore',
  cancelled: 'Annullata',
  paper: 'Stampata su ricetta rossa',
};

export const PRESCRIPTION_KINDS = ['pharma_ssn', 'specialist_ssn', 'white', 'devices'] as const;
export type PrescriptionKind = (typeof PRESCRIPTION_KINDS)[number];

export const PRESCRIPTION_KIND_LABELS: Record<PrescriptionKind, string> = {
  pharma_ssn: 'Farmaceutica SSN',
  specialist_ssn: 'Specialistica SSN',
  white: 'Ricetta bianca',
  devices: 'Presidi e assistenza integrativa',
};

/** Perché l'ultimo invio non è andato: decide che cosa si può fare dopo. */
export type SendErrorKind =
  /** Il SAR (o il Sistema TS) ha risposto e ha rifiutato: il contenuto va corretto. */
  | 'rejected'
  /** Il sistema non è raggiungibile: la ricetta certamente non è arrivata. */
  | 'unreachable'
  /** Nessuna risposta entro il tempo: non si sa se la ricetta è arrivata. */
  | 'timeout';

export type PrescriptionEvent =
  /** Mettere nella coda «da firmare» del medico. */
  | 'submit_for_signing'
  /** Riportare in bozza per correggerla. */
  | 'edit'
  /** Il medico firma e avvia l'invio. */
  | 'start_sending'
  /** Risposte dell'invio. */
  | 'send_succeeded'
  | 'send_failed'
  /** Annullamento: prima dell'invio è solo locale, dopo passa dal SAR. */
  | 'cancel'
  /** Ripiego sulla ricetta rossa quando il sistema non risponde. */
  | 'print_paper';

export interface TransitionContext {
  /** Tipo dell'ultimo errore d'invio, se la ricetta è in errore. */
  lastErrorKind?: SendErrorKind | null;
}

export type TransitionResult = { ok: true; to: PrescriptionStatus } | { ok: false; reason: string };

const ok = (to: PrescriptionStatus): TransitionResult => ({ ok: true, to });
const no = (reason: string): TransitionResult => ({ ok: false, reason });

/** Transizioni ammesse. Ogni rifiuto ha il motivo in chiaro. */
export function transition(
  from: PrescriptionStatus,
  event: PrescriptionEvent,
  ctx: TransitionContext = {},
): TransitionResult {
  switch (event) {
    case 'submit_for_signing':
      return from === 'draft' ? ok('to_sign') : no('Solo una bozza va nella coda «da firmare»');
    case 'edit':
      if (from === 'draft' || from === 'to_sign') return ok('draft');
      if (from === 'error' && ctx.lastErrorKind === 'rejected') return ok('draft');
      if (from === 'error') {
        return no(
          'Una ricetta senza risposta del SAR non si modifica: riprova l’invio o annullala',
        );
      }
      return no('Una ricetta inviata, annullata o stampata non si modifica');
    case 'start_sending':
      if (from === 'draft' || from === 'to_sign') return ok('sending');
      if (
        from === 'error' &&
        (ctx.lastErrorKind === 'unreachable' || ctx.lastErrorKind === 'timeout')
      ) {
        return ok('sending');
      }
      if (from === 'error')
        return no('Il SAR l’ha rifiutata: correggila prima di inviarla di nuovo');
      if (from === 'sending') return no('Invio già in corso');
      return no('Questa ricetta non si può inviare');
    case 'send_succeeded':
      return from === 'sending' ? ok('sent') : no('Nessun invio in corso');
    case 'send_failed':
      return from === 'sending' ? ok('error') : no('Nessun invio in corso');
    case 'cancel':
      if (from === 'draft' || from === 'to_sign' || from === 'error' || from === 'sent') {
        return ok('cancelled');
      }
      if (from === 'sending') return no('Invio in corso: aspetta la risposta');
      return no('Già annullata o stampata');
    case 'print_paper':
      if (from === 'error' && ctx.lastErrorKind === 'unreachable') return ok('paper');
      if (from === 'error' && ctx.lastErrorKind === 'timeout') {
        return no(
          'Esito incerto: la ricetta potrebbe essere arrivata al SAR. Verifica prima di stamparla (da definire sulle specifiche)',
        );
      }
      return no('La ricetta rossa si stampa solo quando il SAR o il Sistema TS non rispondono');
  }
}

/** Stati in cui la ricetta è chiusa: nessun evento la cambia più. */
export const FINAL_STATUSES: readonly PrescriptionStatus[] = ['cancelled', 'paper'];
