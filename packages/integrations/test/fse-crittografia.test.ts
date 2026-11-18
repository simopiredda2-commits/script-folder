import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readJwt, signJwt } from '../src/fse/jwt';
import { createTestCertificate, privateKeyOf, publicKeyOf } from '../src/fse/x509';

/** Certificati e token di prova del simulatore: si leggono con Node e con OpenSSL. */
describe('certificati di prova e token JWT', () => {
  const cert = createTestCertificate({
    commonName: 'Firma dei token di prova',
    organization: 'Simulatore',
    from: new Date('2026-11-01T00:00:00Z'),
    days: 30,
  });

  it('il certificato è un X.509 autofirmato che Node e OpenSSL leggono', () => {
    const x = new X509Certificate(cert.der);
    expect(x.subject).toContain('CN=Firma dei token di prova');
    expect(x.subject).toContain('O=Simulatore');
    expect(x.validFrom).toContain('Nov  1 00:00:00 2026');
    expect(x.verify(publicKeyOf(cert))).toBe(true);
    const out = spawnSync('openssl', ['x509', '-inform', 'DER', '-noout', '-subject', '-dates'], {
      input: cert.der,
    });
    expect(out.status, out.stderr.toString()).toBe(0);
    expect(out.stdout.toString()).toContain('CN = Firma dei token di prova');
    expect(out.stdout.toString()).toContain('notAfter=Dec  1 00:00:00 2026 GMT');
  });

  it('il token firmato si legge e la firma si controlla con il certificato dell’intestazione', () => {
    const token = signJwt({ iss: 'auth:prova', sub: 'X' }, privateKeyOf(cert), cert.der);
    const r = readJwt(token);
    if (!r.ok) throw new Error(r.reason);
    expect(r.parts.header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(r.parts.payload).toEqual({ iss: 'auth:prova', sub: 'X' });
    expect(r.certificate.fingerprint256.replaceAll(':', '').toLowerCase()).toBe(cert.fingerprint);
  });

  it('un token cambiato dopo la firma, o firmato con un’altra chiave, è rifiutato', () => {
    const token = signJwt({ sub: 'X' }, privateKeyOf(cert), cert.der);
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'Y' })).toString('base64url')}.${s}`;
    expect(readJwt(forged)).toEqual({ ok: false, reason: 'Firma del token non valida' });
    const other = createTestCertificate({ commonName: 'Altro' });
    const mixed = signJwt({ sub: 'X' }, privateKeyOf(other), cert.der);
    expect(readJwt(mixed)).toEqual({ ok: false, reason: 'Firma del token non valida' });
    expect(readJwt('non.un.token')).toMatchObject({ ok: false });
  });
});
