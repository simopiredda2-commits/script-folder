import { describe, expect, it } from 'vitest';
import {
  normalizeServiceCode,
  packageServicesOf,
  parseStudioListData,
  STUDIO_LIST_KIND_KEYS,
  STUDIO_LIST_LIMITS,
  studioListDuplicate,
  studioListKey,
  studioListLabel,
} from '../src/studio-lists';

/** Problemi trovati, oppure i dati controllati. Medici, strutture e recapiti inventati. */
const problems = (kind: Parameters<typeof parseStudioListData>[0], raw: unknown) => {
  const r = parseStudioListData(kind, raw);
  return r.ok ? [] : r.problems;
};
const data = <K extends Parameters<typeof parseStudioListData>[0]>(kind: K, raw: unknown) => {
  const r = parseStudioListData(kind, raw);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.data;
};

describe('elenchi dello studio: i campi di ogni tipo (tappa 14)', () => {
  it('quattro tipi, con il nome in italiano', () => {
    expect(STUDIO_LIST_KIND_KEYS).toEqual(['suggeritore', 'posologia', 'pacchetto', 'contatto']);
  });

  it('medico suggeritore: il nome è obbligatorio, il resto facoltativo e senza spazi ai bordi', () => {
    expect(
      data('suggeritore', {
        nome: '  Dott.ssa Anna Prova ',
        struttura: 'Ospedale di prova',
        specialita: '',
      }),
    ).toEqual({
      nome: 'Dott.ssa Anna Prova',
      struttura: 'Ospedale di prova',
      specialita: null,
      telefono: null,
    });
    expect(problems('suggeritore', { struttura: 'Ospedale di prova' })).toEqual([
      'Nome del medico: campo obbligatorio',
    ]);
    expect(problems('suggeritore', { nome: '   ' })).toEqual([
      'Nome del medico: campo obbligatorio',
    ]);
    expect(problems('suggeritore', { nome: 12 })).toEqual([
      'Nome del medico: deve essere un testo',
    ]);
    expect(problems('suggeritore', { nome: 'x'.repeat(STUDIO_LIST_LIMITS.name + 1) })).toEqual([
      `Nome del medico: al massimo ${STUDIO_LIST_LIMITS.name} caratteri`,
    ]);
  });

  it('nessun campo in più: un campo sconosciuto si dice, non si salva', () => {
    expect(problems('suggeritore', { nome: 'Dott. Prova', reparto: 'Cardiologia' })).toEqual([
      'Campi non previsti: reparto',
    ]);
    expect(problems('posologia', 'una compressa')).toEqual([
      'I dati della voce vanno scritti campo per campo',
    ]);
  });

  it('posologia: il testo è obbligatorio, le parti della scheda facoltative', () => {
    expect(data('posologia', { testo: '1 compressa la sera' })).toEqual({
      testo: '1 compressa la sera',
      dose: null,
      unita: null,
      frequenza: null,
      momento: null,
      via: null,
    });
    expect(
      data('posologia', {
        testo: '1 compressa una volta al giorno, la sera, per bocca',
        dose: '1',
        unita: 'compressa',
        frequenza: '1 volta al giorno',
        momento: 'la sera',
        via: 'per bocca',
      }).frequenza,
    ).toBe('1 volta al giorno');
    expect(problems('posologia', { dose: '1' })).toEqual([
      'Testo della posologia: campo obbligatorio',
    ]);
    expect(
      problems('posologia', { testo: 'x', dose: '1'.repeat(STUDIO_LIST_LIMITS.dose + 1) }),
    ).toEqual([`Dose: al massimo ${STUDIO_LIST_LIMITS.dose} caratteri`]);
  });

  it('pacchetto: almeno una prestazione, codici del catalogo in maiuscolo, nessun doppione', () => {
    expect(
      data('pacchetto', {
        nome: 'Controllo di prova',
        prestazioni: [{ codice: ' prova.02 ', descrizione: 'Esame di prova' }],
      }).prestazioni,
    ).toEqual([{ codice: 'PROVA.02', descrizione: 'Esame di prova' }]);
    expect(problems('pacchetto', { nome: 'Controllo di prova', prestazioni: [] })).toEqual([
      'Un pacchetto ha almeno una prestazione',
    ]);
    expect(problems('pacchetto', { nome: 'Controllo di prova' })).toEqual([
      'Prestazioni: serve l’elenco delle prestazioni',
    ]);
    expect(
      problems('pacchetto', {
        nome: 'Controllo di prova',
        prestazioni: [
          { codice: '89.7', descrizione: 'Visita di prova' },
          { codice: '89.7 ', descrizione: 'Visita di prova' },
        ],
      }),
    ).toEqual(['La prestazione 89.7 è due volte nel pacchetto']);
    expect(
      problems('pacchetto', {
        nome: 'Controllo di prova',
        prestazioni: [{ codice: '89 7', descrizione: 'Visita di prova' }],
      }),
    ).toEqual([
      'Codice della prestazione: lettere e cifre separate da punti, come nel catalogo regionale',
    ]);
    const many = Array.from({ length: STUDIO_LIST_LIMITS.packageServices + 1 }, (_, i) => ({
      codice: `PROVA.${i}`,
      descrizione: 'Esame di prova',
    }));
    expect(problems('pacchetto', { nome: 'Troppe', prestazioni: many })).toEqual([
      `Un pacchetto ha al massimo ${STUDIO_LIST_LIMITS.packageServices} prestazioni`,
    ]);
  });

  it('contatto: nome e tipo obbligatori, email controllata', () => {
    expect(
      data('contatto', {
        nome: 'Laboratorio di prova',
        tipo: 'laboratorio',
        email: ' laboratorio@esempio.invalid ',
      }),
    ).toEqual({
      nome: 'Laboratorio di prova',
      tipo: 'laboratorio',
      telefono: null,
      email: 'laboratorio@esempio.invalid',
      indirizzo: null,
      note: null,
    });
    expect(problems('contatto', { nome: 'Laboratorio di prova', tipo: 'farmacia' })).toEqual([
      'Tipo di contatto: struttura, specialista, laboratorio o altro',
    ]);
    expect(
      problems('contatto', { nome: 'Laboratorio di prova', tipo: 'altro', email: 'non-una-email' }),
    ).toEqual(['Email: indirizzo non valido']);
    expect(problems('contatto', {})).toEqual([
      'Nome: campo obbligatorio',
      'Tipo di contatto: struttura, specialista, laboratorio o altro',
    ]);
  });

  it('il nome della voce e che cosa la rende la stessa voce', () => {
    expect(studioListLabel('posologia', { testo: ' 1 compressa la sera ' })).toBe(
      '1 compressa la sera',
    );
    expect(studioListLabel('suggeritore', { nome: 'Dott. Prova' })).toBe('Dott. Prova');
    // Maiuscole e spazi non contano; la struttura sì: gli omonimi restano distinti.
    expect(studioListKey('suggeritore', { nome: 'Dott.  PROVA', struttura: 'Ospedale A' })).toBe(
      studioListKey('suggeritore', { nome: 'dott. prova', struttura: 'ospedale a' }),
    );
    expect(studioListKey('suggeritore', { nome: 'Dott. Prova', struttura: 'Ospedale A' })).not.toBe(
      studioListKey('suggeritore', { nome: 'Dott. Prova', struttura: 'Ospedale B' }),
    );
    expect(studioListKey('contatto', { nome: 'ASL di prova', tipo: 'struttura' })).not.toBe(
      studioListKey('contatto', { nome: 'ASL di prova', tipo: 'altro' }),
    );
    // Dati salvati male non fanno cadere nulla: nome vuoto.
    expect(studioListLabel('pacchetto', {})).toBe('');
    expect(studioListDuplicate('posologia', '1 compressa la sera')).toBe(
      'Nell’elenco c’è già la posologia «1 compressa la sera»',
    );
  });

  it('le prestazioni di un pacchetto salvato si leggono con prudenza', () => {
    expect(normalizeServiceCode(' 45.30.1a ')).toBe('45.30.1A');
    expect(
      packageServicesOf({
        prestazioni: [{ codice: ' 89.7', descrizione: 'Visita di prova' }, { codice: '' }, null, 3],
      }),
    ).toEqual([{ codice: '89.7', descrizione: 'Visita di prova' }]);
    expect(packageServicesOf({})).toEqual([]);
  });
});
