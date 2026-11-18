/**
 * Credenziali dei servizi esterni del medico e secondo fattore (tappa 8, D100–D102).
 *
 * - Sistema TS: certificati di malattia INPS e ricetta bianca (utente, password e PIN). Fonti:
 *   specifiche INPS del Sistema TS, versione 3.2, 4.1; disciplinare tecnico della ricetta bianca,
 *   1/12/2022, 2.3.
 * - RUPAR Piemonte: ricette SSN al SAR della Regione (utente, password e PIN). Fonte: specifiche
 *   del SAR per i prescrittori, 3.1.1. La password scade ogni tre mesi (piano dei test SIRPED,
 *   «Integrazione Cartelle Cliniche MMG/PLS», V02).
 * - Secondo fattore (Id-Sessione): ricetta SSN (DM 27/2/2025) e ricetta bianca (DM 8/6/2023).
 */

import { addMonths } from './sick-leave';

export const CREDENTIAL_SERVICES = ['sistema_ts', 'rupar_piemonte'] as const;
export type CredentialService = (typeof CREDENTIAL_SERVICES)[number];

export const CREDENTIAL_SERVICE_LABELS: Record<CredentialService, string> = {
  sistema_ts: 'Sistema TS',
  rupar_piemonte: 'RUPAR Piemonte',
};

/** A che cosa serve ogni credenziale, detto al medico. */
export const CREDENTIAL_SERVICE_USES: Record<CredentialService, string> = {
  sistema_ts: 'Certificati di malattia INPS e ricetta bianca elettronica',
  rupar_piemonte: 'Ricette SSN al SAR della Regione Piemonte',
};

/**
 * Mesi di validità della password. RUPAR: tre, dal piano dei test SIRPED. Sistema TS: nelle fonti
 * lette non c'è una scadenza, quindi nessun avviso (da completare).
 */
export const PASSWORD_VALIDITY_MONTHS: Record<CredentialService, number | null> = {
  sistema_ts: null,
  rupar_piemonte: 3,
};

/** Giorni di preavviso prima della scadenza della password: parametro dell'interfaccia (D101). */
export const PASSWORD_WARNING_DAYS = 14;

/** Ultimo giorno di validità della password, o null se la scadenza non è nota. */
export function passwordExpiry(service: CredentialService, changedOn: string): string | null {
  const months = PASSWORD_VALIDITY_MONTHS[service];
  return months === null ? null : addMonths(changedOn, months);
}

export type PasswordState = 'valida' | 'in_scadenza' | 'scaduta' | 'senza_scadenza';

/** Stato della password oggi, per l'avviso. La risposta del servizio resta quella che decide. */
export function passwordState(
  service: CredentialService,
  changedOn: string,
  today: string,
): PasswordState {
  const expiry = passwordExpiry(service, changedOn);
  if (!expiry) return 'senza_scadenza';
  if (today >= expiry) return 'scaduta';
  const warnFrom = new Date(Date.parse(`${expiry}T12:00:00Z`) - PASSWORD_WARNING_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return today >= warnFrom ? 'in_scadenza' : 'valida';
}

/** Gli invii che usano le credenziali. */
export const SERVICE_USES = ['ricetta_ssn', 'ricetta_bianca', 'certificato_inps'] as const;
export type ServiceUse = (typeof SERVICE_USES)[number];

export const SERVICE_FOR_USE: Record<ServiceUse, CredentialService> = {
  ricetta_ssn: 'rupar_piemonte',
  ricetta_bianca: 'sistema_ts',
  certificato_inps: 'sistema_ts',
};

/**
 * Quali invii chiedono il secondo fattore. Ricetta SSN: DM 27/2/2025 e SIRPED, autenticazione
 * forte. Ricetta bianca: DM 8/6/2023. Certificato INPS: le fonti lette non lo chiedono, da
 * verificare in collaudo (D102).
 */
export const NEEDS_SECOND_FACTOR: Record<ServiceUse, boolean> = {
  ricetta_ssn: true,
  ricetta_bianca: true,
  certificato_inps: false,
};

/** Le ultime tre lettere dell'utente, per riconoscere la credenziale senza mostrarla. */
export function usernameHint(username: string): string {
  const u = username.trim();
  return `…${u.slice(-3)}`;
}
