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
    // Dal menu dell'utente (clic sul nome, in alto a destra: D244) si torna al cambio della
    // password quando si vuole.
    await user.click(document.querySelector<HTMLButtonElement>('.utente-apri')!);
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
  codiciSbagliati: 0,
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
  ultimoTitolare: false,
  confermaDalServizio: false,
  sospesoDalServizio: false,
  ...over,
});

const ADMIN_ROLE = [{ codice: 'administrator', nome: 'Amministratore dello studio' }];
/** Le ASL della regione dello studio, come le dà il servizio (D267): due bastano alla prova. */
const HEALTH_UNITS = {
  regione: 'PIEMONTE',
  elenco: [
    { codice: '203', nome: 'TO3', regione: 'PIEMONTE' },
    { codice: '301', nome: "ASL CITTA' DI TORINO", regione: 'PIEMONTE' },
  ],
  fonte: 'Ministero della Salute, ASL 2026',
};
const USERS = {
  aziendeSanitarie: HEALTH_UNITS,
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

  it('sblocco solo per chi non apre dati dei pazienti; ultimo titolare e titolare con pazienti sospeso senza azioni; conferma dal servizio detta a parole', async () => {
    const OWNER_ROLE = [{ codice: 'owner_doctor', nome: 'Medico titolare' }];
    const SECRETARY_ROLE = [{ codice: 'secretary', nome: 'Segreteria' }];
    fakeService({
      '/api/studio/utenti': () => ({
        status: 200,
        body: {
          aziendeSanitarie: HEALTH_UNITS,
          ruoli: USERS.ruoli,
          utenti: [
            row({
              id: 'a1',
              nomeUtente: 'amministratore',
              nome: 'Andrea Conti',
              ruoli: ADMIN_ROLE,
              io: true,
            }),
            row({
              id: 'a2',
              nomeUtente: 'amministratore.due',
              nome: 'Bruna Galli',
              ruoli: ADMIN_ROLE,
              bloccatoFinoA: '2026-11-19T11:00:00Z',
            }),
            row({
              id: 't1',
              nomeUtente: 'titolare.ultimo',
              nome: 'Dott. Bruno Ultimi',
              ruoli: OWNER_ROLE,
              ripristinoDalServizio: true,
              ultimoTitolare: true,
              bloccatoFinoA: '2026-11-19T11:00:00Z',
            }),
            row({
              id: 't2',
              nomeUtente: 'titolare.sospeso',
              nome: 'Dott. Carlo Sospesi',
              ruoli: OWNER_ROLE,
              stato: 'sospeso',
              ripristinoDalServizio: true,
              titolareConPazienti: true,
            }),
            row({
              id: 's1',
              nomeUtente: 'segreteria.bloccata',
              nome: 'Marta Servi',
              ruoli: SECRETARY_ROLE,
              ripristinoDalServizio: true,
              tentativiFalliti: 2,
              confermato: { da: null, il: '2026-11-18T09:00:00Z' },
            }),
            row({
              id: 'w1',
              nomeUtente: 'primo.titolare',
              nome: 'Dott.ssa Anna Primi',
              ruoli: OWNER_ROLE,
              ripristinoDalServizio: true,
              inAttesaDiConferma: true,
              richiestaDiConferma: { da: 'Andrea Conti', il: '2026-11-19T10:00:00Z' },
              confermaDalServizio: true,
            }),
          ],
        },
      }),
    });
    render(<UsersSection />);
    const table = await screen.findByRole('table', { name: 'Utenti dello studio' });
    const rows = within(table).getAllByRole('row');
    const byName = (n: string) =>
      rows.find((r) => r.querySelector('th')?.textContent?.startsWith(n))!;
    // Sblocco: l'amministratore bloccato sì; medici e segreteria no, con la strada del server.
    expect(
      within(byName('Bruna Galli')).getByRole('button', { name: 'Sblocca per Bruna Galli' }),
    ).toBeTruthy();
    for (const n of ['Dott. Bruno Ultimi', 'Marta Servi']) {
      expect(within(byName(n)).queryByRole('button', { name: /Sblocca/ }), n).toBeNull();
      expect(
        within(byName(n)).getByText(
          /secondo fattore e sblocco: li ripristina chi gestisce il servizio, sul server/,
        ),
      ).toBeTruthy();
    }
    // L'ultimo titolare attivo e confermato non si sospende da qui, e si dice perché.
    const last = byName('Dott. Bruno Ultimi');
    expect(within(last).queryByRole('button', { name: /Sospendi/ })).toBeNull();
    expect(within(last).getByText(/È l’ultimo medico titolare attivo e confermato/)).toBeTruthy();
    // Un titolare con pazienti sospeso non si riattiva da qui.
    const suspended = byName('Dott. Carlo Sospesi');
    expect(within(suspended).queryByRole('button', { name: /Riattiva/ })).toBeNull();
    expect(
      within(suspended).getByText(
        'Ha pazienti nel suo archivio: lo riattiva chi gestisce il servizio, sul server.',
      ),
    ).toBeTruthy();
    // Conferma data, o da dare, da chi gestisce il servizio.
    expect(byName('Marta Servi').textContent).toMatch(/Confermato da chi gestisce il servizio il/);
    expect(
      within(byName('Dott.ssa Anna Primi')).getByText(
        /Nessun medico titolare attivo e confermato può confermarlo: lo conferma chi gestisce il servizio, sul server/,
      ),
    ).toBeTruthy();
    // Nel testo della sezione, anche il primo titolare aspetta la conferma.
    expect(screen.getByText(/anche il primo\s+medico titolare/)).toBeTruthy();
  });

  it('chi è sospeso da chi gestisce il servizio non si riattiva da qui, e si dice perché; le sospensioni dell’amministratore sì', async () => {
    const OWNER_ROLE = [{ codice: 'owner_doctor', nome: 'Medico titolare' }];
    const SECRETARY_ROLE = [{ codice: 'secretary', nome: 'Segreteria' }];
    fakeService({
      '/api/studio/utenti': () => ({
        status: 200,
        body: {
          aziendeSanitarie: HEALTH_UNITS,
          ruoli: USERS.ruoli,
          utenti: [
            row({
              id: 'a1',
              nomeUtente: 'amministratore',
              nome: 'Andrea Conti',
              ruoli: ADMIN_ROLE,
              io: true,
            }),
            row({
              id: 's2',
              nomeUtente: 'segreteria.server',
              nome: 'Rita Serveri',
              ruoli: SECRETARY_ROLE,
              stato: 'sospeso',
              ripristinoDalServizio: true,
              sospesoDalServizio: true,
            }),
            row({
              id: 's3',
              nomeUtente: 'segreteria.sospesa',
              nome: 'Gina Sospesi',
              ruoli: SECRETARY_ROLE,
              stato: 'sospeso',
              ripristinoDalServizio: true,
            }),
            row({
              id: 't2',
              nomeUtente: 'titolare.server',
              nome: 'Dott. Carlo Serveri',
              ruoli: OWNER_ROLE,
              stato: 'sospeso',
              ripristinoDalServizio: true,
              titolareConPazienti: true,
              sospesoDalServizio: true,
            }),
          ],
        },
      }),
    });
    render(<UsersSection />);
    const table = await screen.findByRole('table', { name: 'Utenti dello studio' });
    const rows = within(table).getAllByRole('row');
    const byName = (n: string) =>
      rows.find((r) => r.querySelector('th')?.textContent?.startsWith(n))!;
    const SERVICE = /L’ha sospeso chi gestisce il servizio, sul server: lo riattiva solo lui/;
    // Sospesa dal server: niente «Riattiva», lo stato e il perché.
    const byServer = byName('Rita Serveri');
    expect(within(byServer).queryByRole('button', { name: /Riattiva/ })).toBeNull();
    expect(within(byServer).getByText(/Sospeso da chi gestisce il servizio/)).toBeTruthy();
    expect(within(byServer).getByText(SERVICE)).toBeTruthy();
    // Sospesa dall'amministratore: si riattiva da qui.
    const byAdmin = byName('Gina Sospesi');
    expect(within(byAdmin).getByRole('button', { name: 'Riattiva per Gina Sospesi' })).toBeTruthy();
    expect(within(byAdmin).queryByText(SERVICE)).toBeNull();
    // Titolare con pazienti sospeso dal server: un solo motivo, quello del server.
    const owner = byName('Dott. Carlo Serveri');
    expect(within(owner).queryByRole('button', { name: /Riattiva/ })).toBeNull();
    expect(within(owner).getByText(SERVICE)).toBeTruthy();
    expect(within(owner).queryByText(/Ha pazienti nel suo archivio: lo riattiva/)).toBeNull();
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

  it('medico nuovo: il codice ASL si sceglie fra le ASL della regione dello studio e va al servizio (D267)', async () => {
    const created = { ...USERS.utenti[4], id: 'w3', nomeUtente: 'elena.marchi', nome: 'Elena' };
    const calls = fakeService({
      '/api/studio/utenti': (method) =>
        method === 'GET'
          ? { status: 200, body: USERS }
          : { status: 201, body: { utente: created, avvisi: [] } },
    });
    const user = userEvent.setup();
    render(<UsersSection />);
    const form = await screen.findByRole('form', { name: 'Nuovo utente' });
    await user.type(within(form).getByLabelText('Nome utente'), 'elena.marchi');
    await user.type(within(form).getByLabelText('Nome mostrato'), 'Dott.ssa Elena Marchi');
    await user.click(within(form).getByLabelText('Medico titolare'));
    await user.type(within(form).getByLabelText('Nome'), 'Elena');
    await user.type(within(form).getByLabelText('Cognome'), 'Marchi');
    await user.type(within(form).getByLabelText('Codice fiscale'), 'MRCLNE70A41X001X');
    const asl = within(form).getByLabelText('Codice ASL per la Regione');
    expect(
      within(asl)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Da completare', '203 – TO3', "301 – ASL CITTA' DI TORINO"]);
    expect(asl.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(form).getByText(/fra le ASL della regione PIEMONTE/)).toBeTruthy();
    await user.selectOptions(asl, '301');
    await user.click(within(form).getByRole('button', { name: 'Crea l’utente' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      medico: { codiceAsl: '301', codiceFiscale: 'MRCLNE70A41X001X' },
    });
  });
});
