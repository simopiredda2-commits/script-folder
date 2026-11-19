import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceDataset, referenceUpdateRun } from '../src/db/schema';
import {
  EXAMPLE_TRANSCRIPTIONS,
  EXAMPLES_DIR,
  runSyncOnExample,
  serveExampleSite,
  type ExampleSite,
} from '../src/reference/example-site';
import { ReferenceData } from '../src/reference/lookup';
import {
  beginReferenceUpdate,
  issuesOf,
  type SeriesStatus,
  UpdateInProgressError,
  type UpdateRun,
  type UpdateSetup,
} from '../src/reference/update';
import { ReferenceUpdates } from '../src/reference/updates-service';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Aggiornamento delle banche dati (D156): sync sul sito d'esempio servito in locale, poi
 * l'importazione con i controlli, poi il registro. Nessun sito reale (regola 7).
 */
describe('aggiornamento delle banche dati (D156)', () => {
  let t: TestDatabase;
  let site: ExampleSite;
  let work: string;
  let setup: UpdateSetup;
  const SITE = join(EXAMPLES_DIR, 'sito');
  const original = (path: string) => new Uint8Array(readFileSync(join(SITE, path)));

  beforeAll(async () => {
    t = await createTestDatabase();
    site = await serveExampleSite();
    work = mkdtempSync(join(tmpdir(), 'mmg-aggiornamento-'));
    setup = {
      dataDir: join(work, 'dati-pubblici'),
      transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
      mappings: loadMappings(),
      sync: (dest, signal) => runSyncOnExample(site, dest, [], signal),
    };
  });
  afterAll(async () => {
    await site?.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const run = async (now = new Date()) =>
    (
      await beginReferenceUpdate(t.db, setup, {
        trigger: 'comando',
        requestedBy: 'prova',
        now: () => now,
      })
    ).done;
  const statusOf = (r: UpdateRun, series: string) =>
    (r.seriesStatus as SeriesStatus[]).find((x) => x.series === series)!;
  const reference = () => new ReferenceData(t.db, loadMappings());
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
  const datasets = async () => (await t.db.select().from(referenceDataset)).length;

  it('primo giro: scarica, importa e registra; ogni serie in uso ha la sua fonte controllata', async () => {
    const r = await run();
    expect(r.outcome, r.message ?? '').toBe('ok');
    expect(r.running).toBeNull();
    expect(r.syncExitCode).toBe(0);
    expect(await datasets()).toBeGreaterThan(0);
    for (const series of ['aifa-anagrafica', 'istat-comuni', 'catalogo-piemonte']) {
      const st = statusOf(r, series);
      expect(st.checkFailed, series).toBe(false);
      expect(st.pending, series).toEqual([]);
      expect(st.checkedAt, series).not.toBeNull();
    }
    const versions = await reference().versions(today);
    expect(versions.filter((v) => v.stale)).toEqual([]);
  });

  it('giro senza cambiamenti: tutto invariato, nessuna versione nuova', async () => {
    const before = await datasets();
    const r = await run();
    expect(r.outcome).toBe('ok');
    const report = r.syncReport as { righe: { esito: string }[] };
    expect(report.righe.every((x) => x.esito === 'invariato')).toBe(true);
    expect(await datasets()).toBe(before);
  });

  it('una fonte non risponde bene: errore nel registro, la versione resta in uso, più vecchia del previsto', async () => {
    const path = 'istat/Elenco-comuni-italiani.xlsx';
    site.override(path, new TextEncoder().encode('PK\u0003\u0004 non è un archivio vero'));
    try {
      const r = await run();
      expect(r.outcome).toBe('errore');
      expect(statusOf(r, 'istat-comuni').checkFailed).toBe(true);
      // Le altre fonti sono state controllate lo stesso.
      expect(statusOf(r, 'aifa-anagrafica').checkFailed).toBe(false);
      expect(issuesOf(r)).toContainEqual(
        expect.objectContaining({ level: 'errore', source: 'istat_comuni' }),
      );
      const [comuni] = await reference().versions(today, ['comuni']);
      expect(comuni).toMatchObject({ series: 'istat-comuni', stale: true });
      expect(comuni!.staleReasons.join(' ')).toMatch(/non è riuscito a controllare la fonte/);
      const [farmaci] = await reference().versions(today, ['farmaci']);
      expect(farmaci!.stale).toBe(false);
    } finally {
      site.override(path, original(path));
    }
    // Il giro dopo, con la fonte di nuovo a posto, toglie l'avviso.
    expect((await run()).outcome).toBe('ok');
    const [comuni] = await reference().versions(today, ['comuni']);
    expect(comuni!.stale).toBe(false);
  });

  it('documento nuovo nella pagina del catalogo: scaricato e segnalato, la versione in uso resta', async () => {
    site.override(
      'piemonte/catalogo.html',
      new TextEncoder().encode(
        '<html><body><a href="/piemonte/attach/catalogo_prova_allegato_c.pdf">Allegato C</a>' +
          '<a href="/piemonte/attach/catalogo_nuovo.pdf">Catalogo nuovo</a></body></html>',
      ),
    );
    site.override(
      'piemonte/attach/catalogo_nuovo.pdf',
      new TextEncoder().encode('%PDF-1.4 catalogo nuovo di prova'),
    );
    const r = await run();
    expect(r.outcome).toBe('da_verificare');
    expect(statusOf(r, 'catalogo-piemonte').pending.join(' ')).toMatch(
      /documenti nuovi della fonte da trascrivere: catalogo_nuovo\.pdf/,
    );
    expect(issuesOf(r)).toContainEqual(
      expect.objectContaining({
        level: 'da_verificare',
        source: 'piemonte_catalogo',
        file: 'catalogo_nuovo.pdf',
        what: 'serve una trascrizione',
      }),
    );
    const [catalogo] = await reference().versions(today, ['prestazioni']);
    expect(catalogo).toMatchObject({ series: 'catalogo-piemonte', stale: true });
    // In uso resta la trascrizione controllata (A8): i dati del PDF nuovo non si estraggono da soli.
    expect(catalogo!.title).toMatch(/catalogo/i);
  });

  it('un solo giro alla volta', async () => {
    let release!: () => void;
    const slow: UpdateSetup = {
      ...setup,
      sync: () =>
        new Promise((ok) => {
          release = () => ok({ code: 0, output: '' });
        }),
    };
    const first = await beginReferenceUpdate(t.db, slow, {
      trigger: 'automatico',
      requestedBy: 'prova',
      now: () => new Date(),
    });
    await expect(
      beginReferenceUpdate(t.db, setup, {
        trigger: 'pulsante',
        requestedBy: 'prova',
        now: () => new Date(),
      }),
    ).rejects.toBeInstanceOf(UpdateInProgressError);
    release();
    const done = await first.done;
    // sync non ha scritto un rapporto nuovo: si dice, invece di usare quello del giro prima.
    expect(done.outcome).toBe('errore');
    expect(done.message).toMatch(/non ha scritto il rapporto di questo giro/);
  });

  it('un giro rimasto «in corso» da ore si chiude come interrotto', async () => {
    const now = new Date();
    const [stuck] = await t.db
      .insert(referenceUpdateRun)
      .values({
        trigger: 'automatico',
        requestedBy: 'prova',
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
        running: true,
      })
      .returning();
    expect((await run(now)).running).toBeNull();
    const [row] = await t.db
      .select()
      .from(referenceUpdateRun)
      .where(eq(referenceUpdateRun.id, stuck!.id));
    expect(row).toMatchObject({ outcome: 'interrotto', running: null });
  });

  it('alla chiusura del servizio il download si ferma e il giro resta «interrotto»', async () => {
    const updates = new ReferenceUpdates(t.db, {
      ...setup,
      sync: (_dest, signal) =>
        new Promise((ok) => {
          signal?.addEventListener('abort', () => ok({ code: 1, output: 'fermato' }));
        }),
    });
    const { done } = await updates.start('automatico', 'prova');
    await updates.stop();
    expect((await done).outcome).toBe('interrotto');
  });
});

describe('aggiornamento dalle schermate e avviso di vecchiaia (D156)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let site: ExampleSite;
  let work: string;
  let updates: ReferenceUpdates;

  beforeAll(async () => {
    t = await createTestDatabase();
    site = await serveExampleSite();
    work = mkdtempSync(join(tmpdir(), 'mmg-aggiornamento-http-'));
    s = await createScenario(
      t.db,
      {},
      {
        referenceUpdates: (now) => {
          updates = new ReferenceUpdates(
            t.db,
            {
              dataDir: join(work, 'dati-pubblici'),
              transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
              mappings: loadMappings(),
              sync: (dest, signal) => runSyncOnExample(site, dest, [], signal),
            },
            { time: '03:30', now },
          );
          return updates;
        },
      },
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await site?.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const get = (cookie: string, url = '/api/banche-dati/aggiornamenti') =>
    s.app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/banche-dati/aggiornamenti',
      headers: { cookie },
      payload: {},
    });

  it('prima di ogni giro: ora e prossimo avvio; l’aggiornamento di stanotte manca', async () => {
    const doctor = await login(s, 'titolare');
    const res = await get(doctor);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configurato: true,
      automatico: { ora: '03:30' },
      puoAvviare: false,
      ultimo: null,
    });
  });

  it('solo l’amministratore avvia un giro; poi tutti vedono com’è andato', async () => {
    const secretary = await login(s, 'segreteria');
    expect((await post(secretary)).statusCode).toBe(403);
    const admin = await login(s, 'amministratore');
    expect((await get(admin)).json().puoAvviare).toBe(true);
    const started = await post(admin);
    expect(started.statusCode, started.body).toBe(202);
    // Un secondo avvio mentre il primo gira: rifiutato, con l'ora.
    const again = await post(admin);
    expect(again.statusCode).toBe(409);
    expect(again.json().errore).toMatch(/già in corso/);
    await updates.inProgress;
    const body = (await get(secretary)).json();
    expect(body.ultimo).toMatchObject({ avvio: 'pulsante', esito: 'ok', daControllare: [] });
    expect(body.ultimo.chi).not.toBe('');
    expect(body.giri).toHaveLength(1);
  });

  it('le versioni dicono quando è stata controllata la fonte; senza giro di stanotte, più vecchie del previsto', async () => {
    const doctor = await login(s, 'titolare');
    const fresh = (await get(doctor, '/api/banche-dati')).json();
    const comuni = fresh.versioni.find((v: { series: string }) => v.series === 'istat-comuni');
    expect(comuni).toMatchObject({ stale: false, staleReasons: [] });
    expect(comuni.checkedAt).not.toBeNull();
    // Passano due giorni senza aggiornamenti (servizio spento): l'avviso c'è, con il perché.
    s.clock.advance(2 * 24 * 60 * 60 * 1000);
    const late = (await get(await login(s, 'titolare'), '/api/banche-dati')).json();
    const comuniLate = late.versioni.find((v: { series: string }) => v.series === 'istat-comuni');
    expect(comuniLate.stale).toBe(true);
    expect(comuniLate.staleReasons.join(' ')).toMatch(/l’aggiornamento di ogni notte manca dal/);
  });

  it('senza configurazione nessun giro parte dal servizio (regola 7)', async () => {
    const t2 = await createTestDatabase();
    const s2 = await createScenario(t2.db);
    try {
      const admin = await login(s2, 'amministratore');
      const res = await s2.app.inject({
        method: 'POST',
        url: '/api/banche-dati/aggiornamenti',
        headers: { cookie: admin },
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errore).toMatch(/non si aggiornano dal programma/);
      const status = (
        await s2.app.inject({
          method: 'GET',
          url: '/api/banche-dati/aggiornamenti',
          headers: { cookie: admin },
        })
      ).json();
      expect(status).toMatchObject({ configurato: false, automatico: null, puoAvviare: false });
    } finally {
      await s2.app.close();
      await t2.drop();
    }
  });
});
