/** `node:url` nel browser (D221): le classi del browser e la conversione dei percorsi file:. */
const URLClass = globalThis.URL;
const URLSearchParamsClass = globalThis.URLSearchParams;

export function fileURLToPath(input: string | URL): string {
  const url = typeof input === 'string' ? new URLClass(input) : input;
  if (url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  return decodeURIComponent(url.pathname);
}

export const pathToFileURL = (path: string) => new URLClass(`file://${encodeURI(path)}`);

/** Il vecchio url.parse, quanto basta a chi lo usa ancora. */
export function parse(input: string) {
  const u = new URLClass(input, 'http://localhost');
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(input);
  return {
    protocol: absolute ? u.protocol : null,
    host: absolute ? u.host : null,
    hostname: absolute ? u.hostname : null,
    port: absolute ? u.port || null : null,
    pathname: u.pathname,
    search: u.search || null,
    query: u.search ? u.search.slice(1) : null,
    hash: u.hash || null,
    path: `${u.pathname}${u.search}`,
    href: input,
  };
}

export const format = (u: URL | { href?: string }) =>
  u instanceof URLClass ? u.href : (u.href ?? '');

export { URLClass as URL, URLSearchParamsClass as URLSearchParams };
export default {
  URL: URLClass,
  URLSearchParams: URLSearchParamsClass,
  fileURLToPath,
  pathToFileURL,
  parse,
  format,
};
