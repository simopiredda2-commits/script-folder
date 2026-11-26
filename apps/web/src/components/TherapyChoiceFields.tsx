import { Notice } from './common';

/**
 * Il tipo di terapia sulla riga della ricetta (D282, D283): tipo (cronica, ciclo, al bisogno),
 * tipologia S o H e «Non rimborsabile SSN». Alla firma il programma crea la terapia, o aggiorna
 * quella collegata. Della segreteria è una proposta, che il medico conferma o no quando firma.
 */

export type ChoiceKind = '' | 'chronic' | 'as_needed' | 'cycle';

/** La scelta come la tiene la riga nell'editor: testi dei campi, vuoti se non scritti. */
export interface ChoiceDraft {
  kind: ChoiceKind;
  endOn: string;
  typology: '' | 'S' | 'H';
  notReimbursable: boolean;
  suggestedByName: string;
  suggestedByFacility: string;
  suggestedOn: string;
}

export const NO_CHOICE: ChoiceDraft = {
  kind: '',
  endOn: '',
  typology: '',
  notReimbursable: false,
  suggestedByName: '',
  suggestedByFacility: '',
  suggestedOn: '',
};

/** I campi della terapia che la riga mostra e può cambiare. */
export interface TherapyChoiceSource {
  kind: 'chronic' | 'as_needed' | 'cycle';
  endOn?: string | null;
  suggestedS?: boolean;
  hospitalH?: boolean;
  notReimbursable?: boolean;
  suggestedByName?: string | null;
  suggestedByFacility?: string | null;
  suggestedOn?: string | null;
}

/** La scelta com'è nella scheda della terapia: da qui parte la riga di una terapia in corso. */
export function choiceFromTherapy(t: TherapyChoiceSource): ChoiceDraft {
  return {
    kind: t.kind,
    endOn: t.endOn ?? '',
    typology: t.suggestedS ? 'S' : t.hospitalH ? 'H' : '',
    notReimbursable: !!t.notReimbursable,
    suggestedByName: t.suggestedByName ?? '',
    suggestedByFacility: t.suggestedByFacility ?? '',
    suggestedOn: t.suggestedOn ?? '',
  };
}

/** Che cosa della scelta conta: la fine solo per il ciclo, il suggeritore solo con la S. */
function relevant(c: ChoiceDraft) {
  const s = c.typology === 'S';
  return {
    kind: c.kind,
    endOn: c.kind === 'cycle' ? c.endOn : '',
    typology: c.typology,
    notReimbursable: c.notReimbursable,
    suggestedByName: s ? c.suggestedByName.trim() : '',
    suggestedByFacility: s ? c.suggestedByFacility.trim() : '',
    suggestedOn: s ? c.suggestedOn : '',
  };
}

/** La scelta cambia qualcosa: rispetto alla terapia collegata, o perché ne crea una. */
export function choiceChanged(c: ChoiceDraft | undefined, base: ChoiceDraft | undefined): boolean {
  if (!c || c.kind === '') return false;
  if (!base) return true;
  return JSON.stringify(relevant(c)) !== JSON.stringify(relevant(base));
}

/** La scelta come la vuole il servizio, o null se la riga non sceglie niente. */
export function choiceBody(c: ChoiceDraft | undefined, base: ChoiceDraft | undefined) {
  if (!c || !choiceChanged(c, base) || c.kind === '') return null;
  const r = relevant(c);
  return {
    kind: c.kind,
    endOn: r.endOn || null,
    typology: c.typology || null,
    notReimbursable: c.notReimbursable,
    suggestedByName: r.suggestedByName || null,
    suggestedByFacility: r.suggestedByFacility || null,
    suggestedOn: r.suggestedOn || null,
  };
}

const KIND_LABEL: Record<Exclude<ChoiceKind, ''>, string> = {
  chronic: 'cronica',
  as_needed: 'al bisogno',
  cycle: 'ciclo',
};

const itDate = (d: string) => d.split('-').reverse().join('/');

/** La scelta in breve, per la riga chiusa: solo se cambia qualcosa. */
export function choiceSummary(
  c: ChoiceDraft | undefined,
  base: ChoiceDraft | undefined,
): string | null {
  if (!c || !choiceChanged(c, base) || c.kind === '') return null;
  const kind =
    c.kind === 'cycle' && c.endOn ? `ciclo fino al ${itDate(c.endOn)}` : KIND_LABEL[c.kind];
  return [
    `terapia ${kind}`,
    c.typology === 'S' ? 'S' : c.typology === 'H' ? 'H' : null,
    c.notReimbursable ? 'non rimborsabile SSN' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Problemi della scelta prima di salvare la bozza: si dicono accanto al campo. */
export function choiceProblems(c: ChoiceDraft | undefined): string[] {
  if (!c || c.kind === '') return [];
  const out: string[] = [];
  if (c.kind === 'cycle' && !c.endOn) out.push('Ciclo: manca la data di fine');
  if (c.typology === 'S' && !c.suggestedByName.trim())
    out.push('Suggerita (S): manca il medico suggeritore');
  return out;
}

export function TherapyChoiceFields({
  id,
  value,
  base,
  white,
  proposal,
  onChange,
}: {
  /** Chiave della riga: gli identificativi dei campi. */
  id: string;
  value: ChoiceDraft;
  /** La terapia collegata, com'era quando la riga è entrata; assente per un farmaco nuovo. */
  base?: ChoiceDraft;
  /** Ricetta bianca. */
  white: boolean;
  /** Chi segna non firma (la segreteria): la scelta è una proposta per il medico. */
  proposal: boolean;
  onChange: (patch: Partial<ChoiceDraft>) => void;
}) {
  const active = value.kind !== '';
  const changed = choiceChanged(value, base);
  // In ricetta SSN la casella si toglie, non si mette: «Non rimborsabile SSN» va in bianca (R8).
  const reimbursableOnly = !white && !value.notReimbursable;
  const help = `tt-aiuto-${id}`;
  return (
    <fieldset className="scelta-terapia">
      <legend>Terapia</legend>
      <div className="campi-riga">
        <div className="campo">
          <label htmlFor={`tt-${id}`}>Tipo di terapia</label>
          <select
            id={`tt-${id}`}
            value={value.kind}
            aria-describedby={help}
            onChange={(e) => onChange({ kind: e.target.value as ChoiceKind })}
          >
            {!base && <option value="">Nessuna: prescrizione occasionale</option>}
            <option value="chronic">Cronica</option>
            <option value="cycle">Ciclo</option>
            <option value="as_needed">Al bisogno</option>
          </select>
        </div>
        {value.kind === 'cycle' && (
          <div className="campo campo-stretto">
            <label htmlFor={`tf-${id}`}>Fine del ciclo</label>
            <input
              id={`tf-${id}`}
              type="date"
              required
              value={value.endOn}
              onChange={(e) => onChange({ endOn: e.target.value })}
            />
          </div>
        )}
        {active && (
          <div className="campo">
            <label htmlFor={`ttp-${id}`}>Tipologia</label>
            <select
              id={`ttp-${id}`}
              value={value.typology}
              onChange={(e) => onChange({ typology: e.target.value as ChoiceDraft['typology'] })}
            >
              <option value="">Nessuna</option>
              <option value="S">Suggerita (S)</option>
              <option value="H">Ricovero (H)</option>
            </select>
          </div>
        )}
      </div>
      {active && value.typology === 'S' && (
        <div className="campi-riga">
          <div className="campo">
            <label htmlFor={`tsn-${id}`}>Medico suggeritore</label>
            <input
              id={`tsn-${id}`}
              required
              value={value.suggestedByName}
              onChange={(e) => onChange({ suggestedByName: e.target.value })}
            />
          </div>
          <div className="campo">
            <label htmlFor={`tss-${id}`}>Struttura</label>
            <input
              id={`tss-${id}`}
              value={value.suggestedByFacility}
              onChange={(e) => onChange({ suggestedByFacility: e.target.value })}
            />
          </div>
          <div className="campo campo-stretto">
            <label htmlFor={`tsd-${id}`}>Data</label>
            <input
              id={`tsd-${id}`}
              type="date"
              value={value.suggestedOn}
              onChange={(e) => onChange({ suggestedOn: e.target.value })}
            />
          </div>
        </div>
      )}
      {active && (
        <div className="casella">
          <input
            type="checkbox"
            id={`tnr-${id}`}
            checked={value.notReimbursable}
            disabled={reimbursableOnly}
            onChange={(e) => onChange({ notReimbursable: e.target.checked })}
          />
          <label htmlFor={`tnr-${id}`}>
            Non rimborsabile SSN{' '}
            <span className="tenue">
              {white
                ? '· le ripetizioni vanno in ricetta bianca'
                : '· si prescrive solo su ricetta bianca'}
            </span>
          </label>
        </div>
      )}
      {active && !white && value.notReimbursable && (
        <Notice kind="avviso">
          La terapia è segnata «Non rimborsabile SSN»: in ricetta SSN togli la spunta, oppure scegli
          la ricetta bianca.
        </Notice>
      )}
      <p className="aiuto" id={help}>
        {!active
          ? 'Prescrizione occasionale: la terapia in cartella non si crea.'
          : !changed
            ? 'Come nella scheda della terapia.'
            : proposal
              ? 'È una proposta per il medico: la conferma, o no, quando firma.'
              : base
                ? 'Alla firma si aggiorna la terapia in cartella.'
                : 'Alla firma si crea la terapia in cartella. Dose, unità al giorno e indicazione si completano nella scheda della terapia.'}
      </p>
    </fieldset>
  );
}
