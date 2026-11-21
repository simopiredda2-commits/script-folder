import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetPrintPreferences } from '../src/components/PrintHint';
import { ReminderPanel } from '../src/components/ReminderPanel';
import { SessionProvider } from '../src/lib/session';
import { PrintSection } from '../src/pages/admin/PrintSection';

type Handler = (method: string, body: unknown) => { status: number; body: unknown };

/** Servizio simulato: per ogni indirizzo una risposta; le chiamate restano per i controlli. */
function stubFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = routes[path];
      const r = handler ? handler(method, body) : { status: 404, body: { errore: 'Non trovato' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetPrintPreferences();
});

/** Persone, postazioni e stampanti inventate. */
const me = (roles: [string, string][]) => ({
  id: roles[0]![0],
  nome: 'Utente di prova',
  ruoli: roles.map(([codice, nome]) => ({ codice, nome })),
  postazione: 'Ambulatorio 1',
  archivio: null,
});
const DOCTOR = me([['owner_doctor', 'Medico titolare']]);
const ADMIN = me([['administrator', 'Amministratore dello studio']]);
const STATIONS = {
  postazioni: [
    {
      id: 'w1',
      nome: 'Ambulatorio 1',
      condivisa: true,
      note: null,
      creataIl: '2026-11-19T08:00:00.000Z',
      archiviataIl: null,
    },
  ],
  archiviate: [],
  puoModificare: false,
};

const KINDS = [
  ['promemoria', 'Promemoria della ricetta SSN', ['A5', 'A4'], 'A5', true],
  ['certificato_inps', 'Certificato di malattia INPS', [], 'A4', false],
  ['certificato_modello', 'Certificati dai modelli', ['A4', 'A5'], 'A4', false],
  ['schema_orario', 'Schema orario della terapia', ['A4', 'A5'], null, false],
] as const;

const predefined = {
  stampante: 'predefinito',
  copie: 'predefinito',
  carta: 'predefinito',
  variante: 'predefinito',
};
const effective = (over: Record<string, Record<string, unknown>> = {}) => ({
  postazione: { scritta: 'Ambulatorio 1', riconosciuta: { id: 'w1', nome: 'Ambulatorio 1' } },
  preferenze: KINDS.map(([tipo, nome, carte, carta, variante]) => ({
    tipo,
    nome,
    uscita: 'pdf',
    stampante: null,
    copie: 1,
    carta,
    cartaScelta: carte.length > 0,
    variante: variante ? 'completo' : null,
    da: predefined,
    suggerimento: null,
    ...over[tipo],
  })),
});
const empty = { stampante: null, carta: null, copie: null, variante: null };
const settings = (studio: Record<string, unknown> = {}, w1: Record<string, unknown> = {}) => ({
  tipi: KINDS.map(([codice, nome, carte, cartaPredefinita, variante]) => ({
    codice,
    nome,
    descrizione: `Descrizione di prova di ${nome}.`,
    uscita: 'pdf',
    carte,
    cartaPredefinita,
    fonteCarta: 'Fonte del formato di prova.',
    variante,
  })),
  carte: [
    { codice: 'A4', nome: 'A4 (210 × 297 mm)' },
    { codice: 'A5', nome: 'A5 (148 × 210 mm)' },
  ],
  varianti: [
    { codice: 'completo', nome: 'Promemoria completo' },
    { codice: 'solo_nre', nome: 'Solo NRE e codice fiscale' },
  ],
  limiti: { copies: { min: 1, max: 5 }, printerName: 100 },
  predefinite: { copie: 1, variante: 'completo' },
  studio: Object.fromEntries(KINDS.map(([k]) => [k, { ...empty, ...(studio[k] ?? {}) }])),
  postazioni: [
    {
      id: 'w1',
      nome: 'Ambulatorio 1',
      condivisa: true,
      preferenze: Object.fromEntries(KINDS.map(([k]) => [k, { ...empty, ...(w1[k] ?? {}) }])),
    },
  ],
  puoModificare: true,
});

describe('preferenze di stampa (tappa 14)', () => {
  it('il medico vede che cosa vale alla sua postazione e che cosa fa il programma; non le modifica', async () => {
    const calls = stubFetch({
      '/api/io': () => ({ status: 200, body: DOCTOR }),
      '/api/studio/postazioni': () => ({ status: 200, body: STATIONS }),
      '/api/stampa/preferenze': () => ({
        status: 200,
        body: effective({
          certificato_modello: {
            stampante: 'Stampante dell’ambulatorio',
            carta: 'A5',
            copie: 2,
            da: {
              stampante: 'postazione',
              copie: 'studio',
              carta: 'postazione',
              variante: 'predefinito',
            },
          },
        }),
      }),
    });
    render(
      <SessionProvider>
        <PrintSection />
      </SessionProvider>,
    );
    const table = await screen.findByRole('table', { name: 'Questa postazione' });
    expect(screen.getByText(/è la postazione «Ambulatorio 1» dello studio/)).toBeTruthy();
    const row = within(table).getByRole('row', { name: /Certificati dai modelli/ });
    expect(row.textContent).toContain('Stampante dell’ambulatorio (della postazione)');
    expect(row.textContent).toContain('2 copie (dello studio)');
    expect(row.textContent).toContain('A5 (della postazione)');
    const inps = within(table).getByRole('row', { name: /Certificato di malattia INPS/ });
    expect(inps.textContent).toContain('A4 (fissata)');
    expect(
      screen.getByRole('heading', { name: 'Che cosa può fare il programma con le stampanti' }),
    ).toBeTruthy();
    expect(screen.getByText(/Non vede le stampanti del computer/)).toBeTruthy();
    await screen.findByText('Le preferenze di stampa le cambia l’amministratore dello studio.');
    // Chi non è amministratore non chiede nemmeno tutte le preferenze.
    expect(calls.some((c) => c.path === '/api/stampa/impostazioni')).toBe(false);
  });

  it('l’amministratore sceglie una postazione, modifica un documento e salva: vuoto vuol dire come lo studio', async () => {
    let saved = settings({ certificato_modello: { copie: 2 } });
    const calls = stubFetch({
      '/api/io': () => ({ status: 200, body: ADMIN }),
      '/api/studio/postazioni': () => ({ status: 200, body: STATIONS }),
      '/api/stampa/preferenze': () => ({ status: 200, body: effective() }),
      '/api/stampa/impostazioni': (method, body) => {
        if (method === 'PUT') {
          const b = body as Record<string, unknown>;
          saved = settings(
            { certificato_modello: { copie: 2 } },
            { certificato_modello: { stampante: b.stampante, carta: b.carta, copie: b.copie } },
          );
        }
        return { status: 200, body: saved };
      },
    });
    const user = userEvent.setup();
    render(
      <SessionProvider>
        <PrintSection />
      </SessionProvider>,
    );
    await user.selectOptions(await screen.findByLabelText('Preferenze di'), 'w1');
    const table = await screen.findByRole('table', {
      name: 'Preferenze della postazione «Ambulatorio 1»',
    });
    // Quello che la postazione lascia vuoto viene dallo studio.
    expect(
      within(table).getByRole('row', { name: /Certificati dai modelli/ }).textContent,
    ).toContain('Come lo studio: 2 copie');
    await user.click(
      within(table).getByRole('button', {
        name: 'Modifica le preferenze della postazione «Ambulatorio 1» per «Certificati dai modelli»',
      }),
    );
    const printer = await screen.findByLabelText('Stampante consigliata');
    await waitFor(() => expect(document.activeElement).toBe(printer));
    await user.type(printer, '  Stampante dell’ambulatorio ');
    expect(
      within(screen.getByLabelText('Copie')).getByRole('option', {
        name: 'Come lo studio: 2 copie',
      }),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Carta'), 'A5');
    await user.click(screen.getByRole('button', { name: 'Salva le preferenze' }));
    await screen.findByText(
      'Preferenze della postazione «Ambulatorio 1» per «Certificati dai modelli» salvate.',
    );
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      {
        postazione: 'w1',
        tipo: 'certificato_modello',
        stampante: 'Stampante dell’ambulatorio',
        copie: null,
        carta: 'A5',
        variante: null,
      },
    ]);
    // Dopo il salvataggio si rilegge che cosa vale alla postazione.
    expect(calls.filter((c) => c.path === '/api/stampa/preferenze').length).toBeGreaterThan(1);
  });

  it('il promemoria propone per primo la variante preferita, con il suggerimento di stampa', async () => {
    stubFetch({
      '/api/io': () => ({ status: 200, body: DOCTOR }),
      '/api/pazienti/p1/recapiti-promemoria': () => ({
        status: 200,
        body: { paziente: { email: null, telefono: null }, deleghe: [] },
      }),
      '/api/ricette/r1/promemoria/consegne': () => ({
        status: 200,
        body: {
          consegne: [],
          carta: 'A4',
          disponibile: { promemoria: true, soloNre: true, email: true, sms: true, motivo: null },
        },
      }),
      '/api/stampa/preferenze': () => ({
        status: 200,
        body: effective({
          promemoria: {
            stampante: 'Stampante della segreteria',
            variante: 'solo_nre',
            carta: 'A4',
            da: {
              stampante: 'studio',
              copie: 'predefinito',
              carta: 'studio',
              variante: 'studio',
            },
            suggerimento:
              'Stampante consigliata: Stampante della segreteria, 1 copia, carta A4, solo NRE e codice fiscale',
          },
        }),
      }),
    });
    render(
      <SessionProvider>
        <ReminderPanel prescriptionId="r1" patientId="p1" kind="pharma_ssn" />
      </SessionProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Promemoria della ricetta' });
    const hint = await within(panel).findByText(
      /Stampante consigliata: Stampante della segreteria/,
    );
    const links = within(panel).getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual(['Solo NRE (PDF)', 'Promemoria (PDF)']);
    expect(links[0]!.className).toContain('pulsante-primario');
    expect(links[1]!.className).not.toContain('pulsante-primario');
    expect(links[0]!.getAttribute('href')).toBe('/api/ricette/r1/promemoria?formato=nre');
    expect(links[0]!.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.textContent).toMatch(/Si confermano nella finestra di stampa\./);
    // La carta scelta dallo studio, e come stampare perché i codici restino delle misure giuste.
    expect(within(panel).getByText(/Carta A4, con il promemoria nella metà alta\./)).toBeTruthy();
    expect(within(panel).getByText(/Stampa al 100% \(«dimensioni effettive»\)/)).toBeTruthy();
  });

  it('senza preferenze il promemoria resta com’è: completo per primo, nessun suggerimento', async () => {
    stubFetch({
      '/api/io': () => ({ status: 200, body: DOCTOR }),
      '/api/pazienti/p1/recapiti-promemoria': () => ({
        status: 200,
        body: { paziente: { email: null, telefono: null }, deleghe: [] },
      }),
      '/api/ricette/r1/promemoria/consegne': () => ({
        status: 200,
        body: {
          consegne: [],
          carta: 'A5',
          disponibile: { promemoria: true, soloNre: true, email: true, sms: true, motivo: null },
        },
      }),
      '/api/stampa/preferenze': () => ({ status: 200, body: effective() }),
    });
    render(
      <SessionProvider>
        <ReminderPanel prescriptionId="r1" patientId="p1" kind="pharma_ssn" />
      </SessionProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Promemoria della ricetta' });
    await waitFor(() => expect(within(panel).getAllByRole('link')).toHaveLength(2));
    const links = within(panel).getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual(['Promemoria (PDF)', 'Solo NRE (PDF)']);
    expect(links.every((l) => !l.className.includes('pulsante-primario'))).toBe(true);
    expect(links.every((l) => !l.hasAttribute('aria-describedby'))).toBe(true);
    expect(within(panel).queryByText(/finestra di stampa/)).toBeNull();
    // Senza preferenze: A5 orizzontale (D222).
    expect(await within(panel).findByText(/Carta A5 orizzontale\./)).toBeTruthy();
  });

  it('la carta la dice il servizio: un promemoria del modello di prima esce su A4 anche con A5 scelto (D232)', async () => {
    stubFetch({
      '/api/io': () => ({ status: 200, body: DOCTOR }),
      '/api/pazienti/p1/recapiti-promemoria': () => ({
        status: 200,
        body: { paziente: { email: null, telefono: null }, deleghe: [] },
      }),
      '/api/ricette/r1/promemoria/consegne': () => ({
        status: 200,
        body: {
          consegne: [],
          carta: 'A4',
          disponibile: { promemoria: true, soloNre: true, email: true, sms: true, motivo: null },
        },
      }),
      '/api/stampa/preferenze': () => ({ status: 200, body: effective() }),
    });
    render(
      <SessionProvider>
        <ReminderPanel prescriptionId="r1" patientId="p1" kind="pharma_ssn" />
      </SessionProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Promemoria della ricetta' });
    expect(
      await within(panel).findByText(/Carta A4, con il promemoria nella metà alta\./),
    ).toBeTruthy();
    expect(within(panel).queryByText(/Carta A5/)).toBeNull();
  });
});
