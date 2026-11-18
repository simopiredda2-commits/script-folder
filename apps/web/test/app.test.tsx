import { COMPANY_BRAND, PRODUCT_NAME, productMark } from '@mmg/brand';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

/** Risposte finte del servizio: la prova non chiama nulla di vero. */
function fakeService(routes: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      const r = routes[path] ?? { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ME = {
  id: 'u1',
  nome: 'Dott.ssa Medico Inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
};
const TODAY = {
  data: '2026-11-18',
  appuntamenti: [],
  code: {
    daFirmare: 3,
    nonInviate: 0,
    richiesteAperte: 0,
    pianiInScadenza: [],
    giorniAvvisoPiani: 30,
  },
};

describe('interfaccia', () => {
  it('senza sessione mostra l’accesso, con il nome da PRODUCT_NAME e «by SCRIPT»', async () => {
    fakeService({ '/api/io': { status: 401, body: { errore: 'Accesso necessario' } } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Accesso' })).toBeTruthy();
    expect(screen.getAllByText(PRODUCT_NAME).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`by ${COMPANY_BRAND}`).length).toBeGreaterThan(0);
  });

  it('mostra il segno scelto alla prima fermata (proposta B)', async () => {
    fakeService({ '/api/io': { status: 401, body: {} } });
    const { container } = render(<App />);
    await screen.findByRole('heading', { name: 'Accesso' });
    const mark = container.querySelector('svg[data-segno="prodotto"] path');
    expect(mark?.getAttribute('d')).toBe(productMark.paths[0]);
  });

  it('sessione bloccata: chiede il codice a 6 cifre, non la password', async () => {
    fakeService({ '/api/io': { status: 423, body: { errore: 'Sessione bloccata' } } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sessione bloccata' })).toBeTruthy();
    expect(screen.getByLabelText('Codice a 6 cifre')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('dopo l’accesso: menu con simbolo e nome (D67), ricette da firmare contate', async () => {
    fakeService({
      '/api/io': { status: 200, body: ME },
      '/api/oggi': { status: 200, body: TODAY },
    });
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Sezioni' });
    // «Oggi» caricato: la prova non dipende più da chi arriva prima.
    await screen.findByRole('link', { name: /^Ricette da firmare/ });
    for (const label of ['Oggi', 'Pazienti', 'Ricette', 'Farmaci e prestazioni']) {
      // Cercato nel menu: «Oggi» può avere già caricato «Ricette da firmare», un altro collegamento.
      const link = within(nav).getByRole('link', { name: new RegExp(`^${label}`) });
      expect(nav.contains(link)).toBe(true);
      // Il simbolo è decorativo: il nome del collegamento è il testo.
      expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }
    expect(await screen.findByLabelText('3 da firmare')).toBeTruthy();
    expect(screen.getByText('Dott.ssa Medico Inventato')).toBeTruthy();
  });
});
