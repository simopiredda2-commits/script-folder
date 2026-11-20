import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import { OCR_A_FILE } from '../src/reminders/pdf';

describe('carattere OCR-A del promemoria (D211)', () => {
  it('il file è quello del pacchetto Debian, con l’impronta scritta in SHA256SUMS', () => {
    const lines = readFileSync(join(dirname(OCR_A_FILE), 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const [sum, name] = lines[0]!.split(/\s+/);
    expect(name).toBe('OCRA.ttf');
    expect(createHash('sha256').update(readFileSync(OCR_A_FILE)).digest('hex')).toBe(sum);
  });

  it('ha tutti i caratteri dell’NRE e del codice fiscale', () => {
    const font = fontkit.create(readFileSync(OCR_A_FILE));
    expect(font.postscriptName).toBe('OCRA');
    const needed = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ :';
    expect([...needed].filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0)!))).toEqual([]);
  });
});
