import {
  SimulatedGateway,
  type RegionalPrescriptionGateway,
  type RegionalPrescriptionTexts,
  type SimulatedRegionalAuthorization,
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
  options: SimulatorOptions & { oauth?: SimulatedRegionalAuthorization } = {},
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

function regionalPrescription(
  options: SimulatorOptions & { oauth?: SimulatedRegionalAuthorization } = {},
): RegionalPrescriptionGateway {
  const key = regionalPackageKey(SCENARIO_REGION);
  const r = REGIONAL_PACKAGES.find((p) => p.key === key)?.integrations?.prescription?.(options);
  if (r?.route !== 'gateway')
    throw new Error('La regione degli studi delle prove non ha il servizio delle ricette');
  return r;
}
