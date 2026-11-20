import { Icon } from './Icon';

/** Una carenza dall'elenco AIFA dei farmaci carenti, come la dà il servizio (D202). */
export interface DrugShortage {
  since: string | null;
  expectedEnd: string | null;
  equivalentAvailable: boolean | null;
  reason: string | null;
  /** «Suggerimenti/Indicazioni AIFA» dell'elenco. */
  aifaAdvice: string | null;
  /** «Nota AIFA» dell'elenco: un testo in parole, non il numero di una nota AIFA. */
  aifaNote: string | null;
  /** La carenza in parole alla data, come nella regola R21. */
  text: string;
}

/**
 * Il farmaco è nell'elenco AIFA dei carenti (D202): simbolo, parola e testo dell'elenco, mai il
 * colore da solo. Con `details`, anche le indicazioni e l'annotazione dell'elenco, con le sue
 * parole: il programma non suggerisce alternative (regola 3).
 */
export function ShortageNote({
  shortage,
  details = false,
}: {
  shortage: DrugShortage;
  details?: boolean;
}) {
  return (
    <span className="carenza">
      <Icon name="avviso" />
      <span>
        <strong>Farmaco carente:</strong> {shortage.text}.
        {details && shortage.aifaAdvice && <> Indicazioni AIFA: {shortage.aifaAdvice}.</>}
        {details && shortage.aifaNote && (
          <span className="carenza-annotazione"> Annotazione dell’elenco: {shortage.aifaNote}</span>
        )}
      </span>
    </span>
  );
}

/** Una variazione AIFA su un farmaco in terapia, come la dà il servizio (A7, D205). */
export interface AifaChange {
  kind: 'sospesa' | 'anagrafica' | 'classe' | 'nota' | 'piano';
  /** La data della versione che la mostra. */
  since: string;
  /** In parole, con la fonte e la versione. */
  text: string;
}

/** Il tipo di variazione in poche parole, per gli elenchi. */
export const AIFA_CHANGE_LABEL: Record<AifaChange['kind'], string> = {
  sospesa: 'confezione sospesa',
  anagrafica: 'uscita dall’anagrafica',
  classe: 'classe cambiata',
  nota: 'nota cambiata',
  piano: 'piano richiesto',
};

/** Come si chiude la variazione: con la terapia aggiornata, o conclusa (D205). */
const HOW_TO: Record<AifaChange['kind'], string> = {
  sospesa: 'si chiude quando la terapia passa a un’altra confezione o è conclusa',
  anagrafica: 'si chiude quando la terapia passa a un’altra confezione o è conclusa',
  classe:
    'si chiude aggiornando la scheda dalla banca dati in vigore («Aggiorna dalla banca dati»)',
  nota: 'si chiude aggiornando la scheda dalla banca dati in vigore («Aggiorna dalla banca dati»): la nota viene dall’elenco DPC',
  piano: 'si chiude collegando il piano terapeutico alla terapia',
};

/**
 * Una variazione AIFA sul farmaco in terapia (A7, D205): simbolo, parola e testo con la fonte,
 * come la carenza. Con `details`, anche come si chiude.
 */
export function AifaChangeNote({
  change,
  details = false,
}: {
  change: AifaChange;
  details?: boolean;
}) {
  return (
    <span className="carenza">
      <Icon name="avviso" />
      <span>
        <strong>Variazione AIFA:</strong> {change.text}.
        {details && <> {cap(HOW_TO[change.kind])}.</>}
      </span>
    </span>
  );
}

/** Confezione sospesa secondo l'anagrafica AIFA in vigore, nei risultati della ricerca (D205). */
export function SuspendedNote() {
  return (
    <span className="carenza">
      <Icon name="avviso" />
      <span>
        <strong>Confezione sospesa</strong> secondo l’anagrafica AIFA delle confezioni.
      </span>
    </span>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Vero se l'anagrafica dice che la confezione è sospesa. */
export const isSuspended = (adminState: string | null | undefined) =>
  (adminState ?? '').trim().toLowerCase() === 'sospesa';
