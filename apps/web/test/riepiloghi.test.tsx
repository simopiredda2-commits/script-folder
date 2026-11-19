import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

type Handler = (search: string) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { path: string; search: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const [path = '', search = ''] = url.split('?');
      calls.push({ path, search });
      const handler = routes[path];
      const r = handler ? handler(search) : { status: 404, body: { errore: 'Non trovato' } };
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

const summary = (dal: string, al: string, vaccines = true) => ({
  dal,
  al,
  visite: {
    totale: 3,
    telefonici: 1,
    perTipo: [
      { tipo: 'office', nome: 'In studio', numero: 1 },
      { tipo: 'home', nome: 'A domicilio', numero: 1 },
      { tipo: 'televisit', nome: 'Televisita', numero: 1 },
      { tipo: 'phone', nome: 'Telefono', numero: 1 },
    ],
    perMedico: [
      { medico: 'Dott.ssa Titolare Inventata', numero: 3 },
      { medico: 'Dott. Sostituto Inventato', numero: 1 },
    ],
  },
  ricette: {
    totale: { inviate: 2, cartacee: 1, annullate: 1, righe: 6 },
    perTipo: [
      {
        tipo: 'pharma_ssn',
        nome: 'Farmaceutica SSN',
        inviate: 1,
        cartacee: 1,
        annullate: 1,
        righe: 3,
      },
      {
        tipo: 'specialist_ssn',
        nome: 'Specialistica SSN',
        inviate: 1,
        cartacee: 0,
        annullate: 0,
        righe: 3,
      },
      { tipo: 'white', nome: 'Bianca', inviate: 0, cartacee: 0, annullate: 0, righe: 0 },
      { tipo: 'devices', nome: 'Presidi', inviate: 0, cartacee: 0, annullate: 0, righe: 0 },
    ],
    perMedico: [{ medico: 'Dott.ssa Titolare Inventata', numero: 4 }],
  },
  vaccinazioni: vaccines
    ? {
        totale: 3,
        perVaccino: [
          { vaccino: 'Antinfluenzale', campagna: '2026/2027', numero: 2 },
          { vaccino: 'Antitetanica', campagna: null, numero: 1 },
        ],
        perMedico: [{ medico: 'Dott.ssa Titolare Inventata', numero: 3 }],
      }
    : { totale: 0, perVaccino: [], perMedico: [] },
});

/** Il periodo come lo chiede l'interfaccia, dalla stringa di ricerca. */
const period = (search: string) => {
  const q = new URLSearchParams(search);
  return [q.get('dal') ?? '', q.get('al') ?? ''] as const;
};

describe('Riepiloghi per periodo nell’interfaccia (D201)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('il titolare vede i conteggi del periodo dell’indirizzo, con il CSV dello stesso periodo', async () => {
    window.history.pushState({}, '', '/archivio/riepiloghi?dal=2026-11-01&al=2026-11-19');
    const calls = stubFetch({
      '/api/io': ok(OWNER),
      '/api/archivi/a1/riepiloghi': (search) => ok(summary(...period(search)))(),
    });
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Riepiloghi' })).toBeTruthy();
    expect(
      await screen.findByText(
        'Riepilogo dal 01/11/2026 al 19/11/2026: 3 visite, 1 contatti telefonici, 2 ricette inviate, 3 vaccinazioni.',
      ),
    ).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c.path === '/api/archivi/a1/riepiloghi' && c.search === 'dal=2026-11-01&al=2026-11-19',
      ),
    ).toBe(true);
    const visits = screen.getByRole('table', { name: 'Note del diario per tipo di contatto' });
    expect(within(visits).getByRole('row', { name: 'A domicilio 1' })).toBeTruthy();
    const rx = screen.getByRole('table', { name: 'Ricette fatte nell’archivio, per tipo' });
    expect(within(rx).getByRole('row', { name: 'Farmaceutica SSN 1 1 1 3' })).toBeTruthy();
    expect(within(rx).getByRole('row', { name: 'Totale 2 1 1 6' })).toBeTruthy();
    const vaccines = screen.getByRole('table', { name: 'Vaccinazioni per vaccino e campagna' });
    expect(within(vaccines).getByRole('row', { name: 'Antitetanica — 1' })).toBeTruthy();
    // Per medico: visite, ricette e vaccinazioni insieme.
    expect(screen.getByRole('row', { name: 'Dott. Sostituto Inventato 1 0 0' })).toBeTruthy();
    expect(screen.getByRole('row', { name: 'Dott.ssa Titolare Inventata 3 4 3' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Scarica in CSV' }).getAttribute('href')).toBe(
      '/api/archivi/a1/riepiloghi/esportazione?dal=2026-11-01&al=2026-11-19',
    );
  });

  it('un periodo nuovo va nell’indirizzo e si chiede al servizio; senza vaccinazioni lo dice', async () => {
    window.history.pushState({}, '', '/archivio/riepiloghi?dal=2026-11-01&al=2026-11-19');
    const calls = stubFetch({
      '/api/io': ok(OWNER),
      '/api/archivi/a1/riepiloghi': (search) => ok(summary(...period(search), false))(),
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Dal'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Al (compreso)'), { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mostra il riepilogo' }));
    await waitFor(() => expect(window.location.search).toBe('?dal=2026-01-01&al=2026-06-30'));
    await waitFor(() =>
      expect(calls.some((c) => c.search === 'dal=2026-01-01&al=2026-06-30')).toBe(true),
    );
    expect(await screen.findByText('Nessuna vaccinazione nel periodo.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Scarica in CSV' }).getAttribute('href')).toBe(
      '/api/archivi/a1/riepiloghi/esportazione?dal=2026-01-01&al=2026-06-30',
    );
  });

  it('chi non è titolare di un archivio non ha la pagina', async () => {
    window.history.pushState({}, '', '/archivio/riepiloghi');
    const calls = stubFetch({
      '/api/io': ok({
        ...OWNER,
        ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
        archivio: null,
      }),
    });
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(calls.some((c) => c.path.includes('/riepiloghi'))).toBe(false);
  });
});
