import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityPage } from '../src/pages/IdentityPage';

/** Il servizio finto risponde solo allo stato dell'identità. */
function fakeIdentity(state: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(state)))),
  );
}

const base = {
  disponibile: true,
  perIlMedico: false,
  puoRipristinare: true,
  collegata: false,
  codiceFiscale: null,
  collegataIl: null,
};

const show = () =>
  render(
    <MemoryRouter>
      <IdentityPage />
    </MemoryRouter>,
  );

describe('SPID o CIE per il ripristino (D189)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('la segreteria non collegata vede che cosa cambia e collega con il codice di adesso', async () => {
    fakeIdentity(base);
    show();
    expect(await screen.findByText(/Non collegata: se perdi la password/)).toBeTruthy();
    expect(screen.getByLabelText('Codice a 6 cifre di adesso')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collega con SPID o CIE' })).toBeTruthy();
  });

  it('collegata: il codice fiscale, «Scollega» e «Collega di nuovo»', async () => {
    fakeIdentity({
      ...base,
      collegata: true,
      codiceFiscale: 'SRVMRT85C41X101Q',
      collegataIl: '2026-11-19T10:00:00Z',
    });
    show();
    expect(await screen.findByText('SRVMRT85C41X101Q')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scollega' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collega di nuovo con SPID o CIE' })).toBeTruthy();
  });

  it('il medico non collega nulla; senza il collegamento vero non si offre nulla', async () => {
    fakeIdentity({ ...base, perIlMedico: true });
    show();
    expect(
      await screen.findByText(/vale il codice fiscale del tuo profilo di medico/),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    fakeIdentity({ ...base, disponibile: false });
    show();
    expect(await screen.findByText(/non sono ancora collegati al servizio vero/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
