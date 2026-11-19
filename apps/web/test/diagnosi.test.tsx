import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiagnosisCodeInfo,
  DiagnosisSearch,
  type Diagnosis,
} from '../src/components/DiagnosisSearch';

/**
 * Ricerca delle diagnosi ICD-9-CM nei moduli (D186). Righe vere della versione italiana 2007; il
 * servizio è finto e la prova non chiama nulla di vero.
 */
const d = (code: string, description: string, over: Partial<Diagnosis> = {}): Diagnosis => ({
  code,
  description,
  parentCode: null,
  includedTerms: null,
  notes: null,
  chapter: null,
  section: null,
  category: false,
  path: [],
  ...over,
});
const ASMA = d('493.9', 'Asma, non specificata', {
  parentCode: '493',
  category: true,
  path: [{ code: '493', description: 'Asma' }],
});
const RIACUTIZZAZIONE = d('493.92', 'Asma, tipo non specificato, con riacutizzazione', {
  parentCode: '493.9',
  path: [
    { code: '493', description: 'Asma' },
    { code: '493.9', description: 'Asma, non specificata' },
  ],
});
const VERSION = {
  kind: 'diagnosi',
  kindLabel: 'Diagnosi ICD-9-CM',
  series: 'icd9cm-diagnosi',
  title: 'Ministero della salute: diagnosi ICD-9-CM 2007 (trascrizione)',
  validFrom: '2021-02-02',
  validFromBasis: 'atto',
  downloadedAt: null,
  act: 'DM 28 ottobre 2020',
  stale: null,
};

function fakeService(answer: (path: string, q: string | null) => unknown) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = new URL(url, 'http://localhost');
      paths.push(`${u.pathname}${u.search}`);
      return Promise.resolve(
        new Response(JSON.stringify(answer(u.pathname, u.searchParams.get('q'))), { status: 200 }),
      );
    }),
  );
  return paths;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Form() {
  const [code, setCode] = useState('');
  return (
    <>
      <label htmlFor="codice">Codice ICD-9-CM</label>
      <input id="codice" value={code} onChange={(e) => setCode(e.target.value)} />
      <DiagnosisCodeInfo code={code} />
      <DiagnosisSearch onPick={(x) => setCode(x.code)} />
    </>
  );
}

describe('ricerca delle diagnosi ICD-9-CM (D186)', () => {
  it('cerca per parole, apre i sottocodici di una categoria e usa il codice scelto', async () => {
    const paths = fakeService((path, q) => {
      if (path === '/api/diagnosi/493.92') return { diagnosi: RIACUTIZZAZIONE, disponibile: true };
      if (q === '493.9')
        return { diagnosi: [ASMA, RIACUTIZZAZIONE], totale: 2, versioni: [VERSION] };
      return { diagnosi: [ASMA], totale: 31, versioni: [VERSION] };
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Form />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Cerca il codice per descrizione' }));
    await user.type(screen.getByRole('searchbox'), 'asma');
    expect(await screen.findByText('Asma, non specificata')).toBeTruthy();
    expect(screen.getByText(/Altre 30 voci rispondono alla ricerca/)).toBeTruthy();
    // A6: la versione in uso, con la data dell'atto.
    expect(screen.getByText(/in vigore dal 02\/02\/2021/)).toBeTruthy();
    // Una categoria non si usa: porta ai suoi sottocodici.
    expect(screen.queryByRole('button', { name: 'Usa 493.9' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sottocodici di 493.9' }));
    await user.click(await screen.findByRole('button', { name: 'Usa 493.92' }));
    expect(screen.getByLabelText<HTMLInputElement>('Codice ICD-9-CM').value).toBe('493.92');
    // Il titolo del codice nel campo, dal catalogo; la ricerca si chiude.
    expect(await screen.findByText(/Asma, tipo non specificato, con riacutizzazione/)).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(paths).toContain('/api/diagnosi?q=asma');
  });

  it('il codice scritto a mano: titolo, categoria o codice che il catalogo non ha', async () => {
    fakeService((path) => {
      if (path === '/api/diagnosi/493.9') return { diagnosi: ASMA, disponibile: true };
      return { diagnosi: null, disponibile: true };
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Form />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText('Codice ICD-9-CM'), '493.9');
    expect(await screen.findByText(/è una categoria con sottocodici/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Codice ICD-9-CM'));
    await user.type(screen.getByLabelText('Codice ICD-9-CM'), '999.99');
    expect(await screen.findByText(/non è nel catalogo ICD-9-CM in uso/)).toBeTruthy();
  });

  it('senza catalogo in uso lo dice, e il codice si scrive a mano senza avvisi', async () => {
    const paths = fakeService((path) =>
      path === '/api/diagnosi'
        ? { diagnosi: [], totale: 0, versioni: [] }
        : { diagnosi: null, disponibile: false },
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Form />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Cerca il codice per descrizione' }));
    await user.type(screen.getByRole('searchbox'), 'asma');
    expect(await screen.findByText(/Il catalogo ICD-9-CM non è in uso/)).toBeTruthy();
    await user.type(screen.getByLabelText('Codice ICD-9-CM'), '401.9');
    await waitFor(() => expect(paths).toContain('/api/diagnosi/401.9'));
    expect(screen.queryByText(/non è nel catalogo/)).toBeNull();
  });
});
