import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { studioToday } from '../src/lib/format';
import { AdminLogSection } from '../src/pages/admin/AdminLogSection';
import { AftSection } from '../src/pages/AftSection';

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
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

const ok = (body: unknown) => () => ({ status: 200, body });

const ME = {
  id: 'u1',
  nome: 'Dott.ssa Titolare Inventata',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: { id: 'a1', nome: 'Archivio di prova' },
};
const TODAY = {
  data: '2026-11-19',
  appuntamenti: [],
  code: {
    daFirmare: 0,
    nonInviate: 0,
    richiesteAperte: 0,
    pianiInScadenza: [],
    giorniAvvisoPiani: 30,
  },
};
const grant = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  medico: { id: 'u3', nome: 'Dott. Sostituto Inventato' },
  tipo: { codice: 'substitution', nome: 'Sostituzione' },
  dal: '2026-11-18',
  al: '2026-11-25',
  inizio: '2026-11-17T23:00:00.000Z',
  fine: '2026-11-25T22:59:59.999Z',
  motivo: 'Ferie del titolare di prova',
  stato: { codice: 'attiva', nome: 'Attiva' },
  concessaDa: 'Dott.ssa Titolare Inventata',
  concessaIl: '2026-11-17T09:00:00.000Z',
  revocataIl: null,
  revocabile: true,
  ...over,
});
const GRANTABLE = {
  tipi: [
    {
      codice: 'substitution',
      nome: 'Sostituzione',
      spiegazione: 'Un medico con il ruolo di sostituto lavora sull’archivio.',
      medici: [{ id: 'u3', nome: 'Dott. Sostituto Inventato', codiceRegionale: 'MMG-PROVA-3' }],
      nota: null,
    },
    {
      codice: 'group_colleague',
      nome: 'Medicina di gruppo',
      spiegazione: 'Un altro medico titolare dello studio.',
      medici: [],
      nota: 'Lo studio non è di medicina di gruppo: il tipo dello studio lo cambia l’amministratore.',
    },
  ],
};
const RULES = [
  'Cartelle diverse aperte da un utente in un giorno',
  'Fascia oraria degli accessi',
  'Consultazioni dell’AFT di un collega in un giorno',
];
const alertsOff = {
  periodo: { giorni: 30, dal: '2026-10-21', al: '2026-11-19' },
  regole: [
    { codice: 'cartelle_al_giorno', nome: RULES[0], stato: 'da_completare', soglia: null },
    { codice: 'fascia_oraria', nome: RULES[1], stato: 'da_completare', soglia: null },
    { codice: 'consultazioni_aft_al_giorno', nome: RULES[2], stato: 'da_completare', soglia: null },
  ],
  daCompletare: RULES,
  nonValide: [],
  fonte: 'Garante, Linee guida sul dossier sanitario, par. 7, lett. c',
  avvisi: [],
};

describe('Archivio: autorizzazioni e avvisi sugli accessi anomali (tappa 14)', () => {
  beforeEach(() => window.history.pushState({}, '', '/archivio'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('elenco, nuova autorizzazione e revoca con conferma; soglie da completare con la fonte', async () => {
    let list = [grant()];
    const calls = stubFetch({
      '/api/io': ok(ME),
      '/api/oggi': ok(TODAY),
      '/api/archivi/a1/impostazioni': ok({
        segreteriaLeggeDiario: false,
        segreteriaLeggeRiepilogo: false,
      }),
      '/api/archivi/a1/autorizzazioni': (method, body) => {
        if (method === 'POST') {
          const b = body as { dal: string; al: string };
          const created = grant({
            id: 'g2',
            dal: b.dal,
            al: b.al,
            motivo: 'Congresso medico fuori sede',
          });
          list = [created, ...list];
          return { status: 201, body: { autorizzazione: created } };
        }
        return { status: 200, body: { autorizzazioni: list } };
      },
      '/api/archivi/a1/autorizzazioni/g1/revoca': () => {
        list = list.map((g) =>
          g.id === 'g1'
            ? grant({
                stato: { codice: 'revocata', nome: 'Revocata' },
                revocabile: false,
                revocataIl: '2026-11-19T10:00:00.000Z',
              })
            : g,
        );
        return { status: 200, body: { autorizzazione: list[1] } };
      },
      '/api/archivi/a1/medici-autorizzabili': ok(GRANTABLE),
      '/api/archivi/a1/avvisi-accessi': ok(alertsOff),
    });
    const user = userEvent.setup();
    render(<App />);
    const section = (
      await screen.findByRole('heading', { name: 'Autorizzazioni sull’archivio' })
    ).closest('section')!;
    const table = await within(section).findByRole('table', { name: /Autorizzazioni date/ });
    expect(within(table).getByText('Dott. Sostituto Inventato')).toBeTruthy();
    expect(within(table).getByText('Attiva')).toBeTruthy();

    // La medicina di gruppo spiega perché non c'è nessuno; la sostituzione ha il medico.
    await user.click(within(section).getByLabelText('Medicina di gruppo'));
    expect(within(section).getByText(/non è di medicina di gruppo/)).toBeTruthy();
    expect(
      within(section).getByRole<HTMLButtonElement>('button', { name: /Autorizza/ }).disabled,
    ).toBe(true);
    await user.click(within(section).getByLabelText('Sostituzione'));
    await user.selectOptions(within(section).getByLabelText('Medico'), 'u3');
    fireEvent.change(within(section).getByLabelText('Al (compreso)'), {
      target: { value: '2026-12-31' },
    });
    await user.type(within(section).getByLabelText('Motivo'), 'Congresso medico fuori sede');
    await user.click(within(section).getByRole('button', { name: /Autorizza/ }));
    await within(section).findByText(/autorizzazione data a Dott\. Sostituto Inventato/);
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/api/archivi/a1/autorizzazioni')!.body,
    ).toEqual({
      medico: 'u3',
      tipo: 'substitution',
      dal: studioToday(),
      al: '2026-12-31',
      motivo: 'Congresso medico fuori sede',
    });

    // Revoca: chiede conferma; senza conferma non parte niente.
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    // Due autorizzazioni dello stesso medico: il pulsante dice anche il periodo. (jsdom unisce
    // «Revoca» e il testo nascosto senza lo spazio, i browser no.)
    const revoke = await within(section).findByRole('button', {
      name: /^Revoca\s*l’autorizzazione di Dott\. Sostituto Inventato dal 18\/11\/2026 al 25\/11\/2026$/,
    });
    await user.click(revoke);
    expect(calls.some((c) => c.path.endsWith('/revoca'))).toBe(false);
    await user.click(revoke);
    await within(section).findByText(/revocata: l’accesso all’archivio è chiuso/);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.path === '/api/archivi/a1/autorizzazioni/g1/revoca')).toHaveLength(
      1,
    );

    // Avvisi: soglie vuote, spenti, con la fonte.
    const alerts = screen
      .getByRole('heading', { name: 'Avvisi sugli accessi anomali' })
      .closest('section')!;
    expect(within(alerts).getByText('Soglie da completare.')).toBeTruthy();
    for (const r of RULES) expect(within(alerts).getByText(`${r}.`)).toBeTruthy();
    expect(within(alerts).getByText(/Fonte: Garante/)).toBeTruthy();
    expect(within(alerts).queryByRole('table')).toBeNull();
  });

  it('avvisi accesi: tabella con giorno, utente, avviso e ore; il periodo si sceglie', async () => {
    const calls = stubFetch({
      '/api/io': ok(ME),
      '/api/oggi': ok(TODAY),
      '/api/archivi/a1/impostazioni': ok({
        segreteriaLeggeDiario: false,
        segreteriaLeggeRiepilogo: false,
      }),
      '/api/archivi/a1/autorizzazioni': ok({ autorizzazioni: [] }),
      '/api/archivi/a1/medici-autorizzabili': ok(GRANTABLE),
      '/api/archivi/a1/avvisi-accessi': ok({
        ...alertsOff,
        regole: alertsOff.regole.map((r, i) => ({
          ...r,
          stato: 'attiva',
          soglia: [
            'più di 3 al giorno',
            'dalle 22:00 alle 06:00, comprende la mezzanotte',
            'più di 2 al giorno',
          ][i],
        })),
        daCompletare: [],
        avvisi: [
          {
            tipo: 'consultazioni_aft_al_giorno',
            nome: RULES[2],
            utente: {
              id: 'x1',
              nome: 'Dott. Collega Inventato',
              studio: 'Altro studio di prova',
              io: false,
            },
            giorno: '2026-11-17',
            conteggio: 3,
            cartelle: 2,
            soglia: 2,
            fascia: null,
            primo: '2026-11-17T14:00:00.000Z',
            ultimo: '2026-11-17T14:10:00.000Z',
            descrizione:
              '3 consultazioni dell’AFT in un giorno, su 2 pazienti: la soglia è più di 2 al giorno',
          },
        ],
      }),
    });
    const user = userEvent.setup();
    render(<App />);
    const table = await screen.findByRole('table', { name: /Accessi anomali dal 21\/10\/2026/ });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row.textContent).toMatch(/17\/11\/2026/);
    expect(row.textContent).toMatch(/Dott\. Collega Inventato.*Altro studio di prova/);
    expect(row.textContent).toMatch(/3 consultazioni dell’AFT in un giorno/);
    expect(row.textContent).toMatch(/dalle 15:00 alle 15:10/);
    expect(screen.queryByText('Soglie da completare.')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Periodo'), '90');
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/api/archivi/a1/avvisi-accessi' && c.search === 'giorni=90'),
      ).toBe(true),
    );
  });
});

describe('Strumenti › Registro di amministrazione (tappa 14)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a pagine: le righe più vecchie e di nuovo le più recenti, l’esito a parole', async () => {
    const row = (numero: number, over: Record<string, unknown> = {}) => ({
      numero,
      quando: '2026-11-19T09:00:00.000Z',
      utente: 'Amministratore Inventato',
      postazione: 'postazione-1',
      area: 'Utenti e ruoli',
      azione: 'Modifica',
      dettaglio: `Riga ${numero}`,
      esito: 'riuscito',
      ...over,
    });
    const calls = stubFetch({
      '/api/studio/registro-amministrazione': (_m, _b, search) =>
        new URLSearchParams(search).get('prima') === '9'
          ? ok({
              righe: [row(8, { esito: 'negato', azione: 'Revoca di un’autorizzazione' })],
              prossima: null,
            })()
          : ok({ righe: [row(10), row(9)], prossima: 9 })(),
    });
    const user = userEvent.setup();
    render(<AdminLogSection />);
    const table = await screen.findByRole('table', { name: /Azioni di amministrazione/ });
    expect(within(table).getByText('Riga 10')).toBeTruthy();
    expect(within(table).getAllByText('Riuscito')).toHaveLength(2);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Righe più recenti' }).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Righe più vecchie' }));
    expect(await screen.findByText('Riga 8')).toBeTruthy();
    expect(screen.getByText('Negato')).toBeTruthy();
    expect(screen.getByRole('table', { name: /pagina 2/ })).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Righe più vecchie' }).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Righe più recenti' }));
    expect(await screen.findByText('Riga 10')).toBeTruthy();
    expect(calls.map((c) => new URLSearchParams(c.search).get('prima'))).toEqual([null, '9', null]);
  });
});

describe('Strumenti › AFT: nome, ASL e codice (tappa 14)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('un membro li cambia; ASL vuota si toglie', async () => {
    let aft: { id: string; nome: string; asl: string | null; codice: string | null } = {
      id: 'f1',
      nome: 'AFT di prova',
      asl: 'ASL di prova',
      codice: null,
    };
    const calls = stubFetch({
      '/api/aft': () => ({
        status: 200,
        body: {
          aft: { ...aft, condivido: false, dal: '2026-11-01T09:00:00.000Z', membri: [] },
          inviti: [],
          puoCreare: false,
          tipologieAttivita: [],
          motiviComuni: [],
        },
      }),
      '/api/aft/f1': (method, body) => {
        const b = body as { nome: string; asl: string; codice: string };
        aft = { ...aft, nome: b.nome, asl: b.asl || null, codice: b.codice || null };
        return { status: method === 'PATCH' ? 200 : 405, body: { aft } };
      },
      '/api/aft/consultazioni': ok({ consultazioni: [] }),
      '/api/aft/attivita': ok({ attivita: [] }),
    });
    const user = userEvent.setup();
    render(<AftSection />);
    const toggle = await screen.findByRole('button', {
      name: 'Modifica nome, ASL e codice dell’AFT',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const name = screen.getByLabelText<HTMLInputElement>('Nome dell’AFT');
    expect(name.value).toBe('AFT di prova');
    await user.clear(name);
    await user.type(name, 'AFT Nord di prova');
    await user.clear(
      screen.getByLabelText('Azienda sanitaria (facoltativo)', { selector: '#aft-modifica-asl' }),
    );
    await user.type(
      screen.getByLabelText('Codice dell’AFT (facoltativo)', { selector: '#aft-modifica-codice' }),
      'AFT-01',
    );
    await user.click(screen.getByRole('button', { name: 'Salva i dati dell’AFT' }));
    expect(await screen.findByText('Dati dell’AFT salvati.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      nome: 'AFT Nord di prova',
      asl: '',
      codice: 'AFT-01',
    });
    await waitFor(() => expect(screen.getByText(/AFT Nord di prova/)).toBeTruthy());
  });
});
