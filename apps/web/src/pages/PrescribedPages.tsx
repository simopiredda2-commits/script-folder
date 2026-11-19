import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { ColourLegend, drugRowClass, OriginTag } from '../components/DrugColours';
import { Icon } from '../components/Icon';
import { PastPrescriptionsSection } from '../components/PastPrescriptions';
import {
  countsText,
  historyHref,
  SERVICE_GROUPS,
  type PastPrescription,
  type PrescribedDrug,
  type PrescribedService,
} from '../components/Prescribed';
import { date, THERAPY_KIND } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

const THERAPY_STATUS: Record<string, string> = {
  suspended: 'Sospesa',
  ended: 'Conclusa',
};

/** Le ricette fatte con un altro programma che i due elenchi restituiscono (tappa 15). */
interface WithPast {
  ricettePassate?: PastPrescription[];
  /** Il medico registra e annulla le ricette passate, come le voci cliniche. */
  puoRegistrare?: boolean;
}

/** Il segno delle voci con ricette fatte con un altro programma: la parola, non solo il conto. */
function PastTag({ c }: { c: PrescribedDrug | PrescribedService }) {
  if (!c.altroProgramma?.ricette) return null;
  return (
    <span className="etichetta">
      <Icon name="archivio" size={16} />{' '}
      {c.ricette > 0 ? 'Anche con un altro programma' : 'Con un altro programma'}
    </span>
  );
}

function DrugRow({ d, patientId }: { d: PrescribedDrug; patientId: string }) {
  const t = d.terapia;
  return (
    <li className={drugRowClass(t)}>
      <div className="terapia-testo">
        <Link to={historyHref(patientId, d.storico)} className="terapia-nome">
          {d.farmaco}
        </Link>
        {d.principioAttivo && d.principioAttivo.toLowerCase() !== d.farmaco.toLowerCase() && (
          <span className="tenue">Principio attivo: {d.principioAttivo}</span>
        )}
        <span>
          {t ? (
            <span className="etichetta">{THERAPY_KIND[t.tipo]}</span>
          ) : (
            <span className="etichetta">Prescritto senza terapia</span>
          )}
          {t && THERAPY_STATUS[t.stato] && (
            <span className="etichetta">{THERAPY_STATUS[t.stato]}</span>
          )}
          <OriginTag origin={t?.tipologia ?? null} />
          <PastTag c={d} />
          {d.notaAifa && <span className="etichetta">Nota {d.notaAifa}</span>}
          {t?.riservata && <span className="etichetta">Riservata</span>}
          {d.aic && <span className="codice tenue">AIC {d.aic}</span>}
        </span>
        <span className="farmaco-conti tenue">
          {countsText(d)}
          {d.ultimi12Mesi > 0 && ` · ${d.ultimi12Mesi} negli ultimi 12 mesi`}
          {t?.stato === 'active' && t.tipo === 'cycle' && t.fine && ` · fino al ${date(t.fine)}`}
          {t?.stato === 'ended' && t.fine && ` · conclusa il ${date(t.fine)}`}
          {t?.motivoSospensione && ` · sospesa: ${t.motivoSospensione}`}
        </span>
      </div>
      <Link to={historyHref(patientId, d.storico)} className="pulsante pulsante-piatto">
        <Icon name="storico" /> <span>{t ? 'Scheda e storico' : 'Storico'}</span>
      </Link>
    </li>
  );
}

function DrugGroup({
  title,
  id,
  drugs,
  patientId,
  empty,
}: {
  title: string;
  id: string;
  drugs: PrescribedDrug[];
  patientId: string;
  empty: string;
}) {
  return (
    <section className="riquadro" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {drugs.length === 0 ? (
        <p className="tenue">{empty}</p>
      ) : (
        <ul className="elenco-farmaci">
          {drugs.map((d) => (
            <DrugRow key={d.chiave} d={d} patientId={patientId} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Tutti i farmaci prescritti al paziente (D152): in corso, sospesi o conclusi, e quelli
 * prescritti senza una terapia in cartella. Ognuno apre il suo storico (D65). Dalla tappa 15 anche
 * le ricette fatte con un altro programma, contate a parte e in un riquadro loro.
 */
export function PrescribedDrugsPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const drugs = useApi<{ farmaci: PrescribedDrug[] } & WithPast>(
    `/api/pazienti/${id}/farmaci-prescritti`,
  );
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const list = drugs.data?.farmaci ?? [];
  const active = list.filter((d) => d.terapia?.stato === 'active');
  const stopped = list.filter((d) => d.terapia && d.terapia.stato !== 'active');
  const occasional = list.filter((d) => !d.terapia);
  return (
    <>
      <PageHeader
        title="Farmaci prescritti"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Farmaci prescritti</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      <ColourLegend />
      {drugs.loading && !drugs.data && <Loading what="farmaci" />}
      {drugs.error?.status === 403 ? (
        <Notice kind="info">I farmaci prescritti non sono visibili con il tuo ruolo.</Notice>
      ) : (
        <ErrorMessage error={drugs.error} />
      )}
      {drugs.data && (
        <>
          <DrugGroup
            id="titolo-farmaci-in-corso"
            title="Terapie in corso"
            drugs={active}
            patientId={id!}
            empty="Nessuna terapia in corso."
          />
          <DrugGroup
            id="titolo-farmaci-sospesi"
            title="Terapie sospese o concluse"
            drugs={stopped}
            patientId={id!}
            empty="Nessuna terapia sospesa o conclusa."
          />
          <DrugGroup
            id="titolo-farmaci-occasionali"
            title="Prescritti senza terapia in cartella"
            drugs={occasional}
            patientId={id!}
            empty="Nessun farmaco prescritto senza terapia."
          />
          <PastPrescriptionsSection
            patientId={id!}
            kind="farmaco"
            items={drugs.data.ricettePassate ?? []}
            canWrite={drugs.data.puoRegistrare === true}
            onChanged={drugs.reload}
          />
        </>
      )}
    </>
  );
}

/** Tutte le visite e tutti gli esami prescritti al paziente (D152), ognuno con il suo storico. */
export function PrescribedServicesPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const services = useApi<{ prestazioni: PrescribedService[] } & WithPast>(
    `/api/pazienti/${id}/prestazioni-prescritte`,
  );
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const list = services.data?.prestazioni ?? [];
  return (
    <>
      <PageHeader
        title="Visite ed esami prescritti"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Visite ed esami prescritti</span>
          </>
        }
        actions={
          <Link className="pulsante" to={`/pazienti/${id}/seguito`}>
            <Icon name="specialistica" /> <span>Seguito delle prestazioni</span>
          </Link>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {services.loading && !services.data && <Loading what="prestazioni" />}
      {services.error?.status === 403 ? (
        <Notice kind="info">Visite ed esami prescritti non sono visibili con il tuo ruolo.</Notice>
      ) : (
        <ErrorMessage error={services.error} />
      )}
      {services.data &&
        SERVICE_GROUPS.map(([group, label]) => {
          const items = list.filter((x) => x.gruppo === group);
          const titleId = `titolo-gruppo-${group}`;
          return (
            <section key={group} className="riquadro" aria-labelledby={titleId}>
              <h2 id={titleId}>{label}</h2>
              {items.length === 0 ? (
                <p className="tenue">
                  {group === 'visita' ? 'Nessuna visita prescritta.' : 'Nessun esame prescritto.'}
                </p>
              ) : (
                <table className="tabella tabella-prescritte">
                  <thead>
                    <tr>
                      <th scope="col">Prestazione</th>
                      <th scope="col">Codice</th>
                      <th scope="col">Ricette</th>
                      <th scope="col">Negli ultimi 12 mesi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((x) => (
                      <tr key={x.chiave}>
                        <td>
                          <Link to={historyHref(id!, x.storico)}>{x.descrizione}</Link>
                          {!!x.altroProgramma?.ricette && (
                            <div>
                              <PastTag c={x} />
                            </div>
                          )}
                        </td>
                        <td className="codice">{x.codice ?? '—'}</td>
                        <td>{countsText(x)}</td>
                        <td>{x.ultimi12Mesi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      {services.data && (
        <PastPrescriptionsSection
          patientId={id!}
          kind="prestazione"
          items={services.data.ricettePassate ?? []}
          canWrite={services.data.puoRegistrare === true}
          onChanged={services.reload}
        />
      )}
      <p className="aiuto">
        Visite: le prestazioni la cui descrizione nel catalogo comincia con «visita», «prima visita»
        o «televisita», o che dopo un trattino nominano la visita. Tutte le altre sono esami e altre
        prestazioni.
      </p>
    </>
  );
}
