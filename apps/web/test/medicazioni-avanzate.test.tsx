import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const [path = ''] = url.split('?');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = routes[path];
      const r = handler ? handler(method, body) : { status: 404, body: { errore: 'Non trovato' } };
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

const ME = {
  id: 'u1',
  nome: 'Dott.ssa Titolare Inventata',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: { id: 'a1', nome: 'Archivio di prova' },
};

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

const CATEGORIES = {
  categorie: [
    { chiave: 'monouso', nome: 'Dispositivi medici monouso', fonte: 'allegato 2', allegato: '2' },
    {
      chiave: 'medicazione_avanzata',
      nome: 'Medicazioni avanzate e bendaggio specialistico',
      fonte: 'vademecum',
      allegato: null,
    },
  ],
};

/** Voci inventate nella forma del nomenclatore dell'allegato 2 (D236, D237). */
const item = (
  codice: string,
  descrizione: string,
  gruppo: string,
  quantita: string | null = null,
  intestazioneQuantita: string | null = null,
) => ({
  codice,
  descrizione,
  gruppo,
  allegato: '2',
  atto: 'DPCM di prova, allegato 2',
  quantita,
  intestazioneQuantita,
});
const CATALOG = {
  presidi: [
    item('09.99.04.003', 'sacca di prova', '09.99.04 sacche di prova', '60', 'quantità erogabile'),
    item(
      '09.99.05.003',
      'sistema di prova',
      '09.99.05 sistemi di prova',
      '20 + 60',
      'quantità erogabile',
    ),
    item('04.49.03.103', 'medicazione di prova in alginato', '04.49 lesioni cutanee di prova'),
    item('04.49.06.203', 'medicazione di prova in idrocolloidi', '04.49 lesioni cutanee di prova'),
  ],
  malattieRare: [],
};

function supplyRoutes(advanced: string[], presidi: unknown[] = []) {
  return stubFetch({
    '/api/io': ok(ME),
    '/api/oggi': ok({ data: '2026-11-21', appuntamenti: [], code: { daFirmare: 0 } }),
    '/api/pazienti/p1': ok(PATIENT),
    '/api/pazienti/p1/voci': ok({ voci: [] }),
    '/api/pazienti/p1/presidi': (method) =>
      method === 'POST'
        ? { status: 201, body: { id: 's9' } }
        : {
            status: 200,
            body: { presidi, puoScrivere: true, medicazioniAvanzate: advanced },
          },
    '/api/pazienti/p1/presidi/s1/rinnova': () => ({ status: 201, body: { id: 's2' } }),
    '/api/presidi/categorie': ok(CATEGORIES),
    '/api/presidi/nomenclatore': ok(CATALOG),
  });
}

/** Una prescrizione di presidi già registrata, nella forma del servizio. */
const supply = (extra: object = {}) => ({
  id: 's1',
  categoria: 'monouso',
  nomeCategoria: 'Dispositivi medici monouso',
  fonte: null,
  prodotto: 'medicazione di prova in alginato',
  codice: '04.49.03.103',
  quantitaMensile: 10,
  unita: 'pezzi',
  mesi: 12,
  dal: '2025-10-01',
  al: '2026-09-30',
  prescrittore: 'mmg',
  primoSpecialista: null,
  primoSpecialistaIl: null,
  note: null,
  riservato: false,
  stato: 'scaduta',
  motivoAnnullamento: null,
  registrataDa: 'Dott.ssa Titolare Inventata',
  rinnovo: { categoria: null, chiedeSpecialista: false, mesiMassimi: null },
  ...extra,
});

const options = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((o) => o.textContent)
    .filter((t) => !t?.startsWith('Scrivi'));

describe('presidi: quantità del nomenclatore e medicazioni avanzate (D237)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('accanto alla voce scelta la quantità dell’allegato, con l’intestazione; senza, niente', async () => {
    supplyRoutes([]);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const select = await screen.findByLabelText<HTMLSelectElement>('Dal nomenclatore (allegato 2)');
    const choose = (name: string) =>
      fireEvent.change(select, {
        target: {
          value: within(select).getByRole('option', { name }).getAttribute('value'),
        },
      });
    choose('sistema di prova · 09.99.05.003');
    const quantity = screen.getByText(/Quantità nel nomenclatore/);
    expect(quantity.textContent).toBe(
      'Quantità nel nomenclatore: 20 + 60 («quantità erogabile»). Il fabbisogno lo decide il medico.',
    );
    expect(select.getAttribute('aria-describedby')).toContain(quantity.id);
    // Una voce senza quantità nell'allegato: la riga sparisce.
    choose('medicazione di prova in alginato · 04.49.03.103');
    expect(screen.queryByText(/Quantità nel nomenclatore/)).toBeNull();
    expect(select.getAttribute('aria-describedby')).toBe('presidio-nomenclatore-aiuto');
  });

  it('le voci scelte dal titolare stanno solo fra le medicazioni avanzate', async () => {
    const calls = supplyRoutes(['04.49.03.103']);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const monouso = await screen.findByLabelText<HTMLSelectElement>(
      'Dal nomenclatore (allegato 2)',
    );
    expect(options(monouso)).toEqual([
      'sacca di prova · 09.99.04.003',
      'sistema di prova · 09.99.05.003',
      'medicazione di prova in idrocolloidi · 04.49.06.203',
    ]);
    fireEvent.change(screen.getByLabelText('Categoria'), {
      target: { value: 'medicazione_avanzata' },
    });
    const advanced = await screen.findByLabelText<HTMLSelectElement>(
      'Dal nomenclatore (allegato 2)',
    );
    expect(options(advanced)).toEqual(['medicazione di prova in alginato · 04.49.03.103']);
    fireEvent.change(advanced, {
      target: {
        value: within(advanced)
          .getByRole('option', { name: 'medicazione di prova in alginato · 04.49.03.103' })
          .getAttribute('value'),
      },
    });
    // Fra le medicazioni avanzate il modulo chiede la prima prescrizione dello specialista.
    fireEvent.change(screen.getByLabelText('Prima prescrizione: specialista'), {
      target: { value: 'Dr. Vulnologo di prova' },
    });
    fireEvent.change(screen.getByLabelText('Prima prescrizione: data'), {
      target: { value: '2026-01-10' },
    });
    fireEvent.change(screen.getByLabelText('Fabbisogno al mese'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Unità'), { target: { value: 'pezzi' } });
    fireEvent.change(screen.getByLabelText('Mesi'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Registra la prescrizione/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        categoria: 'medicazione_avanzata',
        codice: '04.49.03.103',
        primoSpecialista: 'Dr. Vulnologo di prova',
      }),
    );
  });

  it('cambiando categoria la voce scelta dal nomenclatore si toglie (D239)', async () => {
    supplyRoutes([]);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const select = await screen.findByLabelText<HTMLSelectElement>('Dal nomenclatore (allegato 2)');
    fireEvent.change(select, {
      target: {
        value: within(select)
          .getByRole('option', { name: 'medicazione di prova in alginato · 04.49.03.103' })
          .getAttribute('value'),
      },
    });
    const product = screen.getByLabelText<HTMLInputElement>('Prodotto');
    const code = screen.getByLabelText<HTMLInputElement>('Codice del nomenclatore');
    expect([product.value, code.value]).toEqual([
      'medicazione di prova in alginato',
      '04.49.03.103',
    ]);
    fireEvent.change(screen.getByLabelText('Categoria'), {
      target: { value: 'medicazione_avanzata' },
    });
    expect([product.value, code.value]).toEqual(['', '']);
    // Un prodotto scritto a mano resta.
    fireEvent.change(product, { target: { value: 'garza scritta a mano' } });
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'monouso' } });
    expect(product.value).toBe('garza scritta a mano');
  });

  it('il rinnovo che passa fra le medicazioni avanzate chiede specialista e mesi (D239)', async () => {
    const calls = supplyRoutes(
      ['04.49.03.103'],
      [
        supply({
          rinnovo: { categoria: 'medicazione_avanzata', chiedeSpecialista: true, mesiMassimi: 6 },
        }),
      ],
    );
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const renew = await screen.findByRole('button', { name: /^Rinnova/ });
    expect(renew.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(renew);
    expect(renew.getAttribute('aria-expanded')).toBe('true');
    screen.getByText(/il rinnovo passa nella categoria «Medicazioni avanzate»/);
    expect(screen.getByLabelText<HTMLInputElement>('Rinnovo: mesi').value).toBe('6');
    fireEvent.change(screen.getByLabelText('Rinnovo: specialista della prima prescrizione'), {
      target: { value: 'Dr. Vulnologo di prova' },
    });
    fireEvent.change(screen.getByLabelText('Rinnovo: data della prima prescrizione'), {
      target: { value: '2026-01-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conferma il rinnovo' }));
    await screen.findByText('Rinnovata fra le medicazioni avanzate.');
    expect(calls.find((c) => c.path.endsWith('/rinnova'))?.body).toEqual({
      categoria: 'medicazione_avanzata',
      primoSpecialista: 'Dr. Vulnologo di prova',
      primoSpecialistaIl: '2026-01-10',
      mesi: 6,
    });
  });

  it('il rinnovo che non chiede niente resta un clic', async () => {
    const calls = supplyRoutes([], [supply({ mesi: 3 })]);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const renew = await screen.findByRole('button', { name: /^Rinnova/ });
    expect(renew.getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(renew);
    await screen.findByText('Rinnovata.');
    expect(calls.find((c) => c.path.endsWith('/rinnova'))?.body).toEqual({});
  });

  it('senza scelte del titolare le medicazioni avanzate non hanno un nomenclatore', async () => {
    supplyRoutes([]);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const monouso = await screen.findByLabelText<HTMLSelectElement>(
      'Dal nomenclatore (allegato 2)',
    );
    expect(options(monouso)).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Categoria'), {
      target: { value: 'medicazione_avanzata' },
    });
    await waitFor(() => expect(screen.queryByLabelText(/Dal nomenclatore/)).toBeNull());
  });
});

describe('archivio: le medicazioni avanzate le sceglie il titolare (D237)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  const archiveRoutes = (catalog: unknown, reloadFails = false, initial = ['04.49.06.203']) => {
    let saved = initial;
    let patched = false;
    const calls = stubFetch({
      '/api/io': ok(ME),
      '/api/oggi': ok({ data: '2026-11-21', appuntamenti: [], code: { daFirmare: 0 } }),
      '/api/archivi/a1/impostazioni': (method, body) => {
        if (method === 'PATCH') {
          saved = [...((body as { medicazioniAvanzate: string[] }).medicazioniAvanzate ?? [])];
          patched = true;
        } else if (patched && reloadFails)
          return { status: 503, body: { errore: 'Servizio non disponibile' } };
        return {
          status: 200,
          body: {
            segreteriaLeggeDiario: false,
            segreteriaLeggeRiepilogo: false,
            medicazioniAvanzate: saved,
          },
        };
      },
      '/api/presidi/nomenclatore': ok(catalog),
    });
    return calls;
  };

  it('solo le voci 04.49 del nomenclatore, con quelle già scelte; si salva l’elenco intero', async () => {
    const calls = archiveRoutes(CATALOG);
    window.history.pushState({}, '', '/archivio?sezione=medicazioni');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Medicazioni avanzate' })).closest(
      'section',
    )!;
    const boxes = await within(section).findAllByRole('checkbox');
    expect(boxes.map((b) => b.id)).toEqual(['avanzata-04.49.03.103', 'avanzata-04.49.06.203']);
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([false, true]);
    const save = within(section).getByRole('button', { name: 'Salva le medicazioni avanzate' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await within(section).findByText('Medicazioni avanzate salvate: 2.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      medicazioniAvanzate: ['04.49.06.203', '04.49.03.103'],
    });
  });

  it('dopo il salvataggio le caselle dicono che cosa ha salvato il servizio, anche se le impostazioni non si ricaricano', async () => {
    archiveRoutes(CATALOG, true);
    window.history.pushState({}, '', '/archivio?sezione=medicazioni');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Medicazioni avanzate' })).closest(
      'section',
    )!;
    const boxes = await within(section).findAllByRole('checkbox');
    fireEvent.click(boxes[1]!);
    const save = within(section).getByRole('button', { name: 'Salva le medicazioni avanzate' });
    fireEvent.click(save);
    await within(section).findByText(/Nessuna medicazione avanzata/);
    // Le impostazioni non si sono ricaricate: le caselle restano come le ha salvate il servizio.
    await waitFor(() => expect(screen.getByText('Servizio non disponibile')).toBeTruthy());
    expect(
      within(section)
        .getAllByRole('checkbox')
        .map((b) => (b as HTMLInputElement).checked),
    ).toEqual([false, false]);
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('con il nomenclatore non ancora in uso la pagina lo dice, senza caselle', async () => {
    archiveRoutes({ presidi: [], malattieRare: [] }, false, []);
    window.history.pushState({}, '', '/archivio?sezione=medicazioni');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Medicazioni avanzate' })).closest(
      'section',
    )!;
    await within(section).findByText(/non è ancora in uso/);
    expect(within(section).queryAllByRole('checkbox')).toEqual([]);
  });

  it('una voce scelta che il nomenclatore in uso non ha più si vede e si toglie (D239)', async () => {
    const calls = archiveRoutes(CATALOG, false, ['04.49.06.203', '04.49.99.999']);
    window.history.pushState({}, '', '/archivio?sezione=medicazioni');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Medicazioni avanzate' })).closest(
      'section',
    )!;
    const boxes = await within(section).findAllByRole('checkbox');
    expect(boxes.map((b) => [b.id, (b as HTMLInputElement).checked])).toEqual([
      ['avanzata-04.49.03.103', false],
      ['avanzata-04.49.06.203', true],
      ['avanzata-04.49.99.999', true],
    ]);
    expect(within(section).getByLabelText(/04\.49\.99\.999.*non è più nel nomenclatore/)).toBe(
      boxes[2],
    );
    fireEvent.click(boxes[2]!);
    fireEvent.click(within(section).getByRole('button', { name: 'Salva le medicazioni avanzate' }));
    await within(section).findByText('Medicazioni avanzate salvate: 1.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      medicazioniAvanzate: ['04.49.06.203'],
    });
    // Tolta e salvata, non si vede più.
    await waitFor(() => expect(within(section).queryByLabelText(/04\.49\.99\.999/)).toBeNull());
  });

  it('anche con il nomenclatore non in uso le voci già scelte si vedono, per toglierle', async () => {
    archiveRoutes({ presidi: [], malattieRare: [] }, false, ['04.49.06.203']);
    window.history.pushState({}, '', '/archivio?sezione=medicazioni');
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Medicazioni avanzate' })).closest(
      'section',
    )!;
    await within(section).findByText(/non è ancora in uso/);
    expect(
      within(section)
        .getAllByRole('checkbox')
        .map((b) => b.id),
    ).toEqual(['avanzata-04.49.06.203']);
  });
});
