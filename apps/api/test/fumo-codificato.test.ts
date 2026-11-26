import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { riskFactorDetail } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

/**
 * Il fumo codificato negli stili di vita (D284): il SIAP chiede «sì», «no» o «non noto». Per il
 * fumo il valore codificato è obbligatorio; il testo resta per i dettagli, facoltativo. Gli altri
 * fattori non lo hanno. Dati inventati.
 */
describe('fumo codificato negli stili di vita (D284)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (body: object) =>
    s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/voci`,
      headers: { cookie: doctor },
      payload: { tipo: 'stile_di_vita', data: studioDayFrom(s.clock.now(), 0), ...body },
    });
  const detailOf = async (id: string) =>
    (await t.db.select().from(riskFactorDetail).where(eq(riskFactorDetail.entryId, id)))[0]!;

  it('per il fumo serve il valore codificato; il testo è facoltativo', async () => {
    const missing = await post({ fattore: 'Fumo', valore: 'Dieci sigarette al giorno' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toMatch(/Fumo: scegli «sì», «no» o «non noto»/);
    // Solo il valore codificato: il testo è il fumo in parole.
    const onlyCode = await post({ fattore: 'Fumo', fumo: 'no' });
    expect(onlyCode.statusCode, onlyCode.body).toBe(201);
    expect(await detailOf(onlyCode.json<{ id: string }>().id)).toMatchObject({
      factor: 'Fumo',
      value: 'Non fuma',
      smokingStatus: 'no',
    });
    // Con il testo, il testo resta com'è.
    const both = await post({ fattore: 'fumo', fumo: 'yes', valore: 'Dieci sigarette al giorno' });
    expect(both.statusCode, both.body).toBe(201);
    expect(await detailOf(both.json<{ id: string }>().id)).toMatchObject({
      value: 'Dieci sigarette al giorno',
      smokingStatus: 'yes',
    });
  });

  it('gli altri fattori non hanno il valore codificato, e vogliono il testo', async () => {
    const coded = await post({ fattore: 'Alcol', fumo: 'no', valore: 'Raramente' });
    expect(coded.statusCode).toBe(400);
    expect(coded.body).toMatch(/vale solo per il fumo/);
    const empty = await post({ fattore: 'Alcol' });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toMatch(/Com’è: manca/);
    const ok = await post({ fattore: 'Alcol', valore: 'Raramente' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await detailOf(ok.json<{ id: string }>().id)).toMatchObject({ smokingStatus: null });
  });

  it('la cartella restituisce il valore codificato con la voce', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${s.richPatient}/voci?tipo=stile_di_vita`,
      headers: { cookie: doctor },
    });
    expect(res.statusCode, res.body).toBe(200);
    const smoking = res
      .json<{ voci: { dettaglio: { fattore: string; fumo: string | null } }[] }>()
      .voci.filter((v) => v.dettaglio.fattore.toLowerCase() === 'fumo')
      .map((v) => v.dettaglio.fumo);
    expect(smoking.sort()).toEqual(['no', 'yes']);
  });
});
