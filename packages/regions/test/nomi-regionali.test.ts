import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGIONAL_PACKAGES, type RegionalPackage } from '../src';
import {
  compareInventory,
  countRegionalLines,
  EXCEPTIONS,
  isException,
  matchingLines,
  readInventory,
  repoRoot,
  zoneOf,
} from './nomi-regionali';

/**
 * Nomi regionali fuori dai pacchetti (D292). Le prove non scrivono il nome di nessuna regione: le
 * parole vengono dai pacchetti dell'elenco.
 */
describe('nomi regionali fuori dai pacchetti (D292)', () => {
  it('fuori dalle cartelle del pacchetto le parole della regione stanno solo dove dice l’inventario, con le stesse righe', () => {
    const { grown, shrunk } = compareInventory(countRegionalLines(), readInventory());
    expect(
      grown,
      `Righe regionali nuove fuori dal pacchetto: vanno nelle sue cartelle (regions/<chiave>/)\n${grown.join('\n')}`,
    ).toEqual([]);
    expect(
      shrunk,
      `Righe regionali in meno: aggiornare l’inventario con «pnpm --filter @mmg/regions inventario»\n${shrunk.join('\n')}`,
    ).toEqual([]);
  });

  it('le cartelle di un pacchetto sono «regions/<chiave>/» in ogni livello del programma', () => {
    const keys = REGIONAL_PACKAGES.map((p) => p.key);
    const k = keys[0]!;
    expect(zoneOf(`packages/regions/${k}/index.ts`, keys)).toBe(k);
    expect(zoneOf(`apps/api/src/regions/${k}/service.ts`, keys)).toBe(k);
    expect(zoneOf(`apps/web/test/regions/${k}/pagina.test.tsx`, keys)).toBe(k);
    expect(zoneOf('packages/regions/src/index.ts', keys)).toBeNull();
    expect(zoneOf('apps/api/src/prescriptions/service.ts', keys)).toBeNull();
    expect(zoneOf('apps/api/src/regions/nessuna/service.ts', keys)).toBeNull();
  });

  it('la ricerca trova le parole: nel manifesto guardato da fuori, in un testo e in un percorso', () => {
    for (const pkg of REGIONAL_PACKAGES) {
      const text = readFileSync(join(repoRoot, 'packages', 'regions', pkg.key, 'index.ts'), 'utf8');
      expect(matchingLines(pkg, 'fuori/index.ts', text).length, pkg.key).toBeGreaterThan(5);
    }
    const fake: RegionalPackage = {
      ...REGIONAL_PACKAGES[0]!,
      key: 'prova',
      terms: [/\bRegione di prova\b/, /\benteProva(?=[A-Z])/],
    };
    expect(
      matchingLines(
        fake,
        'a/b.ts',
        'riga\nla Regione di prova\nconst enteProvaService = 1\nniente',
      ),
    ).toEqual([2, 3]);
    // Il percorso conta come riga 0.
    expect(matchingLines(fake, 'a/enteProvaX/b.ts', 'niente')).toEqual([0]);
  });

  it('le parole dei pacchetti non trovano le parole comuni del programma', () => {
    const common = [
      'sarà',
      'necessario',
      'Paura delle folle',
      'SARS-CoV-2',
      'censimento',
      'misura',
      'Sardegna',
      'Laura',
    ];
    for (const pkg of REGIONAL_PACKAGES)
      for (const w of common) expect(matchingLines(pkg, 'x.ts', w), `${pkg.key}: ${w}`).toEqual([]);
  });

  it('le eccezioni esistono e hanno un motivo; le migrazioni sono storia', () => {
    for (const [path, reason] of Object.entries(EXCEPTIONS)) {
      expect(existsSync(join(repoRoot, path)), path).toBe(true);
      expect(reason.length, path).toBeGreaterThan(30);
    }
    expect(isException('apps/api/migrations/0001_prova.sql')).toBe(true);
    expect(isException('apps/api/src/app.ts')).toBe(false);
  });
});
