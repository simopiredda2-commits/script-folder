import type {
  RegionalContextCall,
  RegionalFsePublication,
  RegionalPrescription,
  SimulatedFseGateway,
} from '@mmg/integrations';
import { REGIONAL_PACKAGES, type RegionalIntegrations, type RegionalPackage } from '@mmg/regions';

/**
 * Le integrazioni con i servizi della regione (D297), una per pacchetto: il servizio le sceglie
 * dalla regione dello studio, a ogni richiesta. Si creano alla prima richiesta e restano. Con
 * `override` (le prove, o un adattatore dato dalla configurazione) si usa quella per ogni regione.
 */
export interface RegionalChoice<T> {
  /** L'integrazione per la regione (la chiave del pacchetto), o null se la regione non ce l'ha. */
  for(region: string | null): T | null;
  /** Le integrazioni già create, per esempio per servire le pagine dei simulatori. */
  created(): T[];
}

export function regionalChoice<T>(
  build: (pkg: RegionalPackage) => T | null,
  override?: T,
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): RegionalChoice<T> {
  const made = new Map<string, T | null>();
  return {
    for(region) {
      if (override !== undefined) return override;
      if (region === null) return null;
      if (!made.has(region)) {
        const pkg = packages.find((p) => p.key === region);
        made.set(region, pkg ? build(pkg) : null);
      }
      return made.get(region) ?? null;
    },
    created() {
      if (override !== undefined) return [override];
      return [...made.values()].filter((x): x is T => x !== null);
    },
  };
}

/**
 * Le destinazioni delle chiamate di contesto della regione (D220, D297): i simulatori del
 * pacchetto. Date qui (le prove, o adattatori dalla configurazione), valgono per ogni regione.
 */
export const contextCallChoice = (
  override?: readonly RegionalContextCall[],
  options: { now?: () => Date } = {},
  packages?: readonly RegionalPackage[],
) => regionalChoice((pkg) => pkg.integrations?.contextCalls?.(options) ?? null, override, packages);

/**
 * La pubblicazione del Profilo nel Fascicolo della regione (D280): il simulatore del pacchetto, che
 * pubblica sul Gateway nazionale simulato su cui il programma valida.
 */
export const fsePublicationChoice = (
  override: RegionalFsePublication | undefined,
  options: {
    now?: () => Date;
    gateway: SimulatedFseGateway;
    application: { id: string; vendor: string; version: string };
  },
  packages?: readonly RegionalPackage[],
) =>
  regionalChoice((pkg) => pkg.integrations?.fsePublication?.(options) ?? null, override, packages);

/**
 * Le ricette SSN della regione dello studio (D300): il servizio a cui vanno, con lotti di NRE e
 * ricetta rossa in DPCM se la regione li ha, o il prescrittore esterno. Per difetto il simulatore
 * del pacchetto; con `options.gateway` (le prove, o un adattatore dalla configurazione) quel
 * servizio, con le parole e le scelte della regione. Con `override` la stessa ricetta per ogni
 * regione.
 */
export const prescriptionChoice = (
  override: RegionalPrescription | undefined,
  options: Parameters<NonNullable<RegionalIntegrations['prescription']>>[0],
  packages?: readonly RegionalPackage[],
) => regionalChoice((pkg) => pkg.integrations?.prescription?.(options) ?? null, override, packages);
