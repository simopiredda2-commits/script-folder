import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { date, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

/** I conteggi del periodo, come li dà il servizio (D201). */
export interface Summary {
  dal: string;
  al: string;
  visite: {
    totale: number;
    telefonici: number;
    perTipo: { tipo: string; nome: string; numero: number }[];
    perMedico: { medico: string; numero: number }[];
  };
  ricette: {
    totale: { inviate: number; cartacee: number; annullate: number; righe: number };
    perTipo: {
      tipo: string;
      nome: string;
      inviate: number;
      cartacee: number;
      annullate: number;
      righe: number;
    }[];
    perMedico: { medico: string; numero: number }[];
  };
  vaccinazioni: {
    totale: number;
    perVaccino: { vaccino: string; campagna: string | null; numero: number }[];
    perMedico: { medico: string; numero: number }[];
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Dal primo del mese a oggi, nell'ora dello studio. */
function thisMonth(): { dal: string; al: string } {
  const today = studioToday();
  return { dal: `${today.slice(0, 8)}01`, al: today };
}

/** Per ogni medico: visite e contatti, ricette (eventi) e vaccinazioni del periodo. */
function byDoctor(s: Summary) {
  const rows = new Map<string, { visite: number; ricette: number; vaccinazioni: number }>();
  const add = (
    list: { medico: string; numero: number }[],
    key: 'visite' | 'ricette' | 'vaccinazioni',
  ) => {
    for (const m of list) {
      const row = rows.get(m.medico) ?? { visite: 0, ricette: 0, vaccinazioni: 0 };
      row[key] += m.numero;
      rows.set(m.medico, row);
    }
  };
  add(s.visite.perMedico, 'visite');
  add(s.ricette.perMedico, 'ricette');
  add(s.vaccinazioni.perMedico, 'vaccinazioni');
  return [...rows].sort((a, b) => a[0].localeCompare(b[0], 'it'));
}

/**
 * Riepiloghi dell'archivio per periodo (requisiti, «Riepiloghi»; D201): visite e contatti dal
 * diario, ricette inviate, cartacee e annullate, vaccinazioni; con l'esportazione in CSV. Il
 * titolare sul suo archivio, la segreteria sugli archivi che l'hanno confermata (D204). Periodo
 * e archivio restano nell'indirizzo.
 */
export function ReportsPage() {
  const { state } = useSession();
  // Il percorso «Archivio / Riepiloghi» solo per chi ha un archivio suo: la segreteria arriva dal
  // menu, e la pagina «Archivio» non è sua.
  const ownsArchive = state.status === 'ready' && !!state.me.archivio;
  const archives = useApi<{ archivi: { id: string; nome: string }[] }>('/api/riepiloghi/archivi');
  const [params, setParams] = useSearchParams();
  const fallback = thisMonth();
  const dal = ISO.test(params.get('dal') ?? '') ? params.get('dal')! : fallback.dal;
  const al = ISO.test(params.get('al') ?? '') ? params.get('al')! : fallback.al;
  const [from, setFrom] = useState(dal);
  const [to, setTo] = useState(al);
  const list = archives.data?.archivi ?? [];
  // L'archivio dell'indirizzo, se è fra quelli di chi guarda; se no il primo.
  const own = list.find((a) => a.id === params.get('archivio')) ?? list[0] ?? null;
  const query = `dal=${dal}&al=${al}`;
  const r = useApi<Summary>(own ? `/api/archivi/${own.id}/riepiloghi?${query}` : null);

  if (archives.loading && !archives.data) return <Loading what="archivi" />;
  if (archives.data && !own) return <Navigate to="/" replace />;
  if (!own) return <ErrorMessage error={archives.error} />;

  function show(e: FormEvent) {
    e.preventDefault();
    setParams(
      { dal: from, al: to, ...(list.length > 1 && own ? { archivio: own.id } : {}) },
      { replace: true },
    );
  }

  const s = r.data;
  const doctors = s ? byDoctor(s) : [];
  return (
    <>
      <PageHeader
        title="Riepiloghi"
        trail={
          ownsArchive ? (
            <>
              <Link to="/archivio">Archivio</Link> <span aria-hidden="true">/</span>{' '}
              <span>Riepiloghi</span>
            </>
          ) : undefined
        }
      />
      <form className="riquadro" onSubmit={show} aria-labelledby="titolo-periodo">
        <h2 id="titolo-periodo">Periodo</h2>
        {list.length > 1 && (
          <div className="campo">
            <label htmlFor="riepilogo-archivio">Archivio</label>
            <select
              id="riepilogo-archivio"
              value={own.id}
              onChange={(e) => setParams({ dal, al, archivio: e.target.value }, { replace: true })}
            >
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nome}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="riepilogo-dal">Dal</label>
            <input
              id="riepilogo-dal"
              type="date"
              required
              max={to || undefined}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor="riepilogo-al">Al (compreso)</label>
            <input
              id="riepilogo-al"
              type="date"
              required
              min={from || undefined}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="cerca" /> <span>Mostra il riepilogo</span>
          </button>
          <a
            className="pulsante"
            href={`/api/archivi/${own.id}/riepiloghi/esportazione?${query}`}
            download
          >
            <Icon name="archivio" /> <span>Scarica in CSV</span>
          </a>
        </div>
        <p className="aiuto">
          Giorni dello studio, in ora italiana. Il CSV ha una riga per visita, per ricetta e per
          vaccinazione, con i nomi dei pazienti e senza testi clinici: ogni esportazione resta nel
          registro degli accessi, paziente per paziente.
        </p>
        <p>
          <Link to="/archivio/prestazioni-aggiuntive">
            Prestazioni aggiuntive (PPIP): la distinta del mese per l’ASL
          </Link>
        </p>
      </form>

      {r.loading && !s && <Loading what="riepilogo" />}
      <ErrorMessage error={r.error} />
      {s && (
        <>
          <p role="status">
            Riepilogo dal {date(s.dal)} al {date(s.al)}: {s.visite.totale} visite,{' '}
            {s.visite.telefonici} contatti telefonici, {s.ricette.totale.inviate} ricette inviate,{' '}
            {s.vaccinazioni.totale} vaccinazioni.
          </p>
          <div className="griglia-cartella">
            <section className="riquadro" aria-labelledby="titolo-visite">
              <h2 id="titolo-visite">Visite e contatti</h2>
              <table className="tabella">
                <caption>Note del diario per tipo di contatto</caption>
                <thead>
                  <tr>
                    <th scope="col">Tipo</th>
                    <th scope="col" className="numero">
                      Numero
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.visite.perTipo.map((t) => (
                    <tr key={t.tipo}>
                      <th scope="row">{t.nome}</th>
                      <td className="numero">{t.numero}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="aiuto">
                Visite: in studio, a domicilio e televisite ({s.visite.totale}). I contatti
                telefonici sono a parte ({s.visite.telefonici}).
              </p>
            </section>

            <section className="riquadro" aria-labelledby="titolo-vaccinazioni">
              <h2 id="titolo-vaccinazioni">Vaccinazioni</h2>
              {s.vaccinazioni.perVaccino.length === 0 ? (
                <p className="tenue">Nessuna vaccinazione nel periodo.</p>
              ) : (
                <table className="tabella">
                  <caption>Vaccinazioni per vaccino e campagna</caption>
                  <thead>
                    <tr>
                      <th scope="col">Vaccino</th>
                      <th scope="col">Campagna</th>
                      <th scope="col" className="numero">
                        Numero
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.vaccinazioni.perVaccino.map((v) => (
                      <tr key={`${v.vaccino}|${v.campagna ?? ''}`}>
                        <th scope="row">{v.vaccino}</th>
                        <td>{v.campagna ?? '—'}</td>
                        <td className="numero">{v.numero}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="riquadro" aria-labelledby="titolo-ricette">
            <h2 id="titolo-ricette">Ricette</h2>
            <div className="tabella-scorrevole">
              <table className="tabella">
                <caption>Ricette fatte nell’archivio, per tipo</caption>
                <thead>
                  <tr>
                    <th scope="col">Tipo</th>
                    <th scope="col" className="numero">
                      Inviate
                    </th>
                    <th scope="col" className="numero">
                      Cartacee
                    </th>
                    <th scope="col" className="numero">
                      Annullate
                    </th>
                    <th scope="col" className="numero">
                      Righe
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.ricette.perTipo.map((t) => (
                    <tr key={t.tipo}>
                      <th scope="row">{t.nome}</th>
                      <td className="numero">{t.inviate}</td>
                      <td className="numero">{t.cartacee}</td>
                      <td className="numero">{t.annullate}</td>
                      <td className="numero">{t.righe}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Totale</th>
                    <td className="numero">{s.ricette.totale.inviate}</td>
                    <td className="numero">{s.ricette.totale.cartacee}</td>
                    <td className="numero">{s.ricette.totale.annullate}</td>
                    <td className="numero">{s.ricette.totale.righe}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="aiuto">
              Ogni ricetta conta il giorno in cui è stata inviata o stampata, e il giorno in cui è
              stata annullata. Le righe sono quelle delle ricette inviate e cartacee.
            </p>
          </section>

          <section className="riquadro" aria-labelledby="titolo-medici">
            <h2 id="titolo-medici">Per medico</h2>
            {doctors.length === 0 ? (
              <p className="tenue">Nessuna attività nel periodo.</p>
            ) : (
              <div className="tabella-scorrevole">
                <table className="tabella">
                  <caption>
                    Chi ha scritto le visite e le vaccinazioni, e chi ha firmato, stampato o
                    annullato le ricette
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Medico</th>
                      <th scope="col" className="numero">
                        Visite e contatti
                      </th>
                      <th scope="col" className="numero">
                        Ricette
                      </th>
                      <th scope="col" className="numero">
                        Vaccinazioni
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {doctors.map(([name, n]) => (
                      <tr key={name}>
                        <th scope="row">{name}</th>
                        <td className="numero">{n.visite}</td>
                        <td className="numero">{n.ricette}</td>
                        <td className="numero">{n.vaccinazioni}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="aiuto">
            PPIP e fatture non ci sono ancora: servono le regole del Piemonte per le prestazioni di
            particolare impegno professionale e la fattura delle prestazioni private.
          </p>
        </>
      )}
    </>
  );
}
