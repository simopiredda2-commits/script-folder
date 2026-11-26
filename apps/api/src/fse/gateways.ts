import {
  FseGatewayClient,
  SimulatedFseGateway,
  type FseCredentials,
  type FseTransport,
} from '@mmg/integrations';

/**
 * Il cliente del Gateway del Fascicolo per la regione dello studio (D298). I certificati di
 * produzione non li dà Sogei: si chiedono ai referenti di ogni Regione (risposta di Sogei a Simone
 * del 26/11/2026, `docs/fse.md`). Il programma tiene quindi una coppia di certificati per regione
 * (collegamento e firma dei token) e sceglie quella della regione dello studio del medico, dal
 * codice della regione nell'elenco nazionale delle aziende sanitarie («010»). Con il simulatore,
 * una coppia di prova per regione; senza certificati per la regione, nessun cliente.
 */
export interface GatewayChoice {
  for(regionCode: string | null): FseGatewayClient | null;
}

export function gatewayChoice(options: {
  /** Dato, vale per ogni regione (le prove). */
  override?: FseGatewayClient;
  /** Il Gateway: il simulatore, per difetto. */
  transport?: FseTransport;
  /** I certificati della regione; per difetto, con il simulatore, una coppia di prova. */
  credentialsFor?: (regionCode: string) => FseCredentials | null;
  now?: () => Date;
}): GatewayChoice {
  const made = new Map<string, FseGatewayClient | null>();
  const { override, transport, now } = options;
  const credentialsFor =
    options.credentialsFor ??
    (transport instanceof SimulatedFseGateway
      ? (code: string) => transport.issueCredentials(`Programma (regione ${code})`)
      : () => null);
  return {
    for(regionCode) {
      if (override) return override;
      if (regionCode === null || !transport) return null;
      if (!made.has(regionCode)) {
        const credentials = credentialsFor(regionCode);
        made.set(
          regionCode,
          credentials ? new FseGatewayClient(transport, credentials, now) : null,
        );
      }
      return made.get(regionCode) ?? null;
    },
  };
}

/** Quando per la regione dello studio il programma non ha i certificati del Gateway (D298). */
export const NO_GATEWAY_CREDENTIALS =
  'Per la regione dello studio il programma non ha ancora i certificati del Gateway del Fascicolo: li danno i referenti della Regione';
