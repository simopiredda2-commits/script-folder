/** Voci cliniche, parametri, privacy e piani terapeutici della cartella (tappa 9). */
import { useApi } from './useApi';

export interface Named {
  chiave: string;
  nome: string;
}

/** I nomi vengono dal servizio, che li prende dal dominio: un'unica fonte. */
export interface Catalog {
  tipi: Named[];
  contatti: Named[];
  sezioniAnamnesi: Named[];
  parametri: (Named & { unita: string; massimo: number | null })[];
  fattori: string[];
  consensi: (Named & { fonte: string | null })[];
  /** Per il Profilo Sanitario Sintetico (tappa 11), dai dizionari ufficiali. */
  categorieProblema: Named[];
  organiMancanti: Coded[];
  nature: Named[];
  agenti: Named[];
  criticita: Named[];
  allergeni: Coded[];
  parenti: Named[];
  capacitaMotorie: Named[];
  vieSomministrazione: string[];
}

/** Voce di un dizionario ufficiale: codice e descrizione. */
export interface Coded {
  codice: string;
  nome: string;
}

export function useCatalog() {
  return useApi<Catalog>('/api/voci-cliniche/catalogo');
}

export const nameOf = (list: Named[] | undefined, key: string | null | undefined) =>
  list?.find((x) => x.chiave === key)?.nome ?? key ?? '';

export type EntryType =
  | 'problema'
  | 'diario'
  | 'misura'
  | 'anamnesi'
  | 'allergia'
  | 'stile_di_vita'
  | 'esame_obiettivo'
  | 'capacita_motoria';

export interface Entry {
  id: string;
  tipo: EntryType;
  data: string;
  autore: string;
  note: string | null;
  riservata: boolean;
  oscurata: boolean;
  promemoria: string | null;
  stato: 'attiva' | 'annullata';
  annullataIl: string | null;
  motivoAnnullamento: string | null;
  dettaglio: Record<string, string | number | boolean | null> | null;
}

export interface EntryList {
  voci: Entry[];
  puoScrivere: boolean;
}

export interface Series {
  parametro: string;
  unita: string;
  valori: { id: string; data: string; valore: string }[];
}

export interface Consent {
  id: string;
  tipo: string;
  nome: string;
  fonte: string | null;
  stato: 'dato' | 'negato' | 'revocato';
  data: string | null;
  revocatoIl: string | null;
  espressoDa: string | null;
  note: string | null;
  registratoDa: string | null;
  inVigore: boolean;
}

export interface Delegation {
  id: string;
  nome: string;
  codiceFiscale: string | null;
  telefono: string | null;
  email: string | null;
  ambito: string;
  dal: string;
  al: string | null;
  revocataIl: string | null;
  validaOggi: boolean;
}

export interface Privacy {
  consensi: Consent[];
  deleghe: Delegation[];
  puoScrivere: boolean;
}

export interface Plan {
  id: string;
  farmaco: string;
  aic: string | null;
  principioAttivo: string | null;
  rilasciatoIl: string;
  scadeIl: string;
  centro: string | null;
  specialista: string | null;
  confezioniAutorizzate: number | null;
  posologia: string | null;
  cartaceo: boolean;
  riservato: boolean;
  note: string | null;
  stato: 'attivo' | 'annullato';
  motivoAnnullamento: string | null;
  validita: 'valido' | 'scaduto' | 'non_ancora_valido';
  giorniAllaScadenza: number;
  registratoDa: string | null;
}

export const CONSENT_STATUS_LABEL: Record<Consent['stato'], string> = {
  dato: 'Dato',
  negato: 'Negato',
  revocato: 'Revocato',
};

export const PLAN_VALIDITY_LABEL: Record<Plan['validita'], string> = {
  valido: 'Valido',
  scaduto: 'Scaduto',
  non_ancora_valido: 'Non ancora valido',
};
