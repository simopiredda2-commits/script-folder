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

function panel(
  status = 'draft',
  lastErrorKind: string | null = null,
  preview = false,
  autoSign = false,
  onChange?: (status: string, nre?: string) => void,
  onEdit?: () => void,
) {
  render(
    <SessionProvider>
      <MemoryRouter>
        <SendPanel
          prescriptionId="r1"
          status={status}
          lastErrorKind={lastErrorKind}
          lineNames={{}}
          preview={preview}
          autoSign={autoSign}
          {...(onChange ? { onChange } : {})}
          {...(onEdit ? { onEdit } : {})}
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

describe('ricetta del medico in un passo (D255)', () => {
  const signs = (calls: string[]) =>
    calls.filter((c) => c === 'POST /api/ricette/r1/firma-e-invia');
  const warned = () =>
    json(200, {
      versioneRegole: 'prova-1',
      problemi: [
        {
          ruleId: 'R18',
          severity: 'warn',
          message: 'Codice non nel catalogo del programma',
          remedy: null,
          lineId: null,
        },
      ],
      bloccanti: 0,
    });

  it('a controllo finito senza problemi firma e invia da sé, una volta sola', async () => {
    const changes: string[] = [];
    const calls = service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('draft', null, false, true, (status) => changes.push(status));
    await screen.findByText('Ricetta inviata.', { exact: false });
    expect(signs(calls)).toHaveLength(1);
    expect(changes).toEqual(['sent']);
  });

  it('l’informazione R1 sulla validità, che c’è sempre, non ferma il passo unico', async () => {
    const calls = service(['owner_doctor'], () =>
      Promise.resolve(
        json(200, {
          versioneRegole: 'prova-1',
          problemi: [
            {
              ruleId: 'R1',
              severity: 'info',
              message: 'La ricetta vale 30 giorni',
              remedy: null,
              lineId: null,
            },
          ],
          bloccanti: 0,
        }),
      ),
    );
    panel('draft', null, false, true);
    await screen.findByText('Ricetta inviata.', { exact: false });
    expect(signs(calls)).toHaveLength(1);
  });

  it('un’altra informazione ferma il passo unico (R21, farmaco carente)', async () => {
    const calls = service(['owner_doctor'], () =>
      Promise.resolve(
        json(200, {
          versioneRegole: 'prova-1',
          problemi: [
            {
              ruleId: 'R21',
              severity: 'info',
              message: 'Farmaco carente secondo l’elenco AIFA',
              remedy: null,
              lineId: 'l1',
            },
          ],
          bloccanti: 0,
        }),
      ),
    );
    panel('draft', null, false, true);
    await screen.findByText(/La ricetta non è ancora partita/);
    expect(signs(calls)).toHaveLength(0);
  });

  it('con un problema dei controlli si ferma: niente invio, lo dice, si firma con il pulsante', async () => {
    const calls = service(['owner_doctor'], () => Promise.resolve(warned()));
    panel('draft', null, false, true);
    await screen.findByText(/La ricetta non è ancora partita/);
    screen.getByText(/Codice non nel catalogo del programma/);
    expect(signs(calls)).toHaveLength(0);
    await userEvent.type(
      screen.getByLabelText('Motivo per procedere nonostante l’avviso R18'),
      'Codice nuovo',
    );
    // Si procede solo con la conferma esplicita del medico (D256).
    expect(screen.queryByRole('button', { name: 'Firma e invia' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Ho visto i controlli: firma e invia' }),
    );
    await screen.findByText('Ricetta inviata.', { exact: false });
    expect(signs(calls)).toHaveLength(1);
  });

  it('con il controllo non riuscito non firma, nemmeno dopo «Controlla di nuovo»', async () => {
    let fail = true;
    const calls = service(['owner_doctor'], () =>
      fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(checked()),
    );
    panel('draft', null, false, true);
    await screen.findByText(/Controllo non riuscito/);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Controlla di nuovo' }));
    await waitFor(() => expect(checkStatus()).toBe(''));
    expect(screen.queryByText(/Controllo non riuscito/)).toBeNull();
    expect(signs(calls)).toHaveLength(0);
  });

  it('senza «in un passo» il medico firma solo con il pulsante', async () => {
    const calls = service(['owner_doctor'], () => Promise.resolve(checked()));
    panel('draft');
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(disabled(sign)).toBe(false));
    expect(signs(calls)).toHaveLength(0);
  });

  it('la segreteria non firma mai, nemmeno «in un passo»', async () => {
    const calls = service(['secretary'], () => Promise.resolve(checked()));
    panel('draft', null, false, true);
    const toSign = await screen.findByRole('button', { name: 'Manda alla firma del medico' });
    await waitFor(() => expect(disabled(toSign)).toBe(false));
    expect(signs(calls)).toHaveLength(0);
  });
});

describe('con un blocco non si firma: si corregge (audit, D259)', () => {
  const signs = (calls: string[]) =>
    calls.filter((c) => c === 'POST /api/ricette/r1/firma-e-invia');
  const blocked = () =>
    json(200, {
      versioneRegole: 'prova-1',
      problemi: [
        {
          ruleId: 'R2',
          severity: 'block',
          message: '3 confezioni: il limite è 2',
          remedy: null,
          lineId: null,
        },
      ],
      bloccanti: 1,
    });

  it('«in un passo» si ferma, la firma è spenta, la pagina dice che cosa correggere', async () => {
    const edits: string[] = [];
    const calls = service(['owner_doctor'], () => Promise.resolve(blocked()));
    panel('draft', null, false, true, undefined, () => edits.push('modifica'));
    await screen.findByText(/La ricetta non può partire: R2 blocca/);
    // Non invita a confermare: il pulsante non dice «Ho visto i controlli», ed è spento.
    expect(screen.queryByText(/conferma con «Ho visto i controlli/)).toBeNull();
    const sign = screen.getByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(checkStatus()).toBe(''));
    expect(disabled(sign)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Modifica la ricetta' }));
    expect(edits).toEqual(['modifica']);
    expect(signs(calls)).toHaveLength(0);
  });

  it('anche senza il passo unico, e senza «Modifica» dove non si modifica (la coda)', async () => {
    service(['owner_doctor'], () => Promise.resolve(blocked()));
    panel('to_sign');
    await screen.findByText(/La ricetta non può partire: R2 blocca/);
    expect(disabled(screen.getByRole('button', { name: 'Firma e invia' }))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Modifica la ricetta' })).toBeNull();
  });

  it('la nota AIFA (R7) non spegne la firma: si conferma con la casella', async () => {
    service(['owner_doctor'], () =>
      Promise.resolve(
        json(200, {
          versioneRegole: 'prova-1',
          problemi: [
            {
              ruleId: 'R7',
              severity: 'block',
              needs: 'aifa_confirmation',
              message: 'Nota AIFA 13',
              remedy: null,
              lineId: 'l1',
            },
          ],
          bloccanti: 1,
        }),
      ),
    );
    panel('draft');
    const sign = await screen.findByRole('button', { name: 'Firma e invia' });
    await waitFor(() => expect(disabled(sign)).toBe(false));
    expect(screen.queryByText(/La ricetta non può partire/)).toBeNull();
  });
});
