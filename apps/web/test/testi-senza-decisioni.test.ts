// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * I testi che vedono medico e segreteria non citano le decisioni del progetto («(D212)»): sono
 * per chi sviluppa, non per chi lavora (D239). Si guardano le stringhe dell'interfaccia e del
 * servizio, che arrivano nella pagina come messaggi; i commenti no.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIRS = ['apps/web/src', 'apps/api/src'];

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listFiles(join(dir, e.name))
      : /\.(ts|tsx)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

/** Il codice senza commenti: blocchi, JSX e righe. Una «//» dentro un indirizzo taglia e basta. */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export const decisionCodes = (text: string) =>
  withoutComments(text)
    .split('\n')
    .filter((line) => /\(D\d{2,3}[),.;\s]/.test(line));

describe('testi senza i codici delle decisioni', () => {
  it('nessun «(Dnnn)» nelle stringhe dell’interfaccia e del servizio', () => {
    const found = DIRS.flatMap((d) => listFiles(join(ROOT, d))).flatMap((f) =>
      decisionCodes(readFileSync(f, 'utf8')).map((l) => `${relative(ROOT, f)}: ${l.trim()}`),
    );
    expect(found, found.join('\n')).toEqual([]);
  });

  it('la ricerca li trova davvero, e lascia stare i commenti', () => {
    expect(decisionCodes("const a = 'come si manda (D212).';")).toHaveLength(1);
    expect(decisionCodes('<p>Testo (D88)</p>')).toHaveLength(1);
    expect(decisionCodes('// nota (D212)\n/* blocco (D88) */\n{/* jsx (D1) */}')).toEqual([]);
  });
});
