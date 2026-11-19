import { fiscalCodeFacts, patientAdminSchema } from '@mmg/domain';
import type { AuraRegistry } from '@mmg/integrations';
import { REGISTRY_FIELDS } from './registry';

/** Un nuovo assistito segnalato da AURA, come sta in `aura_new_patient` (D199). */
export interface NewPatientCandidate {
  archiveId: string;
  fiscalCode: string;
  lastName: string;
  firstName: string;
  birthDate: string;
  expiresOn: string | null;
  registry: AuraRegistry | null;
}

/**
 * Il corpo per registrare un nuovo assistito con i dati di AURA (D199), con i controlli di
 * «Nuovo paziente»:
 *
 * - identità: cognome, nome e nascita come li dice AURA; sesso e codice del luogo di nascita dal
 *   codice fiscale (omocodia compresa); il nome del luogo dal catalogo dei comuni, se c'è;
 * - residenza, domicilio, ASL e distretto dall'anagrafica di AURA, solo i valori che passano i
 *   controlli del pannello amministrativo (gli altri si vedono dopo come differenze da confermare);
 * - stato «temporaneo» se la scelta ha una scadenza: la scelta la porta il collegamento con AURA.
 */
export function newPatientBody(c: NewPatientCandidate, birthPlaceName: string | null) {
  const facts = fiscalCodeFacts(c.fiscalCode);
  const dati: Record<string, string> = {};
  for (const f of REGISTRY_FIELDS) {
    const value = c.registry?.[f.aura]?.trim();
    if (!value) continue;
    const parsed = patientAdminSchema.shape[f.campo].safeParse(value);
    if (parsed.success && typeof parsed.data === 'string') dati[f.campo] = parsed.data;
  }
  if (c.expiresOn) dati['stato'] = 'temporaneo';
  return {
    archivioId: c.archiveId,
    identita: {
      cognome: c.lastName,
      nome: c.firstName,
      ...(facts ? { sesso: facts.sex, luogoNascitaCodice: facts.placeCode } : {}),
      nascita: c.birthDate,
      luogoNascita: birthPlaceName,
      codiceFiscale: c.fiscalCode,
    },
    dati,
  };
}
