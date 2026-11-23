import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColourLegend } from '../src/components/DrugColours';
import type { PrescribedDrug } from '../src/components/Prescribed';
import { byGroup, packages, PrescribedDrugList } from '../src/components/PrescribedDrugs';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { lineFromPrescribed, PrescriptionEditor } from '../src/pages/PrescriptionEditor';
import type { TherapyRow } from '../src/pages/RecordPage';

/** Farmaci e terapie inventati, come li restituisce il servizio. */
const THERAPY: TherapyRow = {
  id: 't1',
  drugName: 'Farmaco di prova 5 mg',
  drugAic: '900000017',
  activeIngredient: 'Provalina',
  kind: 'chronic',
  status: 'active',
  dose: '1',
  doseUnit: 'compressa',
  frequency: 'una volta al giorno',
  timeOfDay: 'mattina',
  aifaNote: '13',
  reserved: false,
  important: false,
};

const COUNTS = {
  ricette: 2,
  prescritte: 2,
  inPreparazione: 0,
  annullate: 0,
  ultimaIl: '2026-11-10',
  ultimoStato: 'sent',
  ultimi12Mesi: 4,
};

const CHRONIC: PrescribedDrug = {
  ...COUNTS,
  ultimaPrescrizione: { il: '2026-11-10', quantita: 2, altroProgramma: false },
  chiave: 'terapia:t1',
  storico: { terapia: 't1' },
  farmaco: 'Farmaco di prova 5 mg',
  principioAttivo: 'Provalina',
  aic: '900000017',
  notaAifa: '13',
  terapia: {
    id: 't1',
    tipo: 'chronic',
    stato: 'active',
    tipologia: 'S',
    riservata: false,
    fine: null,
    motivoSospensione: null,
  },
};

const OCCASIONAL: PrescribedDrug = {
  ...COUNTS,
  ricette: 1,
  prescritte: 1,
  ultimaIl: '2026-10-02',
  ultimi12Mesi: 1,
  ultimaPrescrizione: { il: '2026-10-02', quantita: 1, altroProgramma: true },
  chiave: 'aic:900000029',
  storico: { aic: '900000029' },
  farmaco: 'Altro farmaco di prova 10 mg',
  principioAttivo: 'Inventalina',
  aic: '900000029',
  notaAifa: null,
  terapia: null,
};

const HISTORY = {
  ultimi12Mesi: 4,
  voci: [
    {
      ricetta: {
        id: 'r2',
        stato: 'sent',
        nre: '0100A0000000002',
        preparataIl: '2026-11-09T08:00:00Z',
        inviataIl: '2026-11-10T09:00:00Z',
        cartaceaIl: null,
        annullataIl: null,
      },
      riga: { farmaco: 'Farmaco di prova 5 mg', quantita: 2 },
    },
  ],
  ricettePassate: [{ id: 'q1', data: '2026-05-04', quantita: 3, annullataIl: null }],
};

function stubFetch() {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(url.includes('storico-prescrizioni') ? HISTORY : {}), {
        status: 200,
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const renderList = (drugs: PrescribedDrug[], action?: (d: PrescribedDrug) => React.ReactNode) =>
  render(
    <MemoryRouter>
      <h3 id="titolo">Farmaci prescritti</h3>
      <PrescribedDrugList drugs={drugs} patientId="p1" label="titolo" action={action} />
    </MemoryRouter>,
  );

/** Una terapia sospesa con la ricetta più recente: nel servizio viene prima della cronica. */
const SUSPENDED: PrescribedDrug = {
  ...CHRONIC,
  ultimaPrescrizione: { il: '2026-11-20', quantita: 1, altroProgramma: false },
  ultimaIl: '2026-11-20',
  chiave: 'terapia:t2',
  storico: { terapia: 't2' },
  farmaco: 'Farmaco sospeso di prova 20 mg',
  aic: '900000031',
  terapia: {
    ...CHRONIC.terapia!,
    id: 't2',
    stato: 'suspended',
    tipologia: null,
    motivoSospensione: 'Motivo di prova',
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('farmaci prescritti in una riga, con i dettagli che si aprono (D246)', () => {
  it('in vista solo nome, tipo e ultima ricetta; il resto è chiuso e non si carica', () => {
    const fetch = stubFetch();
    renderList([CHRONIC]);
    const item = within(screen.getByRole('list', { name: 'Farmaci prescritti' })).getByRole(
      'listitem',
    );
    const open = within(item).getByRole('button', { name: 'Farmaco di prova 5 mg' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    // Il «+» dice da sé che la voce si apre.
    expect(open.querySelector('path[d="M12 8v8"]')).not.toBeNull();
    expect(item.querySelector('.farmaco-tipo')!.textContent).toBe(
      'CronicaSSuggerita dallo specialista',
    );
    expect(item.querySelector('.farmaco-ultima')!.textContent).toBe(
      'Ultima ricetta10/11/2026 · 2 confezioni',
    );
    const details = document.getElementById(open.getAttribute('aria-controls')!)!;
    expect(details.hidden).toBe(true);
    expect(details.textContent).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('col «+» si aprono i dati del farmaco e le ultime ricette; col «−» si richiude', async () => {
    const fetch = stubFetch();
    renderList([CHRONIC]);
    const open = screen.getByRole('button', { name: 'Farmaco di prova 5 mg' });
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.querySelector('path[d="M12 8v8"]')).toBeNull();
    const details = document.getElementById(open.getAttribute('aria-controls')!)!;
    expect(details.hidden).toBe(false);
    expect(
      [...details.querySelectorAll('.farmaco-conti > span')].map((s) => s.textContent),
    ).toEqual([
      'Principio attivo: Provalina',
      'AIC 900000017',
      'Nota AIFA 13',
      '2 ricette inviate o su carta · 4 confezioni negli ultimi 12 mesi',
    ]);
    const table = await within(details).findByRole('table', {
      name: 'Ultime ricette di Farmaco di prova 5 mg',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/api/pazienti/p1/storico-prescrizioni?terapia=t1');
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)),
    ).toEqual([
      ['10/11/2026', '2', 'Inviata', '0100A0000000002'],
      ['04/05/2026', '3', 'Con un altro programma', '—'],
    ]);
    expect(
      within(details).getByRole('link', { name: 'Scheda e storico completo' }).getAttribute('href'),
    ).toBe('/pazienti/p1/terapie/t1');
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
  });

  it('un farmaco senza terapia: «Senza terapia», principio attivo e storico completo', async () => {
    stubFetch();
    renderList([OCCASIONAL]);
    const item = screen.getByRole('listitem');
    expect(item.className).toContain('farmaco-non-in-corso');
    expect(item.querySelector('.farmaco-tipo')!.textContent).toBe('Senza terapia');
    fireEvent.click(within(item).getByRole('button', { name: 'Altro farmaco di prova 10 mg' }));
    expect(within(item).getByText('Principio attivo: Inventalina')).toBeTruthy();
    // Una confezione al singolare anche negli ultimi 12 mesi.
    expect(
      within(item).getByText('1 ricetta inviata o su carta · 1 confezione negli ultimi 12 mesi'),
    ).toBeTruthy();
    expect(within(item).getByText('L’ultima ricetta è fatta con un altro programma.')).toBeTruthy();
    await within(item).findByRole('table');
    expect(within(item).getByRole('link', { name: 'Storico completo' }).getAttribute('href')).toBe(
      '/pazienti/p1/farmaci/storico?aic=900000029',
    );
  });

  it('il pulsante della riga sta accanto al nome, uno per voce', () => {
    stubFetch();
    renderList([CHRONIC, OCCASIONAL], (d) => <button type="button">Aggiungi {d.farmaco}</button>);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.farmaco-azione')?.textContent ?? null)).toEqual([
      'Aggiungi Farmaco di prova 5 mg',
      'Aggiungi Altro farmaco di prova 10 mg',
    ]);
  });

  it('senza ricette prescritte l’ultima ricetta dice «nessuna»', () => {
    stubFetch();
    renderList([{ ...CHRONIC, ultimaPrescrizione: null }]);
    expect(screen.getByRole('listitem').querySelector('.farmaco-ultima')!.textContent).toBe(
      'Ultima ricettanessuna',
    );
  });

  it('le confezioni al singolare e al plurale, o non indicate', () => {
    expect(packages(1)).toBe('1 confezione');
    expect(packages(3)).toBe('3 confezioni');
    expect(packages(null)).toBe('confezioni non indicate');
  });

  it('lo storico si carica solo quando la voce è aperta, una volta sola', async () => {
    const fetch = stubFetch();
    renderList([CHRONIC, OCCASIONAL]);
    fireEvent.click(screen.getByRole('button', { name: 'Altro farmaco di prova 10 mg' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]![0]).toBe('/api/pazienti/p1/storico-prescrizioni?aic=900000029');
  });
});

describe('«Aggiungi» dalla riga del farmaco prescritto (D246)', () => {
  it('la terapia in corso con la sua posologia', () => {
    expect(lineFromPrescribed(CHRONIC, [THERAPY])).toEqual({
      therapyId: 't1',
      drugAic: '900000017',
      drugName: 'Farmaco di prova 5 mg',
      activeIngredient: 'Provalina',
      aifaNote: '13',
      quantity: 1,
      posologyText: '1 compressa, una volta al giorno, mattina',
    });
  });

  it('nessuna riga per le terapie sospese o concluse, né se la terapia non c’è più', () => {
    for (const stato of ['suspended', 'ended'] as const) {
      expect(
        lineFromPrescribed({ ...CHRONIC, terapia: { ...CHRONIC.terapia!, stato } }, [THERAPY]),
      ).toBeNull();
    }
    expect(lineFromPrescribed(CHRONIC, [])).toBeNull();
  });

  it('un farmaco senza terapia con l’AIC, senza posologia né terapia collegata', () => {
    expect(lineFromPrescribed(OCCASIONAL, [THERAPY])).toEqual({
      drugAic: '900000029',
      drugName: 'Altro farmaco di prova 10 mg',
      activeIngredient: 'Inventalina',
      aifaNote: null,
      quantity: 1,
    });
  });

  it('nessuna riga per un farmaco senza AIC: si cerca nella banca dati', () => {
    expect(lineFromPrescribed({ ...OCCASIONAL, aic: null }, [THERAPY])).toBeNull();
  });
});

describe('i farmaci prescritti nella ricetta (D246)', () => {
  const PATIENT_ID = '00000000-0000-4000-8000-000000000001';
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

  /**
   * La ricetta con il servizio finto. `wait` trattiene la risposta delle terapie o dei farmaci
   * prescritti fino a quando la prova la lascia andare; `fail` fa fallire i farmaci prescritti.
   */
  function renderEditor(
    opts: { wait?: { terapie?: Promise<void>; farmaci?: Promise<void> }; fail?: boolean } = {},
  ) {
    const fetch = vi.fn(async (url: string) => {
      const path = url.split('?')[0]!;
      if (path === `/api/pazienti/${PATIENT_ID}/terapie`) await opts.wait?.terapie;
      if (path === `/api/pazienti/${PATIENT_ID}/farmaci-prescritti`) {
        await opts.wait?.farmaci;
        if (opts.fail)
          return new Response(JSON.stringify({ errore: 'Errore di prova' }), { status: 500 });
      }
      const body =
        path === `/api/pazienti/${PATIENT_ID}`
          ? RECORD
          : path === `/api/pazienti/${PATIENT_ID}/terapie`
            ? { terapie: [THERAPY] }
            : path === `/api/pazienti/${PATIENT_ID}/farmaci-prescritti`
              ? { farmaci: [SUSPENDED, CHRONIC, OCCASIONAL] }
              : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    return render(
      <OpenRecordsProvider>
        <MemoryRouter initialEntries={[`/pazienti/${PATIENT_ID}/ricetta`]}>
          <Routes>
            <Route path="/pazienti/:id/ricetta" element={<PrescriptionEditor mode="farmaci" />} />
          </Routes>
        </MemoryRouter>
      </OpenRecordsProvider>,
    );
  }

  it('in testa le terapie in corso, poi sospese o concluse, poi senza terapia, come i gruppi della pagina', async () => {
    renderEditor();
    const list = await screen.findByRole('list', { name: 'Farmaci prescritti' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('.farmaco-nome')!.textContent),
    ).toEqual([
      'Farmaco di prova 5 mg',
      'Farmaco sospeso di prova 20 mg',
      'Altro farmaco di prova 10 mg',
    ]);
    // «Aggiungi» per la terapia in corso e per il farmaco con l'AIC; la sospesa si riprende dalla
    // sua scheda.
    expect(
      within(list)
        .getAllByRole('button', { name: /^Aggiungi/ })
        .map((b) => b.textContent.trim()),
    ).toEqual(['Aggiungi Farmaco di prova 5 mg', 'Aggiungi Altro farmaco di prova 10 mg']);
    expect(
      screen
        .getByRole('link', {
          name: 'Tutti i farmaci prescritti, con le ricette fatte con altri programmi',
        })
        .getAttribute('href'),
    ).toBe(`/pazienti/${PATIENT_ID}/farmaci`);
  });

  it('«Aggiungi» della terapia in corso mette nella ricetta la riga con la sua posologia', async () => {
    renderEditor();
    const list = await screen.findByRole('list', { name: 'Farmaci prescritti' });
    // L'elenco arriva con le terapie già lette: il pulsante c'è da subito. Nel nome jsdom perde lo
    // spazio prima del testo nascosto, il browser no (la prova nel browser cerca il nome intero).
    fireEvent.click(
      within(list).getByRole('button', { name: /^Aggiungi ?Farmaco di prova 5 mg$/ }),
    );
    const line = await waitFor(() => {
      const l = document.querySelector('.riga-ricetta');
      expect(l).not.toBeNull();
      return l as HTMLElement;
    });
    expect(line.textContent).toContain('Farmaco di prova 5 mg');
    expect(line.textContent).toContain('1 confezione · 1 compressa, una volta al giorno, mattina');
  });

  /** Qualche giro di attesa, perché le risposte arrivate finiscano nella pagina. */
  const settle = () => act(() => new Promise((done) => setTimeout(done, 30)));

  it('l’elenco aspetta le terapie: «Aggiungi» non compare dopo, sotto il cursore', async () => {
    let release!: () => void;
    renderEditor({ wait: { terapie: new Promise<void>((r) => (release = r)) } });
    await screen.findByRole('heading', { name: 'Banca dati farmaci' });
    await settle();
    // I farmaci prescritti sono arrivati, le terapie no: né l'elenco né il ripiego.
    expect(screen.queryByRole('list', { name: 'Farmaci prescritti' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dalla terapia in corso' })).toBeNull();
    release();
    const list = await screen.findByRole('list', { name: 'Farmaci prescritti' });
    expect(
      within(list).getByRole('button', { name: /^Aggiungi ?Farmaco di prova 5 mg$/ }),
    ).toBeTruthy();
  });

  it('mentre si leggono i farmaci prescritti nessun elenco di ripiego, che sparirebbe subito', async () => {
    let release!: () => void;
    renderEditor({ wait: { farmaci: new Promise<void>((r) => (release = r)) } });
    await screen.findByRole('heading', { name: 'Banca dati farmaci' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Dalla terapia in corso' })).toBeNull();
    release();
    await screen.findByRole('list', { name: 'Farmaci prescritti' });
    expect(screen.queryByRole('heading', { name: 'Dalla terapia in corso' })).toBeNull();
  });

  it('se i farmaci prescritti non si leggono, si aggiunge dalla terapia in corso come prima', async () => {
    renderEditor({ fail: true });
    await screen.findByRole('heading', { name: 'Dalla terapia in corso' });
    expect(screen.queryByRole('list', { name: 'Farmaci prescritti' })).toBeNull();
    expect(screen.getByText('1 compressa, una volta al giorno, mattina')).toBeTruthy();
  });

  it('l’ordine dei gruppi tiene, dentro ogni gruppo, l’ordine del servizio', () => {
    const older = { ...CHRONIC, chiave: 'terapia:t3', farmaco: 'Cronica più vecchia' };
    expect(byGroup([OCCASIONAL, SUSPENDED, CHRONIC, older]).map((d) => d.farmaco)).toEqual([
      'Farmaco di prova 5 mg',
      'Cronica più vecchia',
      'Farmaco sospeso di prova 20 mg',
      'Altro farmaco di prova 10 mg',
    ]);
  });
});

describe('legenda dei colori compatta (D246)', () => {
  it('sei voci con un titolo per chi usa un lettore di schermo', () => {
    render(<ColourLegend />);
    const list = screen.getByRole('list', { name: 'Legenda dei colori' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent.trim()),
    ).toEqual([
      'Cronica',
      'Ciclo con data di fine',
      'Al bisogno',
      'S Suggerita dallo specialista',
      'H Da ricovero',
      'Non in corso',
    ]);
  });
});
