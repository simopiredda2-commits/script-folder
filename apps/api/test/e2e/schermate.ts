/**
 * Fotografa le schermate principali con i dati dimostrativi, per la revisione (docs/interfaccia.md).
 *
 *   pnpm db:seed && pnpm banche-dati:importa -- --esempio
 *   SCHERMATE_UTENTE=medico SCHERMATE_PASSWORD=… \
 *     [SCHERMATE_AMMINISTRATORE=amministratore SCHERMATE_PASSWORD_AMMINISTRATORE=…] \
 *     pnpm --filter @mmg/api exec tsx test/e2e/schermate.ts
 *
 * Vuole DATABASE_URL e APP_ENCRYPTION_KEY, e un medico che non ha ancora attivato il secondo
 * fattore (il primo accesso dopo il seed); lo stesso per l'amministratore, se si danno le sue
 * credenziali (schermate della tappa 14 che vede solo lui). Solo pazienti inventati; nessun sito
 * esterno.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { generatePatients } from '@mmg/fixtures';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { referenceUpdatesFromConfig } from '../../src/reference/updates-service';
import { createDatabase, createPool } from '../../src/db/client';
import { studioDate } from '../../src/prescriptions/rules-check';
import { base32Decode } from '../../src/security/base32';
import { totp } from '../../src/security/totp';
import { buildWeb, serveWeb } from './serve-web';

const OUT = resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'schermate');
const user = process.env.SCHERMATE_UTENTE;
const password = process.env.SCHERMATE_PASSWORD;
if (!user || !password) throw new Error('Servono SCHERMATE_UTENTE e SCHERMATE_PASSWORD');
const adminUser = process.env.SCHERMATE_AMMINISTRATORE ?? 'amministratore';
const adminPassword = process.env.SCHERMATE_PASSWORD_AMMINISTRATORE;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDatabase(pool);
const work = mkdtempSync(join(tmpdir(), 'mmg-schermate-'));
// Aggiornamento delle banche dati sul sito d'esempio (D156), per la schermata degli strumenti.
const referenceUpdates = referenceUpdatesFromConfig(db, {
  dataDir: join(work, 'dati-pubblici'),
  sources: 'esempio',
  time: '03:30',
});
const app = buildApp({ db, config: { ...config, cookieSecure: false }, referenceUpdates });
mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage });
  console.log(`  ${name}.png`);
}

/** Primo accesso di un utente del seed: password, poi l'attivazione del secondo fattore. */
async function firstLogin(
  browser: Browser,
  base: string,
  username: string,
  secret: string,
  workstation = 'Studio',
) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    locale: 'it-IT',
  });
  const p = await ctx.newPage();
  await p.goto(base);
  await p.getByLabel('Nome utente').fill(username);
  await p.getByLabel('Password').fill(secret);
  await p.getByLabel('Postazione').fill(workstation);
  await p.getByRole('button', { name: 'Continua' }).click();
  const code = (await p.locator('.segreto').innerText()).replace(/\s/g, '');
  await p.getByLabel('Codice a 6 cifre').fill(totp(base32Decode(code), Date.now()));
  await p.getByRole('button', { name: 'Entra' }).click();
  await p.getByRole('heading', { level: 1, name: 'Oggi' }).waitFor();
  return { ctx, page: p };
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

  // Tappa 8: credenziali dei servizi; il codice di sessione serve prima di mandare le ricette.
  await page.locator('.utente').getByRole('link', { name: 'Credenziali' }).click();
  await page.getByRole('heading', { level: 1, name: 'Credenziali dei servizi' }).waitFor();
  await shot(page, '19-credenziali');
  for (const name of ['RUPAR Piemonte', 'Sistema TS']) {
    const card = page.getByRole('region', { name });
    await card.getByRole('button', { name: 'Chiedi il codice' }).click();
    await card.getByText(/Ambiente di prova/).waitFor();
    await card.getByRole('button', { name: 'Attiva' }).click();
    await card.getByText(/^Attivo fino a/).waitFor();
  }

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

  // Pazienti con un quadro adatto al farmaco della schermata (D150): dulaglutide a chi ha il
  // diabete tipo 2, l'amlodipina a un iperteso; il paziente principale ha il diabete tipo 1.
  const withProblem = async (code: string) => {
    const rows = await db.execute<{ id: string }>(sql`
      select p.id, p.last_name from patient p
      join clinical_entry c on c.patient_id = p.id and c.kind = 'problem'
      join problem_detail d on d.entry_id = c.id and d.icd_code = ${code}
      where p.id <> ${patientId} group by p.id, p.last_name order by p.last_name limit 1`);
    return rows.rows[0]!.id;
  };
  const diabetes2PatientId = await withProblem('250.00');
  const hypertensionPatientId = await withProblem('401.9');

  await page.goto(`${base}/pazienti/${diabetes2PatientId}/ricetta`);
  // Dulaglutide: in DPC con nota AIFA 100 e piano terapeutico (elenco della Regione Piemonte).
  await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('dulaglutide');
  // Si aspetta il risultato della ricerca, non la terapia in corso (anche lei è un risultato).
  const withPlan = page.locator('.risultato').filter({ hasText: 'TRULICITY' });
  await withPlan.waitFor();
  await withPlan.getByRole('button', { name: 'Aggiungi' }).click();
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
  await page.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('amlodipina');
  await page.locator('.risultato').first().waitFor();
  await page
    .locator('.risultato')
    .first()
    .getByRole('button', { name: 'Mostra gli equivalenti' })
    .click();
  await page.getByRole('table').waitFor();
  await shot(page, '10-farmaci-ed-equivalenti');

  // Terapia completa (D80–D83), recapiti (D86) e archivio (D84). La terapia nuova, scelta dalla
  // banca dati con il nome della confezione, va a un paziente iperteso: le schermate della
  // cartella del paziente principale restano senza nomi di ditte, per il sito (D149, D150).
  const otherPatientId = hypertensionPatientId;
  await page.goto(`${base}/pazienti/${otherPatientId}/terapie/nuova`);
  await page.getByRole('heading', { level: 1, name: 'Nuova terapia' }).waitFor();
  const restart = page.getByRole('button', { name: 'Annulla le modifiche' });
  if (await page.getByRole('button', { name: 'Cambia farmaco' }).count()) {
    await restart.click();
    await page.goto(`${base}/pazienti/${otherPatientId}/terapie/nuova`);
  }
  await page.getByLabel('Farmaco, principio attivo, codice AIC o ATC').fill('amlodipina');
  // Un generico che nessun paziente dimostrativo ha già in terapia.
  const chosen = page.locator('.risultato').filter({ hasText: 'AMLODIPINA EG' });
  await chosen.waitFor();
  await chosen.getByRole('button', { name: 'Scegli' }).click();
  await page.getByLabel('Dose', { exact: true }).fill('1');
  await page.getByLabel('Unità', { exact: true }).selectOption('compressa');
  await page.getByLabel('Frequenza').selectOption('1 volta al giorno');
  await page.getByLabel('Momento').selectOption('la sera');
  await page.getByLabel('Via', { exact: true }).selectOption('per bocca');
  await page.getByLabel('Istruzioni per il paziente').fill('Dopo cena.');
  // La lettura composta dalla scheda (la stessa frase può essere anche una posologia dello studio).
  await page
    .getByRole('paragraph')
    .filter({ hasText: '1 compressa una volta al giorno, la sera, per bocca' })
    .waitFor();
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

  // Tappa 9: voci cliniche, parametri con l'andamento, privacy, piani terapeutici (dati inventati).
  await page.goto(`${base}/pazienti/${patientId}/voci?tipo=problema`);
  await page.getByRole('heading', { level: 1, name: 'Voci cliniche' }).waitFor();
  // Una voce credibile per un trentenne con il diabete tipo 1 (D150).
  await page.getByLabel('Descrizione').fill('Ipotiroidismo');
  await page.getByLabel('Codice ICD-9-CM').fill('244.9');
  await page.getByLabel(/Patologia cronica/).check();
  await page
    .getByLabel('Inizio', { exact: true })
    .fill(studioDate(new Date(Date.now() - 400 * 86_400_000)));
  await page.getByRole('button', { name: 'Registra', exact: true }).click();
  await page.getByText('Voce registrata.').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  // Pagina intera: modulo ed elenco insieme.
  await shot(page, '24-voci-cliniche', true);

  await page.goto(`${base}/pazienti/${patientId}/parametri`);
  await page.getByRole('heading', { level: 1, name: 'Parametri' }).waitFor();
  for (const [days, pas, pad, weight] of [
    [270, '126', '82', '74,8'],
    [180, '124', '80', '75,2'],
    [90, '120', '78', '75,6'],
    [7, '118', '76', '76'],
  ] as const) {
    await page
      .getByLabel('Data', { exact: true })
      .fill(studioDate(new Date(Date.now() - days * 86_400_000)));
    await page.getByRole('textbox', { name: /Pressione sistolica/ }).fill(pas);
    await page.getByRole('textbox', { name: /Pressione diastolica/ }).fill(pad);
    await page.getByRole('textbox', { name: /^Peso/ }).fill(weight);
    await page.getByRole('button', { name: 'Registra', exact: true }).click();
    await page.getByText('Registrati 3 parametri.').waitFor();
  }
  const chart = page.getByRole('group', { name: /Pressione arteriosa: grafico/ });
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await page
    .getByRole('heading', { name: 'Andamento nel tempo' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shot(page, '25-parametri');

  await page.goto(`${base}/pazienti/${patientId}/privacy`);
  await page.getByRole('heading', { level: 1, name: 'Privacy' }).waitFor();
  await page.getByLabel('Consenso', { exact: true }).selectOption('fse_cura');
  await page.getByRole('button', { name: 'Registra il consenso' }).click();
  await page.getByText('Consenso registrato.').waitFor();
  await page.getByLabel('Consenso', { exact: true }).selectOption('fse_prevenzione_enti');
  await page.getByLabel('Nega il consenso').check();
  await page.getByRole('button', { name: 'Registra il consenso' }).click();
  await page.getByText('Consenso registrato.').waitFor();
  await page.getByLabel('Cognome e nome del delegato').fill('Delegato Dimostrativo');
  await page.getByLabel('Per che cosa vale').fill('Ritiro di ricette e promemoria');
  await page.getByRole('button', { name: 'Registra la delega' }).click();
  await page.getByText('Delega registrata.').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '26-privacy');

  await page.goto(`${base}/pazienti/${diabetes2PatientId}/piani`);
  await page.getByRole('heading', { level: 1, name: 'Piani terapeutici' }).waitFor();
  // Per principio attivo, con la descrizione AIFA del gruppo: nessun marchio a schermo (D149).
  await page
    .getByLabel('Farmaco', { exact: true })
    .fill("DULAGLUTIDE 1,5MG 4 UNITA' USO PARENTERALE");
  await page.getByLabel('Principio attivo').fill('DULAGLUTIDE');
  await page.getByLabel('Rilasciato il').fill(studioDate(new Date(Date.now() - 60 * 86_400_000)));
  await page.getByLabel('Scade il').fill(studioDate(new Date(Date.now() + 20 * 86_400_000)));
  await page.getByLabel('Confezioni autorizzate').fill('6');
  await page.getByLabel('Centro che l’ha rilasciato').fill('Diabetologia, centro dimostrativo');
  await page.getByRole('button', { name: 'Registra il piano' }).click();
  await page.getByText('Piano registrato.').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '27-piani-terapeutici', true);

  // Tappa 10: una ricetta specialistica inviata (dal catalogo d'esempio), poi il suo seguito con
  // un referto inventato; presidi per diabetici.
  const found = await page.request.get(`${base}/api/prestazioni?q=prova`);
  // Con il codice del nomenclatore: la riga della specialistica lo vuole (R10, D154).
  const service = (
    (await found.json()) as {
      prestazioni: { regionalCode: string; nationalCode: string | null; description: string }[];
    }
  ).prestazioni.find((p) => p.nationalCode)!;
  const draft = await page.request.post(`${base}/api/pazienti/${patientId}/ricette`, {
    data: {
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Controllo dimostrativo',
      lines: [
        {
          serviceCode: service.regionalCode,
          serviceNationalCode: service.nationalCode,
          serviceDescription: service.description,
          quantity: 1,
        },
      ],
    },
  });
  const draftId = ((await draft.json()) as { id: string }).id;
  const sentVisit = await page.request.post(`${base}/api/ricette/${draftId}/firma-e-invia`, {
    data: {},
  });
  if (!sentVisit.ok()) throw new Error(`Invio della specialistica: ${await sentVisit.text()}`);
  await page.goto(`${base}/pazienti/${patientId}/seguito`);
  await page.getByRole('heading', { level: 1, name: 'Seguito delle prestazioni' }).waitFor();
  await page
    .getByRole('button', { name: /Registra (l’esecuzione|una seduta)/ })
    .first()
    .click();
  await page.getByLabel('Struttura').fill('Poliambulatorio dimostrativo');
  await page.getByLabel('Esito').fill('Esito dimostrativo: paziente inventato.');
  await page.getByLabel(/Referto \(PDF o immagine/).setInputFiles({
    name: 'referto-dimostrativo.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% referto dimostrativo\n%%EOF\n', 'latin1'),
  });
  await page.getByRole('button', { name: 'Registra', exact: true }).click();
  await page.getByText('Esecuzione registrata.').waitFor();
  await shot(page, '28-seguito-prestazioni');

  await page.goto(`${base}/pazienti/${patientId}/presidi`);
  await page.getByRole('heading', { level: 1, name: 'Presidi e assistenza integrativa' }).waitFor();
  await page.getByLabel('Categoria').selectOption('diabetici');
  await page.getByLabel('Prodotto').fill('Strisce reattive per glicemia');
  await page.getByLabel('Fabbisogno al mese').fill('50');
  await page.getByLabel('Unità').fill('strisce');
  await page.getByRole('button', { name: 'Registra la prescrizione' }).click();
  await page.getByText('Prescrizione registrata.').waitFor();
  await page.getByLabel('Categoria').selectOption('medicazione_avanzata');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '29-presidi', true);

  // Tappa 8: certificato di malattia di un lavoratore adulto con la residenza in anagrafica.
  const adult = await db.execute<{ id: string }>(sql`
    select id from patient
    where birth_date < current_date - interval '18 years'
      and residence_street is not null and residence_town is not null
      and residence_province ~ '^[A-Za-z]{2}$'
    order by last_name, first_name limit 1`);
  const worker = adult.rows[0]!.id;
  // Dalla cartella, come fa il medico: così il paziente è tra le cartelle aperte.
  await page.goto(`${base}/pazienti/${worker}`);
  await page.getByRole('link', { name: 'Certificati', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Certificati di malattia' }).waitFor();
  await page.getByRole('button', { name: 'Nuovo certificato' }).click();
  await page
    .getByLabel('Prognosi a tutto il')
    .fill(studioDate(new Date(Date.now() + 2 * 86_400_000)));
  await page.getByLabel('Codice ICD-9-CM').fill('487.1');
  await page.getByLabel('Diagnosi', { exact: true }).fill('Sindrome influenzale');
  // I dati dimostrativi non hanno il CAP: il medico lo completa nel certificato (inventato).
  await page
    .getByRole('group', { name: 'Residenza o domicilio abituale' })
    .getByLabel('CAP')
    .fill('00000');
  await page.getByRole('button', { name: 'Salva e controlla' }).click();
  await page.getByText('Nessun problema nei controlli: si può inviare.').waitFor();
  await shot(page, '20-certificato');
  await page.getByRole('button', { name: 'Firma e invia all’INPS' }).click();
  const certificate = page.locator('.scheda-certificato').filter({ hasText: 'Inviato' }).first();
  await certificate.getByText(/protocollo SIM\d+/).waitFor();
  await shot(page, '21-certificati');
  for (const [link, file] of [
    ['Copia per il lavoratore (PDF)', '22-certificato-copia'],
    ['Attestato (PDF)', '23-certificato-attestato'],
  ] as const) {
    const url = await certificate.getByRole('link', { name: link }).getAttribute('href');
    const path = join(work, `${file}.pdf`);
    writeFileSync(path, await (await page.request.get(`${base}${url}`)).body());
    execFileSync('pdftoppm', ['-png', '-r', '96', '-singlefile', path, join(OUT, file)]);
    console.log(`  ${file}.png`);
  }

  // Tappa 11: Profilo Sanitario Sintetico, dalla cartella al Fascicolo (simulatore del Gateway).
  await page.goto(`${base}/pazienti/${patientId}`);
  await page
    .getByRole('navigation', { name: 'Sezioni della cartella' })
    .getByRole('link', { name: 'Profilo sanitario sintetico' })
    .click();
  await page.getByRole('heading', { level: 1, name: 'Profilo sanitario sintetico' }).waitFor();
  await page.getByRole('button', { name: 'Prepara il Profilo dalla cartella' }).click();
  await page.getByText('Bozza preparata dalla cartella.').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '30-profilo-sanitario-bozza', true);
  await page.getByLabel('Ho controllato il contenuto del Profilo, voce per voce').check();
  await page.getByRole('button', { name: 'Valida con il Gateway' }).click();
  await page.getByText('Validato dal Gateway. Ora puoi firmarlo e pubblicarlo.').waitFor();
  await page.getByRole('button', { name: 'Firma e pubblica' }).click();
  await page.getByText('Profilo firmato e pubblicato nel Fascicolo.').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '31-profilo-sanitario-pubblicato');
  const pssHref = await page
    .getByRole('link', { name: 'PDF firmato della versione 1' })
    .getAttribute('href');
  const pssPath = join(work, 'profilo-sanitario.pdf');
  writeFileSync(pssPath, await (await page.request.get(`${base}${pssHref}`)).body());
  execFileSync('pdftoppm', [
    '-png',
    '-r',
    '96',
    '-singlefile',
    pssPath,
    join(OUT, '32-profilo-sanitario-pdf'),
  ]);
  console.log('  32-profilo-sanitario-pdf.png');
  await page.goto(`${base}/profilo/recapiti`);
  await page.getByRole('heading', { level: 1, name: 'Recapiti di studio' }).waitFor();
  await shot(page, '33-recapiti-di-studio');
  // Le impostazioni del Fascicolo (D133): dalla tappa 14 la pagina apre una sezione alla volta.
  await page.goto(`${base}/strumenti?sezione=fascicolo`);
  await page.getByRole('heading', { level: 2, name: 'Fascicolo Sanitario Elettronico' }).waitFor();
  await shot(page, '34-strumenti', true);

  // Tappa 13: modelli ufficiali e proposti (D158, D160), e il certificato della patente.
  await page.goto(`${base}/strumenti?sezione=modelli`);
  await page.getByRole('heading', { level: 2, name: 'Modelli ufficiali e proposti' }).waitFor();
  await shot(page, '36-modelli', true);
  await page.goto(`${base}/pazienti/${patientId}/certificati-modelli`);
  await page.getByRole('heading', { level: 1, name: 'Altri certificati' }).waitFor();
  await page.getByLabel('Modello').selectOption('patente-anamnestico');
  for (const g of await page.locator('form fieldset.scelta-in-riga').all())
    await g.getByRole('radio').first().check();
  await page
    .getByRole('group', { name: 'In cura presso il medico' })
    .getByLabel('da un anno o più')
    .check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '37-certificato-patente', true);

  // D156, D192: aggiornamento delle banche dati, avviato da chi gestisce il servizio con il comando
  // sul server; lo studio vede com'è andato.
  await (
    await referenceUpdates.start('comando', 'riga di comando (schermate)')
  ).done;
  await page.goto(`${base}/strumenti?sezione=banche-dati`);
  await page
    .getByText('Comando sul server (riga di comando (schermate))', { exact: false })
    .first()
    .waitFor();
  await shot(page, '38-banche-dati', true);

  // Tappa 12: AFT. La prima volta il medico la crea; poi condivide i pazienti con il consenso.
  await page.goto(`${base}/strumenti?sezione=aft`);
  await page
    .getByRole('heading', { level: 2, name: 'Aggregazione funzionale territoriale' })
    .waitFor();
  if (await page.getByRole('button', { name: 'Crea l’AFT' }).count()) {
    await page.getByLabel('Nome dell’AFT').fill('AFT dimostrativa');
    await page.getByLabel('Azienda sanitaria (facoltativo)').fill('ASL dimostrativa');
    await page.getByRole('button', { name: 'Crea l’AFT' }).click();
  }
  await page.getByRole('table', { name: 'Medici dell’AFT nel programma' }).waitFor();
  const sharing = page.getByLabel(
    'Condivido con i medici dell’AFT la scheda dei miei pazienti che hanno dato il consenso',
  );
  if (!(await sharing.isChecked())) await sharing.check();
  await shot(page, '39-aft', true);

  await page.goto(`${base}/archivio`);
  await page.getByRole('heading', { level: 1, name: 'Archivio' }).waitFor();
  await page.getByLabel(/La segreteria legge il riepilogo clinico/).waitFor();
  await shot(page, '16-archivio');

  // Tappa 14: autorizzazioni sull'archivio e avvisi sugli accessi anomali (D177).
  await page
    .getByRole('table', { name: /Autorizzazioni date sull’archivio/ })
    .scrollIntoViewIfNeeded();
  await page.getByRole('heading', { level: 2, name: 'Avvisi sugli accessi anomali' }).waitFor();
  await shot(page, '50-archivio-autorizzazioni-e-avvisi', true);

  // Tappa 14: elenchi dello studio e registro di amministrazione (D175, D177).
  await page.goto(`${base}/strumenti?sezione=elenchi&elenco=posologia`);
  await page.getByRole('table', { name: /Posologie in uso/ }).waitFor();
  await shot(page, '40-elenchi-dello-studio', true);
  await page.goto(`${base}/strumenti?sezione=registro`);
  await page
    .getByRole('heading', { level: 2, name: 'Registro delle azioni di amministrazione' })
    .waitFor();
  await shot(page, '41-registro-di-amministrazione', true);

  // Tappa 15: importazione a passi con un CSV di pazienti inventati, fino alla prova senza
  // scrivere (D173): le cartelle dimostrative non cambiano.
  // Solo adulti, come in tutte le schermate (D149).
  const people = generatePatients({ seed: 'schermate-importazione', count: 40 })
    .filter((x) => x.birthDate < '2000-01-01')
    .slice(0, 4);
  const csv = [
    'Codice fiscale;Cognome;Nome;Sesso;Data di nascita',
    ...people.map((x) => [x.fiscalCode, x.lastName, x.firstName, x.sex, x.birthDate].join(';')),
  ].join('\r\n');
  await page.goto(`${base}/strumenti?sezione=importazione`);
  await page.getByLabel('File da importare').setInputFiles({
    name: 'pazienti-inventati.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf-8'),
  });
  await page.getByRole('button', { name: 'Carica e leggi il file' }).click();
  await page.getByRole('heading', { level: 4, name: 'File letto' }).waitFor();
  await page.getByRole('button', { name: 'Avanti: dove vanno i dati' }).click();
  await page.getByRole('heading', { level: 3, name: '2. Dove vanno i dati' }).waitFor();
  await shot(page, '42-importazione-destinazioni', true);
  await page.getByRole('button', { name: 'Avanti: colonne e campi' }).click();
  await page.getByRole('button', { name: 'Mostra l’anteprima' }).click();
  await page.getByRole('button', { name: 'Avanti: prova senza scrivere' }).click();
  await page.getByRole('button', { name: 'Fai la prova (non scrive nulla)' }).click();
  await page.getByText('Prova finita: nessun dato è stato scritto.').waitFor();
  await shot(page, '43-importazione-prova', true);

  // Tappa 15: pannello amministrativo del paziente (D169).
  await page.goto(`${base}/pazienti/nuovo`);
  await page.getByRole('heading', { level: 1, name: 'Nuovo paziente' }).waitFor();
  await shot(page, '44-nuovo-paziente', true);
  await page.goto(`${base}/pazienti/${patientId}/amministrazione`);
  await page.getByRole('heading', { level: 2, name: 'Canale del promemoria' }).waitFor();
  await shot(page, '45-dati-amministrativi', true);

  // Tappa 15: menu che mancavano (D176).
  await page.goto(`${base}/pazienti/${patientId}/esami`);
  await page.getByRole('heading', { level: 2, name: 'Nuovo referto di laboratorio' }).waitFor();
  await shot(page, '46-esami-e-referto', true);
  await page.goto(`${base}/pazienti/${patientId}/voci`);
  await page.getByRole('button', { name: 'Vaccinazioni' }).click();
  await page.locator('.voce').filter({ hasText: 'Vaccino antinfluenzale dimostrativo' }).waitFor();
  await shot(page, '47-vaccinazioni', true);
  await page.goto(`${base}/pazienti/${patientId}/farmaci`);
  await page
    .getByRole('heading', { level: 2, name: /Farmaci prescritti con un altro programma/ })
    .waitFor();
  await shot(page, '48-farmaci-prescritti-con-un-altro-programma', true);
  const ended = await db.execute<{ id: string }>(sql`
    select id from therapy where patient_id = ${patientId} and status = 'ended' limit 1`);
  if (ended.rows[0]) {
    await page.goto(`${base}/pazienti/${patientId}/terapie/${ended.rows[0].id}`);
    await page.getByText(/Terapia conclusa il/).waitFor();
    await shot(page, '49-terapia-conclusa');
  }

  // Tappa 14: le schede che vede solo l'amministratore, se si danno le sue credenziali.
  if (adminPassword) {
    // Dalla postazione dell'ambulatorio: «Questa postazione» mostra le sue preferenze di stampa.
    const admin = await firstLogin(browser, base, adminUser, adminPassword, 'Ambulatorio');
    // Una segreteria nuova (inventata): aspetta la conferma di un medico titolare (D179).
    await admin.page.goto(`${base}/strumenti?sezione=utenti`);
    const form = admin.page.getByRole('form', { name: 'Nuovo utente' });
    await form.getByLabel('Nome utente').fill('segreteria.pomeriggio');
    await form.getByLabel('Nome mostrato').fill('Segreteria del pomeriggio');
    await form.getByLabel('Segreteria', { exact: true }).check();
    await form.getByRole('button', { name: 'Crea l’utente' }).click();
    await admin.page.getByText('Utente creato: Segreteria del pomeriggio.').waitFor();
    for (const [sezione, title, name] of [
      ['utenti', 'Utenti e ruoli', '51-utenti-e-ruoli'],
      ['studio', 'Dati e impostazioni dello studio', '52-dati-dello-studio'],
      ['stampa', 'Postazioni dello studio', '53-postazioni-e-stampa'],
      ['servizio', 'Stato del servizio', '54-stato-del-servizio'],
    ] as const) {
      await admin.page.goto(`${base}/strumenti?sezione=${sezione}`);
      await admin.page.getByRole('heading', { level: 2, name: title }).waitFor();
      await shot(admin.page, name, true);
    }
    await admin.ctx.close();
    // Il medico titolare la trova fra gli utenti da confermare, con chi l'ha chiesta e quando.
    await page.goto(`${base}/strumenti?sezione=conferme`);
    await page
      .getByRole('table', { name: 'Utenti in attesa della conferma di un medico titolare' })
      .getByText('segreteria.pomeriggio')
      .waitFor();
    await shot(page, '55-utenti-da-confermare', true);
  } else console.log('  (schermate dell’amministratore saltate: manca la sua password)');

  // Tappa 16 (D188): un blocco inventato del conto della segreteria, con indirizzi di
  // documentazione (RFC 5737); il medico titolare vede l'avviso nella cornice e la pagina.
  const secretaries = await db.execute<{ id: string; studio_id: string }>(sql`
    select id, studio_id from app_user where 'secretary' = any(roles) order by username limit 1`);
  const secretary = secretaries.rows[0];
  if (secretary) {
    await db.execute(sql`
      insert into account_lock
        (studio_id, user_id, reason, failures, locked_at, locked_until, addresses, workstations)
      values (${secretary.studio_id}, ${secretary.id}, 'passwords', 50, now(),
        now() + interval '15 minutes', array['192.0.2.10', '192.0.2.11'], array['pc-fuori'])`);
    await page.goto(base);
    await page.getByRole('link', { name: 'Vedi i blocchi' }).waitFor();
    await shot(page, '56-avviso-dei-blocchi');
    await page.getByRole('link', { name: 'Vedi i blocchi' }).click();
    await page.getByRole('heading', { level: 1, name: 'Blocchi del conto' }).waitFor();
    await shot(page, '57-blocchi-del-conto', true);
  }

  // Tappa 16 (D189): ripristino con SPID o CIE, senza sessione; la pagina di SPID è il simulatore.
  const doctors = await db.execute<{ fiscal_code: string }>(sql`
    select p.fiscal_code from app_user u join doctor_profile p on p.user_id = u.id
    where u.username = ${user}`);
  const anonymous = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    locale: 'it-IT',
  });
  const anon = await anonymous.newPage();
  await anon.goto(`${base}/ripristino`);
  await anon.getByRole('heading', { level: 1, name: 'Ripristino con SPID o CIE' }).waitFor();
  await shot(anon, '58-ripristino-con-spid-o-cie');
  const fiscalCode = doctors.rows[0]?.fiscal_code;
  if (fiscalCode) {
    await anon.getByLabel('Nome utente').fill(user);
    await anon.getByLabel('Postazione').fill('Casa');
    await anon.getByRole('button', { name: 'Entra con SPID o CIE' }).click();
    await anon.getByLabel('Codice fiscale di chi entra').fill(fiscalCode);
    await anon.getByRole('button', { name: 'Entra con SPID (simulato)' }).click();
    await anon.getByText(/Riconosciuto con SPID/).waitFor();
    await shot(anon, '59-ripristino-password-nuova');
  }
  await anonymous.close();

  // Più cartelle aperte insieme (D68, D129): una scheda per paziente nella barra sotto il menu,
  // quella attiva in giallo; ogni scheda riporta all'ultima pagina vista di quel paziente.
  const others = await db.execute<{ id: string }>(sql`
    select id from patient where id <> ${patientId} order by last_name, first_name limit 4`);
  for (const { id } of others.rows) {
    await page.goto(`${base}/pazienti/${id}`);
    await page.getByRole('heading', { name: 'Problemi attivi' }).waitFor();
  }
  await page.goto(`${base}/pazienti/${patientId}`);
  await page.getByRole('heading', { name: 'Terapia in corso' }).waitFor();
  const tabs = page.getByRole('navigation', { name: 'Cartelle aperte' }).getByRole('link');
  if ((await tabs.count()) < 5) throw new Error('Servono almeno cinque cartelle aperte');
  await shot(page, '35-cartelle-aperte');

  // Su tablet la barra delle cartelle scorre e tiene in vista quella attiva.
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
