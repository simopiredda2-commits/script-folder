import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPermissionsMatrix } from '../src/permissions-matrix';

describe('documentazione dei permessi', () => {
  it('la matrice in docs/ruoli-permessi.md è quella calcolata dal codice', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'ruoli-permessi.md'),
      'utf8',
    );
    const start = '<!-- matrice:inizio -->';
    const inside = doc.slice(
      doc.indexOf(start) + start.length,
      doc.indexOf('<!-- matrice:fine -->'),
    );
    expect(inside.trim()).toBe(renderPermissionsMatrix());
  });
});
