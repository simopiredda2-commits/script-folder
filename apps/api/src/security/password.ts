import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password conservate con scrypt (memoria e tempo costosi per chi tenta di indovinarle).
 * Formato: scrypt$N$r$p$sale$impronta, tutto in base64 tranne i parametri.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };

function derive(
  password: string,
  salt: Buffer,
  opts: ScryptOptions,
  keylen: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFC'),
      salt,
      keylen,
      { ...opts, maxmem: 128 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS, PARAMS.keylen);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(
    password,
    Buffer.from(salt, 'base64'),
    { N: Number(n), r: Number(r), p: Number(p) },
    expected.length,
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Requisito minimo della password: lunghezza. Le regole fini sono una scelta dello studio. */
export const MIN_PASSWORD_LENGTH = 12;
