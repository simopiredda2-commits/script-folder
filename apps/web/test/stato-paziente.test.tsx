import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRecordsProvider } from '../src/lib/openRecords';
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
});
