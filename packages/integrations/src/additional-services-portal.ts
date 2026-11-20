/**
 * Invio all'ASL della distinta mensile delle prestazioni aggiuntive (PPIP): ACN della medicina
 * generale 2022-2024, allegato 6, comma 4 («entro il giorno 15 di ciascun mese il riepilogo delle
 * prestazioni eseguite nel corso del mese precedente»). In Piemonte la rendicontazione passa dal
 * portale regionale, con lo strumento digitale che predispone l'ASL (AIR 2024, art. 30 e art. 36,
 * comma 6). Le specifiche del portale non sono pubbliche: qui l'interfaccia e il simulatore
 * (regola 7). Il collegamento vero si scrive quando Regione e ASL dicono come (D212).
 */

/** Una prestazione della distinta, con i campi che chiede il comma 4. */
export interface AdditionalServiceLine {
  /** Data di effettuazione, AAAA-MM-GG. */
  performedOn: string;
  patient: {
    fiscalCode: string;
    lastName: string;
    firstName: string;
    /** Indirizzo dell'assistito come lo ha la cartella; vuoto se non c'è. */
    address: string | null;
  };
  code: string;
  description: string;
  quantity: number;
  place: 'studio' | 'home';
  /** Estremi dell'autorizzazione, per le prestazioni che la chiedono (comma 5). */
  authorizationRef: string | null;
  /** Compenso di una prestazione in euro, se il catalogo lo dice. */
  unitCompensation: number | null;
}

export interface AdditionalServicesReport {
  /** Mese delle prestazioni, AAAA-MM. */
  month: string;
  doctor: { fiscalCode: string | null; regionalCode: string | null; name: string };
  lines: AdditionalServiceLine[];
  /** Somma dei compensi, in euro; vuota se una riga non ha il compenso. */
  total: number | null;
}

export type AdditionalServicesResult =
  | { outcome: 'accepted'; protocol: string }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'unreachable'; message: string };

export interface AdditionalServicesPortal {
  readonly environment: 'simulator' | 'test' | 'production';
  submit(report: AdditionalServicesReport): Promise<AdditionalServicesResult>;
}

export interface AdditionalServicesPortalOptions {
  /** Esito di ogni invio. Per difetto: accolto. */
  decide?: (report: AdditionalServicesReport) => AdditionalServicesResult['outcome'];
}

/** Simulatore: tiene le distinte in memoria, per le prove; niente esce davvero. */
export class SimulatedAdditionalServicesPortal implements AdditionalServicesPortal {
  readonly environment = 'simulator' as const;
  readonly reports: AdditionalServicesReport[] = [];
  private counter = 0;

  constructor(private readonly options: AdditionalServicesPortalOptions = {}) {}

  submit(report: AdditionalServicesReport): Promise<AdditionalServicesResult> {
    const outcome = this.options.decide?.(report) ?? 'accepted';
    if (outcome === 'rejected')
      return Promise.resolve({
        outcome,
        message: 'Simulatore: distinta rifiutata per prova',
      });
    if (outcome === 'unreachable')
      return Promise.resolve({
        outcome,
        message: 'Portale regionale non raggiungibile (simulato)',
      });
    this.reports.push(report);
    this.counter += 1;
    return Promise.resolve({
      outcome: 'accepted',
      protocol: `SIM-PPIP-${report.month}-${String(this.counter).padStart(4, '0')}`,
    });
  }
}
