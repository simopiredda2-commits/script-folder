import { SimulatedSecondFactor, type RegionalCredentials } from '@mmg/integrations';
import {
  REGIONAL_SOFTWARE_ID,
  regionalSoftwareId,
  SOFTWARE_CODE_VARIABLE,
  softwareCodeProblem,
} from './gestionale';
import { PRESCRIBER_SCOPE, SimulatedSirpedAccess } from './sirped-access';

/**
 * Le credenziali del medico per i servizi della Regione Piemonte (D301): utente, password e PIN
 * della RUPAR, per il SAR (ricette SSN, lotti di NRE, ricetta rossa in DPCM) e per il Fascicolo
 * regionale (Profilo e apertura dalla cartella). Fonte: specifiche del SAR per i prescrittori,
 * 3.1.1.
 *
 * - La password scade ogni tre mesi (piano dei test SIRPED, «Integrazione Cartelle Cliniche
 *   MMG/PLS», V02).
 * - Il secondo fattore è l'Id-Sessione chiesto con le credenziali RUPAR (CreateAuth), mandato
 *   all'email certificata, verificabile (CheckToken) e revocabile (REL-STC-01, autenticazione
 *   forte, V08 del 23/09/2026, 4.2). Nell'ambiente di prova torna anche nella risposta. Vale 8 ore
 *   per i servizi di prescrizione; un Id-Sessione nuovo revoca il precedente (V08, 3).
 * - Al posto dell'Id-Sessione, per le ricette, l'accesso con SPID o CIE della Regione (V08, 4.3):
 *   `sirped-access.ts`.
 * - Il programma si presenta alla Regione con il codice del gestionale e il codice ASL del medico
 *   (V08; D266, D267): `gestionale.ts`.
 */
export const RUPAR_CREDENTIALS: RegionalCredentials = {
  // La chiave con cui le credenziali RUPAR si conservano da quando ci sono (D100): non cambia,
  // perché utente, password e PIN sono cifrati con lei (D301).
  key: 'rupar_piemonte',
  slug: 'rupar',
  name: 'RUPAR Piemonte',
  use: 'Ricette SSN al SAR e apertura del Fascicolo regionale della Regione Piemonte',
  passwordValidityMonths: 3,
  // Gli altri invii della Regione non chiedono il secondo fattore:
  // - lotto di NRE e ricetta rossa in DPCM: «esclusivamente» utente, password e PIN RUPAR, senza
  //   autenticazione multifattore (SIRPED, «Cartelle cliniche MMG e PLS», V06, 3.1.1; D269);
  // - Fascicolo regionale dalla cartella: il modulo del CSI (LCCE V13, aprile 2026) chiede utente,
  //   password e PIN RUPAR, senza secondo fattore; con l'autenticazione forte di oggi è una domanda
  //   per il CSI (D220, D265);
  // - Profilo Sanitario Sintetico ai servizi del Fascicolo regionale: WS-Security con utente,
  //   password e PIN RUPAR (V09, 3.2.1), senza secondo fattore (D280).
  secondFactorUses: [],
  secondFactor: ({ now }) =>
    new SimulatedSecondFactor('rupar_piemonte', {
      ...(now ? { now } : {}),
      label: 'SIRPED',
      // L'informazione aggiuntiva «APP» è obbligatoria nella richiesta, nella verifica e nella
      // revoca dell'Id-Sessione (V08, 4.2.1–4.2.3): senza, o in un'altra forma, il servizio
      // simulato rifiuta come quello vero.
      softwareProblem: (software) =>
        software && REGIONAL_SOFTWARE_ID.test(software)
          ? null
          : 'Informazione aggiuntiva APP mancante o non valida: codice del gestionale seguito da «_» e dal codice dell’ASL (REL-STC-01 V08, 4.2.1) (simulato)',
      softwareCode: 'APP',
    }),
  software: {
    variable: SOFTWARE_CODE_VARIABLE,
    codeProblem: softwareCodeProblem,
    identify: regionalSoftwareId,
  },
  strongAccess: {
    scope: [PRESCRIBER_SCOPE],
    note: 'Servono però per chiedere al SAR i numeri di ricetta (lotto di NRE) e per la ricetta rossa: tienile salvate qui sopra (SIRPED, «Cartelle cliniche MMG e PLS», V06, 3.1.1).',
    gateway: ({ now }) => new SimulatedSirpedAccess(now ? { now } : {}),
  },
};
