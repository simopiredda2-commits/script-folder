/**
 * Database di partenza della dimostrazione (D221), preparato in Node una volta per costruzione:
 * tutte le migrazioni e le banche dati d'esempio, cioè `sync/` lanciato sul sito d'esempio
 * (fixtures/banche-dati) e importato come fa `pnpm banche-dati:importa -- --esempio`. In più il
 * nomenclatore dei presidi degli allegati 2 e 3 del DPCM LEA (D218, D236) e il catalogo regionale
 * delle prestazioni del Piemonte, D.D. 590/2026 con le modifiche della D.D. 710/2026 (D159, D260),
 * che nel programma entrano solo dopo il controllo di una persona (A8): qui si vedono prima, e il
 * riquadro lo dice. Il catalogo vero prende il posto di quello d'esempio, nella stessa serie.
 * Nessun paziente: i dati dimostrativi si creano nel browser all'avvio, con le date di quel giorno.
 *
 *   tsx apps/demo/scripts/prepara-database.ts DESTINAZIONE.tar.gz
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { loadMappings, TRANSCRIPTION_DIRS } from '@mmg/reference';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from '../../api/src/db/client';
import { readMigrations } from '../../api/src/db/migrate';
import * as schema from '../../api/src/db/schema';
import {
  EXAMPLE_TRANSCRIPTIONS,
  EXAMPLES_DIR,
  runSyncOnExample,
  serveExampleSite,
  type ExampleSite,
} from '../../api/src/reference/example-site';
import { importReferenceData } from '../../api/src/reference/importer';

const dest = process.argv[2];
if (!dest) throw new Error('Indica il file da scrivere (.tar.gz)');

/**
 * Le trascrizioni che la dimostrazione mostra prima del controllo, per cartella: i presidi e le note
 * del nomenclatore del DPCM LEA (D276) e il catalogo regionale (la versione intera della D.D. 590 e
 * le due date della D.D. 710).
 */
const UNCHECKED_TRANSCRIPTIONS = {
  lea: ['allegato-2-ausili-monouso', 'allegato-3-presidi', 'allegato-4-note'],
  piemonte_catalogo: [
    'dd590-2026-allegato-a',
    'dd710-2026-dal-2026-10-30',
    'dd710-2026-dal-2027-01-13',
  ],
};
/**
 * La cartella delle trascrizioni del programma che ha la scheda: quella nazionale o quella di un
 * pacchetto regionale (D292).
 */
function transcriptionRoot(dir: string, base: string) {
  const root = TRANSCRIPTION_DIRS.find((d) => existsSync(join(d, dir, `${base}.json`)));
  if (!root) throw new Error(`Manca la trascrizione ${dir}/${base}`);
  return root;
}
/** «Controllato da» nella copia della dimostrazione: dice che nessuno l'ha controllata. */
const DEMO_UNCHECKED = 'nessuno: copia della dimostrazione, ancora da controllare (A8)';

/**
 * Farmaci (D256, D261): sul sito d'esempio le liste di AIFA di classe A e H intere al posto degli
 * estratti, e nell'anagrafica le righe d'esempio, che servono alle prove e alle simulazioni
 * (confezione sospesa, farmaco fuori dalle liste), più tutte le altre confezioni dell'anagrafica
 * AIFA intera: anche classe C, farmaci senza obbligo di prescrizione e confezioni non rimborsate.
 * `sync/` e l'importazione restano quelli veri.
 */
const DEMO_AIFA = join(import.meta.dirname, '..', 'dati', 'aifa');
const CLASS_LISTS = [
  'Classe-A_per_principio-attivo_30-6-2026.csv',
  'Classe-H_per_principio-attivo_30-6-2026.csv',
];
const unzip = (name: string) => gunzipSync(readFileSync(join(DEMO_AIFA, `${name}.gz`)));
/** Il codice AIC di una riga dell'anagrafica: comincia con il codice fra virgolette. */
const aicOf = (line: Buffer) => line.subarray(1, 10).toString('latin1');
const lines = (data: Buffer) => {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
    out.push(data.subarray(start, i));
    start = i + 1;
  }
  if (start < data.length) out.push(data.subarray(start));
  return out.filter((l) => l.length > 0);
};

function useDemoDrugs(site: ExampleSite) {
  for (const name of CLASS_LISTS)
    site.override(`aifa/documents/20142/3815901/${name}`, unzip(name));
  const example = lines(
    readFileSync(join(EXAMPLES_DIR, 'sito', 'aifa', 'farmaci', 'confezioni_fornitura.csv')),
  );
  const [header, ...rows] = lines(unzip('confezioni_fornitura.csv'));
  if (!header!.equals(example[0]!)) throw new Error('Anagrafica AIFA: intestazioni diverse');
  const known = new Set(example.slice(1).map(aicOf));
  const added = rows.filter((r) => !known.has(aicOf(r)));
  const all = [...example, ...added];
  site.override(
    'aifa/farmaci/confezioni_fornitura.csv',
    Buffer.concat(all.flatMap((l) => [l, Buffer.from('\n')])),
  );
  console.log(
    `Anagrafica AIFA intera: ${added.length} confezioni oltre alle ${known.size} d'esempio`,
  );
}

const work = mkdtempSync(join(tmpdir(), 'mmg-dimostrazione-'));
try {
  const syncDir = join(work, 'dati-pubblici');
  const site = await serveExampleSite();
  useDemoDrugs(site);
  try {
    const run = await runSyncOnExample(site, syncDir);
    if (run.code !== 0)
      throw new Error(`sync sul sito d'esempio: uscita ${run.code}\n${run.output}`);
  } finally {
    await site.close();
  }

  const pg = await PGlite.create();
  // Le migrazioni come le applica runMigrations: in ordine, ognuna nella sua transazione, con la
  // tabella che ne tiene le impronte.
  await pg.exec(`create table if not exists schema_migrations (
    tag text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now()
  )`);
  for (const m of readMigrations()) {
    await pg.transaction(async (tx) => {
      for (const statement of m.statements) await tx.exec(statement);
      await tx.query('insert into schema_migrations (tag, sha256) values ($1, $2)', [
        m.tag,
        m.sha256,
      ]);
    });
  }
  const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Database;
  const report = await importReferenceData({
    db,
    syncDir,
    transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
    mappings: loadMappings(),
    importedBy: 'dimostrazione nel browser (banche dati d’esempio)',
  });
  // Presidi e catalogo regionale: le trascrizioni del programma, copiate con chi le ha controllate.
  // Non vengono da sync (atti non scaricati): una cartella di sync vuota, perché i file d'esempio
  // sono già entrati sopra. Le modifiche della D.D. 710 partono dalla D.D. 590 (la versione prima
  // della loro data) e, alla stessa data del catalogo d'esempio, vince l'importazione più recente.
  const unchecked = join(work, 'trascrizioni-da-controllare');
  const noSync = join(work, 'senza-sync');
  mkdirSync(noSync);
  writeFileSync(join(noSync, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  for (const [dir, bases] of Object.entries(UNCHECKED_TRANSCRIPTIONS)) {
    mkdirSync(join(unchecked, dir), { recursive: true });
    for (const base of bases) {
      const root = transcriptionRoot(dir, base);
      const from = (ext: string) => join(root, dir, `${base}.${ext}`);
      cpSync(from('csv'), join(unchecked, dir, `${base}.csv`));
      const sheet = JSON.parse(readFileSync(from('json'), 'utf-8')) as Record<string, unknown>;
      writeFileSync(
        join(unchecked, dir, `${base}.json`),
        JSON.stringify({ ...sheet, controllato_da: DEMO_UNCHECKED }),
      );
    }
  }
  report.push(
    ...(await importReferenceData({
      db,
      syncDir: noSync,
      transcriptionsDir: unchecked,
      mappings: loadMappings(),
      importedBy:
        'dimostrazione nel browser (presidi e note del nomenclatore del DPCM LEA e catalogo regionale, da controllare)',
    })),
  );
  const refused = report.filter((r) => r.outcome !== 'importato' && r.outcome !== 'gia_importato');
  for (const r of report)
    console.log(`${r.file}: ${r.outcome}${r.rows ? `, ${r.rows} righe` : ''}`);
  if (refused.length)
    throw new Error(`Importazione non riuscita: ${refused.map((r) => r.file).join(', ')}`);
  // Per il caricamento nel browser: niente da ripulire dopo, tutto già scritto.
  await pg.exec('checkpoint');
  const dump = await pg.dumpDataDir('gzip');
  writeFileSync(dest, new Uint8Array(await dump.arrayBuffer()));
  console.log(`Database di partenza: ${dest}, ${(dump.size / 1e6).toFixed(1)} MB`);
  await pg.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
