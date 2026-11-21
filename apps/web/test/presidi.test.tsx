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
    { chiave: 'diabetici', nome: 'Presidi per diabetici', fonte: 'allegato 3', allegato: '3' },
    { chiave: 'monouso', nome: 'Dispositivi medici monouso', fonte: 'allegato 2', allegato: '2' },
    { chiave: 'dietetici', nome: 'Prodotti dietetici', fonte: 'art. 14', allegato: null },
  ],
};

/** Voci inventate nella forma del nomenclatore (D218). */
const item = (codice: string, descrizione: string, gruppo: string) => ({
  codice,
  descrizione,
  gruppo,
  allegato: '3',
  atto: 'DPCM di prova, allegato 3',
});
const CATALOG = {
  presidi: [
    item('V0104', 'Lancette pungidito di prova', 'Lancette pungidito'),
    item('V0104', 'Minilancette pungidito di prova', 'Lancette pungidito'),
    item('W0201060102 / Z12040115', 'Apparecchio di prova', 'Apparecchi di prova'),
  ],
  malattieRare: [item('RCG061', 'MALATTIA RARA DI PROVA', 'Malattie rare')],
};

function routes(catalog: unknown) {
  return stubFetch({
    '/api/io': ok(ME),
    '/api/oggi': ok({ data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } }),
    '/api/pazienti/p1': ok(PATIENT),
    '/api/pazienti/p1/voci': ok({ voci: [] }),
    '/api/pazienti/p1/presidi': (method) =>
      method === 'POST'
        ? { status: 201, body: { id: 's9' } }
        : { status: 200, body: { presidi: [], puoScrivere: true } },
    '/api/presidi/categorie': ok(CATEGORIES),
    '/api/presidi/nomenclatore': ok(catalog),
  });
}

describe('presidi: scelta dal nomenclatore del DPCM LEA (D218)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('la voce scelta riempie prodotto e codice; le malattie rare sono elencate', async () => {
    const calls = routes(CATALOG);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const select = await screen.findByLabelText('Dal nomenclatore (allegato 3)');
    expect([...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))).toEqual([
      'Lancette pungidito',
      'Apparecchi di prova',
    ]);
    const option = within(select).getByRole('option', {
      name: 'Apparecchio di prova · W0201060102 / Z12040115',
    });
    fireEvent.change(select, { target: { value: option.getAttribute('value') } });
    expect(screen.getByLabelText<HTMLInputElement>('Prodotto').value).toBe('Apparecchio di prova');
    expect(screen.getByLabelText<HTMLInputElement>('Codice del nomenclatore').value).toBe(
      'W0201060102 / Z12040115',
    );
    expect(screen.getByText(/Fonte: DPCM di prova, allegato 3/)).toBeTruthy();
    expect(screen.getByText('MALATTIA RARA DI PROVA')).toBeTruthy();
    // Lo stesso codice per due presidi: si sceglie il presidio, non solo il codice.
    fireEvent.change(select, {
      target: {
        value: within(select)
          .getByRole('option', { name: 'Minilancette pungidito di prova · V0104' })
          .getAttribute('value'),
      },
    });
    expect(screen.getByLabelText<HTMLInputElement>('Prodotto').value).toBe(
      'Minilancette pungidito di prova',
    );
    fireEvent.change(screen.getByLabelText('Fabbisogno al mese'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Unità'), { target: { value: 'pezzi' } });
    fireEvent.click(screen.getByRole('button', { name: /Registra la prescrizione/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        categoria: 'diabetici',
        prodotto: 'Minilancette pungidito di prova',
        codice: 'V0104',
      }),
    );
  });

  it('tornare a «scrivi a mano» svuota prodotto e codice, non sceglie la prima voce (D232)', async () => {
    const calls = routes(CATALOG);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    const select = await screen.findByLabelText<HTMLSelectElement>('Dal nomenclatore (allegato 3)');
    fireEvent.change(select, {
      target: {
        value: within(select)
          .getByRole('option', { name: 'Apparecchio di prova · W0201060102 / Z12040115' })
          .getAttribute('value'),
      },
    });
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getByLabelText<HTMLInputElement>('Prodotto').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Codice del nomenclatore').value).toBe('');
    expect(select.value).toBe('');
    // Scritto a mano, il prodotto parte senza il codice di un'altra voce.
    fireEvent.change(screen.getByLabelText('Prodotto'), {
      target: { value: 'Prodotto scritto a mano' },
    });
    fireEvent.change(screen.getByLabelText('Fabbisogno al mese'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Unità'), { target: { value: 'pezzi' } });
    fireEvent.click(screen.getByRole('button', { name: /Registra la prescrizione/ }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    const body = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(body.prodotto).toBe('Prodotto scritto a mano');
    expect(body.codice).toBeUndefined();
  });

  it('nessuna scelta per le categorie senza nomenclatore o con il nomenclatore vuoto', async () => {
    routes(CATALOG);
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    await screen.findByLabelText('Dal nomenclatore (allegato 3)');
    // Monouso: l'allegato 2 non è ancora trascritto. Dietetici: nessun allegato.
    for (const value of ['monouso', 'dietetici']) {
      fireEvent.change(screen.getByLabelText('Categoria'), { target: { value } });
      expect(screen.queryByLabelText(/Dal nomenclatore/)).toBeNull();
    }
  });

  it('senza banca dati controllata il modulo resta quello di sempre', async () => {
    routes({ presidi: [], malattieRare: [] });
    window.history.pushState({}, '', '/pazienti/p1/presidi');
    render(<App />);
    await screen.findByLabelText('Prodotto');
    expect(screen.queryByLabelText(/Dal nomenclatore/)).toBeNull();
  });
});
