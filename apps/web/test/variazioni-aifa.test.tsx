import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  AifaChangeNote,
  isSuspended,
  SuspendedNote,
  type AifaChange,
} from '../src/components/Shortage';

const CLASS_CHANGE: AifaChange = {
  kind: 'classe',
  since: '2026-11-01',
  text: 'non è più nell’elenco AIFA dei farmaci di classe A (versione del 01/11/2026); nella terapia è segnato in classe A',
};
const SUSPENDED: AifaChange = {
  kind: 'sospesa',
  since: '2026-11-20',
  text: 'confezione sospesa secondo l’anagrafica AIFA delle confezioni (versione del 20/11/2026)',
};

describe('variazioni AIFA nell’interfaccia (A7, D205)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('la variazione ha simbolo, parola e testo; nella scheda anche come si chiude', () => {
    const { container, rerender } = render(<AifaChangeNote change={CLASS_CHANGE} />);
    expect(container.textContent).toBe(`Variazione AIFA: ${CLASS_CHANGE.text}.`);
    expect(container.querySelector('.carenza svg')).toBeTruthy();
    rerender(<AifaChangeNote change={CLASS_CHANGE} details />);
    expect(container.textContent).toBe(
      `Variazione AIFA: ${CLASS_CHANGE.text}. Per aggiornare la scheda, scegli di nuovo il farmaco e salva.`,
    );
    rerender(<AifaChangeNote change={{ ...CLASS_CHANGE, kind: 'piano' }} details />);
    expect(container.textContent).toMatch(
      /Si chiude collegando il piano terapeutico alla terapia\.$/,
    );
  });

  it('la confezione sospesa nei risultati della ricerca, solo se l’anagrafica lo dice', () => {
    const { container } = render(<SuspendedNote />);
    expect(container.textContent).toBe(
      'Confezione sospesa secondo l’anagrafica AIFA delle confezioni.',
    );
    expect(container.querySelector('.carenza svg')).toBeTruthy();
    expect(isSuspended('Sospesa')).toBe(true);
    expect(isSuspended(' sospesa ')).toBe(true);
    expect(isSuspended('Autorizzata')).toBe(false);
    expect(isSuspended(null)).toBe(false);
  });

  it('Oggi: una voce per farmaco e variazione, con i pazienti che si aprono con un clic', async () => {
    let list: unknown = [
      {
        aic: '034471021',
        farmaco: 'RANITIDINA DOC GENERICI',
        tipo: 'sospesa',
        testo: SUSPENDED.text,
        pazienti: [
          { id: 'p1', nome: 'Lina', cognome: 'Rota' },
          { id: 'p2', nome: 'Ugo', cognome: 'Sala' },
        ],
      },
      {
        aic: '034471021',
        farmaco: 'RANITIDINA DOC GENERICI',
        tipo: 'classe',
        testo: CLASS_CHANGE.text,
        pazienti: [{ id: 'p2', nome: 'Ugo', cognome: 'Sala' }],
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
              ? {
                  data: '2026-11-20',
                  appuntamenti: [],
                  code: {
                    daFirmare: 0,
                    nonInviate: 0,
                    richiesteAperte: 0,
                    pianiInScadenza: [],
                    giorniAvvisoPiani: 30,
                    farmaciCarenti: [],
                    variazioniAifa: list,
                  },
                }
              : { stato: 'ok' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { unmount } = render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Variazioni AIFA sui farmaci in terapia' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          el.textContent === `RANITIDINA DOC GENERICI: ${SUSPENDED.text}.`,
      ),
    ).toBeTruthy();
    const suspended = screen.getByRole('list', {
      name: 'Pazienti con RANITIDINA DOC GENERICI in terapia: confezione sospesa',
    });
    expect(
      within(suspended)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Lina Rota', '/pazienti/p1'],
      ['Ugo Sala', '/pazienti/p2'],
    ]);
    // Lo stesso farmaco con un'altra variazione: un elenco a sé, con il suo nome.
    expect(
      screen.getByRole('list', {
        name: 'Pazienti con RANITIDINA DOC GENERICI in terapia: classe cambiata',
      }),
    ).toBeTruthy();
    unmount();
    list = [];
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Da fare' });
    expect(
      screen.queryByRole('heading', { name: 'Variazioni AIFA sui farmaci in terapia' }),
    ).toBeNull();
  });
});
