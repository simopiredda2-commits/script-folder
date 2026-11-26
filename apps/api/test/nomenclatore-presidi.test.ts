import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, TRANSCRIPTIONS_DIR } from '@mmg/reference';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog } from '../src/db/schema';
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
    quantita: string | null;
    intestazioneQuantita: string | null;
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
      const from = (ext: string) => join(TRANSCRIPTIONS_DIR, 'lea', `${base}.${ext}`);
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

  it('la quantità come la stampa l’allegato, con l’intestazione della sua colonna (D237)', async () => {
    const c = await catalog();
    const at = (code: string) => c.presidi.find((p) => p.codice === code)!;
    expect(at('09.18.05.003')).toMatchObject({
      quantita: '20 + 60',
      intestazioneQuantita: 'quantità erogabile',
    });
    expect(at('09.15.03.003')).toMatchObject({
      quantita: '4',
      intestazioneQuantita: 'quantità/anno',
    });
    expect(at('09.30.21.003')).toMatchObject({
      quantita: '120',
      intestazioneQuantita: 'quantità massima erogabile',
    });
    expect(at('09.31.06.006').quantita).toBe('2/anno');
    // Dove l'allegato non dà la quantità (04.49) e nell'allegato 3: niente.
    expect(at('04.49.03.103')).toMatchObject({ quantita: null, intestazioneQuantita: null });
    expect(at('09.15.03.021')).toMatchObject({ quantita: null });
    for (const p of c.presidi.filter((x) => x.allegato === '3'))
      expect([p.quantita, p.intestazioneQuantita]).toEqual([null, null]);
  });

  describe('medicazioni avanzate scelte dal titolare (D237)', () => {
    const settings = () => `/api/archivi/${s.archives.titolare}/impostazioni`;
    const supplies = () => `/api/pazienti/${s.richPatient}/presidi`;
    const send = (
      method: 'GET' | 'PATCH' | 'POST',
      url: string,
      cookie: string,
      payload?: object,
    ) => s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const dressing = (extra: object = {}) => ({
      categoria: 'medicazione_avanzata',
      prodotto: 'medicazioni in alginato (classe M040402 - Cnd): cm 15 x 15',
      codice: '04.49.03.103',
      quantitaMensile: 10,
      unita: 'pezzi',
      mesi: 3,
      dal: studioDayFrom(s.clock.now(), 0),
      ...extra,
    });

    it('le sceglie solo il titolare, fra le voci 04.49 del nomenclatore in uso', async () => {
      expect((await send('GET', settings(), doctor)).json()).toMatchObject({
        medicazioniAvanzate: [],
      });
      const secretary = await login(s, 'segreteria');
      expect(
        (await send('PATCH', settings(), secretary, { medicazioniAvanzate: ['04.49.03.103'] }))
          .statusCode,
      ).toBe(403);
      // Fuori dal gruppo 04.49, o una voce che il nomenclatore non ha: no.
      const outside = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['09.18.04.003'],
      });
      expect(outside.statusCode).toBe(400);
      expect(outside.body).toMatch(/gruppo 04\.49/);
      const unknown = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.99.999'],
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.body).toMatch(/04\.49\.99\.999/);
      // Doppioni tolti, in ordine.
      const ok = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.06.203', '04.49.03.103', '04.49.03.103'],
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ medicazioniAvanzate: ['04.49.03.103', '04.49.06.203'] });
      expect((await send('GET', supplies(), doctor)).json()).toMatchObject({
        medicazioniAvanzate: ['04.49.03.103', '04.49.06.203'],
      });
    });

    it('una voce scelta si prescrive solo fra le medicazioni avanzate, con la regola dello specialista', async () => {
      const monouso = await send('POST', supplies(), doctor, dressing({ categoria: 'monouso' }));
      expect(monouso.statusCode).toBe(400);
      expect(monouso.body).toMatch(/medicazioni avanzate scelte dal titolare/);
      // Fra le medicazioni avanzate, la prima prescrizione è dello specialista.
      const first = await send('POST', supplies(), doctor, dressing());
      expect(first.statusCode).toBe(400);
      expect(first.body).toMatch(/la prima prescrizione è dello specialista/);
      const ok = await send(
        'POST',
        supplies(),
        doctor,
        dressing({ primoSpecialista: 'Dr. Vulnologo di prova', primoSpecialistaIl: '2026-01-10' }),
      );
      expect(ok.statusCode, ok.body).toBe(201);
      // Una voce non scelta resta fra i monouso, come prima.
      const other = await send(
        'POST',
        supplies(),
        doctor,
        dressing({ categoria: 'monouso', codice: '04.49.09.303' }),
      );
      expect(other.statusCode, other.body).toBe(201);
    });

    it('anche il rinnovo: una voce scelta dopo la prima prescrizione cambia categoria', async () => {
      const first = await send(
        'POST',
        supplies(),
        doctor,
        dressing({ categoria: 'monouso', codice: '04.49.18.603' }),
      );
      expect(first.statusCode, first.body).toBe(201);
      const renewUrl = `${supplies()}/${first.json<{ id: string }>().id}/rinnova`;
      await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.06.203', '04.49.18.603'],
      });
      const renew = await send('POST', renewUrl, doctor, {});
      expect(renew.statusCode).toBe(400);
      expect(renew.body).toMatch(/04\.49\.18\.603 è fra le medicazioni avanzate/);
      // Tolta dall'elenco, il rinnovo passa.
      await send('PATCH', settings(), doctor, { medicazioniAvanzate: ['04.49.03.103'] });
      expect((await send('POST', renewUrl, doctor, {})).statusCode).toBe(201);
    });

    it('il rinnovo porta la voce fra le medicazioni avanzate, con la prima prescrizione dello specialista (D239)', async () => {
      await send('PATCH', settings(), doctor, { medicazioniAvanzate: ['04.49.03.103'] });
      // Una prescrizione monouso di prima, di una voce scritta senza punti.
      const old = await send(
        'POST',
        supplies(),
        doctor,
        dressing({ categoria: 'monouso', codice: '044903106', mesi: 12 }),
      );
      expect(old.statusCode, old.body).toBe(201);
      await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.03.106'],
      });
      type Listed = {
        id: string;
        categoria: string;
        stato: string;
        rinnovaId: string | null;
        primoSpecialista: string | null;
        rinnovo: {
          categoria: string | null;
          chiedeSpecialista: boolean;
          mesiMassimi: number | null;
        };
      };
      const listed = async () =>
        (await send('GET', supplies(), doctor)).json<{ presidi: Listed[] }>().presidi;
      const oldId = old.json<{ id: string }>().id;
      expect((await listed()).find((x) => x.id === oldId)?.rinnovo).toEqual({
        categoria: 'medicazione_avanzata',
        chiedeSpecialista: true,
        mesiMassimi: 6,
      });
      const renew = (body: object) => send('POST', `${supplies()}/${oldId}/rinnova`, doctor, body);
      // Solo verso le medicazioni avanzate; con lo specialista; per al massimo 6 mesi.
      expect((await renew({ categoria: 'monouso' })).statusCode).toBe(400);
      expect((await renew({ categoria: 'medicazione_avanzata' })).body).toMatch(
        /la prima prescrizione è dello specialista/,
      );
      const specialist = {
        primoSpecialista: 'Dr. Vulnologo di prova',
        primoSpecialistaIl: '2026-01-10',
      };
      expect((await renew({ categoria: 'medicazione_avanzata', ...specialist })).body).toMatch(
        /al massimo 6 mesi/,
      );
      const ok = await renew({ categoria: 'medicazione_avanzata', ...specialist, mesi: 6 });
      expect(ok.statusCode, ok.body).toBe(201);
      const after = await listed();
      expect(after.find((x) => x.id === oldId)?.stato).toBe('conclusa');
      expect(after.find((x) => x.id === ok.json<{ id: string }>().id)).toMatchObject({
        categoria: 'medicazione_avanzata',
        rinnovaId: oldId,
        primoSpecialista: 'Dr. Vulnologo di prova',
        rinnovo: { categoria: null, chiedeSpecialista: false, mesiMassimi: 6 },
      });
    });

    it('il rinnovo di una trascrizione dello specialista chiede chi e quando, poi li porta con sé (D239)', async () => {
      const transcribed = await send(
        'POST',
        supplies(),
        doctor,
        dressing({ prescrittore: 'specialista' }),
      );
      expect(transcribed.statusCode, transcribed.body).toBe(201);
      const id = transcribed.json<{ id: string }>().id;
      const renew = (supplyId: string, body: object = {}) =>
        send('POST', `${supplies()}/${supplyId}/rinnova`, doctor, body);
      expect((await renew(id)).body).toMatch(/la prima prescrizione è dello specialista/);
      const first = await renew(id, {
        primoSpecialista: 'Dr. Vulnologo di prova',
        primoSpecialistaIl: '2026-01-10',
      });
      expect(first.statusCode, first.body).toBe(201);
      // Il rinnovo dopo li ha già: un clic.
      expect((await renew(first.json<{ id: string }>().id)).statusCode).toBe(201);
    });

    /** Le ultime righe del registro per le impostazioni dell'archivio, dalla più recente. */
    const settingsLog = async (n: number) =>
      (
        await t.db
          .select({ outcome: accessLog.outcome, details: accessLog.details })
          .from(accessLog)
          .where(eq(accessLog.action, 'impostazioni_archivio'))
          .orderBy(desc(accessLog.seq))
          .limit(n)
      ).map((r) => [r.outcome, r.details] as const);

    it('una richiesta che non va bene non cambia niente, e il registro dice «fallito» (D239)', async () => {
      const before = (await send('GET', settings(), doctor)).json<{
        medicazioniAvanzate: string[];
      }>().medicazioniAvanzate;
      const empty = await send('PATCH', settings(), doctor, {});
      expect(empty.statusCode).toBe(400);
      expect(empty.body).toMatch(/Nessuna impostazione da cambiare/);
      const unknown = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.99.999'],
      });
      expect(unknown.statusCode).toBe(400);
      const [last, previous] = await settingsLog(2);
      expect(last).toEqual([
        'fallito',
        expect.objectContaining({
          fase: 'modifica',
          campi: ['medicazioniAvanzate'],
          motivo: 'Voci che il nomenclatore in uso non ha',
        }),
      ]);
      expect(previous).toEqual([
        'fallito',
        expect.objectContaining({ fase: 'modifica', motivo: 'Nessuna impostazione da cambiare' }),
      ]);
      // Mai i codici nel registro.
      expect(JSON.stringify([last, previous])).not.toMatch(/04\.49/);
      expect((await send('GET', settings(), doctor)).json()).toMatchObject({
        medicazioniAvanzate: before,
      });
    });

    it('una voce scelta che il nomenclatore nuovo non ha più resta, e si toglie (D239)', async () => {
      await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.27.903'],
      });
      // Una versione corretta dell'allegato 2: la rete elastica con il codice della NOTA 2.
      const dir = transcriptions('corretta', 'Prova (D239)');
      const csv = join(dir, 'lea', 'allegato-2-ausili-monouso.csv');
      writeFileSync(csv, readFileSync(csv, 'utf-8').replace(';04.49.27.903;', ';04.49.27.003;'));
      expect(await load(dir)).toContainEqual([
        'lea/allegato-2-ausili-monouso.json',
        'importato',
        87,
      ]);
      const codes = (await catalog()).presidi.map((p) => p.codice);
      expect(codes).toContain('04.49.27.003');
      expect(codes).not.toContain('04.49.27.903');
      // La voce di prima resta scelta; la nuova si aggiunge accanto.
      const both = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.27.903', '04.49.27.003'],
      });
      expect(both.statusCode, both.body).toBe(200);
      expect(both.json()).toMatchObject({
        medicazioniAvanzate: ['04.49.03.103', '04.49.27.003', '04.49.27.903'],
      });
      // Tolta, non si rimette: non è più nel nomenclatore in uso.
      const removed = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.27.003'],
      });
      expect(removed.statusCode, removed.body).toBe(200);
      const again = await send('PATCH', settings(), doctor, {
        medicazioniAvanzate: ['04.49.03.103', '04.49.27.003', '04.49.27.903'],
      });
      expect(again.statusCode).toBe(400);
      expect(again.body).toMatch(/04\.49\.27\.903/);
      // Nel registro le due modifiche fatte e quella rifiutata, con il loro esito.
      expect((await settingsLog(3)).map(([o]) => o)).toEqual([
        'fallito',
        'consentito',
        'consentito',
      ]);
    });
  });
});
