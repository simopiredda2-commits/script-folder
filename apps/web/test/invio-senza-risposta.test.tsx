import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SessionProvider } from '../src/lib/session';
import { SignQueuePage } from '../src/pages/SignQueuePage';

/**
 * Ricetta rimasta «in invio» (D233): nella pagina Ricette, fra gli invii senza risposta, il medico
 * segna l'esito chiesto all'ente; Oggi ne dà il conto. Servizio finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const me = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

const interrupted = {
  pazienti: [
    {
      paziente: {
        id: 'p1',
        nome: 'Paola',
        cognome: 'Inventata',
        codiceFiscale: 'XXXXXX00X00X000X',
      },
      ricette: [
        {
          id: 'r1',
          tipo: 'pharma_ssn',
          preparataIl: '2026-11-20T09:00:00Z',
          preparataDa: 'Medico inventato',
          righe: 1,
          errore: null,
          tipoErrore: null,
          firmataIl: '2026-11-20T09:05:00Z',
          firmataDa: 'Medico inventato',
        },
      ],
    },
  ],
};

/** Il servizio finto: risponde all'esito come la prova chiede, e ne tiene il corpo. */
function service(settled: (body: Record<string, unknown>) => object) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      if (path === '/api/io') return Promise.resolve(json(200, me));
      if (path === '/api/ricette/da-firmare' || path === '/api/ricette/non-inviate')
        return Promise.resolve(json(200, { pazienti: [] }));
      if (path === '/api/ricette/senza-risposta') return Promise.resolve(json(200, interrupted));
      if (path === '/api/ricette/r1/esito-invio') {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        bodies.push(body);
        return Promise.resolve(json(200, settled(body)));
      }
      if (path === '/api/ricette/r1/promemoria/consegne')
        return Promise.resolve(json(200, { consegne: [], carta: 'A5' }));
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
  return bodies;
}

function page() {
  render(
    <SessionProvider>
      <MemoryRouter>
        <SignQueuePage />
      </MemoryRouter>
    </SessionProvider>,
  );
}

const section = async () =>
  within(
    (await screen.findByRole('heading', { level: 2, name: 'Invii senza risposta' })).closest(
      'section',
    )!,
  );

describe('invii senza risposta nella pagina Ricette (D233)', () => {
  it('dice quando era partito l’invio e chi l’aveva firmato; «Non è arrivata» la rimette da inviare', async () => {
    const bodies = service(() => ({
      stato: 'error',
      nre: null,
      messaggio:
        'Non arrivata all’ente, secondo l’ente: si può rimandare o stampare la ricetta rossa',
    }));
    page();
    const s = await section();
    await s.findByRole('link', { name: 'Paola Inventata' });
    expect(s.getByText(/firmato da Medico inventato, è rimasto senza risposta/)).toBeTruthy();
    await userEvent.click(s.getByRole('button', { name: 'Non è arrivata: torna da inviare' }));
    await s.findByText('Ricetta di nuovo da inviare: è fra gli invii non riusciti.');
    expect(bodies).toEqual([{ esito: 'non_arrivata' }]);
  });

  it('«È arrivata» manda l’NRE e il codice di autenticazione scritti', async () => {
    const bodies = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }));
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    await userEvent.type(within(form).getByLabelText(/Numero di ricetta/), ' MAN000000000001 ');
    await userEvent.type(within(form).getByLabelText(/Codice di autenticazione/), 'MANAUT0001');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/Ricetta segnata come arrivata/);
    expect(s.getByText('MAN000000000001')).toBeTruthy();
    expect(bodies).toEqual([
      { esito: 'arrivata', nre: 'MAN000000000001', codiceAutenticazione: 'MANAUT0001' },
    ]);
  });

  it('«È arrivata» senza il codice: niente codice nel corpo, e l’avviso del promemoria', async () => {
    const bodies = service((b) => ({
      stato: 'sent',
      nre: b.nre,
      messaggio:
        'Ricetta segnata come arrivata, NRE MAN000000000002: senza il codice di autenticazione il promemoria non si stampa.',
    }));
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    await userEvent.type(within(form).getByLabelText(/Numero di ricetta/), 'MAN000000000002');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/senza il codice di autenticazione il promemoria non si stampa/);
    expect(bodies).toEqual([{ esito: 'arrivata', nre: 'MAN000000000002' }]);
  });
});

describe('Oggi: il conto degli invii senza risposta (D233)', () => {
  it('compare con il numero e porta alla coda nella pagina Ricette', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io') return Promise.resolve(json(200, me));
        if (path === '/api/oggi')
          return Promise.resolve(
            json(200, {
              data: '2026-11-20',
              appuntamenti: [],
              code: {
                daFirmare: 0,
                nonInviate: 0,
                senzaRisposta: 2,
                richiesteAperte: 0,
                pianiInScadenza: [],
                giorniAvvisoPiani: 30,
              },
            }),
          );
        return Promise.resolve(json(200, { stato: 'ok' }));
      }),
    );
    render(<App />);
    const link = await screen.findByRole('link', { name: /Invii senza risposta/ });
    expect(link.getAttribute('href')).toBe('/ricette#senza-risposta');
    await waitFor(() => expect(within(link).getByText('2')).toBeTruthy());
  });
});
