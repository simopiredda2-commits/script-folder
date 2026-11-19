/**
 * I due token JWT delle chiamate al Gateway (specifiche di integrazione, 2.3 e 16.1): RS256,
 * con il certificato di firma del programma nell'intestazione (x5c, DER in base64). Il primo va
 * nell'intestazione «Authorization: Bearer», il secondo in «FSE-JWT-Signature».
 */

import { createPublicKey, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface JwtParts {
  header: { alg: string; typ: string; x5c?: string[]; kid?: string };
  payload: Record<string, unknown>;
}

/** Token firmato RS256 con il certificato nell'intestazione. */
export function signJwt(
  payload: Record<string, unknown>,
  key: KeyObject,
  certificateDer: Buffer,
): string {
  const header = { alg: 'RS256', typ: 'JWT', x5c: [certificateDer.toString('base64')] };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${body}.${b64url(sign('sha256', Buffer.from(body), key))}`;
}

export type JwtCheck =
  { ok: true; parts: JwtParts; certificate: X509Certificate } | { ok: false; reason: string };

/** Legge il token e ne controlla la firma con il certificato dell'intestazione. */
export function readJwt(token: string): JwtCheck {
  const pieces = token.split('.');
  if (pieces.length !== 3) return { ok: false, reason: 'Il token non è un JWT' };
  let parts: JwtParts;
  try {
    parts = {
      header: JSON.parse(
        Buffer.from(pieces[0]!, 'base64url').toString('utf8'),
      ) as JwtParts['header'],
      payload: JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >,
    };
  } catch {
    return { ok: false, reason: 'Intestazione o contenuto del token non leggibili' };
  }
  if (parts.header.typ !== 'JWT') return { ok: false, reason: "Il campo typ deve valere 'JWT'" };
  if (!['RS256', 'RS384', 'RS512'].includes(parts.header.alg))
    return { ok: false, reason: 'Algoritmo di firma non ammesso' };
  const der = parts.header.x5c?.[0];
  if (!der) return { ok: false, reason: 'Manca il certificato (x5c)' };
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(Buffer.from(der, 'base64'));
  } catch {
    return { ok: false, reason: 'Il certificato (x5c) non è leggibile' };
  }
  const hash = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' }[parts.header.alg]!;
  const signed = Buffer.from(`${pieces[0]}.${pieces[1]}`);
  const good = verify(
    hash,
    signed,
    createPublicKey(certificate.publicKey.export({ type: 'spki', format: 'pem' })),
    Buffer.from(pieces[2]!, 'base64url'),
  );
  return good
    ? { ok: true, parts, certificate }
    : { ok: false, reason: 'Firma del token non valida' };
}
