import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

/** Servizio simulato: utente medico, pagina Oggi vuota, credenziali come indicato. */
function stubFetch(credentials: unknown) {
  const fetchMock = vi.fn((url: string) => {
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
              data: '2026-11-18',
              appuntamenti: [],
              code: {
                daFirmare: 0,
                nonInviate: 0,
                richiesteAperte: 0,
                pianiInScadenza: [],
                giorniAvvisoPiani: 30,
              },
            }
          : path === '/api/profilo/credenziali'
            ? credentials
            : { stato: 'ok' };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const asked = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/profilo/credenziali'));

describe('pagina Oggi: avvisi dei servizi (D100–D102)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('una risposta inattesa delle credenziali non fa cadere la pagina', async () => {
    const fetchMock = stubFetch({ stato: 'ok' });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Oggi' });
    await waitFor(() => expect(asked(fetchMock)).toBe(true));
    // La risposta arriva ed è elaborata: la pagina resta in piedi, senza avvisi.
    await new Promise((ok) => setTimeout(ok, 50));
    expect(screen.getByRole('heading', { level: 1, name: 'Oggi' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Servizi' })).toBeNull();
  });

  it('con credenziali mancanti e codice di sessione spento, gli avvisi ci sono', async () => {
    stubFetch({
      servizi: [
        {
          servizio: 'rupar',
          nome: 'RUPAR Piemonte',
          uso: 'Ricette SSN al SAR della Regione Piemonte',
          impostate: true,
          utente: '…ABC',
          passwordCambiataIl: '2026-08-20',
          scadenzaPassword: '2026-11-20',
          statoPassword: 'in_scadenza',
          aggiornateIl: null,
          secondoFattore: true,
          sessione: { attiva: false, scadeIl: null },
          ambiente: 'simulator',
        },
        {
          servizio: 'sistema-ts',
          nome: 'Sistema TS',
          uso: 'Certificati di malattia INPS e ricetta bianca elettronica',
          impostate: false,
          utente: null,
          passwordCambiataIl: null,
          scadenzaPassword: null,
          statoPassword: null,
          aggiornateIl: null,
          secondoFattore: true,
          sessione: { attiva: false, scadeIl: null },
          ambiente: 'simulator',
        },
      ],
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Servizi' });
    expect(
      screen.getByText('La password RUPAR Piemonte scade a breve: cambiala per tempo.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Codice di sessione RUPAR Piemonte non attivo: serve per mandare le ricette.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Mancano le credenziali Sistema TS/)).toBeTruthy();
  });
});
