import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PasswordModule from '../src/security/password';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Terza revisione dei poteri dell'amministratore: nel cambio della password la password attuale
 * giusta faceva un'impronta in più (quella della password nuova) prima di rileggere l'utente sotto
 * blocco, quella sbagliata no. Con un blocco arrivato a metà le due ricevevano lo stesso 429, ma la
 * giusta più tardi: il tempo diceva chi aveva indovinato. Ora le due strade fanno lo stesso lavoro.
 * Qui si contano le impronte, invece di misurare i tempi.
 */
const counted = vi.hoisted(() => ({ hashes: 0 }));
vi.mock('../src/security/password', async (importOriginal) => {
  const original = await importOriginal<typeof PasswordModule>();
  return {
    ...original,
    hashPassword: async (password: string) => {
      counted.hashes++;
      return original.hashPassword(password);
    },
  };
});

describe('cambio della password: lo stesso lavoro con la password attuale giusta o sbagliata', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { idleLockMinutes: null });
    cookie = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const change = (current: string, next: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/profilo/password',
      headers: { cookie },
      payload: { passwordAttuale: current, nuovaPassword: next },
    });

  it('l’impronta della password nuova si calcola anche quando quella attuale è sbagliata', async () => {
    let before = counted.hashes;
    const wrong = await change('una password attuale sbagliata', 'una password nuova di prova');
    expect(wrong.statusCode, wrong.body).toBe(400);
    const wrongWork = counted.hashes - before;

    before = counted.hashes;
    const right = await change(PASSWORD, 'una password nuova di prova');
    expect(right.statusCode, right.body).toBe(200);
    const rightWork = counted.hashes - before;

    expect(wrongWork).toBe(1);
    expect(rightWork).toBe(wrongWork);
  });
});
