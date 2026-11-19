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

/** Un utente dell'elenco, come lo dà il servizio; i campi che contano si cambiano nella prova. */
const row = (over: Record<string, unknown>) => ({
  email: null,
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
  inAttesaDiConferma: false,
  richiestaDiConferma: null,
  confermato: null,
  ripristinoDalServizio: false,
  titolareConPazienti: false,
  ...over,
});

const ADMIN_ROLE = [{ codice: 'administrator', nome: 'Amministratore dello studio' }];
const USERS = {
  ruoli: [
    { codice: 'owner_doctor', nome: 'Medico titolare' },
    { codice: 'secretary', nome: 'Segreteria' },
    { codice: 'substitute_doctor', nome: 'Medico sostituto' },
    { codice: 'administrator', nome: 'Amministratore dello studio' },
  ],
  utenti: [
    row({
      id: 'a1',
      nomeUtente: 'amministratore',
      nome: 'Andrea Conti',
      ruoli: ADMIN_ROLE,
      io: true,
    }),
    row({ id: 'a2', nomeUtente: 'amministratore.due', nome: 'Bruna Galli', ruoli: ADMIN_ROLE }),
    row({
      id: 's1',
      nomeUtente: 'segreteria',
      nome: 'Lucia Bassi',
      ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
      ripristinoDalServizio: true,
      confermato: { da: 'Dott.ssa Elena Marchi', il: '2026-11-02T09:00:00Z' },
    }),
    row({
      id: 't1',
      nomeUtente: 'titolare',
      nome: 'Dott.ssa Elena Marchi',
      ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
      ripristinoDalServizio: true,
      titolareConPazienti: true,
      archivio: { id: 'arc1', nome: 'Archivio Marchi' },
    }),
    row({
      id: 'w1',
      nomeUtente: 'nuova.segreteria',
      nome: 'Nuova Segreteria',
      ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
      secondoFattoreAttivo: false,
      passwordDaCambiare: true,
      ripristinoDalServizio: true,
      inAttesaDiConferma: true,
      richiestaDiConferma: { da: 'Andrea Conti', il: '2026-11-19T10:00:00Z' },
    }),
  ],
};

describe('utenti dello studio (tappa 14)', () => {
  it('la password temporanea si vede una volta, con l’istruzione di consegnarla di persona', async () => {
    const calls = fakeService({
      '/api/studio/utenti': () => ({ status: 200, body: USERS }),
      '/api/studio/utenti/a2/password-temporanea': () => ({
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
    const other = rows.find((r) => r.textContent?.includes('Bruna Galli'))!;
    await user.click(
      within(other).getByRole('button', { name: 'Password temporanea per Bruna Galli' }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(/smette di valere/);
    expect(await screen.findByText('Prova-Temporanea')).toBeTruthy();
    expect(screen.getByText(/Consegnala di persona/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Consegnata: nascondi la password' }));
    expect(screen.queryByText('Prova-Temporanea')).toBeNull();
  });

  it('medici e segreteria: niente password temporanea né azzeramento, con il perché; titolare con pazienti non si sospende da qui', async () => {
    fakeService({ '/api/studio/utenti': () => ({ status: 200, body: USERS }) });
    render(<UsersSection />);
    const table = await screen.findByRole('table', { name: 'Utenti dello studio' });
    const rows = within(table).getAllByRole('row');
    // La riga dell'utente: quella che comincia con il suo nome (altre righe possono citarlo).
    const byName = (n: string) =>
      rows.find((r) => r.querySelector('th')?.textContent?.startsWith(n))!;
    for (const n of ['Lucia Bassi', 'Dott.ssa Elena Marchi', 'Nuova Segreteria']) {
      const r = byName(n);
      expect(within(r).queryByRole('button', { name: /Password temporanea/ }), n).toBeNull();
      expect(within(r).queryByRole('button', { name: /Azzera il secondo fattore/ }), n).toBeNull();
      expect(
        within(r).getByText(/li ripristina chi gestisce il servizio, sul server/),
      ).toBeTruthy();
    }
    // L'amministratore senza dati dei pazienti sì.
    expect(
      within(byName('Bruna Galli')).getByRole('button', {
        name: 'Azzera il secondo fattore per Bruna Galli',
      }),
    ).toBeTruthy();
    // Titolare con pazienti: niente «Sospendi», e si dice la strada.
    const owner = byName('Dott.ssa Elena Marchi');
    expect(within(owner).queryByRole('button', { name: /Sospendi/ })).toBeNull();
    expect(within(owner).getByText(/prima il medico esporta i suoi dati/)).toBeTruthy();
    expect(
      within(byName('Lucia Bassi')).getByRole('button', { name: 'Sospendi per Lucia Bassi' }),
    ).toBeTruthy();
    // Lo stato dell'attesa e della conferma, a parole.
    const waiting = byName('Nuova Segreteria');
    expect(within(waiting).getByText('In attesa di conferma di un titolare')).toBeTruthy();
    expect(waiting.textContent).toMatch(/richiesta di Andrea Conti del/);
    expect(byName('Lucia Bassi').textContent).toMatch(/Confermato da Dott\.ssa Elena Marchi il/);
  });

  it('utente nuovo con i dati dei pazienti: nessuna password all’amministratore, e si dice chi la riceve', async () => {
    const created = { ...USERS.utenti[4], id: 'w2', nomeUtente: 'carla.neri', nome: 'Carla Neri' };
    const calls = fakeService({
      '/api/studio/utenti': (method) =>
        method === 'GET'
          ? { status: 200, body: USERS }
          : {
              status: 201,
              body: {
                utente: created,
                avvisi: [
                  'In attesa della conferma di un medico titolare dello studio: finché non è confermato, l’utente non entra.',
                  'La password temporanea la riceve il medico titolare che lo conferma, da consegnare di persona; il secondo fattore si attiva al primo accesso.',
                ],
              },
            },
    });
    const user = userEvent.setup();
    render(<UsersSection />);
    const form = await screen.findByRole('form', { name: 'Nuovo utente' });
    expect(within(form).getByText(/aspettano la conferma di un medico titolare/)).toBeTruthy();
    await user.type(within(form).getByLabelText('Nome utente'), 'carla.neri');
    await user.type(within(form).getByLabelText('Nome mostrato'), 'Carla Neri');
    await user.click(within(form).getByLabelText('Segreteria'));
    await user.click(within(form).getByRole('button', { name: 'Crea l’utente' }));
    expect(await screen.findByText(/la riceve il medico titolare che lo conferma/)).toBeTruthy();
    expect(screen.queryByText(/Consegnala di persona/)).toBeNull();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ ruoli: ['secretary'] });
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
