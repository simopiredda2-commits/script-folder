import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendPanel } from '../src/components/SendPanel';
import { SessionProvider } from '../src/lib/session';

/**
 * «Firma e invia» a controllo finito (D230): chi firma vede sempre i controlli prima di firmare.
 * Servizio finto: la prova non chiama nulla di vero; dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const me = (roles: string[]) => ({
  id: 'u1',
  nome: 'Utente di prova',
  ruoli: roles.map((codice) => ({ codice, nome: codice })),
  postazione: 'Studio',
  archivio: null,
});

/** Il servizio finto: il controllo risponde quando lo decide la prova. */
function service(
  roles: string[],
  check: () => Promise<Response>,
  signed: object = { esito: 'accepted', nre: '0101A0000000001', messaggio: null },
  toSignFails = false,
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split('?')[0]!;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/io') return Promise.resolve(json(200, me(roles)));
      if (path === '/api/ricette/r1/controlla') return check();
      if (path === '/api/ricette/r1/firma-e-invia') return Promise.resolve(json(200, signed));
      if (path === '/api/ricette/r1/da-firmare')
        return toSignFails
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(json(200, { stato: 'to_sign' }));
      return Promise.resolve(json(404, { errore: 'Non trovato' }));
    }),
  );
  return calls;
}

const checked = () => json(200, { versioneRegole: 'prova-1', problemi: [], bloccanti: 0 });

function panel(status = 'draft', lastErrorKind: string | null = null, preview = false) {
  render(
    <SessionProvider>
      <MemoryRouter>
        <SendPanel
          prescriptionId="r1"
          status={status}
          lastErrorKind={lastErrorKind}
          lineNames={{}}
          preview={preview}
        />
      </MemoryRouter>
    </SessionProvider>,
  );
}

const disabled = (b: HTMLElement) => (b as HTMLButtonElement).disabled;
/** Lo stato del controllo, annunciato ai lettori di schermo. */
const checkStatus = () => document.querySelector('.stato-controllo')!.textContent;

describe('firma e invio a controllo finito (D230)', () => {
  it('«Firma e invia» resta spento finché il controllo prima dell’invio non è finito, e lo dice; poi si firma', async () => {
    let finish!: () => void;
    const calls = service(
      ['owner_doctor'],
      () => new Promise<Response>((ok) => (finish = () => ok(checked()))),
    );
    panel();
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    expect(disabled(sign)).toBe(true);
    expect(disabled(screen.getByRole('button', { name: 'Controlla di nuovo' }))).toBe(true);
    expect(checkStatus()).toBe('Controllo in corso: si firma quando è finito.');
    finish();
    await waitFor(() => expect(disabled(sign)).toBe(false));
    expect(checkStatus()).toBe('');
    await screen.findByText('Regole di prescrizione, versione prova-1');
    await userEvent.click(sign);
    await screen.findByText(/Ricetta inviata/);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /api/ricette/r1/controlla',
      'POST /api/ricette/r1/firma-e-invia',
    ]);
  });

  it('«Controlla di nuovo» rispegne la firma finché il controllo nuovo non è finito', async () => {
    const pending: (() => void)[] = [];
    service(
      ['owner_doctor'],
      () => new Promise<Response>((ok) => pending.push(() => ok(checked()))),
    );
    panel();
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!();
    await waitFor(() => expect(disabled(sign)).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Controlla di nuovo' }));
    await waitFor(() => expect(disabled(sign)).toBe(true));
    pending[1]!();
    await waitFor(() => expect(disabled(sign)).toBe(false));
  });

  it('la segreteria manda alla firma a controllo finito', async () => {
    let finish!: () => void;
    service(['secretary'], () => new Promise<Response>((ok) => (finish = () => ok(checked()))));
    panel();
    const send = await screen.findByRole('button', { name: 'Manda alla firma del medico' });
    expect(disabled(send)).toBe(true);
    expect(checkStatus()).toBe('Controllo in corso: si manda alla firma quando è finito.');
    finish();
    await waitFor(() => expect(disabled(send)).toBe(false));
  });

  it('se il controllo non riesce si può firmare lo stesso: il servizio controlla di nuovo all’invio', async () => {
    service(['owner_doctor'], () =>
      Promise.resolve(json(500, { errore: 'Errore del servizio di prova' })),
    );
    panel();
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(disabled(sign)).toBe(false));
    await screen.findByText(/Errore del servizio di prova/);
  });

  it('se il controllo resta senza risposta (rete, proxy) lo dice, e la firma si riaccende (D232)', async () => {
    service(['owner_doctor'], () => Promise.reject(new TypeError('Failed to fetch')));
    panel();
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(disabled(sign)).toBe(false));
    await screen.findByText(/Controllo non riuscito: il servizio non ha risposto/);
  });

  it('ricetta partita senza i dati del promemoria: l’NRE e l’avviso, con simbolo e parola (D232)', async () => {
    service(['owner_doctor'], () => Promise.resolve(checked()), {
      esito: 'accepted',
      nre: '0101A0000000002',
      messaggio:
        'Ricetta partita, NRE 0101A0000000002: i dati del promemoria non si sono potuti fissare, quindi il promemoria non si stampa.',
    });
    panel();
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(disabled(sign)).toBe(false));
    await userEvent.click(sign);
    await screen.findByText(/Ricetta inviata\. NRE/);
    const warning = await screen.findByText(/il promemoria non si stampa/);
    expect(warning.closest('[class*="avviso"]')).toBeTruthy();
  });

  it('un controllo riuscito toglie l’errore di quello di prima (D239)', async () => {
    let first = true;
    service(['owner_doctor'], () => {
      if (first) {
        first = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(checked());
    });
    panel();
    await screen.findByText(/Controllo non riuscito: il servizio non ha risposto/);
    await userEvent.click(screen.getByRole('button', { name: 'Controlla di nuovo' }));
    await waitFor(() => expect(screen.queryByText(/Controllo non riuscito/)).toBeNull());
    await screen.findByText(/Regole di prescrizione, versione prova-1/);
  });

  it('la segreteria che manda alla firma senza risposta del servizio lo sa (D239)', async () => {
    service(['secretary'], () => Promise.resolve(checked()), undefined, true);
    panel();
    const send = await screen.findByRole('button', { name: 'Manda alla firma del medico' });
    await waitFor(() => expect(disabled(send)).toBe(false));
    await userEvent.click(send);
    await screen.findByText(/Il servizio non ha risposto: ricarica la pagina/);
  });

  it('fra gli invii non riusciti, con l’ente che non rispondeva, si stampa la ricetta rossa (D239)', async () => {
    service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('error', 'unreachable');
    await screen.findByRole('button', { name: 'Stampa la ricetta rossa' });
    expect(screen.getByText(/Il servizio regionale non risponde/)).toBeTruthy();
  });

  it('con un esito incerto la ricetta rossa non c’è', async () => {
    service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('error', 'timeout');
    await screen.findByRole('button', { name: 'Firma e invia' });
    expect(screen.queryByRole('button', { name: 'Stampa la ricetta rossa' })).toBeNull();
  });
});

describe('anteprima del promemoria prima della firma (D253)', () => {
  it('per la ricetta SSN non inviata c’è il collegamento al PDF; per la bianca no', async () => {
    service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('draft', null, true);
    const link = await screen.findByRole('link', { name: 'Anteprima del promemoria (PDF)' });
    expect(link.getAttribute('href')).toBe('/api/ricette/r1/promemoria/anteprima');
    cleanup();
    service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('draft', null, false);
    await screen.findByRole('button', { name: 'Controlla di nuovo' });
    expect(screen.queryByRole('link', { name: 'Anteprima del promemoria (PDF)' })).toBeNull();
  });
});
