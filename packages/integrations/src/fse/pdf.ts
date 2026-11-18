/**
 * Il PDF del Fascicolo (tappa 11): un PDF leggibile con il documento CDA2 dentro come allegato
 * «cda.xml», nel punto in cui il Gateway lo cerca (Root/Names/EmbeddedFiles/Names/[1]/EF/F,
 * specifiche di integrazione, 2). Poi la firma PAdES: dizionario /Sig con /SubFilter
 * /ETSI.CAdES.detached e una firma CMS (RFC 5652) sui byte del file tranne la firma stessa.
 *
 * La firma del simulatore usa un certificato di prova: ha la forma di una firma vera ma non vale
 * fuori dal programma. La firma vera sarà quella qualificata del medico (D137).
 */

import { createHash, sign, type KeyObject } from 'node:crypto';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import {
  contentOf,
  elementLength,
  explicit,
  implicitConstructed,
  integer,
  nullValue,
  OIDS,
  octetString,
  oid,
  sequence,
  set,
  utcTime,
} from './der';

export const CDA_ATTACHMENT_NAME = 'cda.xml';

/** Aggiunge il CDA come allegato «cda.xml» (modalità ATTACHMENT). */
export async function withEmbeddedCda(
  pdf: Uint8Array,
  cdaXml: string,
  at: Date,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  await doc.attach(Buffer.from(cdaXml, 'utf8'), CDA_ATTACHMENT_NAME, {
    mimeType: 'text/xml',
    description: 'Documento CDA2',
    creationDate: at,
    modificationDate: at,
  });
  return doc.save({ useObjectStreams: false });
}

/** Il CDA allegato, dove lo cerca il Gateway; null se non c'è. */
export async function extractCda(pdf: Uint8Array): Promise<string | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  } catch {
    return null;
  }
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embedded = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const direct = embedded?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const kids = embedded?.lookupMaybe(PDFName.of('Kids'), PDFArray);
  const list =
    direct ?? kids?.lookupMaybe(0, PDFDict)?.lookupMaybe(PDFName.of('Names'), PDFArray) ?? null;
  if (!list || list.size() < 2) return null;
  const nameObj = list.lookup(0);
  const fileName =
    nameObj instanceof PDFString || nameObj instanceof PDFHexString ? nameObj.decodeText() : '';
  if (fileName.toLowerCase() !== CDA_ATTACHMENT_NAME) return null;
  const stream = list
    .lookupMaybe(1, PDFDict)
    ?.lookupMaybe(PDFName.of('EF'), PDFDict)
    ?.lookupMaybe(PDFName.of('F'), PDFStream);
  if (!stream) return null;
  const bytes =
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  return Buffer.from(bytes).toString('utf8');
}

/* Firma PAdES ------------------------------------------------------------------------------ */

/** Spazio per la firma CMS nel file (byte); il resto resta a zero. */
const SIGNATURE_BYTES = 8192;
const RANGE_PLACEHOLDER = 9_999_999_999;

export interface PadesSigner {
  certificateDer: Buffer;
  /** Emittente e numero di serie del certificato in DER (per il SignerInfo). */
  issuerAndSerialDer: Buffer;
  key: KeyObject;
  name: string;
  reason: string;
  at: Date;
}

/** Firma CMS «detached» con gli attributi firmati di PAdES (RFC 5652, RFC 5035). */
function cmsSignature(data: Buffer, s: PadesSigner): Buffer {
  const digest = createHash('sha256').update(data).digest();
  const certHash = createHash('sha256').update(s.certificateDer).digest();
  const sha256 = sequence(oid(OIDS.sha256), nullValue());
  const attributes = [
    sequence(oid(OIDS.contentType), set(oid(OIDS.data))),
    sequence(oid(OIDS.signingTime), set(utcTime(s.at))),
    sequence(oid(OIDS.messageDigest), set(octetString(digest))),
    // signing-certificate-v2 con ESSCertIDv2 (algoritmo SHA-256 per difetto, si omette).
    sequence(
      oid(OIDS.signingCertificateV2),
      set(sequence(sequence(sequence(octetString(certHash))))),
    ),
  ];
  // Si firma la codifica DER del SET degli attributi; nel SignerInfo vanno come [0] IMPLICIT.
  const signedSet = set(...attributes);
  const signature = sign('sha256', signedSet, s.key);
  const signerInfo = sequence(
    integer(1),
    s.issuerAndSerialDer,
    sha256,
    implicitConstructed(0, contentOf(signedSet)),
    sequence(oid(OIDS.rsaEncryption), nullValue()),
    octetString(signature),
  );
  const signedData = sequence(
    integer(1),
    set(sha256),
    sequence(oid(OIDS.data)),
    implicitConstructed(0, s.certificateDer),
    set(signerInfo),
  );
  return sequence(oid(OIDS.signedData), explicit(0, signedData));
}

/** Il PDF firmato PAdES: dizionario di firma, campo, e firma CMS sui byte del file. */
export async function signPades(pdf: Uint8Array, s: PadesSigner): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const ctx = doc.context;
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [0, RANGE_PLACEHOLDER, RANGE_PLACEHOLDER, RANGE_PLACEHOLDER],
    Contents: PDFHexString.of('0'.repeat(SIGNATURE_BYTES * 2)),
    M: PDFString.fromDate(s.at),
    Name: PDFString.of(s.name),
    Reason: PDFString.of(s.reason),
  });
  const sigRef = ctx.register(sig);
  const page = doc.getPage(0);
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    V: sigRef,
    T: PDFString.of('Firma del medico'),
    F: 4,
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widgetRef], SigFlags: 3 }));
  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));

  // Dove sta la firma nel file: si firma tutto tranne il testo esadecimale della firma.
  const placeholder = `/ByteRange [ 0 ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER} ${RANGE_PLACEHOLDER} ]`;
  const rangeAt = bytes.indexOf(placeholder);
  const contentsAt = bytes.indexOf(`<${'0'.repeat(SIGNATURE_BYTES * 2)}>`, rangeAt);
  if (rangeAt < 0 || contentsAt < 0) throw new Error('Firma: segnaposto non trovato nel PDF');
  const start = contentsAt;
  const end = contentsAt + SIGNATURE_BYTES * 2 + 2;
  const range = `/ByteRange [ 0 ${start} ${end} ${bytes.length - end} ]`;
  bytes.write(range.padEnd(placeholder.length, ' '), rangeAt, 'latin1');
  const signed = Buffer.concat([bytes.subarray(0, start), bytes.subarray(end)]);
  const cms = cmsSignature(signed, s).toString('hex');
  if (cms.length > SIGNATURE_BYTES * 2) throw new Error('Firma: spazio insufficiente nel PDF');
  bytes.write(cms.padEnd(SIGNATURE_BYTES * 2, '0'), start + 1, 'latin1');
  return new Uint8Array(bytes);
}

export interface PadesInfo {
  subFilter: string;
  byteRange: [number, number, number, number];
  /** La firma CMS in DER, senza gli zeri di riempimento. */
  cms: Buffer;
  /** I byte firmati (il file tranne la firma). */
  signedBytes: Buffer;
  /** Vero se le parti firmate coprono tutto il file tranne la firma. */
  coversWholeFile: boolean;
}

/** Legge la firma PAdES del PDF (l'ultima), senza controllare il certificato; null se manca. */
export function readPades(pdf: Uint8Array): PadesInfo | null {
  const bytes = Buffer.from(pdf);
  const text = bytes.toString('latin1');
  const m = [...text.matchAll(/\/ByteRange \[ ?(\d+) (\d+) (\d+) (\d+) ?\]/g)].pop();
  if (!m) return null;
  const sub = /\/SubFilter \/([A-Za-z0-9.]+)/.exec(text)?.[1] ?? '';
  const range = m.slice(1, 5).map(Number) as [number, number, number, number];
  const [a, b, c, d] = range;
  const hex = text.slice(b + 1, c - 1);
  const raw = Buffer.from(hex, 'hex');
  // Lunghezza vera della firma dalla sua intestazione DER (SEQUENCE); poi solo zeri.
  const len = raw[0] === 0x30 ? elementLength(raw) : raw.length;
  return {
    subFilter: sub,
    byteRange: range,
    cms: raw.subarray(0, len),
    signedBytes: Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]),
    coversWholeFile: a === 0 && c + d === bytes.length && text[b] === '<' && text[c - 1] === '>',
  };
}
