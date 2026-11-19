import { describe, expect, it } from 'vitest';
import {
  newTestDatabaseName,
  STALE_TEST_DB_MS,
  staleTestDatabases,
  TEST_DB_PATTERN,
} from './helpers/test-db-names';

/**
 * Pulizia dei database di prova: si cancellano solo quelli avanzati da un giro interrotto, mai
 * quelli di un altro giro in corso sulla stessa macchina.
 */
describe('database di prova avanzati', () => {
  const now = new Date('2026-11-19T03:00:00Z');
  const old = new Date(now.getTime() - STALE_TEST_DB_MS - 60_000);
  const recent = new Date(now.getTime() - 60_000);

  it('il nome porta l’istante di creazione', () => {
    const name = newTestDatabaseName(now);
    expect(name).toMatch(TEST_DB_PATTERN);
    expect(parseInt(TEST_DB_PATTERN.exec(name)![1]!, 36)).toBe(now.getTime());
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('si cancellano solo i vecchi senza connessioni', () => {
    const vecchio = newTestDatabaseName(old);
    const vecchioInUso = newTestDatabaseName(old);
    const recente = newTestDatabaseName(recent);
    expect(
      staleTestDatabases(
        [
          { name: vecchio, connections: 0 },
          { name: vecchioInUso, connections: 2 },
          { name: recente, connections: 0 },
          // Formato vecchio, senza istante: potrebbe essere di un giro in corso.
          { name: 'mmg_test_0123456789ab', connections: 0 },
          { name: 'mmg_dev', connections: 0 },
        ],
        now,
      ),
    ).toEqual([vecchio]);
  });
});
