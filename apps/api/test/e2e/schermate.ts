/**
 * Fotografa le schermate principali con i dati dimostrativi, per la revisione (docs/interfaccia.md).
 *
 *   pnpm db:seed && pnpm banche-dati:importa -- --esempio
 *   SCHERMATE_UTENTE=medico SCHERMATE_PASSWORD=… pnpm --filter @mmg/api exec tsx test/e2e/schermate.ts
 *
 * Vuole DATABASE_URL e APP_ENCRYPTION_KEY, e un medico che non ha ancora attivato il secondo
 * fattore (il primo accesso dopo il seed). Solo pazienti inventati; nessun sito esterno.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { chromium, type Page } from 'playwright';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createDatabase, createPool } from '../../src/db/client';
import { base32Decode } from '../../src/security/base32';
import { totp } from '../../src/security/totp';
import { buildWeb, serveWeb } from './serve-web';

const OUT = resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'schermate');
const user = process.env.SCHERMATE_UTENTE;
const password = process.env.SCHERMATE_PASSWORD;
if (!user || !password) throw new Error('Servono SCHERMATE_UTENTE e SCHERMATE_PASSWORD');

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDatabase(pool);
const app = buildApp({ db, config: { ...config, cookieSecure: false } });
const work = mkdtempSync(join(tmpdir(), 'mmg-schermate-'));
mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`  ${name}.png`);
}

try {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const web = await serveWeb(
    buildWeb(join(work, 'dist')),
    (app.server.address() as AddressInfo).port,
  );
  const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  // Lingua del browser italiana: i campi data si leggono gg/mm/aaaa, come in studio.
  const browser = await chromium.launch({
    env: { ...process.env, LANG: 'it_IT.UTF-8', LANGUAGE: 'it' },
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    locale: 'it-IT',
  });
  const page = await ctx.newPage();

  await page.goto(base);
  await shot(page, '01-accesso');
  await page.getByLabel('Nome utente').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Postazione').fill('Studio');
  await page.getByRole('button', { name: 'Continua' }).click();
  const secret = (await page.locator('.segreto').innerText()).replace(/\s/g, '');
  await page.getByLabel('Codice a 6 cifre').fill(totp(base32Decode(secret), Date.now()));
  await page.getByRole('button', { name: 'Entra' }).click();
  await page.getByRole('heading', { level: 1, name: 'Oggi' }).waitFor();
  await shot(page, '02-oggi');

  await page.goto(`${base}/pazienti`);
  await page.locator('.paziente-riga').first().waitFor();
  await shot(page, '03-pazienti');

  await page.goto(`${base}/ricette`);
  await page.getByRole('button', { name: 'Firma e invia' }).first().waitFor();
  await shot(page, '04-ricette-da-firmare');
  await page.getByRole('button', { name: 'Firma e invia' }).first().click();
  await page.getByText(/Ricetta inviata per/).waitFor();
  // Tappa 7: il promemoria subito dopo l'invio, con stampa e invio al paziente.
  const reminder = page.getByRole('region', { name: 'Promemoria della ricetta' }).first();
  await reminder.getByRole('button', { name: 'Invia' }).waitFor();
  await reminder.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '17-promemoria');
  // Il PDF del promemoria come lo riceve il paziente, in immagine (serve pdftoppm, di poppler).
  const href = await reminder.getByRole('link', { name: 'Promemoria (PDF)' }).getAttribute('href');
  const pdfPath = join(work, 'promemoria.pdf');
  writeFileSync(pdfPath, await (await page.request.get(`${base}${href}`)).body());
  execFileSync('pdftoppm', [
    '-png',
    '-r',
    '96',
    '-singlefile',
    pdfPath,
    join(OUT, '18-promemoria-pdf'),
  ]);
  console.log('  18-promemoria-pdf.png');

  // Il paziente della ricetta appena inviata: cartella, scheda della terapia con lo storico.
  const sent = await db.execute<{ patient_id: string; therapy_id: string }>(sql`
    select p.patient_id, l.therapy_id from prescription p
    join prescription_line l on l.prescription_id = p.id
    where p.status = 'sent' and l.therapy_id is not null order by p.sent_at desc limit 1`);
  const { patient_id: patientId, therapy_id: therapyId } = sent.rows[0]!;
  await page.goto(`${base}/pazienti/${patientId}`);
  await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
  await shot(page, '05-cartella');
  await page.goto(`${base}/pazienti/${patientId}/terapie/${therapyId}`);
  await page.locator('table').getByText(/NRE/).first().waitFor();
  await shot(page, '06-scheda-terapia-e-storico');

  await page.goto(`${base}/pazienti/${patientId}/ricetta`);
  await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('esempina');
  // Si aspetta il risultato della ricerca, non la terapia in corso (anche lei è un risultato).
  const esempina = page.locator('.risultato').filter({ hasText: 'ESEMPINA' });
  await esempina.waitFor();
  await esempina.getByRole('button', { name: 'Aggiungi' }).click();
  await page.getByRole('button', { name: 'Prepara la ricetta' }).click();
  await page.getByText(/Regole di prescrizione, versione/).waitFor();
  // I controlli in alto nella schermata, con un po' di spazio sopra.
  await page
    .getByRole('heading', { name: 'Controlli prima dell’invio' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -160));
  await shot(page, '07-ricetta-con-controlli');

  await page.goto(`${base}/pazienti/${patientId}/specialistica`);
  await page.getByLabel('Prestazione, branca o codice').fill('prova');
  await page.locator('.risultato').first().waitFor();
  await page.locator('.risultato').first().getByRole('button', { name: 'Aggiungi' }).click();
  await shot(page, '08-ricetta-specialistica');

  const withLabs = await db.execute<{ patient_id: string }>(
    sql`select patient_id from clinical_entry where kind = 'lab_result' limit 1`,
  );
  await page.goto(`${base}/pazienti/${withLabs.rows[0]!.patient_id}/esami`);
  await page.getByRole('table').waitFor();
  await shot(page, '09-esami');

  await page.goto(`${base}/banche-dati`);
  await page.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('provalina');
  await page.locator('.risultato').first().waitFor();
  await page
    .locator('.risultato')
    .first()
    .getByRole('button', { name: 'Mostra gli equivalenti' })
    .click();
  await page.getByRole('table').waitFor();
  await shot(page, '10-farmaci-ed-equivalenti');

  // Terapia completa (D80–D83), recapiti (D86) e archivio (D84).
  await page.goto(`${base}/pazienti/${patientId}/terapie/nuova`);
  await page.getByRole('heading', { level: 1, name: 'Nuova terapia' }).waitFor();
  const restart = page.getByRole('button', { name: 'Annulla le modifiche' });
  if (await page.getByRole('button', { name: 'Cambia farmaco' }).count()) {
    await restart.click();
    await page.goto(`${base}/pazienti/${patientId}/terapie/nuova`);
  }
  await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('provalina');
  const provalina = page.locator('.risultato').filter({ hasText: '28 compresse' });
  await provalina.waitFor();
  await provalina.getByRole('button', { name: 'Scegli' }).click();
  await page.getByLabel('Dose', { exact: true }).fill('1');
  await page.getByLabel('Unità', { exact: true }).selectOption('compressa');
  await page.getByLabel('Frequenza').selectOption('1 volta al giorno');
  await page.getByLabel('Momento').selectOption('la sera');
  await page.getByLabel('Via').selectOption('per bocca');
  await page.getByLabel('Istruzioni per il paziente').fill('Dopo cena.');
  await page.getByText('1 compressa una volta al giorno, la sera, per bocca').waitFor();
  await page
    .getByRole('heading', { name: 'Come si prende' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -260));
  await shot(page, '12-nuova-terapia');
  await page.getByRole('button', { name: 'Salva la scheda' }).click();
  await page.getByText('Terapia aggiunta.').waitFor();
  await page.getByRole('button', { name: 'Sospendi…' }).click();
  await page.getByLabel('Motivo della sospensione').fill('Eruzione cutanea dopo l’inizio');
  await page.getByLabel(/È una reazione avversa/).check();
  await page.getByLabel('Reazione osservata (facoltativa)').fill('Eritema diffuso');
  await shot(page, '13-sospensione');
  await page.getByRole('button', { name: 'Non sospendere' }).click();

  await page.goto(`${base}/pazienti/${patientId}/schema-orario`);
  await page.getByRole('heading', { name: 'Schema orario della terapia' }).waitFor();
  await shot(page, '14-schema-orario');

  await page.goto(`${base}/pazienti/${patientId}`);
  await page.getByRole('button', { name: 'Modifica i recapiti' }).click();
  await page
    .getByRole('heading', { name: 'Anagrafica e recapiti' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -120));
  await shot(page, '15-recapiti');

  await page.goto(`${base}/archivio`);
  await page.getByRole('heading', { level: 1, name: 'Archivio' }).waitFor();
  await page.getByLabel(/La segreteria legge il riepilogo clinico/).waitFor();
  await shot(page, '16-archivio');

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`${base}/pazienti/${patientId}`);
  await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
  await shot(page, '11-cartella-tablet');

  await browser.close();
  await new Promise((ok) => web.close(ok));
  console.log(`Schermate in ${OUT}`);
} finally {
  await app.close();
  await pool.end();
  rmSync(work, { recursive: true, force: true });
}
