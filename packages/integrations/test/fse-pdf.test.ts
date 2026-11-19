import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { extractCda, readPades, signPades, withEmbeddedCda } from '../src/fse/pdf';
import { createTestCertificate, privateKeyOf } from '../src/fse/x509';

async function simplePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText(text, {
    x: 50,
    y: 780,
    size: 12,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return doc.save();
}

const CDA =
  '<?xml version="1.0" encoding="UTF-8"?><ClinicalDocument xmlns="urn:hl7-org:v3"><title>Prova àèìòù</title></ClinicalDocument>';
const at = new Date('2026-11-18T09:30:00Z');

describe('PDF del Fascicolo: CDA allegato e firma PAdES', () => {
  it('il CDA entra come «cda.xml» e si ritrova dove lo cerca il Gateway', async () => {
    const pdf = await withEmbeddedCda(await simplePdf('Profilo di prova'), CDA, at);
    expect(await extractCda(pdf)).toBe(CDA);
    // Un PDF senza allegato, o con un allegato con un altro nome, non ha il CDA.
    expect(await extractCda(await simplePdf('Senza allegato'))).toBeNull();
    const other = await PDFDocument.load(await simplePdf('Altro allegato'));
    await other.attach(Buffer.from(CDA), 'documento.xml', { mimeType: 'text/xml' });
    expect(await extractCda(await other.save())).toBeNull();
    expect(await extractCda(new TextEncoder().encode('non è un pdf'))).toBeNull();
  });

  it('la firma PAdES copre tutto il file tranne sé stessa e OpenSSL la verifica', async () => {
    const cert = createTestCertificate({
      commonName: 'Medica Inventata',
      serialNumber: 'MDCPRV65B12X001Y',
    });
    const pdf = await withEmbeddedCda(await simplePdf('Profilo da firmare'), CDA, at);
    const signed = await signPades(pdf, {
      certificateDer: cert.der,
      issuerAndSerialDer: cert.issuerAndSerialDer,
      key: privateKeyOf(cert),
      name: 'Medica Inventata',
      reason: 'Profilo Sanitario Sintetico',
      at,
    });
    // Il CDA resta lo stesso nel PDF firmato.
    expect(await extractCda(signed)).toBe(CDA);
    const info = readPades(signed)!;
    expect(info.subFilter).toBe('ETSI.CAdES.detached');
    expect(info.coversWholeFile).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'pades-'));
    try {
      writeFileSync(join(dir, 'firma.der'), info.cms);
      writeFileSync(join(dir, 'dati.bin'), info.signedBytes);
      const ok = spawnSync('openssl', [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        join(dir, 'firma.der'),
        '-content',
        join(dir, 'dati.bin'),
        '-binary',
        '-noverify',
        '-out',
        join(dir, 'out.bin'),
      ]);
      expect(ok.status, ok.stderr.toString()).toBe(0);
      expect(ok.stderr.toString()).toContain('Verification successful');
      // Un byte cambiato nel file firmato: la verifica fallisce.
      const tampered = Buffer.from(info.signedBytes);
      tampered[100] = tampered[100]! ^ 1;
      writeFileSync(join(dir, 'dati.bin'), tampered);
      const bad = spawnSync('openssl', [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        join(dir, 'firma.der'),
        '-content',
        join(dir, 'dati.bin'),
        '-binary',
        '-noverify',
        '-out',
        join(dir, 'out.bin'),
      ]);
      expect(bad.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un PDF senza firma non ha firma PAdES', async () => {
    expect(readPades(await simplePdf('Senza firma'))).toBeNull();
  });
});
