import type {
  RegionalFseAccess,
  RegionalFsePublication,
  SimulatedFseGateway,
} from '@mmg/integrations';

/**
 * Pacchetti regionali (D288, D292): ciò che è legato a una regione sta nel pacchetto di quella
 * regione, scelto dalla regione dello studio e dall'ASL del medico. Qui il contratto di un
 * pacchetto; il nucleo non nomina nessuna regione.
 */

/** Le parti che un pacchetto regionale può dare (D288). Le altre restano quelle nazionali. */
export const REGIONAL_PARTS = [
  'prescription',
  'registry',
  'health_record',
  'siap',
  'additional_services',
  'reporting',
  'catalog',
  'waiting_groups',
  'distribution',
  'exemptions',
  'deadlines',
  'rules',
] as const;
export type RegionalPart = (typeof REGIONAL_PARTS)[number];

/** Il nome di ogni parte nelle pagine: parole nazionali, che non nominano una regione. */
export const REGIONAL_PART_LABELS: Record<RegionalPart, string> = {
  prescription: 'Ricetta elettronica con il servizio della Regione',
  registry: 'Anagrafe regionale degli assistiti',
  health_record: 'Fascicolo sanitario elettronico della Regione',
  siap: 'Invio dei flussi del SIAP alla Regione',
  additional_services: 'Prestazioni aggiuntive dell’accordo integrativo regionale',
  reporting: 'Rendicontazione dell’accordo integrativo regionale',
  catalog: 'Catalogo regionale delle prestazioni specialistiche',
  waiting_groups: 'Tabelle RAO della Regione',
  distribution: 'Farmaci in distribuzione per conto',
  exemptions: 'Esenzioni regionali',
  deadlines: 'Scadenze regionali delle ricette',
  rules: 'Valori regionali delle regole di prescrizione',
};

/**
 * Dove sta oggi una parte del pacchetto: nelle cartelle del pacchetto, o ancora nel nucleo, da
 * spostare un pezzo alla volta (D288).
 */
export type PartLocation = 'package' | 'core';

export interface RegionalPartEntry {
  part: RegionalPart;
  where: PartLocation;
  /** Che cosa dà la regione per questa parte, con gli atti e i servizi. */
  what: string;
}

/** Una variante dell'ASL dentro il pacchetto della regione: gli accordi aziendali (D288). */
export interface AslVariant {
  /** Codice dell'azienda nell'elenco del Ministero, tre cifre, dentro la regione. */
  code: string;
  parts: readonly RegionalPartEntry[];
}

/**
 * Le integrazioni di un pacchetto con i servizi della regione, che non usano il database (D297):
 * attuano i contratti nazionali di `@mmg/integrations`. Il servizio le sceglie dalla regione dello
 * studio. Oggi ci sono i simulatori (regola 7); gli adattatori veri si aggiungono con l'ente.
 */
export interface RegionalIntegrations {
  /** Apertura del Fascicolo della regione dalla cartella (D220): il simulatore. */
  fseAccess?: (options: { now?: () => Date }) => RegionalFseAccess;
  /**
   * Pubblicazione del Profilo Sanitario Sintetico nel Fascicolo della regione (D280): il
   * simulatore, che pubblica sul Gateway nazionale simulato su cui il programma valida.
   */
  fsePublication?: (options: {
    now?: () => Date;
    gateway: SimulatedFseGateway;
    /** Il programma che chiede: nome, fornitore e versione, come li vuole la regione. */
    application: { id: string; vendor: string; version: string };
  }) => RegionalFsePublication;
}

export interface RegionalPackage {
  /** La chiave: il nome delle cartelle del pacchetto (`regions/<chiave>/`). */
  key: string;
  /** Codice della regione nell'elenco del Ministero delle aziende sanitarie, tre cifre. */
  regionCode: string;
  /** Il nome della regione nelle pagine. */
  name: string;
  parts: readonly RegionalPartEntry[];
  asl: readonly AslVariant[];
  /**
   * Le parole che nominano la regione, i suoi enti, servizi e atti: fuori dalle cartelle del
   * pacchetto non si scrivono (prova dei nomi regionali, D292). Si confrontano riga per riga.
   */
  terms: readonly RegExp[];
  /** Le integrazioni con i servizi della regione (D297), se il pacchetto ne ha. */
  integrations?: RegionalIntegrations;
}
