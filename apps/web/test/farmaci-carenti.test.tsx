import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ShortageNote, type DrugShortage } from '../src/components/Shortage';
import { drugFacts, ingredientOf, type Drug } from '../src/pages/PrescriptionEditor';

const SHORTAGE: DrugShortage = {
  since: '2026-11-02',
  expectedEnd: null,
  equivalentAvailable: true,
  reason: 'Cessata commercializzazione definitiva',
  aifaAdvice: 'Per trattamento alternativo si consiglia di rivolgersi allo specialista o al M.M.G',
  aifaNote: 'prima riga\n- seconda riga',
  text: 'nell’elenco AIFA dei farmaci carenti dal 02/11/2026 (Cessata commercializzazione definitiva); equivalente secondo l’elenco: sì',
};

const DRUG: Drug = {
  aic: '027428010',
  name: 'NORVASC',
  pack: '5 MG COMPRESSE- 28 COMPRESSE',
  activeIngredient: 'AMLODIPINA BESILATO',
  atc: 'C08CA01',
  drugClass: 'A',
  price: '5.53',
  aifaNote: null,
  dpc: false,
  planRequired: null,
  holder: 'VIATRIS PHARMA S.R.L.',
  referencePrice: '3.74',
  priceDifference: '1.79',
  transparencyRemark: null,
  shortage: null,
};

describe('farmaci carenti e lista di trasparenza nell’interfaccia (D202)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('la carenza ha simbolo, parola e testo dell’elenco; i dettagli solo se chiesti', () => {
    const { container, rerender } = render(<ShortageNote shortage={SHORTAGE} />);
    expect(container.textContent).toBe(`Farmaco carente: ${SHORTAGE.text}.`);
    expect(container.querySelector('.carenza svg')).toBeTruthy();
    rerender(<ShortageNote shortage={SHORTAGE} details />);
    expect(container.textContent).toContain(
      'Indicazioni AIFA: Per trattamento alternativo si consiglia di rivolgersi allo specialista o al M.M.G.',
    );
    expect(container.querySelector('.carenza-annotazione')!.textContent).toBe(
      ' Annotazione dell’elenco: prima riga\n- seconda riga',
    );
  });

  it('i dati del farmaco dicono prezzo di riferimento e differenza; la differenza zero non si scrive', () => {
    expect(drugFacts(DRUG)).toEqual([
      '5 MG COMPRESSE- 28 COMPRESSE',
      'ditta VIATRIS PHARMA S.R.L.',
      'classe A',
      '5,53 €',
      'prezzo di riferimento 3,74 €',
      'differenza dal riferimento 1,79 €',
    ]);
    const generic = {
      ...DRUG,
      price: '3.74',
      priceDifference: '0.00',
      transparencyRemark: 'In distribuzione diretta',
    };
    expect(drugFacts(generic)).not.toContain('differenza dal riferimento 0,00 €');
    expect(drugFacts(generic).at(-1)).toBe('In distribuzione diretta');
  });

  it('Oggi: i farmaci in terapia carenti con i pazienti, che si aprono con un clic', async () => {
    const today = (farmaciCarenti: unknown) => ({
      data: '2026-11-19',
      appuntamenti: [],
      code: {
        daFirmare: 0,
        nonInviate: 0,
        richiesteAperte: 0,
        pianiInScadenza: [],
        giorniAvvisoPiani: 30,
        farmaciCarenti,
      },
    });
    let list: unknown = [
      {
        aic: '038548032',
        farmaco: 'AMLODIPINA TEVA ITALIA',
        testo: SHORTAGE.text,
        pazienti: [
          { id: 'p1', nome: 'Lina', cognome: 'Rota' },
          { id: 'p2', nome: 'Ugo', cognome: 'Sala' },
        ],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        const body =
          path === '/api/io'
            ? {
                id: 'u1',
                nome: 'Medico inventato',
                ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
                postazione: null,
              }
            : path === '/api/oggi'
              ? today(list)
              : { stato: 'ok' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { unmount } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Farmaci in terapia carenti' })).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' && el.textContent === `AMLODIPINA TEVA ITALIA: ${SHORTAGE.text}.`,
      ),
    ).toBeTruthy();
    const patients = screen.getByRole('list', {
      name: 'Pazienti con AMLODIPINA TEVA ITALIA in terapia',
    });
    expect(
      within(patients)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Lina Rota', '/pazienti/p1'],
      ['Ugo Sala', '/pazienti/p2'],
    ]);
    unmount();
    // Nessun farmaco carente: la sezione non c'è.
    list = [];
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Da fare' });
    expect(screen.queryByRole('heading', { name: 'Farmaci in terapia carenti' })).toBeNull();
  });
});

describe('principio attivo nel risultato della ricerca (D256)', () => {
  it('si mostra quando il nome non lo dice: marchi e associazioni', () => {
    expect(ingredientOf({ name: 'ALAMUT', activeIngredient: 'RAMIPRIL' })).toBe('RAMIPRIL');
    expect(ingredientOf({ name: 'DUOTENS', activeIngredient: 'RAMIPRIL/FELODIPINA' })).toBe(
      'RAMIPRIL/FELODIPINA',
    );
    expect(ingredientOf({ name: 'AMLODIPINA DOC', activeIngredient: 'AMLODIPINA' })).toBeNull();
    expect(ingredientOf({ name: 'Ramipril Teva', activeIngredient: 'RAMIPRIL' })).toBeNull();
    expect(ingredientOf({ name: 'ALAMUT', activeIngredient: null })).toBeNull();
  });
});
