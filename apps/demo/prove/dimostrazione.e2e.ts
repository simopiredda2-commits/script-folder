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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

/**
 * Un PDF piccolo e valido, con una pagina e un tratto: il visore lo deve disegnare davvero. Un
 * file che comincia con «%PDF» e basta il visore non lo apre (D232).
 */
function tinyPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Contents 4 0 R >>',
  ];
  const content = '2 w 20 20 m 180 100 l S';
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  offsets.push(pdf.length);
  pdf += `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Dopo `presses` volte Tab il fuoco è ancora dentro il riquadro modale (WCAG 2.4.3, D232). */
async function focusStaysIn(frame: Frame, selector: string, presses = 6) {
  for (let i = 0; i < presses; i++) {
    await frame.page().keyboard.press('Tab');
    const inside = await frame.evaluate((sel) => !!document.activeElement?.closest(sel), selector);
    expect(inside, `Tab ${i + 1}: il fuoco è uscito da ${selector}`).toBe(true);
  }
}

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
    await f.getByLabel('Nome utente', { exact: true }).waitFor({ timeout: 90_000 });
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

  // Una prova caduta a metà può lasciare aperti il visore o una conferma: coprirebbero le prove
  // seguenti, che cadrebbero tutte per lei. Si chiudono, senza nascondere la prima caduta.
  afterEach(async () => {
    if (!f) return;
    for (const close of [
      f.locator('#dimo-visore').getByRole('button', { name: 'Chiudi' }),
      f.locator('#dimo-conferma').getByRole('button', { name: 'Annulla' }),
    ])
      if (await close.count()) await close.click();
  });

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
   * Apre il riquadro della dimostrazione in uno stato noto (D241). Dopo un accesso il riquadro si
   * riduce da sé, entro un secondo: se è ancora aperto lo si riduce, poi lo si apre a mano, e
   * aperto a mano non si richiude da sé mentre lo si legge.
   */
  async function openPanel() {
    const opener = f.locator('button.dimo-apri');
    const panel = f.locator('#dimostrazione');
    if (!(await opener.count()))
      await panel
        .getByRole('button', { name: 'Riduci il riquadro della dimostrazione' })
        .click({ timeout: 5_000 })
        // Se intanto si è ridotto da sé, il pulsante non c'è più: va bene lo stesso.
        .catch(() => undefined);
    await opener.click();
    await panel.getByRole('heading', { level: 2, name: 'Dimostrazione' }).waitFor();
    return panel;
  }

  /**
   * Il codice del secondo fattore nel riquadro aperto, per questo utente e diverso da quello che ha
   * già usato (lo stesso codice non vale due volte).
   */
  async function codeFor(username: string) {
    await openPanel();
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
    const panel = await openPanel();
    const value = await read(panel);
    await panel.getByRole('button', { name: 'Riduci il riquadro della dimostrazione' }).click();
    await f.locator('button.dimo-apri').waitFor();
    return value;
  }

  /** L'accesso; `typed` è il nome utente come lo scrive chi prova, anche con le maiuscole. */
  async function login(username: string, typed = username) {
    // «Esci» sta nel menu che si apre col clic sul nome, in alto a destra (D244).
    const userMenu = f.locator('.utente-apri');
    if (await userMenu.count()) {
      await userMenu.click();
      await f.getByRole('button', { name: 'Esci', exact: true }).click();
      await f.getByLabel('Nome utente', { exact: true }).waitFor();
    }
    // Dopo l'accesso il programma torna alla pagina di prima: si riparte da «Oggi».
    await go('/');
    await f.getByLabel('Nome utente', { exact: true }).fill(typed);
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

  /**
   * Il pulsante ridotto della dimostrazione sta dentro il piede, a destra, e non copre né le
   * scritte del piede né il contenuto sopra (richiesta di Simone del 23/11/2026): sul computer,
   * sul tablet in orizzontale e in verticale, con la pagina in fondo.
   */
  async function expectPillClear(where: string) {
    const reduce = f
      .locator('#dimostrazione')
      .getByRole('button', { name: 'Riduci il riquadro della dimostrazione' });
    if (await reduce.count()) await reduce.click();
    await f.locator('button.dimo-apri').waitFor();
    // Il pulsante dice di chi è il codice (suggerimento S5 dell'audit, D259).
    await f
      .locator('button.dimo-apri')
      .getByText(/^codice per medico: \d{3} \d{3}$/)
      .waitFor();
    for (const v of [
      { width: 1280, height: 900 },
      { width: 1024, height: 768 },
      { width: 820, height: 1180 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(v);
      // Con la pagina in alto e a metà il pulsante non copre comandi del programma: dove la pagina
      // scorre, non le sta sopra (audit D259, «Aggiungi» coperto a 768×1024).
      for (const at of [0, 0.5]) {
        const under = await f.evaluate(async (at) => {
          const doc = document.scrollingElement!;
          scrollTo(0, (doc.scrollHeight - innerHeight) * at);
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const pill = document.querySelector('button.dimo-apri')!.getBoundingClientRect();
          // Di ogni comando conta la parte che si vede, tagliata dai riquadri che scorrono e dallo
          // schermo: un campo nascosto in fondo a un riquadro che scorre non è coperto (CI del
          // 24/11/2026, la scelta del promemoria sotto «In ricetta» a 1024×768).
          const seen = (e: Element) => {
            const r = e.getBoundingClientRect();
            let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
            for (
              let p = e.parentElement;
              p && p !== document.documentElement;
              p = p.parentElement
            ) {
              const s = getComputedStyle(p);
              if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
              const c = p.getBoundingClientRect();
              left = Math.max(left, c.left);
              top = Math.max(top, c.top);
              right = Math.min(right, c.right);
              bottom = Math.min(bottom, c.bottom);
            }
            return {
              left: Math.max(left, 0),
              top: Math.max(top, 0),
              right: Math.min(right, innerWidth),
              bottom: Math.min(bottom, innerHeight),
            };
          };
          return [...document.querySelectorAll('#root a, #root button, #root input, #root select')]
            .filter((e) => {
              const r = seen(e);
              return (
                r.right > r.left &&
                r.bottom > r.top &&
                r.left < pill.right &&
                r.right > pill.left &&
                r.top < pill.bottom &&
                r.bottom > pill.top
              );
            })
            .map((e) => (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 40));
        }, at);
        expect(under, `${where} a ${v.width}×${v.height}, pagina a ${at * 100}%`).toEqual([]);
      }
      const measure = () =>
        f.evaluate(async () => {
          scrollTo(0, document.scrollingElement!.scrollHeight);
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const pill = document.querySelector('button.dimo-apri')!.getBoundingClientRect();
          const footer = document.querySelector('.app-footer')!.getBoundingClientRect();
          const covered = [...document.querySelectorAll('.app-footer > *')]
            .map((e) => e.getBoundingClientRect())
            .filter(
              (r) =>
                r.left < pill.right &&
                r.right > pill.left &&
                r.top < pill.bottom &&
                r.bottom > pill.top,
            ).length;
          return {
            inside: pill.top >= footer.top - 0.5 && pill.bottom <= footer.bottom + 0.5,
            covered,
          };
        });
      // Dopo il cambio di misura la cornice può impaginare in ritardo (WebKit nella CI, 24/11/2026,
      // verde nell'altro giro dello stesso codice): si misura finché la pagina è ferma, al massimo
      // 5 secondi. Un pulsante davvero fuori dal piede resta fuori e la prova resta rossa.
      let m = await measure();
      for (const end = Date.now() + 5000; (!m.inside || m.covered > 0) && Date.now() < end;) {
        await page.waitForTimeout(200);
        m = await measure();
      }
      const at = `${where} a ${v.width}×${v.height}`;
      expect(m.inside, `${at}: il pulsante esce dal piede e copre il contenuto`).toBe(true);
      expect(m.covered, `${at}: il pulsante copre le scritte del piede`).toBe(0);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
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
    const revoked = text.match(/la revoca di (.+);/)![1]!;
    await login('medico');
    // La revoca annunciata c'è davvero: il paziente era in carico e ora è revocato (audit 28).
    expect(
      await f.evaluate(async (wanted) => {
        const list = (await (await fetch('/api/pazienti')).json()) as {
          pazienti: { nome: string; cognome: string; stato: string }[];
        };
        return list.pazienti.find((p) => `${p.nome} ${p.cognome}` === wanted)?.stato ?? null;
      }, revoked),
    ).toBe('revoked');

    const changes = f.getByRole('region', { name: 'Variazioni da AURA' });
    await changes.getByText(`AURA segnala il decesso di ${deceased}`, { exact: false }).waitFor();
    await changes.getByRole('link', { name: exemption }).first().waitFor();
    await changes
      .getByText(/ – Esenzione 013 .*\(nuova, /)
      .first()
      .waitFor();

    const news = f.getByRole('region', { name: 'Nuovi assistiti in AURA' });
    await news.getByRole('button', { name: `Registra ${newPatient}` }).click();
    await news.getByText(`${newPatient}: registrato con i dati di AURA.`).waitFor();

    // L'anagrafica diversa: l'ASL di AURA si usa con un clic, dai dati amministrativi.
    // Una sezione alla volta (D244): «#aura» apre quella di AURA.
    await go(`/pazienti/${await patientId(registry)}/amministrazione#aura`);
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

  // Dopo le credenziali dei servizi (accesso regionale e codice del Sistema TS): il certificato si
  // rimanda all'INPS.
  it('invii senza risposta: la ricetta arrivata con il promemoria; il certificato non arrivato, rimandato', async () => {
    const name = await fromPanel(async (p) => {
      const text = await p.getByRole('region', { name: 'Invii senza risposta' }).innerText();
      return /certificato di malattia di (.+), firmati da/.exec(text)![1]!;
    });
    // In Oggi il conto, che porta alla coda nella pagina Ricette: due ricette, una per la ricetta
    // rossa (D270).
    await go('/');
    await f.getByRole('link', { name: /^Invii senza risposta\s*2$/ }).click();
    const section = f.getByRole('region', { name: 'Invii senza risposta' });
    const group = section.locator('li.riquadro', {
      has: f.getByRole('link', { name, exact: true }),
    });
    const form = group.getByRole('form', { name: 'La ricetta è arrivata' });
    // Se il modulo non compare, l'errore dice che cosa mostra la sezione, che cosa risponde il
    // servizio e che ora è nella pagina (D234): con WebKit una volta non è comparso, senza dire
    // perché (D239). Nella #37 la sezione non c'era proprio: ora l'errore dice anche dove è la
    // pagina e che cosa mostra, per capire se il clic in Oggi non ha portato alla pagina Ricette
    // (D262).
    await form.waitFor({ timeout: 30_000 }).catch(async (err: unknown) => {
      const shown = await section
        .innerText({ timeout: 2_000 })
        .catch(() => '(sezione non trovata)');
      const answer = await f
        .evaluate(async () => {
          const res = await fetch('/api/ricette/senza-risposta');
          return `${res.status} ${await res.text()}`;
        })
        .catch((e: unknown) => String(e));
      const now = await f.evaluate(() => new Date().toISOString()).catch(() => '?');
      const where = await f.evaluate(() => location.pathname + location.hash).catch(() => '?');
      const page = await f
        .locator('main')
        .innerText({ timeout: 2_000 })
        .then((text) => text.slice(0, 600))
        .catch(() => '(pagina senza contenuto)');
      throw new Error(
        `Il modulo «La ricetta è arrivata» non è comparso per ${name}. Ora nella pagina: ${now}, indirizzo ${where}.\nLa sezione mostra:\n${shown}\nLa pagina mostra:\n${page}\nIl servizio risponde:\n${answer}`,
        { cause: err },
      );
    });
    await form.getByLabel(/Numero di ricetta/).fill('DIMO00000000001');
    await form.getByLabel(/Codice di autenticazione/).fill('DIMOAUT01');
    await form.getByRole('button', { name: /È arrivata/ }).click();
    // L'esito non si cambia dopo: si conferma prima di segnarlo (D239).
    await group
      .getByRole('group', { name: 'Conferma dell’esito' })
      .getByRole('button', { name: 'Sì, confermo' })
      .click();
    await section.getByText('Ricetta segnata come arrivata. NRE DIMO00000000001').waitFor();
    await section.getByRole('link', { name: 'Promemoria (PDF)' }).click();
    await viewer().locator('canvas').first().waitFor({ timeout: 30_000 });
    await closeViewer();

    await go(`/pazienti/${await patientId(name)}/certificati`);
    await f.getByRole('heading', { level: 1, name: 'Certificati di malattia' }).waitFor();
    await f.getByRole('button', { name: 'Non è arrivato: torna da inviare' }).click();
    await f
      .getByRole('group', { name: 'Conferma dell’esito' })
      .getByRole('button', { name: 'Sì, confermo' })
      .click();
    await f.getByText('Certificato di nuovo da inviare: si può rimandare all’INPS.').waitFor();
    const failed = f.locator('.scheda-certificato').filter({ hasText: /Non arrivato all’INPS/ });
    await failed.getByRole('button', { name: 'Riprova l’invio' }).click();
    const sent = f.locator('.scheda-certificato').filter({ hasText: 'Inviato' }).first();
    await sent.getByText(/protocollo SIM\d+/).waitFor({ timeout: 30_000 });
  });

  it('ricetta rossa (D270): dalla ricetta rimasta «in invio» al PDF sul modulo, poi in DPCM fino a «Accolta»', async () => {
    const name = await fromPanel(async (p) => {
      const text = await p.getByRole('region', { name: 'Invii senza risposta' }).innerText();
      return /Anche una ricetta di (.+) è rimasta/.exec(text)![1]!;
    });
    await go('/ricette#senza-risposta');
    const section = f.getByRole('region', { name: 'Invii senza risposta' });
    const group = section.locator('li.riquadro', {
      has: f.getByRole('link', { name, exact: true }),
    });
    await group.getByRole('button', { name: 'Stampa la ricetta rossa' }).click();
    await group.getByLabel(/Numero del modulo nella stampante/).fill('010260000000101');
    await group.getByRole('button', { name: 'Prepara la ricetta rossa' }).click();
    await group.getByText(/Ricetta rossa pronta sul modulo/).waitFor({ timeout: 30_000 });
    await expectAccessible('ricetta rossa pronta');
    await group.getByRole('link', { name: 'Stampa sul modulo (PDF)' }).click();
    await viewer().locator('canvas').first().waitFor({ timeout: 30_000 });
    await closeViewer();
    // La ricetta rossa si segue nella sua sezione: parte da sola; «Invia adesso» non aspetta il
    // giro della coda. Il SAR simulato risponde «in attesa» alla prima lettura dell'esito.
    const red = f.getByRole('region', { name: 'Ricette rosse in DPCM' });
    const item = red.locator('li.riquadro', { has: f.getByRole('link', { name, exact: true }) });
    await item.waitFor({ timeout: 30_000 });
    // Se non parte, l'errore dice che cosa mostra la sezione e che cosa risponde il servizio.
    const explain = async (err: unknown) => {
      const shown = await red.innerText({ timeout: 2_000 }).catch(() => '(sezione non trovata)');
      const answer = await f
        .evaluate(async () => {
          const res = await fetch('/api/ricette-rosse');
          return `${res.status} ${await res.text()}`;
        })
        .catch((e: unknown) => String(e));
      throw new Error(
        `La ricetta rossa di ${name} non è partita.\nLa sezione mostra:\n${shown}\nIl servizio risponde:\n${answer}`,
        { cause: err },
      );
    };
    // La parola dello stato, accanto al simbolo: la ricerca esatta ignora lo spazio fra i due.
    const sentOrAccepted = item
      .getByText('Mandata', { exact: true })
      .or(item.getByText('Accolta', { exact: true }));
    // Ogni «Invia adesso» legge l'esito una volta: la prima lettura dice «in attesa», la seconda
    // «accolta». Dopo il clic si aspetta la risposta: il pulsante torna attivo, o sparisce quando
    // non c'è più niente in corso.
    const sendNow = red.getByRole('button', { name: 'Invia adesso' });
    const accepted = item.getByText('Accolta', { exact: true });
    for (let i = 0; i < 6; i += 1) {
      await sentOrAccepted.first().waitFor({ timeout: 30_000 }).catch(explain);
      if ((await accepted.count()) || !(await sendNow.count())) break;
      await sendNow.click({ timeout: 10_000 });
      await f.waitForFunction(
        () => {
          const b = [...document.querySelectorAll('button')].find((x) =>
            x.textContent?.includes('Invia adesso'),
          );
          return !b || !b.disabled;
        },
        undefined,
        { timeout: 30_000 },
      );
    }
    await accepted.waitFor({ timeout: 30_000 }).catch(explain);
    await item.getByText('010260000000101').waitFor();
    await expectAccessible('ricette rosse in DPCM');
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
    // La riga è chiusa: nome e sintesi; i campi si aprono col clic (D242). La pagina sta in una
    // schermata: non scorre.
    const line = f.locator('.riga-ricetta').first();
    const opener = line.locator('.riga-ricetta-apri');
    await line.getByText('1 confezione · posologia non indicata').waitFor();
    expect(await opener.getAttribute('aria-expanded')).toBe('false');
    await opener.click();
    await line.getByLabel('Posologia').fill('1 compressa al giorno');
    await opener.click();
    await line.getByText('1 confezione · 1 compressa al giorno').waitFor();
    expect(
      await f.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight),
      'la pagina della ricetta scorre',
    ).toBe(true);
    await expectAccessible('nuova ricetta con la riga chiusa');
    await expectPillClear('nuova ricetta');
    await f.getByRole('button', { name: 'Salva in bozza' }).click();
    await f.getByRole('heading', { name: 'Controlli prima dell’invio' }).waitFor();
    await f.getByRole('button', { name: 'Firma e invia' }).click();
    await f
      .getByText(/Ricetta inviata/)
      .first()
      .waitFor({ timeout: 30_000 });
  });

  it('farmaci di classe A e H: la ricerca trova il ramipril; i farmaci prescritti hanno l’ultima ricetta già inviata (D256)', async () => {
    type Prescribed = { farmaci?: { ultimaPrescrizione: { altroProgramma: boolean } | null }[] };
    const id = await firstPatient(
      (id) => `/api/pazienti/${id}/farmaci-prescritti`,
      (b) =>
        !!(b as Prescribed | null)?.farmaci?.some(
          (d) => d.ultimaPrescrizione && !d.ultimaPrescrizione.altroProgramma,
        ),
    );
    expect(id, 'nessun paziente con una ricetta già inviata').not.toBeNull();
    await go(`/pazienti/${id}/ricetta`);
    const restart = f.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    // L'ultima ricetta, con la data, nella riga del farmaco prescritto (D245, D249).
    await f.locator('.farmaco-ultima-data').first().waitFor();
    // Un farmaco di classe A che le 13 confezioni d'esempio non avevano.
    await f.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('ramipril');
    await f
      .locator('.risultato')
      .filter({ hasText: /RAMIPRIL/i })
      .first()
      .waitFor();
    expect(
      await f
        .locator('.risultato')
        .filter({ hasText: /RAMIPRIL/i })
        .count(),
    ).toBeGreaterThan(1);
  });

  it('anagrafica AIFA intera (D261): l’alprazolam di classe C ferma la ricetta SSN con la R8; l’ibuprofene da banco', async () => {
    // Il riquadro dice che la banca dati è l'anagrafica intera, con due esempi da cercare.
    const hint = await fromPanel((panel) =>
      panel.getByRole('region', { name: 'Per entrare' }).innerText(),
    );
    expect(hint).toMatch(
      /La banca dati è l’anagrafica AIFA intera: anche classe C, come l’alprazolam/,
    );
    expect(hint).toMatch(/come l’ibuprofene da banco/);
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/ricetta`);
    const restart = f.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    const search = f.getByLabel('Farmaco, principio attivo, codice AIC o ATC');
    // Classe C con obbligo di ricetta: nelle liste A e H non c'è, e lo dice il regime dell'anagrafica.
    await search.fill('alprazolam');
    const found = f.locator('.risultato').filter({ hasText: /ALPRAZOLAM/i });
    await found.first().waitFor();
    expect(await found.count()).toBeGreaterThan(1);
    expect(await found.filter({ hasText: /\bclasse [AH]\b/ }).count()).toBe(0);
    await found
      .first()
      .getByText(/Medicinali soggetti a prescrizione medica/)
      .waitFor();
    await found.first().getByRole('button', { name: 'Aggiungi' }).click();
    await f.locator('.riga-ricetta').first().waitFor();
    // Il passo unico si ferma: l'informazione della R8 chiede di guardare, non blocca (D59, D256).
    await f.getByRole('button', { name: 'Firma e invia' }).click();
    await f
      .getByText(
        /: non è negli elenchi AIFA dei farmaci di classe A e H in vigore; la banca dati non dice se è a carico del SSN\. Se non lo è, si prescrive su ricetta bianca/,
      )
      .first()
      .waitFor({ timeout: 30_000 });
    await f.getByRole('button', { name: 'Ho visto i controlli: firma e invia' }).waitFor();
    // Senza obbligo di prescrizione, da banco: il regime con le parole dell'anagrafica AIFA.
    await go(`/banche-dati`);
    await f.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('ibuprofene');
    await f
      .locator('.risultato')
      .filter({ hasText: 'Medicinali non soggetti a prescrizione medica, da banco.' })
      .first()
      .waitFor();
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
    // Il catalogo regionale vero, D.D. 590/2026 con le modifiche della 710, da controllare (D260).
    const hint = await fromPanel((panel) =>
      panel.getByRole('region', { name: 'Specialistica' }).innerText(),
    );
    expect(hint).toMatch(/D\.D\. 590\/2026 con le modifiche della D\.D\. 710\/2026/);
    expect(hint).toMatch(/prima\s+che una persona abbia controllato la trascrizione/);
    const id = (await patients())[1]!.id;
    await go(`/pazienti/${id}/specialistica`);
    const restart = f.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    await f.getByLabel('Prestazione, branca o codice').fill('cardiologica controllo ecg');
    await f
      .locator('.risultato')
      .filter({ hasText: 'VISITA CARDIOLOGICA DI CONTROLLO CON ECG' })
      .first()
      .waitFor();
    await f.getByLabel('Prestazione, branca o codice').fill('visita');
    await f.locator('.risultato').first().getByRole('button', { name: 'Aggiungi' }).click();
    await f.getByLabel('Quesito diagnostico').fill('Quesito dimostrativo');
    // Ricetta del medico in un passo (D255): «Firma e invia» salva, controlla e invia.
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
      buffer: tinyPdf(),
    });
    await f.getByRole('button', { name: 'Registra', exact: true }).click();
    await f.getByText('Esecuzione registrata.').waitFor();
    await f
      .getByRole('link', { name: /Referto/ })
      .first()
      .click();
    // Il referto si vede davvero: una pagina disegnata, nessun errore del visore (D232).
    await viewer().locator('canvas').first().waitFor({ timeout: 30_000 });
    expect(
      await viewer()
        .getByText(/non si è aperto/)
        .count(),
    ).toBe(0);
    // Il fuoco resta nel visore: il resto della pagina non si raggiunge con Tab.
    await focusStaysIn(f, '#dimo-visore');
    await closeViewer();
  });

  it('prestazioni aggiuntive: registrata in cartella, con il compenso del catalogo', async () => {
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/prestazioni-aggiuntive`);
    await f.getByRole('heading', { level: 1, name: 'Prestazioni aggiuntive' }).waitFor();
    const today = new Date().toISOString().slice(0, 10);
    await f.getByLabel('Data dell’esecuzione').fill(today);
    const select = f.getByLabel('Prestazione', { exact: true });
    await select.selectOption({ index: 1 });
    // Il compenso della voce scelta, come lo dice il catalogo (D232).
    const option = await select.locator('option:checked').innerText();
    const [, compenso] = /(\d+,\d{2})\s*€/.exec(option) ?? [];
    expect(compenso, option).toBeTruthy();
    const auth = f.getByLabel(/^Estremi dell’autorizzazione/);
    if (await auth.evaluate((el) => (el as HTMLInputElement).required))
      await auth.fill('Autorizzazione dimostrativa n. 1');
    await f.getByRole('button', { name: 'Registra la prestazione' }).click();
    await f.getByText('Prestazione registrata.').waitFor();
    const registered = f.getByRole('heading', { name: 'Prestazioni registrate' }).locator('..');
    await registered
      .getByText(new RegExp(`^${compenso}\\s*€$`))
      .first()
      .waitFor();
  });

  it('presidi: la voce più lunga dell’allegato 2 si sceglie dal nomenclatore e si registra intera (D236)', async () => {
    const hint = await fromPanel((panel) =>
      panel.getByRole('region', { name: 'Presidi' }).innerText(),
    );
    expect(hint).toMatch(/prima che una persona abbia controllato la trascrizione/);
    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/presidi`);
    await f.getByRole('heading', { level: 1, name: 'Presidi e assistenza integrativa' }).waitFor();
    await f.getByLabel('Categoria').selectOption('monouso');
    const select = f.getByLabel('Dal nomenclatore (allegato 2)');
    // Prima che si contino, le voci devono essere arrivate dal servizio (D239).
    await select.locator('option', { hasText: '· 09.30.24.063' }).waitFor({ state: 'attached' });
    // 87 voci in 21 gruppi, più la voce «scrivi a mano».
    expect(await select.locator('optgroup').count()).toBe(21);
    expect(await select.locator('option').count()).toBe(88);
    const option = select.locator('option', { hasText: '· 09.30.24.063' });
    await select.selectOption(await option.getAttribute('value'));
    const product = f.getByLabel('Prodotto', { exact: true });
    const chosen = await product.inputValue();
    expect(chosen).toMatch(/^mutanda pannolone \(tipo pull-on \)/);
    expect(chosen).toHaveLength(401);
    expect(await f.getByLabel('Codice del nomenclatore').inputValue()).toBe('09.30.24.063');
    // La quantità dell'allegato, con l'intestazione della sua colonna (D237).
    expect(await f.getByText(/^Quantità nel nomenclatore/).innerText()).toBe(
      'Quantità nel nomenclatore: 120 («quantità massima erogabile»). Il fabbisogno lo decide il medico.',
    );
    await f.getByLabel('Fabbisogno al mese').fill('120');
    await f.getByLabel('Unità').fill('pezzi');
    await f.getByRole('button', { name: /Registra la prescrizione/ }).click();
    await f.getByText('Prescrizione registrata.').waitFor();
    // Nell'elenco il prodotto intero, con il codice.
    await f.getByRole('region', { name: 'Prescrizioni' }).getByText(chosen).first().waitFor();
  });

  it('medicazioni avanzate: il titolare sceglie l’alginato; poi si prescrive solo lì, con lo specialista (D237)', async () => {
    // Una sezione alla volta (D244): le medicazioni avanzate dal loro indirizzo.
    await go('/archivio?sezione=medicazioni');
    const section = f.getByRole('region', { name: 'Medicazioni avanzate' });
    await section.getByLabel(/cm 15 x 15 .* 04\.49\.03\.103/).check();
    await section.getByRole('button', { name: 'Salva le medicazioni avanzate' }).click();
    await section.getByText('Medicazioni avanzate salvate: 1.').waitFor();

    const id = (await patients())[0]!.id;
    await go(`/pazienti/${id}/presidi`);
    await f.getByRole('heading', { level: 1, name: 'Presidi e assistenza integrativa' }).waitFor();
    await f.getByLabel('Categoria').selectOption('monouso');
    const monouso = f.getByLabel('Dal nomenclatore (allegato 2)');
    await monouso.locator('option', { hasText: '· 09.30.24.063' }).waitFor({ state: 'attached' });
    // L'alginato 15 x 15 non è più fra i monouso: 86 voci, più «scrivi a mano».
    expect(await monouso.locator('option').count()).toBe(87);
    expect(await monouso.locator('option', { hasText: '· 04.49.03.103' }).count()).toBe(0);
    await f.getByLabel('Categoria').selectOption('medicazione_avanzata');
    const advanced = f.getByLabel('Dal nomenclatore (allegato 2)');
    await advanced.locator('option', { hasText: '· 04.49.03.103' }).waitFor({ state: 'attached' });
    expect(await advanced.locator('option').count()).toBe(2);
    await advanced.selectOption(
      await advanced.locator('option', { hasText: '· 04.49.03.103' }).getAttribute('value'),
    );
    await f.getByLabel('Fabbisogno al mese').fill('10');
    await f.getByLabel('Unità').fill('pezzi');
    // La regola delle medicazioni avanzate: la prima prescrizione dello specialista è obbligatoria.
    for (const label of ['Prima prescrizione: specialista', 'Prima prescrizione: data'])
      expect(await f.getByLabel(label).getAttribute('required'), label).not.toBeNull();
    const month = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    await f.getByLabel('Prima prescrizione: specialista').fill('Dr. Vulnologo di prova');
    await f.getByLabel('Prima prescrizione: data').fill(month);
    await f.getByRole('button', { name: /Registra la prescrizione/ }).click();
    await f.getByText('Prescrizione registrata.').waitFor();
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
    // Chi ha preparato e per chi: il medico firma proprio questa ricetta, non la prima della coda.
    const { secretary, name } = await f.evaluate(async (pid) => {
      const me = (await (await fetch('/api/io')).json()) as { nome: string };
      const p = (await (await fetch(`/api/pazienti/${pid}`)).json()) as {
        paziente: { firstName: string; lastName: string };
      };
      return { secretary: me.nome, name: `${p.paziente.firstName} ${p.paziente.lastName}` };
    }, id);
    // La segreteria la vede fra le ricette in attesa, in sola lettura (D242): firma e invio sono
    // del medico.
    await go('/ricette');
    await f.getByText(/Qui sotto le ricette in attesa/).waitFor();
    await f
      .locator('li.riquadro', { has: f.getByRole('link', { name, exact: true }) })
      .locator('li.ricetta-in-coda', { hasText: `preparata da ${secretary}` })
      .getByText('In attesa della firma del medico.')
      .first()
      .waitFor();
    expect(await f.getByRole('button', { name: 'Firma e invia' }).count()).toBe(0);
    await expectAccessible('ricette in attesa viste dalla segreteria');
    await login('medico');
    await go('/ricette');
    const group = f.locator('li.riquadro', { has: f.getByRole('link', { name, exact: true }) });
    await group
      .locator('li.ricetta-in-coda', { hasText: `preparata da ${secretary}` })
      .getByRole('button', { name: 'Firma e invia' })
      .click();
    await f
      .getByText(new RegExp(`^Ricetta inviata per ${name}\\.`))
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
    // Lo spostamento non si annulla: prima la domanda (audit D259).
    await changes.getByRole('button', { name: 'Sì, sposta' }).click();
    await changes.getByText(`${moving}: spostato nell’archivio di ${colleague}.`).waitFor();
    expect(await patientId(moving)).toBeNull();
    // La collega lo trova nel suo archivio.
    await login('collega');
    const id = await patientId(moving);
    expect(id).not.toBeNull();
    // Una prestazione aggiuntiva di ieri è del medico di prima: va nella sua distinta. Oggi, il
    // giorno dello spostamento, si sceglie (D240).
    await go(`/pazienti/${id!}/prestazioni-aggiuntive`);
    const day = f.getByLabel('Data dell’esecuzione');
    await day.waitFor();
    const today = await day.inputValue();
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await day.fill(yesterday);
    await f
      .getByText(/Va nella distinta dell’archivio «.+»: il .+ il paziente era nel suo archivio/)
      .waitFor();
    await day.fill(today);
    await f.getByRole('group', { name: /In quale distinta va\?/ }).waitFor();
  });

  it('cambio di medico: «Non spostare», e il paziente resta nell’archivio senza riproporsi', async () => {
    const { kept } = await doctorChanges();
    // La collega scelta lo vede in arrivo, finché il medico non decide.
    await login('collega');
    expect((await pendingChanges()).inArrivo).toContain(kept);
    await login('medico');
    const changes = f.getByRole('region', { name: 'Cambi di medico nello studio' });
    await changes.getByRole('button', { name: `Non spostare ${kept}` }).click();
    await changes.getByRole('button', { name: 'Sì, non spostare' }).click();
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
    await form.getByLabel('Nome utente', { exact: true }).fill('segreteria.prova');
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
    await focusStaysIn(f, '#dimo-conferma');
    await expectAccessible('conferma nella pagina');
    await expectDemoTargets('#dimo-conferma', 'conferma nella pagina');
    await dialog.getByRole('button', { name: 'Conferma' }).click();
    await f.getByText('Password temporanea di Segreteria di prova').waitFor();
  });

  it('il nome utente scritto con le maiuscole: il riquadro dà il codice di quell’utente (D232)', async () => {
    // Prima l'accesso con il nome com'è, quando il riquadro impara il segreto dell'app; poi con le
    // maiuscole, e il codice c'è ancora. Così la prova non dipende da quelle di prima.
    await login('medico');
    await login('medico', 'Medico');
    // Il codice si annuncia quando cambia; il conto alla rovescia di ogni secondo no. Si legge con
    // il riquadro aperto: ridotto, non ci sarebbe niente da leggere (D239).
    const live = (await fromPanel((p) => p.locator('[aria-live]').allInnerTexts())).join(' ');
    expect(live).toMatch(/Codice per medico:/);
    expect(live).not.toMatch(/Cambia fra/);
  });

  it('un documento del servizio che non arriva: il visore lo dice, senza errori non gestiti (D232)', async () => {
    const before = problems.length;
    // Il servizio nel browser che non risponde, solo per questo indirizzo; poi si rimette com'era.
    await f.evaluate(() => {
      const w = window as Window & { __fetchDiPrima?: typeof fetch };
      const original = window.fetch.bind(window);
      w.__fetchDiPrima = original;
      window.fetch = (input, init) =>
        (input instanceof Request ? input.url : String(input)).includes('/api/documento-assente')
          ? Promise.reject(new TypeError('il servizio non risponde'))
          : original(input, init);
      const a = document.createElement('a');
      a.id = 'dimo-prova-documento';
      a.href = '/api/documento-assente';
      a.textContent = 'Documento di prova';
      document.body.append(a);
    });
    try {
      await f.locator('#dimo-prova-documento').click();
      await viewer()
        .getByText('Il documento non si è aperto: il servizio non risponde')
        .waitFor({ timeout: 10_000 });
      await closeViewer();
    } finally {
      await f.evaluate(() => {
        const w = window as Window & { __fetchDiPrima?: typeof fetch };
        if (w.__fetchDiPrima) window.fetch = w.__fetchDiPrima;
        document.getElementById('dimo-prova-documento')?.remove();
      });
    }
    expect(problems.slice(before)).toEqual([]);
  });

  it('in tutto il giro nessun errore della pagina e del servizio', async () => {
    const serviceErrors = await f.evaluate(
      () => (window as Window & { __errori?: string[] }).__errori ?? [],
    );
    expect([...problems, ...serviceErrors]).toEqual([]);
  });

  it('«Ricomincia da capo» da una pagina interna: la dimostrazione riparte (D232)', async () => {
    const before = problems.length;
    await go('/archivio/riepiloghi');
    await openPanel();
    await f.getByRole('button', { name: 'Ricomincia da capo' }).click();
    // Se non riparte, la prova dice che cosa mostra la pagina, con il tempo del primo avvio per
    // confronto: con WebKit è caduta una volta su main dicendo solo che l'attesa era scaduta (prove
    // su GitHub del 21/11/2026, giro 353; D234).
    await f
      .getByLabel('Nome utente', { exact: true })
      .waitFor({ timeout: 90_000 })
      .catch(async (err: unknown) => {
        const shown = await f
          .locator('body')
          .innerText()
          .catch(() => '(pagina non leggibile)');
        throw new Error(
          `La dimostrazione non è ripartita in 90 s (il primo avvio: ${startMs} ms). La pagina mostra: «${shown.replace(/\s+/g, ' ').slice(0, 400)}». Problemi: ${problems.slice(before).join(' | ') || 'nessuno'}`,
          { cause: err },
        );
      });
    expect(await f.getByText('La dimostrazione non è partita in questo browser.').count()).toBe(0);
    expect(problems.slice(before)).toEqual([]);
  });
});
