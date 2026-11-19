import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuraChangesToday, AuraSection } from '../src/pages/AuraSection';
import { ServiceSection } from '../src/pages/admin/ServiceSection';

/** Risposte finte del servizio: per ogni percorso, un corpo (o una funzione per i POST). */
function stub(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const body = key in routes ? routes[key] : {};
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

const state = (over: object = {}) => ({
  disponibile: true,
  ambiente: 'simulator',
  idAura: 'SIM000000001',
  controllatoIl: '2026-11-19T08:00:00Z',
  esito: 'aggiornato',
  messaggio: null,
  aggiornatoIl: '2026-11-19T08:00:00Z',
  variazioni: [
    {
      quando: '2026-11-19T08:00:00Z',
      tipo: 'esenzione',
      variazione: 'tolta',
      descrizione: 'Esenzione 048 dal 01/01/2026, senza scadenza: non c’è più in AURA',
      avvio: 'notifica',
    },
  ],
  ...over,
});

describe('AURA nell’interfaccia (D197)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pannello: stato con simbolo e parola, simulatore dichiarato, variazioni con l’avvio', async () => {
    stub({ 'GET /api/pazienti/p1/aura': state() });
    render(<AuraSection patientId="p1" canWrite onUpdated={() => undefined} />);
    expect(await screen.findByText('Allineato con AURA')).toBeTruthy();
    expect(screen.getByText(/Collegamento simulato/)).toBeTruthy();
    expect(screen.getByText('SIM000000001')).toBeTruthy();
    expect(screen.getByText(/non c’è più in AURA/)).toBeTruthy();
    expect(screen.getByText(/notifica di AURA/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Aggiorna da AURA/ })).toBeTruthy();
  });

  it('«Aggiorna da AURA»: il risultato si legge, e con variazioni il pannello si ricarica', async () => {
    const fetchMock = stub({
      'GET /api/pazienti/p1/aura': state(),
      'POST /api/pazienti/p1/aura': {
        esito: 'aggiornato',
        messaggio: null,
        variazioni: 2,
        stato: state(),
      },
    });
    const onUpdated = vi.fn();
    render(<AuraSection patientId="p1" canWrite onUpdated={onUpdated} />);
    fireEvent.click(await screen.findByRole('button', { name: /Aggiorna da AURA/ }));
    expect(await screen.findByText('Aggiornato da AURA: 2 variazioni.')).toBeTruthy();
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => u === '/api/pazienti/p1/aura' && init?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('senza rete: il motivo si legge; chi non scrive nell’archivio non ha il pulsante', async () => {
    stub({
      'GET /api/pazienti/p1/aura': state({
        esito: 'non_raggiungibile',
        messaggio: 'AURA non raggiungibile (simulatore)',
        variazioni: [],
      }),
    });
    render(<AuraSection patientId="p1" canWrite={false} onUpdated={() => undefined} />);
    expect(await screen.findByText('AURA non raggiungibile')).toBeTruthy();
    expect(screen.getByText('AURA non raggiungibile (simulatore)')).toBeTruthy();
    expect(screen.getByText('Nessuna variazione arrivata da AURA.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aggiorna da AURA/ })).toBeNull();
  });

  it('in produzione con il simulatore: AURA spenta, detto, e niente pulsante', async () => {
    stub({
      'GET /api/pazienti/p1/aura': state({
        disponibile: false,
        esito: null,
        idAura: null,
        variazioni: [],
      }),
    });
    render(<AuraSection patientId="p1" canWrite onUpdated={() => undefined} />);
    expect(await screen.findByText(/non è ancora collegata al servizio vero/)).toBeTruthy();
    expect(screen.queryByText(/Collegamento simulato/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Aggiorna da AURA/ })).toBeNull();
  });

  it('pagina Oggi: le variazioni con il paziente; senza variazioni, o con una risposta strana, niente', async () => {
    stub({
      'GET /api/aura/variazioni?giorni=7': {
        disponibile: true,
        giorni: 7,
        variazioni: [
          {
            quando: '2026-11-19T08:00:00Z',
            tipo: 'esenzione',
            variazione: 'nuova',
            descrizione: 'Esenzione 013 dal 01/01/2025, senza scadenza',
            paziente: { id: 'p1', cognome: 'Inventato', nome: 'Paziente' },
          },
        ],
      },
    });
    const first = render(
      <MemoryRouter>
        <AuraChangesToday />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: 'Paziente Inventato' });
    expect(link.getAttribute('href')).toBe('/pazienti/p1/amministrazione#aura');
    expect(screen.getByText(/nuova – Esenzione 013/)).toBeTruthy();
    first.unmount();
    vi.unstubAllGlobals();
    stub({ 'GET /api/aura/variazioni?giorni=7': { variazioni: 'non un elenco' } });
    const second = render(
      <MemoryRouter>
        <AuraChangesToday />
      </MemoryRouter>,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(second.container.textContent).toBe('');
  });

  it('stato del servizio: i numeri di AURA sono quelli dello studio', async () => {
    stub({
      'GET /api/studio/servizio': {
        collegamenti: [],
        sessione: { durataMassimaOre: 12, minutiInattivita: 5 },
        attese: {
          postazione: 5,
          indirizzo: 20,
          primaSecondi: 2,
          massimaSecondi: 900,
          dimenticaDopoOre: 24,
        },
        bancheDati: { configurato: false, ora: null, prossimoGiro: null },
        aura: {
          disponibile: true,
          prossimoGiro: null,
          ultimoGiro: {
            iniziato: '2026-11-19T01:30:00Z',
            finito: '2026-11-19T01:31:00Z',
            pazienti: 12,
            conVariazioni: 3,
            nonRiusciti: 1,
            messaggio: null,
          },
        },
        salvataggi: { nelProgramma: false },
      },
    });
    render(
      <MemoryRouter>
        <ServiceSection />
      </MemoryRouter>,
    );
    expect(await screen.findByText('AURA, anagrafe regionale')).toBeTruthy();
    expect(screen.getByText('12, di cui 3 con variazioni e 1 non riusciti')).toBeTruthy();
    expect(screen.getByText(/Il controllo di ogni notte non è attivo/)).toBeTruthy();
  });
});
