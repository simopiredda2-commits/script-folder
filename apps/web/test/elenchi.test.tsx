import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  matchingPosology,
  matchingSuggestor,
  packageLines,
  posologyPatch,
  type ListItem,
  type ListLimits,
  type StudioLists,
} from '../src/lib/studio-lists';
import { ListsSection } from '../src/pages/admin/ListsSection';
import { PackagePicker } from '../src/pages/PrescriptionEditor';
import { StudioPosologyField, StudioSuggestorField } from '../src/pages/TherapyForm';

/** Elenchi inventati, come li dà il servizio. */
const limits: ListLimits = {
  name: 120,
  facility: 160,
  specialty: 80,
  phone: 40,
  email: 200,
  address: 200,
  notes: 500,
  posologyText: 200,
  dose: 20,
  posologyPart: 60,
  packageServices: 30,
};
const lists = (over: Partial<StudioLists> = {}): StudioLists => ({
  tipo: null,
  data: '2026-11-19',
  voci: [],
  archiviate: [],
  tipi: [],
  tipiContatto: [
    { codice: 'struttura', nome: 'Struttura' },
    { codice: 'specialista', nome: 'Specialista' },
    { codice: 'laboratorio', nome: 'Laboratorio' },
    { codice: 'altro', nome: 'Altro' },
  ],
  limiti: limits,
  catalogo: null,
  puoModificare: true,
  ...over,
});
const item = <K extends ListItem['tipo']>(
  tipo: K,
  id: string,
  etichetta: string,
  dati: ListItem<K>['dati'],
  over: Partial<ListItem<K>> = {},
): ListItem<K> => ({
  id,
  tipo,
  etichetta,
  dati,
  creataIl: '2026-11-19T08:00:00Z',
  creataDa: 'Medico inventato',
  archiviataIl: null,
  ...over,
});
const evening = item('posologia', 'p1', '1 compressa la sera, per bocca', {
  testo: '1 compressa la sera, per bocca',
  dose: '1',
  unita: 'compressa',
  frequenza: '1 volta al giorno',
  momento: 'la sera',
  via: 'per bocca',
});
const textOnly = item('posologia', 'p2', '2 puff al bisogno', {
  testo: '2 puff al bisogno',
  dose: null,
  unita: null,
  frequenza: null,
  momento: null,
  via: null,
});
const visit = {
  regionalCode: '89.7',
  nationalCode: '89.7',
  description: 'VISITA DI PROVA',
  branch: 'Branca di prova',
  fee: null,
  notes: null,
};
const checkup = item(
  'pacchetto',
  'k1',
  'Controllo di prova',
  {
    nome: 'Controllo di prova',
    prestazioni: [
      { codice: '89.7', descrizione: 'VISITA DI PROVA' },
      { codice: 'PROVA.03', descrizione: 'ESAME USCITO DAL CATALOGO' },
    ],
  },
  {
    catalogo: {
      prestazioni: [
        { codice: '89.7', descrizione: 'VISITA DI PROVA', voce: visit },
        { codice: 'PROVA.03', descrizione: 'ESAME USCITO DAL CATALOGO', voce: null },
      ],
    },
  },
);

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      const handler = routes[path];
      const r = handler ? handler(method, body) : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

const inTools = (elenco: string) => (
  <MemoryRouter initialEntries={[`/strumenti?sezione=elenchi&elenco=${elenco}`]}>
    <ListsSection />
  </MemoryRouter>
);

describe('elenchi dello studio: dalla scheda e dalla ricetta (tappa 14)', () => {
  it('una posologia riempie solo le parti che ha; la scelta mostra quella che la scheda ha già', () => {
    expect(posologyPatch(evening.dati)).toEqual({
      dose: '1',
      doseUnit: 'compressa',
      frequency: '1 volta al giorno',
      timeOfDay: 'la sera',
      route: 'per bocca',
    });
    expect(posologyPatch(textOnly.dati)).toEqual({});
    const fields = {
      dose: '1',
      doseUnit: 'compressa',
      frequency: '1 volta al giorno',
      timeOfDay: 'la sera',
      route: 'per bocca',
    };
    expect(matchingPosology([textOnly, evening], fields)).toBe('p1');
    expect(matchingPosology([evening], { ...fields, dose: '2' })).toBe('');
  });

  it('il medico suggeritore: stesso nome e stessa struttura, senza badare a maiuscole e spazi', () => {
    const s = item('suggeritore', 's1', 'Dott.ssa Anna Prova', {
      nome: 'Dott.ssa Anna Prova',
      struttura: 'Ospedale di prova',
      specialita: 'Cardiologia',
      telefono: null,
    });
    expect(matchingSuggestor([s], ' dott.ssa anna  prova', 'OSPEDALE DI PROVA')).toBe('s1');
    expect(matchingSuggestor([s], 'Dott.ssa Anna Prova', 'Altro ospedale')).toBe('');
  });

  it('un pacchetto in ricetta: le voci del catalogo in vigore sì, quelle uscite no, i doppioni no', () => {
    expect(packageLines(checkup, [])).toEqual({
      add: [
        {
          serviceCode: '89.7',
          serviceNationalCode: '89.7',
          serviceDescription: 'VISITA DI PROVA',
          quantity: 1,
        },
      ],
      missing: [{ codice: 'PROVA.03', descrizione: 'ESAME USCITO DAL CATALOGO' }],
      already: [],
    });
    const again = packageLines(checkup, [' 89.7 ']);
    expect(again.add).toEqual([]);
    expect(again.already.map((s) => s.codice)).toEqual(['89.7']);
    // Senza catalogo in uso nessuna prestazione si può controllare: non se ne aggiunge nessuna.
    expect(packageLines({ ...checkup, catalogo: null }, []).missing).toHaveLength(2);
  });
});

describe('Strumenti › Elenchi dello studio (tappa 14)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('chi non li modifica li consulta soltanto: niente moduli e niente azioni', async () => {
    stubFetch({
      '/api/studio/elenchi': () => ({
        status: 200,
        body: lists({ tipo: 'posologia', voci: [evening, textOnly], puoModificare: false }),
      }),
    });
    render(inTools('posologia'));
    const table = await screen.findByRole('table', { name: 'Posologie in uso' });
    expect(
      within(table).getByRole('rowheader', { name: '1 compressa la sera, per bocca' }),
    ).toBeTruthy();
    expect(
      within(table).getByText('Solo testo: si propone nelle righe della ricetta'),
    ).toBeTruthy();
    expect(within(table).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nuova posologia' })).toBeNull();
    expect(
      screen.getByText(
        /li aggiornano i medici titolari, l’amministratore e il sostituto\s+mentre sostituisce: qui si consultano/,
      ),
    ).toBeTruthy();
  });

  it('una posologia nuova con le parti della scheda: il testo si può comporre dalle parti', async () => {
    let saved = false;
    const calls = stubFetch({
      '/api/studio/elenchi': (method) => {
        if (method === 'POST') {
          saved = true;
          return { status: 201, body: evening };
        }
        return { status: 200, body: lists({ tipo: 'posologia', voci: saved ? [evening] : [] }) };
      },
    });
    const user = userEvent.setup();
    render(inTools('posologia'));
    await screen.findByRole('heading', { name: 'Nuova posologia' });
    await user.type(screen.getByLabelText('Dose'), '1');
    await user.selectOptions(screen.getByLabelText('Unità'), 'compressa');
    await user.selectOptions(screen.getByLabelText('Frequenza'), '1 volta al giorno');
    await user.selectOptions(screen.getByLabelText('Momento'), 'la sera');
    await user.click(screen.getByRole('button', { name: 'Usalo come testo' }));
    expect(screen.getByLabelText<HTMLInputElement>('Testo della posologia').value).toBe(
      '1 compressa una volta al giorno, la sera',
    );
    await user.click(screen.getByRole('button', { name: 'Aggiungi all’elenco' }));
    await screen.findByText('Posologia «1 compressa una volta al giorno, la sera» aggiunta.');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      tipo: 'posologia',
      dati: {
        testo: '1 compressa una volta al giorno, la sera',
        dose: '1',
        unita: 'compressa',
        frequenza: '1 volta al giorno',
        momento: 'la sera',
        via: '',
      },
    });
  });

  it('un pacchetto si compone cercando nel catalogo; quello salvato segnala le voci uscite', async () => {
    const calls = stubFetch({
      '/api/studio/elenchi': (method) =>
        method === 'POST'
          ? { status: 201, body: checkup }
          : { status: 200, body: lists({ tipo: 'pacchetto', voci: [checkup], catalogo: true }) },
      '/api/prestazioni': () => ({ status: 200, body: { prestazioni: [visit], versioni: [] } }),
    });
    const user = userEvent.setup();
    render(inTools('pacchetto'));
    const table = await screen.findByRole('table', { name: 'Pacchetti di prestazioni in uso' });
    expect(
      within(table).getByText(/non è nel catalogo in vigore: in ricetta non si aggiunge/),
    ).toBeTruthy();

    await user.type(screen.getByLabelText('Nome del pacchetto'), 'Visita di controllo');
    await user.type(
      screen.getByLabelText('Cerca nel catalogo regionale: prestazione, branca o codice'),
      'visita{Enter}',
    );
    // Invio nella ricerca non salva il pacchetto.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Aggiungi al pacchetto' }));
    expect(screen.getByRole('button', { name: 'Già nel pacchetto' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Aggiungi all’elenco' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      tipo: 'pacchetto',
      dati: {
        nome: 'Visita di controllo',
        prestazioni: [{ codice: '89.7', descrizione: 'VISITA DI PROVA' }],
      },
    });
  });

  it('una voce si archivia dopo la conferma, e resta tra le archiviate', async () => {
    let archived = false;
    const contact = item('contatto', 'c1', 'Laboratorio di prova', {
      nome: 'Laboratorio di prova',
      tipo: 'laboratorio',
      telefono: '000 0000011',
      email: null,
      indirizzo: null,
      note: null,
    });
    const calls = stubFetch({
      '/api/studio/elenchi': () => ({
        status: 200,
        body: archived
          ? lists({ archiviate: [{ ...contact, archiviataIl: '2026-11-19T09:00:00Z' }] })
          : lists({ voci: [contact] }),
      }),
      '/api/studio/elenchi/c1/archivia': () => {
        archived = true;
        return { status: 200, body: contact };
      },
    });
    vi.stubGlobal('confirm', () => true);
    const user = userEvent.setup();
    render(inTools('contatto'));
    const table = await screen.findByRole('table', { name: 'Contatti utili in uso' });
    expect(within(table).getByText('Laboratorio')).toBeTruthy();
    await user.click(
      within(table).getByRole('button', { name: 'Archivia «Laboratorio di prova»' }),
    );
    await screen.findByText('Contatto «Laboratorio di prova» archiviato.');
    expect(calls.some((c) => c.url === '/api/studio/elenchi/c1/archivia')).toBe(true);
    expect(await screen.findByText('Voci archiviate (1)')).toBeTruthy();
  });
});

describe('scheda della terapia e ricetta specialistica: gli elenchi in uso (tappa 14)', () => {
  afterEach(() => {
    cleanup();
  });

  it('nella scheda della terapia la posologia e il suggeritore dello studio riempiono i campi', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const empty = { dose: '', doseUnit: '', frequency: '', timeOfDay: '', route: '' };
    render(
      <MemoryRouter>
        <StudioPosologyField items={[textOnly, evening]} draft={empty} onChoose={onChoose} />
        <StudioSuggestorField
          items={[
            item('suggeritore', 's1', 'Dott.ssa Anna Prova', {
              nome: 'Dott.ssa Anna Prova',
              struttura: 'Ospedale di prova',
              specialita: 'Cardiologia',
              telefono: null,
            }),
          ]}
          name=""
          facility=""
          onChoose={onChoose}
        />
      </MemoryRouter>,
    );
    const posology = screen.getByLabelText('Posologia dello studio');
    // La posologia di solo testo non riempie la scheda: non si propone qui.
    expect(within(posology).queryByText('2 puff al bisogno')).toBeNull();
    await user.selectOptions(posology, 'p1');
    expect(onChoose).toHaveBeenLastCalledWith({
      dose: '1',
      doseUnit: 'compressa',
      frequency: '1 volta al giorno',
      timeOfDay: 'la sera',
      route: 'per bocca',
    });
    await user.selectOptions(screen.getByLabelText('Dall’elenco dello studio'), 's1');
    expect(onChoose).toHaveBeenLastCalledWith({
      suggestedByName: 'Dott.ssa Anna Prova',
      suggestedByFacility: 'Ospedale di prova',
    });
  });

  it('«Aggiungi un pacchetto»: le prestazioni in vigore in ricetta, le altre dette e lasciate fuori', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <MemoryRouter>
        <PackagePicker packages={[checkup]} inPrescription={[]} disabled={false} onAdd={onAdd} />
      </MemoryRouter>,
    );
    const add = screen.getByRole('button', { name: 'Aggiungi in ricetta' });
    expect(add).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Pacchetto dello studio'), 'k1');
    await user.click(add);
    expect(onAdd).toHaveBeenCalledWith([
      {
        serviceCode: '89.7',
        serviceNationalCode: '89.7',
        serviceDescription: 'VISITA DI PROVA',
        quantity: 1,
      },
    ]);
    expect(
      screen.getByText('Aggiunta 1 prestazione del pacchetto «Controllo di prova».'),
    ).toBeTruthy();
    const warning = screen.getByText('Non aggiunta, perché non è nel catalogo in vigore oggi:');
    expect(within(warning.parentElement!).getByText('ESAME USCITO DAL CATALOGO')).toBeTruthy();
  });

  it('senza pacchetti, la ricetta dice dove si preparano', () => {
    render(
      <MemoryRouter>
        <PackagePicker packages={[]} inPrescription={[]} disabled={false} onAdd={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Strumenti › Elenchi dello studio' })).toHaveProperty(
      'href',
      expect.stringContaining('/strumenti?sezione=elenchi&elenco=pacchetto'),
    );
  });
});
