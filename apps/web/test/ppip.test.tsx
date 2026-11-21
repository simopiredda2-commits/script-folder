import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { parseMonth } from '../src/pages/PpipReportPage';

type Handler = (method: string, body: unknown, search: string) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; search: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const [path = '', search = ''] = url.split('?');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, search, body });
      const handler = routes[path];
      const r = handler
        ? handler(method, body, search)
        : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(
        new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

const ok = (body: unknown) => () => ({ status: 200, body });

const me = (role: 'owner_doctor' | 'secretary') => ({
  id: 'u1',
  nome: role === 'owner_doctor' ? 'Dott.ssa Titolare Inventata' : 'Segreteria Inventata',
  ruoli: [{ codice: role, nome: role }],
  postazione: 'Studio',
  archivio: role === 'owner_doctor' ? { id: 'a1', nome: 'Archivio di prova' } : null,
});

const PATIENT = {
  paziente: {
    id: 'p1',
    firstName: 'Lina',
    lastName: 'Rota',
    sex: 'F',
    birthDate: '1950-01-01',
    birthPlaceName: null,
    fiscalCode: 'RTOLNI50A41X000A',
    phone: null,
    email: null,
    asl: null,
    status: 'active',
    deceasedOn: null,
  },
  riepilogo: null,
};

const CATALOG = {
  data: '2026-10-05',
  voci: [
    {
      codice: 'A1',
      sezione: 'A',
      descrizione: 'Prima medicazione',
      autorizzazione: false,
      compenso: 12.32,
      note: 'Per la prima medicazione va intesa quella eseguita su ferita non precedentemente medicata.',
      atto: 'ACN 2022-2024, allegato 6',
      inVigoreDal: '2026-01-15',
    },
    {
      codice: 'B2',
      sezione: 'B',
      descrizione: 'Ciclo curativo di iniezioni endovenose (per ogni iniezione)',
      autorizzazione: true,
      compenso: 6.16,
      note: null,
      atto: 'ACN 2022-2024, allegato 6',
      inVigoreDal: '2026-01-15',
    },
    {
      codice: 'AIR35.4',
      sezione: 'AIR Piemonte',
      descrizione: 'Trasfusione di sangue intero o dei suoi derivati, in ADI o in ADR',
      autorizzazione: false,
      compenso: 55,
      note: null,
      atto: 'AIR Piemonte 2024, art. 35, comma 4',
      inVigoreDal: '2025-01-01',
    },
  ],
};

const record = (over: Record<string, unknown>) => ({
  id: 'r1',
  data: '2026-10-05',
  codice: 'A1',
  sezione: 'A',
  descrizione: 'Prima medicazione',
  quantita: 1,
  luogo: 'studio',
  nomeLuogo: 'In studio',
  autorizzazione: null,
  compensoUnitario: 12.32,
  importo: 12.32,
  note: null,
  stato: 'registrata',
  motivoAnnullamento: null,
  inviata: false,
  inInvio: false,
  protocolloInvio: null,
  registrataDa: 'Dott.ssa Titolare Inventata',
  altroArchivio: null,
  ...over,
});

describe('prestazioni aggiuntive in cartella (D212)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
    window.sessionStorage.clear();
  });

  it('voci per sezione con il compenso; la sezione B chiede l’autorizzazione', async () => {
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/pazienti/p1/ppip': (method) =>
        method === 'POST'
          ? { status: 201, body: { id: 'r9' } }
          : {
              status: 200,
              body: {
                puoScrivere: true,
                archivio: 'a1',
                prestazioni: [
                  record({}),
                  record({
                    id: 'r2',
                    codice: 'B2',
                    descrizione: 'Ciclo curativo di iniezioni endovenose (per ogni iniezione)',
                    quantita: 3,
                    importo: 18.48,
                    inviata: true,
                    protocolloInvio: 'SIM-PPIP-2026-10-0001',
                    autorizzazione: 'Distretto n. 12',
                  }),
                ],
              },
            },
      '/api/prestazioni-aggiuntive/catalogo': ok(CATALOG),
    });
    window.history.pushState({}, '', '/pazienti/p1/prestazioni-aggiuntive');
    render(<App />);
    const select = await screen.findByLabelText('Prestazione');
    await within(select).findByRole('option', { name: /A1 · Prima medicazione/ });
    // Il catalogo con gli accordi della regione e dell'ASL dell'archivio (D232).
    expect(calls.find((c) => c.path === '/api/prestazioni-aggiuntive/catalogo')?.search).toMatch(
      /(^|&)archivio=a1(&|$)/,
    );
    expect([...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))).toEqual([
      'A · eseguibili senza autorizzazione',
      'B · eseguibili con autorizzazione sanitaria',
      'AIR Piemonte',
    ]);
    expect(
      within(select).getByRole('option', { name: /A1 · Prima medicazione/ }).textContent,
    ).toMatch(/12,32\s€/);
    const auth = screen.getByLabelText<HTMLInputElement>(/Estremi dell’autorizzazione/);
    expect(auth.required).toBe(false);
    fireEvent.change(select, { target: { value: 'B2' } });
    expect(screen.getByLabelText<HTMLInputElement>(/Estremi dell’autorizzazione/).required).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText(/Estremi dell’autorizzazione/), {
      target: { value: 'Distretto n. 13' },
    });
    fireEvent.change(screen.getByLabelText('Quantità'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('A domicilio'));
    fireEvent.click(screen.getByRole('button', { name: 'Registra la prestazione' }));
    await screen.findByText('Prestazione registrata.');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/pazienti/p1/ppip');
    expect(post?.body).toEqual({
      data: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      codice: 'B2',
      quantita: 2,
      luogo: 'domicilio',
      autorizzazione: 'Distretto n. 13',
    });
    // Elenco: da inviare si annulla; inviata no, e dice il protocollo.
    const list = screen.getByRole('heading', { name: 'Prestazioni registrate' }).parentElement!;
    expect(within(list).getByText('Da inviare')).toBeTruthy();
    expect(within(list).getByText('Inviata all’ASL (SIM-PPIP-2026-10-0001)')).toBeTruthy();
    expect(within(list).getAllByRole('button', { name: /^Annulla/ })).toHaveLength(1);
  });

  it('una prestazione di un altro archivio o in invio si legge e basta (D232)', async () => {
    stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/pazienti/p1/ppip': ok({
        puoScrivere: true,
        archivio: 'a1',
        prestazioni: [
          record({ id: 'r1', altroArchivio: 'Archivio della dottoressa di prima' }),
          record({ id: 'r2', codice: 'A3', descrizione: 'Rimozione di punti', inInvio: true }),
          record({ id: 'r3', codice: 'A4', descrizione: 'Cateterismo uretrale' }),
        ],
      }),
      '/api/prestazioni-aggiuntive/catalogo': ok(CATALOG),
    });
    window.history.pushState({}, '', '/pazienti/p1/prestazioni-aggiuntive');
    render(<App />);
    const list = (await screen.findByRole('heading', { name: 'Prestazioni registrate' }))
      .parentElement!;
    await within(list).findByText(
      /Nella distinta dell’archivio «Archivio della dottoressa di prima», che aveva il paziente il giorno dell’esecuzione: lì si annulla/,
    );
    expect(within(list).getByText('In invio con la distinta')).toBeTruthy();
    // Si annulla solo la terza: le altre sono nella distinta di un altro archivio o partono.
    const buttons = within(list).getAllByRole('button', { name: /^Annulla/ });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toMatch(/A4/);
  });

  it('dopo «Sposta»: la distinta di chi aveva il paziente quel giorno; il giorno dello spostamento si sceglie (D240)', async () => {
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/pazienti/p1/ppip': (method) =>
        method === 'POST'
          ? { status: 201, body: { id: 'r9' } }
          : {
              status: 200,
              body: {
                puoScrivere: true,
                archivio: 'a1',
                prestazioni: [],
                spostamenti: [
                  {
                    giorno: '2026-11-18',
                    da: 'a0',
                    daNome: 'Archivio della dottoressa di prima',
                    a: 'a1',
                    aNome: 'Archivio di prova',
                  },
                ],
              },
            },
      '/api/prestazioni-aggiuntive/catalogo': ok(CATALOG),
    });
    window.history.pushState({}, '', '/pazienti/p1/prestazioni-aggiuntive');
    render(<App />);
    const select = await screen.findByLabelText('Prestazione');
    await within(select).findByRole('option', { name: /A1 · Prima medicazione/ });
    const day = screen.getByLabelText('Data dell’esecuzione');
    // Prima dello spostamento: la distinta della dottoressa di prima, con il suo catalogo.
    fireEvent.change(day, { target: { value: '2026-11-17' } });
    await screen.findByText(
      /Va nella distinta dell’archivio «Archivio della dottoressa di prima»: il 17\/11\/2026 il paziente era nel suo archivio/,
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === '/api/prestazioni-aggiuntive/catalogo').at(-1)?.search,
      ).toMatch(/(^|&)archivio=a0(&|$)/),
    );
    // Dopo: la propria, senza avvisi.
    fireEvent.change(day, { target: { value: '2026-11-19' } });
    expect(screen.queryByText(/Va nella distinta dell’archivio/)).toBeNull();
    expect(screen.queryByRole('group', { name: /In quale distinta va/ })).toBeNull();
    // Il giorno dello spostamento: si sceglie, e senza scelta non parte niente.
    fireEvent.change(day, { target: { value: '2026-11-18' } });
    const group = screen.getByRole('group', { name: /In quale distinta va\? Il 18\/11\/2026/ });
    const radios = within(group).getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((r) => r.required)).toEqual([true, true]);
    expect(within(group).getByLabelText(/Archivio di prova \(dopo lo spostamento\)/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'A1' } });
    // Il browser ferma il modulo con il gruppo obbligatorio vuoto; se lo manda lo stesso, lo ferma
    // la pagina.
    expect(radios[0]!.validity.valueMissing).toBe(true);
    fireEvent.submit(select.closest('form')!);
    await screen.findByText(/scegli in quale distinta va la prestazione/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(
      within(group).getByLabelText(
        /Archivio della dottoressa di prima \(prima dello spostamento\)/,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Registra la prestazione' }));
    await screen.findByText('Prestazione registrata.');
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/pazienti/p1/ppip');
    expect(post?.body).toMatchObject({ data: '2026-11-18', codice: 'A1', archivio: 'a0' });
  });

  it('senza catalogo in vigore lo dice, con simbolo e parola', async () => {
    stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/pazienti/p1': ok(PATIENT),
      '/api/pazienti/p1/ppip': ok({ puoScrivere: true, prestazioni: [] }),
      '/api/prestazioni-aggiuntive/catalogo': ok({ data: '2026-11-20', voci: [] }),
    });
    window.history.pushState({}, '', '/pazienti/p1/prestazioni-aggiuntive');
    render(<App />);
    const notice = await screen.findByText(
      /Nessun catalogo delle prestazioni aggiuntive in vigore/,
    );
    expect(notice.closest('[class*="avviso"]')?.querySelector('svg')).toBeTruthy();
  });
});

const DISTINTA = (puoInviare: boolean, daInviare = 2) => ({
  mese: '2026-10',
  scadenza: '2026-11-15',
  righe: [
    {
      id: 'r1',
      paziente: 'p1',
      data: '2026-10-05',
      cognome: 'Rota',
      nome: 'Lina',
      indirizzo: 'Via di Prova 1, 10100 Torino (TO)',
      codiceFiscale: 'RTOLNI50A41X000A',
      codice: 'A1',
      descrizione: 'Prima medicazione',
      quantita: 1,
      luogo: 'In studio',
      autorizzazione: null,
      importo: 12.32,
      inviata: false,
      inInvioDal: null,
      pazienteNellArchivio: true,
      protocolloInvio: null,
    },
    {
      id: 'r2',
      paziente: 'p1',
      data: '2026-10-07',
      cognome: 'Rota',
      nome: 'Lina',
      indirizzo: 'Via di Prova 1, 10100 Torino (TO)',
      codiceFiscale: 'RTOLNI50A41X000A',
      codice: 'B2',
      descrizione: 'Ciclo curativo di iniezioni endovenose (per ogni iniezione)',
      quantita: 3,
      luogo: 'A domicilio',
      autorizzazione: 'Distretto n. 12',
      importo: 18.48,
      inviata: false,
      inInvioDal: null,
      pazienteNellArchivio: true,
      protocolloInvio: null,
    },
  ],
  perVoce: [
    { codice: 'A1', descrizione: 'Prima medicazione', quantita: 1, importo: 12.32 },
    {
      codice: 'B2',
      descrizione: 'Ciclo curativo di iniezioni endovenose (per ogni iniezione)',
      quantita: 3,
      importo: 18.48,
    },
  ],
  totale: 30.8,
  daInviare,
  inInvio: null as { dal: string; interrotto: boolean; righe: number } | null,
  invii: [] as unknown[],
  puoInviare,
  puoAnnullare: true,
  invioAttivo: true,
  invioSimulato: true,
  formati: [
    {
      id: 'acn-allegato-6',
      titolo: 'Distinta con i campi dell’allegato 6 dell’ACN',
      fonte: 'ACN della medicina generale 2022-2024, allegato 6, comma 4.',
    },
  ],
});

describe('distinta del mese nell’archivio (D212)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('il titolare: righe, per voce, scadenza, CSV; invia solo dopo il controllo', async () => {
    let sent = false;
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': () => ({ status: 200, body: DISTINTA(true, sent ? 0 : 2) }),
      '/api/archivi/a1/ppip/invio': () => {
        sent = true;
        return {
          status: 200,
          body: { esito: 'accepted', protocollo: 'SIM-PPIP-2026-10-0001', righe: 2, totale: 30.8 },
        };
      },
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    await screen.findByText(
      /Distinta di ottobre 2026: 2 prestazioni, 30,80\s€; da inviare entro il 15\/11\/2026/,
    );
    const table = screen.getByRole('table', {
      name: 'Distinta di ottobre 2026, una riga per prestazione',
    });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    // Due righe dello stesso paziente: il codice fiscale c'è in tutte e due.
    expect(within(table).getAllByText('RTOLNI50A41X000A')).toHaveLength(2);
    expect(within(table).getByText('Autorizzazione: Distretto n. 12')).toBeTruthy();
    const byService = screen.getByRole('table', {
      name: 'Quantità e importo per voce del catalogo',
    });
    expect(within(byService).getByRole('row', { name: /Totale 4 30,80/ })).toBeTruthy();
    const csv = screen.getByRole('link', { name: 'Scarica la distinta in CSV' });
    expect(csv.getAttribute('href')).toBe(
      '/api/archivi/a1/ppip/esportazione?mese=2026-10&formato=acn-allegato-6',
    );
    expect(
      screen.getByText(/Invio simulato: il collegamento vero si scrive quando Regione e ASL/),
    ).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Invia all’ASL 2 prestazioni' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Ho controllato la distinta/));
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await screen.findByText('Distinta inviata: 2 prestazioni, protocollo SIM-PPIP-2026-10-0001.');
    // Partono le prestazioni che il titolare ha visto (D232).
    expect(calls.find((c) => c.path === '/api/archivi/a1/ppip/invio')?.body).toEqual({
      mese: '2026-10',
      righe: ['r1', 'r2'],
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: /Invia all’ASL/ })).toBeNull());
  });

  it('la segreteria prepara e scarica; la distinta la manda il titolare', async () => {
    stubFetch({
      '/api/io': ok(me('secretary')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': ok(DISTINTA(false)),
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    await screen.findByText('La distinta la manda il medico titolare dell’archivio.');
    expect(screen.getByRole('link', { name: 'Scarica la distinta in CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Invia all’ASL/ })).toBeNull();
  });

  it('senza l’invio dal programma: la distinta consegnata a mano si segna, con le righe viste (D232)', async () => {
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': ok({ ...DISTINTA(true), invioAttivo: false, invioSimulato: true }),
      '/api/archivi/a1/ppip/consegna': ok({ righe: 2, totale: 30.8 }),
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    await screen.findByText(/L’invio dal programma non è ancora collegato/);
    expect(screen.queryByRole('button', { name: /Invia all’ASL/ })).toBeNull();
    expect(screen.queryByText(/Invio simulato/)).toBeNull();
    fireEvent.click(screen.getByText('Consegnata all’ASL fuori dal programma'));
    const mark = screen.getByRole('button', { name: 'Segna come consegnate 2 prestazioni' });
    expect((mark as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText('Ho consegnato all’ASL la distinta con queste prestazioni'),
    );
    fireEvent.change(screen.getByLabelText('Riferimento della consegna (facoltativo)'), {
      target: { value: 'Caricata il 20/11' },
    });
    fireEvent.click(mark);
    await screen.findByText('Distinta segnata come consegnata all’ASL: 2 prestazioni.');
    expect(calls.find((c) => c.path === '/api/archivi/a1/ppip/consegna')?.body).toEqual({
      mese: '2026-10',
      righe: ['r1', 'r2'],
      riferimento: 'Caricata il 20/11',
    });
  });

  it('un invio rimasto senza risposta: si dice, e il titolare segna l’esito chiesto all’ASL', async () => {
    const base = DISTINTA(true, 0);
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': ok({
        ...base,
        righe: base.righe.map((r) => ({ ...r, inInvioDal: '2026-11-20T09:00:00.000Z' })),
        inInvio: { dal: '2026-11-20T09:00:00.000Z', interrotto: true, righe: 2 },
      }),
      '/api/archivi/a1/ppip/esito': ok({ righe: 2, esito: 'non_arrivata' }),
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    await screen.findByText(/è rimasto senza risposta: le 2 prestazioni restano «in invio»/);
    expect(screen.getAllByText('In invio')).toHaveLength(2);
    // Mentre una prestazione parte non si annulla, nemmeno dalla distinta.
    expect(screen.queryByRole('button', { name: /^Annulla/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Non è arrivata: torna da inviare' }));
    // Prima si conferma (WCAG 3.3.4, D239): niente parte finché non si dice sì.
    const confirm = screen.getByRole('group', { name: 'Conferma dell’esito' });
    expect(within(confirm).getByText(/Confermi che la distinta/)).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/archivi/a1/ppip/esito')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Sì, confermo' }));
    await screen.findByText(
      /Segnato: la distinta non è arrivata\. 2 prestazioni tornano da inviare\./,
    );
    expect(calls.find((c) => c.path === '/api/archivi/a1/ppip/esito')?.body).toEqual({
      mese: '2026-10',
      esito: 'non_arrivata',
    });
    // Il fuoco va al risultato, non alla pagina (WCAG 2.4.3).
    await waitFor(() => expect(document.activeElement?.className).toBe('esito-distinta'));
  });

  it('«Torna indietro» non segna l’esito', async () => {
    const base = DISTINTA(true, 0);
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': ok({
        ...base,
        righe: base.righe.map((r) => ({ ...r, inInvioDal: '2026-11-20T09:00:00.000Z' })),
        inInvio: { dal: '2026-11-20T09:00:00.000Z', interrotto: true, righe: 2 },
      }),
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'È arrivata all’ASL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Torna indietro' }));
    expect(screen.queryByRole('group', { name: 'Conferma dell’esito' })).toBeNull();
    expect(calls.some((c) => c.path === '/api/archivi/a1/ppip/esito')).toBe(false);
  });

  it('«Ho controllato» vale per le prestazioni viste: se la distinta cambia si toglie (D239)', async () => {
    let annulled = false;
    const base = DISTINTA(true);
    stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': () => ({
        status: 200,
        body: annulled ? { ...base, righe: [base.righe[0]!], daInviare: 1 } : base,
      }),
      '/api/archivi/a1/ppip/r2/annulla': () => {
        annulled = true;
        return { status: 200, body: { id: 'r2', stato: 'annullata' } };
      },
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    const box = await screen.findByLabelText<HTMLInputElement>(/Ho controllato la distinta/);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    // Una prestazione esce dalla distinta: le righe da inviare non sono più quelle controllate.
    fireEvent.click(screen.getAllByRole('button', { name: /^Annulla/ })[1]!);
    fireEvent.change(screen.getByLabelText('Motivo dell’annullamento'), {
      target: { value: 'Registrata due volte' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conferma l’annullamento' }));
    await screen.findByRole('button', { name: 'Invia all’ASL 1 prestazione' });
    expect(screen.getByLabelText<HTMLInputElement>(/Ho controllato la distinta/).checked).toBe(
      false,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Invia all’ASL 1 prestazione' })
        .disabled,
    ).toBe(true);
  });

  it('l’annullamento dalla distinta parte una volta sola, anche con due clic (D239)', async () => {
    let posts = 0;
    let answer: () => void = () => {};
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io') return Promise.resolve(json(me('owner_doctor')));
        if (path === '/api/oggi')
          return Promise.resolve(json({ data: '2026-11-20', appuntamenti: [], code: {} }));
        if (path === '/api/ppip/archivi')
          return Promise.resolve(json({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }));
        if (path === '/api/archivi/a1/ppip') return Promise.resolve(json(DISTINTA(true)));
        if (path === '/api/archivi/a1/ppip/r1/annulla') {
          posts += 1;
          return new Promise<Response>((r) => {
            answer = () => r(json({ id: 'r1', stato: 'annullata' }));
          });
        }
        return Promise.resolve(json({}));
      }),
    );
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Annulla/ }))[0]!);
    fireEvent.change(screen.getByLabelText('Motivo dell’annullamento'), {
      target: { value: 'Registrata due volte' },
    });
    const confirm = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Conferma l’annullamento',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(posts).toBe(1);
    answer();
    await screen.findByText('Prestazione A1 di Rota Lina annullata.');
  });

  it('dopo l’esito i pulsanti restano spenti finché la distinta non è ricaricata (D239)', async () => {
    const base = DISTINTA(true, 0);
    const interrupted = {
      ...base,
      righe: base.righe.map((r) => ({ ...r, inInvioDal: '2026-11-20T09:00:00.000Z' })),
      inInvio: { dal: '2026-11-20T09:00:00.000Z', interrotto: true, righe: 2 },
    };
    let loads = 0;
    let release: () => void = () => {};
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io') return Promise.resolve(json(me('owner_doctor')));
        if (path === '/api/oggi')
          return Promise.resolve(json({ data: '2026-11-20', appuntamenti: [], code: {} }));
        if (path === '/api/ppip/archivi')
          return Promise.resolve(json({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }));
        if (path === '/api/archivi/a1/ppip/esito')
          return Promise.resolve(json({ righe: 2, esito: 'non_arrivata' }));
        if (path === '/api/archivi/a1/ppip') {
          loads += 1;
          if (loads === 1) return Promise.resolve(json(interrupted));
          // La distinta ricaricata arriva quando la prova lo dice.
          return new Promise<Response>((r) => {
            release = () => r(json({ ...base, daInviare: 2 }));
          });
        }
        return Promise.resolve(json({}));
      }),
    );
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Non è arrivata: torna da inviare' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sì, confermo' }));
    await screen.findByText(/Segnato: la distinta non è arrivata/);
    await waitFor(() => expect(loads).toBe(2));
    // La distinta di prima è ancora lì, ma i suoi pulsanti non si premono.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Non è arrivata: torna da inviare' })
        .disabled,
    ).toBe(true);
    release();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Non è arrivata: torna da inviare' })).toBeNull(),
    );
  });

  it('dalla distinta: annullamento con il motivo; il paziente passato a un altro medico senza collegamento', async () => {
    const base = DISTINTA(true);
    const calls = stubFetch({
      '/api/io': ok(me('owner_doctor')),
      '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/ppip/archivi': ok({ archivi: [{ id: 'a1', nome: 'Archivio di prova' }] }),
      '/api/archivi/a1/ppip': ok({
        ...base,
        righe: [
          { ...base.righe[0]!, pazienteNellArchivio: false, indirizzo: null },
          base.righe[1]!,
        ],
      }),
      '/api/archivi/a1/ppip/r1/annulla': ok({ id: 'r1', stato: 'annullata' }),
    });
    window.history.pushState({}, '', '/archivio/prestazioni-aggiuntive?mese=2026-10');
    render(<App />);
    const table = await screen.findByRole('table', {
      name: 'Distinta di ottobre 2026, una riga per prestazione',
    });
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first!).queryByRole('link')).toBeNull();
    expect(within(first!).getByText('(ora assistito di un altro medico)')).toBeTruthy();
    expect(within(second!).getByRole('link', { name: 'Rota Lina' })).toBeTruthy();
    // L'indirizzo che manca si dice prima di mandare (comma 4).
    expect(
      screen.getByText(/1 prestazione da inviare non ha l’indirizzo dell’assistito/),
    ).toBeTruthy();
    fireEvent.click(within(first!).getByRole('button', { name: /Annulla A1 di Rota Lina/ }));
    fireEvent.change(within(first!).getByLabelText('Motivo dell’annullamento'), {
      target: { value: 'Registrata due volte' },
    });
    fireEvent.click(within(first!).getByRole('button', { name: 'Conferma l’annullamento' }));
    await screen.findByText('Prestazione A1 di Rota Lina annullata.');
    expect(calls.find((c) => c.path === '/api/archivi/a1/ppip/r1/annulla')?.body).toEqual({
      motivo: 'Registrata due volte',
    });
  });

  it('il mese scritto a mano come MM/AAAA, dove il browser non ha il selettore del mese', () => {
    // Safari e Firefox da computer mostrano il campo del mese come testo libero.
    expect(parseMonth('2026-10')).toBe('2026-10');
    expect(parseMonth('10/2026')).toBe('2026-10');
    expect(parseMonth(' 9/2026 ')).toBe('2026-09');
    expect(parseMonth('09.2026')).toBe('2026-09');
    expect(parseMonth('13/2026')).toBeNull();
    expect(parseMonth('0/2026')).toBeNull();
    expect(parseMonth('ottobre 2026')).toBeNull();
  });
});
