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
  window.history.pushState({}, '', '/');
});

/** Codici fiscali inventati, con la X come luogo di nascita (D12). */
const OLD_CF = 'SRRPLA71B02X101K';
const NEW_CF = 'SRRPLA71B02X101Z';
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

describe('codice fiscale corretto dall’amministratore (tappa 16, D181)', () => {
  it('il medico vede l’avviso, apre la pagina e conferma la correzione che ha davanti', async () => {
    let pending = true;
    const contacts = () => ({
      nome: 'Paolo',
      cognome: 'Serra',
      telefono: '000 0000001',
      email: '',
      pec: '',
      mancaPerIlProfilo: [],
      codiceFiscale: pending ? OLD_CF : NEW_CF,
      correzioneCodiceFiscale: pending
        ? { proposto: NEW_CF, da: 'Andrea Conti', il: '2026-11-19T09:00:00.000Z' }
        : null,
    });
    const calls = fakeService({
      '/api/io': () => ({
        status: 200,
        body: {
          id: 'd1',
          nome: 'Dott. Paolo Serra',
          nomeUtente: 'paolo.serra',
          ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
          postazione: 'Studio',
          archivio: null,
          codiceFiscaleDaConfermare: pending,
        },
      }),
      '/api/oggi': () => ({ status: 200, body: TODAY }),
      '/api/profilo/recapiti': () => ({ status: 200, body: contacts() }),
      '/api/profilo/codice-fiscale/conferma': () => {
        pending = false;
        return {
          status: 200,
          body: {
            avvisi: ['Codice fiscale aggiornato: da adesso è questo, anche per i servizi.'],
            ...contacts(),
          },
        };
      },
    });
    render(<App />);
    const banner = await screen.findByText(/L’amministratore ha corretto il tuo codice fiscale/);
    await userEvent.click(within(banner).getByRole('link', { name: 'Controlla e conferma' }));
    await screen.findByRole('heading', { name: 'Codice fiscale' });
    // Sulla sua pagina l'avviso della cornice non si ripete: c'è la correzione con i due codici.
    expect(screen.queryByText(/L’amministratore ha corretto il tuo codice fiscale/)).toBeNull();
    expect(screen.getByText(OLD_CF)).toBeTruthy();
    expect(screen.getByText(NEW_CF)).toBeTruthy();
    expect(screen.getByText(/Andrea Conti ha corretto il tuo codice fiscale/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'È giusto: lo confermo' }));
    await screen.findByText('Codice fiscale aggiornato: da adesso è questo, anche per i servizi.');
    expect(calls.find((c) => c.path === '/api/profilo/codice-fiscale/conferma')?.body).toEqual({
      proposto: NEW_CF,
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'È giusto: lo confermo' })).toBeNull(),
    );
  });

  it('l’amministratore vede la correzione in attesa e la può ritirare, con la conferma', async () => {
    const doctor = {
      id: 'd1',
      nomeUtente: 'paolo.serra',
      nome: 'Dott. Paolo Serra',
      email: null,
      ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
      stato: 'attivo',
      secondoFattoreAttivo: true,
      bloccatoFinoA: null,
      tentativiFalliti: 0,
      codiciSbagliati: 0,
      passwordDaCambiare: false,
      passwordCambiataIl: null,
      creatoIl: '2026-11-01T08:00:00Z',
      medico: {
        codiceFiscale: OLD_CF,
        codiceRegionale: null,
        asl: null,
        nome: 'Paolo',
        cognome: 'Serra',
        correzioneCodiceFiscale: {
          proposto: NEW_CF,
          da: 'Andrea Conti',
          il: '2026-11-19T09:00:00Z',
        },
      },
      archivio: { id: 'arc1', nome: 'Archivio di Paolo Serra' },
      io: false,
      inAttesaDiConferma: false,
      richiestaDiConferma: null,
      confermato: null,
      ripristinoDalServizio: true,
      titolareConPazienti: false,
      ultimoTitolare: false,
      confermaDalServizio: false,
      sospesoDalServizio: false,
    };
    const calls = fakeService({
      '/api/studio/utenti': () => ({ status: 200, body: { ruoli: [], utenti: [doctor] } }),
      '/api/studio/utenti/d1/codice-fiscale/ritira': () => ({
        status: 200,
        body: {
          utente: { ...doctor, medico: { ...doctor.medico, correzioneCodiceFiscale: null } },
        },
      }),
    });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    render(<UsersSection />);
    const table = await screen.findByRole('table', { name: 'Utenti dello studio' });
    expect(within(table).getByText(/Correzione in attesa del medico:/)).toBeTruthy();
    expect(within(table).getByText(NEW_CF)).toBeTruthy();
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Ritira la correzione del codice fiscale per Dott. Paolo Serra',
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      'Ritirare la correzione del codice fiscale di Dott. Paolo Serra? Resta il codice di adesso; il medico non avrà più niente da confermare.',
    );
    await screen.findByText(
      'Correzione del codice fiscale ritirata: per Dott. Paolo Serra resta il codice di prima.',
    );
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.path === '/api/studio/utenti/d1/codice-fiscale/ritira',
      ),
    ).toBe(true);
  });
});
