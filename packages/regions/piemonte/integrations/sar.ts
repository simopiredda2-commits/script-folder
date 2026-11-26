import {
  hasNreLots,
  isDpcmServices,
  type PrescriptionGateway,
  type RegionalPrescriptionGateway,
  type RegionalPrescriptionTexts,
  type ServiceAuth,
} from '@mmg/integrations';
import { REGIONAL_SOFTWARE_ID } from './gestionale';
import { RUPAR_CREDENTIALS } from './rupar';

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
    credentialService: RUPAR_CREDENTIALS.slug,
    texts: SAR_TEXTS,
  };
}

/**
 * Credenziali mancanti, o mescolate al token, come le rifiuta il SAR (specifiche del SAR per i
 * prescrittori, 3.1.1 e 4: «Credenziali invalide (from client)», «EA01 - Inserire il PinCode»;
 * REL-STC-01 V08, 4.3.6, con il token). Il simulatore del SAR le usa al posto di quelle nazionali.
 */
export function sarShapeProblem(
  auth: ServiceAuth | undefined,
): { code: string; message: string } | null {
  // Con il token non va nessun altro dato di autenticazione (REL-STC-01 V08, 4.3.6).
  if (auth?.bearer)
    return auth.username || auth.password || auth.pin || auth.sessionId
      ? {
          code: 'CREDENZIALI',
          message:
            'Con il token SPID o CIE non si mandano utente, password, PIN né Id-Sessione (REL-STC-01 V08, 4.3.6)',
        }
      : null;
  if (!auth?.username?.trim() || !auth.password)
    return { code: 'CREDENZIALI', message: 'Credenziali invalide (from client)' };
  if (!auth.pin) return { code: 'EA01', message: 'Inserire il PinCode' };
  return null;
}

/**
 * Autenticazione di una chiamata SOAP ai servizi della ricetta del SIRPED, come la vuole la V08
 * di REL-STC-01. Serve all'adattatore vero del SAR; qui la provano le prove.
 *
 * - Con il token SPID o CIE (4.3.6): solo `X-OAuth2-Authorization: Bearer <jwt>`; niente
 *   `Authorization: Basic`, `<pinCode>` vuoto, nessun altro dato di autenticazione.
 * - Con l'Id-Sessione dell'email certificata (4.1.1, 4.2.5): `Authorization: Basic` con utente e
 *   password RUPAR, `X-idSessione: Bearer <Id-Sessione>`, `X-Gestionale` con il codice del
 *   gestionale seguito da «_» e dal codice dell'ASL (per esempio MIOAPPLICATIVO_301); il PIN va
 *   nella richiesta, cifrato con il certificato della Regione (SAR V06, 3.1.2): lo cifra
 *   l'adattatore.
 *
 * `X-Gestionale` è `auth.software`, cioè `regionalSoftwareId` con il codice ASL del medico (D266).
 */
export function sarAuthentication(auth: ServiceAuth):
  | {
      outcome: 'ok';
      headers: Record<string, string>;
      /** Contenuto di `<pinCode>`: vuoto con il token, altrimenti il PIN da cifrare. */
      pinCode: { kind: 'vuoto' } | { kind: 'da-cifrare'; pin: string };
    }
  | { outcome: 'problem'; code: string; message: string } {
  const shape = sarShapeProblem(auth);
  if (shape) return { outcome: 'problem', ...shape };
  if (auth.bearer)
    return {
      outcome: 'ok',
      headers: { 'X-OAuth2-Authorization': `Bearer ${auth.bearer}` },
      pinCode: { kind: 'vuoto' },
    };
  if (!auth.sessionId)
    return {
      outcome: 'problem',
      code: 'ID_SESSIONE',
      message: 'Manca l’Id-Sessione (secondo fattore)',
    };
  const gestionale = auth.software?.trim() ?? '';
  if (!gestionale)
    return {
      outcome: 'problem',
      code: 'GESTIONALE',
      message: 'Manca il codice del gestionale per X-Gestionale (REL-STC-01 V08, 4.2.5)',
    };
  if (!REGIONAL_SOFTWARE_ID.test(gestionale))
    return {
      outcome: 'problem',
      code: 'GESTIONALE',
      message:
        'X-Gestionale è il codice del gestionale seguito da «_» e dal codice dell’ASL del medico, per esempio MIOAPPLICATIVO_301 (REL-STC-01 V08, 4.2.5)',
    };
  const basic = btoa(
    String.fromCharCode(...new TextEncoder().encode(`${auth.username}:${auth.password}`)),
  );
  return {
    outcome: 'ok',
    headers: {
      Authorization: `Basic ${basic}`,
      'X-idSessione': `Bearer ${auth.sessionId}`,
      'X-Gestionale': gestionale,
    },
    pinCode: { kind: 'da-cifrare', pin: auth.pin! },
  };
}
