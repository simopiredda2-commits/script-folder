import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifratura dei segreti a riposo (segreti TOTP, credenziali esterne): AES-256-GCM con la
 * chiave dell'applicazione, che non sta nel repository (variabile APP_ENCRYPTION_KEY).
 * Formato: versione (1 byte) | iv (12) | tag (16) | testo cifrato.
 */
const VERSION = 1;

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY deve essere di 32 byte in base64');
  return key;
}

/**
 * Chiave derivata per un solo uso (HKDF-SHA256): un segreto cifrato per uno scopo non si apre con
 * la chiave di un altro scopo.
 */
export function deriveKey(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), purpose, 32));
}

/**
 * `aad` lega il testo cifrato al suo posto (per esempio medico e servizio): copiato su un'altra
 * riga, non si apre più.
 */
export function encryptSecret(key: Buffer, plain: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(key: Buffer, data: Buffer, aad?: Buffer): Buffer {
  if (data[0] !== VERSION) throw new Error('Versione di cifratura sconosciuta');
  const iv = data.subarray(1, 13);
  const tag = data.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
}

/** Token casuale per sessioni e passaggi di accesso: si consegna il token, si conserva l'impronta. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
