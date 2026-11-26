import { ASL_LIST } from '@mmg/domain';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REGIONAL_PACKAGES,
  REGIONAL_PART_LABELS,
  REGIONAL_PARTS,
  selectRegionalPackage,
  type RegionalPackage,
} from '../src';
import { repoRoot } from './nomi-regionali';

/**
 * Scelta del pacchetto regionale (D292): dalla regione scritta nei dati dello studio, riconosciuta
 * con l'elenco delle aziende sanitarie del Ministero, e dall'ASL del medico.
 */
describe('scelta del pacchetto regionale (D292)', () => {
  const pkg = REGIONAL_PACKAGES[0]!;
  const regionName = ASL_LIST.find((a) => a.regionCode === pkg.regionCode)!.regionName;

  it('la regione dello studio con un pacchetto: il pacchetto, le parti che dà e quelle che mancano', () => {
    const s = selectRegionalPackage({ regionName: ` ${regionName.toLowerCase()} ` });
    expect(s.region).toEqual({ code: pkg.regionCode, name: regionName });
    expect(s.package?.key).toBe(pkg.key);
    expect(s.asl).toBeNull();
    expect(s.parts).toEqual([...pkg.parts]);
    expect(s.missing).toEqual(REGIONAL_PARTS.filter((p) => !pkg.parts.some((x) => x.part === p)));
  });

  it('una regione senza pacchetto: solo le parti nazionali, mancano tutte', () => {
    const other = ASL_LIST.find(
      (a) => !REGIONAL_PACKAGES.some((p) => p.regionCode === a.regionCode),
    )!;
    const s = selectRegionalPackage({ regionName: other.regionName, aslCode: other.code });
    expect(s.region?.code).toBe(other.regionCode);
    expect(s.package).toBeNull();
    expect(s.asl).toBeNull();
    expect(s.parts).toEqual([]);
    expect(s.missing).toEqual([...REGIONAL_PARTS]);
  });

  it('una regione non scritta o non riconosciuta: nessuna regione, nessun pacchetto', () => {
    for (const regionName of [null, undefined, '', 'Regione inventata']) {
      const s = selectRegionalPackage({ regionName });
      expect(s.region, String(regionName)).toBeNull();
      expect(s.package).toBeNull();
      expect(s.missing).toEqual([...REGIONAL_PARTS]);
    }
  });

  it('la variante dell’ASL del medico, se il pacchetto ne ha una per quell’azienda', () => {
    const withAsl: RegionalPackage = {
      ...pkg,
      asl: [
        {
          code: '999',
          parts: [{ part: 'reporting', where: 'package', what: 'Accordo aziendale di prova' }],
        },
      ],
    };
    const s = selectRegionalPackage({ regionName, aslCode: ' 999 ' }, [withAsl]);
    expect(s.asl?.code).toBe('999');
    expect(s.parts.map((p) => p.what)).toContain('Accordo aziendale di prova');
    expect(s.missing).not.toContain('reporting');
    const other = selectRegionalPackage({ regionName, aslCode: '998' }, [withAsl]);
    expect(other.asl).toBeNull();
    expect(other.missing).toContain('reporting');
  });

  it('i pacchetti dell’elenco: cartella, regione dell’elenco del Ministero, parti senza doppioni, parole senza stato', () => {
    expect(REGIONAL_PACKAGES.length).toBeGreaterThan(0);
    expect(new Set(REGIONAL_PACKAGES.map((p) => p.regionCode)).size).toBe(REGIONAL_PACKAGES.length);
    expect(new Set(REGIONAL_PACKAGES.map((p) => p.key)).size).toBe(REGIONAL_PACKAGES.length);
    for (const p of REGIONAL_PACKAGES) {
      expect(existsSync(join(repoRoot, 'packages', 'regions', p.key, 'index.ts')), p.key).toBe(
        true,
      );
      expect(/^[a-z][a-z-]*$/.test(p.key), p.key).toBe(true);
      expect(
        ASL_LIST.some((a) => a.regionCode === p.regionCode),
        p.key,
      ).toBe(true);
      expect(new Set(p.parts.map((x) => x.part)).size, p.key).toBe(p.parts.length);
      expect(p.terms.length, p.key).toBeGreaterThan(0);
      // Senza «g»: un'espressione con lo stato cambierebbe risposta fra una riga e l'altra.
      for (const t of p.terms) expect(t.global || t.sticky, `${p.key}: ${String(t)}`).toBe(false);
    }
    for (const part of REGIONAL_PARTS) expect(REGIONAL_PART_LABELS[part].length).toBeGreaterThan(5);
  });
});
