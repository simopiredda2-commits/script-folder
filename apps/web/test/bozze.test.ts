// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Le bozze ricordate nel browser (D68, D129) stanno ognuna sotto la sua chiave. Due pagine con la
 * stessa chiave leggerebbero l'una la bozza dell'altra: è successo fra il certificato INPS e gli
 * altri certificati (tappa 13). Si controllano le chiavi scritte con un prefisso fisso; quelle
 * composte altrove (variabili) restano fuori dal controllo.
 */
const SRC = join(import.meta.dirname, '..', 'src');

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

/** Prefisso fisso della chiave di ogni `usePersistentState`, per file. */
export function draftPrefixes(sources: { file: string; text: string }[]) {
  const out: { file: string; prefix: string }[] = [];
  for (const { file, text } of sources)
    for (const m of text.matchAll(/usePersistentState\b[^(]*\(\s*`([a-z0-9-]+)\$\{/g))
      out.push({ file, prefix: m[1]! });
  return out;
}

/** Coppie di file diversi in cui un prefisso è l'inizio dell'altro (o lo stesso). */
export function collisions(list: { file: string; prefix: string }[]) {
  const out: string[] = [];
  for (const a of list)
    for (const b of list)
      if (a.file < b.file && (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)))
        out.push(`${a.file} «${a.prefix}» – ${b.file} «${b.prefix}»`);
  return out;
}

describe('chiavi delle bozze ricordate nel browser', () => {
  it('ogni pagina ha le sue: nessuna è l’inizio di quella di un’altra pagina', () => {
    const sources = files(SRC).map((f) => ({
      file: relative(SRC, f),
      text: readFileSync(f, 'utf8'),
    }));
    const list = draftPrefixes(sources);
    expect(list.length).toBeGreaterThan(5);
    expect(collisions(list)).toEqual([]);
  });

  it('il controllo funziona: due pagine con lo stesso prefisso sono segnalate', () => {
    const list = draftPrefixes([
      { file: 'a.tsx', text: 'usePersistentState<A>(`bozza-certificato-${id}`, null)' },
      { file: 'b.tsx', text: 'usePersistentState<B>(\n  `bozza-certificato-modello-${id}`,\n {})' },
    ]);
    expect(collisions(list)).toEqual([
      'a.tsx «bozza-certificato-» – b.tsx «bozza-certificato-modello-»',
    ]);
  });
});
