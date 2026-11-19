import { WorkstationsPanel } from './WorkstationsPanel';

/** Postazioni dello studio e preferenze di stampa per tipo di documento (tappa 14). */
export function PrintSection() {
  return (
    <>
      <WorkstationsPanel />
      <section className="riquadro" aria-labelledby="titolo-stampa">
        <h2 id="titolo-stampa">Preferenze di stampa</h2>
        <p className="tenue">In costruzione.</p>
      </section>
    </>
  );
}
