import { STRUCTURE_TYPES, STUDIO_STRUCTURE_TYPES } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aft, structureType, studio } from '../src/db/schema';
import { siapValues } from '../src/siap/values';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Struttura {
  codice: string | null;
  tipo: string;
  tipi: { codice: string; nome: string; codiceMinistero: number }[];
}

interface AftView {
  codiceStruttura: string | null;
  uccpNome: string | null;
  uccpCodiceStruttura: string | null;
}

/**
 * SIAP, tracciato dell'organizzazione (D289): codice e tipo della struttura dello studio, codice
 * della struttura dell'AFT e l'UCCP a cui afferisce. Studio e medici inventati; i codici sono di
 * prova, con lettere che nessuna codifica usa.
 */
describe('codice e tipo della struttura per il SIAP (D289)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { name: 'Studio di prova', kind: 'group' });
    for (const who of ['titolare', 'segreteria', 'amministratore'] as const)
      c[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  type Who = 'titolare' | 'segreteria' | 'amministratore';
  const req = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const struttura = (codice: string | null, tipo = 'gp_office') => ({
    struttura: { codice, tipo },
  });

  it('i tipi del database sono le chiavi del dominio, nello stesso ordine', () => {
    expect(structureType.enumValues).toEqual([...STRUCTURE_TYPES]);
  });

  it('per difetto lo studio di medicina generale, senza codice; i tipi dello studio con codice e descrizione del Ministero', async () => {
    const res = await req('segreteria', 'GET', '/api/studio');
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json<{ struttura: Struttura }>().struttura;
    expect(v).toMatchObject({ codice: null, tipo: 'gp_office' });
    const file = siapValues().tipoStruttura;
    expect(v.tipi).toEqual(
      STUDIO_STRUCTURE_TYPES.map((k) => {
        const x = file.find((f) => f.chiave === k)!;
        return { codice: k, nome: x.descrizione, codiceMinistero: x.codice };
      }),
    );
    // Studio medico MMG e PLS, AFT, UCCP, Casa della Comunità: non le sedi di guardia e le
    // strutture residenziali, che sono sedi del contatto, non lo studio.
    expect(v.tipi.map((x) => x.codiceMinistero)).toEqual([1, 2, 3, 4, 5]);
  });

  it('l’amministratore salva il codice in maiuscolo e il tipo; un codice vuoto si toglie', async () => {
    let res = await req('amministratore', 'PUT', '/api/studio', struttura(' prova1 ', 'aft'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ struttura: Struttura }>().struttura).toMatchObject({
      codice: 'PROVA1',
      tipo: 'aft',
    });
    const [row] = await t.db.select().from(studio).where(eq(studio.id, s.studioId));
    expect(row).toMatchObject({ structureCode: 'PROVA1', structureType: 'aft' });
    res = await req('amministratore', 'PUT', '/api/studio', struttura('', 'gp_office'));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ struttura: Struttura }>().struttura).toMatchObject({
      codice: null,
      tipo: 'gp_office',
    });
  });

  it('codici senza la forma e tipi che non sono di uno studio: rifiutati, il gruppo si manda intero', async () => {
    for (const codice of ['PROV1', 'PROVA12', 'PRO-A1', 'PROVÀ1']) {
      const res = await req('amministratore', 'PUT', '/api/studio', struttura(codice));
      expect(res.statusCode, codice).toBe(400);
      expect(res.body, codice).toContain('Codice della struttura: 6 lettere o cifre');
    }
    for (const tipo of [
      'out_of_hours',
      'tourist_service',
      'semi_residential',
      'residential',
      'x',
    ]) {
      const res = await req('amministratore', 'PUT', '/api/studio', struttura(null, tipo));
      expect(res.statusCode, tipo).toBe(400);
      expect(res.body, tipo).toContain('Tipo di struttura: uno di quelli dell’elenco');
    }
    const half = await req('amministratore', 'PUT', '/api/studio', {
      struttura: { codice: 'PROVA1' },
    });
    expect(half.statusCode, half.body).toBe(400);
    const [row] = await t.db.select().from(studio).where(eq(studio.id, s.studioId));
    expect(row).toMatchObject({ structureCode: null, structureType: 'gp_office' });
  });

  it('il codice e il tipo li cambia solo l’amministratore dello studio', async () => {
    for (const who of ['titolare', 'segreteria'] as const) {
      const res = await req(who, 'PUT', '/api/studio', struttura('PROVA2'));
      expect(res.statusCode, who).toBe(403);
    }
    const [row] = await t.db.select().from(studio).where(eq(studio.id, s.studioId));
    expect(row!.structureCode).toBeNull();
  });

  it('AFT: il codice della struttura e l’UCCP con il suo codice, in maiuscolo; vuoti si tolgono', async () => {
    const created = await req('titolare', 'POST', '/api/aft', {
      nome: 'AFT di prova',
      codiceStruttura: 'prova7',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    let res = await req('titolare', 'PATCH', `/api/aft/${id}`, {
      uccpNome: 'UCCP di prova',
      uccpCodiceStruttura: 'prova8',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ aft: AftView }>().aft).toMatchObject({
      codiceStruttura: 'PROVA7',
      uccpNome: 'UCCP di prova',
      uccpCodiceStruttura: 'PROVA8',
    });
    const overview = await req('titolare', 'GET', '/api/aft');
    expect(overview.json<{ aft: AftView }>().aft).toMatchObject({
      codiceStruttura: 'PROVA7',
      uccpNome: 'UCCP di prova',
      uccpCodiceStruttura: 'PROVA8',
    });
    for (const body of [{ codiceStruttura: 'AF-007' }, { uccpCodiceStruttura: 'UC00071' }]) {
      const bad = await req('titolare', 'PATCH', `/api/aft/${id}`, body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
      expect(bad.body).toContain('6 lettere o cifre');
    }
    res = await req('titolare', 'PATCH', `/api/aft/${id}`, {
      codiceStruttura: '',
      uccpNome: '',
      uccpCodiceStruttura: '',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ aft: AftView }>().aft).toMatchObject({
      codiceStruttura: null,
      uccpNome: null,
      uccpCodiceStruttura: null,
    });
  });

  /** Il vincolo che ha fermato la scrittura: con `pg` sta nella causa dell'errore di Drizzle. */
  const violated = async (write: PromiseLike<unknown>) => {
    try {
      await write;
      return null;
    } catch (e) {
      const err = e as { constraint?: string; cause?: { constraint?: string } };
      return err.cause?.constraint ?? err.constraint ?? null;
    }
  };

  it('il database rifiuta un codice senza la forma anche fuori dal servizio', async () => {
    expect(
      await violated(
        t.db.update(studio).set({ structureCode: 'prova1' }).where(eq(studio.id, s.studioId)),
      ),
    ).toBe('studio_structure_code');
    // Un'AFT sua, perché la prova regga anche da sola.
    const [a] = await t.db
      .insert(aft)
      .values({ name: 'AFT del vincolo, di prova', createdBy: s.users.titolare.id })
      .returning();
    expect(
      await violated(t.db.update(aft).set({ structureCode: 'PROVA' }).where(eq(aft.id, a!.id))),
    ).toBe('aft_structure_code');
    expect(
      await violated(
        t.db.update(aft).set({ uccpStructureCode: 'PROVA-' }).where(eq(aft.id, a!.id)),
      ),
    ).toBe('aft_uccp_structure_code');
    // Un codice con la forma giusta passa.
    expect(
      await violated(t.db.update(aft).set({ structureCode: 'PROVA9' }).where(eq(aft.id, a!.id))),
    ).toBeNull();
  });
});
