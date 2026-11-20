/** `node:net` nel browser (D221): il riconoscimento degli indirizzi IP. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export const isIPv4 = (s: string) => IPV4.test(s);
export function isIPv6(s: string): boolean {
  if (!s.includes(':')) return false;
  try {
    new URL(`http://[${s}]/`);
    return true;
  } catch {
    return false;
  }
}
export const isIP = (s: string) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);

export class Socket {
  remoteAddress = '127.0.0.1';
  destroy() {}
  setTimeout() {}
}
export function createServer(): never {
  throw new Error('net.createServer non è disponibile nel browser');
}
export function connect(): never {
  throw new Error('net.connect non è disponibile nel browser');
}

export default { isIP, isIPv4, isIPv6, Socket, createServer, connect };
