/**
 * Quando il riquadro della dimostrazione si riduce da sé (D241). Dopo un accesso si riduce, una
 * volta per sessione, così copre di meno la pagina. Se lo si è aperto a mano dopo l'inizio della
 * sessione resta aperto: chi lo sta leggendo non lo vede chiudersi. Il riquadro legge lo stato
 * del servizio una volta al secondo, quindi l'accesso lo vede fino a un secondo dopo.
 */
export interface SessionState {
  loggedIn: boolean;
  /** Da quando c'è la sessione aperta, in millisecondi; nessuna sessione, null. */
  sessionSince: number | null;
}

export function autoReduce(
  state: SessionState,
  /** La sessione per cui il riquadro ha già deciso. */
  decidedFor: number | null,
  /** Quando lo si è aperto a mano l'ultima volta, in millisecondi; mai, 0. */
  openedByHand: number,
): { reduce: boolean; decidedFor: number | null } {
  const since = state.loggedIn ? state.sessionSince : null;
  if (since === null || since === decidedFor) return { reduce: false, decidedFor };
  return { reduce: openedByHand < since, decidedFor: since };
}
