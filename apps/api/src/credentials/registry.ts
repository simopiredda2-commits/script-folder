import {
  NATIONAL_CREDENTIALS,
  type CredentialService,
  type CredentialServiceInfo,
} from '@mmg/domain';
import type { RegionalCredentials } from '@mmg/integrations';
import { REGIONAL_PACKAGES, regionalPackageKey, type RegionalPackage } from '@mmg/regions';

/**
 * I servizi con le credenziali del medico (D100, D301): il Sistema TS e, per ogni pacchetto
 * regionale che le ha, le credenziali dei servizi della regione. Le descrizioni sono dei pacchetti;
 * qui si raccolgono, per le pagine, i messaggi e le sessioni da chiudere.
 */

/** Le credenziali regionali di ogni pacchetto che le ha, con la chiave del pacchetto. */
export function regionalCredentialsOf(
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): { region: string; credentials: RegionalCredentials }[] {
  return packages.flatMap((p) =>
    p.integrations?.credentials ? [{ region: p.key, credentials: p.integrations.credentials }] : [],
  );
}

/** Le chiavi dei servizi delle regioni. */
export const REGIONAL_CREDENTIAL_SERVICES: readonly CredentialService[] =
  regionalCredentialsOf().map((r) => r.credentials.key);

/** Tutte le chiavi: il Sistema TS e i servizi delle regioni. */
export const ALL_CREDENTIAL_SERVICES: readonly CredentialService[] = [
  NATIONAL_CREDENTIALS.key,
  ...REGIONAL_CREDENTIAL_SERVICES,
];

/** La descrizione di un servizio dalla sua chiave, o null se nessun pacchetto la dà più. */
export function credentialServiceInfo(key: CredentialService): CredentialServiceInfo | null {
  if (key === NATIONAL_CREDENTIALS.key) return NATIONAL_CREDENTIALS;
  return regionalCredentialsOf().find((r) => r.credentials.key === key)?.credentials ?? null;
}

/** Il nome di un servizio nelle pagine e nei messaggi: senza descrizione, la chiave. */
export const credentialServiceName = (key: CredentialService): string =>
  credentialServiceInfo(key)?.name ?? key;

/** Le credenziali dei servizi della regione scritta come la scrive l'amministratore, o null. */
export function regionalCredentialsFor(
  regionName: string | null | undefined,
): RegionalCredentials | null {
  const region = regionalPackageKey(regionName);
  return regionalCredentialsOf().find((r) => r.region === region)?.credentials ?? null;
}
