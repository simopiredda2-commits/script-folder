import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGIONAL_PACKAGES, REGIONS_DIR, regionalDataDirs, type RegionalPackage } from '../src';

/**
 * I dati dei pacchetti regionali (D292, D295): `packages/regions/<chiave>/data/<tipo>`. Il nucleo
 * li trova dall'elenco dei pacchetti, senza nominare le regioni; un pacchetto senza quel tipo di
 * dati non dà cartelle. La prova non scrive il nome di nessuna regione.
 */
describe('dati dei pacchetti regionali (D295)', () => {
  const pkg = REGIONAL_PACKAGES[0]!;

  it('le cartelle che ci sono, una per pacchetto, nell’ordine dell’elenco', () => {
    for (const kind of ['trascrizioni', 'rao', 'siap'] as const) {
      const dirs = regionalDataDirs(kind);
      expect(dirs, kind).toEqual(
        REGIONAL_PACKAGES.map((p) => join(REGIONS_DIR, p.key, 'data', kind)).filter((d) =>
          existsSync(d),
        ),
      );
      // Il primo pacchetto ha già i suoi dati di ogni tipo, con almeno un file.
      expect(dirs[0], kind).toBe(join(REGIONS_DIR, pkg.key, 'data', kind));
      expect(readdirSync(dirs[0]!).length, kind).toBeGreaterThan(0);
    }
  });

  it('un pacchetto senza dati non dà cartelle; l’ordine è quello dell’elenco', () => {
    const empty: RegionalPackage = { ...pkg, key: 'pacchetto-senza-dati' };
    expect(regionalDataDirs('rao', [empty])).toEqual([]);
    expect(regionalDataDirs('rao', [empty, pkg])).toEqual([
      join(REGIONS_DIR, pkg.key, 'data', 'rao'),
    ]);
  });
});
