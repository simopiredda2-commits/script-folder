import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { documentTypeLabel } from '../src/pages/FseAccessPage';

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const [path = ''] = url.split('?');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = routes[path];
      const r = handler ? handler(method, body) : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(
        new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

const ok = (body: unknown) => () => ({ status: 200, body });

const me = (role: 'owner_doctor' | 'secretary') => ({
  id: 'u1',
  nome: role === 'owner_doctor' ? 'Dott.ssa Titolare Inventata' : 'Segreteria Inventata',
  ruoli: [{ codice: role, nome: role }],
  postazione: 'Studio',
  archivio: role === 'owner_doctor' ? { id: 'a1', nome: 'Archivio di prova' } : null,
});

const PATIENT = {
  paziente: {
    id: 'p1',
    firstName: 'Lina',
    lastName: 'Rota',
    sex: 'F',
    birthDate: '1950-01-01',
    birthPlaceName: null,
    fiscalCode: 'RTOLNI50A41X000A',
    phone: null,
    email: null,
    asl: null,
    status: 'active',
    deceasedOn: null,
  },
  riepilogo: null,
};

const INFO = (over: Record<string, unknown> = {}) => ({
  tipiDocumento: [
    { codice: '57833-6', nome: 'PRESCRIZIONE FARMACEUTICA' },
    { codice: '11502-2', nome: 'REFERTO DI LABORATORIO' },
  ],
  simulato: true,
  attivo: true,
  ...over,
});

const TOKEN_URL = '/api/simulatori/fascicolo?token=00000000-0000-4000-8000-000000000001';

/** Una scheda nuova finta, come la restituisce window.open. */
function fakeTab() {
  return {
    opener: {} as unknown,
    document: { title: '', body: { textContent: '' } },
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

const start = () => {
  window.history.pushState({}, '', '/pazienti/p1/fascicolo-regionale');
  render(<App />);
};

describe('Fascicolo regionale dalla cartella (D220)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
    window.sessionStorage.clear();
  });

  it('il medico lo apre in una scheda nuova, senza legame con la cartella', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/fascicolo-regionale': ok(INFO()),
      '/api/pazienti/p1/fascicolo-regionale': ok({ indirizzo: TOKEN_URL, simulato: true }),
    });
    const user = userEvent.setup();
    start();
    // Con il simulatore la pagina lo dice: non è il Fascicolo vero.
    expect(await screen.findByText(/Collegamento simulato/)).toBeTruthy();
    const select = screen.getByLabelText('Documenti da mostrare');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Tutti i documenti', 'Prescrizione farmaceutica', 'Referto di laboratorio']);
    await user.click(screen.getByRole('button', { name: 'Apri il Fascicolo' }));
    await screen.findByText('Fascicolo aperto in una scheda nuova.');
    // La scheda si prepara al clic, poi riceve l'indirizzo; la pagina regionale non vede la cartella.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledWith(
      new URL(TOKEN_URL, window.location.href).href,
    );
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/pazienti/p1/fascicolo-regionale',
        body: { tipoDocumento: null },
      },
    ]);
  });

  it('con il filtro dei documenti; se il browser blocca la scheda resta il collegamento', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/fascicolo-regionale': ok(INFO()),
      '/api/pazienti/p1/fascicolo-regionale': ok({ indirizzo: TOKEN_URL, simulato: true }),
    });
    const user = userEvent.setup();
    start();
    await user.selectOptions(
      await screen.findByLabelText('Documenti da mostrare'),
      'Referto di laboratorio',
    );
    await user.click(screen.getByRole('button', { name: 'Apri il Fascicolo' }));
    const link = await screen.findByRole('link', { name: 'Apri il Fascicolo' });
    expect(link.getAttribute('href')).toBe(new URL(TOKEN_URL, window.location.href).href);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/Il browser non ha aperto la scheda nuova/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ tipoDocumento: '11502-2' });
  });

  it('credenziali rifiutate: la scheda preparata si chiude e la pagina porta alle credenziali', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/fascicolo-regionale': ok(INFO()),
      '/api/pazienti/p1/fascicolo-regionale': () => ({
        status: 422,
        body: {
          errore:
            'Errore di autenticazione (AUTH_ER_501). Controlla utente, password e PIN RUPAR in «Credenziali dei servizi».',
          dettagli: {
            codice: 'CREDENZIALI_RIFIUTATE',
            servizio: 'rupar',
            codiceFascicolo: 'AUTH_ER_501',
          },
        },
      }),
    });
    const user = userEvent.setup();
    start();
    await user.click(await screen.findByRole('button', { name: 'Apri il Fascicolo' }));
    const alert = await screen.findByText(/AUTH_ER_501/);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    const link = within(alert.closest('.messaggio')!).getByRole('link', {
      name: 'Apri «Credenziali dei servizi»',
    });
    expect(link.getAttribute('href')).toBe('/profilo/credenziali');
    expect(screen.queryByText('Fascicolo aperto in una scheda nuova.')).toBeNull();
  });

  it('collegamento non attivo: il pulsante è spento e la pagina dice perché', async () => {
    const open = vi.spyOn(window, 'open');
    stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/fascicolo-regionale': ok(INFO({ attivo: false })),
    });
    start();
    expect(await screen.findByText(/non è ancora attivo: si attiva con il CSI/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Apri il Fascicolo' }).disabled,
    ).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('la segreteria non lo apre: lo dice la pagina, e la cartella non mostra il collegamento', async () => {
    const calls = stubFetch({
      '/api/io': ok(me('secretary')),
      '/api/pazienti/p1': ok(PATIENT),
    });
    start();
    expect(await screen.findByText(/lo apre il medico, con le sue credenziali/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apri il Fascicolo' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/pazienti/p1')).toBe(true));
    expect(calls.some((c) => c.path === '/api/fascicolo-regionale')).toBe(false);
  });

  it('nella cartella il collegamento c’è per il medico, non per la segreteria', async () => {
    for (const role of ['owner_doctor', 'secretary'] as const) {
      stubFetch({
        '/api/io': ok(me(role)),
        '/api/pazienti/p1': ok(PATIENT),
        '/api/pazienti/p1/terapie': ok({ terapie: [] }),
        '/api/pazienti/p1/prestazioni-prescritte': ok({ prestazioni: [] }),
        '/api/pazienti/p1/cronologia': ok({ cronologia: [] }),
      });
      window.history.pushState({}, '', '/pazienti/p1');
      render(<App />);
      const nav = await screen.findByRole('navigation', { name: 'Sezioni della cartella' });
      const link = within(nav).queryByRole('link', { name: 'Fascicolo regionale' });
      if (role === 'owner_doctor')
        expect(link?.getAttribute('href')).toBe('/pazienti/p1/fascicolo-regionale');
      else expect(link).toBeNull();
      cleanup();
      vi.unstubAllGlobals();
      window.sessionStorage.clear();
    }
  });

  it('i nomi delle specifiche si scrivono come una frase', () => {
    expect(documentTypeLabel('PROFILO SANITARIO SINTETICO / PATIENT SUMMARY')).toBe(
      'Profilo sanitario sintetico / patient summary',
    );
    expect(documentTypeLabel('ATTESTATO DI ESENZIONE')).toBe('Attestato di esenzione');
  });
});
