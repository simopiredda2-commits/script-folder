import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFirstStudio } from '../src/db/first-studio';
import { appUser, studio } from '../src/db/schema';
import { verifyPassword } from '../src/security/password';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Primo avvio di uno studio vero (tappa 14, D172). */
describe('primo avvio: studio e primo amministratore', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  const input = {
    nome: 'Studio di prova',
    tipo: 'singolo' as const,
    regione: 'piemonte',
    amministratore: 'amministratore.prova',
    nomeAmministratore: 'Amministratore di prova',
  };

  it('crea lo studio e l’amministratore con una password temporanea da cambiare', async () => {
    const r = await createFirstStudio(t.db, input);
    const [st] = await t.db.select().from(studio).where(eq(studio.id, r.studioId));
    expect(st).toMatchObject({ name: 'Studio di prova', kind: 'single', regionName: 'PIEMONTE' });
    const [u] = await t.db.select().from(appUser).where(eq(appUser.id, r.userId));
    expect(u).toMatchObject({
      studioId: r.studioId,
      roles: ['administrator'],
      mustChangePassword: true,
      status: 'active',
    });
    // Nessun accesso clinico: solo amministratore. La password temporanea vale.
    expect(await verifyPassword(r.temporaryPassword, u!.passwordHash)).toBe(true);
    expect(r.temporaryPassword.length).toBeGreaterThanOrEqual(16);
  });

  it('rifiuta un nome utente che c’è già e i dati non validi', async () => {
    await expect(createFirstStudio(t.db, input)).rejects.toThrow(/esiste già/);
    await expect(
      createFirstStudio(t.db, { ...input, amministratore: 'Con Spazi', nome: 'Altro' }),
    ).rejects.toThrow(/nome utente/);
    await expect(
      createFirstStudio(t.db, { ...input, amministratore: 'altro', regione: '' }),
    ).rejects.toThrow();
  });
});
