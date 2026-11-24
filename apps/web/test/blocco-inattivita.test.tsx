import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '../src/lib/session';

/**
 * Blocco per inattività nella pagina (audit D259): allo scadere dei minuti dello studio la pagina
 * si copre da sola, senza aspettare un clic, e chiede al servizio di bloccare la sessione. Servizio
 * finto, orologio finto.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function Status() {
  const { state } = useSession();
  return <p>{state.status}</p>;
}

function start(minutes: number | null) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/io')
        return Promise.resolve(
          json(200, {
            id: 'u1',
            nome: 'Medico inventato',
            ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
            postazione: 'Studio',
            archivio: null,
            minutiInattivita: minutes,
          }),
        );
      return Promise.resolve(json(200, { stato: 'bloccata' }));
    }),
  );
  render(
    <SessionProvider>
      <Status />
    </SessionProvider>,
  );
  return calls;
}

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('blocco per inattività nella pagina (audit D259)', () => {
  it('allo scadere la pagina si blocca da sola e lo chiede al servizio; un tasto fa ripartire il conto', async () => {
    const calls = start(1);
    await wait(0);
    expect(screen.getByText('ready')).toBeTruthy();
    // 50 secondi, poi un tasto: il conto riparte da lì.
    await wait(50_000);
    fireEvent.keyDown(window, { key: 'a' });
    await wait(50_000);
    expect(screen.getByText('ready')).toBeTruthy();
    expect(calls).not.toContain('POST /api/sessione/blocca');
    // Un minuto dal tasto: bloccata, senza nessun clic.
    await wait(11_000);
    expect(screen.getByText('locked')).toBeTruthy();
    expect(calls).toContain('POST /api/sessione/blocca');
  });

  it('senza minuti dello studio la pagina non si blocca da sola', async () => {
    const calls = start(null);
    await wait(0);
    await wait(60 * 60_000);
    expect(screen.getByText('ready')).toBeTruthy();
    expect(calls).not.toContain('POST /api/sessione/blocca');
  });
});
