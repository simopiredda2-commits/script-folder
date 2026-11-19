import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceSection } from '../src/pages/admin/ServiceSection';
import { StudioSection } from '../src/pages/admin/StudioSection';
import { WorkstationsPanel } from '../src/pages/admin/WorkstationsPanel';

const limits = {
  idleLockMinutes: { min: 1, max: 30 },
  maxFailedLogins: { min: 3, max: 10 },
  failedLoginLockMinutes: { min: 5, max: 60 },
  sendTimeoutSeconds: { min: 1, max: 60 },
  alertDailyRecords: { min: 1, max: 10000 },
  alertAftDaily: { min: 1, max: 1000 },
  hour: { min: 0, max: 23 },
  headerLines: 6,
  headerLineLength: 100,
};

/** Dati dello studio inventati, come li dà il servizio. */
const studio = (over: Record<string, unknown> = {}) => ({
  dati: {
    nome: 'Studio di prova',
    tipo: 'single',
    regione: null as string | null,
    indirizzo: 'Via di Prova 1',
    cap: '10100',
    comune: 'Comune di prova',
    provincia: 'TO',
    telefono: null,
    email: null,
    pec: null,
  },
  tipi: [
    { codice: 'single', nome: 'Medico singolo' },
    { codice: 'group', nome: 'Medicina di gruppo' },
  ],
  indirizzoCompleto: 'Via di Prova 1, 10100 Comune di prova (TO)',
  intestazione: [],
  sicurezza: { minutiInattivita: 5, tentativiFalliti: 5, minutiBlocco: 15 },
  invii: { secondiAttesa: 8, avviso: null },
  avvisi: {
    cartelleAlGiorno: null,
    fasciaDalle: null,
    fasciaAlle: null,
    consultazioniAftAlGiorno: null,
    daCompletare: [
      'Cartelle diverse aperte da un utente in un giorno',
      'Fascia oraria degli accessi',
      'Consultazioni dell’AFT di un collega in un giorno',
    ],
    fonte: 'Garante, linee guida sul dossier sanitario, par. 7, lett. c',
  },
  daCompletare: ['Regione: va nell’intestazione del promemoria'],
  limiti: limits,
  puoModificare: false,
  puoModificareIntestazione: false,
  ...over,
});

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = routes[path];
      const r = handler ? handler(method, body) : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

describe('Strumenti › Dati dello studio, postazioni e stato del servizio (tappa 14)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('chi non è amministratore legge soltanto, e vede subito che manca la regione', async () => {
    stubFetch({ '/api/studio': () => ({ status: 200, body: studio() }) });
    render(<StudioSection />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Manca la regione dello studio: nessuna ricetta SSN/);
    expect(alert.textContent).toMatch(/La inserisce l’amministratore dello studio/);
    expect(screen.getByLabelText<HTMLInputElement>('Nome dello studio').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Tipo di studio').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Salva/ })).toBeNull();
    // Le soglie vuote: avvisi spenti, da completare.
    expect(screen.getByText(/Finché una soglia è vuota, quell’avviso è spento/)).toBeTruthy();
  });

  it('l’amministratore salva: un gruppo per riquadro, vuoti come vuoti, righe dell’intestazione pulite', async () => {
    const saved: unknown[] = [];
    let current = studio({ puoModificare: true, puoModificareIntestazione: true });
    const calls = stubFetch({
      '/api/studio': (method, body) => {
        if (method === 'PUT') {
          saved.push(body);
          current = {
            ...current,
            dati: { ...current.dati, regione: 'PIEMONTE' },
            daCompletare: [],
          };
        }
        return { status: 200, body: current };
      },
    });
    const user = userEvent.setup();
    render(<StudioSection />);
    await user.type(await screen.findByLabelText('Regione'), 'PIEMONTE');
    await user.type(
      screen.getByLabelText('Intestazione dello studio'),
      'Studio di prova{enter}{enter}  Via di Prova 1  ',
    );
    await user.selectOptions(screen.getByLabelText('Dalle ore'), '22');
    await user.click(screen.getByRole('button', { name: 'Salva i dati dello studio' }));
    await screen.findByText('Dati e impostazioni dello studio salvati.');
    expect(saved).toEqual([
      {
        dati: {
          nome: 'Studio di prova',
          tipo: 'single',
          regione: 'PIEMONTE',
          indirizzo: 'Via di Prova 1',
          cap: '10100',
          comune: 'Comune di prova',
          provincia: 'TO',
          telefono: null,
          email: null,
          pec: null,
        },
        sicurezza: { minutiInattivita: 5, tentativiFalliti: 5, minutiBlocco: 15 },
        invii: { secondiAttesa: 8 },
        avvisi: {
          cartelleAlGiorno: null,
          fasciaDalle: 22,
          fasciaAlle: null,
          consultazioniAftAlGiorno: null,
        },
        intestazione: ['Studio di prova', 'Via di Prova 1'],
      },
    ]);
    // Dopo il salvataggio il modulo si rifà con i dati del servizio: l'avviso della regione sparisce.
    await waitFor(() => expect(screen.queryByText(/Manca la regione dello studio/)).toBeNull());
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('i problemi trovati dal servizio si vedono tutti, in un elenco', async () => {
    const calls = stubFetch({
      '/api/studio': (method) =>
        method === 'PUT'
          ? {
              status: 400,
              body: {
                errore: 'CAP: 5 cifre. Provincia: la sigla di 2 lettere',
                dettagli: { problemi: ['CAP: 5 cifre', 'Provincia: la sigla di 2 lettere'] },
              },
            }
          : { status: 200, body: studio({ puoModificare: true, puoModificareIntestazione: true }) },
    });
    const user = userEvent.setup();
    render(<StudioSection />);
    // Senza la regione il browser non manda nemmeno il modulo: il campo è obbligatorio.
    await user.click(await screen.findByRole('button', { name: 'Salva i dati dello studio' }));
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    await user.type(screen.getByLabelText('Regione'), 'PIEMONTE');
    await user.click(screen.getByRole('button', { name: 'Salva i dati dello studio' }));
    // L'elenco arriva dopo la risposta del servizio; in cima c'è già l'avviso della regione.
    const list = (await screen.findByText('Da correggere:')).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['CAP: 5 cifre.', 'Provincia: la sigla di 2 lettere.']);
  });

  it('postazioni: l’amministratore aggiunge, il nome doppio è detto in chiaro', async () => {
    const list = { postazioni: [] as unknown[], archiviate: [], puoModificare: true };
    stubFetch({
      '/api/studio/postazioni': (method, body) => {
        if (method === 'POST') {
          const b = body as { nome: string };
          if (b.nome.toLowerCase() === 'ambulatorio 1' && list.postazioni.length)
            return {
              status: 409,
              body: { errore: 'C’è già una postazione attiva che si chiama «Ambulatorio 1»' },
            };
          list.postazioni.push({
            id: 'p1',
            nome: b.nome,
            condivisa: true,
            note: null,
            creataIl: '2026-11-19T08:00:00.000Z',
            archiviataIl: null,
          });
          return { status: 201, body: list.postazioni.at(-1) };
        }
        return { status: 200, body: list };
      },
    });
    const user = userEvent.setup();
    render(<WorkstationsPanel />);
    await user.type(await screen.findByLabelText('Nome della postazione'), 'Ambulatorio 1');
    await user.click(screen.getByRole('button', { name: 'Aggiungi la postazione' }));
    await screen.findByText('Postazione «Ambulatorio 1» aggiunta.');
    const table = await screen.findByRole('table', { name: 'Postazioni attive' });
    expect(within(table).getByText('Ambulatorio 1')).toBeTruthy();
    expect(
      within(table).getByRole('button', { name: 'Archivia la postazione «Ambulatorio 1»' }),
    ).toBeTruthy();
    await user.type(screen.getByLabelText('Nome della postazione'), 'Ambulatorio 1');
    await user.click(screen.getByRole('button', { name: 'Aggiungi la postazione' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/C’è già una postazione attiva/);
  });

  it('postazioni: chi non è amministratore le vede soltanto', async () => {
    stubFetch({
      '/api/studio/postazioni': () => ({
        status: 200,
        body: {
          postazioni: [
            {
              id: 'p1',
              nome: 'Segreteria',
              condivisa: true,
              note: 'Stampante del bancone',
              creataIl: '2026-11-19T08:00:00.000Z',
              archiviataIl: null,
            },
          ],
          archiviate: [],
          puoModificare: false,
        },
      }),
    });
    render(<WorkstationsPanel />);
    const table = await screen.findByRole('table', { name: 'Postazioni attive' });
    expect(within(table).getByText('Stampante del bancone')).toBeTruthy();
    expect(screen.queryByLabelText('Nome della postazione')).toBeNull();
    expect(screen.queryByRole('button', { name: /Archivia/ })).toBeNull();
    expect(
      screen.getByText('Le postazioni le gestisce l’amministratore dello studio.'),
    ).toBeTruthy();
  });

  it('stato del servizio: collegamenti simulati, sessione, banche dati e salvataggi, in sola lettura', async () => {
    stubFetch({
      '/api/studio/servizio': () => ({
        status: 200,
        body: {
          collegamenti: [
            {
              codice: 'sar',
              nome: 'SAR Piemonte',
              uso: 'Ricette SSN: farmaci e specialistica',
              ambiente: 'simulatore',
              ultimoUso: {
                quando: '2026-11-19T08:00:00.000Z',
                ambiente: 'simulatore',
                operazione: 'invio',
                esito: 'accettato',
              },
            },
          ],
          sessione: { durataMassimaOre: 12, minutiInattivita: 5 },
          bancheDati: { configurato: false, ora: null, prossimoGiro: null },
          salvataggi: { nelProgramma: false },
        },
      }),
    });
    render(
      <MemoryRouter>
        <ServiceSection />
      </MemoryRouter>,
    );
    const table = await screen.findByRole('table', { name: 'Collegamenti con i servizi esterni' });
    expect(within(table).getByText('Simulatore')).toBeTruthy();
    expect(within(table).getByText(/invio, accettato \(simulatore\)/)).toBeTruthy();
    expect(screen.getByText(/12 ore/)).toBeTruthy();
    expect(screen.getByText(/il backup lo fa chi gestisce il server/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
