import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRulesTable } from '../src/docs';

describe('documentazione delle regole', () => {
  it('la tabella in docs/regole.md è quella generata dai dati', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'regole.md'),
      'utf8',
    );
    const start = '<!-- regole:inizio -->';
    const inside = doc.slice(
      doc.indexOf(start) + start.length,
      doc.indexOf('<!-- regole:fine -->'),
    );
    expect(inside.trim()).toBe(renderRulesTable());
  });
});
