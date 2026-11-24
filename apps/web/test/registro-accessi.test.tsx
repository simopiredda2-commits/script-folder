import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import type { ReactNode } from 'react';
import { SessionProvider, useSession } from '../src/lib/session';
import { AccessLogPage, actionText } from '../src/pages/AccessLogPage';
import { ArchivePage } from '../src/pages/ArchivePage';

/**
 * Registro degli accessi (audit D259): nella cartella e nell'Archivio, per il titolare. Servizio
 * finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const owner = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: { id: 'a1', nome: 'Archivio inventato' },
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

const ROWS = [
  {
    quando: '2026-11-24T09:00:00Z',
    nome: 'Segreteria inventata',
    azione: 'apertura_cartella',
    esito: 'negato',
    postazione: 'Accettazione',
    motivo: 'La segreteria non legge il diario',
    pazienteId: 'p1',
    paziente: 'Inventata Paola',
  },
];

function service(patientLog: { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      if (path === '/api/io') return Promise.resolve(json(200, owner));
      if (path === '/api/pazienti/p1') return Promise.resolve(json(200, RECORD));
      if (path === '/api/pazienti/p1/registro')
        return Promise.resolve(json(patientLog.status, patientLog.body));
      if (path === '/api/archivi/a1/registro')
        return Promise.resolve(json(200, { registro: ROWS, altri: false }));
      return Promise.resolve(json(200, {}));
    }),
  );
}

/** La pagina Archivio vuole la sessione pronta: prima rimanda alla pagina iniziale. */
function WhenReady({ children }: { children: ReactNode }) {
  const { state } = useSession();
  return state.status === 'ready' ? children : null;
}

function render_(path: string) {
  render(
    <SessionProvider>
      <OpenRecordsProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/pazienti/:id/registro" element={<AccessLogPage />} />
            <Route
              path="/archivio"
              element={
                <WhenReady>
                  <ArchivePage />
                </WhenReady>
              }
            />
          </Routes>
        </MemoryRouter>
      </OpenRecordsProvider>
    </SessionProvider>,
  );
}

describe('registro degli accessi (audit D259)', () => {
  it('nella cartella: chi, che cosa, esito, postazione e motivo; quando sono gli ultimi lo dice', async () => {
    service({ status: 200, body: { registro: ROWS, altri: true } });
    render_('/pazienti/p1/registro');
    const table = await screen.findByRole('table', { name: 'Accessi alla cartella' });
    const cells = within(table)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual(
      expect.arrayContaining([
        'Segreteria inventata',
        'Apertura cartella',
        'Negato',
        'Accettazione',
        'La segreteria non legge il diario',
      ]),
    );
    // Nella cartella il paziente non si ripete.
    expect(within(table).queryByRole('columnheader', { name: 'Paziente' })).toBeNull();
    expect(screen.getByText(/Gli ultimi 1 accessi, dal più recente/)).toBeTruthy();
  });

  it('a chi non è titolare la pagina dice chi lo legge', async () => {
    service({ status: 403, body: { errore: 'Azione riservata al titolare' } });
    render_('/pazienti/p1/registro');
    await screen.findByText(
      'Il registro degli accessi lo legge il medico titolare dell’archivio del paziente.',
    );
  });

  it('nell’Archivio: con il paziente, che porta al suo registro', async () => {
    service({ status: 200, body: { registro: [], altri: false } });
    render_('/archivio?sezione=registro');
    const table = await screen.findByRole('table', { name: 'Registro degli accessi' });
    const link = within(table).getByRole('link', { name: 'Inventata Paola' });
    expect(link.getAttribute('href')).toBe('/pazienti/p1/registro');
    expect(within(table).getByRole('columnheader', { name: 'Paziente' })).toBeTruthy();
  });

  it('l’azione in parole', () => {
    expect(actionText('apertura_cartella')).toBe('Apertura cartella');
    expect(actionText('lettura_registro_archivio')).toBe('Lettura registro archivio');
  });
});
