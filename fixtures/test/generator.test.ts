import { checkFiscalCode } from '@mmg/domain';
import { describe, expect, it } from 'vitest';
import { FICTITIOUS_PLACE_LETTER, generatePatients } from '../src/generator';

describe('pazienti inventati', () => {
  const a = generatePatients({ seed: 'prova', count: 200 });

  it('stesso seme, stessi pazienti', () => {
    expect(generatePatients({ seed: 'prova', count: 200 })).toEqual(a);
  });

  it('seme diverso, pazienti diversi', () => {
    expect(generatePatients({ seed: 'altro', count: 200 })).not.toEqual(a);
  });

  it('i primi pazienti non cambiano se se ne chiedono di più', () => {
    expect(generatePatients({ seed: 'prova', count: 50 })).toEqual(a.slice(0, 50));
  });

  it('ogni codice fiscale passa il controllo formale', () => {
    for (const p of a) expect(checkFiscalCode(p.fiscalCode), p.fiscalCode).toEqual({ valid: true });
  });

  it('nessun codice fiscale può essere di una persona reale: luogo di nascita con la X', () => {
    for (const p of a) {
      expect(p.fiscalCode[11]).toBe(FICTITIOUS_PLACE_LETTER);
      expect(p.birthPlace.code[0]).toBe(FICTITIOUS_PLACE_LETTER);
    }
  });

  it('recapiti che non raggiungono nessuno', () => {
    for (const p of a) {
      expect(p.email).toMatch(/@example\.org$/);
      expect(p.phone).toMatch(/^\+39 000 \d{7}$/);
    }
  });

  it('identificativi unici e date di nascita valide', () => {
    expect(new Set(a.map((p) => p.id)).size).toBe(a.length);
    for (const p of a) {
      expect(new Date(`${p.birthDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(p.birthDate);
    }
  });

  it('copre tutti gli stati del paziente', () => {
    const states = new Set(generatePatients({ seed: 'stati', count: 500 }).map((p) => p.status));
    expect([...states].sort()).toEqual(['active', 'deceased', 'revoked', 'temporary']);
  });
});
