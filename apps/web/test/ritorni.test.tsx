import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { IdentityPage } from '../src/pages/IdentityPage';
import { RecoveryPage } from '../src/pages/RecoveryPage';
import { ServiceCredentialsPage } from '../src/pages/ServiceCredentialsPage';

/**
 * Ritorni da SPID o CIE e dalla pagina regionale (D193): nell'indirizzo c'è solo il codice del
 * motivo, e un testo scritto nell'indirizzo non compare mai. Chiunque potrebbe mandare un
 * collegamento al dominio vero con un messaggio falso.
 */
const FORGED = 'Conto sospeso: chiama subito il numero 000 000 000';
const forged = encodeURIComponent(FORGED);

/** Le risposte del servizio, finte. */
function fakeService() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const json = (data: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (url === '/api/io')
        return json({
          id: 'u1',
          nome: 'Medico di prova',
          ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
          postazione: null,
          archivio: null,
        });
      if (url === '/api/profilo/identita')
        return json({
          disponibile: true,
          perIlMedico: false,
          puoRipristinare: true,
          collegata: false,
          codiceFiscale: null,
          collegataIl: null,
        });
      if (url === '/api/profilo/credenziali') return json({ servizi: [] });
      return json({});
    }),
  );
}

/** Le pagine del ripristino e dell'identità leggono l'indirizzo della finestra. */
const at = (path: string) => window.history.replaceState({}, '', path);

describe('ritorni da SPID o CIE: solo il testo del programma (D193)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    at('/');
  });

  it('ripristino: un testo nell’indirizzo non compare; un codice noto dà il suo testo', async () => {
    fakeService();
    at(`/ripristino?esito=errore&motivo=${forged}`);
    const first = render(
      <MemoryRouter>
        <RecoveryPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Non riuscito: ricomincia')).toBeTruthy();
    expect(screen.queryByText(new RegExp(FORGED))).toBeNull();
    first.unmount();
    // Nemmeno i nomi delle proprietà degli oggetti valgono come codici.
    at('/ripristino?esito=errore&motivo=toString');
    const second = render(
      <MemoryRouter>
        <RecoveryPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Non riuscito: ricomincia')).toBeTruthy();
    second.unmount();
    at('/ripristino?esito=errore&motivo=non-riconosciuta');
    render(
      <MemoryRouter>
        <RecoveryPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Richiesta non riconosciuta o scaduta: ricomincia'),
    ).toBeTruthy();
  });

  it('collegamento dell’identità: un testo nell’indirizzo non compare', async () => {
    fakeService();
    at(`/profilo/identita?collegamento=errore&motivo=${forged}`);
    render(
      <MemoryRouter>
        <IdentityPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Collegamento non riuscito')).toBeTruthy();
    expect(screen.queryByText(new RegExp(FORGED))).toBeNull();
  });

  it('accesso regionale: un testo nell’indirizzo non compare; un codice noto dà il suo testo', async () => {
    fakeService();
    const show = (query: string) =>
      render(
        <SessionProvider>
          <MemoryRouter initialEntries={[`/profilo/credenziali?${query}`]}>
            <ServiceCredentialsPage />
          </MemoryRouter>
        </SessionProvider>,
      );
    const first = show(`accesso=errore&motivo=${forged}`);
    expect(
      await screen.findByText('Accesso regionale non riuscito: motivo non indicato.'),
    ).toBeTruthy();
    expect(screen.queryByText(new RegExp(FORGED))).toBeNull();
    first.unmount();
    show('accesso=errore&motivo=identita-diversa');
    expect(await screen.findByText(/identità diversa da quella del medico collegato/)).toBeTruthy();
  });
});
