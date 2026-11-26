/**
 * Costruzione della dimostrazione nel browser (D221): l'interfaccia di apps/web e, in un Web
 * Worker, il servizio di apps/api con PGlite. I moduli di Node vanno ai sostituti di
 * src/worker/shims; i file che il servizio legge dal disco entrano in un disco virtuale.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// Import relativo: la configurazione di Vite gira in Node e deve includere il file nel suo bundle.
import { COMPANY_BRAND, PRODUCT_NAME } from '../../packages/brand/brand';

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

/**
 * I dati dei pacchetti regionali che il servizio legge mentre lavora (D295): le tabelle RAO e le
 * corrispondenze per il SIAP di ogni pacchetto, `packages/regions/<chiave>/data/…`. Le trascrizioni
 * no: entrano nel database di partenza (scripts/prepara-database.ts).
 */
const REGIONAL_RUNTIME_DATA = ['rao', 'siap'];
const regionalRuntimeFiles = () =>
  readdirSync(join(REPO, 'packages', 'regions'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => REGIONAL_RUNTIME_DATA.map((kind) => `packages/regions/${e.name}/data/${kind}`))
    .filter((rel) => existsSync(join(REPO, rel)));

/** Cartelle e file che il servizio legge mentre lavora, sotto /repo nel disco virtuale. */
const RUNTIME_FILES = [
  'apps/api/caratteri',
  'apps/api/distinte',
  'apps/api/modelli',
  'packages/integrations/fse-ufficiale',
  'packages/reference/data/mappature.json',
  'packages/reference/data/rao',
  'packages/reference/data/ricerca-prestazioni.json',
  'packages/reference/data/siap',
  'packages/rules/data',
  ...regionalRuntimeFiles(),
];
const BINARY = new Set(['.ttf', '.otf', '.woff', '.woff2', '.pdf', '.png', '.jpg', '.gz', '.zip']);
/** Chiavi RSA di prova per i simulatori del Fascicolo (rsa.ts): nuove a ogni costruzione. */
const TEST_KEYS = 4;

const shim = (name: string) => join(HERE, 'src', 'worker', 'shims', `${name}.ts`);
/** Sostituti in CommonJS: chi fa require() riceve il valore, non lo spazio dei nomi. */
const cjs = (name: string) => join(HERE, 'src', 'worker', 'shims', `${name}.cjs`);
const NODE_MODULES: Record<string, string> = {
  assert: cjs('assert'),
  'assert/strict': cjs('assert'),
  async_hooks: shim('async-hooks'),
  buffer: require.resolve('buffer/'),
  child_process: shim('child-process'),
  crypto: shim('crypto'),
  diagnostics_channel: shim('diagnostics-channel'),
  dns: shim('empty'),
  events: require.resolve('events/'),
  fs: shim('fs'),
  'fs/promises': shim('fs'),
  http: shim('http'),
  http2: shim('empty'),
  https: shim('http'),
  module: shim('empty'),
  net: shim('net'),
  os: shim('os'),
  path: require.resolve('path-browserify'),
  perf_hooks: shim('perf-hooks'),
  pg: shim('pg'),
  process: cjs('process'),
  stream: join(dirname(require.resolve('readable-stream')), 'browser.js'),
  string_decoder: require.resolve('string_decoder/'),
  tls: shim('empty'),
  url: shim('url'),
  util: shim('util'),
  worker_threads: shim('empty'),
  zlib: shim('empty'),
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const aliases = Object.entries(NODE_MODULES).map(([name, target]) => ({
  find: new RegExp(`^(node:)?${escape(name)}$`),
  replacement: target,
}));

/** Il programma usa la sua posizione sul disco (import.meta.dirname/url): diventa /repo/… */
function repositoryPaths(): Plugin {
  const roots = ['apps/api/src', 'packages', 'fixtures'].map((r) => join(REPO, r) + sep);
  return {
    name: 'dimostrazione-percorsi',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (file.includes(`${sep}node_modules${sep}`) || !roots.some((r) => file.startsWith(r)))
        return;
      if (!code.includes('import.meta.dirname') && !code.includes('import.meta.url')) return;
      const rel = relative(REPO, file).split(sep).join('/');
      const dir = `/repo/${dirname(rel)}`;
      return {
        code: code
          .replaceAll('import.meta.dirname', JSON.stringify(dir))
          .replaceAll('import.meta.url', JSON.stringify(`file:///repo/${rel}`)),
        map: null,
      };
    },
  };
}

function listFiles(rel: string): string[] {
  const abs = join(REPO, rel);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => listFiles(`${rel}/${name}`));
}

/** I moduli virtuali: il disco del servizio e la scorta di chiavi di prova. */
function virtualModules(): Plugin {
  const ids = { 'virtual:demo-fs': '\0demo-fs', 'virtual:demo-rsa-keys': '\0demo-rsa-keys' };
  return {
    name: 'dimostrazione-moduli-virtuali',
    resolveId(id) {
      return ids[id as keyof typeof ids];
    },
    load(id) {
      if (id === ids['virtual:demo-fs']) {
        const files: Record<string, { text?: string; base64?: string }> = {};
        for (const rel of RUNTIME_FILES.flatMap(listFiles)) {
          const bytes = readFileSync(join(REPO, rel));
          files[`/repo/${rel}`] = BINARY.has(extname(rel).toLowerCase())
            ? { base64: bytes.toString('base64') }
            : { text: bytes.toString('utf8') };
        }
        return `export default ${JSON.stringify(files)};`;
      }
      if (id === ids['virtual:demo-rsa-keys']) {
        const keys = Array.from({ length: TEST_KEYS }, () =>
          generateKeyPairSync('rsa', { modulusLength: 2048 })
            .privateKey.export({ type: 'pkcs8', format: 'der' })
            .toString('base64'),
        );
        return `export default ${JSON.stringify(keys)};`;
      }
      return undefined;
    },
  };
}

/**
 * Nell'interfaccia i cambi di pagina (window.location.assign) passano dal navigatore della
 * dimostrazione (src/navigation.ts): nell'artifact un cambio di pagina la farebbe perdere.
 */
function demoNavigation(): Plugin {
  const web = join(REPO, 'apps', 'web', 'src') + sep;
  return {
    name: 'dimostrazione-navigazione',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!file.startsWith(web) || !code.includes('window.location.assign(')) return;
      return {
        code: code.replaceAll('window.location.assign(', 'globalThis.__dimostrazioneVai!('),
        map: null,
      };
    },
  };
}

/** Nome del prodotto e marchio dalla pagina del marchio, come in apps/web (regola 6). */
function productTitle(): Plugin {
  return {
    name: 'titolo-prodotto',
    transformIndexHtml: (html) =>
      html
        .replaceAll('%NOME_PRODOTTO%', PRODUCT_NAME)
        .replaceAll('%MARCHIO_AZIENDA%', COMPANY_BRAND),
  };
}

export default defineConfig({
  root: HERE,
  base: './',
  plugins: [repositoryPaths(), virtualModules(), demoNavigation(), react(), productTitle()],
  resolve: { alias: aliases, dedupe: ['react', 'react-dom', 'react-router'] },
  worker: {
    format: 'es',
    plugins: () => [repositoryPaths(), virtualModules()],
    rolldownOptions: { output: { codeSplitting: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Tutto nella stessa cartella della pagina: la pagina si incorpora nell'artifact.
    assetsDir: '',
    target: 'es2022',
    modulePreload: false,
    sourcemap: false,
    chunkSizeWarningLimit: 20_000,
    // Caratteri e immagini piccole dentro il CSS: l'artifact non carica caratteri da altri file.
    assetsInlineLimit: (file) => (/\.(woff2?|svg|png)$/.test(file) ? true : undefined),
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
