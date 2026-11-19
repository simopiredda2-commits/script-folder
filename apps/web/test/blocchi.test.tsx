import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { LocksPage } from '../src/pages/LocksPage';

/** Le risposte del servizio, finte; le richieste mandate restano in `sent`. */
function fakeService(locks: object[]) {
  const sent: { url: string; body: unknown }[] = [];
  let current = locks;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      sent.push({ url, body });
      const json = (data: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (url === '/api/blocchi/visti') {
        current = [];
        return json({ segnati: locks.length });
      }
      if (url === '/api/blocchi') return json({ totale: current.length, blocchi: current });
      if (url === '/api/io')
        return json({
          id: 'u1',
          nome: 'Utente di prova',
          ruoli: [],
          postazione: null,
          archivio: null,
        });
      return json({});
    }),
  );
  return sent;
}

const lock = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  utente: { id: 'u2', nome: 'Marta Servi', nomeUtente: 'segreteria.prova' },
  proprio: false,
  motivo: 'passwords',
  motivoTesto: 'password sbagliate',
  tentativi: 50,
  bloccatoIl: '2026-11-19T10:00:00Z',
  bloccatoFinoA: '2026-11-19T10:15:00Z',
  indirizzi: ['10.9.3.1', '10.9.2.1'],
  postazioni: ['pc-fuori'],
  ...over,
});

describe('blocchi del conto (D188)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('mostra chi, quando, da dove e che cosa fare; «Segna come visti» manda gli identificativi mostrati', async () => {
    const sent = fakeService([
      lock(),
      lock({
        id: '00000000-0000-4000-8000-000000000002',
        proprio: true,
        motivo: 'codes',
        motivoTesto: 'codici sbagliati',
        tentativi: 5,
        indirizzi: ['10.8.0.1'],
        postazioni: [],
      }),
    ]);
    render(
      <MemoryRouter>
        <SessionProvider>
          <LocksPage />
        </SessionProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Marta Servi (segreteria.prova)' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Il tuo conto' })).toBeTruthy();
    expect(screen.getByText(/dopo 50 password sbagliate di seguito/)).toBeTruthy();
    expect(screen.getByText('10.9.3.1, 10.9.2.1')).toBeTruthy();
    expect(screen.getByText('nessuna')).toBeTruthy();
    expect(screen.getByText(/Chi ha scritto i codici conosceva la tua password/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Segna come visti' }));
    expect(await screen.findByText('Nessun blocco da vedere.')).toBeTruthy();
    expect(sent.find((r) => r.url === '/api/blocchi/visti')!.body).toEqual({
      blocchi: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
    });
  });
});

describe('avviso dei blocchi nella cornice (D188)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('dice quanti blocchi ci sono da vedere, porta alla pagina, e sparisce quando sono visti', async () => {
    let unseen = [
      lock(),
      lock({
        id: '00000000-0000-4000-8000-000000000003',
        utente: { id: 'u3', nome: 'Altro', nomeUtente: 'altro' },
      }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = url.split('?')[0]!;
        const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));
        if (path === '/api/io')
          return json({
            id: 'd1',
            nome: 'Dott. Paolo Serra',
            ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
            postazione: 'Studio',
            archivio: null,
            blocchiDaVedere: unseen.length,
          });
        if (path === '/api/blocchi') return json({ totale: unseen.length, blocchi: unseen });
        if (path === '/api/blocchi/visti' && init?.method === 'POST') {
          unseen = [];
          return json({ segnati: 2 });
        }
        if (path === '/api/oggi')
          return json({
            data: '2026-11-19',
            appuntamenti: [],
            code: {
              daFirmare: 0,
              nonInviate: 0,
              richiesteAperte: 0,
              pianiInScadenza: [],
              giorniAvvisoPiani: 30,
            },
          });
        return Promise.resolve(
          new Response(JSON.stringify({ errore: 'Non trovato' }), { status: 404 }),
        );
      }),
    );
    render(<App />);
    const banner = await screen.findByText(
      /2 blocchi del conto dopo troppi tentativi sbagliati, da vedere\./,
    );
    await userEvent.click(within(banner).getByRole('link', { name: 'Vedi i blocchi' }));
    await screen.findByRole('heading', { name: 'Blocchi del conto' });
    // Sulla pagina l'avviso della cornice non si ripete.
    expect(screen.queryByText(/blocchi del conto dopo troppi tentativi sbagliati/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Segna come visti' }));
    await screen.findByText('Nessun blocco da vedere.');
    await waitFor(() =>
      expect(screen.queryByText(/blocchi? del conto dopo troppi tentativi sbagliati/)).toBeNull(),
    );
  });
});
