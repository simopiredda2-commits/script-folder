import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ErrorMessage } from '../src/components/common';
import { ApiError } from '../src/lib/api';
import { SessionProvider } from '../src/lib/session';
import { SignQueuePage } from '../src/pages/SignQueuePage';

/**
 * Ricetta rimasta «in invio» (D233): nella pagina Ricette, fra gli invii senza risposta, il medico
 * segna l'esito chiesto all'ente; Oggi ne dà il conto. Servizio finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const me = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

const interrupted = (extra: object = {}) => ({
  pazienti: [
    {
      paziente: {
        id: 'p1',
        nome: 'Paola',
        cognome: 'Inventata',
        codiceFiscale: 'XXXXXX00X00X000X',
      },
      ricette: [
        {
          id: 'r1',
          tipo: 'pharma_ssn',
          preparataIl: '2026-11-20T09:00:00Z',
          preparataDa: 'Medico inventato',
          righe: 1,
          errore: null,
          tipoErrore: null,
          firmataIl: '2026-11-20T09:05:00Z',
          firmataDa: 'Medico inventato',
          esitoDal: '2026-11-20T09:20:00Z',
          ...extra,
        },
      ],
    },
  ],
});

const ALL = { promemoria: true, soloNre: true, email: true, sms: true, motivo: null };

/** Il servizio finto: risponde all'esito come la prova chiede, e ne tiene il corpo e le chiamate. */
function service(settled: (body: Record<string, unknown>) => object, extra: object = {}) {
  const bodies: Record<string, unknown>[] = [];
  const red: Record<string, unknown>[] = [];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      calls.push(path);
      if (path === '/api/io') return Promise.resolve(json(200, me));
      if (path === '/api/ricette/da-firmare' || path === '/api/ricette/non-inviate')
        return Promise.resolve(json(200, { pazienti: [] }));
      if (path === '/api/ricette/senza-risposta')
        return Promise.resolve(json(200, interrupted(extra)));
      if (path === '/api/pazienti/p1/ricette')
        return Promise.resolve(
          json(200, {
            ricette: [
              {
                id: 'r1',
                righe: [
                  {
                    id: 'l1',
                    drugName: 'Farmaco di prova 5 mg',
                    serviceDescription: null,
                    quantity: 2,
                  },
                ],
              },
            ],
          }),
        );
      if (path === '/api/ricette/r1/ricetta-rossa') {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        red.push(body);
        return Promise.resolve(
          json(200, {
            nre: '010ZZ4000000002',
            poligrafico: body.poligrafico,
            pdf: '/api/ricette/r1/ricetta-rossa.pdf',
            annullamentoDematerializzata: 'da_fare',
            avviso: null,
          }),
        );
      }
      if (path === '/api/ricette/r1/esito-invio') {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        bodies.push(body);
        return Promise.resolve(json(200, settled(body)));
      }
      if (path === '/api/ricette/r1/promemoria/consegne')
        return Promise.resolve(json(200, { consegne: [], carta: 'A5', disponibile: ALL }));
      if (path === '/api/pazienti/p1/recapiti-promemoria')
        return Promise.resolve(
          json(200, { paziente: { email: null, telefono: null }, deleghe: [] }),
        );
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
  return { bodies, calls, red };
}

function page() {
  render(
    <SessionProvider>
      <MemoryRouter>
        <SignQueuePage />
      </MemoryRouter>
    </SessionProvider>,
  );
}

const section = async () =>
  within(
    (await screen.findByRole('heading', { level: 2, name: 'Invii senza risposta' })).closest(
      'section',
    )!,
  );

describe('invii senza risposta nella pagina Ricette (D233)', () => {
  it('dice quando era partito l’invio, chi l’aveva firmato e che cosa c’era; «Non è arrivata» si conferma e ricarica gli invii non riusciti', async () => {
    // I presidi restano come prima: la ricetta rossa in DPCM è solo farmaceutica e specialistica.
    const { bodies, calls } = service(
      () => ({
        stato: 'error',
        nre: null,
        messaggio:
          'Non arrivata all’ente, secondo l’ente: si può rimandare o stampare la ricetta rossa',
      }),
      { tipo: 'devices' },
    );
    page();
    const s = await section();
    await s.findByRole('link', { name: 'Paola Inventata' });
    expect(s.getByText(/firmato da Medico inventato, è rimasto senza risposta/)).toBeTruthy();
    // Le righe della ricetta: il numero dato dall'ente va sulla ricetta giusta (D239).
    await s.findByText('Farmaco di prova 5 mg × 2');
    await userEvent.click(s.getByRole('button', { name: 'Non è arrivata: torna da inviare' }));
    // Prima si conferma (WCAG 3.3.4): niente parte finché non si dice sì.
    s.getByText(/Confermi che la ricetta/);
    expect(bodies).toEqual([]);
    const failedBefore = calls.filter((c) => c === '/api/ricette/non-inviate').length;
    await userEvent.click(s.getByRole('button', { name: 'Sì, confermo' }));
    await s.findByText('Ricetta di nuovo da inviare: è fra gli invii non riusciti.');
    expect(bodies).toEqual([{ esito: 'non_arrivata' }]);
    await waitFor(() =>
      expect(calls.filter((c) => c === '/api/ricette/non-inviate').length).toBeGreaterThan(
        failedBefore,
      ),
    );
    // Il fuoco va al risultato, non alla pagina: il pulsante premuto non c'è più (WCAG 2.4.3).
    const focused = document.activeElement as HTMLElement;
    expect(focused).not.toBe(document.body);
    expect(focused.className).toBe('esito-segnato');
    expect(focused.textContent).toMatch(/Ricetta di nuovo da inviare/);
  });

  it('«Torna indietro» non segna niente', async () => {
    const { bodies } = service(() => ({ stato: 'error', nre: null, messaggio: null }), {
      tipo: 'devices',
    });
    page();
    const s = await section();
    await userEvent.click(
      await s.findByRole('button', { name: 'Non è arrivata: torna da inviare' }),
    );
    await userEvent.click(s.getByRole('button', { name: 'Torna indietro' }));
    expect(s.getByRole('button', { name: 'Non è arrivata: torna da inviare' })).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  it('«È arrivata» manda l’NRE in maiuscolo e il codice di autenticazione, dopo la conferma; il promemoria resta con il paziente', async () => {
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }));
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    await userEvent.type(within(form).getByLabelText(/Numero di ricetta/), ' man000000000001 ');
    await userEvent.type(within(form).getByLabelText(/Codice di autenticazione/), 'MANAUT0001');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    expect(s.getByText(/Confermi che la ricetta è arrivata con NRE/).textContent).toMatch(
      /MAN000000000001.*MANAUT0001/,
    );
    // Il modulo non c'è più: la domanda prende il fuoco (WCAG 2.4.3, audit D259).
    expect(document.activeElement).toBe(s.getByRole('group', { name: 'Conferma dell’esito' }));
    await userEvent.click(s.getByRole('button', { name: 'Sì, confermo' }));
    await s.findByText(/Ricetta segnata come arrivata/);
    expect(bodies).toEqual([
      { esito: 'arrivata', nre: 'MAN000000000001', codiceAutenticazione: 'MANAUT0001' },
    ]);
    await s.findByRole('heading', { name: 'Promemoria della ricetta di Paola Inventata' });
  });

  it('ricetta SSN: senza il codice di autenticazione «È arrivata» non parte (D240)', async () => {
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }));
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    const code = within(form).getByLabelText<HTMLInputElement>(
      'Codice di autenticazione dato dall’ente',
    );
    expect(code.required).toBe(true);
    expect(
      within(form).getByText(/Se l’ente non dà il codice, stampa la ricetta rossa/),
    ).toBeTruthy();
    await userEvent.type(within(form).getByLabelText(/Numero di ricetta/), 'MAN000000000002');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    expect(s.queryByText(/Confermi che la ricetta è arrivata/)).toBeNull();
    // Un codice di soli spazi non basta: lo si dice prima della conferma.
    await userEvent.type(code, '   ');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/Senza il codice di autenticazione la ricetta SSN non è valida/);
    expect(s.queryByText(/Confermi che la ricetta è arrivata/)).toBeNull();
    expect(bodies).toEqual([]);
    // Resta l'altra strada: la ricetta rossa (D270).
    expect(s.getByRole('button', { name: 'Stampa la ricetta rossa' })).toBeTruthy();
  });

  it('ricetta SSN al SAR: «Stampa la ricetta rossa» con il numero del modulo; il PDF resta in vista (D270)', async () => {
    const { bodies, calls, red } = service(() => ({ stato: 'error', nre: null, messaggio: null }));
    page();
    const s = await section();
    await s.findByText(/Come vuole la Regione, si stampa la ricetta rossa/);
    expect(s.queryByRole('button', { name: /Non è arrivata/ })).toBeNull();
    await userEvent.click(s.getByRole('button', { name: 'Stampa la ricetta rossa' }));
    const field = s.getByLabelText(/Numero del modulo nella stampante/);
    // Senza il numero del modulo non si prepara niente.
    const prepare = s.getByRole('button', { name: 'Prepara la ricetta rossa' });
    expect((prepare as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, '010260001234000');
    await userEvent.selectOptions(s.getByLabelText('Tipo di visita'), 'D');
    const before = calls.filter((c) => c === '/api/ricette/senza-risposta').length;
    await userEvent.click(prepare);
    await s.findByText(/Ricetta rossa pronta sul modulo/);
    expect(red).toEqual([{ poligrafico: '010260001234000', tipoVisita: 'D' }]);
    expect(bodies).toEqual([]);
    const pdf = s.getByRole('link', { name: 'Stampa sul modulo (PDF)' });
    expect(pdf.getAttribute('href')).toBe('/api/ricette/r1/ricetta-rossa.pdf');
    s.getByText(/si annulla da sola/);
    // La coda non si ricarica: il PDF da stampare resta qui, e il fuoco va al risultato.
    expect(calls.filter((c) => c === '/api/ricette/senza-risposta').length).toBe(before);
    expect((document.activeElement as HTMLElement).className).toBe('esito-segnato');
  });

  it('ricetta SSN al SAR: «Annulla» chiude il modulo senza stampare (D270)', async () => {
    const { red } = service(() => ({ stato: 'error', nre: null, messaggio: null }));
    page();
    const s = await section();
    await userEvent.click(await s.findByRole('button', { name: 'Stampa la ricetta rossa' }));
    await userEvent.click(s.getByRole('button', { name: 'Annulla' }));
    expect(s.queryByLabelText(/Numero del modulo nella stampante/)).toBeNull();
    s.getByRole('button', { name: 'Stampa la ricetta rossa' });
    expect(red).toEqual([]);
  });

  it('presidi: il codice resta facoltativo, come nell’invio (D240)', async () => {
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }), {
      tipo: 'devices',
    });
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    const code = within(form).getByLabelText<HTMLInputElement>(
      'Codice di autenticazione (facoltativo)',
    );
    expect(code.required).toBe(false);
    await userEvent.type(within(form).getByLabelText(/Numero di ricetta/), 'MAN000000000004');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    s.getByText(/senza il codice di autenticazione\?/);
    await userEvent.click(s.getByRole('button', { name: 'Sì, confermo' }));
    await s.findByText(/Ricetta segnata come arrivata/);
    expect(bodies).toEqual([{ esito: 'arrivata', nre: 'MAN000000000004' }]);
  });

  it('ricetta bianca: NRBE e PIN dati dal Sistema TS (D239)', async () => {
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }), {
      tipo: 'white',
    });
    page();
    const s = await section();
    expect((await s.findAllByText(/fermato mentre aspettava il Sistema TS/)).length).toBe(1);
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    expect(within(form).queryByLabelText(/Codice di autenticazione/)).toBeNull();
    // Come lo detta il Sistema TS, anche con uno spazio e in minuscolo: la X è la lettera di
    // controllo del codice fiscale del paziente (D259).
    await userEvent.type(within(form).getByLabelText(/NRBE/), 'x0 1234567890');
    await userEvent.type(within(form).getByLabelText('PIN della ricetta bianca'), '1234');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    expect(s.getByText(/Confermi che la ricetta è arrivata con NRBE/).textContent).toMatch(
      /X01234567890.*PIN 1234/,
    );
    await userEvent.click(s.getByRole('button', { name: 'Sì, confermo' }));
    await s.findByText(/Ricetta segnata come arrivata/);
    expect(bodies).toEqual([{ esito: 'arrivata', nre: 'X01234567890', pin: '1234' }]);
  });

  it('un NRE di forma sbagliata si dice prima della conferma, e non parte niente (audit D259)', async () => {
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }));
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    const number = within(form).getByLabelText(/Numero di ricetta/);
    // La forma si legge accanto al campo, prima di scrivere.
    expect(number.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(form).getByText(/^15 caratteri: 5 lettere o cifre/)).toBeTruthy();
    await userEvent.type(number, 'ABC');
    await userEvent.type(within(form).getByLabelText(/Codice di autenticazione/), '1');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/L’NRE ha sempre 15 caratteri: qui ce ne sono 3/);
    expect(s.queryByText(/Confermi che la ricetta è arrivata/)).toBeNull();
    // Il sesto carattere va da 0 a 7.
    await userEvent.clear(number);
    await userEvent.type(number, 'MAN008000000001');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/il sesto carattere è una cifra da 0 a 7/);
    expect(s.queryByText(/Confermi che la ricetta è arrivata/)).toBeNull();
    expect(bodies).toEqual([]);
  });

  it('ricetta bianca: l’NRBE comincia con la lettera di controllo del codice fiscale mandato con la ricetta (audit D259)', async () => {
    // Il codice fiscale del paziente è stato corretto dopo l'invio: vale quello mandato.
    const { bodies } = service((b) => ({ stato: 'sent', nre: b.nre, messaggio: null }), {
      tipo: 'white',
      codiceFiscaleInviato: 'XXXXXX00X00X000Y',
    });
    page();
    const s = await section();
    const form = await s.findByRole('form', { name: 'La ricetta è arrivata' });
    const number = within(form).getByLabelText(/NRBE/);
    await userEvent.type(number, 'X01234567890');
    await userEvent.type(within(form).getByLabelText('PIN della ricetta bianca'), '1234');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await s.findByText(/lettera di controllo del codice fiscale \(Y\) seguita da una cifra/);
    expect(s.queryByText(/Confermi che la ricetta è arrivata/)).toBeNull();
    await userEvent.clear(number);
    await userEvent.type(number, 'Y01234567890');
    await userEvent.click(within(form).getByRole('button', { name: /È arrivata/ }));
    await userEvent.click(s.getByRole('button', { name: 'Sì, confermo' }));
    await s.findByText(/Ricetta segnata come arrivata/);
    expect(bodies).toEqual([{ esito: 'arrivata', nre: 'Y01234567890', pin: '1234' }]);
  });

  it('nei primi 15 minuti la ricetta si vede, con l’ora da cui si segna l’esito (D239)', async () => {
    service(() => ({ stato: 'error', nre: null, messaggio: null }), {
      esitoDal: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    page();
    const s = await section();
    await s.findByText(/l’esito si segna qui dalle/);
    expect(s.getByText(/Intanto la ricetta non va rifatta/)).toBeTruthy();
    expect(s.queryByRole('button', { name: 'Non è arrivata: torna da inviare' })).toBeNull();
    expect(s.queryByRole('button', { name: 'Stampa la ricetta rossa' })).toBeNull();
  });
});

describe('invii non riusciti: la ricetta rossa stampata esce dalla coda, il PDF resta (D270)', () => {
  it('nella coda degli invii non riusciti il medico stampa la ricetta rossa; il PDF resta sopra la coda', async () => {
    let printed = false;
    const failed = () => ({
      pazienti: printed
        ? []
        : [
            {
              paziente: {
                id: 'p1',
                nome: 'Paola',
                cognome: 'Inventata',
                codiceFiscale: 'XXXXXX00X00X000X',
              },
              ricette: [
                {
                  id: 'r1',
                  tipo: 'pharma_ssn',
                  preparataIl: '2026-11-20T09:00:00Z',
                  preparataDa: 'Medico inventato',
                  righe: 1,
                  errore: 'Il SAR non ha risposto in tempo',
                  tipoErrore: 'timeout',
                },
              ],
            },
          ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io') return Promise.resolve(json(200, me));
        if (path === '/api/ricette/non-inviate') return Promise.resolve(json(200, failed()));
        if (path === '/api/ricette/da-firmare' || path === '/api/ricette/senza-risposta')
          return Promise.resolve(json(200, { pazienti: [] }));
        if (path === '/api/pazienti/p1/ricette')
          return Promise.resolve(
            json(200, {
              ricette: [
                {
                  id: 'r1',
                  righe: [
                    {
                      id: 'l1',
                      drugName: 'Farmaco di prova 5 mg',
                      serviceDescription: null,
                      quantity: 1,
                    },
                  ],
                },
              ],
            }),
          );
        if (path === '/api/ricette/r1/controlla')
          return Promise.resolve(
            json(200, { versioneRegole: 'prova-1', problemi: [], bloccanti: 0 }),
          );
        if (path === '/api/ricette/r1/ricetta-rossa' && init?.method === 'POST') {
          printed = true;
          return Promise.resolve(
            json(200, {
              stato: 'paper',
              nre: '010ZZ4000000003',
              poligrafico: '010260001234009',
              pdf: '/api/ricette/r1/ricetta-rossa.pdf',
              annullamentoDematerializzata: 'da_fare',
              avviso: null,
            }),
          );
        }
        return Promise.resolve(json(404, { errore: 'Non trovato' }));
      }),
    );
    page();
    const failedQueue = within(
      (await screen.findByRole('heading', { level: 2, name: 'Invii non riusciti' })).closest(
        'section',
      )!,
    );
    await userEvent.click(
      await failedQueue.findByRole('button', { name: 'Stampa la ricetta rossa' }),
    );
    await userEvent.type(
      failedQueue.getByLabelText(/Numero del modulo nella stampante/),
      '010260001234009',
    );
    await userEvent.click(failedQueue.getByRole('button', { name: 'Prepara la ricetta rossa' }));
    // La coda si ricarica e la ricetta non c'è più; la ricetta rossa con il PDF resta in vista.
    await failedQueue.findByText(/Ricetta rossa per Paola Inventata pronta sul modulo/);
    await waitFor(() => expect(failedQueue.queryByText('Farmaco di prova 5 mg × 1')).toBeNull());
    expect(
      failedQueue.getByRole('link', { name: 'Stampa sul modulo (PDF)' }).getAttribute('href'),
    ).toBe('/api/ricette/r1/ricetta-rossa.pdf');
  });
});

describe('Oggi: il conto degli invii senza risposta (D233)', () => {
  it('compare con il numero e porta alla coda nella pagina Ricette', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io') return Promise.resolve(json(200, me));
        if (path === '/api/oggi')
          return Promise.resolve(
            json(200, {
              data: '2026-11-20',
              appuntamenti: [],
              code: {
                daFirmare: 0,
                nonInviate: 0,
                senzaRisposta: 2,
                richiesteAperte: 0,
                pianiInScadenza: [],
                giorniAvvisoPiani: 30,
              },
            }),
          );
        return Promise.resolve(json(200, { stato: 'ok' }));
      }),
    );
    render(<App />);
    const link = await screen.findByRole('link', { name: /Invii senza risposta/ });
    expect(link.getAttribute('href')).toBe('/ricette#senza-risposta');
    await waitFor(() => expect(within(link).getByText('2')).toBeTruthy());
  });
});

describe('messaggio d’errore: i motivi dei dati non accettati (D239)', () => {
  it('dice i campi rifiutati, una volta sola; per gli altri errori solo il messaggio', () => {
    const rule = 'Il numero di ricetta ha solo lettere e cifre, al più 30';
    render(
      <ErrorMessage
        error={
          new ApiError(400, 'Dati non validi', [
            { message: rule, path: ['nre'] },
            { message: rule, path: ['nre'] },
          ])
        }
      />,
    );
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain(`Dati non validi: ${rule}`);
    expect(text.split(rule)).toHaveLength(2);
    cleanup();
    render(<ErrorMessage error={new ApiError(409, 'La ricetta è cambiata', [{ message: 'x' }])} />);
    expect(screen.getByRole('alert').textContent).not.toContain(': x');
  });
});
