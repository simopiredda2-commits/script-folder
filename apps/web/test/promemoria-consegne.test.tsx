import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReminderPanel } from '../src/components/ReminderPanel';
import { SessionProvider } from '../src/lib/session';
import { SignQueuePage } from '../src/pages/SignQueuePage';

/**
 * Il promemoria offre solo ciò che il servizio accetta, con il motivo di ciò che manca; i
 * collegamenti di Oggi portano alla loro sezione della pagina Ricette (D239). Servizio finto, dati
 * inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const doctor = {
  id: 'u1',
  nome: 'Medico inventato',
  ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
  postazione: 'Studio',
  archivio: null,
};

function service(available: object, posts: { path: string; body: unknown }[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      if (init?.method === 'POST') {
        posts.push({ path, body: JSON.parse(init.body as string) as unknown });
        return Promise.resolve(json(200, { consegnato: true }));
      }
      if (path === '/api/io') return Promise.resolve(json(200, doctor));
      if (path === '/api/ricette/r1/promemoria/consegne')
        return Promise.resolve(json(200, { consegne: [], carta: null, disponibile: available }));
      if (path === '/api/pazienti/p1/recapiti-promemoria')
        return Promise.resolve(
          json(200, {
            paziente: { email: 'paziente@esempio.invalid', telefono: '3330000000' },
            deleghe: [],
          }),
        );
      if (path.startsWith('/api/ricette/')) return Promise.resolve(json(200, { pazienti: [] }));
      // Nessuna preferenza di stampa: i pulsanti restano nell'ordine di sempre.
      if (path === '/api/stampa/preferenze')
        return Promise.resolve(json(200, { postazione: null, preferenze: [] }));
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
}

function panel(kind = 'pharma_ssn') {
  render(
    <SessionProvider>
      <MemoryRouter>
        <ReminderPanel
          prescriptionId="r1"
          patientId="p1"
          kind={kind}
          title="Promemoria della ricetta di Paola Inventata"
        />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('promemoria: solo ciò che si può consegnare (D239)', () => {
  it('senza i dati fissati all’invio: niente PDF né email, l’SMS sì, e il motivo', async () => {
    service({
      promemoria: false,
      soloNre: false,
      email: false,
      sms: true,
      motivo:
        'I dati del promemoria non si sono potuti fissare all’invio: il promemoria non si stampa',
    });
    panel();
    const box = within(
      await screen.findByRole('region', { name: 'Promemoria della ricetta di Paola Inventata' }),
    );
    await box.findByText(/I dati del promemoria non si sono potuti fissare/);
    expect(box.queryByRole('link', { name: /Promemoria \(PDF\)/ })).toBeNull();
    expect(box.queryByRole('link', { name: /Solo NRE/ })).toBeNull();
    await waitFor(() =>
      expect(box.getAllByRole('radio').map((r) => r.id)).toEqual(['canale-r1-sms']),
    );
    expect(box.getByRole<HTMLInputElement>('radio').checked).toBe(true);
  });

  it('senza il codice di autenticazione: nessuna consegna, e il motivo', async () => {
    service({
      promemoria: false,
      soloNre: false,
      email: false,
      sms: false,
      motivo: 'Manca il codice di autenticazione del SAC: la ricetta non è valida',
    });
    panel();
    await screen.findByText(/Manca il codice di autenticazione del SAC/);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('group', { name: /Invia al paziente/ })).toBeNull();
  });

  it('con tutto: promemoria, solo NRE, email e SMS, senza avvisi', async () => {
    service({ promemoria: true, soloNre: true, email: true, sms: true, motivo: null });
    panel();
    await screen.findByRole('link', { name: /Promemoria \(PDF\)/ });
    expect(screen.getByRole('link', { name: /Solo NRE/ })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });
});

describe('consegna su carta (audit D259)', () => {
  it('aprire il PDF non registra niente: la consegna la segna chi ha dato il foglio', async () => {
    const posts: { path: string; body: unknown }[] = [];
    service({ promemoria: true, soloNre: true, email: true, sms: true, motivo: null }, posts);
    panel();
    const link = await screen.findByRole('link', { name: /Solo NRE/ });
    // Prima di aprire un PDF non c'è niente da segnare.
    expect(screen.queryByRole('button', { name: 'Consegnato su carta' })).toBeNull();
    // In jsdom il collegamento non apre niente: conta il clic, come nel browser.
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    const group = within(await screen.findByRole('group', { name: 'Consegna su carta' }));
    expect(group.getByText(/Aprire il PDF non è una consegna/)).toBeTruthy();
    expect(group.getByText(/il foglio con l’NRE/)).toBeTruthy();
    expect(posts).toEqual([]);
    group.getByRole('button', { name: 'Consegnato su carta' }).click();
    await screen.findByText('Consegna del foglio con l’NRE registrata.');
    expect(posts).toEqual([
      { path: '/api/ricette/r1/promemoria/consegna-carta', body: { formato: 'nre' } },
    ]);
    expect(screen.queryByRole('group', { name: 'Consegna su carta' })).toBeNull();
  });
});

describe('pagina Ricette: le ancore di Oggi (D239)', () => {
  for (const [hash, name] of [
    ['#senza-risposta', 'Invii senza risposta'],
    ['#non-inviate', 'Invii non riusciti'],
  ] as const)
    it(`${hash} porta il fuoco sul titolo «${name}»`, async () => {
      service({});
      render(
        <SessionProvider>
          <MemoryRouter initialEntries={[`/ricette${hash}`]}>
            <SignQueuePage />
          </MemoryRouter>
        </SessionProvider>,
      );
      const heading = await screen.findByRole('heading', { level: 2, name });
      await waitFor(() => expect(document.activeElement).toBe(heading));
    });
});
