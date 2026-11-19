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
