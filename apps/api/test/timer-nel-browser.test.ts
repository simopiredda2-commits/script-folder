import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unrefTimer } from '../src/timers';

const SRC = join(import.meta.dirname, '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

/**
 * Il servizio gira anche nel browser, nella dimostrazione (D221): lì `setTimeout` dà un numero e
 * `unref` non c'è. Chiamarlo lancerebbe un errore (D232).
 */
describe('timer del servizio anche nel browser (D232)', () => {
  it('unrefTimer: con un timer di Node lo stacca, con un numero non fa nulla', () => {
    const node = setTimeout(() => undefined, 1000);
    const spy = vi.spyOn(node, 'unref');
    expect(unrefTimer(node)).toBe(node);
    expect(spy).toHaveBeenCalledOnce();
    clearTimeout(node);
    expect(unrefTimer(42)).toBe(42);
  });

  it('nessun «.unref()» chiamato direttamente nel servizio: si passa da unrefTimer', () => {
    const direct = files(SRC)
      .filter((f) => !f.endsWith('timers.ts'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (/\.unref\(\)/.test(line) ? [`${relative(SRC, f)}:${i + 1}`] : [])),
      );
    expect(direct).toEqual([]);
  });
});
