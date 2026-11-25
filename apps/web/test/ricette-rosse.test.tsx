import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { SignQueuePage } from '../src/pages/SignQueuePage';
import { TodayPage } from '../src/pages/TodayPage';

/**
 * Ricette rosse in DPCM nella pagina Ricette e in Oggi (D270): stato con simbolo e parola, messaggi
 * del SAR, annullamento della ricetta dematerializzata, «Invia adesso». Servizio finto, dati
 * inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const who = (codice: string, nome: string) => ({
  id: 'u1',
  nome: 'Utente inventato',
  ruoli: [{ codice, nome }],
  postazione: 'Studio',
  archivio: null,
});

const row = (extra: object) => ({
  id: 'd1',
  ricetta: 'r1',
  paziente: 'p1',
  nomePaziente: 'Paola Inventata',
  poligrafico: '010260001234001',
  nre: '010ZZ4000000001',
  stampataIl: '2026-11-20T09:00:00Z',
  inviareEntro: '2026-11-21T09:00:00Z',
  stato: 'to_send',
  protocollo: null,
  accoltaIl: null,
  messaggi: [],
  errore: null,
  tentativi: 0,
  prossimoTentativo: null,
  annullamentoDematerializzata: null,
  pdf: '/api/ricette/r1/ricetta-rossa.pdf',
  daSeguire: false,
  ...extra,
});

const ROWS = [
  row({}),
  row({
    id: 'd2',
    ricetta: 'r2',
    nomePaziente: 'Mario Inventato',
    stato: 'accepted',
    protocollo: '99000000000000000000001',
    accoltaIl: '2026-11-20T09:01:00Z',
    annullamentoDematerializzata: {
      nre: '010ZZ4000000099',
      stato: 'pending',
      errore: null,
      annullataIl: null,
    },
    pdf: '/api/ricette/r2/ricetta-rossa.pdf',
  }),
  row({
    id: 'd3',
    ricetta: 'r3',
    nomePaziente: 'Anna Inventata',
    stato: 'warnings',
    protocollo: '99000000000000000000002',
    messaggi: [
      { code: '2090', description: 'Avviso: Data compilazione precedente alla data di ricezione' },
    ],
    annullamentoDematerializzata: {
      nre: '010ZZ4000000098',
      stato: 'done',
      errore: null,
      annullataIl: '2026-11-20T09:02:00Z',
    },
    pdf: '/api/ricette/r3/ricetta-rossa.pdf',
  }),
  row({
    id: 'd4',
    ricetta: 'r4',
    nomePaziente: 'Luca Inventato',
    stato: 'discarded',
    protocollo: '99000000000000000000003',
    messaggi: [{ code: 'SIM-ERR', description: 'Errore scartante (simulato)' }],
    annullamentoDematerializzata: {
      nre: '010ZZ4000000097',
      stato: 'failed',
      errore: 'Il SAR non ha annullato la ricetta dematerializzata (simulato)',
      annullataIl: null,
    },
    pdf: '/api/ricette/r4/ricetta-rossa.pdf',
    daSeguire: true,
  }),
];

/** Il servizio finto: le code vuote, le ricette rosse come le dà la prova. */
function service(me: object, rows: object[] = ROWS) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/io') return Promise.resolve(json(200, me));
      if (path === '/api/ricette-rosse') return Promise.resolve(json(200, { ricette: rows }));
      if (path === '/api/ricette-rosse/invia') return Promise.resolve(json(200, { ricette: rows }));
      if (path.startsWith('/api/ricette/')) return Promise.resolve(json(200, { pazienti: [] }));
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
  return calls;
}

function page() {
  render(
    <SessionProvider>
      <MemoryRouter>
        <SignQueuePage />
      </MemoryRouter>
    </SessionProvider>,
  );
}

const section = async () =>
  within(
    (await screen.findByRole('heading', { level: 2, name: 'Ricette rosse in DPCM' })).closest(
      'section',
    )!,
  );

describe('ricette rosse in DPCM nella pagina Ricette (D270)', () => {
  it('ogni ricetta rossa con paziente, modulo, NRE e stato, con simbolo e parola', async () => {
    service(who('owner_doctor', 'Medico titolare'));
    page();
    const s = await section();
    await s.findByRole('link', { name: 'Paola Inventata' });
    const items = s.getAllByRole('listitem').filter((li) => li.className.includes('riquadro'));
    expect(items).toHaveLength(4);
    const [toSend, sent, warned, discarded] = items.map((li) => within(li));
    toSend!.getByText(/010260001234001/);
    toSend!.getByText('Da mandare');
    toSend!.getByText(/Parte da sola/);
    sent!.getByText('Mandata');
    sent!.getByText(/si aspetta l’esito/);
    sent!.getByText('Da annullare');
    warned!.getByText('Accolta con avvisi');
    warned!.getByText(/Data compilazione precedente alla data di ricezione/);
    warned!.getByText('Annullata');
    discarded!.getByText('Scartata');
    discarded!.getByText(/Errore scartante \(simulato\)/);
    discarded!.getByText('Non annullata');
    discarded!.getByText(/Il SAR non ha annullato/);
    // Il PDF si ristampa da qui.
    expect(
      toSend!.getByRole('link', { name: 'Stampa di nuovo sul modulo (PDF)' }).getAttribute('href'),
    ).toBe('/api/ricette/r1/ricetta-rossa.pdf');
    // Lo stato non è solo un colore: c'è il simbolo accanto alla parola.
    expect(discarded!.getByText('Scartata').querySelector('svg')).toBeTruthy();
  });

  it('«Invia adesso» fa un giro della coda e rilegge l’elenco', async () => {
    const calls = service(who('owner_doctor', 'Medico titolare'));
    page();
    const s = await section();
    const reads = () => calls.filter((c) => c === 'GET /api/ricette-rosse').length;
    await s.findByRole('link', { name: 'Paola Inventata' });
    const before = reads();
    await userEvent.click(s.getByRole('button', { name: 'Invia adesso' }));
    expect(calls).toContain('POST /api/ricette-rosse/invia');
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('a lavoro finito «Invia adesso» non c’è; senza ricette rosse lo dice', async () => {
    service(who('owner_doctor', 'Medico titolare'), [ROWS[2]!]);
    page();
    const s = await section();
    await s.findByText('Accolta con avvisi');
    expect(s.queryByRole('button', { name: 'Invia adesso' })).toBeNull();
    cleanup();
    service(who('owner_doctor', 'Medico titolare'), []);
    page();
    await (await section()).findByText('Nessuna ricetta rossa.');
  });

  it('la segreteria non ha la sezione: le ricette rosse sono del medico', async () => {
    const calls = service(who('secretary', 'Segreteria'));
    page();
    await screen.findByRole('heading', { level: 2, name: 'Invii senza risposta' });
    expect(screen.queryByRole('heading', { name: 'Ricette rosse in DPCM' })).toBeNull();
    expect(calls).not.toContain('GET /api/ricette-rosse');
  });
});

describe('Oggi: le ricette rosse da seguire (D270)', () => {
  function today(ricetteRosse: number | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io')
          return Promise.resolve(json(200, who('owner_doctor', 'Medico titolare')));
        if (path === '/api/oggi')
          return Promise.resolve(
            json(200, {
              data: '2026-11-20',
              appuntamenti: [],
              code: {
                daFirmare: 0,
                inBozza: 0,
                nonInviate: 0,
                senzaRisposta: 0,
                ricetteRosse,
                richiesteAperte: null,
                pianiInScadenza: [],
                giorniAvvisoPiani: 30,
                farmaciCarenti: [],
                variazioniAifa: [],
              },
            }),
          );
        return Promise.resolve(json(200, {}));
      }),
    );
    render(
      <SessionProvider>
        <MemoryRouter>
          <TodayPage />
        </MemoryRouter>
      </SessionProvider>,
    );
  }

  it('compare con il numero e porta alla sezione nella pagina Ricette', async () => {
    today(2);
    const link = await screen.findByRole('link', { name: /^Ricette rosse da seguire\s*2$/ });
    expect(link.getAttribute('href')).toBe('/ricette#ricette-rosse');
  });

  it('con nessuna da seguire non compare', async () => {
    today(0);
    await screen.findByText(/Oggi|oggi/);
    expect(screen.queryByRole('link', { name: /Ricette rosse da seguire/ })).toBeNull();
  });
});
