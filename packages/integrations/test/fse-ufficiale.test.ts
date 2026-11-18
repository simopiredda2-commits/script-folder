import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Copie dei file ufficiali del Ministero (D131): identiche a quelle lette, senza aggiunte. */
const dir = join(import.meta.dirname, '..', 'fse-ufficiale');
const KEPT = ['schematron', 'dizionari', 'loinc'];

function readSums(): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`Riga di SHA256SUMS non valida: ${line}`);
    sums.set(m[2]!, m[1]!);
  }
  return sums;
}

function filesIn(sub: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(join(dir, sub));
  return out;
}

describe('file ufficiali del Fascicolo', () => {
  const sums = readSums();

  it('lo schematron del Profilo, sedici dizionari e l’estratto LOINC con la sua licenza', () => {
    const names = [...sums.keys()];
    expect(names).toContain('schematron/schematron_PSS_v4.0.sch');
    expect(names.filter((n) => n.startsWith('dizionari/'))).toHaveLength(16);
    expect(names).toContain('loinc/estratto.csv');
    expect(names).toContain('loinc/LOINC_short_license.txt');
  });

  it.each([...sums.entries()])('%s è identico alla copia letta', (file, expected) => {
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    expect(actual).toBe(expected);
  });

  it('non ci sono file estranei a SHA256SUMS', () => {
    const files = KEPT.flatMap(filesIn);
    expect(files.sort()).toEqual([...sums.keys()].sort());
  });
});
