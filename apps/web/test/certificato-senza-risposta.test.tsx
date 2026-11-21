import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { CertificatesPage } from '../src/pages/CertificatesPage';

/**
 * Certificato rimasto «in invio» (D233): nella scheda del certificato il medico segna l'esito
 * chiesto all'INPS. Servizio finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const me = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

const certificate = (interrupted: boolean) => ({
  id: 'c1',
  stato: 'sending',
  etichettaStato: 'In invio',
  tipo: 'I',
  etichettaTipo: 'Inizio',
  visita: 'A',
  etichettaVisita: 'Ambulatoriale',
  dataRilascio: '2026-11-20',
  dataInizio: '2026-11-20',
  dataFine: '2026-11-22',
  giorni: 3,
  codiceDiagnosi: '487.1',
  noteDiagnosi: 'Sindrome influenzale di prova',
  giornataLavorata: false,
  trauma: false,
  agevolazioni: null,
  residenza: null,
  reperibilita: null,
  protocollo: null,
  ricevutoIl: null,
  rettificaDi: null,
  annullamento: null,
  errore: null,
  annullabile: false,
  rettificabile: false,
  continuabile: false,
  invioInterrotto: interrupted,
  inviatoIl: '2026-11-20T09:05:00Z',
});

/** Il servizio finto: un certificato «in invio», l'esito come la prova chiede. */
function service(interrupted: boolean) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      if (path === '/api/io') return Promise.resolve(json(200, me));
      if (path === '/api/pazienti/p1')
        return Promise.resolve(
          json(200, { paziente: { firstName: 'Paola', lastName: 'Inventata' } }),
        );
      if (path === '/api/pazienti/p1/certificati')
        return Promise.resolve(
          json(200, {
            certificati: [certificate(interrupted)],
            residenza: null,
            recapiti: { email: false, telefono: false, emailDatore: false },
          }),
        );
      if (path === '/api/certificati/c1/esito-invio') {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(json(200, { stato: 'error', protocollo: null, messaggio: null }));
      }
      return Promise.resolve(json(200, {}));
    }),
  );
  return bodies;
}

function page() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={['/pazienti/p1/certificati']}>
        <Routes>
          <Route path="/pazienti/:id/certificati" element={<CertificatesPage />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('certificato rimasto «in invio» (D233)', () => {
  it('da meno di 15 minuti: si aspetta, senza pulsanti dell’esito', async () => {
    service(false);
    page();
    await screen.findByText('Invio all’INPS in corso: aspetta la risposta.');
    expect(screen.queryByRole('button', { name: /Non è arrivato/ })).toBeNull();
  });

  it('dopo: «Non è arrivato» lo rimette da inviare', async () => {
    const bodies = service(true);
    page();
    await screen.findByText(
      /è rimasto senza risposta: il servizio si è fermato mentre aspettava l’INPS/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Non è arrivato: torna da inviare' }));
    await vi.waitFor(() => expect(bodies).toEqual([{ esito: 'non_arrivato' }]));
  });

  it('dopo: «È arrivato» manda il protocollo scritto, senza spazi', async () => {
    const bodies = service(true);
    page();
    const form = await screen.findByRole('form', { name: 'Il certificato è arrivato' });
    await userEvent.type(
      within(form).getByLabelText('Protocollo dato dall’INPS'),
      ' MAN000000001 ',
    );
    await userEvent.click(within(form).getByRole('button', { name: /È arrivato/ }));
    await vi.waitFor(() =>
      expect(bodies).toEqual([{ esito: 'arrivato', protocollo: 'MAN000000001' }]),
    );
  });
});
