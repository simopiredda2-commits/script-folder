import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { ServiceCredentialsPage } from '../src/pages/ServiceCredentialsPage';

/**
 * La pagina delle credenziali con il servizio della regione dello studio (D301): il nome del
 * servizio e la nota sotto l'accesso con SPID o CIE arrivano dal servizio, la pagina non nomina
 * nessuna regione; le credenziali di un'altra regione si possono solo cancellare. La regione e i
 * servizi qui sono inventati.
 */

const base = {
  impostate: true,
  utente: '…ABC',
  passwordCambiataIl: '2026-11-01',
  scadenzaPassword: null,
  statoPassword: 'senza_scadenza',
  aggiornateIl: null,
  sessione: { attiva: false, scadeIl: null, modalita: null },
  ambiente: 'simulator',
};

function fakeService(servizi: unknown[]) {
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
      if (url === '/api/profilo/credenziali') return json({ servizi });
      return json({});
    }),
  );
}

const show = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={['/profilo/credenziali']}>
        <ServiceCredentialsPage />
      </MemoryRouter>
    </SessionProvider>,
  );

describe('credenziali del servizio della regione dello studio (D301)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('il nome e la nota dell’accesso con SPID o CIE sono quelli che dà la regione', async () => {
    fakeService([
      {
        ...base,
        servizio: 'srp',
        nome: 'SRP Regione inventata',
        uso: 'Ricette SSN al servizio della regione inventata',
        inUso: true,
        secondoFattore: true,
        accessoRegionale: true,
        notaAccessoRegionale: 'Servono però per la ricetta rossa della regione inventata.',
      },
    ]);
    show();
    expect(
      await screen.findByText(
        /Con questo accesso le credenziali SRP Regione inventata non servono per mandare le ricette\. Servono però per la ricetta rossa della regione inventata\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Non attivo. Serve con le credenziali SRP Regione inventata, al posto dell’accesso con SPID o CIE.',
      ),
    ).toBeTruthy();
  });

  it('le credenziali di un’altra regione: solo la cancellazione, niente modulo né codice di sessione', async () => {
    fakeService([
      {
        ...base,
        servizio: 'altro',
        nome: 'Servizio di un’altra regione',
        uso: 'Prove',
        inUso: false,
        secondoFattore: false,
        accessoRegionale: false,
        notaAccessoRegionale: null,
      },
    ]);
    show();
    expect(
      await screen.findByText(
        /Non è il servizio della regione dello studio: queste credenziali non si usano\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancella le credenziali' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salva' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chiedi il codice' })).toBeNull();
  });
});
