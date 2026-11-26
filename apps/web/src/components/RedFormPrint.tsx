import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ErrorMessage, Notice } from './common';
import { Icon } from './Icon';
import { useRegionalService } from '../lib/regional-service';

/** La ricetta rossa preparata: numero del modulo, NRE nuovo, PDF da stampare (D270). */
export interface RedPrinted {
  nre: string;
  poligrafico: string;
  pdf: string;
  annullamentoDematerializzata: 'da_fare' | null;
  avviso: string | null;
}

/**
 * La ricetta rossa pronta: numero del modulo, NRE nuovo e il PDF da stampare sul modulo. Resta in
 * vista anche quando la ricetta esce dalla coda, come il promemoria delle ricette inviate.
 */
export function RedPrintedNotice({ red, who }: { red: RedPrinted; who?: string }) {
  const service = useRegionalService();
  return (
    <>
      <Notice kind="fatto">
        <p>
          Ricetta rossa {who ? `per ${who} ` : ''}pronta sul modulo{' '}
          <span className="codice">{red.poligrafico}</span>, NRE{' '}
          <span className="codice">{red.nre}</span>. Parte da sola in DPCM entro 24 ore; l’esito si
          vede nella pagina Ricette.
        </p>
        {red.annullamentoDematerializzata && (
          <p>La ricetta dematerializzata, se era arrivata {service.al}, si annulla da sola.</p>
        )}
      </Notice>
      {red.avviso && <Notice kind="avviso">{red.avviso}</Notice>}
      <div className="azioni">
        <a className="pulsante pulsante-primario" href={red.pdf} target="_blank" rel="noopener">
          <Icon name="stampa" /> <span>Stampa sul modulo (PDF)</span>
        </a>
      </div>
    </>
  );
}

/**
 * Ricetta rossa sul modulo del Poligrafico (D270): il medico legge il numero del modulo nella
 * stampante (codice a barre o a mano), sceglie il tipo di visita, e la cartella prepara il PDF con
 * un NRE nuovo; il file DPCM parte poi da sé. Serve quando la ricetta dematerializzata non ha
 * esito, dove la regione vuole la ricetta rossa in DPCM (D300), anche dopo un invio rimasto senza
 * risposta (D233).
 */
export function RedFormPrint({
  prescriptionId,
  onPrinted,
  onCancel,
}: {
  prescriptionId: string;
  onPrinted: (r: RedPrinted) => void;
  /** «Annulla»: si chiude il modulo senza stampare. */
  onCancel?: () => void;
}) {
  const [poligrafico, setPoligrafico] = useState('');
  const [visit, setVisit] = useState<'A' | 'D'>('A');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      onPrinted(
        await api<RedPrinted>(`/api/ricette/${prescriptionId}/ricetta-rossa`, {
          method: 'POST',
          body: { poligrafico, tipoVisita: visit },
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(
              0,
              'Il servizio non ha risposto: ricarica la pagina per vedere se la ricetta rossa è pronta',
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="ricetta-rossa">
      <legend>Ricetta rossa sul modulo del Poligrafico</legend>
      <div className="campo">
        <label htmlFor={`poligrafico-${prescriptionId}`}>
          Numero del modulo nella stampante (codice a barre in alto a destra)
        </label>
        <input
          id={`poligrafico-${prescriptionId}`}
          className="codice"
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          value={poligrafico}
          onChange={(e) => setPoligrafico(e.target.value)}
          aria-describedby={`poligrafico-aiuto-${prescriptionId}`}
        />
        <p className="aiuto" id={`poligrafico-aiuto-${prescriptionId}`}>
          Le 15 cifre del modulo, lette con il lettore di codici a barre o scritte a mano.
        </p>
      </div>
      <div className="campo">
        <label htmlFor={`visita-${prescriptionId}`}>Tipo di visita</label>
        <select
          id={`visita-${prescriptionId}`}
          value={visit}
          onChange={(e) => setVisit(e.target.value === 'D' ? 'D' : 'A')}
        >
          <option value="A">Ambulatoriale</option>
          <option value="D">Domiciliare</option>
        </select>
      </div>
      <ErrorMessage error={error} />
      <div className="azioni">
        <button
          type="button"
          className="pulsante pulsante-primario"
          onClick={() => void prepare()}
          disabled={busy || !poligrafico.trim()}
        >
          <Icon name="stampa" /> <span>Prepara la ricetta rossa</span>
        </button>
        {onCancel && (
          <button type="button" className="pulsante" onClick={onCancel} disabled={busy}>
            <Icon name="annulla" /> <span>Annulla</span>
          </button>
        )}
      </div>
    </fieldset>
  );
}
