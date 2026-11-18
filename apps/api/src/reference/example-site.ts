import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize, resolve } from 'node:path';

/**
 * Sito d'esempio delle banche dati (fixtures/banche-dati/sito) servito in locale, e sync/ lanciato
 * su di esso: così le prove e i dati dimostrativi usano l'output vero di sync, non un'imitazione.
 * Nessuna chiamata a siti reali.
 */

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
export const EXAMPLES_DIR = join(ROOT, 'fixtures', 'banche-dati');
export const EXAMPLE_TRANSCRIPTIONS = join(EXAMPLES_DIR, 'trascrizioni');
export const EXAMPLE_MAPPINGS = join(EXAMPLES_DIR, 'mappature-prova.json');
const SYNC_SCRIPT = join(ROOT, 'sync', 'banche_dati.py');

const TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ExampleSite {
  base: string;
  /** Sostituisce un file del sito per la durata della prova (percorso relativo a sito/). */
  override(path: string, bytes: Uint8Array): void;
  close(): Promise<void>;
}

/** Serve la cartella sito/: un percorso senza estensione cerca prima .html, poi .pdf. */
export async function serveExampleSite(root = join(EXAMPLES_DIR, 'sito')): Promise<ExampleSite> {
  const overrides = new Map<string, Uint8Array>();
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const rel = path.replace(/^\/+/, '');
    const candidates = [rel, `${rel}.html`, `${rel}.pdf`];
    for (const c of candidates) {
      const file = join(root, c);
      if (!file.startsWith(root)) break;
      const body =
        overrides.get(c) ??
        (existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null);
      if (body) {
        const ext = /\.[a-z]+$/.exec(c)?.[0] ?? '';
        res.writeHead(200, {
          'Content-Type': TYPES[ext] ?? 'application/octet-stream',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    override: (p, bytes) => overrides.set(p, bytes),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

/** Lancia sync/banche_dati.py sul sito d'esempio; restituisce il codice d'uscita e l'output. */
export async function runSyncOnExample(
  site: ExampleSite,
  dest: string,
  extraArgs: string[] = [],
): Promise<{ code: number; output: string }> {
  const fonti = join(dest, '..', `fonti-prova-${Date.now()}.json`);
  writeFileSync(
    fonti,
    readFileSync(join(EXAMPLES_DIR, 'fonti-prova.json'), 'utf-8').replaceAll('__BASE__', site.base),
  );
  return new Promise((ok) => {
    execFile(
      'python3',
      [
        '-I',
        SYNC_SCRIPT,
        '--dest',
        dest,
        '--fonti',
        fonti,
        '--pausa',
        '0',
        '--timeout',
        '10',
        ...extraArgs,
      ],
      // Il server è in locale: nessun proxy.
      { env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        ok({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}
