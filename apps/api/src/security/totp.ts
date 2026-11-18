import { createHmac, randomBytes } from 'node:crypto';
import { base32Encode } from './base32';

/** TOTP secondo la RFC 6238: HMAC-SHA1, intervallo di 30 secondi, T0 = 0. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Intervallo di tempo (T) per un istante in millisecondi. */
export function totpStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

/** Codice per un intervallo dato (RFC 4226, troncamento dinamico). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Buffer, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(nowMs), digits);
}

/**
 * Verifica un codice accettando l'intervallo corrente e quello prima e dopo (orologi non
 * perfettamente allineati). Restituisce l'intervallo usato, o null. Un intervallo già usato
 * (`lastStep`) non vale più: lo stesso codice non serve due volte.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastStep: number | null = null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** Segreto nuovo di 20 byte (160 bit, come raccomanda la RFC 4226). */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

/** Indirizzo otpauth:// per le app di autenticazione (codice QR o inserimento manuale). */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret, false),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
