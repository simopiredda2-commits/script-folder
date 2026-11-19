/**
 * Colori dei farmaci nella cartella (D152). Lo sfondo della riga dice come si prende il farmaco
 * (cronica, ciclo con data di fine, al bisogno); l'etichetta viola dice la tipologia sulla
 * ricetta (S suggerita dallo specialista, H da ricovero). Le due cose stanno insieme senza
 * regole di precedenza: una terapia cronica suggerita dallo specialista ha lo sfondo azzurro e
 * l'etichetta S. Il colore accompagna sempre la parola, mai la sostituisce.
 */

export type TherapyKind = 'chronic' | 'as_needed' | 'cycle';
export type TherapyOrigin = 'S' | 'H';

const KIND_CLASS: Record<TherapyKind, string> = {
  chronic: 'cronica',
  cycle: 'ciclo',
  as_needed: 'al-bisogno',
};

/** La classe della riga: colore del tipo se la terapia è in corso, altrimenti nessun colore. */
export function drugRowClass(t: { tipo: TherapyKind; stato: string } | null): string {
  if (!t || t.stato !== 'active') return 'farmaco farmaco-non-in-corso';
  return `farmaco farmaco-${KIND_CLASS[t.tipo]}`;
}

export const ORIGIN_LABEL: Record<TherapyOrigin, string> = {
  S: 'S · suggerita dallo specialista',
  H: 'H · da ricovero',
};

/** La tipologia dalla scheda della terapia: S e H non stanno mai insieme. */
export const originOf = (t: { suggestedS: boolean; hospitalH: boolean }): TherapyOrigin | null =>
  t.suggestedS ? 'S' : t.hospitalH ? 'H' : null;

export function OriginTag({ origin }: { origin: TherapyOrigin | null }) {
  if (!origin) return null;
  return <span className="etichetta etichetta-tipologia">{ORIGIN_LABEL[origin]}</span>;
}

/**
 * Legenda dei colori: la stessa per ogni paziente e sempre nello stesso punto, in testa
 * all'elenco dei farmaci (nella cartella sotto «Terapia in corso», nella pagina dei farmaci
 * prescritti sotto la testata).
 */
export function ColourLegend() {
  return (
    <div className="legenda-colori">
      <p className="legenda-titolo" id="legenda-colori-farmaci">
        Legenda dei colori
      </p>
      <ul aria-labelledby="legenda-colori-farmaci">
        <li>
          <span className="campione farmaco-cronica" aria-hidden="true" /> Cronica
        </li>
        <li>
          <span className="campione farmaco-ciclo" aria-hidden="true" /> Ciclo con data di fine
        </li>
        <li>
          <span className="campione farmaco-al-bisogno" aria-hidden="true" /> Al bisogno
        </li>
        <li>
          <span className="etichetta etichetta-tipologia" aria-hidden="true">
            S
          </span>
          <span className="etichetta etichetta-tipologia" aria-hidden="true">
            H
          </span>{' '}
          Suggerita dallo specialista (S), da ricovero (H)
        </li>
        <li>
          <span className="campione farmaco-non-in-corso" aria-hidden="true" /> Non in corso:
          sospesa, conclusa o prescritta senza terapia
        </li>
      </ul>
    </div>
  );
}
