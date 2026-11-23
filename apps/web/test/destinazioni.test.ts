import { describe, expect, it } from 'vitest';
import { pastWhat } from '../src/components/PastPrescriptions';
import { countsText, pastCountsText, type PastPrescription } from '../src/components/Prescribed';
import { labRange } from '../src/pages/ClinicalEntriesPage';
import { reportBody } from '../src/pages/ExamsPage';

/** Conti di una voce dei prescritti, senza ricette di nessun tipo. */
const none = {
  ricette: 0,
  prescritte: 0,
  inPreparazione: 0,
  annullate: 0,
  ultimaIl: null,
  ultimoStato: null,
  ultimi12Mesi: 0,
};

describe('destinazioni della tappa 15 nell’interfaccia', () => {
  it('i conti dei prescritti dicono le ricette fatte con un altro programma, a parte', () => {
    expect(countsText(none)).toBe('nessuna ricetta');
    expect(pastCountsText(none)).toBe('');
    const onlyPast = { ...none, altroProgramma: { ricette: 2, ultimaIl: '2025-01-15' } };
    expect(countsText(onlyPast)).toBe(
      '2 ricette fatte con un altro programma, l’ultima il 15/01/2025',
    );
    const both = {
      ...none,
      ricette: 1,
      prescritte: 1,
      ultimaIl: '2026-11-10T09:00:00.000Z',
      altroProgramma: { ricette: 1, ultimaIl: '2025-03-10' },
    };
    expect(countsText(both)).toBe(
      '1 ricetta inviata o su carta, ultima il 10/11/2026 · 1 ricetta fatta con un altro programma, il 10/03/2025',
    );
    // Le annullate non si contano: il servizio manda zero, e non si dice nulla.
    expect(countsText({ ...both, altroProgramma: { ricette: 0, ultimaIl: null } })).toBe(
      '1 ricetta inviata o su carta, ultima il 10/11/2026',
    );
  });

  it('che cosa dice una ricetta passata: nome, principio o AIC, con la quantità', () => {
    const base: PastPrescription = {
      id: 'x',
      tipo: 'farmaco',
      data: '2025-03-10',
      aic: '900000045',
      farmaco: null,
      principioAttivo: null,
      atc: null,
      codice: null,
      descrizione: null,
      quantita: null,
      posologia: null,
      nre: null,
      prescrittore: null,
      note: null,
      programma: null,
      importata: false,
      registrataDa: null,
      registrataIl: '2026-11-18T10:00:00.000Z',
      stato: 'attiva',
      annullataIl: null,
      motivoAnnullamento: null,
    };
    expect(pastWhat(base)).toBe('AIC 900000045');
    expect(pastWhat({ ...base, principioAttivo: 'principio di prova', quantita: 2 })).toBe(
      'principio di prova × 2',
    );
    expect(pastWhat({ ...base, farmaco: 'Farmaco di prova' })).toBe('Farmaco di prova');
    expect(
      pastWhat({ ...base, tipo: 'prestazione', aic: null, codice: 'PR.09', descrizione: null }),
    ).toBe('PR.09');
  });

  it('l’intervallo del laboratorio: il testo, oppure minimo e massimo', () => {
    expect(labRange({})).toBe('');
    expect(labRange({ minimo: '70', massimo: '99', unita: 'mg/dL' })).toBe('70–99 mg/dL');
    expect(labRange({ minimo: '70', unita: 'mg/dL' })).toBe('minimo 70 mg/dL');
    expect(labRange({ massimo: '200' })).toBe('massimo 200');
    expect(labRange({ intervallo: 'negativo', minimo: '1', massimo: '2' })).toBe('negativo');
  });

  it('il referto per il servizio: righe vuote fuori, spazi tolti, vuoti come non scritti', () => {
    const row = {
      key: 'a',
      esame: ' Glucosio di prova ',
      valore: '98',
      unita: 'mg/dL',
      minimo: '',
      massimo: ' ',
      intervallo: '70–99',
      codicePrestazione: '',
    };
    const empty = { ...row, key: 'b', esame: '', valore: '', unita: 'mg/dL', intervallo: '' };
    expect(
      reportBody({ data: '2026-11-18', note: ' ', riservata: false, righe: [row, empty] }),
    ).toEqual({
      data: '2026-11-18',
      note: undefined,
      riservata: undefined,
      risultati: [
        {
          esame: 'Glucosio di prova',
          valore: '98',
          unita: 'mg/dL',
          minimo: undefined,
          massimo: undefined,
          intervallo: '70–99',
          codicePrestazione: undefined,
        },
      ],
    });
  });
});
