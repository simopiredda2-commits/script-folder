import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedPrintedNotice } from '../src/components/RedFormPrint';
import { SessionProvider } from '../src/lib/session';

/**
 * Le parole del servizio delle ricette della regione dello studio (D300): l'interfaccia non nomina
 * nessuna regione; il nome del servizio, con l'articolo e le preposizioni, arriva con i dati
 * dell'utente. Senza, le parole generiche. La regione e il servizio qui sono inventati.
 */

function stubMe(servizioRicette: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0];
      const body =
        path === '/api/io'
          ? {
              id: 'u1',
              nome: 'Dott.ssa Titolare Inventata',
              ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
              postazione: 'Studio',
              archivio: { id: 'a1', nome: 'Archivio di prova' },
              servizioRicette,
            }
          : { errore: 'Non trovato' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: path === '/api/io' ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const RED = {
  nre: '010ZZ4000001000',
  poligrafico: '010260000000101',
  pdf: '/api/ricette/r1/ricetta-rossa.pdf',
  annullamentoDematerializzata: 'da_fare' as const,
  avviso: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parole del servizio delle ricette della regione (D300)', () => {
  it('con il servizio della regione: il suo nome, con la preposizione che vuole', async () => {
    stubMe({
      via: 'servizio',
      nome: 'SRP',
      il: 'lo SRP',
      al: 'allo SRP',
      dal: 'dallo SRP',
      del: 'dello SRP',
      ricettaRossaDpcm: true,
    });
    render(
      <SessionProvider>
        <RedPrintedNotice red={RED} />
      </SessionProvider>,
    );
    expect(
      await screen.findByText(
        'La ricetta dematerializzata, se era arrivata allo SRP, si annulla da sola.',
      ),
    ).toBeTruthy();
  });

  it('senza il servizio della regione: le parole generiche', async () => {
    stubMe(null);
    render(
      <SessionProvider>
        <RedPrintedNotice red={RED} />
      </SessionProvider>,
    );
    expect(
      await screen.findByText(
        'La ricetta dematerializzata, se era arrivata al servizio della regione, si annulla da sola.',
      ),
    ).toBeTruthy();
  });
});
