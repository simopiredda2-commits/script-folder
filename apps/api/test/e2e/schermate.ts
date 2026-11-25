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
import { buildFiscalCode } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { EMPTY_AURA_REGISTRY, SimulatedAura } from '@mmg/integrations';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { referenceUpdatesFromConfig } from '../../src/reference/updates-service';
import { createDatabase, createPool } from '../../src/db/client';
import { withActor } from '../../src/db/tx';
import { DEMO_REFERENCE_DATE } from '../../src/db/demo';
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
// AURA simulata (D197): l'anagrafe parte vuota; più sotto ci entra un paziente dimostrativo.
const aura = new SimulatedAura();
const app = buildApp({
  db,
  config: { ...config, cookieSecure: false },
  referenceUpdates,
  aura: { gateway: aura },
  // SCHERMATE_REGISTRO=1: il servizio scrive le sue richieste e i suoi errori.
  logger: process.env.SCHERMATE_REGISTRO === '1',
});
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
  await page.locator('.utente-apri').click();
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
  // Il PDF del promemoria come lo riceve il paziente, in immagine (serve pdftoppm, di poppler):
  // mezzo foglio A4 (specifiche del 28/02/2024, D217), la pagina A5 orizzontale per difetto
  // (D222); con la carta A4 lo stesso riquadro prende la metà alta della pagina.
  const href = await reminder.getByRole('link', { name: 'Promemoria (PDF)' }).getAttribute('href');
  const pdfPath = join(work, 'promemoria.pdf');
  writeFileSync(pdfPath, await (await page.request.get(`${base}${href}`)).body());
  execFileSync('pdftoppm', [
    '-png',
    '-r',
    '120',
    '-W',
    '993',
    '-H',
    '702',
    '-singlefile',
    pdfPath,
    join(OUT, '18-promemoria-pdf'),
  ]);
  console.log('  18-promemoria-pdf.png');
  // La ricetta appena firmata è fra le confermate, con il menu di stampa e invio e «Archivia
  // ricette confermate» (D254).
  await page.getByRole('button', { name: /^Archivia ricette confermate/ }).waitFor();
  await page
    .getByRole('heading', { level: 2, name: 'Confermate' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, '76-ricette-confermate');

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

  // Ricetta rossa (D270): una ricetta rimasta «in invio» da 20 minuti, come dopo un arresto del
  // servizio mentre aspettava il SAR. Il medico la stampa sul modulo del Poligrafico e la segue in
  // «Ricette rosse in DPCM». Modulo d'esempio della regione dello studio (010, il Piemonte).
  const stuck = await db.execute<{ id: string }>(sql`
    insert into prescription
      (patient_id, archive_id, kind, status, prepared_by, prepared_at, signed_by, signed_at)
    select p.patient_id, p.archive_id, 'pharma_ssn', 'sending', p.prepared_by,
      now() - interval '30 minutes', p.signed_by, now() - interval '20 minutes'
    from prescription p where p.status = 'sent' and p.patient_id = ${patientId}
    order by p.sent_at desc limit 1
    returning id`);
  await db.execute(sql`
    insert into prescription_line (prescription_id, position, therapy_id, drug_aic, drug_name,
      active_ingredient, by_active_ingredient, quantity)
    select ${stuck.rows[0]!.id}, 1, t.id, t.drug_aic, t.drug_name, t.active_ingredient,
      t.by_active_ingredient, 1
    from therapy t where t.id = ${therapyId}`);
  await page.goto(`${base}/ricette#senza-risposta`);
  const interrupted = page.getByRole('region', { name: 'Invii senza risposta' });
  await interrupted.getByRole('button', { name: 'Stampa la ricetta rossa' }).first().click();
  const form = interrupted.getByRole('group', { name: 'Ricetta rossa sul modulo del Poligrafico' });
  await form.getByLabel(/Numero del modulo nella stampante/).fill('010260000000202');
  await form.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await shot(page, '77-ricetta-rossa-modulo');
  await form.getByRole('button', { name: 'Prepara la ricetta rossa' }).click();
  await interrupted.getByText(/Ricetta rossa pronta sul modulo/).waitFor();
  const red = page.getByRole('region', { name: 'Ricette rosse in DPCM' });
  await red.getByRole('button', { name: 'Invia adesso' }).click();
  await red
    .getByText(/^(Mandata|Accolta)$/)
    .first()
    .waitFor();
  await page
    .getByRole('heading', { level: 2, name: 'Ricette rosse in DPCM' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, '78-ricette-rosse-dpcm');

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
  // Si aspetta il risultato della ricerca: i farmaci prescritti, sotto, hanno righe loro (D246).
  const withPlan = page.locator('.risultato').filter({ hasText: 'TRULICITY' });
  await withPlan.waitFor();
  await withPlan.getByRole('button', { name: 'Aggiungi' }).click();
  await page.getByRole('button', { name: 'Salva in bozza' }).click();
  await page.getByText(/Regole di prescrizione, versione/).waitFor();
  // I controlli in alto nella schermata, con un po' di spazio sopra.
  await page
    .getByRole('heading', { name: 'Controlli prima dell’invio' })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -160));
  await shot(page, '07-ricetta-con-controlli');

  // I farmaci prescritti dentro «Nuova ricetta» (D246): una riga per farmaco; una, con
  // un'ultima ricetta, aperta col «+» per vedere i dati e le ultime ricette con l'NRE.
  await page.goto(`${base}/pazienti/${patientId}/ricetta`);
  const prescribed = page.getByRole('list', { name: 'Farmaci prescritti' });
  const withLast = prescribed
    .getByRole('listitem')
    .filter({ has: page.locator('.farmaco-ultima-data') })
    .first();
  await withLast.waitFor();
  await withLast.locator('.farmaco-apri').click();
  await withLast.getByRole('list', { name: /^Ultime ricette di / }).waitFor();
  await shot(page, '75-farmaci-prescritti-nella-ricetta');

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
  // D220: aprire il Fascicolo regionale dalla cartella (simulatore del modulo del CSI).
  await page.goto(`${base}/pazienti/${patientId}`);
  await page
    .getByRole('navigation', { name: 'Sezioni della cartella' })
    .getByRole('link', { name: 'Fascicolo regionale', exact: true })
    .click();
  await page.getByRole('heading', { level: 1, name: 'Fascicolo regionale' }).waitFor();
  await page.getByLabel('Documenti da mostrare').selectOption({ label: 'Referto di laboratorio' });
  await shot(page, '74-fascicolo-regionale');
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

  // D156: aggiornamento delle banche dati, avviato dall'amministratore dello studio.
  await page.goto(`${base}/strumenti?sezione=banche-dati`);
  await page.getByRole('button', { name: 'Aggiorna adesso' }).click();
  await page.getByText(/Pulsante «Aggiorna adesso» \(/).waitFor({ timeout: 120_000 });
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

  // Tappa 14: autorizzazioni sull'archivio (D177), nella loro sezione (D244).
  await page.goto(`${base}/archivio?sezione=autorizzazioni`);
  await page.getByRole('table', { name: /Autorizzazioni date sull’archivio/ }).waitFor();
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
  await page.goto(`${base}/pazienti/${patientId}/amministrazione#promemoria`);
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

  // In fondo, per non cambiare le schermate di prima: di nuovo lo schermo del computer.
  await page.setViewportSize({ width: 1280, height: 900 });
  // AURA (D197): un paziente dimostrativo con il diabete riceve dal simulatore l'esenzione 013
  // (diabete mellito, allegato 8 del DPCM LEA); «Aggiorna da AURA» la porta nella cartella.
  const diabetic = (
    await db.execute<{ id: string; cf: string; ln: string; fn: string; bd: string }>(sql`
      select p.id, p.fiscal_code as cf, p.last_name as ln, p.first_name as fn,
        p.birth_date::text as bd
      from patient p
      join clinical_entry e on e.patient_id = p.id
      join problem_detail d on d.entry_id = e.id
      where d.icd_code like '250%' and e.status = 'active'
      order by p.last_name, p.first_name
      limit 1`)
  ).rows[0];
  if (!diabetic) throw new Error('Serve un paziente dimostrativo con il diabete');
  const diabeticAura = aura.register({
    fiscalCode: diabetic.cf,
    lastName: diabetic.ln,
    firstName: diabetic.fn,
    birthDate: diabetic.bd,
    exemptions: [{ code: '013', prescriptionCode: null, validFrom: '2026-01-01', validTo: null }],
    choices: [],
  });
  await page.goto(`${base}/pazienti/${diabetic.id}/amministrazione#aura`);
  const auraSection = page.getByRole('region', { name: 'AURA, anagrafe regionale' });
  await auraSection.getByRole('button', { name: 'Aggiorna da AURA' }).click();
  await auraSection.getByText('Aggiornato da AURA: 1 variazione.').waitFor();
  await auraSection.scrollIntoViewIfNeeded();
  await shot(page, '60-aura-nei-dati-amministrativi');

  // D198: AURA manda un'anagrafica diversa (dati inventati): differenze da confermare.
  aura.setRegistry(diabeticAura, {
    residenceStreet: 'Via dei Dati Inventati',
    residenceNumber: '12',
    asl: 'ASL dimostrativa nuova',
  });
  // La notifica di AURA basta di solito; la segreteria può anche premere «Aggiorna da AURA».
  const arrived = async () =>
    (
      await db.execute<{ ok: boolean }>(
        sql`select registry is not null as ok from aura_link where patient_id = ${diabetic.id}`,
      )
    ).rows[0]?.ok === true;
  for (let i = 0; i < 100 && !(await arrived()); i++) await new Promise((r) => setTimeout(r, 50));
  console.log(`  notifica di AURA ${(await arrived()) ? 'arrivata' : 'non arrivata'}`);
  await page.goto(`${base}/pazienti/${diabetic.id}/amministrazione#aura`);
  await auraSection.getByRole('button', { name: 'Aggiorna da AURA' }).click();
  await auraSection.getByText(/^Aggiornato da AURA/).waitFor();
  const pending = auraSection.getByRole('heading', {
    name: 'Anagrafica diversa in AURA, da confermare',
  });
  await pending.waitFor();
  await pending.scrollIntoViewIfNeeded();
  await shot(page, '62-anagrafica-da-aura-da-confermare');

  // Un altro paziente dimostrativo: AURA segnala il decesso, da confermare (in evidenza in Oggi).
  const other = (
    await db.execute<{ id: string; cf: string; ln: string; fn: string; bd: string }>(sql`
      select id, fiscal_code as cf, last_name as ln, first_name as fn, birth_date::text as bd
      from patient
      where id <> ${diabetic.id} and status = 'active'
      order by birth_date, last_name
      limit 1`)
  ).rows[0];
  if (!other) throw new Error('Serve un secondo paziente dimostrativo in carico');
  aura.register({
    fiscalCode: other.cf,
    lastName: other.ln,
    firstName: other.fn,
    birthDate: other.bd,
    exemptions: [],
    choices: [],
    registry: {
      ...EMPTY_AURA_REGISTRY,
      deceasedOn: studioDate(new Date(Date.now() - 2 * 86_400_000)),
    },
  });
  await page.goto(`${base}/pazienti/${other.id}/amministrazione#aura`);
  await auraSection.getByRole('button', { name: 'Aggiorna da AURA' }).click();
  await auraSection.getByText('Aggiornato da AURA: 1 variazione.').waitFor();
  await page.goto(base);
  await page
    .getByRole('region', { name: 'Variazioni da AURA' })
    .getByText(/AURA segnala il decesso/)
    .waitFor();
  await shot(page, '61-variazioni-da-aura-in-oggi', true);

  // D199: due assistiti inventati scelgono il medico dimostrativo in AURA, uno con una scelta
  // temporanea; la notifica li porta fra i nuovi assistiti nella pagina Oggi.
  const doctorCf = (
    await db.execute<{ cf: string }>(sql`
      select fiscal_code as cf from doctor_profile where regional_code = 'DEMO-0001'`)
  ).rows[0]!.cf;
  const today = studioDate(new Date());
  const newOnes = generatePatients({
    seed: 'schermate-nuovi-assistiti',
    count: 2,
    minAge: 18,
    referenceDate: DEMO_REFERENCE_DATE,
  });
  for (const [i, n] of newOnes.entries()) {
    const id = aura.register({
      fiscalCode: n.fiscalCode,
      lastName: n.lastName.toUpperCase(),
      firstName: n.firstName.toUpperCase(),
      birthDate: n.birthDate,
      exemptions: [],
      choices: [],
      registry: {
        ...EMPTY_AURA_REGISTRY,
        residenceTown: 'COMUNE DIMOSTRATIVO',
        asl: 'ASL DIMOSTRATIVA',
      },
    });
    aura.setChoice(id, {
      doctorFiscalCode: doctorCf,
      chosenOn: today,
      expiresOn: i === 1 ? studioDate(new Date(Date.now() + 120 * 86_400_000)) : null,
      endedOn: null,
      endReason: null,
    });
  }
  const signalled = async () =>
    Number(
      (
        await db.execute<{ n: string }>(
          sql`select count(*)::text as n from aura_new_patient where status = 'da_registrare'`,
        )
      ).rows[0]!.n,
    );
  for (let i = 0; i < 100 && (await signalled()) < 2; i++)
    await new Promise((r) => setTimeout(r, 50));
  await page.goto(base);
  const newRegion = page.getByRole('region', { name: 'Nuovi assistiti in AURA' });
  await newRegion.getByRole('table', { name: 'Nuovi assistiti da registrare' }).waitFor();
  await newRegion.scrollIntoViewIfNeeded();
  await shot(page, '63-nuovi-assistiti-in-oggi');

  // D199: il paziente temporaneo si registra in un passo solo, con la scadenza della scelta.
  const [temporary] = generatePatients({
    seed: 'schermate-temporaneo',
    count: 1,
    minAge: 18,
    referenceDate: DEMO_REFERENCE_DATE,
  });
  await page.goto(`${base}/pazienti/nuovo`);
  await page.getByRole('heading', { level: 1, name: 'Nuovo paziente' }).waitFor();
  await page.getByLabel('Cognome').fill(temporary!.lastName);
  await page.getByLabel('Nome', { exact: true }).fill(temporary!.firstName);
  await page.getByLabel(temporary!.sex === 'M' ? 'Maschile' : 'Femminile').check();
  await page.getByLabel('Data di nascita').fill(temporary!.birthDate);
  await page.getByLabel('Codice catastale del luogo di nascita').fill(temporary!.birthPlace.code);
  await page.getByLabel('Codice fiscale').fill(temporary!.fiscalCode);
  await page.getByLabel('Temporaneo, con la scadenza della scelta').check();
  await page
    .getByLabel('Scadenza della scelta', { exact: true })
    .fill(studioDate(new Date(Date.now() + 180 * 86_400_000)));
  await page.getByRole('group', { name: 'Stato' }).scrollIntoViewIfNeeded();
  await shot(page, '64-nuovo-paziente-temporaneo');

  // D199: confermato il decesso segnalato da AURA, la ricetta non si fa (R19).
  await page.goto(`${base}/pazienti/${other.id}/amministrazione#aura`);
  await auraSection.getByRole('button', { name: 'Conferma il decesso' }).click();
  await auraSection.getByRole('button', { name: 'Sì, conferma il decesso' }).click();
  await auraSection
    .getByText(/decesso/i)
    .first()
    .waitFor();
  await page.goto(`${base}/pazienti/${other.id}/ricetta`);
  await page.getByText(/la ricetta non si fa/).waitFor();
  await shot(page, '65-ricetta-paziente-deceduto');

  // D200: un secondo titolare dello studio, inventato e senza accesso, con il suo archivio. Un
  // paziente dimostrativo della Dott.ssa Marchi lo sceglie in AURA: il cambio è da decidere in Oggi.
  const colleague = (
    await db.execute<{ id: string; studio: string }>(sql`
      insert into app_user (studio_id, username, display_name, password_hash, roles)
      select a.studio_id, 'collega.dimostrativo', 'Dott. Paolo Serra', 'nessun accesso',
        array['owner_doctor']::user_role[]
      from archive a join doctor_profile d on d.user_id = a.owner_user_id
      where d.regional_code = 'DEMO-0001'
      returning id, studio_id as studio`)
  ).rows[0]!;
  const colleagueCf = buildFiscalCode({
    surname: 'Serra',
    name: 'Paolo',
    birthDate: '1972-02-02',
    sex: 'M',
    placeCode: 'X001',
  });
  await db.execute(sql`
    insert into doctor_profile (user_id, regional_code, asl, first_name, last_name, fiscal_code)
    values (${colleague.id}, 'DEMO-0003', 'ASL dimostrativa', 'Paolo', 'Serra', ${colleagueCf})`);
  await db.execute(sql`
    insert into archive (studio_id, owner_user_id, name)
    values (${colleague.studio}, ${colleague.id}, 'Archivio del Dott. Serra')`);
  const moving = (
    await db.execute<{ id: string; cf: string; ln: string; fn: string; bd: string }>(sql`
      select id, fiscal_code as cf, last_name as ln, first_name as fn, birth_date::text as bd
      from patient
      where id not in (${diabetic.id}, ${other.id}) and status = 'active'
      order by birth_date desc, last_name
      limit 1`)
  ).rows[0];
  if (!moving) throw new Error('Serve un terzo paziente dimostrativo in carico');
  const chosenOn = studioDate(new Date(Date.now() - 86_400_000));
  aura.register({
    fiscalCode: moving.cf,
    lastName: moving.ln,
    firstName: moving.fn,
    birthDate: moving.bd,
    exemptions: [],
    choices: [
      {
        doctorFiscalCode: doctorCf,
        chosenOn: '2015-01-01',
        expiresOn: null,
        endedOn: chosenOn,
        endReason: 'Scelta di un altro medico',
      },
      { doctorFiscalCode: colleagueCf, chosenOn, expiresOn: null, endedOn: null, endReason: null },
    ],
  });
  await page.goto(`${base}/pazienti/${moving.id}/amministrazione#aura`);
  await auraSection.getByRole('button', { name: 'Aggiorna da AURA' }).click();
  await auraSection.getByText(/^Aggiornato da AURA/).waitFor();
  await page.goto(base);
  const changesRegion = page.getByRole('region', { name: 'Cambi di medico nello studio' });
  await changesRegion.getByRole('table', { name: 'Pazienti da spostare' }).waitFor();
  await changesRegion.scrollIntoViewIfNeeded();
  await shot(page, '66-cambio-di-medico-in-oggi');

  // D201: i riepiloghi dell'archivio, dall'inizio dell'anno a oggi.
  const thisDay = studioDate(new Date());
  await page.goto(`${base}/archivio/riepiloghi?dal=${thisDay.slice(0, 4)}-01-01&al=${thisDay}`);
  await page.getByRole('table', { name: 'Ricette fatte nell’archivio, per tipo' }).waitFor();
  await shot(page, '67-riepiloghi', true);

  // D202: la ricerca con la carenza e gli equivalenti. Per la documentazione, non per il sito: la
  // carenza è di una confezione, che porta il nome della ditta (D149).
  await page.goto(`${base}/banche-dati`);
  await page.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('amlodipina');
  const tevaResult = page.locator('.risultato').filter({ hasText: 'AMLODIPINA TEVA ITALIA' });
  await tevaResult.getByText(/^Farmaco carente:/).waitFor();
  const docResult = page.locator('.risultato').filter({ hasText: 'AMLODIPINA DOC GENERICI' });
  await docResult.getByRole('button', { name: 'Mostra gli equivalenti' }).click();
  await docResult
    .getByRole('table', { name: 'Medicinali dello stesso gruppo di equivalenza' })
    .waitFor();
  await shot(page, '68-farmaco-carente-ed-equivalenti', true);

  // D202: un iperteso dimostrativo prende l'amlodipina in quella confezione; in Oggi il farmaco
  // carente è fra le cose da fare, con il paziente.
  const amlodipine = (
    await db.execute<{ id: string }>(sql`
      select t.id from therapy t join patient p on p.id = t.patient_id
      where t.active_ingredient = 'AMLODIPINA' and t.status = 'active'
      order by p.last_name, p.first_name limit 1`)
  ).rows[0];
  if (!amlodipine) throw new Error('Serve una terapia dimostrativa con l’amlodipina');
  const me = (
    await db.execute<{ id: string }>(sql`select id from app_user where username = ${user}`)
  ).rows[0]!;
  await withActor(db, me.id, (tx) =>
    tx.execute(sql`
      update therapy set drug_aic = '038548032', by_active_ingredient = false,
        drug_name = 'AMLODIPINA TEVA ITALIA 5 MG COMPRESSE- 28 COMPRESSE IN BLISTER PVC/PVDC/AL'
      where id = ${amlodipine.id}`),
  );
  await page.goto(base);
  const shortHeading = page.getByRole('heading', { name: 'Farmaci in terapia carenti' });
  await shortHeading.waitFor();
  // La sezione è in fondo a «Da fare»: in alto nella schermata, con un po' di quello che c'è sopra.
  await shortHeading.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -320);
  });
  await shot(page, '69-farmaci-carenti-in-oggi');

  // D205: lo stesso paziente prende anche la ranitidina, in una confezione che l'anagrafica AIFA
  // d'esempio dà «Sospesa» (riga vera del 20/11/2026); in Oggi la variazione è fra le cose da fare.
  // Per la documentazione, non per il sito: la confezione porta il nome della ditta (D149).
  await withActor(db, me.id, (tx) =>
    tx.execute(sql`
      insert into therapy (patient_id, drug_aic, drug_name, active_ingredient, atc, kind, start_on,
        created_by)
      select patient_id, '034471021',
        'RANITIDINA DOC GENERICI 300 MG COMPRESSE RIVESTITE CON FILM- 20 COMPRESSE',
        'RANITIDINA CLORIDRATO', 'A02BA02', 'chronic', start_on, ${me.id}
      from therapy where id = ${amlodipine.id}`),
  );
  await page.goto(base);
  const changesHeading = page.getByRole('heading', {
    name: 'Variazioni AIFA sui farmaci in terapia',
  });
  await changesHeading.waitFor();
  await changesHeading.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -120);
  });
  await shot(page, '70-variazioni-aifa-in-oggi');

  // D206: i registri e i piani terapeutici AIFA nei dati del farmaco (righe vere dell'elenco).
  await page.goto(`${base}/banche-dati`);
  await page.getByLabel('Nome commerciale, principio attivo, codice AIC o ATC').fill('entresto');
  await page
    .locator('.risultato')
    .filter({ hasText: 'ENTRESTO' })
    .getByRole('link', { name: 'scheda di ENTRESTO sul sito di AIFA' })
    .waitFor();
  await shot(page, '71-registri-aifa', true);

  // D212: prestazioni aggiuntive del mese scorso per due pazienti dimostrativi dell'archivio del
  // medico, registrate dalla cartella; la distinta del mese è pronta da controllare e mandare.
  const [yearNow, monthNow] = studioDate(new Date()).split('-').map(Number) as [number, number];
  const ppipMonth =
    monthNow === 1 ? `${yearNow - 1}-12` : `${yearNow}-${String(monthNow - 1).padStart(2, '0')}`;
  const ppipPatients = (
    await db.execute<{ id: string }>(sql`
      select p.id from patient p join archive a on a.id = p.archive_id
      where a.owner_user_id = ${me.id} and p.status = 'active' and p.deceased_on is null
      order by p.last_name, p.first_name limit 2`)
  ).rows;
  if (ppipPatients.length < 2) throw new Error('Servono due pazienti dimostrativi attivi');
  const ppipRows = [
    { patient: ppipPatients[1]!.id, day: '06', code: 'A1', quantity: '1', home: false },
    { patient: ppipPatients[1]!.id, day: '07', code: 'A2', quantity: '1', home: false },
    { patient: ppipPatients[0]!.id, day: '12', code: 'B2', quantity: '5', home: true },
    { patient: ppipPatients[0]!.id, day: '19', code: 'A4', quantity: '1', home: true },
  ];
  for (const r of ppipRows) {
    await page.goto(`${base}/pazienti/${r.patient}/prestazioni-aggiuntive`);
    await page.getByLabel('Data dell’esecuzione').fill(`${ppipMonth}-${r.day}`);
    await page.getByLabel('Prestazione', { exact: true }).selectOption(r.code);
    if (r.code.startsWith('B')) {
      await page
        .getByLabel(/^Estremi dell’autorizzazione/)
        .fill('Distretto di prova, autorizzazione n. 12');
    }
    await page.getByLabel('Quantità').fill(r.quantity);
    if (r.home) await page.getByLabel('A domicilio').check();
    await page.getByRole('button', { name: 'Registra la prestazione' }).click();
    await page.getByText('Prestazione registrata.').waitFor();
  }
  // In cartella: una vaccinazione della campagna in corso di registrazione, con la nota della voce.
  await page.getByLabel('Prestazione', { exact: true }).selectOption('B4');
  await page.getByText(/^Eseguibili con autorizzazione complessiva/).waitFor();
  await shot(page, '72-prestazioni-aggiuntive-in-cartella', true);
  await page.goto(`${base}/archivio/prestazioni-aggiuntive?mese=${ppipMonth}`);
  await page.getByRole('table', { name: /, una riga per prestazione$/ }).waitFor();
  await shot(page, '73-distinta-prestazioni-aggiuntive', true);

  await browser.close();
  await new Promise((ok) => web.close(ok));
  console.log(`Schermate in ${OUT}`);
} finally {
  await app.close();
  await pool.end();
  rmSync(work, { recursive: true, force: true });
}
