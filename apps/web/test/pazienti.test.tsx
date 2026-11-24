import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatientsPage } from '../src/pages/PatientsPage';

/** Le pagine in cui si è passati, in ordine: ogni navigazione, anche «replace», ne aggiunge una. */
function Probe({ seen }: { seen: string[] }) {
  const location = useLocation();
  if (seen.at(-1) !== location.key) seen.push(location.key);
  return <p data-testid="dove">{`${location.pathname}${location.search}`}</p>;
}

function stub() {
  const fetchMock = vi.fn((url: string) => {
    const body =
      url === '/api/pazienti/nuovo'
        ? { archivi: [{ id: 'a1', nome: 'Archivio', titolare: 'Medico', proprio: true }] }
        : { pazienti: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderPatients(seen: string[], at = '/pazienti') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Probe seen={seen} />
      <Routes>
        <Route path="/pazienti" element={<PatientsPage />} />
        <Route path="/pazienti/nuovo" element={<h1>Modulo del paziente nuovo</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('elenco dei pazienti: ricerca e indirizzo', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('all’apertura nessuna navigazione in ritardo: «Nuovo paziente» porta al modulo e ci resta', async () => {
    stub();
    const seen: string[] = [];
    renderPatients(seen);
    fireEvent.click(await screen.findByRole('link', { name: 'Nuovo paziente' }));
    expect(await screen.findByRole('heading', { name: 'Modulo del paziente nuovo' })).toBeTruthy();
    // Oltre la pausa della ricerca: l'indirizzo non torna all'elenco.
    await wait(400);
    expect(screen.getByTestId('dove').textContent).toBe('/pazienti/nuovo');
    // Due pagine sole: l'elenco e il modulo, nessuna sostituzione in mezzo.
    expect(seen).toHaveLength(2);
  });

  it('aperto senza toccare la ricerca, l’indirizzo non cambia', async () => {
    stub();
    const seen: string[] = [];
    renderPatients(seen, '/pazienti?q=ros');
    expect((await screen.findByLabelText<HTMLInputElement>('Cerca un paziente')).value).toBe('ros');
    await wait(400);
    expect(seen).toHaveLength(1);
    expect(screen.getByTestId('dove').textContent).toBe('/pazienti?q=ros');
  });

  it('il testo va subito nell’indirizzo; la richiesta al servizio parte dopo la pausa', async () => {
    const fetchMock = stub();
    const seen: string[] = [];
    renderPatients(seen);
    await screen.findByRole('link', { name: 'Nuovo paziente' });
    fireEvent.change(screen.getByLabelText('Cerca un paziente'), { target: { value: 'ros' } });
    expect(screen.getByTestId('dove').textContent).toBe('/pazienti?q=ros');
    const asked = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/pazienti?')).length;
    expect(asked()).toBe(0);
    await waitFor(() => expect(asked()).toBe(1));
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/pazienti?q=ros')).toBe(true);
    // Svuotata la ricerca, l'indirizzo torna senza testo.
    fireEvent.change(screen.getByLabelText('Cerca un paziente'), { target: { value: '' } });
    expect(screen.getByTestId('dove').textContent).toBe('/pazienti');
  });

  it('senza archivi visibili spiega perché non ci sono pazienti, invece di «nessun paziente trovato»', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url === '/api/pazienti/nuovo' ? { archivi: [] } : { pazienti: [], archivi: 0 },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    renderPatients([]);
    expect(await screen.findByText(/Non vedi le cartelle di nessun archivio/)).toBeTruthy();
    expect(screen.getByText(/l’amministratore dello\s+studio no/)).toBeTruthy();
    expect(screen.queryByText('Nessun paziente trovato.')).toBeNull();
  });

  it('un risultato: «1 paziente»; lo stato in parole, come nella cartella (audit D259)', async () => {
    const row = (id: string, cognome: string, stato: string) => ({
      id,
      nome: 'Paziente',
      cognome,
      dataNascita: '1950-01-01',
      codiceFiscale: 'NVNPZN50A41X000X',
      stato,
    });
    const answer = (pazienti: unknown[]) =>
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(url === '/api/pazienti/nuovo' ? { archivi: [] } : { pazienti }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    vi.stubGlobal('fetch', answer([row('p1', 'Inventato', 'temporary')]));
    renderPatients([]);
    expect(await screen.findByText('1 paziente')).toBeTruthy();
    expect(screen.getByText('temporaneo')).toBeTruthy();
    expect(screen.queryByText('temporary')).toBeNull();
    cleanup();
    vi.stubGlobal(
      'fetch',
      answer([row('p1', 'Primo', 'revoked'), row('p2', 'Secondo', 'deceased')]),
    );
    renderPatients([]);
    expect(await screen.findByText('2 pazienti')).toBeTruthy();
    expect(screen.getByText('revocato')).toBeTruthy();
    expect(screen.getByText('deceduto')).toBeTruthy();
  });
});
