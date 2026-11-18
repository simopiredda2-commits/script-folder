import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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

export function encryptSecret(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(key: Buffer, data: Buffer): Buffer {
  if (data[0] !== VERSION) throw new Error('Versione di cifratura sconosciuta');
  const iv = data.subarray(1, 13);
  const tag = data.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
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
