import { useState } from 'react';
import {
  DataVersions,
  ErrorMessage,
  Loading,
  PageHeader,
  type DatasetVersion,
} from '../components/common';
import { Icon } from '../components/Icon';
import { ServiceResultText } from '../components/ServiceResult';
import { ShortageNote } from '../components/Shortage';
import { query } from '../lib/api';
import { money } from '../lib/format';
import { useApi } from '../lib/useApi';
import { drugFacts, useDebounced, type Drug, type Service } from './PrescriptionEditor';

type Filter = 'tutti' | 'classeA' | 'nota' | 'piano' | 'dpc';
const FILTERS: [Filter, string][] = [
  ['tutti', 'Tutta la banca dati'],
  ['classeA', 'Solo classe A'],
  ['nota', 'Con nota AIFA'],
  ['piano', 'Con piano terapeutico'],
  ['dpc', 'In DPC'],
];

function keep(f: Filter, d: Drug): boolean {
  if (f === 'classeA') return d.drugClass === 'A';
  if (f === 'nota') return !!d.aifaNote;
  if (f === 'piano') return !!d.planRequired;
  if (f === 'dpc') return d.dpc;
  return true;
}

function Equivalents({ aic }: { aic: string }) {
  const r = useApi<{ equivalenti: Drug[] }>(`/api/farmaci/${aic}`);
  if (r.loading && !r.data) return <Loading what="equivalenti" />;
  if (!r.data) return <ErrorMessage error={r.error} />;
  if (r.data.equivalenti.length === 0)
    return <p className="tenue">Nessun altro medicinale nello stesso gruppo.</p>;
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption>Medicinali dello stesso gruppo di equivalenza</caption>
        <thead>
          <tr>
            <th scope="col">Medicinale</th>
            <th scope="col">Ditta</th>
            <th scope="col">AIC</th>
            <th scope="col" className="numero">
              Prezzo
            </th>
            <th scope="col" className="numero">
              Differenza dal riferimento
            </th>
            <th scope="col">Carenza</th>
          </tr>
        </thead>
        <tbody>
          {r.data.equivalenti.map((e) => (
            <tr key={e.aic}>
              <td>{[e.name, e.pack].filter(Boolean).join(' ')}</td>
              <td>{e.holder ?? '—'}</td>
              <td className="codice">{e.aic}</td>
              <td className="numero">{money(e.price)}</td>
              <td className="numero">{money(e.priceDifference) || '—'}</td>
              <td>{e.shortage ? <ShortageNote shortage={e.shortage} /> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ricerca farmaci (nome, principio attivo, AIC, ATC) e prestazioni del catalogo regionale. */
export function DataSearchPage() {
  const [tab, setTab] = useState<'farmaci' | 'prestazioni'>('farmaci');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('tutti');
  const [open, setOpen] = useState<string | null>(null);
  const q = useDebounced(text).trim();
  const drugs = useApi<{ farmaci: Drug[]; versioni: DatasetVersion[] }>(
    tab === 'farmaci' && q ? `/api/farmaci${query({ q })}` : null,
  );
  const services = useApi<{ prestazioni: Service[]; versioni: DatasetVersion[] }>(
    tab === 'prestazioni' && q ? `/api/prestazioni${query({ q })}` : null,
  );
  const all = useApi<{ versioni: DatasetVersion[] }>('/api/banche-dati');
  const kinds = tab === 'farmaci' ? ['farmaci', 'farmaci_classe', 'farmaci_dpc'] : ['prestazioni'];
  const versions =
    (tab === 'farmaci' ? drugs.data?.versioni : services.data?.versioni) ??
    all.data?.versioni.filter((v) => kinds.includes(v.kind));
  const shown = (drugs.data?.farmaci ?? []).filter((d) => keep(filter, d));

  return (
    <>
      <PageHeader title="Farmaci e prestazioni" />
      <div className="schede" role="group" aria-label="Che cosa cercare">
        <button
          type="button"
          className="scheda"
          aria-pressed={tab === 'farmaci'}
          onClick={() => setTab('farmaci')}
        >
          <Icon name="farmaci" /> <span>Farmaci</span>
        </button>
        <button
          type="button"
          className="scheda"
          aria-pressed={tab === 'prestazioni'}
          onClick={() => setTab('prestazioni')}
        >
          <Icon name="esami" /> <span>Prestazioni ed esami</span>
        </button>
      </div>
      <div role="search" className="ricerca">
        <label htmlFor="cerca-banca-dati">
          {tab === 'farmaci'
            ? 'Nome commerciale, principio attivo, codice AIC o ATC'
            : 'Prestazione, branca o codice'}
        </label>
        <div className="ricerca-campo">
          <Icon name="cerca" />
          <input
            id="cerca-banca-dati"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      {tab === 'farmaci' && (
        <fieldset className="scelta scelta-in-riga">
          <legend>Mostra</legend>
          {FILTERS.map(([f, label]) => (
            <div key={f} className="casella">
              <input
                type="radio"
                id={`filtro-${f}`}
                name="filtro"
                checked={filter === f}
                onChange={() => setFilter(f)}
              />
              <label htmlFor={`filtro-${f}`}>{label}</label>
            </div>
          ))}
        </fieldset>
      )}
      <DataVersions
        versions={versions}
        label={tab === 'farmaci' ? 'Banche dati dei farmaci' : 'Catalogo'}
      />
      <ErrorMessage error={drugs.error ?? services.error} />
      <div aria-live="polite">
        {tab === 'farmaci' && drugs.data && (
          <>
            <p className="tenue">
              {shown.length === 0 ? `Nessun farmaco per «${q}».` : `${shown.length} farmaci`}
            </p>
            <ul className="risultati">
              {shown.map((d) => (
                <li key={d.aic} className="risultato risultato-colonna">
                  <div>
                    <strong>{d.name ?? d.activeIngredient}</strong>
                    <div className="tenue">
                      {[d.activeIngredient, ...drugFacts(d)].filter(Boolean).join(' · ')}
                    </div>
                    <div className="codice tenue">
                      AIC {d.aic}
                      {d.atc ? ` · ATC ${d.atc}` : ''}
                    </div>
                    {d.shortage && <ShortageNote shortage={d.shortage} details />}
                  </div>
                  <button
                    type="button"
                    className="pulsante pulsante-piatto"
                    aria-expanded={open === d.aic}
                    onClick={() => setOpen(open === d.aic ? null : d.aic)}
                  >
                    {open === d.aic ? 'Nascondi gli equivalenti' : 'Mostra gli equivalenti'}
                  </button>
                  {open === d.aic && <Equivalents aic={d.aic} />}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === 'prestazioni' && services.data && (
          <ul className="risultati">
            {services.data.prestazioni.length === 0 && (
              <li className="tenue">Nessuna prestazione per «{q}».</li>
            )}
            {services.data.prestazioni.map((s) => (
              <li key={s.regionalCode} className="risultato">
                <ServiceResultText s={s} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
