import {
  SimulatedGateway,
  SimulatedSecondFactor,
  isSimulatedAuthorizationPage,
  type RegionalAuthorizationGateway,
  type RegionalCredentials,
  type RegionalPrescriptionGateway,
  type RegionalPrescriptionTexts,
  type SimulatedAuthorizationPage,
  type SimulatedValidity,
  type SimulatorOptions,
} from '@mmg/integrations';
import { REGIONAL_PACKAGES, regionalPackageKey } from '@mmg/regions';
import { SCENARIO_REGION } from './scenario';

/**
 * Il simulatore del servizio delle ricette SSN della regione degli studi delle prove, dal suo
 * pacchetto (D300): le prove del ciclo della ricetta lo usano senza nominare la regione, con le
 * scelte del simulatore nazionale (`decide` e le altre) e l'accesso regionale simulato. Le prove
 * del contenuto della regione (lotti di NRE, ricetta rossa in DPCM, catalogo) stanno nelle
 * cartelle del pacchetto.
 */
export function regionalGateway(
  options: SimulatorOptions & { oauth?: SimulatedValidity } = {},
): SimulatedGateway {
  const r = regionalPrescription(options);
  if (!(r.gateway instanceof SimulatedGateway))
    throw new Error('La regione degli studi delle prove non ha il simulatore delle ricette');
  return r.gateway;
}

/** Le parole della ricetta della regione degli studi delle prove: il nome del servizio e il resto. */
export function regionalTexts(): RegionalPrescriptionTexts {
  return regionalPrescription().texts;
}

function scenarioPackage() {
  const key = regionalPackageKey(SCENARIO_REGION);
  return REGIONAL_PACKAGES.find((p) => p.key === key);
}

function regionalPrescription(
  options: SimulatorOptions & { oauth?: SimulatedValidity } = {},
): RegionalPrescriptionGateway {
  const r = scenarioPackage()?.integrations?.prescription?.(options);
  if (r?.route !== 'gateway')
    throw new Error('La regione degli studi delle prove non ha il servizio delle ricette');
  return r;
}

/**
 * Le credenziali dei servizi della regione degli studi delle prove, dal suo pacchetto (D301): la
 * chiave, il nome corto, il nome e il resto, senza nominare la regione.
 */
export function regionalCredentials(): RegionalCredentials {
  const c = scenarioPackage()?.integrations?.credentials;
  if (!c) throw new Error('La regione degli studi delle prove non ha le credenziali regionali');
  return c;
}

/** Il secondo fattore simulato della regione degli studi delle prove. */
export function regionalSecondFactor(now?: () => Date): SimulatedSecondFactor {
  const g = regionalCredentials().secondFactor?.(now ? { now } : {});
  if (!(g instanceof SimulatedSecondFactor))
    throw new Error('La regione degli studi delle prove non ha il secondo fattore simulato');
  return g;
}

/** L'accesso con SPID o CIE simulato della regione degli studi delle prove, con la sua pagina. */
export function regionalAccess(
  now?: () => Date,
): RegionalAuthorizationGateway & SimulatedAuthorizationPage & SimulatedValidity {
  const g = regionalCredentials().strongAccess?.gateway(now ? { now } : {});
  if (
    !g ||
    !isSimulatedAuthorizationPage(g) ||
    typeof (g as Partial<SimulatedValidity>).isValid !== 'function'
  )
    throw new Error('La regione degli studi delle prove non ha l’accesso con SPID o CIE simulato');
  return g as RegionalAuthorizationGateway & SimulatedAuthorizationPage & SimulatedValidity;
}

/**
 * Le credenziali della regione degli studi delle prove come le usa il servizio (D301): con il
 * secondo fattore dato e il codice del programma «SIMULATORE», senza l'accesso con SPID o CIE se
 * non lo si dà.
 */
export function regionalCredentialRuntime(input: {
  secondFactor?: SimulatedSecondFactor | null;
  access?: RegionalAuthorizationGateway | null;
}) {
  const info = regionalCredentials();
  const key = regionalPackageKey(SCENARIO_REGION)!;
  return {
    region: key,
    info,
    secondFactor: input.secondFactor ?? null,
    strongAccess: input.access
      ? {
          gateway: input.access,
          redirectUri: `/api/profilo/credenziali/${info.slug}/accesso-regionale/ritorno`,
        }
      : null,
    softwareCode: info.software ? 'SIMULATORE' : null,
  };
}
