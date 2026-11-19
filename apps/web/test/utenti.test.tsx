import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { UsersSection } from '../src/pages/admin/UsersSection';

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio finto con stato: la prova non chiama nulla di vero. */
function fakeService(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      const r = routes[path]?.(method, body) ?? { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ME = {
  id: 'u1',
  nome: 'Carla Neri',
  nomeUtente: 'carla.neri',
  ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
  postazione: 'Studio',
  archivio: null,
};
const RULES = { lunghezzaMinima: 12, lunghezzaMassima: 128, obbligato: true };
const TODAY = {
  data: '2026-11-19',
  appuntamenti: [],
  code: {
    daFirmare: 0,
    nonInviate: 0,
    richiesteAperte: 0,
    pianiInScadenza: [],
    giorniAvvisoPiani: 30,
  },
};

describe('password temporanea (tappa 14)', () => {
  it('con la password temporanea c’è solo il cambio della password; dopo, il programma', async () => {
    let mustChange = true;
    const calls = fakeService({
      '/api/io': () => ({ status: 200, body: { ...ME, devoCambiarePassword: mustChange } }),
      '/api/profilo/password': (method) => {
        if (method === 'GET') return { status: 200, body: RULES };
        mustChange = false;
        return { status: 200, body: { stato: 'ok', altreSessioniChiuse: 0 } };
      },
      '/api/oggi': () => ({ status: 200, body: TODAY }),
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Cambia la password' })).toBeTruthy();
    // Nessun menu, nessuna cartella: solo il cambio e l'uscita.
    expect(screen.queryByRole('navigation', { name: 'Sezioni' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Esci' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Nome utente').value).toBe('carla.neri');
    const nuova = screen.getByLabelText<HTMLInputElement>('Nuova password');
    expect(nuova.type).toBe('password');
    // Le lunghezze vengono dal servizio, non dall'interfaccia.
    await waitFor(() => expect(nuova.minLength).toBe(12));
    expect(screen.getByText(/Da 12 a 128 caratteri/)).toBeTruthy();

    // Le due password nuove diverse: lo dice prima di chiamare il servizio.
    await user.type(screen.getByLabelText('Password temporanea ricevuta'), 'Temporanea-1234');
    await user.type(nuova, 'una frase lunga e nuova');
    await user.type(screen.getByLabelText('Ripeti la nuova password'), 'una frase lunga e nova');
    await user.click(screen.getByRole('button', { name: 'Cambia la password' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/non sono uguali/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.clear(screen.getByLabelText('Ripeti la nuova password'));
    await user.type(screen.getByLabelText('Ripeti la nuova password'), 'una frase lunga e nuova');
    await user.click(screen.getByRole('button', { name: 'Cambia la password' }));
    expect(await screen.findByRole('navigation', { name: 'Sezioni' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      passwordAttuale: 'Temporanea-1234',
      nuovaPassword: 'una frase lunga e nuova',
    });
    // Dal menu dell'utente si torna al cambio della password quando si vuole.
    expect(screen.getByRole('link', { name: 'Password' }).getAttribute('href')).toBe(
      '/profilo/password',
    );
  });
});

const USERS = {
  ruoli: [
    { codice: 'owner_doctor', nome: 'Medico titolare' },
    { codice: 'secretary', nome: 'Segreteria' },
    { codice: 'substitute_doctor', nome: 'Medico sostituto' },
    { codice: 'administrator', nome: 'Amministratore dello studio' },
  ],
  utenti: [
    {
      id: 'a1',
      nomeUtente: 'amministratore',
      nome: 'Andrea Conti',
      email: null,
      ruoli: [{ codice: 'administrator', nome: 'Amministratore dello studio' }],
      stato: 'attivo',
      secondoFattoreAttivo: true,
      bloccatoFinoA: null,
      tentativiFalliti: 0,
      passwordDaCambiare: false,
      passwordCambiataIl: null,
      creatoIl: '2026-11-01T08:00:00Z',
      medico: null,
      archivio: null,
      io: true,
    },
    {
      id: 's1',
      nomeUtente: 'segreteria',
      nome: 'Lucia Bassi',
      email: null,
      ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
      stato: 'attivo',
      secondoFattoreAttivo: true,
      bloccatoFinoA: null,
      tentativiFalliti: 0,
      passwordDaCambiare: false,
      passwordCambiataIl: null,
      creatoIl: '2026-11-01T08:00:00Z',
      medico: null,
      archivio: null,
      io: false,
    },
  ],
};

describe('utenti dello studio (tappa 14)', () => {
  it('la password temporanea si vede una volta, con l’istruzione di consegnarla di persona', async () => {
    const calls = fakeService({
      '/api/studio/utenti': () => ({ status: 200, body: USERS }),
      '/api/studio/utenti/s1/password-temporanea': () => ({
        status: 200,
        body: {
          utente: { ...USERS.utenti[1], passwordDaCambiare: true },
          passwordTemporanea: 'Prova-Temporanea',
          sessioniChiuse: 1,
        },
      }),
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<UsersSection />);
    const table = await screen.findByRole('table', { name: 'Utenti dello studio' });
    const rows = within(table).getAllByRole('row');
    // Sulla propria riga nessuna azione sulle credenziali: le fa un altro amministratore.
    const own = rows.find((r) => r.textContent?.includes('Andrea Conti'))!;
    expect(within(own).queryByRole('button', { name: /Password temporanea/ })).toBeNull();
    const other = rows.find((r) => r.textContent?.includes('Lucia Bassi'))!;
    await user.click(
      within(other).getByRole('button', { name: 'Password temporanea per Lucia Bassi' }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(/smette di valere/);
    expect(await screen.findByText('Prova-Temporanea')).toBeTruthy();
    expect(screen.getByText(/Consegnala di persona/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Consegnata: nascondi la password' }));
    expect(screen.queryByText('Prova-Temporanea')).toBeNull();
  });

  it('senza conferma non parte nulla', async () => {
    const calls = fakeService({ '/api/studio/utenti': () => ({ status: 200, body: USERS }) });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    const user = userEvent.setup();
    render(<UsersSection />);
    await user.click(await screen.findByRole('button', { name: 'Sospendi per Lucia Bassi' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
