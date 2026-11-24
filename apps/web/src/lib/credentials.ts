/** Credenziali dei servizi del medico e codice di sessione (D100–D102). */

export interface ServiceStatus {
  servizio: 'sistema-ts' | 'rupar';
  nome: string;
  uso: string;
  impostate: boolean;
  /** Solo le ultime tre lettere dell'utente: le credenziali non si rileggono. */
  utente: string | null;
  passwordCambiataIl: string | null;
  scadenzaPassword: string | null;
  statoPassword: 'valida' | 'in_scadenza' | 'scaduta' | 'senza_scadenza' | null;
  aggiornateIl: string | null;
  secondoFattore: boolean;
  sessione: { attiva: boolean; scadeIl: string | null; modalita?: 'email' | 'spid_cie' | null };
  /** Ricette SSN in Piemonte: si entra con SPID o CIE (D109). */
  accessoRegionale?: boolean;
  ambiente: 'simulator' | 'test' | 'production';
}

export interface CredentialsStatus {
  servizi: ServiceStatus[];
}

export const CREDENTIALS_PATH = '/profilo/credenziali';

const CREDENTIAL_ERROR_CODES = new Set([
  'CREDENZIALI_MANCANTI',
  'CREDENZIALI_RIFIUTATE',
  'SESSIONE_MANCANTE',
  'SESSIONE_SCADUTA',
]);

/** L'errore si risolve nella pagina delle credenziali? */
export function isCredentialError(details: unknown): boolean {
  const code = (details as { codice?: unknown } | null | undefined)?.codice;
  return typeof code === 'string' && CREDENTIAL_ERROR_CODES.has(code);
}

/** Che cosa manca, servizio per servizio: per la pagina Oggi. */
export function credentialAlerts(
  servizi: ServiceStatus[],
): { kind: 'avviso' | 'errore'; text: string }[] {
  const alerts: { kind: 'avviso' | 'errore'; text: string }[] = [];
  for (const s of servizi) {
    // Con l'accesso regionale (SPID o CIE) le credenziali RUPAR servono solo per il codice via email.
    if (!s.impostate && !s.accessoRegionale) {
      alerts.push({
        kind: 'avviso',
        // Solo la prima lettera in minuscolo: sigle e nomi propri restano come sono (audit D259).
        text: `Mancano le credenziali ${s.nome} (${s.uso.charAt(0).toLowerCase()}${s.uso.slice(1)}).`,
      });
      continue;
    }
    if (s.statoPassword === 'scaduta')
      alerts.push({
        kind: 'errore',
        text: `La password ${s.nome} risulta scaduta: cambiala e inseriscila di nuovo.`,
      });
    else if (s.statoPassword === 'in_scadenza')
      alerts.push({
        kind: 'avviso',
        text: `La password ${s.nome} scade a breve: cambiala per tempo.`,
      });
    if (s.secondoFattore && !s.sessione.attiva)
      alerts.push({
        kind: 'avviso',
        text: s.accessoRegionale
          ? 'Accesso regionale per le ricette SSN non attivo: entra con SPID o CIE.'
          : `Codice di sessione ${s.nome} non attivo: serve per mandare le ricette.`,
      });
  }
  return alerts;
}
