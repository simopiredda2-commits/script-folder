import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { ConfirmUsersSection } from '../src/pages/admin/ConfirmUsersSection';
import { StudioToolsPage } from '../src/pages/StudioToolsPage';

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

/** Un utente in attesa, come lo dà il servizio ai titolari; dati inventati. */
const pending = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  nomeUtente: 'nuova.segreteria',
  nome: 'Nuova Segreteria',
  email: null,
  ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
  stato: 'attivo',
  inAttesaDiConferma: true,
  creatoIl: '2026-11-19T09:00:00.000Z',
  richiesta: { da: 'Andrea Conti', il: '2026-11-19T09:00:00.000Z' },
  passwordAllaConferma: true,
  medico: null,
  ...over,
});

const rowOf = (table: HTMLElement, name: string) =>
  within(table)
    .getAllByRole('row')
    .find((r) => r.querySelector('th')?.textContent?.startsWith(name))!;

describe('Strumenti › Utenti da confermare (tappa 14)', () => {
  it('il titolare conferma la richiesta che legge e riceve la password temporanea, una volta', async () => {
    let list = [
      pending(),
      pending({
        id: 'w2',
        nomeUtente: 'giulia.rossi',
        nome: 'Dott.ssa Giulia Rossi',
        ruoli: [{ codice: 'substitute_doctor', nome: 'Medico sostituto' }],
        passwordAllaConferma: false,
        medico: { nome: 'Giulia', cognome: 'Rossi', codiceFiscale: 'RSSGLI75E45X001P' },
        // Riattivata da chi gestisce il servizio: la richiesta non ha il nome di un utente.
        richiesta: { da: null, il: '2026-11-19T09:30:00.000Z' },
      }),
    ];
    const calls = fakeService({
      '/api/studio/utenti/da-confermare': () => ({ status: 200, body: { utenti: list } }),
      '/api/studio/utenti/w1/conferma': () => {
        const confirmed = list[0]!;
        list = list.slice(1);
        return {
          status: 200,
          body: {
            utente: { ...confirmed, inAttesaDiConferma: false },
            passwordTemporanea: 'Prova-Conferma',
            avvisi: [
              'Utente confermato. Consegna di persona la password temporanea: al primo accesso l’utente attiva il secondo fattore e sceglie la sua password.',
            ],
          },
        };
      },
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<ConfirmUsersSection />);
    const table = await screen.findByRole('table', {
      name: 'Utenti in attesa della conferma di un medico titolare',
    });
    const first = rowOf(table, 'Nuova Segreteria');
    expect(first.textContent).toMatch(/Di Andrea Conti, il/);
    expect(first.textContent).toMatch(/Utente creato il/);
    expect(first.textContent).toMatch(/Ricevi la password temporanea, da consegnare di persona/);
    const second = rowOf(table, 'Dott.ssa Giulia Rossi');
    expect(second.textContent).toMatch(/Rientra con la sua password e il suo secondo fattore/);
    expect(second.textContent).toContain('RSSGLI75E45X001P');
    expect(second.textContent).toMatch(/Da chi gestisce il servizio, il/);

    await user.click(within(first).getByRole('button', { name: 'Conferma Nuova Segreteria' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(
      /con i ruoli: Segreteria\?.*Riceverai una password temporanea/,
    );
    expect(await screen.findByText('Prova-Conferma')).toBeTruthy();
    expect(screen.getByText(/Consegnala di persona/)).toBeTruthy();
    expect(screen.getByText(/^Utente confermato\. Consegna di persona/)).toBeTruthy();
    // Si conferma la richiesta letta: la sua data va al servizio.
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/studio/utenti/w1/conferma',
      body: { richiestaIl: '2026-11-19T09:00:00.000Z' },
    });
    // L'elenco si rilegge: la segreteria confermata non c'è più, la password resta da consegnare.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Conferma Nuova Segreteria' })).toBeNull(),
    );
    expect(screen.getByText('Prova-Conferma')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Consegnata: nascondi la password' }));
    expect(screen.queryByText('Prova-Conferma')).toBeNull();
  });

  it('senza conferma non parte nulla; il rifiuto del servizio e quello del titolare si leggono', async () => {
    const calls = fakeService({
      '/api/studio/utenti/da-confermare': () => ({ status: 200, body: { utenti: [pending()] } }),
      '/api/studio/utenti/w1/conferma': () => ({
        status: 409,
        body: {
          errore:
            'La richiesta è cambiata dopo che l’hai letta: controlla di nuovo i dati dell’utente e conferma',
        },
      }),
      '/api/studio/utenti/w1/rifiuta': () => ({
        status: 200,
        body: {
          utente: { ...pending(), stato: 'sospeso' },
          sessioniChiuse: 0,
          avvisi: [
            'Utente rifiutato: resta sospeso e non entra. Se l’amministratore lo riattiva, torna in questo elenco con una richiesta nuova.',
          ],
        },
      }),
    });
    const answers = [false, true, true];
    const confirm = vi.fn(() => answers.shift() ?? false);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<ConfirmUsersSection />);
    await user.click(await screen.findByRole('button', { name: 'Rifiuta Nuova Segreteria' }));
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(/Resta sospeso e non entra/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Conferma Nuova Segreteria' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/La richiesta è cambiata/);
    await user.click(screen.getByRole('button', { name: 'Rifiuta Nuova Segreteria' }));
    expect(await screen.findByText(/^Utente rifiutato: resta sospeso/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/studio/utenti/w1/conferma',
      '/api/studio/utenti/w1/rifiuta',
    ]);
  });

  it('segreteria sul mio archivio: la confermo per il mio, poi la posso togliere (D181)', async () => {
    let decision: 'da' | 'sul' | 'no' = 'da';
    const sec = {
      id: 's1',
      nomeUtente: 'lucia.bassi',
      nome: 'Lucia Bassi',
      ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
      archivio: { id: 'arc2', nome: 'Archivio Serra' },
    };
    const calls = fakeService({
      '/api/studio/utenti/da-confermare': () => ({
        status: 200,
        body: {
          utenti: [],
          perArchivio: decision === 'da' ? [sec] : [],
          sulMioArchivio: decision === 'sul' ? [sec] : [],
        },
      }),
      '/api/studio/utenti/s1/archivio/conferma': () => {
        decision = 'sul';
        return {
          status: 200,
          body: { avvisi: ['Confermata per il tuo archivio: da adesso la segreteria lo vede.'] },
        };
      },
      '/api/studio/utenti/s1/archivio/rifiuta': () => {
        decision = 'no';
        return {
          status: 200,
          body: {
            avvisi: [
              'Tolta dal tuo archivio: da adesso la segreteria non lo vede. Gli altri archivi non cambiano.',
            ],
          },
        };
      },
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<ConfirmUsersSection />);
    expect(await screen.findByText('Nessun utente da confermare.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Segreteria sul tuo archivio' })).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Conferma per il mio archivio Lucia Bassi' }),
    );
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toMatch(
      /per il tuo archivio «Archivio Serra»\? Vedrà i tuoi pazienti come segreteria/,
    );
    await screen.findByText('Confermata per il tuo archivio: da adesso la segreteria lo vede.');
    const remove = await screen.findByRole('button', {
      name: 'Togli dal mio archivio Lucia Bassi',
    });
    expect(screen.getByText(/lavora sul tuo archivio/)).toBeTruthy();
    await user.click(remove);
    await screen.findByText(/^Tolta dal tuo archivio/);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/studio/utenti/s1/archivio/conferma',
      '/api/studio/utenti/s1/archivio/rifiuta',
    ]);
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Segreteria sul tuo archivio' })).toBeNull(),
    );
  });

  it('nessuno in attesa: lo dice, senza tabella', async () => {
    fakeService({
      '/api/studio/utenti/da-confermare': () => ({ status: 200, body: { utenti: [] } }),
    });
    render(<ConfirmUsersSection />);
    expect(await screen.findByText('Nessun utente da confermare.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('la scheda è solo dei medici titolari', async () => {
    const cases: [string[], boolean][] = [
      [['owner_doctor'], true],
      [['owner_doctor', 'administrator'], true],
      [['administrator'], false],
      [['substitute_doctor'], false],
    ];
    for (const [roles, visible] of cases) {
      fakeService({
        '/api/io': () => ({
          status: 200,
          body: {
            id: 'u1',
            nome: 'Utente di prova',
            ruoli: roles.map((codice) => ({ codice, nome: codice })),
            postazione: 'Studio',
            archivio: null,
          },
        }),
        '/api/studio/utenti/da-confermare': () => ({ status: 200, body: { utenti: [] } }),
      });
      render(
        <SessionProvider>
          <MemoryRouter initialEntries={['/strumenti?sezione=conferme']}>
            <StudioToolsPage />
          </MemoryRouter>
        </SessionProvider>,
      );
      const tabs = await screen.findByRole('group', { name: 'Sezione degli strumenti' });
      const tab = within(tabs).queryByRole('button', { name: 'Utenti da confermare' });
      expect(tab !== null, roles.join('+')).toBe(visible);
      if (visible) {
        expect(tab!.getAttribute('aria-pressed')).toBe('true');
        expect(await screen.findByText('Nessun utente da confermare.')).toBeTruthy();
      }
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
