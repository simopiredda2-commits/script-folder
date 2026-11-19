/**
 * Certificati X.509 di prova per i simulatori (tappa 11): il Gateway vuole due certificati del
 * programma, uno per il collegamento e uno per firmare i token JWT, rilasciati da Sogei con
 * l'accreditamento; la firma PAdES vuole il certificato qualificato del medico. Qui se ne fanno
 * di finti, autofirmati, solo per i simulatori e le prove: non valgono fuori dal programma.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  bitString,
  explicit,
  integer,
  nullValue,
  OIDS,
  oid,
  printableString,
  sequence,
  set,
  utcTime,
  utf8String,
} from './der';

export interface TestCertificate {
  /** Certificato in DER. */
  der: Buffer;
  /** Chiave privata in PEM (PKCS#8): nei simulatori resta in memoria. */
  privateKeyPem: string;
  /** Impronta SHA-256 del certificato, in esadecimale. */
  fingerprint: string;
  subject: string;
  /** Emittente e numero di serie in DER, per riconoscere il firmatario nella firma CMS. */
  issuerAndSerialDer: Buffer;
}

export const certificateFingerprint = (der: Buffer) =>
  createHash('sha256').update(der).digest('hex');

function rdn(type: string, value: Buffer): Buffer {
  return set(sequence(oid(type), value));
}

/** Certificato autofirmato RSA 2048 con SHA-256, valido `days` giorni da `from`. */
export function createTestCertificate(opts: {
  commonName: string;
  organization?: string;
  /** Codice fiscale del titolare, come numero di serie del soggetto (es. il medico). */
  serialNumber?: string;
  from?: Date;
  days?: number;
}): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const from = opts.from ?? new Date();
  const to = new Date(from.getTime() + (opts.days ?? 365) * 86_400_000);
  const name = sequence(
    rdn(OIDS.countryName, printableString('IT')),
    ...(opts.organization ? [rdn(OIDS.organizationName, utf8String(opts.organization))] : []),
    rdn(OIDS.commonName, utf8String(opts.commonName)),
    ...(opts.serialNumber ? [rdn(OIDS.serialNumber, printableString(opts.serialNumber))] : []),
  );
  const algorithm = sequence(oid(OIDS.sha256WithRSAEncryption), nullValue());
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(12);
  serial[0]! &= 0x7f;
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    name,
    sequence(utcTime(from), utcTime(to)),
    name,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, bitString(signature));
  return {
    der,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: certificateFingerprint(der),
    subject: opts.commonName,
    issuerAndSerialDer: sequence(name, integer(serial)),
  };
}

export const privateKeyOf = (c: TestCertificate): KeyObject => createPrivateKey(c.privateKeyPem);
export const publicKeyOf = (c: TestCertificate): KeyObject => createPublicKey(c.privateKeyPem);
