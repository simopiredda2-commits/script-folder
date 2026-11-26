import type { SoftwareIdentityResult } from '@mmg/integrations';

/**
 * Come il programma si presenta ai servizi della Regione Piemonte (REL-STC-01 V08; D266, D267,
 * D301): il codice che la Regione gli assegna all'avvio dell'autocertificazione, «_» e il codice
 * dell'azienda, che per i medici di medicina generale è l'ASL presso cui operano (esempio della
 * V08: MIOAPPLICATIVO_301). È lo stesso valore in tre punti (D266):
 *
 * - il `client_id` dell'accesso con SPID o CIE (4.3.1, p. 28; 4.3.2, p. 32; 4.3.4 e 4.3.5);
 * - l'intestazione `X-Gestionale` delle chiamate al SAR con l'Id-Sessione per email (4.2.5, p. 25);
 * - l'informazione aggiuntiva «APP» delle richieste dell'Id-Sessione per email (4.2.1, p. 17).
 */

/** La variabile della configurazione con il codice del gestionale (D267). */
export const SOFTWARE_CODE_VARIABLE = 'APP_CODICE_GESTIONALE';

/**
 * Codice del gestionale come lo assegna la Regione all'avvio dell'autocertificazione (REL-STC-01
 * V08, 4.3.1). La V08 non ne dà la forma; l'esempio è MIOAPPLICATIVO. Qui: lettere, cifre, «-» e
 * «_», fino a 64 caratteri.
 */
export const REGIONAL_SOFTWARE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Il codice del gestionale con il codice dell'azienda: MIOAPPLICATIVO_301. */
export const REGIONAL_SOFTWARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}_\d{3}$/;

/** Che cosa non va nel codice del gestionale della configurazione, o null. */
export function softwareCodeProblem(code: string): string | null {
  return REGIONAL_SOFTWARE_CODE.test(code.trim())
    ? null
    : 'il codice del gestionale assegnato dalla Regione ha solo lettere, cifre, «-» e «_» (per esempio MIOAPPLICATIVO)';
}

/** Il codice del gestionale con il codice ASL del medico, o il motivo per cui non si può fare. */
export function regionalSoftwareId(
  softwareCode: string | null | undefined,
  aslCode: string | null | undefined,
): SoftwareIdentityResult {
  const software = softwareCode?.trim() ?? '';
  if (!REGIONAL_SOFTWARE_CODE.test(software))
    return {
      ok: false,
      code: 'GESTIONALE',
      message: software
        ? `Codice del gestionale non valido: «${software}» (lettere, cifre, «-» e «_»)`
        : 'Manca il codice del gestionale assegnato dalla Regione (REL-STC-01 V08, 4.3.1)',
    };
  const asl = aslCode?.trim() ?? '';
  if (!/^\d{3}$/.test(asl))
    return {
      ok: false,
      code: 'ASL',
      message: asl
        ? `Codice ASL del medico non valido: «${asl}» (tre cifre, per esempio 301)`
        : 'Manca il codice ASL del medico: lo scrive l’amministratore nei dati del medico, in Strumenti › Utenti e ruoli (REL-STC-01 V08, 4.3.1)',
    };
  return { ok: true, value: `${software}_${asl}` };
}
