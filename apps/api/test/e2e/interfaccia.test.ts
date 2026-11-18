/**
 * Prova dell'interfaccia vera nel browser: build di apps/web, servizio con un database di prova,
 * accesso con password e secondo fattore, le schermate della tappa 6, accessibilità (axe-core,
 * WCAG 2.2 AA), bersagli di almeno 44 px, impaginazione su tablet. Nessun sito esterno.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { loadMappings, overrideMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointment,
  clinicalEntry,
  labResultDetail,
  measurementDetail,
  patient,
  therapy,
} from '../../src/db/schema';
import { withActor } from '../../src/db/tx';
import { startOfStudioDay } from '../../src/http/today-routes';
import { studioDate } from '../../src/prescriptions/rules-check';
import {
  EXAMPLE_MAPPINGS,
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
} from '../../src/reference/example-site';
import { importReferenceData } from '../../src/reference/importer';
import { base32Decode } from '../../src/security/base32';
import { totp } from '../../src/security/totp';
import { createScenario, PASSWORD, type Scenario } from '../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const WEB = join(ROOT, 'apps', 'web');
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf-8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MIN_TARGET = 44;
const TABLETS = [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Serve dist/ e passa /api al servizio, come farà il dominio dello studio. */
function serveWeb(dist: string, apiPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      const upstream = request(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(upstream);
      return;
    }
    const path = join(dist, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const file =
      path.startsWith(dist) && existsSync(path) && statSync(path).isFile()
        ? path
        : join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

describe('interfaccia nel browser', { timeout: 60_000 }, () => {
  let t: TestDatabase;
  let s: Scenario;
  let web: Server;
  let base: string;
  let browser: Browser;
  let doctor: BrowserContext;
  let page: Page;
  let work: string;
  let therapyId: string;
  let lastName: string;

  /** Codice a 6 cifre: ogni accesso usa l'intervallo di 30 secondi successivo. */
  const nextCode = (secret: string) => {
    s.clock.advance(30_000);
    return totp(base32Decode(secret.replace(/\s/g, '')), s.clock.now().getTime());
  };

  async function loginInBrowser(p: Page, who: 'titolare' | 'segreteria') {
    await p.goto(base);
    await p.getByLabel('Nome utente').fill(s.users[who].username);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByLabel('Postazione').fill(`browser-${who}`);
    await p.getByRole('button', { name: 'Continua' }).click();
    const secret = await p.locator('.segreto').innerText();
    s.secrets.set(s.users[who].id, base32Decode(secret.replace(/\s/g, '')));
    await p.getByLabel('Codice a 6 cifre').fill(nextCode(secret));
    await p.getByRole('button', { name: 'Entra' }).click();
    await p.getByRole('heading', { level: 1, name: 'Oggi' }).waitFor();
  }

  /** Nessuna violazione WCAG 2.2 A e AA trovata da axe-core. */
  async function expectAccessible(p: Page, where: string) {
    await p.addScriptTag({ content: AXE });
    const violations = await p.evaluate(async (tags) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              c: unknown,
              o: unknown,
            ) => Promise<{
              violations: { id: string; help: string; nodes: { target: string[] }[] }[];
            }>;
          };
        }
      ).axe;
      const r = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
      return r.violations.map(
        (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
    }, WCAG_TAGS);
    expect(violations, where).toEqual([]);
  }

  /** Ogni elemento con cui si interagisce misura almeno 44×44 px (le caselle con la loro etichetta). */
  async function expectTargets(p: Page, where: string) {
    const small = await p.evaluate((min) => {
      const out: string[] = [];
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      for (const el of document.querySelectorAll('a, button, input, select, textarea, summary')) {
        if (!visible(el) || el.closest('.salta')) continue;
        // Eccezione WCAG: collegamenti dentro una frase.
        if (
          el.tagName === 'A' &&
          el.parentElement?.closest('p') &&
          getComputedStyle(el).display === 'inline'
        )
          continue;
        let target: Element = el;
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          target = el.closest('label') ?? el.closest('.casella') ?? el;
        }
        const r = target.getBoundingClientRect();
        if (r.width < min - 0.5 || r.height < min - 0.5) {
          out.push(
            `${el.tagName.toLowerCase()} «${(el.textContent || el.getAttribute('aria-label') || el.id).trim().slice(0, 40)}» ${Math.round(r.width)}×${Math.round(r.height)}`,
          );
        }
      }
      return out;
    }, MIN_TARGET);
    expect(small, where).toEqual([]);
  }

  /** Su tablet, in verticale e in orizzontale, la pagina non scorre di lato. */
  async function expectTabletLayout(p: Page, where: string) {
    for (const v of TABLETS) {
      await p.setViewportSize(v);
      const wide = await p.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
          .filter((el) => !el.closest('.tabella-scorrevole'))
          .slice(0, 5)
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}.${el.className} → ${Math.round(el.getBoundingClientRect().right)}`,
          ),
      );
      expect(wide, `${where} a ${v.width}×${v.height}: elementi oltre il bordo`).toEqual([]);
      await expectTargets(p, `${where} a ${v.width}×${v.height}`);
    }
    await p.setViewportSize({ width: 1280, height: 900 });
  }

  const check = async (p: Page, where: string, tablet = false) => {
    await expectAccessible(p, where);
    await expectTargets(p, where);
    if (tablet) await expectTabletLayout(p, where);
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-e2e-'));
    // Banche dati d'esempio, dall'output vero di sync/.
    const site = await serveExampleSite();
    try {
      const syncDir = join(work, 'dati-pubblici');
      expect((await runSyncOnExample(site, syncDir)).code).toBe(0);
      await importReferenceData({
        db: t.db,
        syncDir,
        transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
        mappings: overrideMappings(loadMappings(), loadMappings(EXAMPLE_MAPPINGS)),
        importedBy: 'prova',
      });
    } finally {
      await site.close();
    }
    s = await createScenario(t.db);
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    lastName = rich!.lastName;
    therapyId = (
      await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient))
    ).find((x) => !x.reserved)!.id;
    const midnight = startOfStudioDay(studioDate(new Date())).getTime();
    await withActor(t.db, s.users.titolare.id, async (tx) => {
      await tx.insert(appointment).values({
        studioId: s.studioId,
        patientId: s.richPatient,
        doctorUserId: s.users.titolare.id,
        startsAt: new Date(midnight + 9 * 3_600_000),
        endsAt: new Date(midnight + 9.25 * 3_600_000),
        kind: 'office',
        notes: 'Controllo di prova',
        createdBy: s.users.segreteria.id,
      });
      for (const [occurredOn, value] of [
        ['2026-05-10', '6,4'],
        ['2026-11-12', '7,1'],
      ] as const) {
        const [e] = await tx
          .insert(clinicalEntry)
          .values({
            patientId: s.richPatient,
            kind: 'lab_result',
            occurredOn,
            authorUserId: s.users.titolare.id,
          })
          .returning();
        await tx.insert(labResultDetail).values({
          entryId: e!.id,
          analyte: 'Esame di prova',
          value,
          unit: '%',
          referenceText: '4,0–6,0 %',
        });
      }
      const [m] = await tx
        .insert(clinicalEntry)
        .values({
          patientId: s.richPatient,
          kind: 'measurement',
          occurredOn: studioDate(new Date()),
          authorUserId: s.users.titolare.id,
        })
        .returning();
      await tx
        .insert(measurementDetail)
        .values({ entryId: m!.id, measure: 'Peso', value: '74', unit: 'kg' });
    });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const apiPort = (s.app.server.address() as AddressInfo).port;
    const dist = join(work, 'dist');
    execFileSync(
      join(WEB, 'node_modules', '.bin', 'vite'),
      ['build', '--outDir', dist, '--emptyOutDir'],
      {
        cwd: WEB,
        stdio: 'pipe',
      },
    );
    web = await serveWeb(dist, apiPort);
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    browser = await chromium.launch();
    doctor = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'it-IT' });
    page = await doctor.newPage();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (web ? web.close(ok) : ok(null)));
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('accesso: password, attivazione del secondo fattore, poi «Oggi»', async () => {
    await page.goto(base);
    await check(page, 'pagina di accesso');
    await loginInBrowser(page, 'titolare');
    await page.getByText('Controllo di prova').waitFor();
    await check(page, 'Oggi', true);
  });

  it('il menu ha simbolo e nome insieme (D67)', async () => {
    const items = page.locator('nav[aria-label="Sezioni"] a');
    for (const label of ['Oggi', 'Pazienti', 'Ricette', 'Farmaci e prestazioni']) {
      const item = items.filter({ hasText: label });
      await expect(item.locator('svg[aria-hidden="true"]').count()).resolves.toBe(1);
    }
  });

  it('elenco pazienti con la ricerca', async () => {
    await page.getByRole('link', { name: 'Pazienti' }).first().click();
    await page.getByLabel('Cerca un paziente').fill(lastName);
    await page.locator('.paziente-riga').first().waitFor();
    await check(page, 'Pazienti', true);
  });

  it('cartella: riepilogo, terapia, parametri e cronologia filtrabile', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    await page.getByText('Farmaco di prova 5 mg').first().waitFor();
    await page.locator('.parametri').getByText('74 kg').waitFor();
    await check(page, 'cartella', true);
    await page.getByRole('button', { name: 'Ricette', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Ricette', exact: true }).getAttribute('aria-pressed'),
    ).resolves.toBe('true');
  });

  it('nuova ricetta dalla banca dati: controlli, firma e invio con NRE', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/ricetta`);
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('provalina');
    await page.locator('.risultato').filter({ hasText: '28 compresse' }).waitFor();
    await page.getByText('Banche dati dei farmaci in uso').waitFor();
    await check(page, 'nuova ricetta con risultati', true);
    await page
      .locator('.risultato')
      .filter({ hasText: '28 compresse' })
      .getByRole('button', { name: 'Aggiungi' })
      .click();
    await page.getByLabel('Confezioni').fill('1');
    await page.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await page.getByRole('heading', { name: 'Controlli prima dell’invio' }).waitFor();
    await page.getByText(/Regole di prescrizione, versione/).waitFor();
    await check(page, 'ricetta con i controlli');
    await page.getByRole('button', { name: 'Firma e invia' }).click();
    await page.getByText('Ricetta inviata').waitFor();
  });

  it('scheda della terapia con lo storico delle prescrizioni (D65)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/terapie/${therapyId}`);
    await page.getByRole('heading', { name: 'Storico delle prescrizioni' }).waitFor();
    // La ricetta appena inviata ha lo stesso principio attivo: è nello storico, con l'NRE.
    await page.locator('table').getByText(/NRE/).first().waitFor();
    await check(page, 'scheda della terapia', true);
  });

  it('ricetta specialistica dal catalogo, poi lo storico della prestazione (D66)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/specialistica`);
    await page.getByLabel('Prestazione, branca o codice').fill('visita');
    await page.locator('.risultato').filter({ hasText: 'Visita di prova' }).waitFor();
    await check(page, 'ricetta specialistica', true);
    await page
      .locator('.risultato')
      .filter({ hasText: 'Visita di prova' })
      .getByRole('button', { name: 'Aggiungi' })
      .click();
    await page.getByLabel('Quesito diagnostico').fill('Quesito di prova');
    await page.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await page.getByRole('button', { name: 'Firma e invia' }).click();
    await page.getByText('Ricetta inviata').waitFor();
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('link', { name: 'Visita di prova' }).click();
    await page.getByRole('heading', { name: 'Storico delle prescrizioni' }).waitFor();
    await page.getByText('Primo accesso').waitFor();
    await check(page, 'storico della prestazione');
  });

  it('esami: valori e intervallo del referto, senza giudizio', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/esami`);
    await page.getByRole('cell', { name: '7,1 %' }).waitFor();
    expect(await page.locator('main').innerText()).not.toMatch(/\bsopra\b|\bsotto\b/i);
    await check(page, 'esami', true);
  });

  it('ricerca farmaci con filtri, equivalenti e data della banca dati (A6)', async () => {
    await page.goto(`${base}/banche-dati`);
    await page.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('provalina');
    await page.locator('.risultato').first().waitFor();
    await page
      .locator('.risultato')
      .filter({ hasText: '28 compresse' })
      .getByRole('button', { name: 'Mostra gli equivalenti' })
      .click();
    await page.getByRole('table').waitFor();
    await page
      .getByText(/scaricata il/)
      .first()
      .waitFor();
    await check(page, 'ricerca farmaci', true);
  });

  it('la segreteria prepara la ripetizione; il medico la trova da firmare e la firma', async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      locale: 'it-IT',
    });
    const sec = await ctx.newPage();
    try {
      await loginInBrowser(sec, 'segreteria');
      await sec.goto(`${base}/pazienti/${s.richPatient}`);
      await sec.getByText('Riepilogo clinico').waitFor();
      await sec.getByLabel('Seleziona Farmaco di prova 5 mg da ripetere').check();
      await sec.getByRole('button', { name: /Ripeti 1 terapia/ }).click();
      await sec.getByText(/coda «da firmare» del medico/).waitFor();
      await check(sec, 'cartella vista dalla segreteria');
    } finally {
      await ctx.close();
    }
    await page.goto(`${base}/ricette`);
    await page.getByRole('heading', { name: 'Da firmare' }).waitFor();
    await page.getByRole('button', { name: 'Firma e invia' }).first().waitFor();
    await check(page, 'ricette da firmare', true);
    await page.getByRole('button', { name: 'Firma e invia' }).first().click();
    await page.getByText(/Ricetta inviata per/).waitFor();
  });

  it('dopo l’inattività la sessione si blocca e si sblocca con il codice', async () => {
    s.clock.advance(6 * 60_000);
    await page.goto(`${base}/pazienti`);
    await page.getByRole('heading', { name: 'Sessione bloccata' }).waitFor();
    await check(page, 'sessione bloccata');
    const secret = s.secrets.get(s.users.titolare.id)!;
    s.clock.advance(30_000);
    await page.getByLabel('Codice a 6 cifre').fill(totp(secret, s.clock.now().getTime()));
    await page.getByRole('button', { name: 'Sblocca' }).click();
    await page.getByRole('heading', { level: 1, name: 'Pazienti' }).waitFor();
  });
});
