import { COMPANY_BRAND, PRODUCT_NAME, productMark } from '@mmg/brand';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('la postazione si ricorda in questo browser dopo una password giusta, non prima (D178)', async () => {
    localStorage.clear();
    const login = async (status: number, body: unknown) => {
      fakeService({
        '/api/io': { status: 401, body: {} },
        '/api/accesso': { status, body },
      });
      render(<App />);
      const user = userEvent.setup();
      const ws = await screen.findByLabelText<HTMLInputElement>('Postazione');
      const proposed = ws.value;
      await user.clear(ws);
      await user.type(ws, 'Ambulatorio 2');
      await user.type(screen.getByLabelText('Nome utente'), 'medico.inventato');
      await user.type(screen.getByLabelText('Password'), 'password-di-prova');
      await user.click(screen.getByRole('button', { name: 'Continua' }));
      return proposed;
    };
    // Password sbagliata: la postazione non si ricorda.
    expect(await login(400, { errore: 'Nome utente o password non validi' })).toBe('Studio');
    await screen.findByText(/non validi/);
    expect(localStorage.getItem('postazione')).toBeNull();
    cleanup();
    // Password giusta: si ricorda, e al prossimo accesso è proposta.
    await login(200, { passo: 'codice', passaggio: 'passaggio-di-prova' });
    await screen.findByLabelText('Codice a 6 cifre');
    expect(localStorage.getItem('postazione')).toBe('Ambulatorio 2');
    cleanup();
    expect(await login(400, { errore: 'Nome utente o password non validi' })).toBe('Ambulatorio 2');
    localStorage.clear();
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
