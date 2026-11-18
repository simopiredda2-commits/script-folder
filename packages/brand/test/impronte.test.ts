import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'assets', 'script');

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

describe('marchio di SCRIPT', () => {
  const sums = readSums();

  it('ha le 20 varianti ufficiali elencate in SHA256SUMS', () => {
    expect(sums.size).toBe(20);
  });

  it.each([...sums.entries()])('%s è identico al file ufficiale', (file, expected) => {
    const actual = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
    expect(actual).toBe(expected);
  });

  it('non contiene file estranei a SHA256SUMS', () => {
    const files = readdirSync(dir).filter((f) => f !== 'SHA256SUMS');
    expect(files.sort()).toEqual([...sums.keys()].sort());
  });
});
