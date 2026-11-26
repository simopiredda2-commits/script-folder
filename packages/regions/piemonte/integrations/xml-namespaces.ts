import { PASSWORD_TEXT, V09_NAMESPACES } from './fse-publication';

/**
 * Gli spazi dei nomi XML dei messaggi del pacchetto: identificativi, non indirizzi da chiamare
 * (regola 7). La prova `packages/regions/test/regola-7.test.ts` li toglie prima di cercare
 * indirizzi nel codice delle integrazioni.
 */
export const XML_NAMESPACES: readonly string[] = [...Object.values(V09_NAMESPACES), PASSWORD_TEXT];
