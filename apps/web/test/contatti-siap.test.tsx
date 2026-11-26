import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { ContactView, Listing } from '../src/pages/SiapContactsPage';

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}
type Handler = (call: Call) => { status: number; body: unknown };

/** Servizio simulato: una risposta per metodo e indirizzo; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const [path = '', search = ''] = url.split('?');
      const method = init?.method ?? 'GET';
      const call = {
        method,
        path,
        search,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const handler = routes[`${method} ${path}`] ?? routes[path];
      const r = handler ? handler(call) : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

const ok = (body: unknown) => () => ({ status: 200, body });

const OWNER = {
  id: 'u1',
  nome: 'Dott.ssa Titolare Inventata',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: { id: 'a1', nome: 'Archivio di prova' },
};
const SUBSTITUTE = {
  ...OWNER,
  id: 'u2',
  nome: 'Dott. Sostituto Inventato',
  ruoli: [{ codice: 'substitute_doctor', nome: 'Medico sostituto' }],
  archivio: null,
};
const SECRETARY = {
  ...OWNER,
  id: 'u3',
  nome: 'Segreteria Inventata',
  ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
  archivio: null,
};

const DAY = '2026-11-24';
const proposal = {
  modalita: 'office',
  regime: 'choice',
  accesso: 'scheduled',
  problema: 'V70.0',
  statoProblema: 'unknown',
  prestazioni: [
    { tipologia: 1, dettaglio: 2, quantita: 1 },
    { tipologia: 8, dettaglio: 1, quantita: 1 },
  ],
};
const proposed: ContactView = {
  id: null,
  paziente: { id: 'p1', cognome: 'Prova', nome: 'Anna', codiceFiscale: 'PRVNNA70A41X001A' },
  giorno: DAY,
  stato: 'proposto',
  atti: [
    { tipo: 'diary', id: 'e1', descrizione: 'Nota del diario, in studio', nuovo: false },
    { tipo: 'pharma', id: 'r1', descrizione: 'Ricetta farmaceutica SSN, 1 farmaco', nuovo: false },
  ],
  attiTolti: 0,
  proposta: proposal,
  aggiornamento: null,
  contatto: null,
};
const toUpdate: ContactView = {
  id: 'c2',
  paziente: { id: 'p2', cognome: 'Esempio', nome: 'Bruno', codiceFiscale: 'SMPBRN60A01X001B' },
  giorno: DAY,
  stato: 'da_aggiornare',
  atti: [
    { tipo: 'diary', id: 'e2', descrizione: 'Nota del diario, in studio', nuovo: false },
    { tipo: 'diary', id: 'e3', descrizione: 'Nota del diario, al telefono', nuovo: true },
  ],
  attiTolti: 0,
  proposta: {
    ...proposal,
    accesso: 'direct',
    prestazioni: [
      { tipologia: 1, dettaglio: 2, quantita: 1 },
      { tipologia: 1, dettaglio: 4, quantita: 1 },
    ],
  },
  aggiornamento: [
    { tipologia: 1, dettaglio: 2, quantita: 1 },
    { tipologia: 1, dettaglio: 4, quantita: 1 },
  ],
  contatto: {
    progressivo: 3,
    struttura: { codice: 'PROVA1', tipo: 'gp_office' },
    modalita: 'home',
    regime: 'choice',
    accesso: 'direct',
    problema: { codice: '000.0', stato: 'evolving', apertoIl: '2026-01-01', voce: 'pb2' },
    prestazioni: [{ tipologia: 1, dettaglio: 2, quantita: 1 }],
    motivoScarto: null,
    decisoIl: '2026-11-24T10:00:00.000Z',
  },
};

const listing = (contatti: ContactView[], codice: string | null = 'PROVA1'): Listing => ({
  dal: DAY,
  al: DAY,
  struttura: { codice, tipo: 'gp_office' },
  contatti,
  problemi: {
    p1: [
      {
        voce: 'pb1',
        codice: '401.9',
        descrizione: 'Problema inventato',
        cronico: true,
        quesito: false,
        inizio: '2026-01-01',
      },
    ],
    p2: [
      {
        voce: 'pb2',
        codice: '000.0',
        descrizione: 'Problema di prova',
        cronico: false,
        quesito: false,
        inizio: '2026-01-01',
      },
    ],
  },
  tipologie: [
    {
      codice: 1,
      descrizione: 'Visite',
      dettagli: [
        { codice: 1, descrizione: 'Prima visita' },
        { codice: 2, descrizione: 'Visita di controllo' },
        { codice: 3, descrizione: 'Visione esami o referti medici' },
        { codice: 4, descrizione: 'Altro' },
      ],
    },
    {
      codice: 8,
      descrizione: 'Prescrizioni farmaceutiche',
      dettagli: [
        { codice: 1, descrizione: 'Rinnovo farmaci continuativi' },
        { codice: 2, descrizione: 'Nuovi farmaci' },
        { codice: 9, descrizione: 'Altro' },
      ],
    },
    {
      codice: 11,
      descrizione: 'Informazione ed educazione sanitaria a pazienti e familiari',
      dettagli: [{ codice: 1, descrizione: 'Stili di vita positivi per la salute' }],
    },
  ],
  modalita: [
    { chiave: 'office', codice: 1, descrizione: 'Presso lo studio' },
    { chiave: 'home', codice: 2, descrizione: 'Presso il domicilio' },
    { chiave: 'unknown', codice: 9, descrizione: 'Non noto' },
  ],
  accessi: [
    { chiave: 'scheduled', codice: 1, descrizione: 'Programmato' },
    { chiave: 'direct', codice: 2, descrizione: 'Diretto' },
    { chiave: 'unknown', codice: 9, descrizione: 'Non noto' },
  ],
  statiProblema: [
    { chiave: 'evolving', codice: 2, descrizione: 'In evoluzione' },
    { chiave: 'chronic', codice: 3, descrizione: 'Associato alla patologia cronica' },
    { chiave: 'unknown', codice: 9, descrizione: 'Non noto' },
  ],
});

const open = (me: unknown, data: Listing) => {
  window.history.pushState({}, '', `/archivio/contatti-siap?dal=${DAY}&al=${DAY}`);
  const calls = stubFetch({
    '/api/io': ok(me),
    '/api/oggi': ok({}),
    '/api/siap/contatti': ok(data),
    'POST /api/siap/contatti/conferma': () => ({
      status: 201,
      body: { id: 'c1', progressivo: 1 },
    }),
    'PUT /api/siap/contatti/c2': ok({ id: 'c2', progressivo: 3 }),
    'POST /api/siap/contatti/scarta': ok({ id: 'c1' }),
  });
  render(<App />);
  return calls;
};

describe('Contatti per il SIAP nell’interfaccia (D291)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('il contatto proposto: atti, modalità, accesso, attività con i nomi del Ministero; «Conferma» manda la proposta', async () => {
    const calls = open(OWNER, listing([proposed]));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Contatti per il SIAP' }),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        'Dal 24/11/2026 al 24/11/2026: 1 contatto — 1 da confermare, 0 da aggiornare, 0 confermati, 0 scartati.',
      ),
    ).toBeTruthy();
    const card = screen.getByRole('listitem', { name: /Prova Anna/ });
    expect(within(card).getByText('Proposto')).toBeTruthy();
    expect(within(card).getByText('Ricetta farmaceutica SSN, 1 farmaco')).toBeTruthy();
    expect(within(card).getByText('Presso lo studio')).toBeTruthy();
    expect(within(card).getByText('Programmato')).toBeTruthy();
    const table = within(card).getByRole('table', { name: 'Attività e prestazioni proposte' });
    expect(
      within(table).getByRole('row', {
        name: '8 Prescrizioni farmaceutiche 1 Rinnovo farmaci continuativi 1',
      }),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Conferma' }));
    expect(
      await screen.findByText(
        'Contatto di Prova Anna del 24/11/2026 confermato: numero 1 del giorno.',
      ),
    ).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/siap/contatti/conferma');
    expect(post?.body).toEqual({
      paziente: 'p1',
      giorno: DAY,
      modalita: 'office',
      accesso: 'scheduled',
      problema: null,
      prestazioni: proposal.prestazioni,
    });
  });

  it('«Cambia e conferma»: modalità, problema, quantità, un’attività in più e una in meno', async () => {
    const calls = open(OWNER, listing([proposed]));
    const card = await screen.findByRole('listitem', { name: /Prova Anna/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Cambia e conferma' }));
    fireEvent.change(within(card).getByLabelText('Modalità'), { target: { value: 'home' } });
    fireEvent.change(within(card).getByLabelText('Problema'), { target: { value: 'pb1' } });
    const quantities = within(card).getAllByLabelText('Quantità');
    fireEvent.change(quantities[0]!, { target: { value: '2' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Aggiungi un’attività' }));
    // La tipologia nuova porta il suo primo dettaglio.
    const typologies = within(card).getAllByLabelText('Tipologia');
    fireEvent.change(typologies[2]!, { target: { value: '11' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Togli l’attività 2' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Conferma' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/siap/contatti/conferma')).toBe(true),
    );
    const post = calls.find((c) => c.path === '/api/siap/contatti/conferma')!;
    expect(post.body).toEqual({
      paziente: 'p1',
      giorno: DAY,
      modalita: 'home',
      accesso: 'scheduled',
      problema: 'pb1',
      prestazioni: [
        { tipologia: 1, dettaglio: 2, quantita: 2 },
        { tipologia: 11, dettaglio: 1, quantita: 1 },
      ],
    });
  });

  it('da aggiornare: l’atto nuovo segnato, e «Aggiorna con gli atti nuovi» tiene le scelte del medico', async () => {
    const calls = open(OWNER, listing([toUpdate]));
    const card = await screen.findByRole('listitem', { name: /Esempio Bruno/ });
    expect(within(card).getByText('Da aggiornare, n. 3')).toBeTruthy();
    expect(within(card).getByText('dopo la conferma')).toBeTruthy();
    expect(
      within(card).getByRole('table', { name: 'Con gli atti nuovi diventerebbero' }),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Aggiorna con gli atti nuovi' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/siap/contatti/c2',
      body: {
        modalita: 'home',
        accesso: 'direct',
        problema: 'pb2',
        prestazioni: toUpdate.aggiornamento,
      },
    });
  });

  it('«Scarta» chiede il motivo e lo manda', async () => {
    const calls = open(OWNER, listing([proposed]));
    const card = await screen.findByRole('listitem', { name: /Prova Anna/ });
    fireEvent.click(within(card).getByRole('button', { name: 'Scarta' }));
    fireEvent.change(within(card).getByLabelText('Motivo dello scarto'), {
      target: { value: 'Stesso episodio di ieri' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Scarta il contatto' }));
    expect(await screen.findByText('Contatto di Prova Anna del 24/11/2026 scartato.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/siap/contatti/scarta')?.body).toEqual({
      paziente: 'p1',
      giorno: DAY,
      motivo: 'Stesso episodio di ieri',
    });
  });

  it('senza il codice della struttura lo dice, e i contatti si confermano lo stesso', async () => {
    open(OWNER, listing([proposed], null));
    expect(
      await screen.findByText(/Il codice della struttura per il SIAP non c’è ancora/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conferma' })).toBeTruthy();
  });

  it('il sostituto ha «Contatti SIAP» nel menu; la segreteria no', async () => {
    open(SUBSTITUTE, listing([]));
    expect(await screen.findByRole('link', { name: 'Contatti SIAP' })).toBeTruthy();
    expect(
      await screen.findByText('Nel periodo non ci sono atti tuoi che facciano un contatto.'),
    ).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    open(SECRETARY, listing([]));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Contatti per il SIAP' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Contatti SIAP' })).toBeNull();
  });
});
