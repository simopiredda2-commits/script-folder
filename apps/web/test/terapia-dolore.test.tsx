import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { SessionProvider } from '../src/lib/session';
import { PrescriptionEditor } from '../src/pages/PrescriptionEditor';

/**
 * Il codice della terapia del dolore nella scelta dell'esenzione (R23, D272): lo dà il servizio
 * dai dati delle regole, solo per la ricetta farmaceutica del SSN. Paziente inventato.
 */

const PATIENT_ID = '00000000-0000-4000-8000-000000000003';

const DOCTOR = {
  id: 'u1',
  nome: 'Dott.ssa Elena Marchi',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: 'a1',
};

const RECORD = {
  paziente: {
    id: PATIENT_ID,
    firstName: 'Paziente',
    lastName: 'Inventata',
    birthDate: '1950-01-01',
    sex: 'F',
    birthPlaceName: null,
    fiscalCode: 'NVNPZN50A41X000X',
    phone: null,
    email: null,
    asl: null,
    status: 'active',
    deceasedOn: null,
  },
  riepilogo: {
    problemiAttivi: [],
    allergie: [],
    ultimeVoci: [],
    pianiTerapeutici: [],
    esenzioni: [{ codice: '048', dal: '2026-01-01', al: null }],
    parametri: [],
  },
  codiciTerapiaDolore: ['TDL', 'TDL01'],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function editor() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      const body =
        path === '/api/io' ? DOCTOR : path === `/api/pazienti/${PATIENT_ID}` ? RECORD : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  render(
    <SessionProvider>
      <OpenRecordsProvider>
        <MemoryRouter initialEntries={[`/pazienti/${PATIENT_ID}/ricetta`]}>
          <Routes>
            <Route path="/pazienti/:id/ricetta" element={<PrescriptionEditor mode="farmaci" />} />
          </Routes>
        </MemoryRouter>
      </OpenRecordsProvider>
    </SessionProvider>,
  );
}

describe('codice della terapia del dolore nella ricetta (R23, D272)', () => {
  it('sulla farmaceutica SSN accanto alle esenzioni del paziente; non sulla bianca', async () => {
    editor();
    const select = await screen.findByLabelText('Esenzione');
    const options = () =>
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(options()).toEqual([
      'Nessuna',
      '048',
      'TDL · terapia del dolore',
      'TDL01 · terapia del dolore',
    ]);
    fireEvent.change(select, { target: { value: 'TDL01' } });
    expect((select as HTMLSelectElement).value).toBe('TDL01');
    fireEvent.click(screen.getByLabelText('Bianca (a carico del paziente)'));
    expect(options()).toEqual(['Nessuna', '048']);
  });
});
