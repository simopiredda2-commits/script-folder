import { describe, expect, it } from 'vitest';
import {
  accessTypeOf,
  makesContact,
  modeOf,
  problemStateOf,
  proposeContact,
  servicesOf,
  servicesOfAct,
  SIAP_GENERIC_PROBLEM,
  SIAP_MAX_QUANTITY,
  type SiapAct,
} from '../src';

/**
 * Il contatto del SIAP ricavato dagli atti (D291). Tipologie e dettagli sono quelli dell'allegato 2
 * delle specifiche funzionali del Ministero (versione 1.3): qui scritti come numeri, perché la prova
 * controlla proprio i codici che vanno nel tracciato.
 */
describe('contatto del SIAP dagli atti del medico (D291)', () => {
  const diary = (contactType: 'office' | 'home' | 'phone' | 'televisit', id = 'd'): SiapAct => ({
    kind: 'diary',
    id,
    contactType,
  });

  it('ogni atto con la sua tipologia e il suo dettaglio dell’allegato 2', () => {
    const cases: [SiapAct, [number, number][]][] = [
      [diary('office'), [[1, 2]]],
      [diary('home'), [[1, 2]]],
      [diary('televisit'), [[1, 2]]],
      [diary('phone'), [[1, 4]]],
      [{ kind: 'pharma', id: 'r', continuing: true, newDrugs: false }, [[8, 1]]],
      [{ kind: 'pharma', id: 'r', continuing: false, newDrugs: true }, [[8, 2]]],
      [
        { kind: 'pharma', id: 'r', continuing: true, newDrugs: true },
        [
          [8, 1],
          [8, 2],
        ],
      ],
      // Una ricetta senza righe riconosciute vale come nuovi farmaci, non si perde.
      [{ kind: 'pharma', id: 'r', continuing: false, newDrugs: false }, [[8, 2]]],
      [{ kind: 'specialist', id: 's', visits: true, others: false }, [[9, 1]]],
      [{ kind: 'specialist', id: 's', visits: false, others: true }, [[9, 2]]],
      [
        { kind: 'specialist', id: 's', visits: true, others: true },
        [
          [9, 1],
          [9, 2],
        ],
      ],
      [{ kind: 'specialist', id: 's', visits: false, others: false }, [[9, 2]]],
      [{ kind: 'devices', id: 'p' }, [[9, 9]]],
      [{ kind: 'sick_leave', id: 'c' }, [[6, 1]]],
      [{ kind: 'certificate', id: 'm', sport: true }, [[6, 3]]],
      [{ kind: 'certificate', id: 'm', sport: false }, [[6, 7]]],
      [{ kind: 'vaccination', id: 'v', seasonal: true, ageYears: 70 }, [[7, 1]]],
      [{ kind: 'vaccination', id: 'v', seasonal: true, ageYears: 5 }, [[7, 1]]],
      [{ kind: 'vaccination', id: 'v', seasonal: false, ageYears: 0 }, [[7, 2]]],
      [{ kind: 'vaccination', id: 'v', seasonal: false, ageYears: 11 }, [[7, 2]]],
      [{ kind: 'vaccination', id: 'v', seasonal: false, ageYears: 12 }, [[7, 3]]],
      [{ kind: 'vaccination', id: 'v', seasonal: false, ageYears: 17 }, [[7, 3]]],
      [{ kind: 'vaccination', id: 'v', seasonal: false, ageYears: 18 }, [[7, 4]]],
      [{ kind: 'ppip', id: 'p', detail: 39, quantity: 1 }, [[5, 39]]],
      [{ kind: 'choice', id: 'x' }, [[0, 1]]],
    ];
    for (const [act, pairs] of cases)
      expect(
        servicesOfAct(act).map((p) => [p.tipologia, p.dettaglio]),
        JSON.stringify(act),
      ).toEqual(pairs);
  });

  it('una riga per tipologia e dettaglio, con quanti atti la hanno, in ordine; al più 9', () => {
    const acts: SiapAct[] = [
      { kind: 'specialist', id: 's1', visits: false, others: true },
      diary('office', 'd1'),
      { kind: 'pharma', id: 'r1', continuing: true, newDrugs: false },
      { kind: 'pharma', id: 'r2', continuing: true, newDrugs: true },
      { kind: 'choice', id: 'x' },
    ];
    expect(servicesOf(acts)).toEqual([
      { tipologia: 0, dettaglio: 1, quantita: 1 },
      { tipologia: 1, dettaglio: 2, quantita: 1 },
      { tipologia: 8, dettaglio: 1, quantita: 2 },
      { tipologia: 8, dettaglio: 2, quantita: 1 },
      { tipologia: 9, dettaglio: 2, quantita: 1 },
    ]);
    const many = Array.from({ length: 12 }, (_, i): SiapAct => ({
      kind: 'sick_leave',
      id: `c${i}`,
    }));
    expect(SIAP_MAX_QUANTITY).toBe(9);
    expect(servicesOf(many)).toEqual([{ tipologia: 6, dettaglio: 1, quantita: 9 }]);
    // Le prestazioni aggiuntive contano per quante ne sono registrate, sempre al più 9.
    const ppip = (id: string, quantity: number): SiapAct => ({
      kind: 'ppip',
      id,
      detail: 7,
      quantity,
    });
    expect(servicesOf([ppip('p1', 3), ppip('p2', 2)])).toEqual([
      { tipologia: 5, dettaglio: 7, quantita: 5 },
    ]);
    expect(servicesOf([ppip('p1', 12)])).toEqual([{ tipologia: 5, dettaglio: 7, quantita: 9 }]);
    expect(servicesOf([ppip('p1', 6), ppip('p2', 6)])).toEqual([
      { tipologia: 5, dettaglio: 7, quantita: 9 },
    ]);
    expect(servicesOf([])).toEqual([]);
  });

  it('la scelta del medico da sola non fa un contatto: entra in quello dello stesso giorno', () => {
    const choice: SiapAct = { kind: 'choice', id: 'x' };
    expect(makesContact([])).toBe(false);
    expect(makesContact([choice])).toBe(false);
    expect(makesContact([choice, diary('office')])).toBe(true);
    expect(makesContact([{ kind: 'sick_leave', id: 'c' }])).toBe(true);
  });

  it('modalità: dal diario, prima il domicilio, poi lo studio, la televisita e il telefono', () => {
    expect(modeOf([])).toBe('unknown');
    expect(modeOf([{ kind: 'sick_leave', id: 'c' }])).toBe('unknown');
    expect(modeOf([diary('phone')])).toBe('remote');
    expect(modeOf([diary('televisit')])).toBe('telemedicine');
    expect(modeOf([diary('office')])).toBe('office');
    expect(modeOf([diary('home')])).toBe('home');
    expect(modeOf([diary('phone'), diary('televisit')])).toBe('telemedicine');
    expect(modeOf([diary('phone'), diary('office'), diary('televisit')])).toBe('office');
    expect(modeOf([diary('office'), diary('home')])).toBe('home');
  });

  it('accesso: programmato con l’appuntamento, diretto con il diario senza, altrimenti non noto', () => {
    expect(accessTypeOf([], true)).toBe('scheduled');
    expect(accessTypeOf([diary('office')], true)).toBe('scheduled');
    expect(accessTypeOf([diary('office')], false)).toBe('direct');
    expect(accessTypeOf([{ kind: 'sick_leave', id: 'c' }], false)).toBe('unknown');
    expect(accessTypeOf([], false)).toBe('unknown');
  });

  it('stato del problema: sospetto, associato alla cronicità, in evoluzione; senza problema non noto', () => {
    expect(problemStateOf(null)).toBe('unknown');
    expect(problemStateOf({ openQuestion: true, chronic: true })).toBe('suspected');
    expect(problemStateOf({ openQuestion: false, chronic: true })).toBe('chronic');
    expect(problemStateOf({ openQuestion: false, chronic: false })).toBe('evolving');
  });

  it('la proposta: ciclo di scelta, il problema generico V70.0 con lo stato non noto', () => {
    expect(SIAP_GENERIC_PROBLEM).toBe('V70.0');
    expect(proposeContact([diary('home'), { kind: 'sick_leave', id: 'c' }], false)).toEqual({
      modalita: 'home',
      regime: 'choice',
      accesso: 'direct',
      problema: 'V70.0',
      statoProblema: 'unknown',
      prestazioni: [
        { tipologia: 1, dettaglio: 2, quantita: 1 },
        { tipologia: 6, dettaglio: 1, quantita: 1 },
      ],
    });
  });
});
