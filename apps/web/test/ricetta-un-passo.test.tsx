import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { SessionProvider } from '../src/lib/session';
import { PrescriptionEditor } from '../src/pages/PrescriptionEditor';

/**
 * Ricetta del medico in un passo (D255): «Firma e invia» dell'editor salva, controlla e invia;
 * «Salva in bozza» salva soltanto. Servizio finto, paziente e farmaco inventati.
 */

const PATIENT_ID = '00000000-0000-4000-8000-000000000003';

const DOCTOR = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

const RECORD = {
  paziente: {
    id: PATIENT_ID,
    firstName: 'Paziente',
    lastName: 'Inventato',
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

/** Un controllo che blocca (R2), come nel resoconto dell'audit (D259). */
const BLOCKED = {
  versioneRegole: 'prova-1',
  problemi: [
    {
      ruleId: 'R2',
      severity: 'block',
      message: '3 confezioni: il limite è 2',
      remedy: null,
      lineId: null,
    },
  ],
  bloccanti: 1,
};

function service(opts: { blocked?: boolean; refused?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (opts.refused && path === `/api/pazienti/${PATIENT_ID}/ricette` && method === 'POST')
        return Promise.resolve(
          new Response(JSON.stringify({ errore: 'Azione riservata al medico' }), { status: 403 }),
        );
      const body =
        path === '/api/io'
          ? DOCTOR
          : path === `/api/pazienti/${PATIENT_ID}`
            ? RECORD
            : path === `/api/pazienti/${PATIENT_ID}/ricette` && method === 'POST'
              ? { id: 'r1' }
              : path === `/api/pazienti/${PATIENT_ID}/ricette`
                ? { ricette: [{ id: 'r1', status: 'draft', righe: [] }] }
                : path === '/api/ricette/r1/controlla'
                  ? opts.blocked
                    ? BLOCKED
                    : { versioneRegole: 'prova-1', problemi: [], bloccanti: 0 }
                  : path === '/api/ricette/r1/firma-e-invia'
                    ? { esito: 'accepted', nre: '0101A0000000009', messaggio: null }
                    : // Dopo l'invio compare il promemoria, che legge stampa, recapiti e consegne.
                      path === '/api/stampa/preferenze'
                      ? { postazione: { scritta: '', riconosciuta: null }, preferenze: [] }
                      : path === `/api/pazienti/${PATIENT_ID}/recapiti-promemoria`
                        ? { paziente: { email: null, telefono: null }, deleghe: [] }
                        : path === '/api/ricette/r1/promemoria/consegne'
                          ? { consegne: [], carta: null }
                          : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  return calls;
}

function editor() {
  // Una riga già in ricetta, come la ricorda l'editor (D68).
  sessionStorage.setItem(
    `ricetta:${PATIENT_ID}:farmaci:righe`,
    JSON.stringify([{ key: 'k1', drugName: 'Farmaco di prova 5 mg', quantity: 1 }]),
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

const signs = (calls: string[]) => calls.filter((c) => c === 'POST /api/ricette/r1/firma-e-invia');

describe('ricetta del medico in un passo (D255)', () => {
  it('«Firma e invia» salva, controlla e invia, con l’NRE', async () => {
    const calls = service();
    editor();
    fireEvent.click(await screen.findByRole('button', { name: 'Firma e invia' }));
    await screen.findAllByText(/0101A0000000009/);
    expect(calls).toContain(`POST /api/pazienti/${PATIENT_ID}/ricette`);
    expect(calls).toContain('POST /api/ricette/r1/controlla');
    expect(signs(calls)).toHaveLength(1);
  });

  it('«Salva in bozza» salva soltanto: i controlli, e la firma con il pulsante', async () => {
    const calls = service();
    editor();
    fireEvent.click(await screen.findByRole('button', { name: 'Salva in bozza' }));
    await screen.findByText('Ricetta preparata in bozza. Si controlla e poi si firma.');
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect((sign as HTMLButtonElement).disabled).toBe(false));
    expect(signs(calls)).toHaveLength(0);
  });
});

describe('dopo l’arresto si corregge la ricetta, senza rifarla (audit, D259)', () => {
  it('«Modifica la ricetta» annulla la bozza e rimette in modifica le righe di prima', async () => {
    const calls = service({ blocked: true });
    editor();
    fireEvent.click(await screen.findByRole('button', { name: 'Firma e invia' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Modifica la ricetta' }));
    // Di nuovo in modifica: la ricerca accesa, la riga di prima ancora in ricetta.
    await waitFor(() =>
      expect(
        screen.getByLabelText<HTMLInputElement>('Farmaco, principio attivo, codice AIC o ATC')
          .disabled,
      ).toBe(false),
    );
    expect(screen.getAllByText(/Farmaco di prova 5 mg/).length).toBeGreaterThan(0);
    expect(calls).toContain('POST /api/ricette/r1/annulla');
    expect(signs(calls)).toHaveLength(0);
  });

  it('«Nuova ricetta da capo» non lascia la bozza nel servizio: la annulla', async () => {
    const calls = service({ blocked: true });
    editor();
    fireEvent.click(await screen.findByRole('button', { name: 'Salva in bozza' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Nuova ricetta da capo' }));
    await waitFor(() => expect(calls).toContain('POST /api/ricette/r1/annulla'));
    await screen.findByText('Aggiungi un farmaco dalla ricerca.');
  });

  it('dopo «Ricomincia» l’errore del tentativo di prima non resta (audit 19)', async () => {
    service({ refused: true });
    editor();
    fireEvent.click(await screen.findByRole('button', { name: 'Salva in bozza' }));
    await screen.findByText('Azione riservata al medico');
    fireEvent.click(screen.getByRole('button', { name: 'Ricomincia' }));
    await waitFor(() => expect(screen.queryByText('Azione riservata al medico')).toBeNull());
  });
});
