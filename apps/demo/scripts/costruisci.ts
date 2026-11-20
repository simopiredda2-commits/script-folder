/**
 * Costruisce la dimostrazione da pubblicare come artifact (D221).
 *
 *   pnpm --filter @mmg/demo build
 *
 * 1. Vite costruisce pagina e Worker in dist/.
 * 2. prepara-database.ts scrive il database di partenza (migrazioni e banche dati d'esempio).
 * 3. In dist/artifact/: pagina.html, il contenuto della pagina con stili e codice incorporati
 *    (l'artifact aggiunge da sé html, head e body), i file da pubblicare accanto, file.json con
 *    l'elenco e i tipi, e index.html, la pagina intera per provarla in locale.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';

const HERE = join(import.meta.dirname, '..');
const DIST = join(HERE, 'dist');
const OUT = join(DIST, 'artifact');
const require = createRequire(import.meta.url);
const PGLITE = dirname(require.resolve('@electric-sql/pglite'));

// Con DIMOSTRAZIONE_LEGGIBILE=1 il codice non si minifica: per leggere gli errori.
const readable = process.env.DIMOSTRAZIONE_LEGGIBILE === '1';
execFileSync(
  join(HERE, 'node_modules', '.bin', 'vite'),
  ['build', ...(readable ? ['--minify', 'false'] : [])],
  { cwd: HERE, stdio: 'inherit' },
);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const databaseFile = join(DIST, 'database.tar.gz');
execFileSync(
  join(HERE, '..', '..', 'node_modules', '.bin', 'tsx'),
  [join(HERE, 'scripts', 'prepara-database.ts'), databaseFile],
  { cwd: HERE, stdio: 'inherit' },
);
for (const name of ['pglite.wasm', 'initdb.wasm'])
  copyFileSync(join(PGLITE, name), join(OUT, name));
// L'artifact serve solo tipi noti: i dati binari vanno come testo in base64 (server.ts li
// ricostruisce). I dati di PGlite si comprimono prima; il database è già compresso.
writeFileSync(
  join(OUT, 'pglite-dati.txt'),
  gzipSync(readFileSync(join(PGLITE, 'pglite.data')), { level: 9 }).toString('base64'),
);
writeFileSync(join(OUT, 'database.txt'), readFileSync(databaseFile).toString('base64'));

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const pick = (re: RegExp, what: string) => {
  const m = re.exec(html);
  if (!m) throw new Error(`Nella pagina di Vite manca ${what}`);
  return m[1]!;
};
const title = pick(/<title>([\s\S]*?)<\/title>/, 'il titolo');
const script = pick(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/, 'il codice');
const style = pick(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/, 'lo stile');
const body = pick(/<body>([\s\S]*?)<\/body>/, 'il corpo')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

/**
 * L'artifact non accetta file di testo con caratteri di controllo o con il carattere di
 * sostituzione U+FFFD: nelle librerie stanno dentro stringhe di dati (pdf.js, pdf-lib, la
 * decodifica UTF-8), scritti in chiaro dal minificatore. In JavaScript «\\x1b» e «\\ufffd» valgono
 * gli stessi caratteri. Se il carattere è già preceduto da una barra rovesciata che lo rende un
 * escape, si aggiunge solo il codice dopo quella barra.
 */
const SPECIAL = new RegExp(String.raw`(\\*)([\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd])`, 'g');
function escapeControls(code: string): string {
  return code.replace(SPECIAL, (_m, slashes: string, c: string) => {
    const n = c.charCodeAt(0);
    const escape = n > 0xff ? `u${n.toString(16)}` : `x${n.toString(16).padStart(2, '0')}`;
    return slashes.length % 2 ? `${slashes}${escape}` : `${slashes}\\${escape}`;
  });
}

// Il codice va dentro <script>: nessuna sequenza che chiuda il tag prima del tempo.
const js = escapeControls(readFileSync(join(DIST, script), 'utf8')).replaceAll(
  '</script',
  '<\\/script',
);
if (js.includes('<!--'))
  throw new Error('Il codice contiene «<!--»: va trattato prima di incorporarlo');
const css = readFileSync(join(DIST, style), 'utf8').replaceAll('</style', '<\\/style');

/** I file che il codice chiama accanto alla pagina: il Worker del servizio e quello di pdf.js. */
const referenced = [
  ...js.matchAll(/new URL\(\s*[`"']([^`"'/]+\.m?js)[`"']\s*,\s*import\.meta\.url\s*\)/g),
].map((m) => m[1]!);
if (referenced.length < 2)
  throw new Error(
    `Attesi il Worker del servizio e quello di pdf.js, trovati: ${referenced.join(', ')}`,
  );
for (const name of referenced)
  writeFileSync(join(OUT, name), escapeControls(readFileSync(join(DIST, name), 'utf8')));

const page = `<title>${title}</title>
<style>
${css}
</style>
${body}
<script type="module">
${js}
</script>
`;
writeFileSync(join(OUT, 'pagina.html'), page);
writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html>\n<html lang="it">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${page}</body>\n</html>\n`,
);

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};
const files = [...referenced, 'pglite.wasm', 'initdb.wasm', 'pglite-dati.txt', 'database.txt'].map(
  (name) => ({
    name,
    type: TYPES[name.slice(name.lastIndexOf('.'))]!,
    bytes: statSync(join(OUT, name)).size,
  }),
);
writeFileSync(join(OUT, 'file.json'), `${JSON.stringify(files, null, 2)}\n`);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
console.log(`\nPagina: ${mb(page.length)} · ${basename(OUT)}/`);
for (const f of files) console.log(`  ${f.name.padEnd(36)} ${f.type.padEnd(26)} ${mb(f.bytes)}`);
