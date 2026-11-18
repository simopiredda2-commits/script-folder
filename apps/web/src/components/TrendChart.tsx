import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { date } from '../lib/format';

export interface TrendSeries {
  /** Nome della serie (es. «Sistolica»). */
  name: string;
  /** Classe del colore: serie-1 o serie-2 (global.css), validate con il controllo dei colori. */
  tone: 'serie-1' | 'serie-2';
  /** Seconda codifica oltre al colore: forma del punto. */
  marker: 'cerchio' | 'quadrato';
  points: { data: string; valore: number }[];
}

const W = 640;
const H = 240;
const PAD = { top: 16, right: 116, bottom: 30, left: 48 };
const DAY = 86_400_000;

const decimal = (n: number) =>
  new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(n);

/** Tacche «tonde» per l'asse delle y, da 3 a 6. */
function niceTicks(min: number, max: number): number[] {
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    min -= d;
    max += d;
  }
  const raw = (max - min) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(10)));
  if (out[out.length - 1]! < max) out.push(out[out.length - 1]! + step);
  return out;
}

const time = (d: string) => Date.parse(`${d}T12:00:00Z`);

/**
 * Andamento di un parametro nel tempo: una sola scala (mai due assi), linee da 2 px, punti con
 * l'anello del colore di fondo, etichetta del valore in fondo alla linea. Il cursore segue il
 * puntatore e le frecce della tastiera; la tabella sotto il grafico ha gli stessi valori.
 */
export function TrendChart({
  title,
  unit,
  series,
}: {
  title: string;
  unit: string;
  series: TrendSeries[];
}) {
  const uid = useId();
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.data)))].sort();
  const values = series.flatMap((s) => s.points.map((p) => p.valore));
  const [active, setActive] = useState<number | null>(null);
  if (dates.length === 0) return null;

  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  const t0 = time(dates[0]!);
  const t1 = time(dates[dates.length - 1]!);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (d: string) =>
    t1 === t0 ? PAD.left + plotW / 2 : PAD.left + ((time(d) - t0) / (t1 - t0)) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const xTicks = t1 - t0 < DAY ? [dates[0]!] : [dates[0]!, dates[dates.length - 1]!];

  function nearest(clientX: number, rect: DOMRect) {
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < dates.length; i++)
      if (Math.abs(x(dates[i]!) - px) < Math.abs(x(dates[best]!) - px)) best = i;
    return best;
  }
  const onMove = (e: PointerEvent<SVGSVGElement>) =>
    setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const last = dates.length - 1;
    const cur = active ?? last;
    const next =
      e.key === 'ArrowLeft'
        ? Math.max(0, cur - 1)
        : e.key === 'ArrowRight'
          ? Math.min(last, cur + 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  }

  const at = active === null ? null : dates[active]!;
  const readout =
    at &&
    series
      .map((s) => ({
        s,
        v: s.points.filter((p) => p.data === at).map((p) => decimal(p.valore)),
      }))
      .filter((r) => r.v.length);
  // Il riquadro sta dal lato opposto alle etichette di fine linea: a sinistra del cursore quando
  // il cursore è nella metà destra, a destra quando è nella sinistra.
  const tipAt = at ? (x(at) / W) * 100 : 0;
  const tipStyle =
    tipAt > 50
      ? { right: `calc(${100 - tipAt}% + 0.75rem)` }
      : { left: `calc(${tipAt}% + 0.75rem)` };

  return (
    <figure className="grafico" aria-labelledby={`${uid}-titolo`}>
      <figcaption id={`${uid}-titolo`} className="grafico-titolo">
        {title} <span className="tenue">({unit})</span>
      </figcaption>
      {series.length > 1 && (
        <ul className="grafico-legenda" aria-label="Legenda">
          {series.map((s) => (
            <li key={s.name}>
              <svg width="28" height="12" aria-hidden="true">
                <line x1="2" y1="6" x2="26" y2="6" className={`linea ${s.tone}`} />
                <Marker kind={s.marker} cx={14} cy={6} tone={s.tone} />
              </svg>
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div
        className="grafico-area"
        tabIndex={0}
        role="group"
        aria-label={`${title}: grafico. Frecce sinistra e destra per scorrere le date; i valori sono anche nella tabella`}
        onKeyDown={onKey}
        onFocus={() => setActive((a) => a ?? dates.length - 1)}
        onBlur={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="grafico-svg"
          aria-hidden="true"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="griglia" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="asse">
                {decimal(t)}
              </text>
            </g>
          ))}
          {xTicks.map((d, i) => (
            <text
              key={d}
              x={x(d)}
              y={H - 8}
              textAnchor={xTicks.length === 1 ? 'middle' : i === 0 ? 'start' : 'end'}
              className="asse"
            >
              {date(d)}
            </text>
          ))}
          {at && (
            <line x1={x(at)} x2={x(at)} y1={PAD.top} y2={H - PAD.bottom} className="cursore" />
          )}
          {series.map((s) => {
            const pts = s.points;
            const last = pts[pts.length - 1]!;
            return (
              <g key={s.name}>
                {pts.length > 1 && (
                  <polyline
                    points={pts.map((p) => `${x(p.data)},${y(p.valore)}`).join(' ')}
                    className={`linea ${s.tone}`}
                  />
                )}
                {pts.map((p, i) => (
                  <Marker
                    key={`${p.data}-${i}`}
                    kind={s.marker}
                    cx={x(p.data)}
                    cy={y(p.valore)}
                    tone={s.tone}
                    big={p.data === at}
                  />
                ))}
                <text x={x(last.data) + 10} y={y(last.valore) + 4} className="etichetta-fine">
                  {series.length > 1 ? `${s.name} ${decimal(last.valore)}` : decimal(last.valore)}
                </text>
              </g>
            );
          })}
        </svg>
        {at && readout && (
          <div className="grafico-suggerimento" style={tipStyle} role="status">
            <p className="grafico-suggerimento-data">{date(at)}</p>
            {readout.map(({ s, v }) => (
              <p key={s.name}>
                <svg width="16" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="15" y2="4" className={`linea ${s.tone}`} />
                </svg>{' '}
                <strong>
                  {v.join(' · ')} {unit}
                </strong>{' '}
                <span className="tenue">{s.name}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

function Marker({
  kind,
  cx,
  cy,
  tone,
  big = false,
}: {
  kind: 'cerchio' | 'quadrato';
  cx: number;
  cy: number;
  tone: string;
  big?: boolean;
}) {
  const r = big ? 6 : 4;
  return kind === 'cerchio' ? (
    <circle cx={cx} cy={cy} r={r} className={`punto ${tone}`} />
  ) : (
    <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} className={`punto ${tone}`} />
  );
}
