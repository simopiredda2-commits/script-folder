import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { SignQueuePage } from '../src/pages/SignQueuePage';

/**
 * Le ricette in attesa viste dalla segreteria (D242): la pagina Ricette le promette, «Qui sotto le
 * ricette in attesa». Si vedono con le righe, in sola lettura: firma ed esito restano del medico.
 * Servizio finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const who = (codice: string, nome: string) => ({
  id: 'u1',
  nome: 'Utente inventato',
  ruoli: [{ codice, nome }],
  postazione: 'Studio',
  archivio: null,
});

/** Una coda con una ricetta della paziente inventata, firmabile o no. */
const queue = (id: string, firmabile: boolean, extra: object = {}) => ({
  pazienti: [
    {
      paziente: { id: 'p1', nome: 'Paola', cognome: 'Inventata', codiceFiscale: 'XXX' },
      ricette: [
        {
          id,
          tipo: 'pharma_ssn',
          preparataIl: '2026-11-20T09:00:00Z',
          preparataDa: 'Segreteria inventata',
          righe: 1,
          errore: null,
          tipoErrore: null,
          firmabile,
          ...extra,
        },
      ],
    },
  ],
});

function service(me: object, firmabile: boolean) {
  const calls: string[] = [];
  let archived = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      calls.push(init?.method === 'POST' ? `POST ${path}` : path);
      if (path === '/api/io') return Promise.resolve(json(200, me));
      if (path === '/api/ricette/archivia-confermate' && init?.method === 'POST') {
        archived = true;
        return Promise.resolve(json(200, { archiviate: 1 }));
      }
      if (path === '/api/ricette/confermate')
        return Promise.resolve(
          json(
            200,
            archived
              ? { pazienti: [] }
              : queue('r4', false, {
                  stato: 'sent',
                  nre: '010000000004',
                  inviataIl: '2026-11-20T09:30:00Z',
                  firmataDa: 'Medico inventato',
                }),
          ),
        );
      if (path === '/api/ricette/da-firmare')
        return Promise.resolve(json(200, queue('r1', firmabile)));
      if (path === '/api/ricette/non-inviate')
        return Promise.resolve(
          json(
            200,
            queue('r2', firmabile, { errore: 'Esenzione non valida', tipoErrore: 'rejected' }),
          ),
        );
      if (path === '/api/ricette/senza-risposta')
        return Promise.resolve(
          json(
            200,
            queue('r3', firmabile, {
              firmataIl: '2026-11-20T09:05:00Z',
              firmataDa: 'Medico inventato',
              esitoDal: '2026-11-20T09:20:00Z',
            }),
          ),
        );
      if (path === '/api/pazienti/p1/ricette')
        return Promise.resolve(
          json(200, {
            ricette: ['r1', 'r2', 'r3'].map((id) => ({
              id,
              righe: [
                {
                  id: `l-${id}`,
                  drugName: 'Farmaco di prova 5 mg',
                  serviceDescription: null,
                  quantity: 1,
                },
              ],
            })),
          }),
        );
      if (path === '/api/credenziali/stato')
        return Promise.resolve(json(200, { pronte: true, mancano: [] }));
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
  return calls;
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

const section = async (name: string) =>
  within((await screen.findByRole('heading', { level: 2, name })).closest('section')!);

describe('ricette in attesa viste dalla segreteria (D242)', () => {
  it('la segreteria vede le tre code con le righe, senza firma né esito', async () => {
    service(who('secretary', 'Segreteria'), false);
    page();
    await screen.findByText(/Qui sotto le ricette in attesa/);
    const toSign = await section('Da firmare');
    await toSign.findByText('Farmaco di prova 5 mg × 1');
    toSign.getByText('In attesa della firma del medico.');
    const failed = await section('Invii non riusciti');
    await failed.findByText(/Esenzione non valida/);
    failed.getByText('La corregge e la reinvia il medico.');
    const interrupted = await section('Invii senza risposta');
    await interrupted.findByText(/firmata da Medico inventato: l’esito lo segna il medico/);
    // Nessun pulsante di firma, di controllo o di esito: sono del medico.
    for (const name of [/Firma e invia/, /Controlla/, /arrivata/, /Manda alla firma/])
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
  });

  it('il medico, sulle ricette che firma, ha i pannelli di firma e di esito', async () => {
    service(who('owner_doctor', 'Medico titolare'), true);
    page();
    const toSign = await section('Da firmare');
    await toSign.findByText('Farmaco di prova 5 mg × 1');
    expect(toSign.queryByText('In attesa della firma del medico.')).toBeNull();
    const interrupted = await section('Invii senza risposta');
    await interrupted.findByRole('button', { name: /Non è arrivata/ });
  });

  it('alla segreteria i pannelli non compaiono nemmeno se il servizio la dicesse firmabile', async () => {
    service(who('secretary', 'Segreteria'), true);
    page();
    const toSign = await section('Da firmare');
    await toSign.findByText('Farmaco di prova 5 mg × 1');
    toSign.getByText('In attesa della firma del medico.');
    const interrupted = await section('Invii senza risposta');
    await interrupted.findByText(/l’esito lo segna il medico/);
    expect(screen.queryByRole('button', { name: /arrivata/ })).toBeNull();
  });

  it('chi non è medico né segreteria non chiede le code', async () => {
    const calls = service(who('administrator', 'Amministratore dello studio'), false);
    page();
    const toSign = await section('Da firmare');
    toSign.getByText('Le ricette in attesa le vedono il medico e la segreteria.');
    expect(calls.filter((c) => c.startsWith('/api/ricette/'))).toEqual([]);
  });
});

describe('ricette confermate e archiviazione (D254)', () => {
  it('la segreteria vede le confermate con il menu di stampa e le archivia', async () => {
    const calls = service(who('secretary', 'Segreteria'), false);
    page();
    const done = await section('Confermate');
    await done.findByText('010000000004');
    done.getByText(/inviata il/);
    // Il menu di stampa e invio si apre a richiesta.
    const menu = done.getByRole('button', { name: 'Stampa e invio del promemoria' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    done.getByRole('button', { name: /Archivia ricette confermate \(1\)/ }).click();
    await done.findByText(/1 ricetta archiviata: restano nello storico dei pazienti/);
    await done.findByText('Nessuna ricetta confermata da archiviare.');
    expect(calls).toContain('POST /api/ricette/archivia-confermate');
  });

  it('chi non è medico né segreteria non le chiede', async () => {
    const calls = service(who('administrator', 'Amministratore dello studio'), false);
    page();
    await section('Confermate');
    expect(calls.filter((c) => c.includes('/api/ricette/'))).toEqual([]);
  });
});
