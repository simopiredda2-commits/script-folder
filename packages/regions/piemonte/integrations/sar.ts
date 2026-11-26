import {
  hasNreLots,
  isDpcmServices,
  type PrescriptionGateway,
  type RegionalPrescriptionGateway,
  type RegionalPrescriptionTexts,
} from '@mmg/integrations';

/**
 * Le ricette SSN in Piemonte (D300): vanno al SAR della Regione (progetto SIRPED), che le inoltra
 * al SAC del Sistema TS (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026).
 *
 * - La cartella numera da sé le ricette con i lotti di NRE che il SAR le dà, legati al codice
 *   fiscale del medico (3.2 e 4.1; D269).
 * - Senza esito la ricetta SSN farmaceutica o specialistica non si rimanda: si stampa la ricetta
 *   rossa sul modulo del Poligrafico, che parte poi in DPCM (3.5.1, 4.2 e 4.3.1; D270).
 * - Nel promemoria il codice regionale del medico sta davanti al nome, nel campo 27 (4.3.3).
 */

/** Il tipo di lotto che la cartella chiede: in Piemonte solo 1, di 1000 NRE (V06, 3.2 e 4.1). */
export const SAR_LOT_TYPE = '1';

/** TipoInvio della ricetta rossa in DPCM: «RPS» (V06, 4.2.1). */
export const DPCM_SEND_TYPE = 'RPS';

export const SAR_TEXTS: RegionalPrescriptionTexts = {
  service: { name: 'SAR', the: 'il SAR', to: 'al SAR', from: 'dal SAR', of: 'del SAR' },
  // «Esclusivamente» utente, password e PIN RUPAR, senza secondo fattore (V06, 3.1.1).
  lotCredentials:
    'utente, password e PIN RUPAR del medico, anche con l’accesso con SPID o CIE (SIRPED, V06, 3.1.1)',
  reportTo: 'al CSI Piemonte',
};

/**
 * Il SAR come servizio delle ricette della regione: il simulatore, finché non c'è l'adattatore
 * vero (regola 7), o il servizio dato. I lotti di NRE e la ricetta rossa in DPCM ci sono se il
 * servizio li sa dare.
 */
export function sarPrescription(gateway: PrescriptionGateway): RegionalPrescriptionGateway {
  return {
    route: 'gateway',
    gateway,
    ...(hasNreLots(gateway) ? { nreLots: { service: gateway, lotType: SAR_LOT_TYPE } } : {}),
    ...(isDpcmServices(gateway) ? { dpcm: gateway } : {}),
    reminderDoctorCode: true,
    credentialService: 'rupar',
    texts: SAR_TEXTS,
  };
}
