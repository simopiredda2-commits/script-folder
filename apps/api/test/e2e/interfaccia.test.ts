/**
 * Prova dell'interfaccia vera nel browser: build di apps/web, servizio con un database di prova,
 * accesso con password e secondo fattore, le schermate della tappa 6, accessibilità (axe-core,
 * WCAG 2.2 AA), bersagli di almeno 44 px, impaginazione su tablet. Nessun sito esterno.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePatients } from '@mmg/fixtures';
import { SimulatedAura } from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountLock,
  appointment,
  clinicalEntry,
  doctorProfile,
  labResultDetail,
  measurementDetail,
  patient,
  therapy,
} from '../../src/db/schema';
import { withActor } from '../../src/db/tx';
import { startOfStudioDay } from '../../src/http/today-routes';
import { studioDate } from '../../src/prescriptions/rules-check';
import {
  EXAMPLE_TRANSCRIPTIONS,
  EXAMPLES_DIR,
  exampleSourcesSync,
  runSyncOnExample,
  serveExampleSite,
} from '../../src/reference/example-site';
import { importReferenceData } from '../../src/reference/importer';
import { ReferenceUpdates, sourceNamesOf } from '../../src/reference/updates-service';
import { base32Decode } from '../../src/security/base32';
import { totp } from '../../src/security/totp';
import { createScenario, PASSWORD, type Scenario } from '../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { buildWeb, serveWeb } from './serve-web';
import { studioDayFrom } from '../helpers/dates';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf-8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MIN_TARGET = 44;
const TABLETS = [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];

/**
 * Motore del browser (D155): Chromium (Chrome, Edge) di solito; in CI anche WebKit, il motore di
 * Safari su Mac e iPad, e Firefox. Si sceglie con E2E_BROWSER.
 */
const ENGINES = { chromium, webkit, firefox };
const ENGINE = process.env.E2E_BROWSER ?? 'chromium';
function engineOf(name: string) {
  if (!Object.hasOwn(ENGINES, name)) {
    throw new Error(`E2E_BROWSER=${name}: motore sconosciuto (${Object.keys(ENGINES).join(', ')})`);
  }
  return ENGINES[name as keyof typeof ENGINES];
}
// Un nome sbagliato ferma subito la prova, invece di farla girare con un altro motore.
const engine = engineOf(ENGINE);
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
  let firstName: string;
  let newTherapyUrl: string;
  /** AURA simulata (D197): l'anagrafe con cui la prova allinea il paziente di esempio. */
  const aura = new SimulatedAura();

  /** Codice a 6 cifre: ogni accesso usa l'intervallo di 30 secondi successivo. */
  const nextCode = (secret: string) => {
    s.clock.advance(30_000);
    return totp(base32Decode(secret.replace(/\s/g, '')), s.clock.now().getTime());
  };

  async function loginInBrowser(
    p: Page,
    who: 'titolare' | 'collega' | 'segreteria' | 'amministratore',
  ) {
    await p.goto(base);
    await p.getByLabel('Nome utente').fill(s.users[who].username);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByLabel('Postazione').fill(`browser-${who}`);
    await p.getByRole('button', { name: 'Continua' }).click();
    // Al primo accesso si attiva il secondo fattore; ai successivi basta il codice.
    const known = s.secrets.get(s.users[who].id);
    if (known) {
      s.clock.advance(30_000);
      await p.getByLabel('Codice a 6 cifre').fill(totp(known, s.clock.now().getTime()));
    } else {
      const secret = await p.locator('.segreto').innerText();
      s.secrets.set(s.users[who].id, base32Decode(secret.replace(/\s/g, '')));
      await p.getByLabel('Codice a 6 cifre').fill(nextCode(secret));
    }
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
          // Le tabelle larghe e la barra delle cartelle aperte scorrono nel loro riquadro.
          .filter((el) => !el.closest('.tabella-scorrevole, .schede-aperte'))
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

  /**
   * page.goto che aspetta la pagina nuova. Con WebKit, tornando all'indirizzo dove la prova
   * precedente era finita, «la stessa prestazione già prescritta» è caduta una volta (CI su main,
   * giro 170): il campo di ricerca restava bloccato dalla ricetta ricordata, come se «Nuova ricetta
   * da capo» fosse stato cercato nella pagina di prima o in quella nuova ancora vuota. Causa
   * probabile, non provata (qui WebKit non c'è): page.goto che risponde prima che la pagina nuova
   * prenda il posto di quella di prima, come in un difetto segnalato a Playwright per WebKit. La
   * pagina di prima porta un segno; si va avanti quando il segno non c'è più.
   */
  async function gotoNewPage(p: Page, url: string) {
    await p.evaluate(() => {
      (window as Window & { paginaDiPrima?: boolean }).paginaDiPrima = true;
    });
    await p.goto(url);
    await p.waitForFunction(() => !(window as Window & { paginaDiPrima?: boolean }).paginaDiPrima);
  }

  /**
   * L'editor della ricetta da capo. La ricetta inviata in una prova precedente è ricordata (D68):
   * si apre la pagina nuova, si ricomincia se serve e si aspetta che il campo di ricerca sia libero.
   */
  async function freshPrescription(p: Page, url: string, title: string, search: string) {
    await gotoNewPage(p, url);
    await p.getByRole('heading', { level: 1, name: title }).waitFor();
    const restart = p.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    await expect
      .poll(() => p.getByLabel(search).isEnabled(), {
        timeout: 5000,
        message: `${title}: il campo di ricerca resta bloccato dalla ricetta ricordata`,
      })
      .toBe(true);
  }

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
        mappings: loadMappings(),
        importedBy: 'prova',
      });
    } finally {
      await site.close();
    }
    // Aggiornamento delle banche dati (D156) sul sito d'esempio, ogni notte alle 03:30.
    let updates!: ReferenceUpdates;
    s = await createScenario(
      t.db,
      {},
      {
        aura: { gateway: aura },
        referenceUpdates: (now) => {
          updates = new ReferenceUpdates(
            t.db,
            {
              dataDir: join(work, 'aggiornamenti'),
              transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
              mappings: loadMappings(),
              sync: exampleSourcesSync(),
            },
            {
              time: '03:30',
              now,
              sourceNames: sourceNamesOf(join(EXAMPLES_DIR, 'fonti-prova.json')),
            },
          );
          return updates;
        },
      },
    );
    // Il giro di stanotte c'è stato: le versioni in uso hanno la loro fonte controllata.
    expect((await (await updates.start('automatico', 'orologio del servizio')).done).outcome).toBe(
      'ok',
    );
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    lastName = rich!.lastName;
    firstName = rich!.firstName;
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
    const dist = buildWeb(join(work, 'dist'));
    web = await serveWeb(dist, apiPort);
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    browser = await engine.launch();
    // Il motore avviato è quello chiesto: una prova su WebKit non deve girare su Chromium.
    expect(browser.browserType().name()).toBe(ENGINE);
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
    for (const label of ['Oggi', 'Pazienti', 'Ricette', 'Farmaci e prestazioni', 'Archivio']) {
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
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
    await page.locator('.risultato').filter({ hasText: 'TEVA ITALIA' }).waitFor();
    await page.getByText('Banche dati dei farmaci in uso').waitFor();
    await check(page, 'nuova ricetta con risultati', true);
    await page
      .locator('.risultato')
      .filter({ hasText: 'TEVA ITALIA' })
      .getByRole('button', { name: 'Aggiungi' })
      .click();
    await page
      .locator('.riga-ricetta')
      .filter({ hasText: 'TEVA ITALIA' })
      .getByLabel('Confezioni')
      .fill('1');
    // Anche la terapia in corso: la ricetta inviata finisce nel suo storico (D65).
    await page
      .locator('.risultato')
      .filter({ hasText: 'Farmaco di prova 5 mg' })
      .getByRole('button', { name: 'Aggiungi' })
      .click();
    await page.locator('.riga-ricetta').filter({ hasText: 'Farmaco di prova 5 mg' }).waitFor();
    await page.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await page.getByRole('heading', { name: 'Controlli prima dell’invio' }).waitFor();
    await page.getByText(/Regole di prescrizione, versione/).waitFor();
    await check(page, 'ricetta con i controlli');
    await page.getByRole('button', { name: 'Firma e invia' }).click();
    await page.getByText('Ricetta inviata').waitFor();
  });

  it('promemoria dopo l’invio: PDF del modello, solo NRE, email al paziente (tappa 7)', async () => {
    // Lo stesso indirizzo dove la prova di prima ha appena inviato la ricetta.
    await gotoNewPage(page, `${base}/pazienti/${s.richPatient}/ricetta`);
    const panel = page.getByRole('region', { name: 'Promemoria della ricetta' });
    await panel.waitFor();
    const href = await panel.getByRole('link', { name: 'Promemoria (PDF)' }).getAttribute('href');
    const pdf = await page.request.get(`${base}${href}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await page.request.get(`${base}${href}?formato=nre`)).status()).toBe(200);
    await panel.getByRole('button', { name: 'Invia' }).click();
    await panel.getByText(/Promemoria inviato per email a /).waitFor();
    await panel.getByText(/Consegne \(\d+\)/).click();
    await panel.getByText(/Email a .* · consegnato/).waitFor();
    await check(page, 'promemoria dopo l’invio', true);
  });

  it('nell’editor: oscuramento per le SSN, ripetibilità per la ricetta bianca (tappa 7)', async () => {
    // Di nuovo lo stesso indirizzo: la ricetta inviata è ancora ricordata.
    await gotoNewPage(page, `${base}/pazienti/${s.richPatient}/ricetta`);
    await page.getByRole('heading', { level: 1, name: 'Nuova ricetta' }).waitFor();
    await page.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ }).click();
    await page.getByLabel(/Oscura nome e indirizzo/).waitFor();
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
    const item = page.locator('.risultato').filter({ hasText: 'TEVA ITALIA' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Aggiungi' }).click();
    await page.getByLabel('Bianca (a carico del paziente)').check();
    await expect(page.getByLabel(/Oscura nome e indirizzo/).count()).resolves.toBe(0);
    await page.getByLabel('Ripetibile (volte)').fill('2');
    await page.getByLabel('Validità (mesi)').fill('6');
    await check(page, 'ricetta bianca ripetibile', true);
    await page.getByRole('button', { name: 'Ricomincia' }).click();
  });

  it('scheda della terapia con lo storico delle prescrizioni (D65)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/terapie/${therapyId}`);
    await page.getByRole('heading', { name: 'Storico delle prescrizioni' }).waitFor();
    // La ricetta appena inviata ha lo stesso principio attivo: è nello storico, con l'NRE.
    await page.locator('table').getByText(/NRE/).first().waitFor();
    await check(page, 'scheda della terapia', true);
    // D70: si verifica lo stato presso l'ente e, se non è ancora lavorata, si annulla.
    await page.getByRole('button', { name: 'Verifica lo stato presso l’ente' }).first().click();
    await page.getByText('Presso l’ente: Non ancora presa in carico.').waitFor();
    await page.getByLabel('Motivo dell’annullamento').first().fill('Prescritta per errore');
    await page.getByRole('button', { name: 'Annulla la ricetta' }).first().click();
    // La ricetta resta nello storico, marcata come annullata, con chi e perché.
    await page
      .locator('tr.riga-annullata')
      .getByText(/Annullata il .* da /)
      .first()
      .waitFor();
    await page.locator('tr.riga-annullata').getByText('Prescritta per errore').first().waitFor();
    await check(page, 'storico con una ricetta annullata');
  });

  it('ricetta specialistica dal catalogo, poi lo storico della prestazione (D66)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/specialistica`);
    // D153: parole in qualunque ordine; nel risultato i due codici della ricetta.
    await page.getByLabel('Prestazione, branca o codice').fill('prova esame');
    await page.locator('.risultato').filter({ hasText: 'Esame di prova' }).waitFor();
    await page.getByLabel('Prestazione, branca o codice').fill('visita');
    await page.locator('.risultato').filter({ hasText: 'Visita di prova' }).waitFor();
    await page
      .locator('.risultato')
      .filter({ hasText: 'Visita di prova' })
      .getByText('Catalogo 89.7 · nomenclatore (DM) 89.7')
      .waitFor();
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

  it('farmaci prescritti con i colori e la legenda; visite ed esami nei loro menu (D152)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    // La legenda è sempre nello stesso punto: subito sotto «Terapia in corso».
    await expect(page.locator('#titolo-terapia + .legenda-colori').count()).resolves.toBe(1);
    const chronic = page.locator('li.farmaco-cronica').filter({ hasText: 'Farmaco di prova 5 mg' });
    await chronic.first().waitFor();
    // Il colore viene davvero dai token: sfondo azzurro e barra blu, con la parola «Cronica».
    await expect(
      chronic.first().evaluate((el) => {
        const css = getComputedStyle(el);
        return [css.backgroundColor, css.borderLeftColor];
      }),
    ).resolves.toEqual(['rgb(211, 232, 250)', 'rgb(31, 111, 178)']);
    await chronic.first().getByText('Cronica', { exact: true }).waitFor();

    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Farmaci prescritti' })
      .click();
    await page.getByRole('heading', { name: 'Farmaci prescritti', level: 1 }).waitFor();
    await page.getByText('Legenda dei colori').waitFor();
    const occasional = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Prescritti senza terapia in cartella' }) });
    const amlodipine = occasional
      .locator('li.farmaco-non-in-corso')
      .filter({ hasText: /AMLODIPINA/ });
    await amlodipine.first().waitFor();
    await amlodipine
      .first()
      .getByText(/inviate o su carta/)
      .waitFor();
    await check(page, 'farmaci prescritti', true);
    await amlodipine.first().getByRole('link', { name: 'Storico' }).click();
    await page.getByRole('heading', { name: 'Storico delle prescrizioni' }).waitFor();
    await page.locator('table').getByText(/NRE/).first().waitFor();
    await check(page, 'storico di un farmaco senza terapia');

    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Visite ed esami prescritti' })
      .click();
    await page.getByRole('heading', { name: 'Visite ed esami prescritti', level: 1 }).waitFor();
    const visits = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Visite', exact: true }) });
    await visits.getByRole('link', { name: 'Visita di prova' }).waitFor();
    await check(page, 'visite ed esami prescritti', true);
  });

  it('prestazione non ancora nel catalogo, scritta a mano: avviso R18 con il motivo, poi inviata (D154)', async () => {
    // L'editor ricorda la ricetta appena inviata: se ne comincia una nuova.
    await freshPrescription(
      page,
      `${base}/pazienti/${s.richPatient}/specialistica`,
      'Ricetta specialistica',
      'Prestazione, branca o codice',
    );
    await page
      .getByRole('button', { name: 'Prestazione non ancora nel catalogo: scrivila a mano' })
      .click();
    await page.getByLabel('Codice del catalogo regionale').fill('NUOVO.1');
    await page.getByLabel('Codice del nomenclatore (DM)').fill('99.99.1');
    await page
      .getByLabel('Descrizione, come nel catalogo della Regione')
      .fill('PRESTAZIONE NUOVA DI PROVA');
    await check(page, 'prestazione scritta a mano');
    await page.getByRole('button', { name: 'Aggiungi in ricetta' }).click();
    await page
      .locator('.riga-ricetta')
      .filter({ hasText: 'PRESTAZIONE NUOVA DI PROVA' })
      .getByText('Catalogo NUOVO.1 · nomenclatore (DM) 99.99.1')
      .waitFor();
    await page.getByLabel('Quesito diagnostico').fill('Quesito di prova');
    await page.getByRole('button', { name: 'Prepara la ricetta' }).click();
    await page
      .getByLabel('Motivo per procedere nonostante l’avviso R18')
      .fill('Codice nuovo, il catalogo del programma non è ancora aggiornato');
    await page.getByRole('button', { name: 'Firma e invia' }).click();
    await page.getByText('Ricetta inviata').waitFor();
  });

  it('la stessa prestazione già prescritta: l’editor lo dice subito, con data e NRE', async () => {
    // Lo stesso indirizzo dove la prova di prima ha appena inviato la ricetta.
    await freshPrescription(
      page,
      `${base}/pazienti/${s.richPatient}/specialistica`,
      'Ricetta specialistica',
      'Prestazione, branca o codice',
    );
    await page.getByLabel('Prestazione, branca o codice').fill('visita');
    const item = page.locator('.risultato').filter({ hasText: 'Visita di prova' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Aggiungi' }).click();
    await page.getByText(/Già prescritta.*il \d{2}\/\d{2}\/\d{4}/).waitFor();
    await page.getByRole('link', { name: 'storico della prestazione' }).waitFor();
    await check(page, 'avviso di prestazione già prescritta');
  });

  it('esami: valori e intervallo del referto, senza giudizio', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/esami`);
    await page.getByRole('cell', { name: '7,1 %' }).waitFor();
    expect(await page.locator('main').innerText()).not.toMatch(/\bsopra\b|\bsotto\b/i);
    await check(page, 'esami', true);
  });

  it('ricerca farmaci con filtri, equivalenti e data della banca dati (A6)', async () => {
    await page.goto(`${base}/banche-dati`);
    await page
      .getByLabel('Nome commerciale, principio attivo, codice AIC o ATC')
      .fill('amlodipina');
    await page.locator('.risultato').first().waitFor();
    await page
      .locator('.risultato')
      .filter({ hasText: 'DOC GENERICI' })
      .getByRole('button', { name: 'Mostra gli equivalenti' })
      .click();
    await page.getByRole('table').waitFor();
    // La ditta di ogni generico, nella tabella degli equivalenti (D151).
    await page.getByRole('columnheader', { name: 'Ditta' }).waitFor();
    await page.getByRole('cell', { name: 'EG S.P.A.' }).waitFor();
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
      // La segreteria non scrive le terapie e non ha un archivio suo.
      await expect(sec.getByRole('link', { name: 'Nuova terapia' }).count()).resolves.toBe(0);
      // Degli strumenti dello studio solo gli elenchi, in sola lettura (D175): niente modelli,
      // impaginazione né Fascicolo.
      await sec
        .getByRole('navigation', { name: 'Sezioni' })
        .getByRole('link', { name: 'Strumenti' })
        .click();
      await sec.getByRole('heading', { level: 2, name: 'Elenchi dello studio' }).waitFor();
      await expect(
        sec
          .getByRole('group', { name: 'Sezione degli strumenti' })
          .getByRole('button')
          .allInnerTexts(),
      ).resolves.toEqual(['Elenchi dello studio']);
      await sec.getByText('qui si consultano', { exact: false }).waitFor();
      await expect(sec.getByRole('button', { name: 'Aggiungi all’elenco' }).count()).resolves.toBe(
        0,
      );
      await check(sec, 'elenchi dello studio, segreteria');
      await expect(
        sec
          .getByRole('navigation', { name: 'Sezioni' })
          .getByRole('link', { name: 'Archivio' })
          .count(),
      ).resolves.toBe(0);
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

  it('più cartelle aperte insieme (D68): schede, ritorno alla pagina lasciata, ricetta ricordata', async () => {
    const otherId = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const [other] = await t.db.select().from(patient).where(eq(patient.id, otherId));
    // Ricetta in corso per il primo paziente, non ancora preparata.
    await freshPrescription(
      page,
      `${base}/pazienti/${s.richPatient}/ricetta`,
      'Nuova ricetta',
      'Farmaco, principio attivo, codice AIC o ATC',
    );
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
    const item = page.locator('.risultato').filter({ hasText: 'NORVASC' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Aggiungi' }).click();
    // Il secondo paziente: la sua cartella diventa quella attiva.
    await page.goto(`${base}/pazienti/${otherId}`);
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    const bar = page.getByRole('navigation', { name: 'Cartelle aperte' });
    await expect(bar.locator('a[aria-current="page"]').innerText()).resolves.toContain(
      other!.lastName,
    );
    await check(page, 'cartelle aperte', true);
    // Dalla scheda si torna alla ricetta lasciata a metà, con la riga ancora lì.
    // Etichetta esatta: cognome e nome all'inizio. I nomi inventati cambiano a ogni giro e un
    // altro paziente può avere lo stesso nome come cognome (o viceversa).
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await bar
      .getByRole('link', {
        name: new RegExp(`^${escape(lastName)} ${escape(firstName)}(?![\\p{L}'])`, 'u'),
      })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Nuova ricetta' }).waitFor();
    await page.locator('.riga-ricetta').filter({ hasText: 'NORVASC' }).waitFor();
    // Chiudere una scheda non tocca le altre.
    await bar
      .getByRole('button', { name: `Chiudi la cartella di ${other!.lastName} ${other!.firstName}` })
      .click();
    await expect(bar.getByRole('link').count()).resolves.toBe(1);
  });

  it('nuova terapia dalla banca dati: controlli della scheda, lettura per il paziente, unità al giorno (D80)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('link', { name: 'Nuova terapia' }).click();
    await page.getByRole('heading', { level: 1, name: 'Nuova terapia' }).waitFor();
    // Senza farmaco la scheda non si salva, e lo dice.
    await page.getByRole('button', { name: 'Salva la scheda' }).click();
    await page.getByText('La scheda non si può salvare:').waitFor();
    await page
      .getByText('Scegli un farmaco dalla banca dati o scrivine il nome.')
      .first()
      .waitFor();
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
    const item = page.locator('.risultato').filter({ hasText: 'AMLODIPINA EG' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Scegli' }).click();
    await page.getByRole('button', { name: 'Cambia farmaco' }).waitFor();
    await page.getByLabel('Dose', { exact: true }).fill('1');
    await page.getByLabel('Unità', { exact: true }).selectOption('compressa');
    await page.getByLabel('Frequenza').selectOption('2 volte al giorno');
    await page.getByLabel('Momento').selectOption('la sera');
    await page.getByLabel('Via', { exact: true }).selectOption('per bocca');
    await page.getByText('1 compressa due volte al giorno, la sera, per bocca').waitFor();
    await expect(
      page.getByLabel('Unità al giorno, per il contatore (R11)').inputValue(),
    ).resolves.toBe('2');
    await page.getByLabel('Istruzioni per il paziente').fill('Dopo cena.');
    // Non sostituibile senza motivazione: R13, vicino al campo.
    await page.getByLabel(/Non sostituibile/).check();
    await page.getByRole('button', { name: 'Salva la scheda' }).click();
    await page
      .getByText('Non sostituibile: serve una sintetica motivazione (R13).')
      .first()
      .waitFor();
    await check(page, 'nuova terapia con gli errori', true);
    await page.getByLabel(/Non sostituibile/).uncheck();
    await page.getByRole('button', { name: 'Salva la scheda' }).click();
    await page.getByText('Terapia aggiunta.').waitFor();
    await page.getByRole('heading', { level: 1, name: /AMLODIPINA EG 5 MG/ }).waitFor();
    newTherapyUrl = page.url();
    await check(page, 'scheda della terapia nuova', true);
  });

  it('modifica della scheda: unità al giorno corrette a mano, poi salvate', async () => {
    await page.goto(newTherapyUrl);
    await page.getByRole('link', { name: 'Modifica', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: /Modifica: AMLODIPINA EG/ }).waitFor();
    await page.getByLabel('Dose', { exact: true }).fill('1/2');
    await expect(
      page.getByLabel('Unità al giorno, per il contatore (R11)').inputValue(),
    ).resolves.toBe('1');
    await page.getByLabel('Unità al giorno, per il contatore (R11)').fill('0,75');
    await page.getByText(/Corretta a mano; dal calcolo verrebbe 1/).waitFor();
    await check(page, 'modifica della terapia', true);
    await page.getByRole('button', { name: 'Salva la scheda' }).click();
    await page.getByText('Scheda della terapia salvata.').waitFor();
    await page.locator('.dati').getByText('0,75').waitFor();
  });

  it('sospensione per reazione avversa: la reazione va in testata; poi si riprende (D81)', async () => {
    await page.goto(newTherapyUrl);
    await page.getByRole('button', { name: 'Sospendi…' }).click();
    await page.getByRole('heading', { name: 'Sospendi la terapia' }).waitFor();
    await page.getByRole('button', { name: 'Sospendi la terapia' }).click();
    await page.getByText('Scrivi il motivo della sospensione.').waitFor();
    await page.getByLabel('Motivo della sospensione').fill('Reazione cutanea di prova');
    await page.getByLabel(/È una reazione avversa/).check();
    await page.getByLabel('Reazione osservata (facoltativa)').fill('Eritema di prova');
    await page.getByText(/farmacovigilanza: da completare/).waitFor();
    await check(page, 'sospensione della terapia');
    await page.getByRole('button', { name: 'Sospendi la terapia' }).click();
    await page
      .getByText(/Terapia sospesa\. La reazione a AMLODIPINA BESILATO è ora tra le allergie/)
      .waitFor();
    await page.locator('.testata-avvisi').getByText('Allergia: AMLODIPINA BESILATO').waitFor();
    await page.getByText(/Motivo: Reazione cutanea di prova/).waitFor();
    await check(page, 'terapia sospesa', true);
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('heading', { name: 'Terapie sospese' }).waitFor();
    await page.getByRole('link', { name: /AMLODIPINA EG 5 MG/ }).click();
    await page.getByRole('button', { name: 'Riprendi' }).click();
    await page.getByText('Terapia ripresa: è di nuovo tra quelle in corso.').waitFor();
  });

  it('schema orario stampabile: momenti della giornata, fino a quando, istruzioni', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/schema-orario`);
    await page.getByRole('heading', { name: 'Schema orario della terapia' }).waitFor();
    const evening = page.getByRole('region', { name: 'Sera' });
    await evening.getByText(/AMLODIPINA EG/).waitFor();
    await evening.getByText('Dopo cena.').waitFor();
    // La terapia riservata resta fuori finché il medico non la include.
    await expect(page.getByText('Farmaco riservato di prova').count()).resolves.toBe(0);
    await page.getByLabel(/Includi le terapie riservate/).check();
    await page.getByText('Farmaco riservato di prova').waitFor();
    await check(page, 'schema orario', true);
    // Su carta restano solo il foglio e le sue tabelle.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.app-header').isVisible()).resolves.toBe(false);
    await expect(page.locator('.no-stampa').isVisible()).resolves.toBe(false);
    await expect(page.locator('.foglio-schema').isVisible()).resolves.toBe(true);
    await page.emulateMedia({ media: 'screen' });
  });

  it('anagrafica: si correggono i recapiti dalla cartella, con l’errore spiegato', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('button', { name: 'Modifica i recapiti' }).click();
    await page.getByLabel('Telefono').fill('011 000 0000');
    await page.getByLabel('Email', { exact: true }).fill('non-una-email');
    await check(page, 'modifica dei recapiti', true);
    await page.getByRole('button', { name: 'Salva i recapiti' }).click();
    await page.getByText(/^Email:/).waitFor();
    await page.getByLabel('Email', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Salva i recapiti' }).click();
    await page.getByText('Recapiti salvati.').waitFor();
    await page.locator('.dati').getByText('011 000 0000').waitFor();
  });

  it('archivio del titolare: che cosa vede la segreteria ed esportazione completa (D84)', async () => {
    await page.goto(base);
    await page
      .getByRole('navigation', { name: 'Sezioni' })
      .getByRole('link', { name: 'Archivio' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Archivio' }).waitFor();
    // Pagina corta: la barra delle cartelle aperte resta alta quanto le sue schede.
    const bar = await page
      .locator('.schede-aperte-contenitore')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(bar).toBeLessThan(120);
    const summary = page.getByLabel(/La segreteria legge il riepilogo clinico/);
    await expect(summary.isChecked()).resolves.toBe(false);
    await summary.check();
    await page.getByText('La segreteria legge il riepilogo clinico: acceso.').waitFor();
    await summary.uncheck();
    await page.getByText('La segreteria legge il riepilogo clinico: spento.').waitFor();
    await check(page, 'archivio', true);
    const link = page.getByRole('link', { name: /Scarica in JSON/ });
    await expect(link.getAttribute('href')).resolves.toBe('/api/esportazione?formato=json');
    const res = await page.request.get(`${base}/api/esportazione?formato=json`);
    expect(res.status()).toBe(200);
    expect((await res.json()).formato).toBe('mmg-esportazione');
  });

  it('credenziali dei servizi: mai rilette; codice di sessione revocato, chiesto e attivato (D100–D102)', async () => {
    await page.goto(base);
    await page.locator('.utente').getByRole('link', { name: 'Credenziali' }).click();
    await page.getByRole('heading', { level: 1, name: 'Credenziali dei servizi' }).waitFor();
    const rupar = page.getByRole('region', { name: 'RUPAR Piemonte' });
    await rupar.getByText(/Impostate: utente/).waitFor();
    // Le credenziali salvate non tornano nei campi.
    await expect(rupar.getByLabel('Password', { exact: true }).inputValue()).resolves.toBe('');
    await expect(rupar.getByLabel('PIN', { exact: true }).inputValue()).resolves.toBe('');
    await check(page, 'credenziali dei servizi', true);
    const byEmail = rupar.getByRole('group', {
      name: 'In alternativa: codice di sessione via email',
    });
    const regional = rupar.getByRole('group', { name: 'Accesso regionale con SPID o CIE' });
    await byEmail.getByRole('button', { name: 'Revoca il codice' }).click();
    await byEmail.getByText(/^Non attivo/).waitFor();
    // La pagina Oggi avvisa e porta alla pagina giusta.
    await page
      .getByRole('navigation', { name: 'Sezioni' })
      .getByRole('link', { name: 'Oggi' })
      .click();
    await page
      .getByText('Accesso regionale per le ricette SSN non attivo: entra con SPID o CIE.')
      .waitFor();
    await check(page, 'oggi con gli avvisi dei servizi');
    await page.getByRole('link', { name: 'Apri «Credenziali dei servizi»' }).click();
    // Codice via email: chiesto e attivato.
    await byEmail.getByRole('button', { name: 'Chiedi il codice' }).click();
    await byEmail.getByText(/Ambiente di prova/).waitFor();
    await byEmail.getByRole('button', { name: 'Attiva' }).click();
    await byEmail.getByText(/^Attivo fino a/).waitFor();
    // Accesso regionale con SPID o CIE (D109): la pagina regionale simulata, poi il ritorno.
    await regional.getByRole('button', { name: 'Entra con SPID o CIE' }).click();
    await page.getByRole('heading', { level: 1, name: 'Accesso regionale simulato' }).waitFor();
    await check(page, 'pagina regionale simulata');
    await page.getByRole('button', { name: 'Entra con SPID (simulato)' }).click();
    await page.getByText('Accesso regionale attivo: puoi mandare le ricette SSN.').waitFor();
    await regional.getByText(/^Attivo fino a/).waitFor();
    expect(new URL(page.url()).search).toBe('');
  });

  it('certificato di malattia: compilato, controllato, inviato; copia in PDF e continuazione (tappa 8)', async () => {
    // Lavoratore adulto con la residenza in anagrafica (dati inventati).
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({
          birthDate: '1980-05-05',
          residenceStreet: 'Via di Prova',
          residenceNumber: '',
          residencePostalCode: '10121',
          residenceTown: 'Torino',
          residenceProvince: 'TO',
        })
        .where(eq(patient.id, s.richPatient)),
    );
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('link', { name: 'Certificati', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: 'Certificati di malattia' }).waitFor();
    await page.getByRole('button', { name: 'Nuovo certificato' }).click();
    const end = studioDayFrom(s.clock.now(), 2);
    await page.getByLabel('Prognosi a tutto il').fill(end);
    await page.getByLabel('Codice ICD-9-CM').fill('487.1');
    await page.getByLabel('Diagnosi', { exact: true }).fill('Sindrome influenzale di prova');
    await expect(
      page
        .getByRole('group', { name: 'Residenza o domicilio abituale' })
        .getByLabel('Via o piazza')
        .inputValue(),
    ).resolves.toBe('Via di Prova');
    await page.getByRole('button', { name: 'Salva e controlla' }).click();
    await page.getByText('Nessun problema nei controlli: si può inviare.').waitFor();
    await check(page, 'modulo del certificato', true);
    await page.getByRole('button', { name: 'Firma e invia all’INPS' }).click();
    const card = page.locator('.scheda-certificato').filter({ hasText: 'Inviato' }).first();
    await card.getByText(/protocollo SIM\d+/).waitFor();
    const href = await card
      .getByRole('link', { name: 'Copia per il lavoratore (PDF)' })
      .getAttribute('href');
    const res = await page.request.get(`${base}${href}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    await card.getByRole('button', { name: 'Continuazione' }).click();
    await page.getByText('Continuazione preparata: è tra le bozze.').waitFor();
    await page.locator('.scheda-certificato').filter({ hasText: 'Bozza' }).first().waitFor();
    await check(page, 'elenco dei certificati', true);
  });

  it('voci cliniche, parametri con l’andamento, privacy e piani dalla cartella (tappa 9)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Voci cliniche' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    // Un problema nuovo, poi annullato con il motivo: resta in elenco, segnato.
    await page.getByLabel('Descrizione').fill('Problema della prova nel browser');
    // Il codice si cerca nel catalogo ICD-9-CM per descrizione (D186); la descrizione già scritta resta.
    await page.getByRole('button', { name: 'Cerca il codice per descrizione' }).click();
    await page.getByRole('searchbox').fill('ipertensione non specificata');
    await page.getByRole('button', { name: 'Usa 401.9' }).waitFor();
    // Accessibilità, bersagli di 44 px e tablet anche con la ricerca aperta e i risultati.
    await check(page, 'ricerca delle diagnosi', true);
    await page.getByRole('button', { name: 'Usa 401.9' }).click();
    await expect(page.getByLabel('Codice ICD-9-CM').inputValue()).resolves.toBe('401.9');
    await page.getByText('Ipertensione essenziale non specificata').waitFor();
    await expect(page.getByLabel('Descrizione').inputValue()).resolves.toBe(
      'Problema della prova nel browser',
    );
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Voce registrata.').waitFor();
    const item = page.locator('.voce').filter({ hasText: 'Problema della prova nel browser' });
    await item.waitFor();
    await check(page, 'voci cliniche', true);
    await item.getByRole('button', { name: /Annulla la voce/ }).click();
    await item.getByLabel('Motivo dell’annullamento').fill('Inserita per prova');
    await check(page, 'annullamento di una voce');
    await item.getByRole('button', { name: 'Conferma l’annullamento' }).click();
    await page
      .locator('.voce-annullata')
      .filter({ hasText: 'Motivo dell’annullamento: Inserita per prova' })
      .waitFor();
    // Una nota del diario per telefono.
    await page.getByRole('button', { name: 'Diario clinico' }).click();
    await page.getByLabel('Tipo di contatto').selectOption('telefono');
    await page.getByLabel('Testo', { exact: true }).fill('Telefonata di prova.');
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.locator('.voce').filter({ hasText: 'Al telefono: Telefonata di prova.' }).waitFor();

    // Parametri della stessa visita, poi l'andamento in grafico e in tabella.
    await page.getByRole('link', { name: 'Parametri' }).first().click();
    await page.getByRole('heading', { level: 1, name: 'Parametri' }).waitFor();
    await page.getByLabel(/Pressione sistolica/).fill('135');
    await page.getByLabel(/Pressione diastolica/).fill('85');
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Registrati 2 parametri.').waitFor();
    await page.getByRole('table', { name: /Pressione arteriosa: valori/ }).waitFor();
    await page.getByRole('group', { name: /Pressione arteriosa: grafico/ }).focus();
    await page.locator('.grafico-suggerimento').getByText('135 mmHg').waitFor();
    await check(page, 'parametri', true);

    // Privacy: un consenso del Fascicolo, con la fonte.
    await page.goto(`${base}/pazienti/${s.richPatient}/privacy`);
    await page.getByRole('heading', { level: 1, name: 'Privacy' }).waitFor();
    await page.getByLabel('Consenso', { exact: true }).selectOption('fse_cura');
    await page.getByRole('button', { name: 'Registra il consenso' }).click();
    await page.getByText('Consenso registrato.').waitFor();
    await page.getByRole('row', { name: /finalità di cura Dato/ }).waitFor();
    await check(page, 'privacy', true);

    // Piani terapeutici: un piano valido, con i giorni alla scadenza.
    await page.goto(`${base}/pazienti/${s.richPatient}/piani`);
    await page.getByRole('heading', { level: 1, name: 'Piani terapeutici' }).waitFor();
    await page.getByLabel('Farmaco', { exact: true }).fill('Piano di prova nel browser');
    await page.getByLabel('Scade il').fill(studioDayFrom(s.clock.now(), 90));
    await page.getByRole('button', { name: 'Registra il piano' }).click();
    await page.getByText('Piano registrato.').waitFor();
    await page
      .locator('.voce')
      .filter({ hasText: 'Piano di prova nel browser' })
      .getByText('Valido', { exact: true })
      .waitFor();
    await check(page, 'piani terapeutici', true);
  });

  it('seguito delle prestazioni con il referto in PDF, e presidi (tappa 10)', async () => {
    // La ricetta specialistica inviata da una prova precedente (D66) è nel seguito.
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Seguito delle prestazioni' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Seguito delle prestazioni' }).waitFor();
    await page
      .getByRole('button', { name: /Registra (l’esecuzione|una seduta)/ })
      .first()
      .click();
    await page.getByLabel('Struttura').fill('Struttura di prova');
    await page.getByLabel('Esito').fill('Esito di prova, paziente inventato.');
    await page.getByLabel(/Referto \(PDF o immagine/).setInputFiles({
      name: 'referto-di-prova.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% referto di prova\n%%EOF\n', 'latin1'),
    });
    await check(page, 'esecuzione da registrare');
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Esecuzione registrata.').waitFor();
    const link = page.getByRole('link', { name: /Referto/ }).first();
    const res = await page.request.get(`${base}${await link.getAttribute('href')}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    await check(page, 'seguito delle prestazioni', true);

    await page.goto(`${base}/pazienti/${s.richPatient}/presidi`);
    await page
      .getByRole('heading', { level: 1, name: 'Presidi e assistenza integrativa' })
      .waitFor();
    await page.getByLabel('Categoria').selectOption('diabetici');
    await page.getByText(/Fonte: DPCM 12\/1\/2017 \(LEA\), art\. 13/).waitFor();
    await page.getByLabel('Prodotto').fill('Strisce reattive di prova');
    await page.getByLabel('Fabbisogno al mese').fill('50');
    await page.getByLabel('Unità').fill('strisce');
    await page.getByRole('button', { name: 'Registra la prescrizione' }).click();
    await page.getByText('Prescrizione registrata.').waitFor();
    await page
      .locator('.voce')
      .filter({ hasText: 'Strisce reattive di prova' })
      .getByText('In corso')
      .waitFor();
    await check(page, 'presidi', true);
  });

  it('Profilo sanitario sintetico: dalla cartella, scelto e confermato dal medico, validato, firmato e pubblicato (tappa 11)', async () => {
    // Le voci con i dati che il Profilo vuole: patologia cronica, organo mancante, allergia.
    await page.goto(`${base}/pazienti/${s.richPatient}/voci`);
    await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    await page.getByLabel('Descrizione').fill('Ipertensione della prova nel browser');
    await page.getByLabel('Codice ICD-9-CM').fill('401.9');
    await page.getByLabel(/Patologia cronica/).check();
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Voce registrata.').waitFor();
    await page
      .locator('.voce')
      .filter({ hasText: 'Ipertensione della prova nel browser' })
      .locator('.etichetta', { hasText: 'Cronico' })
      .waitFor();
    await page.getByLabel('Che cosa').selectOption('organo_mancante');
    // Il codice solo dall'elenco ufficiale; la descrizione si riempie con il nome dell'organo.
    await expect(page.getByLabel('Codice ICD-9-CM').count()).resolves.toBe(0);
    await page.getByLabel('Organo mancante').selectOption({ index: 1 });
    expect(await page.getByLabel('Descrizione').inputValue()).not.toBe('');
    await check(page, 'voce di un organo mancante', true);
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Voce registrata.').waitFor();
    await page
      .locator('.voce')
      .filter({ hasText: /^.*Organo mancante:/ })
      .first()
      .waitFor();
    await page.getByRole('button', { name: 'Allergie e reazioni' }).click();
    await page.getByLabel('Sostanza o farmaco').fill('Pollini della prova nel browser');
    await page.getByLabel('Agente', { exact: true }).selectOption('ambiente');
    await page.getByLabel('Allergene').selectOption({ index: 1 });
    await page.getByLabel('Criticità').selectOption('moderata');
    await check(page, 'allergia con agente e criticità', true);
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Voce registrata.').waitFor();
    await page
      .locator('.voce')
      .filter({ hasText: 'Pollini della prova nel browser' })
      .getByText('Criticità moderata')
      .waitFor();

    // Il Profilo dalla cartella: il programma propone, il medico controlla e conferma.
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Profilo sanitario sintetico' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Profilo sanitario sintetico' }).waitFor();
    await check(page, 'Profilo sanitario sintetico, prima della bozza');
    await page.getByRole('button', { name: 'Prepara il Profilo dalla cartella' }).click();
    await page.getByText('Bozza preparata dalla cartella.').waitFor();
    const problems = page.getByRole('group', {
      name: 'Patologie croniche, organi mancanti, trapianti, malformazioni',
    });
    await expect(
      problems.getByLabel(/Ipertensione della prova nel browser/).isChecked(),
    ).resolves.toBe(true);
    await expect(
      page
        .getByRole('group', { name: 'Allergie e intolleranze' })
        .getByLabel(/Pollini della prova/)
        .isChecked(),
    ).resolves.toBe(true);
    await check(page, 'Profilo sanitario sintetico, bozza', true);
    // Si toglie una voce: la scelta resta.
    await problems.getByLabel(/Ipertensione della prova nel browser/).uncheck();
    await page.getByText('Scelta salvata.').waitFor();
    await expect(
      problems.getByLabel(/Ipertensione della prova nel browser/).isChecked(),
    ).resolves.toBe(false);
    await problems.getByLabel(/Ipertensione della prova nel browser/).check();
    await page.getByText('Scelta salvata.').waitFor();
    // Senza la conferma del medico non si valida.
    const validate = page.getByRole('button', { name: 'Valida con il Gateway' });
    await expect(validate.isDisabled()).resolves.toBe(true);
    await page.getByLabel('Ho controllato il contenuto del Profilo, voce per voce').check();
    await validate.click();
    await page.getByText('Validato dal Gateway. Ora puoi firmarlo e pubblicarlo.').waitFor();
    await check(page, 'Profilo validato');
    const draftPdf = page.getByRole('link', { name: 'Apri il PDF' });
    const preview = await page.request.get(`${base}${await draftPdf.getAttribute('href')}`);
    expect(preview.headers()['content-type']).toBe('application/pdf');
    await page.getByRole('button', { name: 'Firma e pubblica' }).click();
    await page.getByText('Profilo firmato e pubblicato nel Fascicolo.').waitFor();
    await page.getByRole('heading', { name: 'Versioni nel Fascicolo' }).waitFor();
    const signed = page.getByRole('link', { name: 'PDF firmato della versione 1' });
    const res = await page.request.get(`${base}${await signed.getAttribute('href')}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect((await res.body()).includes(Buffer.from('/ETSI.CAdES.detached'))).toBe(true);
    await check(page, 'Profilo pubblicato', true);
  });

  it('recapiti di studio del medico e impostazioni del Fascicolo dell’amministratore (tappa 11)', async () => {
    await page.goto(`${base}/profilo/credenziali`);
    await page.getByRole('link', { name: 'Recapiti di studio' }).click();
    await page.getByRole('heading', { level: 1, name: 'Recapiti di studio' }).waitFor();
    await page.getByText('Ci sono i dati che il Profilo sanitario sintetico richiede.').waitFor();
    await page.getByLabel('Telefono dello studio').fill('011 000 0000');
    await page.getByRole('button', { name: 'Salva i recapiti' }).click();
    await page.getByText('Recapiti salvati.').waitFor();
    await check(page, 'recapiti di studio', true);

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    const admin = await ctx.newPage();
    try {
      await loginInBrowser(admin, 'amministratore');
      await admin
        .getByRole('navigation', { name: 'Sezioni' })
        .getByRole('link', { name: 'Strumenti' })
        .click();
      await admin.getByRole('heading', { level: 1, name: 'Strumenti dello studio' }).waitFor();
      // L'amministratore non è medico: niente impaginazione, che è del medico.
      await expect(admin.getByRole('button', { name: 'Impaginazione' }).count()).resolves.toBe(0);
      await admin.getByRole('button', { name: 'Fascicolo sanitario' }).click();
      await admin.getByText('Impostazioni complete.').waitFor();
      expect(await admin.getByLabel('Tipo di attività clinica').inputValue()).toBe('OBS');
      await admin.getByLabel('Regime').selectOption('SSN');
      await admin.getByRole('button', { name: 'Salva le impostazioni' }).click();
      await admin.getByText('Impostazioni salvate.').waitFor();
      await check(admin, 'strumenti dello studio', true);
    } finally {
      await ctx.close();
    }
  });

  it('aggiornamento delle banche dati: quando parte, com’è andato, «Aggiorna adesso» dell’amministratore per tutti gli studi (D156, D194)', async () => {
    // Chi usa le banche dati vede quando è stata controllata la fonte, e da lì l'aggiornamento.
    await page.goto(`${base}/banche-dati`);
    await page
      .getByText(/fonte controllata il/)
      .first()
      .waitFor();
    await page.getByRole('link', { name: 'Aggiornamento delle banche dati' }).click();
    await page
      .getByRole('heading', { level: 2, name: 'Aggiornamento delle banche dati' })
      .waitFor();
    await page.getByText('Aggiornamento automatico: ogni notte alle 03:30.').waitFor();
    await page
      .getByText('Automatico, di notte (orologio del servizio)', { exact: false })
      .waitFor();
    // Le aggiorna chi gestisce il servizio, per tutti gli studi (D191).
    await page
      .getByText(/le aggiorna chi gestisce il servizio, e lo studio non deve fare nulla/)
      .waitFor();
    // Il medico non è amministratore: niente pulsante.
    await expect(page.getByRole('button', { name: 'Aggiorna adesso' }).count()).resolves.toBe(0);
    await check(page, 'aggiornamento delle banche dati', true);

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    const admin = await ctx.newPage();
    try {
      await loginInBrowser(admin, 'amministratore');
      await admin.goto(`${base}/strumenti?sezione=banche-dati`);
      // Il pulsante resta all'amministratore dello studio, e dice che vale per tutti (D194).
      await admin.getByText(/L’aggiornamento vale per tutti gli studi del servizio/).waitFor();
      await admin.getByRole('button', { name: 'Aggiorna adesso' }).click();
      // La pagina segue il giro da sola; alla fine l'ultimo è quello del pulsante.
      await admin.getByText(/Pulsante «Aggiorna adesso» \(/).waitFor({ timeout: 30_000 });
      await admin.getByRole('caption').filter({ hasText: 'Aggiornamenti recenti' }).waitFor();
      await expect(
        admin.getByRole('table', { name: 'Aggiornamenti recenti' }).getByRole('row').count(),
      ).resolves.toBe(3);
      await check(admin, 'aggiornamento delle banche dati (amministratore)', true);
    } finally {
      await ctx.close();
    }
  });

  it('modelli dei certificati: impaginazione del medico, modello dello studio, rilascio e annullamento (tappa 13)', async () => {
    // Impaginazione del medico, con la prova di stampa.
    await page
      .getByRole('navigation', { name: 'Sezioni' })
      .getByRole('link', { name: 'Strumenti' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Strumenti dello studio' }).waitFor();
    await page.getByRole('button', { name: 'Impaginazione' }).click();
    await page.getByRole('heading', { name: 'Impaginazione dei certificati' }).waitFor();
    await page.getByLabel('Con grazie (Times)').check();
    await page
      .getByLabel('Intestazione', { exact: true })
      .fill('Dott.ssa Medica Inventata\nMedicina generale – Via di prova 1');
    await page.getByLabel('Al centro').check();
    await page.getByLabel('Luogo proposto per «luogo e data»').fill('Comune di prova');
    await page.getByLabel('Timbro').fill('Timbro di prova');
    const [proof] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/profilo/impaginazione/anteprima')),
      page.getByRole('button', { name: 'Prova di stampa (PDF)' }).click(),
    ]);
    expect(proof.headers()['content-type']).toBe('application/pdf');
    for (const other of doctor.pages()) if (other !== page) await other.close();
    await page.getByRole('button', { name: 'Salva l’impaginazione' }).click();
    await page.getByText('Impaginazione salvata.').waitFor();
    await check(page, 'impaginazione dei certificati', true);

    // Un modello dello studio, con i segnaposto.
    await page.getByRole('button', { name: 'Modelli dei certificati' }).click();
    await page.getByRole('heading', { name: 'Modelli dello studio' }).waitFor();
    await page.getByLabel('Titolo').fill('Certificato di prova nel browser');
    await page
      .getByLabel('Testo', { exact: true })
      .fill(
        'Si certifica che {{paziente.cognome}} {{paziente.nome}}, nato/a il {{paziente.nato_il}}: {{campo.testo}}\n\n{{rilascio.luogo}}, {{rilascio.data}}',
      );
    await page.getByRole('button', { name: 'Salva il modello' }).click();
    await page.getByText('Modello salvato.').waitFor();
    await page.locator('.voce').filter({ hasText: 'Certificato di prova nel browser' }).waitFor();
    await page.getByText('Segnaposto che si possono usare').click();
    await check(page, 'modelli dei certificati', true);

    // Dalla cartella: anteprima, rilascio, PDF, annullamento.
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Altri certificati' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Altri certificati' }).waitFor();
    await page.getByLabel('Modello').selectOption({ label: 'Certificato di prova nel browser' });
    expect(await page.getByLabel('Luogo del rilascio').inputValue()).toBe('Comune di prova');
    await page.getByLabel('Testo', { exact: true }).fill('testo scritto nel browser.');
    const [preview] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/certificati-modelli/anteprima')),
      page.getByRole('button', { name: 'Anteprima (PDF)' }).click(),
    ]);
    expect(preview.headers()['content-type']).toBe('application/pdf');
    for (const other of doctor.pages()) if (other !== page) await other.close();
    await check(page, 'altri certificati, prima del rilascio', true);
    await page.getByRole('button', { name: 'Rilascia il certificato' }).click();
    await page
      .getByText('Certificato rilasciato: è nella cartella, da stampare e firmare.')
      .waitFor();
    const item = page.locator('.voce').filter({ hasText: 'Certificato di prova nel browser' });
    const href = await item.getByRole('link', { name: /PDF/ }).getAttribute('href');
    const pdf = await page.request.get(`${base}${href}`);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    // La bozza si cancella dopo il rilascio.
    expect(await page.getByLabel('Modello').inputValue()).toBe('');
    await item.getByRole('button', { name: /Annulla/ }).click();
    await item.getByLabel('Motivo dell’annullamento').fill('Rilasciato per prova');
    await item.getByRole('button', { name: 'Conferma l’annullamento' }).click();
    await item.locator('.etichetta', { hasText: 'Annullato' }).waitFor();
    await check(page, 'altri certificati, rilasciati', true);
  });

  it('modello ufficiale del porto d’armi: le caselle come pulsanti in riga, poi il rilascio (D158)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/certificati-modelli`);
    await page.getByRole('heading', { level: 1, name: 'Altri certificati' }).waitFor();
    await page.getByLabel('Modello').selectOption('porto-armi-anamnestico');
    const groups = page.locator('form fieldset.scelta-in-riga');
    await expect(groups.count()).resolves.toBe(17);
    for (const g of await groups.all()) await g.getByLabel('No', { exact: true }).check();
    await page
      .getByRole('group', { name: 'Malattie del sistema nervoso: epilessia' })
      .getByLabel('Pregressa', { exact: true })
      .check();
    await page.getByLabel('Professione').fill('Impiegata di prova');
    await page.getByLabel('Unità sanitaria locale n.').fill('ASL di prova');
    await page.getByLabel('Regione').fill('Piemonte');
    await page.getByLabel('Luogo del rilascio').fill('Comune di prova');
    await check(page, 'altri certificati, porto d’armi', true);
    await page.getByRole('button', { name: 'Rilascia il certificato' }).click();
    await page
      .getByText('Certificato rilasciato: è nella cartella, da stampare e firmare.')
      .waitFor();
    const item = page.locator('.voce').filter({ hasText: 'PORTO D' }).first();
    const href = await item.getByRole('link', { name: /PDF/ }).getAttribute('href');
    expect((await page.request.get(`${base}${href}`)).headers()['content-type']).toBe(
      'application/pdf',
    );
  });

  it('AFT: il titolare crea l’AFT e condivide, il collega accetta l’invito e consulta la scheda (tappa 12, D187)', async () => {
    await page.goto(`${base}/strumenti?sezione=aft`);
    await page
      .getByRole('heading', { level: 2, name: 'Aggregazione funzionale territoriale' })
      .waitFor();
    await page.getByLabel('Nome dell’AFT').fill('AFT di prova');
    await page.getByRole('button', { name: 'Crea l’AFT' }).click();
    await page.getByRole('table', { name: 'Medici dell’AFT nel programma' }).waitFor();
    await page
      .getByLabel(
        'Condivido con i medici dell’AFT la scheda dei miei pazienti che hanno dato il consenso',
      )
      .check();
    await page.getByLabel('Invita un medico titolare: codice regionale').fill('MMG-PROVA-2');
    await page.getByRole('button', { name: 'Invita' }).click();
    await page.getByRole('cell', { name: 'Invitato, in attesa' }).waitFor();
    await check(page, 'AFT del titolare', true);
    // Il consenso del paziente, come lo registra lo studio nella sua cartella.
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    for (const tipo of ['aft_condivisione', 'aft_condivisione_pregressi']) {
      const given = await page.request.post(`${base}/api/pazienti/${s.richPatient}/consensi`, {
        data: { tipo, stato: 'dato', data: '2026-11-18' },
      });
      expect(given.status(), tipo).toBe(201);
    }

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    const colleague = await ctx.newPage();
    try {
      await loginInBrowser(colleague, 'collega');
      await colleague.goto(`${base}/strumenti?sezione=aft`);
      await colleague.getByRole('button', { name: 'Accetta l’invito' }).click();
      await colleague
        .getByRole('heading', { level: 2, name: 'Scheda di un paziente di un collega' })
        .waitFor();
      await colleague.getByLabel('Codice fiscale del paziente').fill(rich!.fiscalCode);
      await colleague
        .getByLabel('Motivo dell’accesso')
        .fill('Visita nell’ambulatorio serale dell’AFT');
      await colleague.getByRole('button', { name: 'Mostra la scheda' }).click();
      await colleague
        .getByText('Scheda condivisa con il consenso del paziente.', { exact: false })
        .waitFor();
      await colleague.getByText('Sostanza di prova', { exact: false }).first().waitFor();
      await expect(colleague.getByText('Farmaco riservato di prova').count()).resolves.toBe(0);
      // Si dice che la scheda può non essere completa (Garante, par. 5.1).
      await colleague.getByText('La scheda può non essere completa', { exact: false }).waitFor();
      // La scheda intera non riservata, sotto il riepilogo (D187).
      await colleague
        .getByRole('heading', {
          level: 4,
          name: 'Scheda: note di visita, esami, ricette e altre voci',
        })
        .waitFor();
      await check(colleague, 'AFT del collega, scheda', true);
      // L'attività svolta va nel registro di AFT e nella cronologia del medico curante.
      await colleague.getByLabel('Tipologia').selectOption('ambulatorio');
      await colleague.getByLabel('Esito', { exact: true }).fill('Controllo pressorio di prova');
      await colleague.getByRole('button', { name: 'Registra l’attività' }).click();
      await colleague
        .getByText('Attività registrata: il medico curante la vede nella cronologia.')
        .waitFor();
    } finally {
      await ctx.close();
    }
    // Il titolare vede chi ha consultato e perché, e che cosa ha fatto il collega.
    await page.reload();
    await page
      .getByRole('table', { name: 'Consultazioni dei colleghi sui miei pazienti' })
      .getByRole('cell', { name: 'Visita nell’ambulatorio serale dell’AFT' })
      .waitFor();
    await page
      .getByRole('table', { name: 'Attività dei colleghi sui miei pazienti' })
      .getByRole('cell', { name: 'Controllo pressorio di prova' })
      .waitFor();
    await check(page, 'AFT del titolare, consultazioni e attività', true);
  });

  it('Strumenti dell’amministratore: dati dello studio, postazioni e stato del servizio (tappa 14)', async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    const admin = await ctx.newPage();
    try {
      await loginInBrowser(admin, 'amministratore');
      await admin.goto(`${base}/strumenti?sezione=studio`);
      await admin
        .getByRole('heading', { level: 2, name: 'Dati e impostazioni dello studio' })
        .waitFor();
      await admin.getByLabel('Regione').fill('PIEMONTE');
      await admin.getByLabel('Telefono').fill('000 0000002');
      await admin.getByRole('button', { name: 'Salva i dati dello studio' }).click();
      await admin.getByText('Dati e impostazioni dello studio salvati.').waitFor();
      await check(admin, 'dati dello studio, amministratore', true);

      await admin.goto(`${base}/strumenti?sezione=stampa`);
      await admin.getByRole('heading', { level: 2, name: 'Postazioni dello studio' }).waitFor();
      await admin.getByLabel('Nome della postazione').fill('Ambulatorio di prova');
      await admin.getByRole('button', { name: 'Aggiungi la postazione' }).click();
      await admin
        .getByRole('table', { name: 'Postazioni attive' })
        .getByRole('cell', { name: 'Ambulatorio di prova', exact: true })
        .first()
        .waitFor();
      await check(admin, 'postazioni e stampa, amministratore', true);
      // Preferenze di stampa dello studio (D180): i certificati dai modelli in A5.
      await admin
        .getByRole('heading', { level: 3, name: 'Preferenze dello studio e delle postazioni' })
        .waitFor();
      await admin
        .getByRole('button', {
          name: 'Modifica le preferenze dello studio per «Certificati dai modelli»',
        })
        .click();
      await admin.getByLabel('Stampante consigliata').fill('Stampante di prova');
      await admin.getByLabel('Carta', { exact: true }).selectOption('A5');
      await check(admin, 'preferenze di stampa di un documento', true);
      await admin.getByRole('button', { name: 'Salva le preferenze' }).click();
      await admin
        .getByRole('table', { name: 'Preferenze dello studio' })
        .getByText('Stampante di prova')
        .waitFor();

      await admin.goto(`${base}/strumenti?sezione=servizio`);
      await admin.getByRole('heading', { level: 2, name: 'Stato del servizio' }).waitFor();
      await check(admin, 'stato del servizio', true);
    } finally {
      await ctx.close();
    }
    // Il medico legge i dati dello studio senza poterli cambiare.
    await page.goto(`${base}/strumenti?sezione=studio`);
    await page
      .getByRole('heading', { level: 2, name: 'Dati e impostazioni dello studio' })
      .waitFor();
    await expect(
      page.getByRole('button', { name: 'Salva i dati dello studio' }).count(),
    ).resolves.toBe(0);
    // Il medico vede che cosa vale sulla sua postazione, senza le preferenze delle altre.
    await page.goto(`${base}/strumenti?sezione=stampa`);
    await page.getByRole('heading', { level: 3, name: 'Questa postazione' }).waitFor();
    await page
      .getByText(/Stampante di prova/)
      .first()
      .waitFor();
    await expect(
      page
        .getByRole('heading', { level: 3, name: 'Preferenze dello studio e delle postazioni' })
        .count(),
    ).resolves.toBe(0);
    await check(page, 'postazioni e stampa, medico', true);
  });

  it('utenti: l’amministratore crea una segreteria, che aspetta; il medico titolare la conferma e riceve la password (tappa 14, D179)', async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    const admin = await ctx.newPage();
    try {
      await loginInBrowser(admin, 'amministratore');
      await admin.goto(`${base}/strumenti?sezione=utenti`);
      await admin.getByRole('heading', { level: 2, name: 'Utenti e ruoli' }).waitFor();
      const form = admin.getByRole('form', { name: 'Nuovo utente' });
      await form.getByLabel('Nome utente').fill('segreteria.e2e');
      await form.getByLabel('Nome mostrato').fill('Segreteria di prova e2e');
      await form.getByLabel('Segreteria', { exact: true }).check();
      await form.getByRole('button', { name: 'Crea l’utente' }).click();
      await admin.getByText('Utente creato: Segreteria di prova e2e.').waitFor();
      // L'amministratore non riceve la password di chi lavora con i dati dei pazienti.
      await expect(admin.locator('.segreto').count()).resolves.toBe(0);
      await admin
        .getByRole('table', { name: 'Utenti dello studio' })
        .getByRole('row')
        .filter({ hasText: 'segreteria.e2e' })
        .getByText('In attesa di conferma di un titolare')
        .waitFor();
      await check(admin, 'utenti e ruoli, utente in attesa', true);
    } finally {
      await ctx.close();
    }
    // Il medico titolare la trova fra gli utenti da confermare, la conferma e riceve la password.
    await page.goto(`${base}/strumenti?sezione=conferme`);
    await page.getByRole('heading', { level: 2, name: 'Utenti da confermare' }).waitFor();
    const row = page
      .getByRole('table', { name: 'Utenti in attesa della conferma di un medico titolare' })
      .getByRole('row')
      .filter({ hasText: 'segreteria.e2e' });
    await row.waitFor();
    await check(page, 'utenti da confermare', true);
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Conferma Segreteria di prova e2e' }).click();
    await page.getByText('Password temporanea di Segreteria di prova e2e').waitFor();
    await expect(page.locator('.segreto').innerText()).resolves.toMatch(/\S{8,}/);
    await page.getByRole('button', { name: 'Consegnata: nascondi la password' }).click();
    await page.getByText('Nessun utente da confermare.').waitFor();
    await expect(page.locator('.segreto').count()).resolves.toBe(0);
  });

  it('nuovo paziente e dati amministrativi: identità controllata, canale del promemoria (tappa 15)', async () => {
    // Un paziente inventato (D12): codice fiscale con la X in dodicesima posizione.
    const [nuovo] = generatePatients({ seed: `nuovo-paziente-e2e-${s.studioId}`, count: 1 });
    await page.goto(`${base}/pazienti`);
    await page.getByRole('heading', { level: 1, name: 'Pazienti' }).waitFor();
    await page.getByRole('link', { name: 'Nuovo paziente' }).click();
    await page.getByRole('heading', { level: 1, name: 'Nuovo paziente' }).waitFor();
    await page.getByLabel('Cognome').fill(nuovo!.lastName);
    await page.getByLabel('Nome', { exact: true }).fill(nuovo!.firstName);
    await page.getByLabel(nuovo!.sex === 'M' ? 'Maschile' : 'Femminile').check();
    await page.getByLabel('Data di nascita').fill(nuovo!.birthDate);
    await page.getByLabel('Comune o Stato estero di nascita').fill(nuovo!.birthPlace.name);
    await page.getByLabel('Codice catastale del luogo di nascita').fill(nuovo!.birthPlace.code);
    await page.getByLabel('Codice fiscale').fill(nuovo!.fiscalCode);
    await check(page, 'nuovo paziente', true);
    await page.getByRole('button', { name: 'Registra il paziente' }).click();
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();

    // Dati amministrativi: il canale del promemoria scelto dal paziente (R15).
    await page.getByRole('link', { name: 'Dati amministrativi' }).first().click();
    await page.getByRole('heading', { level: 2, name: 'Canale del promemoria' }).waitFor();
    await check(page, 'dati amministrativi', true);
    await page.getByRole('button', { name: 'Modifica canale del promemoria' }).click();
    await page
      .getByLabel('Canale scelto dal paziente')
      .selectOption({ label: 'Promemoria cartaceo' });
    const promemoria = page.getByRole('region', { name: 'Canale del promemoria' });
    await promemoria.getByRole('button', { name: /^Salva/ }).click();
    await promemoria.getByText('Promemoria cartaceo').first().waitFor();
  });

  it('importazione a passi: file, destinazione proposta, colonne, anteprima, prova, importazione (tappa 15)', async () => {
    // Pazienti inventati (D12): in prova si importano solo codici fiscali con la X.
    const nuovi = generatePatients({ seed: `importazione-e2e-${s.studioId}`, count: 3 });
    const csv = [
      'Codice fiscale;Cognome;Nome;Sesso;Data di nascita',
      ...nuovi.map((p) => [p.fiscalCode, p.lastName, p.firstName, p.sex, p.birthDate].join(';')),
    ].join('\r\n');
    await page.goto(`${base}/strumenti?sezione=importazione`);
    await page
      .getByRole('heading', { level: 2, name: 'Importazione da altri programmi' })
      .waitFor();
    await check(page, 'importazione: scegli il file', true);
    await page.getByLabel('File da importare').setInputFiles({
      name: 'pazienti-inventati.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf-8'),
    });
    await page.getByRole('button', { name: 'Carica e leggi il file' }).click();
    await page.getByRole('heading', { level: 4, name: 'File letto' }).waitFor();
    await page.getByRole('definition').filter({ hasText: 'Punto e virgola (;)' }).waitFor();

    // La destinazione è proposta dai nomi delle colonne: è solo un suggerimento.
    await page.getByRole('button', { name: 'Avanti: dove vanno i dati' }).click();
    await page.getByRole('heading', { level: 3, name: '2. Dove vanno i dati' }).waitFor();
    expect(await page.getByLabel('Dove vanno le righe').inputValue()).toBe('pazienti');
    await check(page, 'importazione: dove vanno i dati', true);

    await page.getByRole('button', { name: 'Avanti: colonne e campi' }).click();
    await page.getByRole('heading', { level: 3, name: '3. Colonne e campi' }).waitFor();
    await check(page, 'importazione: colonne e campi', true);

    await page.getByRole('button', { name: 'Mostra l’anteprima' }).click();
    await page.getByRole('heading', { level: 3, name: '4. Anteprima' }).waitFor();
    await page.getByText(nuovi[0]!.lastName).first().waitFor();
    await check(page, 'importazione: anteprima', true);

    await page.getByRole('button', { name: 'Avanti: prova senza scrivere' }).click();
    await page.getByRole('heading', { level: 3, name: '5. Prova senza scrivere' }).waitFor();
    await page.getByRole('button', { name: 'Fai la prova (non scrive nulla)' }).click();
    await page.getByText('Prova finita: nessun dato è stato scritto.').waitFor();
    await check(page, 'importazione: prova senza scrivere', true);
    // La prova non ha scritto nulla.
    const codici = nuovi.map((p) => p.fiscalCode);
    const scritti = async () =>
      (await t.db.select({ cf: patient.fiscalCode }).from(patient)).filter((r) =>
        codici.includes(r.cf),
      ).length;
    expect(await scritti()).toBe(0);

    await page.getByRole('button', { name: 'Avanti: importa' }).click();
    await page.getByRole('heading', { level: 3, name: '6. Importa' }).waitFor();
    const importa = page.getByRole('button', { name: 'Importa', exact: true });
    await expect(importa.isDisabled()).resolves.toBe(true);
    await page.getByLabel('Ho controllato la prova: importa i dati nel mio archivio').check();
    await check(page, 'importazione: conferma', true);
    await importa.click();
    await page.getByRole('heading', { level: 3, name: '7. Esito' }).waitFor();
    await page.getByText('Importazione finita.').waitFor();
    await check(page, 'importazione: esito', true);
    expect(await scritti()).toBe(3);

    // Il paziente importato si trova nell'elenco, come uno scritto a mano.
    await page.goto(`${base}/pazienti`);
    await page.getByLabel('Cerca un paziente').fill(nuovi[0]!.lastName);
    await page
      .locator('.paziente-riga', { hasText: new RegExp(nuovi[0]!.lastName, 'i') })
      .first()
      .waitFor();
  });

  it('elenchi dello studio: il medico aggiunge un contatto utile (tappa 14, D175)', async () => {
    await page.goto(`${base}/strumenti?sezione=elenchi&elenco=contatto`);
    await page.getByRole('heading', { level: 2, name: 'Elenchi dello studio' }).waitFor();
    await page.getByLabel('Nome', { exact: true }).fill('Laboratorio di prova e2e');
    await page.getByLabel('Tipo', { exact: true }).selectOption({ label: 'Laboratorio' });
    await page.getByLabel('Telefono (facoltativo)').fill('000 0000099');
    await page.getByRole('button', { name: 'Aggiungi all’elenco' }).click();
    await page.getByText(/«Laboratorio di prova e2e» aggiunto/).waitFor();
    await page
      .getByRole('table', { name: /Contatti utili in uso/ })
      .getByText('Laboratorio di prova e2e')
      .waitFor();
    await check(page, 'elenchi dello studio', true);
  });

  it('archivio: autorizzazione al sostituto e sua revoca, avvisi da completare; registro di amministrazione (tappa 14, D177)', async () => {
    await page.goto(`${base}/archivio`);
    await page.getByRole('heading', { level: 2, name: 'Autorizzazioni sull’archivio' }).waitFor();
    await page.getByLabel('Medico', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Dal', { exact: true }).fill(studioDate(new Date()));
    await page.getByLabel('Al (compreso)').fill(studioDayFrom(new Date(), 3));
    await page.getByLabel('Motivo', { exact: true }).fill('Ferie di prova nel browser');
    await page.getByRole('button', { name: 'Autorizza', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'Ferie di prova nel browser' });
    await row.getByText('Attiva').waitFor();
    await check(page, 'archivio: autorizzazioni', true);
    // La revoca chiede conferma e chiude subito.
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: /^Revoca/ }).click();
    await row.getByText('Revocata').waitFor();
    // Avvisi: con le soglie vuote la pagina dice che cosa completare, con la fonte.
    await page.getByRole('heading', { level: 2, name: 'Avvisi sugli accessi anomali' }).waitFor();
    await page.getByText('Soglie da completare.').waitFor();
    await check(page, 'archivio: avvisi sugli accessi anomali');

    await page.goto(`${base}/strumenti?sezione=registro`);
    await page
      .getByRole('heading', { level: 2, name: 'Registro delle azioni di amministrazione' })
      .waitFor();
    await page
      .getByRole('cell', { name: /Autorizzazione revocata/ })
      .first()
      .waitFor();
    await check(page, 'registro di amministrazione', true);
  });

  it('referto di laboratorio con due esami e vaccinazione, scritti a mano (tappa 15, D176)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/esami`);
    await page.getByRole('heading', { level: 2, name: 'Nuovo referto di laboratorio' }).waitFor();
    await page.getByLabel('Data del referto').fill(studioDate(new Date()));
    const first = page.getByRole('group', { name: 'Esame 1' });
    await first.getByLabel('Esame', { exact: true }).fill('Esame di prova nel browser');
    await first.getByLabel('Valore', { exact: true }).fill('13,5');
    await first.getByLabel('Unità di misura').fill('g/dl');
    await first.getByLabel('Minimo', { exact: true }).fill('12');
    await first.getByLabel('Massimo', { exact: true }).fill('16');
    await page.getByRole('button', { name: 'Aggiungi un esame' }).click();
    const second = page.getByRole('group', { name: 'Esame 2' });
    await second.getByLabel('Esame', { exact: true }).fill('Altro esame di prova nel browser');
    await second.getByLabel('Valore', { exact: true }).fill('negativo');
    await check(page, 'nuovo referto di laboratorio', true);
    await page.getByRole('button', { name: 'Registra il referto' }).click();
    await page.getByText('Altro esame di prova nel browser').last().waitFor();
    await page.getByText('Esame di prova nel browser', { exact: true }).last().waitFor();

    await page.goto(`${base}/pazienti/${s.richPatient}/voci`);
    await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    await page.getByRole('button', { name: 'Vaccinazioni' }).click();
    await page.getByLabel('Vaccino', { exact: true }).fill('Vaccino di prova nel browser');
    await page.getByLabel('Campagna vaccinale').fill('Campagna di prova');
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.locator('.voce').filter({ hasText: 'Vaccino di prova nel browser' }).waitFor();
    await check(page, 'voci cliniche: vaccinazioni', true);
  });

  it('ricetta fatta con un altro programma nei farmaci prescritti; terapia conclusa (tappa 15, D176)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/farmaci`);
    await page
      .getByRole('heading', { level: 2, name: /Farmaci prescritti con un altro programma/ })
      .waitFor();
    await page
      .getByRole('button', { name: 'Registra una ricetta fatta con un altro programma' })
      .click();
    await page.getByLabel('Data della ricetta').fill('2026-01-15');
    await page.getByLabel('Nome del farmaco').fill('Farmaco di un altro programma');
    await page.getByLabel('Programma con cui è stata fatta').fill('Programma di prova');
    await check(page, 'ricetta fatta con un altro programma', true);
    await page.getByRole('button', { name: 'Registra la ricetta' }).click();
    await page
      .getByText(/Con un altro programma/)
      .first()
      .waitFor();
    await page.getByText('Farmaco di un altro programma').first().waitFor();

    // Una terapia in corso, conclusa dalla sua pagina: non si sospende e non si ripete più.
    const [t1] = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(therapy)
        .values({
          patientId: s.richPatient,
          drugName: 'Farmaco da concludere nel browser',
          kind: 'chronic',
          startOn: '2026-01-01',
          createdBy: s.users.titolare.id,
        })
        .returning({ id: therapy.id }),
    );
    await page.goto(`${base}/pazienti/${s.richPatient}/terapie/${t1!.id}`);
    await page.getByRole('button', { name: 'Concludi…' }).click();
    await page.getByRole('heading', { level: 2, name: 'Concludi la terapia' }).waitFor();
    await page.getByLabel('Conclusa il').fill(studioDate(new Date()));
    await check(page, 'conclusione della terapia', true);
    await page.getByRole('button', { name: 'Concludi la terapia' }).click();
    // L'avviso dell'azione, poi la testata della terapia riletta: «Terapia conclusa il …» compare in
    // tutti e due, e un browser veloce (Firefox) li mostra insieme.
    await page.getByText(/è tra le terapie sospese o concluse dei farmaci prescritti/).waitFor();
    await page.locator('strong', { hasText: /^Terapia conclusa il / }).waitFor();
    // La pagina rilegge la terapia dopo l'avviso: si aspetta che «Sospendi…» sparisca.
    await expect
      .poll(() => page.getByRole('button', { name: 'Sospendi…' }).count(), { timeout: 5000 })
      .toBe(0);
  });

  it('pagina della password: regole lette dal servizio, accessibile (tappa 14)', async () => {
    await page.goto(`${base}/profilo/password`);
    await page.getByRole('heading', { level: 1, name: 'Cambia la password' }).waitFor();
    await check(page, 'cambio della password', true);
  });

  it('blocchi del conto: l’avviso nella cornice porta alla pagina, accessibile; visti, l’avviso sparisce (D188)', async () => {
    // Un blocco della segreteria, con indirizzi di documentazione (RFC 5737): lo vede il titolare.
    await t.db.insert(accountLock).values({
      studioId: s.studioId,
      userId: s.users.segreteria.id,
      reason: 'passwords',
      failures: 50,
      lockedAt: s.clock.now(),
      lockedUntil: new Date(s.clock.now().getTime() + 15 * 60_000),
      addresses: ['192.0.2.10', '192.0.2.11'],
      workstations: ['pc-fuori'],
    });
    await page.goto(base);
    await page.getByText(/Un blocco del conto dopo troppi tentativi sbagliati/).waitFor();
    await page.getByRole('link', { name: 'Vedi i blocchi' }).click();
    await page.getByRole('heading', { level: 1, name: 'Blocchi del conto' }).waitFor();
    await page.getByText('192.0.2.10, 192.0.2.11').waitFor();
    await check(page, 'blocchi del conto', true);
    await page.getByRole('button', { name: 'Segna come visti' }).click();
    await page.getByText('Nessun blocco da vedere.').waitFor();
    await page.goto(base);
    await page.getByText('Controllo di prova').waitFor();
    expect(await page.getByText(/blocchi? del conto dopo troppi tentativi/).count()).toBe(0);
  });

  it('molte cartelle aperte (D68): venti schede, la ventunesima chiude la meno usata; pagine nuove e scritti ricordati per paziente', async () => {
    // Pazienti inventati in più nell'archivio del titolare, per superare il massimo di 20. Senza
    // omonimi: il seme cambia a ogni giro, e due «Neri Ada» farebbero cercare la scheda sbagliata.
    const used = new Set(
      (await t.db.select().from(patient)).map((p) => `${p.lastName} ${p.firstName}`),
    );
    const extra = generatePatients({ seed: `molte-cartelle-${s.studioId}`, count: 60 })
      .filter((p) => {
        const name = `${p.lastName} ${p.firstName}`;
        if (used.has(name)) return false;
        used.add(name);
        return true;
      })
      .slice(0, 18);
    expect(extra).toHaveLength(18);
    const added = await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .insert(patient)
        .values(
          extra.map((p) => ({
            studioId: s.studioId,
            archiveId: s.archives.titolare,
            firstName: p.firstName,
            lastName: p.lastName,
            sex: p.sex,
            birthDate: p.birthDate,
            birthPlaceCode: p.birthPlace.code,
            birthPlaceName: p.birthPlace.name,
            fiscalCode: p.fiscalCode,
            status: p.status,
          })),
        )
        .returning({ id: patient.id }),
    );
    const ids = [...s.patients.titolare, ...added.map((r) => r.id)];
    const names = new Map(
      (await t.db.select().from(patient)).map((p) => [p.id, `${p.lastName} ${p.firstName}`]),
    );
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bar = page.getByRole('navigation', { name: 'Cartelle aperte' });
    const tab = (id: string) =>
      bar.getByRole('link', {
        name: new RegExp(`^${escape(names.get(id)!)}(?![\\p{L}'])`, 'u'),
      });
    /** La scheda attiva si vede tutta nella barra, anche quando la barra scorre. */
    const activeVisible = () =>
      page.evaluate(() => {
        const nav = document.querySelector('nav.schede-aperte');
        const li = nav?.querySelector('a[aria-current="page"]')?.closest('li');
        if (!nav || !li) return false;
        const n = nav.getBoundingClientRect();
        const r = li.getBoundingClientRect();
        return r.left >= n.left - 1 && r.right <= n.right + 1;
      });

    await page.goto(`${base}/pazienti`);
    await page.getByRole('heading', { level: 1, name: 'Pazienti' }).waitFor();
    const closeAll = page.getByRole('button', { name: 'Chiudi tutte' });
    if (await closeAll.count()) await closeAll.click();
    for (const id of ids.slice(0, 20)) {
      await page.goto(`${base}/pazienti/${id}`);
      await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
      // La cartella entra nella barra con un effetto di React, subito dopo la pagina: ricaricando
      // la pagina successiva troppo presto (WebKit) la registrazione andava persa. Nell'uso vero
      // non si ricarica: la barra resta in memoria. Si aspetta che la barra la mostri.
      await tab(id).waitFor();
    }
    // La barra si aggiorna dopo la pagina: con i motori più lenti (WebKit) si aspetta un attimo.
    await expect.poll(() => bar.getByRole('link').count(), { timeout: 5000 }).toBe(20);
    await expect.poll(activeVisible, { timeout: 5000 }).toBe(true);
    await check(page, 'venti cartelle aperte', true);

    // La ventunesima: si chiude quella usata meno di recente, con l'avviso.
    await page.goto(`${base}/pazienti/${ids[20]}`);
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    await page.getByText(`chiusa quella di ${names.get(ids[0]!)}, usata meno di recente`).waitFor();
    await expect.poll(() => bar.getByRole('link').count(), { timeout: 5000 }).toBe(20);
    await expect(tab(ids[0]!).count()).resolves.toBe(0);
    await expect.poll(activeVisible, { timeout: 5000 }).toBe(true);
    for (const v of TABLETS) {
      await page.setViewportSize(v);
      // Il riposizionamento segue l'evento di ridimensionamento: si aspetta un attimo.
      await expect
        .poll(() => activeVisible(), { timeout: 2000, message: `tablet ${v.width}×${v.height}` })
        .toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Pagine nuove nelle schede: si torna alla pagina lasciata, con quello che si stava scrivendo.
    const [a, b] = [ids[20]!, ids[19]!];
    await page.goto(`${base}/pazienti/${a}/voci?tipo=diario`);
    await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    await page.getByLabel('Testo', { exact: true }).fill('Nota lasciata a metà.');
    await tab(b).click();
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    // Ciascuno il suo: mentre la nota del primo è in sospeso, la cartella dell'altro non la mostra.
    await page.goto(`${base}/pazienti/${b}/voci?tipo=diario`);
    await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
    await expect(page.getByLabel('Testo', { exact: true }).inputValue()).resolves.toBe('');
    await page.goto(`${base}/pazienti/${b}`);
    await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
    await page
      .getByRole('navigation', { name: 'Sezioni della cartella' })
      .getByRole('link', { name: 'Parametri' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Parametri' }).waitFor();
    await page.getByRole('textbox', { name: /^Peso/ }).fill('70');
    await tab(a).click();
    await page.waitForURL(`**/pazienti/${a}/voci?tipo=diario`);
    await expect(page.getByLabel('Testo', { exact: true }).inputValue()).resolves.toBe(
      'Nota lasciata a metà.',
    );
    await expect.poll(activeVisible, { timeout: 5000 }).toBe(true);
    // Registrata, la bozza non resta: tornando, il modulo è vuoto.
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Voce registrata.').waitFor();
    await expect(page.getByLabel('Testo', { exact: true }).inputValue()).resolves.toBe('');
    await tab(b).click();
    await page.waitForURL(`**/pazienti/${b}/parametri`);
    await expect(page.getByRole('textbox', { name: /^Peso/ }).inputValue()).resolves.toBe('70');
    await tab(a).click();
    await page.waitForURL(`**/pazienti/${a}/voci?tipo=diario`);
    await expect(page.getByLabel('Testo', { exact: true }).inputValue()).resolves.toBe('');
  });

  it('AURA (D197): «Aggiorna da AURA» porta l’esenzione con la sua fonte; la variazione è in Oggi', async () => {
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    // 013, diabete mellito (allegato 8 del DPCM LEA), su un assistito inventato del simulatore.
    aura.register({
      fiscalCode: rich!.fiscalCode,
      lastName: rich!.lastName,
      firstName: rich!.firstName,
      birthDate: rich!.birthDate,
      exemptions: [{ code: '013', prescriptionCode: null, validFrom: '2026-01-01', validTo: null }],
      choices: [],
    });
    await page.goto(`${base}/pazienti/${s.richPatient}/amministrazione`);
    const section = page.getByRole('region', { name: 'AURA, anagrafe regionale' });
    await section.getByText('Collegamento simulato', { exact: false }).waitFor();
    await section.getByRole('button', { name: 'Aggiorna da AURA' }).click();
    await section.getByText('Aggiornato da AURA: 1 variazione.').waitFor();
    await section.getByText('Allineato con AURA').waitFor();
    await section.getByRole('rowheader', { name: /Esenzione 013 dal 01\/01\/2026/ }).waitFor();
    await check(page, 'AURA nei dati amministrativi', true);
    const exemptions = page.getByRole('region', { name: 'Esenzioni' });
    const row = exemptions.getByRole('row', { name: /013/ });
    await row.getByText('AURA').waitFor();
    // L'esenzione arrivata da AURA non si modifica dal pannello.
    await expect(row.getByRole('button', { name: /Modifica/ }).count()).resolves.toBe(0);
    await page.goto(`${base}/`);
    const today = page.getByRole('region', { name: 'Variazioni da AURA' });
    await today.getByRole('link', { name: `${rich!.firstName} ${rich!.lastName}` }).waitFor();
    await check(page, 'variazioni da AURA in Oggi');
  });

  it('dopo l’inattività la sessione si blocca e si sblocca con il codice; le cartelle aperte restano', async () => {
    const bar = page.getByRole('navigation', { name: 'Cartelle aperte' });
    const before = await bar.getByRole('link').count();
    expect(before).toBeGreaterThan(1);
    s.clock.advance(6 * 60_000);
    await page.goto(`${base}/pazienti`);
    await page.getByRole('heading', { name: 'Sessione bloccata' }).waitFor();
    await check(page, 'sessione bloccata');
    const secret = s.secrets.get(s.users.titolare.id)!;
    s.clock.advance(30_000);
    await page.getByLabel('Codice a 6 cifre').fill(totp(secret, s.clock.now().getTime()));
    await page.getByRole('button', { name: 'Sblocca' }).click();
    await page.getByRole('heading', { level: 1, name: 'Pazienti' }).waitFor();
    await expect(bar.getByRole('link').count()).resolves.toBe(before);
  });

  // In fondo: cambia la password del sostituto, che le prove prima non usano più.
  it('ripristino con SPID o CIE senza sessione: nome utente, pagina simulata, password nuova (D189)', async () => {
    const [profile] = await t.db
      .select({ cf: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.sostituto.id));
    const anonymous = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'it-IT',
    });
    try {
      const p = await anonymous.newPage();
      await p.goto(base);
      await p.getByRole('link', { name: /Ripristina con SPID o CIE/ }).click();
      await p.getByRole('heading', { level: 1, name: 'Ripristino con SPID o CIE' }).waitFor();
      await check(p, 'avvio del ripristino', true);
      await p.getByLabel('Nome utente').fill(s.users.sostituto.username);
      await p.getByLabel('Postazione').fill('casa del sostituto');
      await p.getByRole('button', { name: 'Entra con SPID o CIE' }).click();
      // La pagina simulata, servita dal programma solo in prova.
      await p.getByRole('heading', { name: 'Accesso con SPID o CIE simulato' }).waitFor();
      await p.getByLabel('Codice fiscale di chi entra').fill(profile!.cf!);
      await p.getByRole('button', { name: 'Entra con SPID (simulato)' }).click();
      await p.getByText(/Riconosciuto con SPID/).waitFor();
      await check(p, 'password nuova del ripristino', true);
      await p.getByLabel('Nuova password', { exact: true }).fill('il sostituto ritrova la sua');
      await p.getByLabel('Ripeti la nuova password').fill('il sostituto ritrova la sua');
      await p.getByRole('button', { name: 'Salva la password nuova' }).click();
      await p.getByText('Credenziali ripristinate: entra con la password nuova.').waitFor();
      await p.getByRole('link', { name: 'Vai all’accesso' }).click();
      await p.getByLabel('Nome utente').fill(s.users.sostituto.username);
      await p.getByLabel('Password').fill('il sostituto ritrova la sua');
      await p.getByLabel('Postazione').fill('casa del sostituto');
      await p.getByRole('button', { name: 'Continua' }).click();
      await p.getByLabel('Codice a 6 cifre').waitFor();
    } finally {
      await anonymous.close();
    }
  });
});
