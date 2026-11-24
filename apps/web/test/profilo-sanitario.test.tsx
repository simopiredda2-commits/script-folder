import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { SessionProvider } from '../src/lib/session';
import { HealthProfilePage } from '../src/pages/HealthProfilePage';

/**
 * Profilo sanitario sintetico (audit D259): «Nessuna … nota» si propone solo con la sezione vuota
 * in cartella; la terapia che non può entrare porta alla sua scheda. Servizio finto, dati
 * inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const doctor = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

const RECORD = {
  paziente: {
    id: 'p1',
    firstName: 'Paola',
    lastName: 'Inventata',
    sex: 'F',
    birthDate: '1950-01-01',
    birthPlaceName: null,
    fiscalCode: 'NVNPZN50A41X000X',
    phone: null,
    email: null,
    asl: null,
    status: 'active',
    deceasedOn: null,
  },
  riepilogo: null,
};

const empty = {
  allergie: [],
  problemi: [],
  anamnesiFamiliare: [],
  parametri: [],
  stiliDiVita: [],
  capacitaMotoria: [],
};

const DRAFT = {
  id: 'd1',
  stato: 'draft',
  statoNome: 'Bozza',
  versione: 1,
  documento: 'DOC-1',
  sostituisce: null,
  ultimoProblema: null,
  validatoIl: null,
  firmatoIl: null,
  inviatoIl: null,
  pubblicatoIl: null,
  contenuto: {
    sezioni: {
      ...empty,
      // Una terapia in cartella che non può entrare: senza AIC né ATC.
      terapie: [
        {
          id: 't1',
          etichetta: 'Farmaco inventato 5 mg',
          incluso: false,
          manca: ['Manca il codice AIC o ATC del farmaco'],
        },
      ],
    },
    assenze: {
      allergie: 'no-allergy-info',
      terapie: 'no-medication-info',
      problemi: 'no-problem-info',
      anamnesiFamiliare: 'no-problem-info',
    },
    esclusi: { oscurate: 0, riservate: 0 },
    nonInseribili: [],
  },
};

function page() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      if (path === '/api/io') return Promise.resolve(json(200, doctor));
      if (path === '/api/pazienti/p1') return Promise.resolve(json(200, RECORD));
      if (path === '/api/pazienti/p1/profilo-sanitario')
        return Promise.resolve(
          json(200, { versioni: [], inLavorazione: DRAFT, mancano: [], puoFirmare: true }),
        );
      return Promise.resolve(json(200, {}));
    }),
  );
  render(
    <SessionProvider>
      <OpenRecordsProvider>
        <MemoryRouter initialEntries={['/pazienti/p1/profilo-sanitario']}>
          <Routes>
            <Route path="/pazienti/:id/profilo-sanitario" element={<HealthProfilePage />} />
          </Routes>
        </MemoryRouter>
      </OpenRecordsProvider>
    </SessionProvider>,
  );
}

const section = async (name: string) =>
  within((await screen.findByText(name, { selector: 'legend' })).closest('fieldset')!);

describe('Profilo sanitario sintetico: assenze vere (audit D259)', () => {
  it('con una terapia in cartella «Nessuna terapia nota» non si propone; la terapia porta alla sua scheda', async () => {
    page();
    const therapies = await section('Terapie farmacologiche');
    expect(therapies.queryByLabelText('Nessuna terapia nota')).toBeNull();
    expect(
      therapies.getByText(/nel Profilo si scrive «Nessuna informazione sulle terapie»/),
    ).toBeTruthy();
    const link = therapies.getByRole('link', {
      name: 'Completa la scheda di Farmaco inventato 5 mg',
    });
    expect(link.getAttribute('href')).toBe('/pazienti/p1/terapie/t1/modifica');
  });

  it('con la sezione vuota in cartella le due scelte restano', async () => {
    page();
    const allergies = await section('Allergie e intolleranze');
    expect(allergies.getByLabelText('Nessuna allergia nota')).toBeTruthy();
    expect(allergies.getByLabelText('Nessuna informazione sulle allergie')).toBeTruthy();
  });
});
