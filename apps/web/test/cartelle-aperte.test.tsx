import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  addRecord,
  MAX_OPEN_RECORDS,
  patientIdOf,
  recordLabel,
  type OpenRecord,
} from '../src/lib/openRecords';

const rec = (n: number, extra: Partial<OpenRecord> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  lastName: `Cognome${n}`,
  firstName: 'Nome',
  birthDate: '1960-01-01',
  lastPath: `/pazienti/${n}`,
  ...extra,
});

describe('cartelle aperte insieme (D68)', () => {
  it('si tengono aperte fino a 20; alla ventunesima si chiude quella usata meno di recente', () => {
    expect(MAX_OPEN_RECORDS).toBe(20);
    let list: OpenRecord[] = [];
    for (let i = 1; i <= 20; i++) list = addRecord(list, rec(i), i).list;
    expect(list).toHaveLength(20);
    // La prima torna in uso: la meno recente diventa la seconda.
    list = addRecord(list, rec(1), 21).list;
    const r = addRecord(list, rec(21), 22);
    expect(r.list).toHaveLength(20);
    expect(r.closed?.lastName).toBe('Cognome2');
    expect(r.list.map((x) => x.lastName)).toContain('Cognome1');
    expect(r.list.at(-1)?.lastName).toBe('Cognome21');
  });

  it('riaprire una cartella già aperta non la sposta e non ne cambia la pagina', () => {
    let list = addRecord([], rec(1), 1).list;
    list = addRecord(list, rec(2), 2).list;
    list = list.map((r) =>
      r.lastName === 'Cognome1' ? { ...r, lastPath: '/pazienti/1/ricetta' } : r,
    );
    const again = addRecord(list, rec(1), 3);
    expect(again.closed).toBeNull();
    expect(again.list.map((x) => x.lastName)).toEqual(['Cognome1', 'Cognome2']);
    expect(again.list[0]!.lastPath).toBe('/pazienti/1/ricetta');
  });

  it('due pazienti con lo stesso nome si distinguono con la data di nascita', () => {
    const a = {
      ...rec(1, { lastName: 'Rossi', firstName: 'Maria', birthDate: '1950-03-02' }),
      lastUsed: 1,
    };
    const b = {
      ...rec(2, { lastName: 'Rossi', firstName: 'Maria', birthDate: '1987-11-30' }),
      lastUsed: 2,
    };
    const c = { ...rec(3, { lastName: 'Bianchi', firstName: 'Luca' }), lastUsed: 3 };
    expect(recordLabel(a, [a, b, c])).toBe('Rossi Maria (02/03/1950)');
    expect(recordLabel(b, [a, b, c])).toBe('Rossi Maria (30/11/1987)');
    expect(recordLabel(c, [a, b, c])).toBe('Bianchi Luca');
  });

  it('riconosce il paziente dal percorso, anche nelle sue sottopagine', () => {
    const id = '0b6c1f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(patientIdOf(`/pazienti/${id}`)).toBe(id);
    expect(patientIdOf(`/pazienti/${id}/ricetta`)).toBe(id);
    expect(patientIdOf('/pazienti')).toBeNull();
    expect(patientIdOf('/ricette')).toBeNull();
  });
});

describe('uscita', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('all’uscita non resta nulla nel browser: cartelle aperte e ricette in corso', async () => {
    sessionStorage.setItem(
      'cartelle-aperte',
      JSON.stringify({ records: [{ ...rec(1), lastUsed: 1 }], seq: 1 }),
    );
    sessionStorage.setItem('ricetta:x:farmaci:righe', '[]');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        const body =
          path === '/api/io'
            ? {
                id: 'u1',
                nome: 'Medico inventato',
                ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
                postazione: null,
              }
            : path === '/api/oggi'
              ? {
                  data: '2026-11-18',
                  appuntamenti: [],
                  code: {
                    daFirmare: 0,
                    nonInviate: 0,
                    richiesteAperte: 0,
                    pianiInScadenza: [],
                    giorniAvvisoPiani: 30,
                  },
                }
              : { stato: 'ok' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    render(<App />);
    expect(await screen.findByRole('navigation', { name: 'Cartelle aperte' })).toBeTruthy();
    // Esci sta nel menu che si apre col clic sul nome, in alto a destra (D244).
    await userEvent.click(document.querySelector<HTMLButtonElement>('.utente-apri')!);
    await userEvent.click(screen.getByRole('button', { name: 'Esci' }));
    await screen.findByRole('heading', { name: 'Accesso' });
    expect(sessionStorage.length).toBe(0);
  });
});
