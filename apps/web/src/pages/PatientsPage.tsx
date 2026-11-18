import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { query } from '../lib/api';
import { age, date, maskedFiscalCode } from '../lib/format';
import { useApi } from '../lib/useApi';

interface PatientRow {
  id: string;
  nome: string;
  cognome: string;
  dataNascita: string;
  codiceFiscale: string;
  stato: string;
}

const SEARCH_DELAY_MS = 250;

/** Elenco pazienti con ricerca per nome, cognome, codice fiscale, anno di nascita, telefono. */
export function PatientsPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  useEffect(() => {
    const t = setTimeout(
      () => setParams(text ? { q: text } : {}, { replace: true }),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(t);
  }, [text, setParams]);
  const q = params.get('q') ?? '';
  const { data, error, loading } = useApi<{ pazienti: PatientRow[] }>(
    `/api/pazienti${query({ q })}`,
  );

  return (
    <>
      <PageHeader title="Pazienti" />
      <div role="search" className="ricerca">
        <label htmlFor="cerca-paziente">Cerca un paziente</label>
        <div className="ricerca-campo">
          <Icon name="cerca" />
          <input
            id="cerca-paziente"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Cognome, nome, codice fiscale, anno di nascita o telefono"
            autoComplete="off"
          />
        </div>
      </div>
      <ErrorMessage error={error} />
      {loading && !data && <Loading what="pazienti" />}
      {data && (
        <>
          <p role="status" className="tenue">
            {data.pazienti.length === 0
              ? 'Nessun paziente trovato.'
              : `${data.pazienti.length} pazienti${data.pazienti.length === 100 ? ' (i primi 100: affina la ricerca)' : ''}`}
          </p>
          <ul className="elenco-pazienti">
            {data.pazienti.map((p) => (
              <li key={p.id}>
                <Link to={`/pazienti/${p.id}`} className="paziente-riga">
                  <span className="paziente-nome">
                    {p.cognome} {p.nome}
                  </span>
                  <span>
                    {date(p.dataNascita)} · {age(p.dataNascita)} anni
                  </span>
                  <span className="codice">{maskedFiscalCode(p.codiceFiscale)}</span>
                  {p.stato !== 'active' && <span className="etichetta">{p.stato}</span>}
                  <Icon name="apri" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
