import { describe, expect, it } from 'vitest';
import {
  ANAMNESIS_SECTIONS,
  CONTACT_TYPES,
  IMPORT_DESTINATION_KEYS,
  IMPORT_DESTINATIONS,
  MEASURE_KEYS,
  MOTOR_CAPACITY_KEYS,
  normalizeHeaderName,
  PATIENT_STATUS_KEYS,
  PROBLEM_CATEGORIES,
  RELATIVE_KEYS,
  REMINDER_CHANNEL_KEYS,
  suggestColumns,
  suggestDestination,
  importDestination,
} from '../src';

/** Catalogo delle destinazioni dell'importazione (tappa 15). */
describe('destinazioni dell’importazione', () => {
  it('una definizione per ogni destinazione, prima i pazienti, ordini diversi', () => {
    expect(IMPORT_DESTINATIONS.map((d) => d.key).sort()).toEqual(
      [...IMPORT_DESTINATION_KEYS].sort(),
    );
    const orders = IMPORT_DESTINATIONS.map((d) => d.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect([...IMPORT_DESTINATIONS].sort((a, b) => a.order - b.order)[0]!.key).toBe('pazienti');
  });

  it('ogni destinazione abbina il paziente per codice fiscale, obbligatorio', () => {
    for (const d of IMPORT_DESTINATIONS) {
      const cf = d.fields.find((f) => f.key === 'codiceFiscale');
      expect(cf, d.key).toMatchObject({ kind: 'fiscalCode', required: true });
    }
  });

  it('campi senza doppioni; chiave naturale fatta di campi della destinazione; sinonimi già normalizzati', () => {
    for (const d of IMPORT_DESTINATIONS) {
      const keys = d.fields.map((f) => f.key);
      expect(new Set(keys).size, d.key).toBe(keys.length);
      for (const k of d.naturalKey) expect(keys, `${d.key}.${k}`).toContain(k);
      for (const f of d.fields) {
        if (f.kind === 'choice') expect(f.choices?.length, `${d.key}.${f.key}`).toBeGreaterThan(0);
        for (const s of f.synonyms) expect(normalizeHeaderName(s), `${d.key}.${f.key}`).toBe(s);
      }
    }
  });

  it('i valori ammessi sono quelli dei moduli della cartella', () => {
    const choices = (dest: string, field: string) =>
      importDestination(dest)!
        .fields.find((f) => f.key === field)!
        .choices!.map((c) => c.key);
    expect(choices('diario', 'contatto')).toEqual([...CONTACT_TYPES]);
    expect(choices('anamnesi', 'sezione')).toEqual([...ANAMNESIS_SECTIONS]);
    expect(choices('anamnesi', 'parente')).toEqual([...RELATIVE_KEYS]);
    expect(choices('problemi', 'categoria')).toEqual([...PROBLEM_CATEGORIES]);
    expect(choices('parametri', 'parametro')).toEqual([...MEASURE_KEYS]);
    expect(choices('capacita_motoria', 'capacita')).toEqual([...MOTOR_CAPACITY_KEYS]);
    expect(choices('pazienti', 'stato')).toEqual([...PATIENT_STATUS_KEYS]);
    expect(choices('pazienti', 'canalePromemoria')).toEqual([...REMINDER_CHANNEL_KEYS]);
    expect(choices('pazienti', 'sesso')).toEqual(['M', 'F']);
  });

  it('suggerimenti: il nome uguale vale più del nome che contiene; una colonna per campo', () => {
    const d = importDestination('pazienti')!;
    const s = suggestColumns(d, [
      'Codice Fiscale',
      'Cognome',
      'Nome',
      'Data di nascita',
      'Nome del medico',
    ]);
    expect(s).toMatchObject({ codiceFiscale: 0, cognome: 1, nome: 2, nascita: 3 });
    expect(Object.values(s).filter((c) => c === 4)).toHaveLength(0);
  });

  it('destinazione suggerita da almeno due campi obbligatori riconosciuti; altrimenti nessuna', () => {
    expect(suggestDestination(['CF', 'Cognome', 'Nome', 'Sesso', 'Data di nascita'])?.key).toBe(
      'pazienti',
    );
    expect(suggestDestination(['Codice fiscale', 'Data', 'Tipo contatto', 'Nota'])?.key).toBe(
      'diario',
    );
    expect(suggestDestination(['Colonna senza nome', 'Altro'])).toBeNull();
  });
});
