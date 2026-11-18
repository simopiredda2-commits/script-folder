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
import { buildWeb, serveWeb } from './serve-web';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf-8');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MIN_TARGET = 44;
const TABLETS = [
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];
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

  it('promemoria dopo l’invio: PDF del modello, solo NRE, email al paziente (tappa 7)', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/ricetta`);
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
    await page.goto(`${base}/pazienti/${s.richPatient}/ricetta`);
    await page.getByRole('heading', { level: 1, name: 'Nuova ricetta' }).waitFor();
    await page.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ }).click();
    await page.getByLabel(/Oscura nome e indirizzo/).waitFor();
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('provalina');
    const item = page.locator('.risultato').filter({ hasText: '28 compresse' });
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

  it('la stessa prestazione già prescritta: l’editor lo dice subito, con data e NRE', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/specialistica`);
    await page.getByRole('heading', { level: 1, name: 'Ricetta specialistica' }).waitFor();
    const restart = page.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
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
      // La segreteria non scrive le terapie e non ha un archivio suo.
      await expect(sec.getByRole('link', { name: 'Nuova terapia' }).count()).resolves.toBe(0);
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
    await page.goto(`${base}/pazienti/${s.richPatient}/ricetta`);
    await page.getByRole('heading', { level: 1, name: 'Nuova ricetta' }).waitFor();
    // La ricetta inviata in una prova precedente è ricordata: si ricomincia da capo.
    const restart = page.getByRole('button', { name: /Nuova ricetta da capo|Ricomincia/ });
    if (await restart.count()) await restart.click();
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('provalina');
    const item = page.locator('.risultato').filter({ hasText: '14 compresse' });
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
    await page.locator('.riga-ricetta').filter({ hasText: '14 compresse' }).waitFor();
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
    await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('provalina');
    const item = page.locator('.risultato').filter({ hasText: '28 compresse' });
    await item.waitFor();
    await item.getByRole('button', { name: 'Scegli' }).click();
    await page.getByRole('button', { name: 'Cambia farmaco' }).waitFor();
    await page.getByLabel('Dose', { exact: true }).fill('1');
    await page.getByLabel('Unità', { exact: true }).selectOption('compressa');
    await page.getByLabel('Frequenza').selectOption('2 volte al giorno');
    await page.getByLabel('Momento').selectOption('la sera');
    await page.getByLabel('Via').selectOption('per bocca');
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
    await page.getByRole('heading', { level: 1, name: /PROVALINA 28 compresse/ }).waitFor();
    newTherapyUrl = page.url();
    await check(page, 'scheda della terapia nuova', true);
  });

  it('modifica della scheda: unità al giorno corrette a mano, poi salvate', async () => {
    await page.goto(newTherapyUrl);
    await page.getByRole('link', { name: 'Modifica', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: /Modifica: PROVALINA/ }).waitFor();
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
      .getByText(/Terapia sospesa\. La reazione a principio di prova è ora tra le allergie/)
      .waitFor();
    await page.locator('.testata-avvisi').getByText('Allergia: principio di prova').waitFor();
    await page.getByText(/Motivo: Reazione cutanea di prova/).waitFor();
    await check(page, 'terapia sospesa', true);
    await page.goto(`${base}/pazienti/${s.richPatient}`);
    await page.getByRole('heading', { name: 'Terapie sospese' }).waitFor();
    await page.getByRole('link', { name: /PROVALINA 28 compresse/ }).click();
    await page.getByRole('button', { name: 'Riprendi' }).click();
    await page.getByText('Terapia ripresa: è di nuovo tra quelle in corso.').waitFor();
  });

  it('schema orario stampabile: momenti della giornata, fino a quando, istruzioni', async () => {
    await page.goto(`${base}/pazienti/${s.richPatient}/schema-orario`);
    await page.getByRole('heading', { name: 'Schema orario della terapia' }).waitFor();
    const evening = page.getByRole('region', { name: 'Sera' });
    await evening.getByText(/PROVALINA 28 compresse/).waitFor();
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
    await page.getByRole('link', { name: 'Certificati' }).click();
    await page.getByRole('heading', { level: 1, name: 'Certificati di malattia' }).waitFor();
    await page.getByRole('button', { name: 'Nuovo certificato' }).click();
    const end = studioDate(new Date(s.clock.now().getTime() + 2 * 86_400_000));
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
    await page.getByLabel('Codice ICD-9-CM').fill('401.9');
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
    await page
      .getByLabel('Scade il')
      .fill(studioDate(new Date(s.clock.now().getTime() + 90 * 86_400_000)));
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
