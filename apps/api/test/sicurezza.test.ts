import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from '../src/security/base32';
import { hashPassword, verifyPassword } from '../src/security/password';
import { decryptSecret, encryptSecret, hashToken, newToken } from '../src/security/secrets';
import { hotp, otpauthUri, totp, totpStep, verifyTotp } from '../src/security/totp';

describe('Base32 (RFC 4648, sezione 10)', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  it.each(vectors)('BASE32("%s") = "%s"', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });
});

describe('TOTP (RFC 6238, appendice B, SHA1)', () => {
  // Segreto di prova della RFC: la stringa ASCII "12345678901234567890"; 8 cifre, passo 30 s.
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('al secondo %d il codice è %s', (seconds, code) => {
    expect(totp(secret, seconds * 1000, 8)).toBe(code);
  });

  it('accetta l’intervallo corrente e quelli vicini, non quelli lontani', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, hotp(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step + 2), now)).toBeNull();
  });

  it('lo stesso codice non vale due volte', () => {
    const now = 1_800_000_000_000;
    const code = totp(secret, now);
    const used = verifyTotp(secret, code, now);
    expect(used).not.toBeNull();
    expect(verifyTotp(secret, code, now, used)).toBeNull();
  });

  it('rifiuta codici che non sono di 6 cifre', () => {
    expect(verifyTotp(secret, '12345', 0)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 0)).toBeNull();
  });

  it('l’indirizzo otpauth contiene il segreto in Base32 senza riempimento', () => {
    const uri = otpauthUri(secret, 'medico', 'Studio');
    expect(uri).toContain(`secret=${base32Encode(secret, false)}`);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
  });
});

describe('password', () => {
  it('la password giusta passa, quella sbagliata no', async () => {
    const stored = await hashPassword('una password abbastanza lunga');
    expect(stored).toMatch(/^scrypt\$/);
    expect(await verifyPassword('una password abbastanza lunga', stored)).toBe(true);
    expect(await verifyPassword('una password abbastanza lungA', stored)).toBe(false);
  });
  it('due impronte della stessa password sono diverse (sale casuale)', async () => {
    expect(await hashPassword('stessa password')).not.toBe(await hashPassword('stessa password'));
  });
  it('un formato sconosciuto non passa', async () => {
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
  });
});

describe('segreti a riposo', () => {
  const key = randomBytes(32);
  it('cifrati e decifrati tornano uguali', () => {
    const plain = randomBytes(20);
    const enc = encryptSecret(key, plain);
    expect(enc.includes(plain)).toBe(false);
    expect(decryptSecret(key, enc)).toEqual(plain);
  });
  it('con un’altra chiave o un byte alterato la decifratura fallisce', () => {
    const enc = encryptSecret(key, Buffer.from('segreto'));
    expect(() => decryptSecret(randomBytes(32), enc)).toThrow();
    const altered = Buffer.from(enc);
    altered[altered.length - 1]! ^= 1;
    expect(() => decryptSecret(key, altered)).toThrow();
  });
  it('del token si conserva solo l’impronta', () => {
    const { token, hash } = newToken();
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token);
  });
});
