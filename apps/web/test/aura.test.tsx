import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuraChangesToday,
  AuraDoctorChangesToday,
  AuraNewPatientsToday,
  AuraSection,
} from '../src/pages/AuraSection';
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
  differenze: [],
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

  it('anagrafica di AURA: le differenze si confermano una alla volta, con il dato visto', async () => {
    const fetchMock = stub({
      'GET /api/pazienti/p1/aura': state({
        differenze: [
          {
            campo: 'asl',
            etichetta: 'ASL di assistenza',
            nellaCartella: 'ASL TO1',
            inAura: 'ASL TO5',
          },
          { campo: 'decesso', etichetta: 'Decesso', nellaCartella: null, inAura: '2026-11-17' },
        ],
      }),
      'POST /api/pazienti/p1/aura/differenze': { campi: ['asl'], nonUsati: [], stato: state() },
    });
    const onUpdated = vi.fn();
    render(<AuraSection patientId="p1" canWrite onUpdated={onUpdated} />);
    expect(await screen.findByText('Anagrafica diversa in AURA, da confermare')).toBeTruthy();
    expect(screen.getByText('ASL TO1')).toBeTruthy();
    expect(screen.getByText('Deceduto il 17/11/2026')).toBeTruthy();
    expect(screen.getByText('Non risulta deceduto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Usa il dato di AURA: ASL di assistenza' }));
    expect(await screen.findByText('ASL di assistenza: ora c’è il dato di AURA.')).toBeTruthy();
    const posted = fetchMock.mock.calls.find(
      ([u, init]) => u === '/api/pazienti/p1/aura/differenze' && init?.method === 'POST',
    );
    // Il client manda il corpo come testo JSON.
    expect(JSON.parse(posted![1]!.body as string)).toEqual({
      scelte: [{ campo: 'asl', inAura: 'ASL TO5', usa: true }],
    });
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Conferma il decesso' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Non confermare il decesso' })).toBeTruthy();
  });

  it('anagrafica di AURA: chi non scrive nell’archivio vede le differenze ma non i pulsanti', async () => {
    stub({
      'GET /api/pazienti/p1/aura': state({
        differenze: [
          { campo: 'asl', etichetta: 'ASL di assistenza', nellaCartella: null, inAura: 'ASL TO5' },
        ],
      }),
    });
    render(<AuraSection patientId="p1" canWrite={false} onUpdated={() => undefined} />);
    expect(await screen.findByText('ASL TO5')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Usa il dato di AURA/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Azioni' })).toBeNull();
  });

  it('pagina Oggi: il decesso segnalato da AURA in evidenza, con il collegamento al pannello', async () => {
    stub({
      'GET /api/aura/variazioni?giorni=7': {
        disponibile: true,
        giorni: 7,
        variazioni: [],
        daConfermare: [
          {
            paziente: { id: 'p2', cognome: 'Inventata', nome: 'Paziente' },
            campi: [],
            decesso: '2026-11-17',
          },
          {
            paziente: { id: 'p3', cognome: 'Inventato', nome: 'Altro' },
            campi: ['ASL di assistenza', 'Residenza: comune'],
            decesso: null,
          },
        ],
      },
    });
    render(
      <MemoryRouter>
        <AuraChangesToday />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/AURA segnala il decesso di/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Paziente Inventata' }).getAttribute('href')).toBe(
      '/pazienti/p2/amministrazione#aura',
    );
    expect(screen.getByText(/il 17\/11\/2026: da confermare/)).toBeTruthy();
    expect(
      screen.getByText(/anagrafica diversa in AURA \(ASL di assistenza, Residenza: comune\)/),
    ).toBeTruthy();
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

  it('nuovi assistiti in Oggi (D199): chi, scelta e scadenza; «Registra» con un clic porta alla cartella', async () => {
    const one = {
      id: 'n1',
      cognome: 'INVENTATO',
      nome: 'PAZIENTE',
      nascita: '1970-05-04',
      codiceFiscale: 'NVNPZN70E04X001A',
      medico: 'Medico Titolare',
      sceltaDal: '2026-11-19',
      scadenza: '2027-02-17',
      segnalatoIl: '2026-11-19T08:00:00Z',
    };
    const fetchMock = stub({
      'GET /api/aura/nuovi': { disponibile: true, nuovi: [one] },
      'POST /api/aura/nuovi/n1/registra': { id: 'p9', avvisi: [], aura: { esito: 'aggiornato' } },
    });
    render(
      <MemoryRouter>
        <AuraNewPatientsToday />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /Nuovi assistiti in AURA/ })).toBeTruthy();
    const row = screen.getByRole('row', { name: /PAZIENTE INVENTATO/ });
    expect(row.textContent).toMatch(/04\/05\/1970/);
    expect(row.textContent).toMatch(
      /Medico Titolare, dal 19\/11\/2026; temporanea fino al 17\/02\/2027/,
    );
    // Il codice fiscale si vede mascherato, come nell'elenco dei pazienti.
    expect(row.textContent).not.toContain('NVNPZN70E04X001A');
    fireEvent.click(screen.getByRole('button', { name: 'Registra PAZIENTE INVENTATO' }));
    expect(await screen.findByText(/registrato con i dati di AURA/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Apri la cartella' }).getAttribute('href')).toBe(
      '/pazienti/p9',
    );
    // L'elenco si ricarica dopo il clic.
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/aura/nuovi').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Non registrare PAZIENTE INVENTATO' })).toBeTruthy();
  });

  it('nuovi assistiti: già registrato a mano, il collegamento al paziente; senza nuovi, niente', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const conflict = init?.method === 'POST';
        const body = conflict
          ? { errore: 'Il codice fiscale è già registrato', dettagli: { paziente: { id: 'p7' } } }
          : {
              disponibile: true,
              nuovi: [
                {
                  id: 'n2',
                  cognome: 'ALTRO',
                  nome: 'ASSISTITO',
                  nascita: '1980-01-01',
                  codiceFiscale: 'LTRSST80A01X002B',
                  medico: 'Medico Titolare',
                  sceltaDal: '2026-11-19',
                  scadenza: null,
                  segnalatoIl: '2026-11-19T08:00:00Z',
                },
              ],
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: conflict ? 409 : 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const first = render(
      <MemoryRouter>
        <AuraNewPatientsToday />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Registra ASSISTITO ALTRO' }));
    expect(await screen.findByText('Il codice fiscale è già registrato')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Apri la cartella del paziente già registrato' })
        .getAttribute('href'),
    ).toBe('/pazienti/p7');
    first.unmount();
    vi.unstubAllGlobals();
    stub({ 'GET /api/aura/nuovi': { disponibile: true, nuovi: [] } });
    const second = render(
      <MemoryRouter>
        <AuraNewPatientsToday />
      </MemoryRouter>,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(second.container.textContent).toBe('');
  });

  it('cambi di medico in Oggi (D200): il titolare di prima sposta con un clic, o non sposta; l’elenco si ricarica', async () => {
    const one = {
      id: 'c1',
      paziente: { id: 'p3', cognome: 'INVENTATO', nome: 'PAZIENTE' },
      medico: 'Medico Collega',
      medicoId: 'u2',
      sceltaDal: '2026-11-18',
    };
    const fetchMock = stub({
      'GET /api/aura/cambi-medico': { disponibile: true, daDecidere: [one], inArrivo: [] },
      'POST /api/aura/cambi-medico/c1/sposta': { id: 'c1', stato: 'spostato' },
      'POST /api/aura/cambi-medico/c1/non-spostare': { id: 'c1', stato: 'non_spostato' },
    });
    render(
      <MemoryRouter>
        <AuraDoctorChangesToday />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: /Cambi di medico nello studio/ }),
    ).toBeTruthy();
    const row = screen.getByRole('row', { name: /PAZIENTE INVENTATO/ });
    expect(row.textContent).toMatch(/Medico Collega, dal 18\/11\/2026/);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sposta PAZIENTE INVENTATO nell’archivio di Medico Collega',
      }),
    );
    expect(
      await screen.findByText('PAZIENTE INVENTATO: spostato nell’archivio di Medico Collega.'),
    ).toBeTruthy();
    // Il cambio come si vede: medico scelto e data, perché il servizio controlli che sia quello.
    const sent = fetchMock.mock.calls.find(([u]) => u === '/api/aura/cambi-medico/c1/sposta');
    expect(sent?.[1]?.method).toBe('POST');
    expect(JSON.parse(sent?.[1]?.body as string)).toEqual({
      medico: 'u2',
      sceltaDal: '2026-11-18',
    });
    // L'elenco si ricarica dopo il clic.
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/aura/cambi-medico').length).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Non spostare PAZIENTE INVENTATO' }));
    expect(
      await screen.findByText(
        'PAZIENTE INVENTATO: resta nel tuo archivio. Non si ripropone finché AURA non manda una scelta nuova.',
      ),
    ).toBeTruthy();
  });

  it('cambi di medico: con ricette aperte il motivo si legge; il medico scelto è informato, senza pulsanti né collegamento; senza cambi, niente', async () => {
    const message =
      'Prima dello spostamento vanno chiuse nell’archivio: 1 ricetta da firmare, 1 certificato in bozza';
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const conflict = init?.method === 'POST';
        const body = conflict
          ? { errore: message }
          : {
              disponibile: true,
              daDecidere: [
                {
                  id: 'c2',
                  paziente: { id: 'p4', cognome: 'ALTRO', nome: 'PAZIENTE' },
                  medico: 'Medico Collega',
                  sceltaDal: '2026-11-18',
                },
              ],
              inArrivo: [
                {
                  id: 'c3',
                  paziente: { cognome: 'TERZO', nome: 'PAZIENTE' },
                  daMedico: 'Medico Titolare',
                  sceltaDal: '2026-11-17',
                },
              ],
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: conflict ? 409 : 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    const first = render(
      <MemoryRouter>
        <AuraDoctorChangesToday />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sposta PAZIENTE ALTRO nell’archivio di Medico Collega',
      }),
    );
    expect(await screen.findByText(message)).toBeTruthy();
    // Chi è stato scelto lo sa, ma la cartella non è nel suo archivio: niente collegamento.
    const incoming = screen.getByText(/PAZIENTE TERZO ti ha scelto in AURA dal 17\/11\/2026/);
    expect(incoming.textContent).toContain('è ancora nell’archivio di Medico Titolare');
    expect(incoming.closest('li')!.querySelectorAll('a, button')).toHaveLength(0);
    first.unmount();
    vi.unstubAllGlobals();
    stub({ 'GET /api/aura/cambi-medico': { disponibile: true, daDecidere: [], inArrivo: [] } });
    const second = render(
      <MemoryRouter>
        <AuraDoctorChangesToday />
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
