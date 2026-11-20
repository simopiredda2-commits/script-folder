/**
 * Prove della dimostrazione nel browser (D221, D223), sulla pagina costruita (`dist/artifact`).
 *
 *   pnpm --filter @mmg/demo build
 *   pnpm --filter @mmg/demo test:browser            # Chromium
 *   DEMO_BROWSER=webkit pnpm --filter @mmg/demo test:browser
 *
 * La pagina gira dentro un iframe con sandbox, come nell'artifact di claude.ai: senza finestre del
 * browser (conferme, stampa), senza schede nuove e senza download. Le prove usano l'interfaccia
 * come chi prova la dimostrazione: il codice del secondo fattore si legge nel riquadro, i PDF si
 * aprono nel visore. Tutto inventato (regola 1), nessun sito esterno (regola 7).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { generatePatients } from '@mmg/fixtures';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type Frame,
  type Locator,
  type Page,
} from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', 'dist', 'artifact');
const ENGINES = { chromium, firefox, webkit };
const ENGINE = process.env.DEMO_BROWSER ?? 'chromium';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf-8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MIN_TARGET = 44;
const PASSWORD = 'dimostrazione';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * La cornice dell'artifact: niente `allow-modals` (conferme e stampa), `allow-popups` (schede
 * nuove), `allow-downloads`, `allow-top-navigation`.
 */
const FRAME_PAGE =
  '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Cornice di prova</title></head>' +
  '<body style="margin:0"><iframe title="Dimostrazione" sandbox="allow-scripts allow-same-origin allow-forms" ' +
  'src="/index.html" style="border:0;display:block;width:100vw;height:100vh"></iframe></body></html>';

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/cornice.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FRAME_PAGE);
      return;
    }
    let file = join(ROOT, decodeURIComponent(url.pathname));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Una pagina sola: gli indirizzi dell'interfaccia tornano alla pagina.
    if (!existsSync(file) || !statSync(file).isFile()) file = join(ROOT, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

describe(`dimostrazione nel browser (${ENGINE})`, { timeout: 120_000 }, () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let f: Frame;
  /** Errori della pagina, della console e risposte 5xx del servizio, in tutto il giro. */
  const problems: string[] = [];
  const lastCode = new Map<string, string>();
  let startMs = 0;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'index.html')))
      throw new Error('Manca la dimostrazione costruita: pnpm --filter @mmg/demo build');
    if (!Object.hasOwn(ENGINES, ENGINE))
      throw new Error(`DEMO_BROWSER=${ENGINE}: motore sconosciuto`);
    server = await serve();
    browser = await ENGINES[ENGINE as keyof typeof ENGINES].launch();
    expect(browser.browserType().name()).toBe(ENGINE);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`errore della pagina: ${e.message}`));
    // Nessun messaggio d'errore è atteso, nemmeno quelli del browser sulle finestre bloccate:
    // nella cornice la dimostrazione non prova ad aprirle (dialogs.ts).
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
    });
    const port = (server.address() as AddressInfo).port;
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${port}/cornice.html`);
    f = page.frames().find((x) => x.parentFrame() === page.mainFrame())!;
    await f.getByLabel('Nome utente').waitFor({ timeout: 90_000 });
    startMs = Date.now() - t0;
    // Le chiamate al servizio che finiscono con un errore del servizio (5xx) sono un problema.
    await f.evaluate(() => {
      const w = window as Window & { __errori?: string[] };
      w.__errori = [];
      const original = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const res = await original(...args);
        if (res.status >= 500) {
          const url = args[0] instanceof Request ? args[0].url : String(args[0]);
          w.__errori!.push(`${res.status} ${url} ${(await res.clone().text()).slice(0, 200)}`);
        }
        return res;
      };
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => (server ? server.close(ok) : ok(null)));
  });

  /** Un cambio di pagina dell'interfaccia, senza ricaricare (ricaricare riparte da capo). */
  const go = (path: string) =>
    f.evaluate((p) => {
      history.pushState({}, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);

  /**
   * Il codice del secondo fattore nel riquadro aperto, per questo utente e diverso da quello che ha
   * già usato (lo stesso codice non vale due volte).
   */
  async function codeFor(username: string) {
    const opener = f.locator('button.dimo-apri');
    if (await opener.count()) await opener.click();
    const line = f.locator('#dimostrazione p', { hasText: `Codice per ${username}:` });
    for (let i = 0; i < 80; i++) {
      if (await line.count()) {
        const code = (await line.locator('.dimo-codice').innerText()).replace(/\s/g, '');
        if (/^\d{6}$/.test(code) && code !== lastCode.get(username)) {
          lastCode.set(username, code);
          return code;
        }
      }
      await page.waitForTimeout(500);
    }
    throw new Error(`Nessun codice nuovo per ${username}`);
  }

  /**
   * Legge nel riquadro della dimostrazione, che dopo l'accesso si riduce da sé: lo apre, legge, e lo
   * riduce di nuovo, perché aperto copre la pagina.
   */
  async function fromPanel<T>(read: (panel: Locator) => Promise<T>): Promise<T> {
    const opener = f.locator('button.dimo-apri');
    if (await opener.count()) await opener.click();
    const panel = f.locator('#dimostrazione');
    await panel.getByRole('heading', { level: 2, name: 'Dimostrazione' }).waitFor();
    const value = await read(panel);
    await panel.getByRole('button', { name: 'Riduci il riquadro della dimostrazione' }).click();
    await opener.waitFor();
    return value;
  }

  async function login(username: string) {
    const exit = f.getByRole('button', { name: 'Esci', exact: true });
    if (await exit.count()) {
      await exit.click();
      await f.getByLabel('Nome utente').waitFor();
    }
    // Dopo l'accesso il programma torna alla pagina di prima: si riparte da «Oggi».
    await go('/');
    await f.getByLabel('Nome utente').fill(username);
    await f.getByLabel('Password').fill(PASSWORD);
    await f.getByLabel('Postazione').fill('Ambulatorio');
    await f.getByRole('button', { name: 'Continua' }).click();
    await f.getByLabel('Codice a 6 cifre').waitFor();
    await f.getByLabel('Codice a 6 cifre').fill(await codeFor(username));
    await f.getByLabel('Codice a 6 cifre').press('Enter');
    await f.getByRole('heading', { level: 1, name: 'Oggi' }).waitFor({ timeout: 30_000 });
  }

  const viewer = () => f.locator('#dimo-visore');
  async function closeViewer() {
    await viewer().getByRole('button', { name: 'Chiudi' }).click();
    await viewer().waitFor({ state: 'detached' });
  }

  /** Un paziente del medico per nome e cognome, dall'elenco del servizio. */
  async function patientOf(name: string) {
    return f.evaluate(async (wanted) => {
      const list = (await (await fetch('/api/pazienti')).json()) as {
        pazienti: { id: string; nome: string; cognome: string }[];
      };
      return list.pazienti.find((p) => `${p.nome} ${p.cognome}` === wanted) ?? null;
    }, name);
  }

  async function patientId(name: string) {
    return (await patientOf(name))?.id ?? null;
  }

  /** I due cambi di medico che AURA simulata ha mandato (D227, D229): uno da spostare, uno no. */
  async function doctorChanges() {
    const [, moving, kept, colleague] =
      /la scelta di (.+) e di (.+) per la collega (.+): il cambio di medico/.exec(
        await fromPanel((p) => p.getByRole('region', { name: 'AURA simulata' }).innerText()),
      )!;
    return { moving: moving!, kept: kept!, colleague: colleague! };
  }

  /** I cambi di medico ancora da decidere e in arrivo, per l'utente entrato, dal servizio. */
  async function pendingChanges() {
    return f.evaluate(async () => {
      type Change = { paziente: { nome: string; cognome: string } };
      const r = (await (await fetch('/api/aura/cambi-medico')).json()) as {
        daDecidere: Change[];
        inArrivo: Change[];
      };
      const names = (l: Change[]) => l.map((c) => `${c.paziente.nome} ${c.paziente.cognome}`);
      return { daDecidere: names(r.daDecidere), inArrivo: names(r.inArrivo) };
    });
  }

  /** Il paziente dell'altro studio dell'AFT e il suo codice fiscale, dal riquadro. */
  async function aftPatient() {
    return fromPanel(async (p) => {
      const region = p.getByRole('region', { name: 'AFT', exact: true });
      const text = await region.innerText();
      const [, name] = /si consulta la scheda di (.+), che ha/.exec(text)!;
      return { name: name!, fiscalCode: (await region.locator('code').innerText()).trim() };
    });
  }

  /** Nessuna violazione WCAG 2.2 A e AA trovata da axe-core, nel documento della dimostrazione. */
  async function expectAccessible(where: string) {
    await f.addScriptTag({ content: AXE });
    const violations = await f.evaluate(async (tags) => {
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

  /** Bersagli di almeno 44×44 px nelle parti della dimostrazione (riquadro, visore, conferma). */
  async function expectDemoTargets(selector: string, where: string) {
    const small = await f.evaluate(
      ({ selector, min }) => {
        const out: string[] = [];
        for (const root of document.querySelectorAll(selector))
          for (const el of root.querySelectorAll('a, button, input, select, textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (
              el.tagName === 'A' &&
              el.parentElement?.closest('p') &&
              getComputedStyle(el).display === 'inline'
            )
              continue;
            if (r.width < min - 0.5 || r.height < min - 0.5)
              out.push(
                `${el.tagName.toLowerCase()} «${(el.textContent ?? '').trim().slice(0, 30)}» ${Math.round(r.width)}×${Math.round(r.height)}`,
              );
          }
        return out;
      },
      { selector, min: MIN_TARGET },
    );
    expect(small, where).toEqual([]);
  }

  it('avvio: il programma parte nella cornice, con utenti e AURA simulata nel riquadro', async () => {
    expect(startMs).toBeLessThan(90_000);
    const panel = f.locator('#dimostrazione');
    for (const u of [
      'medico',
      'segreteria',
      'sostituto',
      'amministratore',
      'collega',
      'medico.aft',
    ])
      await panel.getByRole('cell', { name: u, exact: true }).waitFor();
    await panel
      .getByRole('region', { name: 'AFT', exact: true })
      .getByText(/che ha dato il consenso: codice fiscale/)
      .waitFor();
    const aura = panel.getByRole('region', { name: 'AURA simulata' });
    await aura.getByText(/un nuovo assistito, .+, da registrare\./).waitFor();
    await expectAccessible('pagina di accesso con il riquadro');
    await expectDemoTargets('#dimostrazione', 'riquadro della dimostrazione');
  });

  it('AURA: in Oggi le variazioni; il nuovo assistito si registra, l’ASL si conferma', async () => {
    const hints = f.locator('#dimostrazione').getByRole('region', { name: 'AURA simulata' });
    const text = await hints.innerText();
    const newPatient = text.match(/un nuovo assistito, (.+), da registrare/)![1]!;
    const registry = text.match(/un’ASL diversa per (.+), da confermare/)![1]!;
    const deceased = text.match(/il decesso di (.+), da confermare/)![1]!;
    const exemption = text.match(/un’esenzione nuova per (.+);/)![1]!;
    await login('medico');

    const changes = f.getByRole('region', { name: 'Variazioni da AURA' });
    await changes.getByText(`AURA segnala il decesso di ${deceased}`, { exact: false }).waitFor();
    await changes.getByRole('link', { name: exemption }).first().waitFor();
    await changes.getByText(/nuova – Esenzione 013/).waitFor();

    const news = f.getByRole('region', { name: 'Nuovi assistiti in AURA' });
    await news.getByRole('button', { name: `Registra ${newPatient}` }).click();
    await news.getByText(`${newPatient}: registrato con i dati di AURA.`).waitFor();

    // L'anagrafica diversa: l'ASL di AURA si usa con un clic, dai dati amministrativi.
    await go(`/pazienti/${await patientId(registry)}/amministrazione`);
    const section = f.getByRole('region', { name: 'AURA, anagrafe regionale' });
    await section
      .getByRole('heading', { name: 'Anagrafica diversa in AURA, da confermare' })
      .waitFor();
    await section.getByRole('button', { name: 'Usa il dato di AURA: ASL di assistenza' }).click();
    await section.getByText('ASL di assistenza: ora c’è il dato di AURA.').waitFor();
    // Un controllo a mano: nulla di nuovo in AURA.
    await section.getByRole('button', { name: 'Aggiorna da AURA' }).click();
    await section.getByText(/Aggiornato da AURA/).waitFor();
  });

  it('ricetta: accesso regionale con SPID simulato, firma e invio, promemoria su A5 nel visore', async () => {
    await go('/profilo/credenziali');
    await f.getByRole('button', { name: 'Entra con SPID o CIE' }).click();
    await viewer().locator('button[value="spid"]').click();
    await viewer().waitFor({ state: 'detached' });
    await f
      .getByText(/Attivo fino a/)
      .first()
      .waitFor();
    const ts = f.getByRole('region', { name: 'Sistema TS' });
    await ts.getByRole('button', { name: 'Chiedi il codice' }).click();
    await ts.getByText(/Ambiente di prova/).waitFor();
    await ts.getByRole('button', { name: 'Attiva' }).click();
    await f.getByText('Codice di sessione attivo.').waitFor();

    await go('/ricette');
    await f.getByRole('button', { name: 'Firma e invia' }).first().click();
    await f
      .getByText(/Ricetta inviata per/)
      .first()
      .waitFor({ timeout: 30_000 });
    await f
      .getByText(/^Carta A5 orizzontale\./)
      .first()
      .waitFor();
    await f.getByRole('link', { name: 'Promemoria (PDF)' }).first().click();
    const canvas = viewer().locator('canvas').first();
    await canvas.waitFor({ timeout: 30_000 });
    const ratio = await canvas.evaluate((c: HTMLCanvasElement) => c.width / c.height);
    expect(ratio).toBeCloseTo(210 / 148, 1);
    await expectAccessible('promemoria nel visore');
    await expectDemoTargets('#dimo-visore', 'visore');
    await closeViewer();
  });

  it('certificato di malattia: controllato, inviato, copia per il lavoratore nel visore', async () => {
    // Un adulto in età da lavoro.
    const id = (await patients()).find(
      (p) => p.dataNascita >= '1966-01-01' && p.dataNascita <= '1996-12-31',
    )!.id;
    await go(`/pazienti/${id}/certificati`);
    await f.getByRole('heading', { level: 1, name: 'Certificati di malattia' }).waitFor();
    await f.getByRole('button', { name: 'Nuovo certificato' }).click();
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await f.getByLabel('Prognosi a tutto il').fill(end);
    await f.getByLabel('Codice ICD-9-CM').fill('487.1');
    await f.getByLabel('Diagnosi', { exact: true }).fill('Sindrome influenzale (dimostrazione)');
    await f.getByRole('button', { name: 'Salva e controlla' }).click();
    await f.getByText('Nessun problema nei controlli: si può inviare.').waitFor();
    await f.getByRole('button', { name: 'Firma e invia all’INPS' }).click();
    const card = f.locator('.scheda-certificato').filter({ hasText: 'Inviato' }).first();
    await card.getByText(/protocollo SIM\d+/).waitFor({ timeout: 30_000 });
    await card.getByRole('link', { name: 'Copia per il lavoratore (PDF)' }).click();
    await viewer().locator('canvas').first().waitFor({ timeout: 30_000 });
    await closeViewer();
  });

  /** Una lettura dal servizio, come la fa l'interfaccia: con la sessione di chi è entrato. */
  const read = (path: string) =>
    f.evaluate(async (p) => {
      const res = await fetch(p);
      return res.ok ? ((await res.json()) as unknown) : null;
    }, path);

  /** I pazienti che l'utente vede, nell'ordine dell'elenco. */
  const patients = async () =>
    ((await read('/api/pazienti')) as { pazienti: { id: string; dataNascita: string }[] }).pazienti;

  /** Il primo paziente per cui la lettura di `path(id)` soddisfa `test`. */
  async function firstPatient(path: (id: string) => string, test: (body: unknown) => boolean) {
    for (const p of await patients()) if (test(await read(path(p.id)))) return p.id;
    return null;
  }

  it('nuova ricetta dalla banca dati: amlodipina, controlli, firma e invio', async () => {
    const id = await firstPatient(
      (id) => `/api/pazienti/${id}/terapie`,
      (t) => t !== null && !JSON.stringify(t).toLowerCase().includes('amlodipina'),
    );
    expect(id).not.toBeNull();
    await go(`/pazienti/${id}/ricetta`);
    const restart = f.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    await f.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
    const result = f
      .locator('.risultato')
      .filter({ hasText: /AMLODIPINA/i })
      .first();
    await result.getByRole('button', { name: 'Aggiungi' }).click();
    await f.locator('.riga-ricetta').first().waitFor();
    await f.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await f.getByRole('heading', { name: 'Controlli prima dell’invio' }).waitFor();
    await f.getByRole('button', { name: 'Firma e invia' }).click();
    await f
      .getByText(/Ricetta inviata/)
      .first()
      .waitFor({ timeout: 30_000 });
  });

  it('voci cliniche e Profilo sanitario: preparato, validato, firmato e pubblicato; PDF nel visore', async () => {
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/voci`);
    await f.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    await f.getByLabel('Descrizione').fill('Ipertensione arteriosa (dimostrazione)');
    await f.getByLabel('Codice ICD-9-CM').fill('401.9');
    await f.getByLabel(/Patologia cronica/).check();
    await f.getByRole('button', { name: 'Registra', exact: true }).click();
    await f.getByText('Voce registrata.').waitFor();

    await go(`/pazienti/${id}/profilo-sanitario`);
    await f.getByRole('heading', { level: 1, name: 'Profilo sanitario sintetico' }).waitFor();
    await f.getByRole('button', { name: 'Prepara il Profilo dalla cartella' }).click();
    await f.getByText('Bozza preparata dalla cartella.').waitFor();
    await f.getByLabel('Ho controllato il contenuto del Profilo, voce per voce').check();
    await f.getByRole('button', { name: 'Valida con il Gateway' }).click();
    await f.getByText('Validato dal Gateway. Ora puoi firmarlo e pubblicarlo.').waitFor({
      timeout: 30_000,
    });
    await f.getByRole('button', { name: 'Firma e pubblica' }).click();
    await f.getByText('Profilo firmato e pubblicato nel Fascicolo.').waitFor({ timeout: 30_000 });
    await f.getByRole('link', { name: 'PDF firmato della versione 1' }).click();
    await viewer().locator('canvas').first().waitFor({ timeout: 30_000 });
    await closeViewer();
  });

  it('specialistica e seguito: visita dal catalogo inviata, poi l’esecuzione con il referto nel visore', async () => {
    const id = (await patients())[1]!.id;
    await go(`/pazienti/${id}/specialistica`);
    const restart = f.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    await f.getByLabel('Prestazione, branca o codice').fill('visita');
    await f.locator('.risultato').first().getByRole('button', { name: 'Aggiungi' }).click();
    await f.getByLabel('Quesito diagnostico').fill('Quesito dimostrativo');
    await f.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await f.getByRole('button', { name: 'Firma e invia' }).click();
    await f
      .getByText(/Ricetta inviata/)
      .first()
      .waitFor({ timeout: 30_000 });

    await go(`/pazienti/${id}/seguito`);
    await f.getByRole('heading', { level: 1, name: 'Seguito delle prestazioni' }).waitFor();
    await f
      .getByRole('button', { name: /Registra (l’esecuzione|una seduta)/ })
      .first()
      .click();
    await f.getByLabel('Struttura').fill('Struttura dimostrativa');
    await f.getByLabel('Esito').fill('Esito dimostrativo, paziente inventato.');
    await f.getByLabel(/Referto \(PDF o immagine/).setInputFiles({
      name: 'referto-dimostrativo.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% referto dimostrativo\n%%EOF\n', 'latin1'),
    });
    await f.getByRole('button', { name: 'Registra', exact: true }).click();
    await f.getByText('Esecuzione registrata.').waitFor();
    await f
      .getByRole('link', { name: /Referto/ })
      .first()
      .click();
    await viewer().waitFor();
    await closeViewer();
  });

  it('prestazioni aggiuntive: registrata in cartella, con il compenso del catalogo', async () => {
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/prestazioni-aggiuntive`);
    await f.getByRole('heading', { level: 1, name: 'Prestazioni aggiuntive' }).waitFor();
    const today = new Date().toISOString().slice(0, 10);
    await f.getByLabel('Data dell’esecuzione').fill(today);
    await f.getByLabel('Prestazione', { exact: true }).selectOption({ index: 1 });
    const auth = f.getByLabel(/^Estremi dell’autorizzazione/);
    if (await auth.evaluate((el) => (el as HTMLInputElement).required))
      await auth.fill('Autorizzazione dimostrativa n. 1');
    await f.getByRole('button', { name: 'Registra la prestazione' }).click();
    await f.getByText('Prestazione registrata.').waitFor();
  });

  it('la segreteria prepara la ripetizione; il medico la trova da firmare e la manda', async () => {
    await login('segreteria');
    const id = await firstPatient(
      (id) => `/api/pazienti/${id}/terapie`,
      (j) =>
        ((j as { terapie?: { status: string }[] } | null)?.terapie ?? []).some(
          (t) => t.status === 'active',
        ),
    );
    await go(`/pazienti/${id}`);
    const pick = f.getByLabel(/^Seleziona .+ da ripetere$/).first();
    await pick.check();
    await f.getByRole('button', { name: /Ripeti 1 terapia/ }).click();
    await f.getByText(/coda «da firmare» del medico/).waitFor();
    await login('medico');
    await go('/ricette');
    await f.getByRole('button', { name: 'Firma e invia' }).first().click();
    await f
      .getByText(/Ricetta inviata per/)
      .first()
      .waitFor({ timeout: 30_000 });
  });

  it('Fascicolo regionale: la scheda nuova non si apre, il collegamento porta al visore', async () => {
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/fascicolo-regionale`);
    await f.getByRole('heading', { level: 1, name: 'Fascicolo regionale' }).waitFor();
    await f.getByRole('button', { name: 'Apri il Fascicolo' }).click();
    await f.getByRole('link', { name: 'Apri il Fascicolo' }).click();
    await viewer()
      .getByText(/Qui si aprirebbe il Fascicolo dell’assistito/)
      .waitFor();
    await closeViewer();
  });

  it('schema orario: la stampa non parte e la pagina lo dice', async () => {
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/schema-orario`);
    await f.getByRole('button', { name: 'Stampa' }).click();
    await f
      .locator('#dimo-avviso')
      .getByText(/la stampa non parte/)
      .waitFor();
    await expectDemoTargets('#dimo-avviso', 'avviso della stampa');
  });

  it('riepiloghi: il CSV si apre nel visore', async () => {
    await go('/archivio/riepiloghi');
    await f.getByRole('link', { name: 'Scarica in CSV' }).click();
    await viewer()
      .getByText(/Data;|Data,|Tipo/)
      .first()
      .waitFor({ timeout: 30_000 });
    await closeViewer();
  });

  it('importazione: file, anteprima, prova senza scrivere, importazione', async () => {
    // Pazienti inventati (D12): codici fiscali con la X, che nessun comune ha.
    const nuovi = generatePatients({ seed: 'importazione-della-dimostrazione', count: 2 });
    const csv = [
      'Codice fiscale;Cognome;Nome;Sesso;Data di nascita',
      ...nuovi.map((p) => [p.fiscalCode, p.lastName, p.firstName, p.sex, p.birthDate].join(';')),
    ].join('\r\n');
    await go('/strumenti?sezione=importazione');
    await f.getByRole('heading', { level: 2, name: 'Importazione da altri programmi' }).waitFor();
    await f.getByLabel('File da importare').setInputFiles({
      name: 'pazienti-inventati.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
    await f.getByRole('button', { name: 'Carica e leggi il file' }).click();
    await f.getByRole('heading', { level: 4, name: 'File letto' }).waitFor();
    await f.getByRole('button', { name: 'Avanti: dove vanno i dati' }).click();
    await f.getByRole('button', { name: 'Avanti: colonne e campi' }).click();
    await f.getByRole('button', { name: 'Mostra l’anteprima' }).click();
    await f.getByText(nuovi[0]!.lastName).first().waitFor();
    await f.getByRole('button', { name: 'Avanti: prova senza scrivere' }).click();
    await f.getByRole('button', { name: 'Fai la prova (non scrive nulla)' }).click();
    await f.getByText('Prova finita: nessun dato è stato scritto.').waitFor();
    await f.getByRole('button', { name: 'Avanti: importa' }).click();
    await f.getByLabel('Ho controllato la prova: importa i dati nel mio archivio').check();
    await f.getByRole('button', { name: 'Importa', exact: true }).click();
    await f.getByText('Importazione finita.').waitFor({ timeout: 30_000 });
    expect(await patientId(`${nuovi[0]!.firstName} ${nuovi[0]!.lastName}`)).not.toBeNull();
  });

  it('cambio di medico dentro lo studio: in Oggi «Sposta», e il paziente passa alla collega', async () => {
    const { moving, colleague } = await doctorChanges();
    await login('medico');
    const changes = f.getByRole('region', { name: 'Cambi di medico nello studio' });
    await changes
      .getByRole('button', { name: `Sposta ${moving} nell’archivio di ${colleague}` })
      .click();
    await changes.getByText(`${moving}: spostato nell’archivio di ${colleague}.`).waitFor();
    expect(await patientId(moving)).toBeNull();
    // La collega lo trova nel suo archivio.
    await login('collega');
    expect(await patientId(moving)).not.toBeNull();
  });

  it('cambio di medico: «Non spostare», e il paziente resta nell’archivio senza riproporsi', async () => {
    const { kept } = await doctorChanges();
    // La collega scelta lo vede in arrivo, finché il medico non decide.
    await login('collega');
    expect((await pendingChanges()).inArrivo).toContain(kept);
    await login('medico');
    const changes = f.getByRole('region', { name: 'Cambi di medico nello studio' });
    await changes.getByRole('button', { name: `Non spostare ${kept}` }).click();
    await changes
      .getByText(
        `${kept}: resta nel tuo archivio. Non si ripropone finché AURA non manda una scelta nuova.`,
      )
      .waitFor();
    expect(await patientId(kept)).not.toBeNull();
    expect((await pendingChanges()).daDecidere).not.toContain(kept);
    // Non si ripropone né al medico, dopo un nuovo accesso, né alla collega.
    await login('medico');
    expect((await pendingChanges()).daDecidere).not.toContain(kept);
    await login('collega');
    expect((await pendingChanges()).inArrivo).not.toContain(kept);
    expect(await patientId(kept)).toBeNull();
  });

  it('AFT: la scheda del paziente dell’altro studio, con il motivo; la consultazione nel registro del suo medico', async () => {
    const { fiscalCode } = await aftPatient();
    await login('medico');
    await go('/strumenti?sezione=aft');
    await f.getByLabel('Codice fiscale del paziente').fill(fiscalCode);
    await f.getByLabel('Motivo dell’accesso').fill('Visita nell’ambulatorio serale dell’AFT');
    await f.getByRole('button', { name: 'Mostra la scheda' }).click();
    await f.getByText('Penicillina').first().waitFor();
    await f.getByText('Ipertensione arteriosa essenziale').first().waitFor();
    await expectAccessible('scheda di un paziente dell’AFT');
    // Il medico curante, nell'altro studio, vede chi ha consultato, quando e perché.
    await login('medico.aft');
    await go('/strumenti?sezione=aft');
    const log = f.getByRole('region', { name: 'Consultazioni dei colleghi sui miei pazienti' });
    await log.getByText('Visita nell’ambulatorio serale dell’AFT').waitFor();
    await log
      .getByText(/Marchi/)
      .first()
      .waitFor();
  });

  it('AFT: l’attività svolta per il paziente dell’altro studio arriva al suo medico, nell’elenco e nella cronologia', async () => {
    const { name, fiscalCode } = await aftPatient();
    await login('medico');
    await go('/strumenti?sezione=aft');
    await f.getByLabel('Codice fiscale del paziente').fill(fiscalCode);
    await f.getByLabel('Motivo dell’accesso').fill('Controllo della pressione nell’AFT');
    await f.getByRole('button', { name: 'Mostra la scheda' }).click();
    const form = f.getByRole('form', { name: 'Registra l’attività svolta' });
    await form.getByLabel('Tipologia').selectOption({ label: 'Visita in ambulatorio' });
    await form.getByLabel('Esito').fill('Pressione nei limiti, terapia invariata');
    await form
      .getByLabel('Note per il medico curante (facoltative)')
      .fill('Da rivedere fra un mese');
    await form.getByRole('button', { name: 'Registra l’attività' }).click();
    await form
      .getByText('Attività registrata: il medico curante la vede nella cronologia.')
      .waitFor();
    // Il medico curante, nell'altro studio: nell'elenco delle attività dei colleghi…
    await login('medico.aft');
    await go('/strumenti?sezione=aft');
    const row = f
      .getByRole('region', { name: 'Attività dei colleghi sui miei pazienti' })
      .getByRole('row')
      .filter({ hasText: 'Pressione nei limiti, terapia invariata' });
    await row.waitFor();
    const p = (await patientOf(name))!;
    const cells = await row.innerText();
    expect(cells).toContain(`${p.cognome} ${p.nome}`);
    expect(cells).toMatch(/Marchi/);
    expect(cells).toContain('Visita in ambulatorio');
    expect(cells).toContain('Da rivedere fra un mese');
    // … e nella cronologia della cartella, con il nome della collega.
    await go(`/pazienti/${p.id}`);
    const item = f
      .getByRole('region', { name: 'Cronologia' })
      .getByRole('listitem')
      .filter({ hasText: 'Collega dell’AFT: Visita in ambulatorio' });
    await item.waitFor();
    expect(await item.innerText()).toContain('Pressione nei limiti, terapia invariata');
    expect(await item.innerText()).toMatch(/Marchi/);
  });

  it('AFT al contrario: la Dott.ssa Marchi condivide e registra il consenso di una paziente; il medico dell’altro studio la consulta, e lei lo vede nel registro', async () => {
    await login('medico');
    // Una paziente in carico della Dott.ssa Marchi, dal suo elenco.
    const p = await f.evaluate(async () => {
      const list = (await (await fetch('/api/pazienti')).json()) as {
        pazienti: {
          id: string;
          nome: string;
          cognome: string;
          codiceFiscale: string;
          stato: string;
        }[];
      };
      return list.pazienti.find((x) => x.stato === 'active')!;
    });
    // Condivide con i medici dell'AFT (nella dimostrazione, per difetto, no).
    await go('/strumenti?sezione=aft');
    const share = f.getByLabel(
      'Condivido con i medici dell’AFT la scheda dei miei pazienti che hanno dato il consenso',
    );
    await share.check();
    await expect
      .poll(() =>
        f.evaluate(async () => {
          const o = (await (await fetch('/api/aft')).json()) as { aft: { condivido: boolean } };
          return o.aft.condivido;
        }),
      )
      .toBe(true);
    // Il consenso della paziente, nella sua cartella.
    await go(`/pazienti/${p.id}/privacy`);
    await f.getByLabel('Consenso', { exact: true }).selectOption({
      label: 'Condivisione della scheda sanitaria con i medici dell’AFT (senza le voci riservate)',
    });
    await f.getByLabel('Dà il consenso').check();
    await f.getByRole('button', { name: 'Registra il consenso' }).click();
    await f.getByText('Consenso registrato.').waitFor();
    // Il medico dell'altro studio consulta la scheda, con il motivo.
    await login('medico.aft');
    await go('/strumenti?sezione=aft');
    await f.getByLabel('Codice fiscale del paziente').fill(p.codiceFiscale);
    await f.getByLabel('Motivo dell’accesso').fill('Visita in continuità assistenziale nell’AFT');
    await f.getByRole('button', { name: 'Mostra la scheda' }).click();
    await f.getByText(/Scheda condivisa con il consenso del paziente/).waitFor();
    await f.getByText(`${p.cognome} ${p.nome}`).first().waitFor();
    // La Dott.ssa Marchi vede chi ha consultato, quando e perché.
    await login('medico');
    await go('/strumenti?sezione=aft');
    const log = f.getByRole('region', { name: 'Consultazioni dei colleghi sui miei pazienti' });
    await log.getByText('Visita in continuità assistenziale nell’AFT').waitFor();
    await log
      .getByText(/Rinaldi/)
      .first()
      .waitFor();
  });

  it('strumenti: l’amministratore salva lo studio e crea un utente; il medico lo conferma nella pagina', async () => {
    await login('amministratore');
    await go('/strumenti?sezione=studio');
    await f.getByRole('heading', { level: 2, name: 'Dati e impostazioni dello studio' }).waitFor();
    await f.getByLabel('Telefono').fill('000 0000009');
    await f.getByRole('button', { name: 'Salva i dati dello studio' }).click();
    await f.getByText('Dati e impostazioni dello studio salvati.').waitFor();

    await go('/strumenti?sezione=stampa');
    await f.getByLabel('Nome della postazione').fill('Ambulatorio della dimostrazione');
    await f.getByRole('button', { name: 'Aggiungi la postazione' }).click();
    await f
      .getByRole('table', { name: 'Postazioni attive' })
      .getByRole('cell', { name: 'Ambulatorio della dimostrazione', exact: true })
      .first()
      .waitFor();

    await go('/strumenti?sezione=utenti');
    const form = f.getByRole('form', { name: 'Nuovo utente' });
    await form.getByLabel('Nome utente').fill('segreteria.prova');
    await form.getByLabel('Nome mostrato').fill('Segreteria di prova');
    await form.getByLabel('Segreteria', { exact: true }).check();
    await form.getByRole('button', { name: 'Crea l’utente' }).click();
    await f.getByText('Utente creato: Segreteria di prova.').waitFor();

    await go('/strumenti?sezione=servizio');
    await f.getByRole('heading', { level: 2, name: 'Stato del servizio' }).waitFor();

    // Il medico titolare conferma: la domanda, che nella cornice non si apre, è nella pagina.
    await login('medico');
    await go('/strumenti?sezione=conferme');
    const row = f
      .getByRole('table', { name: 'Utenti in attesa della conferma di un medico titolare' })
      .getByRole('row')
      .filter({ hasText: 'segreteria.prova' });
    await row.getByRole('button', { name: 'Conferma Segreteria di prova' }).click();
    const dialog = f.getByRole('alertdialog', { name: 'Conferma' });
    await dialog.waitFor();
    await expectAccessible('conferma nella pagina');
    await expectDemoTargets('#dimo-conferma', 'conferma nella pagina');
    await dialog.getByRole('button', { name: 'Conferma' }).click();
    await f.getByText('Password temporanea di Segreteria di prova').waitFor();
  });

  it('in tutto il giro nessun errore della pagina e del servizio', async () => {
    const serviceErrors = await f.evaluate(
      () => (window as Window & { __errori?: string[] }).__errori ?? [],
    );
    expect([...problems, ...serviceErrors]).toEqual([]);
  });
});
