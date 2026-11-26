/**
 * Credenziali dei servizi esterni del medico e secondo fattore (tappa 8, D100–D102; D301).
 *
 * - Sistema TS, il servizio nazionale: certificati di malattia INPS e ricetta bianca (utente,
 *   password e PIN). Fonti: specifiche INPS del Sistema TS, versione 3.2, 4.1; disciplinare tecnico
 *   della ricetta bianca, 1/12/2022, 2.3.
 * - Il servizio della regione dello studio, per le ricette SSN e gli altri servizi della regione:
 *   che servizio è, come si chiama, quanto dura la password e quali invii chiedono il secondo
 *   fattore lo dice il pacchetto della regione (D301).
 * - Secondo fattore (Id-Sessione): ricetta SSN (DM 27/2/2025) e ricetta bianca (DM 8/6/2023), in
 *   tutte le regioni.
 */

import { addMonths } from './sick-leave';

/**
 * La chiave di un servizio con le credenziali del medico: il Sistema TS o il servizio di una
 * regione, come lo chiama il suo pacchetto (D301). Utente, password e PIN si conservano e si
 * cifrano con questa chiave: una volta data, non cambia.
 */
export type CredentialService = string;

/** Forma di una chiave: lettere minuscole, cifre e «_», da 2 a 40 caratteri, prima una lettera. */
export const CREDENTIAL_SERVICE_KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** Forma del nome corto di un servizio nelle rotte e negli errori: minuscole, cifre e «-». */
export const CREDENTIAL_SERVICE_SLUG = /^[a-z][a-z0-9-]{1,39}$/;

/** Come le pagine e i messaggi descrivono un servizio con le credenziali del medico. */
export interface CredentialServiceInfo {
  /** La chiave con cui le credenziali si conservano. */
  key: CredentialService;
  /** Nelle rotte e negli errori, corto: «sistema-ts». */
  slug: string;
  /** Il nome nelle pagine. */
  name: string;
  /** A che cosa servono le credenziali, detto al medico. */
  use: string;
  /** Mesi di validità della password; null se le fonti non la dicono: nessun avviso. */
  passwordValidityMonths: number | null;
}

/** Il Sistema TS: nelle fonti lette non c'è una scadenza della password (da completare). */
export const NATIONAL_CREDENTIALS: CredentialServiceInfo = {
  key: 'sistema_ts',
  slug: 'sistema-ts',
  name: 'Sistema TS',
  use: 'Certificati di malattia INPS e ricetta bianca elettronica',
  passwordValidityMonths: null,
};

/** Giorni di preavviso prima della scadenza della password: parametro dell'interfaccia (D101). */
export const PASSWORD_WARNING_DAYS = 14;

/** Ultimo giorno di validità della password, o null se la scadenza non è nota. */
export function passwordExpiry(validityMonths: number | null, changedOn: string): string | null {
  return validityMonths === null ? null : addMonths(changedOn, validityMonths);
}

export type PasswordState = 'valida' | 'in_scadenza' | 'scaduta' | 'senza_scadenza';

/** Stato della password oggi, per l'avviso. La risposta del servizio resta quella che decide. */
export function passwordState(
  validityMonths: number | null,
  changedOn: string,
  today: string,
): PasswordState {
  const expiry = passwordExpiry(validityMonths, changedOn);
  if (!expiry) return 'senza_scadenza';
  if (today >= expiry) return 'scaduta';
  const warnFrom = new Date(Date.parse(`${expiry}T12:00:00Z`) - PASSWORD_WARNING_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return today >= warnFrom ? 'in_scadenza' : 'valida';
}

/** Gli invii che usano le credenziali. */
export const SERVICE_USES = [
  'ricetta_ssn',
  'ricetta_bianca',
  'certificato_inps',
  'fascicolo_regionale',
  'lotto_nre',
  'ricetta_dpcm',
  'profilo_sanitario',
] as const;
export type ServiceUse = (typeof SERVICE_USES)[number];

/** Gli invii al Sistema TS, in tutte le regioni. */
export const NATIONAL_USES = [
  'ricetta_bianca',
  'certificato_inps',
] as const satisfies readonly ServiceUse[];
export type NationalUse = (typeof NATIONAL_USES)[number];

/**
 * Gli invii ai servizi della regione dello studio: con quali credenziali li dice l'integrazione
 * della regione (D300, D301). La ricetta SSN, per esempio, va al servizio della regione.
 */
export const REGIONAL_USES = [
  'ricetta_ssn',
  'fascicolo_regionale',
  'lotto_nre',
  'ricetta_dpcm',
  'profilo_sanitario',
] as const satisfies readonly ServiceUse[];
export type RegionalUse = (typeof REGIONAL_USES)[number];

export const isNationalUse = (use: ServiceUse): use is NationalUse =>
  (NATIONAL_USES as readonly ServiceUse[]).includes(use);

/**
 * Gli invii che chiedono il secondo fattore per legge, in tutte le regioni: ricetta SSN (DM
 * 27/2/2025) e ricetta bianca (DM 8/6/2023). Il certificato INPS no: le fonti lette non lo
 * chiedono, da verificare in collaudo (D102). Per gli altri invii della regione lo dice il
 * pacchetto della regione (D301).
 */
export const NATIONAL_SECOND_FACTOR: Readonly<Record<'ricetta_ssn' | NationalUse, boolean>> = {
  ricetta_ssn: true,
  ricetta_bianca: true,
  certificato_inps: false,
};

/**
 * L'invio chiede il secondo fattore? Per legge (`NATIONAL_SECOND_FACTOR`), o perché il servizio
 * della regione lo chiede per quell'invio (`regionalSecondFactorUses`, dal pacchetto).
 */
export function needsSecondFactor(
  use: ServiceUse,
  regionalSecondFactorUses: readonly RegionalUse[] = [],
): boolean {
  if (Object.hasOwn(NATIONAL_SECOND_FACTOR, use))
    return NATIONAL_SECOND_FACTOR[use as keyof typeof NATIONAL_SECOND_FACTOR];
  return (regionalSecondFactorUses as readonly ServiceUse[]).includes(use);
}

/** Le ultime tre lettere dell'utente, per riconoscere la credenziale senza mostrarla. */
export function usernameHint(username: string): string {
  const u = username.trim();
  return `…${u.slice(-3)}`;
}
