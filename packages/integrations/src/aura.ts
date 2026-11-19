/**
 * AURA, l'anagrafe regionale degli assistiti del Piemonte (CSI Piemonte): anagrafica, scelta e
 * revoca del medico, esenzioni (requisiti; D197). Dal manuale pubblico dei servizi di cooperazione
 * (AURA--ORG-01-V08, servizi.regione.piemonte.it/media/786):
 *
 * - ricerca «massiva» dei profili (FIND) per codice fiscale e altri dati: dà gli identificativi AURA;
 * - ricerca puntuale del profilo sanitario completo (GET) per identificativo AURA: anagrafica e dati
 *   sanitari;
 * - notifiche delle variazioni a un servizio dell'ente, ogni 3 minuti, per gli eventi sottoscritti
 *   presso il CSI; nel servizio vero arrivano su un web service esposto sulla rete RUPAR, firmate
 *   con il certificato di AURA.
 *
 * Le specifiche di dettaglio (documenti AURA--SER-01) il CSI le dà alle software house accreditate:
 * nomi dei campi, formati e codici degli eventi sono da completare. Qui l'interfaccia, con i dati
 * che il programma usa, e il simulatore (regola 7).
 */

/** Un'esenzione come la registra AURA. */
export interface AuraExemption {
  code: string;
  /** Codice da riportare in ricetta, se diverso dal codice dell'esenzione. */
  prescriptionCode: string | null;
  validFrom: string;
  validTo: string | null;
}

/** Una scelta del medico come la registra AURA: il medico per codice fiscale. */
export interface AuraChoice {
  doctorFiscalCode: string;
  chosenOn: string;
  expiresOn: string | null;
  endedOn: string | null;
  endReason: string | null;
}

/** Il profilo sanitario completo (GET): quello che il programma ne usa. */
export interface AuraProfile {
  auraId: string;
  fiscalCode: string;
  lastName: string;
  firstName: string;
  birthDate: string;
  exemptions: AuraExemption[];
  choices: AuraChoice[];
}

export type AuraSearch =
  | { outcome: 'found'; auraIds: string[] }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'rejected'; message: string };

export type AuraFetch =
  | { outcome: 'found'; profile: AuraProfile }
  | { outcome: 'not_found' }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'rejected'; message: string };

/** Una variazione notificata da AURA: di chi e che cosa è cambiato. */
export interface AuraNotification {
  auraId: string;
  event: 'esenzione' | 'scelta' | 'anagrafica';
  at: string;
}

export interface AuraGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  findByFiscalCode(fiscalCode: string): Promise<AuraSearch>;
  getProfile(auraId: string): Promise<AuraFetch>;
  /**
   * Riceve le variazioni. Nel servizio vero le manda AURA al web service dell'ente; qui il
   * simulatore le consegna nello stesso processo. Restituisce la funzione che smette di ascoltare.
   */
  onNotification(listener: (n: AuraNotification) => void): () => void;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Simulatore di AURA: un'anagrafe in memoria con soli assistiti inventati. Le modifiche fatte con i
 * suoi metodi (come le farebbe un'ASL) mandano una notifica a chi ascolta. Si può renderlo
 * irraggiungibile, per provare il programma senza rete.
 */
export class SimulatedAura implements AuraGateway {
  readonly environment = 'simulator' as const;
  private readonly profiles = new Map<string, AuraProfile>();
  private readonly listeners = new Set<(n: AuraNotification) => void>();
  private unreachable = false;
  private nextId = 1;

  constructor(private readonly options: { now?: () => Date } = {}) {}

  private now() {
    return (this.options.now ?? (() => new Date()))();
  }

  /** Iscrive un assistito, o lo sostituisce; restituisce il suo identificativo AURA. */
  register(profile: Omit<AuraProfile, 'auraId'> & { auraId?: string }): string {
    const existing = [...this.profiles.values()].find(
      (p) => p.fiscalCode === profile.fiscalCode.toUpperCase(),
    );
    const auraId =
      profile.auraId ?? existing?.auraId ?? `SIM${String(this.nextId++).padStart(9, '0')}`;
    this.profiles.set(auraId, {
      ...clone(profile),
      auraId,
      fiscalCode: profile.fiscalCode.toUpperCase(),
    });
    if (existing) this.notify(auraId, 'anagrafica');
    return auraId;
  }

  /** Aggiunge o sostituisce l'esenzione con lo stesso codice e la stessa data d'inizio. */
  setExemption(auraId: string, e: AuraExemption): void {
    const p = this.mustGet(auraId);
    p.exemptions = [
      ...p.exemptions.filter((x) => !(x.code === e.code && x.validFrom === e.validFrom)),
      clone(e),
    ];
    this.notify(auraId, 'esenzione');
  }

  /** Toglie un'esenzione (per esempio annullata dall'ASL). */
  removeExemption(auraId: string, code: string, validFrom: string): void {
    const p = this.mustGet(auraId);
    p.exemptions = p.exemptions.filter((x) => !(x.code === code && x.validFrom === validFrom));
    this.notify(auraId, 'esenzione');
  }

  /** Aggiunge o sostituisce la scelta con lo stesso medico e la stessa data. */
  setChoice(auraId: string, c: AuraChoice): void {
    const p = this.mustGet(auraId);
    p.choices = [
      ...p.choices.filter(
        (x) => !(x.doctorFiscalCode === c.doctorFiscalCode && x.chosenOn === c.chosenOn),
      ),
      clone(c),
    ];
    this.notify(auraId, 'scelta');
  }

  /** Senza rete: ogni richiesta risponde «non raggiungibile». */
  setUnreachable(value: boolean): void {
    this.unreachable = value;
  }

  findByFiscalCode(fiscalCode: string): Promise<AuraSearch> {
    if (this.unreachable)
      return Promise.resolve({
        outcome: 'unreachable',
        message: 'AURA non raggiungibile (simulatore)',
      });
    const cf = fiscalCode.trim().toUpperCase();
    return Promise.resolve({
      outcome: 'found',
      auraIds: [...this.profiles.values()].filter((p) => p.fiscalCode === cf).map((p) => p.auraId),
    });
  }

  getProfile(auraId: string): Promise<AuraFetch> {
    if (this.unreachable)
      return Promise.resolve({
        outcome: 'unreachable',
        message: 'AURA non raggiungibile (simulatore)',
      });
    const p = this.profiles.get(auraId);
    return Promise.resolve(p ? { outcome: 'found', profile: clone(p) } : { outcome: 'not_found' });
  }

  onNotification(listener: (n: AuraNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mustGet(auraId: string): AuraProfile {
    const p = this.profiles.get(auraId);
    if (!p) throw new Error(`Assistito ${auraId} non iscritto nel simulatore di AURA`);
    return p;
  }

  private notify(auraId: string, event: AuraNotification['event']) {
    const n: AuraNotification = { auraId, event, at: this.now().toISOString() };
    for (const l of this.listeners) l(n);
  }
}
