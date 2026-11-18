/** Certificati di malattia INPS: tipi della risposta del servizio (tappa 8). */

export interface CertAddress {
  via: string;
  civico: string;
  cap: string;
  comune: string;
  provincia: string;
}

export interface Certificate {
  id: string;
  stato: 'draft' | 'sending' | 'sent' | 'error' | 'cancelled' | 'rectified';
  etichettaStato: string;
  tipo: 'I' | 'C' | 'R';
  etichettaTipo: string;
  visita: 'A' | 'D' | 'P';
  etichettaVisita: string;
  dataRilascio: string;
  dataInizio: string;
  dataFine: string;
  giorni: number;
  codiceDiagnosi: string | null;
  noteDiagnosi: string | null;
  giornataLavorata: boolean;
  trauma: boolean;
  agevolazioni: 'T' | 'C' | 'I' | null;
  residenza: CertAddress | null;
  reperibilita: { nominativo: string | null; indirizzo: CertAddress | null } | null;
  protocollo: string | null;
  ricevutoIl: string | null;
  rettificaDi: string | null;
  annullamento: { protocollo: string | null; il: string; motivo: string | null } | null;
  errore: { tipo: string | null; codice: string | null; messaggio: string | null } | null;
  annullabile: boolean;
  rettificabile: boolean;
  continuabile: boolean;
}

export interface CertificateList {
  certificati: Certificate[];
  residenza: CertAddress | null;
  recapiti: { email: boolean; telefono: boolean; emailDatore: boolean };
}

export const TYPES = [
  ['I', 'Inizio'],
  ['C', 'Continuazione'],
  ['R', 'Ricaduta'],
] as const;

export const VISITS = [
  ['A', 'Ambulatoriale'],
  ['D', 'Domiciliare'],
  ['P', 'Pronto soccorso'],
] as const;

/** Agevolazioni del modello (schema delle specifiche INPS 3.2). */
export const BENEFITS = [
  ['T', 'Patologia grave che richiede terapia salvavita'],
  ['C', 'Malattia per la quale è stata riconosciuta la causa di servizio'],
  ['I', 'Stato patologico sotteso o connesso alla situazione di invalidità riconosciuta'],
] as const;
