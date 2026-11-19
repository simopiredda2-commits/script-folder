import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { studioToday } from '../src/lib/format';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { NewPatientPage } from '../src/pages/NewPatientPage';
import { PrescriptionEditor } from '../src/pages/PrescriptionEditor';

const PATIENT_ID = '00000000-0000-4000-8000-000000000001';

/** Il servizio finto: la cartella con lo stato dato, il resto vuoto. */
function stub(status: string, deceasedOn: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body =
        url.startsWith(`/api/pazienti/${PATIENT_ID}?`) || url === `/api/pazienti/${PATIENT_ID}`
          ? {
              paziente: {
                id: PATIENT_ID,
                firstName: 'Paziente',
                lastName: 'Inventato',
                sex: 'M',
                birthDate: '1950-01-01',
                birthPlaceName: null,
                fiscalCode: 'NVNPZN50A01X000A',
                phone: null,
                email: null,
                asl: null,
                status,
                deceasedOn,
              },
              riepilogo: null,
            }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

const renderEditor = () =>
  render(
    <OpenRecordsProvider>
      <MemoryRouter initialEntries={[`/pazienti/${PATIENT_ID}/ricetta`]}>
        <Routes>
          <Route path="/pazienti/:id/ricetta" element={<PrescriptionEditor mode="farmaci" />} />
        </Routes>
      </MemoryRouter>
    </OpenRecordsProvider>,
  );

describe('stato del paziente nella ricetta (D199)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('deceduto: la ricetta non si fa, lo si dice subito con il rimedio; nessuna ricerca dei farmaci', async () => {
    stub('deceased', '2026-11-17');
    renderEditor();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Il paziente risulta deceduto il 17\/11\/2026: la ricetta non si fa\./,
    );
    expect(screen.getByRole('link', { name: 'dati amministrativi' }).getAttribute('href')).toBe(
      `/pazienti/${PATIENT_ID}/amministrazione`,
    );
    expect(screen.queryByRole('heading', { name: 'Banca dati farmaci' })).toBeNull();
    // La testata dice lo stato con la data.
    expect(screen.getByText('deceduto il 17/11/2026')).toBeTruthy();
  });

  it('in carico: l’editor c’è, senza il blocco', async () => {
    stub('active', null);
    renderEditor();
    expect(await screen.findByRole('heading', { name: 'Banca dati farmaci' })).toBeTruthy();
    expect(screen.queryByText(/la ricetta non si fa/)).toBeNull();
  });

  it('nuovo paziente temporaneo: lo stato e le date della scelta vanno con il paziente', async () => {
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/pazienti/nuovo')
        return json({
          archivi: [{ id: 'a1', nome: 'Archivio di prova', titolare: 'Medico', proprio: true }],
          archivioProposto: 'a1',
          sessi: [
            { chiave: 'M', nome: 'Maschile' },
            { chiave: 'F', nome: 'Femminile' },
          ],
        });
      if (url === '/api/pazienti' && init?.method === 'POST') return json({ id: PATIENT_ID }, 201);
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/pazienti/nuovo']}>
        <Routes>
          <Route path="/pazienti/nuovo" element={<NewPatientPage />} />
          <Route path="/pazienti/:id" element={<p>Cartella aperta</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Nuovo paziente' });
    // In carico per difetto: nessuna data da scrivere.
    expect((screen.getByLabelText('In carico') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Scadenza della scelta')).toBeNull();
    fireEvent.click(screen.getByLabelText('Temporaneo, con la scadenza della scelta'));
    expect((screen.getByLabelText('Scelta dal') as HTMLInputElement).value).toBe(studioToday());
    fireEvent.change(screen.getByLabelText('Scadenza della scelta'), {
      target: { value: '2027-02-28' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registra il paziente' }));
    await screen.findByText('Cartella aperta');
    const posted = fetchMock.mock.calls.find(
      ([u, init]) => u === '/api/pazienti' && init?.method === 'POST',
    );
    const body = JSON.parse(posted![1]!.body as string) as {
      dati: Record<string, string>;
      sceltaTemporanea?: { dal: string; scadenza: string };
    };
    expect(body.dati.stato).toBe('temporaneo');
    expect(body.sceltaTemporanea).toEqual({ dal: studioToday(), scadenza: '2027-02-28' });
    // Dopo la registrazione il modulo riparte da «in carico».
    await waitFor(() =>
      expect(localStorage.getItem('bozza-nuovo-paziente-stato') ?? '').not.toMatch(/temporaneo/),
    );
  });
});
