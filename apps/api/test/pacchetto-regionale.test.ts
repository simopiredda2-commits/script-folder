import { ASL_LIST } from '@mmg/domain';
import { REGIONAL_PACKAGES, REGIONAL_PART_LABELS, REGIONAL_PARTS } from '@mmg/regions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface RegionalView {
  regione: { codice: string; nome: string } | null;
  pacchetto: { chiave: string; nome: string } | null;
  parti: { parte: string; nome: string; cosa: string; nelPacchetto: boolean }[];
  mancano: { parte: string; nome: string }[];
}
interface StudioView {
  dati: Record<string, unknown>;
  pacchettoRegionale: RegionalView;
}

/**
 * Il pacchetto regionale nei dati dello studio (D292): dalla regione scritta dall'amministratore,
 * le parti che il pacchetto dà e quelle che mancano. La prova non scrive nomi di regioni: vengono
 * dall'elenco dei pacchetti e da quello delle aziende sanitarie del Ministero.
 */
describe('pacchetto regionale dello studio (D292)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  const pkg = REGIONAL_PACKAGES[0]!;
  const withPackage = ASL_LIST.find((a) => a.regionCode === pkg.regionCode)!.regionName;
  const without = ASL_LIST.find(
    (a) => !REGIONAL_PACKAGES.some((p) => p.regionCode === a.regionCode),
  )!.regionName;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { name: 'Studio di prova', kind: 'group', regionName: null });
    for (const who of ['amministratore', 'segreteria'] as const) c[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const read = async (who = 'segreteria') => {
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/studio',
      headers: { cookie: c[who]! },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<StudioView>();
  };
  const setRegion = async (regione: string) => {
    const { dati } = await read('amministratore');
    const res = await s.app.inject({
      method: 'PUT',
      url: '/api/studio',
      headers: { cookie: c.amministratore! },
      payload: { dati: { ...dati, regione } },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('senza la regione: nessun pacchetto, tutte le parti nazionali', async () => {
    const v = (await read()).pacchettoRegionale;
    expect(v).toEqual({
      regione: null,
      pacchetto: null,
      parti: [],
      mancano: REGIONAL_PARTS.map((p) => ({ parte: p, nome: REGIONAL_PART_LABELS[p] })),
    });
  });

  it('la regione con un pacchetto: il pacchetto, che cosa dà e dove sta, e che cosa manca', async () => {
    await setRegion(withPackage.toLowerCase());
    const v = (await read()).pacchettoRegionale;
    expect(v.regione).toEqual({ codice: pkg.regionCode, nome: withPackage });
    expect(v.pacchetto).toEqual({ chiave: pkg.key, nome: pkg.name });
    expect(v.parti).toEqual(
      pkg.parts.map((p) => ({
        parte: p.part,
        nome: REGIONAL_PART_LABELS[p.part],
        cosa: p.what,
        nelPacchetto: p.where === 'package',
      })),
    );
    expect(v.mancano.map((m) => m.parte)).toEqual(
      REGIONAL_PARTS.filter((p) => !pkg.parts.some((x) => x.part === p)),
    );
  });

  it('una regione senza pacchetto: la regione sì, il pacchetto no, mancano tutte le parti', async () => {
    await setRegion(without);
    const v = (await read()).pacchettoRegionale;
    expect(v.regione?.nome).toBe(without);
    expect(v.pacchetto).toBeNull();
    expect(v.parti).toEqual([]);
    expect(v.mancano).toHaveLength(REGIONAL_PARTS.length);
  });
});
