import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, REGIONAL_TRANSCRIPTIONS } from '@mmg/reference';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importReferenceData } from '../src/reference/importer';
import { studioDayFrom } from './helpers/dates';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Catalog {
  presidi: {
    codice: string;
    descrizione: string;
    gruppo: string;
    allegato: string;
    atto: string;
  }[];
  malattieRare: { codice: string; descrizione: string; allegato: string }[];
}

/**
 * Il nomenclatore dei presidi dalle trascrizioni del repository (D218, D236): gli allegati 2 e 3
 * del DPCM LEA restano fuori finché nessuno li ha controllati (A8); controllati, il servizio li dà
 * alla scheda dei presidi, e la voce più lunga dell'allegato 2 si registra intera nella
 * prescrizione. Le trascrizioni sono copiate in una cartella della prova per scegliere chi le ha
 * controllate.
 */
describe('nomenclatore dei presidi dalle trascrizioni dei LEA (D218, D236)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let work: string;
  let syncDir: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    work = mkdtempSync(join(tmpdir(), 'mmg-presidi-'));
    // Nessun file di sync: qui contano solo le trascrizioni.
    syncDir = join(work, 'dati-pubblici');
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const ANNEXES = ['allegato-2-ausili-monouso', 'allegato-3-presidi'];
  /** Le due trascrizioni dei presidi del repository, con chi le ha controllate. */
  function transcriptions(name: string, checkedBy: string | null) {
    const dir = join(work, name);
    mkdirSync(join(dir, 'lea'), { recursive: true });
    for (const base of ANNEXES) {
      const from = (ext: string) => join(REGIONAL_TRANSCRIPTIONS, 'lea', `${base}.${ext}`);
      cpSync(from('csv'), join(dir, 'lea', `${base}.csv`));
      const sheet = JSON.parse(readFileSync(from('json'), 'utf-8')) as Record<string, unknown>;
      writeFileSync(
        join(dir, 'lea', `${base}.json`),
        JSON.stringify({ ...sheet, controllato_da: checkedBy }),
      );
    }
    return dir;
  }
  const load = async (dir: string) =>
    (
      await importReferenceData({
        db: t.db,
        syncDir,
        transcriptionsDir: dir,
        mappings: loadMappings(),
        importedBy: 'prova',
      })
    ).map((l) => [l.file, l.outcome, l.rows ?? null]);
  const catalog = async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/presidi/nomenclatore',
      headers: { cookie: doctor },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Catalog>();
  };

  it('da controllare: non entrano, e la scheda dei presidi non offre niente', async () => {
    expect(await load(transcriptions('da-controllare', null))).toEqual([
      ['lea/allegato-2-ausili-monouso.json', 'trascrizione_da_controllare', null],
      ['lea/allegato-3-presidi.json', 'trascrizione_da_controllare', null],
    ]);
    expect(await catalog()).toEqual({ presidi: [], malattieRare: [] });
  });

  it('controllate: le 87 voci dell’allegato 2, i 18 presidi e le 12 malattie rare dell’allegato 3', async () => {
    expect(await load(transcriptions('controllate', 'Prova (D236)'))).toEqual([
      ['lea/allegato-2-ausili-monouso.json', 'importato', 87],
      ['lea/allegato-3-presidi.json', 'importato', 30],
    ]);
    const c = await catalog();
    const of = (annex: string) => c.presidi.filter((p) => p.allegato === annex);
    expect(of('2')).toHaveLength(87);
    expect(of('3')).toHaveLength(18);
    expect(c.malattieRare).toHaveLength(12);
    expect(new Set(of('2').map((p) => p.gruppo)).size).toBe(21);
    expect(new Set(of('2').map((p) => p.atto))).toEqual(
      new Set([
        expect.stringMatching(/allegato 2: ausili monouso, aggiornato dal DM 3 agosto 2026/),
      ]),
    );
    expect(of('2').find((p) => p.codice === '09.24.21.003')).toMatchObject({
      descrizione: 'guaina (catetere maschile esterno)',
      gruppo: '09.24.21 catetere maschile esterno per urina',
    });
  });

  it('la voce più lunga dell’allegato 2 si registra intera; oltre 500 caratteri no', async () => {
    const longest = (await catalog()).presidi.find((p) => p.codice === '09.30.24.063')!;
    expect(longest.descrizione).toHaveLength(401);
    const url = `/api/pazienti/${s.richPatient}/presidi`;
    const post = (prodotto: string) =>
      s.app.inject({
        method: 'POST',
        url,
        headers: { cookie: doctor },
        payload: {
          categoria: 'monouso',
          prodotto,
          codice: '09.30.24.063',
          quantitaMensile: 120,
          unita: 'pezzi',
          mesi: 3,
          dal: studioDayFrom(s.clock.now(), 0),
        },
      });
    const saved = await post(longest.descrizione);
    expect(saved.statusCode, saved.body).toBe(201);
    const list = await s.app.inject({ method: 'GET', url, headers: { cookie: doctor } });
    expect(
      list.json<{ presidi: { id: string; prodotto: string; codice: string | null }[] }>().presidi,
    ).toContainEqual(
      expect.objectContaining({
        id: saved.json<{ id: string }>().id,
        prodotto: longest.descrizione,
        codice: '09.30.24.063',
      }),
    );
    expect((await post('x'.repeat(500))).statusCode).toBe(201);
    expect((await post('x'.repeat(501))).statusCode).toBe(400);
  });
});
