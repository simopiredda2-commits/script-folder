import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownActivity, siapValues } from '../src/siap/values';

/**
 * I valori ammessi del SIAP (D284), trascritti dalle specifiche funzionali del Ministero,
 * versione 1.3: allegati 1 e 2 e domini dei campi. La prova controlla la forma e alcuni valori
 * letti sulle pagine 59–61; il controllo voce per voce resta da fare (controllato_da vuoto).
 */
describe('valori ammessi del SIAP (D284)', () => {
  const v = siapValues();

  it('le tipologie dell’allegato 1, con i dettagli dell’allegato 2', () => {
    expect(v.versione).toBe('1.3');
    expect(v.tipologie.map((t) => t.codice)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 99,
    ]);
    expect(v.tipologie.reduce((n, t) => n + t.dettagli.length, 0)).toBe(94);
    const of = (code: number) => v.tipologie.find((t) => t.codice === code)!;
    expect(of(5).dettagli).toHaveLength(47);
    expect(of(5).dettagli.at(-1)).toEqual({ codice: 47, descrizione: 'Altro' });
    expect(of(6).dettagli.map((d) => d.codice)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
    expect(of(8).dettagli.map((d) => d.descrizione)).toEqual([
      'Rinnovo farmaci continuativi',
      'Nuovi farmaci',
      'Altro',
    ]);
    // Il nome del codice 13 non è lo stesso nell'allegato 1: resta scritto, con la nota.
    expect(of(13)).toMatchObject({
      descrizione: 'Attività amministrativa',
      descrizioneAllegato1: 'ATTIVITÀ DI INIZIATIVA',
    });
    expect(knownActivity(v, 9, 6)).toBe(true);
    expect(knownActivity(v, 9, 7)).toBe(false);
    expect(knownActivity(v, 14, 1)).toBe(false);
  });

  it('i domini dei campi, con la chiave del programma', () => {
    const codes = (d: { chiave: string; codice: number }[]) =>
      Object.fromEntries(d.map((x) => [x.chiave, x.codice]));
    expect(codes(v.modalitaContatto)).toEqual({
      office: 1,
      home: 2,
      telemedicine: 3,
      remote: 4,
      unknown: 9,
    });
    expect(codes(v.statoProblema)).toEqual({ suspected: 1, evolving: 2, chronic: 3, unknown: 9 });
    expect(codes(v.tipologiaAccesso)).toEqual({ scheduled: 1, direct: 2, unknown: 9 });
    expect(codes(v.regimeAttivita)).toEqual({ choice: 1, hourly: 2, unknown: 9 });
    // Il «non noto» del fumo è 9 nella definizione del campo (lo schema XSD dice 3): domanda 12.
    expect(codes(v.fumo)).toEqual({ yes: 1, no: 2, unknown: 9 });
    expect(v.tipoStruttura.map((x) => x.codice)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('la fonte è quella registrata, con la stessa impronta', () => {
    const provenances = readFileSync(
      join(import.meta.dirname, '../../../docs/provenienze.md'),
      'utf8',
    );
    const row = provenances
      .split('\n')
      .find((l) => l.includes('Specifiche_funzionali_SIAP_v1.3_042026.pdf'));
    expect(row).toBeDefined();
    expect(row).toContain(v.sha256_origine);
    // Da controllare voce per voce, come le altre trascrizioni.
    expect(v.controllato_da).toBeNull();
  });
});
