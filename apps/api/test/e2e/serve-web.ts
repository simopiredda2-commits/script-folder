import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';

/** Build di apps/web e piccolo server che la serve e passa /api al servizio (prove e schermate). */
const WEB = resolve(import.meta.dirname, '..', '..', '..', 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Serve dist/ e passa /api al servizio, come farà il dominio dello studio. */
export function serveWeb(dist: string, apiPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      const upstream = request(
        {
          host: '127.0.0.1',
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(upstream);
      return;
    }
    const path = join(dist, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const file =
      path.startsWith(dist) && existsSync(path) && statSync(path).isFile()
        ? path
        : join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/** Build dell'interfaccia in una cartella; restituisce la cartella. */
export function buildWeb(outDir: string): string {
  execFileSync(
    join(WEB, 'node_modules', '.bin', 'vite'),
    ['build', '--outDir', outDir, '--emptyOutDir'],
    {
      cwd: WEB,
      stdio: 'pipe',
    },
  );
  return outDir;
}
