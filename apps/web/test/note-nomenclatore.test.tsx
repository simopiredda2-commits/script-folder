import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceResultText } from '../src/components/ServiceResult';
import { lineSummary, noteLetters } from '../src/pages/PrescriptionEditor';

/** Nota del nomenclatore, sedute dei cicli e tariffa indicativa nella ricetta specialistica (D276). */
describe('note del nomenclatore e sedute nell’interfaccia (D276)', () => {
  afterEach(cleanup);

  it('le lettere della nota come la nota le scrive: maiuscole, o minuscole se mancano le maiuscole', () => {
    expect(
      noteLetters(
        'A) 0-14 anni. B) Condizioni di vulnerabilità sanitaria; C) Condizioni di vulnerabilità sociale',
      ),
    ).toEqual(['A', 'B', 'C']);
    // Le voci minuscole dentro una condizione maiuscola non sono condizioni a parte.
    expect(noteLetters('A) Prima: a) una; b) due. B) Seconda')).toEqual(['A', 'B']);
    expect(noteLetters('Indicata nei pazienti con patologie: a) ossee; b) epatobiliari.')).toEqual([
      'A',
      'B',
    ]);
    expect(noteLetters('Generalità della popolazione')).toEqual([]);
    expect(noteLetters('allegato 4 B')).toEqual([]);
  });

  it('il riepilogo della riga dice la nota con la lettera e le sedute', () => {
    expect(
      lineSummary(
        {
          quantity: 1,
          serviceCode: 'CICLO.1',
          serviceNationalCode: 'CICLO.1',
          sessions: '10',
        },
        'specialistica',
      ),
    ).toBe('quantità 1 · catalogo CICLO.1 · nomenclatore (DM) CICLO.1 · 10 sedute');
    expect(
      lineSummary(
        { quantity: 1, serviceCode: 'COND.1', serviceNote: '99', serviceNoteLetter: 'B' },
        'specialistica',
      ),
    ).toBe('quantità 1 · catalogo COND.1 · nota 99 B');
  });

  it('il risultato della ricerca dice la tariffa indicativa, il ciclo e la nota', () => {
    render(
      <ServiceResultText
        s={{
          regionalCode: 'CICLO.1',
          nationalCode: 'CICLO.1',
          description: 'Rieducazione di prova, per seduta',
          branch: 'Riabilitazione di prova',
          fee: '22.50',
          notes: null,
          cycle: true,
          sessions: 10,
          note: { note: '99', kind: 'condizione', text: 'A) Prova' },
        }}
      />,
    );
    expect(screen.getByText(/tariffa indicativa/).textContent).toMatch(
      /^Riabilitazione di prova · tariffa indicativa .*22,50/,
    );
    expect(
      screen.getByText('A ciclo, al più 10 sedute · Nota 99, condizione di erogabilità'),
    ).toBeTruthy();
  });
});
