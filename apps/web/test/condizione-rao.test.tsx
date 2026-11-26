import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterRaoChoice,
  RaoConditionField,
  raoChoiceOf,
  type RaoChoice,
  type RaoTable,
} from '../src/components/RaoCondition';

/** La condizione RAO nella ricetta specialistica (D285): una tabella di prova, inventata. */
const table: RaoTable = {
  fonte: 'prova',
  titoloFonte: 'Tabelle di prova',
  ambito: 'regionale',
  controllatoDa: null,
  noteDelDocumento: null,
  id: 't1',
  servizi: ['VISITA DI PROVA'],
  testata: 'VISITA DI PROVA - Codice 00.0',
  pagine: [1],
  note: ['Nota di prova della tabella'],
  prestazioni: ['00.0'],
  righe: [
    {
      classe: 'emergenza',
      pediatria: false,
      attesa: 'PS',
      gruppo: null,
      daNota: true,
      nonPreviste: null,
      indicazioni: [
        { chiave: 'prova:t1:1:1', numero: '1', testo: 'Condizione urgente di prova', altro: false },
      ],
    },
    {
      classe: 'U',
      pediatria: false,
      attesa: '72 ore',
      gruppo: null,
      daNota: false,
      nonPreviste: 'Livello di priorità non previsto',
      indicazioni: [],
    },
    {
      classe: 'B',
      pediatria: false,
      attesa: '10 gg',
      gruppo: null,
      daNota: false,
      nonPreviste: null,
      indicazioni: [
        { chiave: 'prova:t1:3:1', numero: '1', testo: 'Prima condizione di prova', altro: false },
        { chiave: 'prova:t1:3:2', numero: '2', testo: 'Altro (10%)', altro: true },
      ],
    },
    {
      classe: 'D',
      pediatria: true,
      attesa: '30 gg',
      gruppo: null,
      daNota: false,
      nonPreviste: null,
      indicazioni: [
        {
          chiave: 'prova:t1:4:1',
          numero: '1',
          testo: 'Condizione pediatrica di prova',
          altro: false,
        },
      ],
    },
    {
      classe: 'P',
      pediatria: false,
      attesa: '120 gg',
      gruppo: 'Pazienti di prova',
      daNota: false,
      nonPreviste: null,
      indicazioni: [
        {
          chiave: 'prova:t1:5:1',
          numero: '1',
          testo: 'Condizione programmata di prova',
          altro: false,
        },
      ],
    },
  ],
};

describe('condizione RAO nella ricetta specialistica (D285)', () => {
  afterEach(cleanup);

  it('la chiave dà la condizione con la classe della sua riga; l’emergenza no', () => {
    expect(raoChoiceOf([table], 'prova:t1:3:1')).toEqual({
      key: 'prova:t1:3:1',
      testo: 'Prima condizione di prova',
      classe: 'B',
      altro: false,
    });
    expect(raoChoiceOf([table], 'prova:t1:1:1')).toBeNull();
    expect(raoChoiceOf([table], '')).toBeNull();
    expect(raoChoiceOf([table], 'prova:t1:9:9')).toBeNull();
  });

  it('l’elenco per classe: prima gli adulti, poi l’età pediatrica; l’emergenza a parte', () => {
    render(<RaoConditionField tables={[table]} value="" priority="" onChange={() => {}} />);
    const select = screen.getByLabelText<HTMLSelectElement>('Condizione clinica (RAO)');
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual([
      'B – breve · 10 gg',
      'P – programmata · 120 gg · Pazienti di prova',
      'D – differibile · 30 gg · età pediatrica',
    ]);
    expect(within(select).queryByText('Condizione urgente di prova')).toBeNull();
    expect(select.value).toBe('');
    // Le fonti, con lo stato della trascrizione.
    expect(
      screen.getByText(/Tabelle di prova, tabella t1 \(trascrizione da controllare\)/),
    ).toBeTruthy();
    // Il promemoria del pronto soccorso e le note, a parte.
    expect(screen.getByText('Condizione urgente di prova')).toBeTruthy();
    expect(screen.getByText('Nota di prova della tabella')).toBeTruthy();
  });

  it('scelta la condizione, la pagina riceve la classe; «Altro» chiede il quesito', () => {
    const onChange = vi.fn<(c: RaoChoice | null) => void>();
    const { rerender } = render(
      <RaoConditionField tables={[table]} value="" priority="" onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText('Condizione clinica (RAO)'), {
      target: { value: 'prova:t1:5:1' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      key: 'prova:t1:5:1',
      testo: 'Condizione programmata di prova',
      classe: 'P',
      altro: false,
    });
    rerender(
      <RaoConditionField tables={[table]} value="prova:t1:3:2" priority="B" onChange={onChange} />,
    );
    expect(screen.getByText(/«Altro» presuppone la descrizione in dettaglio/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Condizione clinica (RAO)'), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('se il medico cambia la classe, la pagina lo dice, con il simbolo e la parola', () => {
    const { rerender } = render(
      <RaoConditionField tables={[table]} value="prova:t1:3:1" priority="B" onChange={() => {}} />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    rerender(
      <RaoConditionField tables={[table]} value="prova:t1:3:1" priority="D" onChange={() => {}} />,
    );
    expect(screen.getByRole('status').textContent).toMatch(
      /La classe della ricetta, D – differibile, non è quella della condizione scelta, B – breve\./,
    );
  });
  it('la scelta mette la classe; il quesito prende il testo solo se è vuoto o è della condizione di prima', () => {
    const first = raoChoiceOf([table], 'prova:t1:3:1')!;
    const second = raoChoiceOf([table], 'prova:t1:5:1')!;
    const other = raoChoiceOf([table], 'prova:t1:3:2')!;
    expect(afterRaoChoice(first, null, '')).toEqual({
      priority: 'B',
      question: 'Prima condizione di prova',
    });
    // Il quesito è ancora quello della condizione di prima: prende quello nuovo.
    expect(afterRaoChoice(second, first, 'Prima condizione di prova')).toEqual({
      priority: 'P',
      question: 'Condizione programmata di prova',
    });
    // Il quesito scritto dal medico resta.
    expect(afterRaoChoice(second, first, 'Quesito del medico')).toEqual({
      priority: 'P',
      question: 'Quesito del medico',
    });
    // «Altro»: la classe sì, il quesito resta al medico, anche vuoto.
    expect(afterRaoChoice(other, null, '')).toEqual({ priority: 'B', question: '' });
  });
});
