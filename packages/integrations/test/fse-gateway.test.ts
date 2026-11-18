import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPssCda, type PssCdaInput } from '../src/fse/cda';
import {
  FseGatewayClient,
  type FseCaller,
  type FseHttpRequest,
  type FsePublicationMetadata,
  type FseResult,
  type FseTransport,
} from '../src/fse/gateway';
import { SIMULATED_FSE_AUDIENCE, SimulatedFseGateway } from '../src/fse/gateway-simulator';
import { signPades, withEmbeddedCda } from '../src/fse/pdf';
import { createTestCertificate, privateKeyOf } from '../src/fse/x509';
import { sampleInput } from './helpers/pss-esempio';

const created = new Date('2026-11-18T09:30:00Z');
const PATIENT = 'PRVPZN70A41X001X';
const caller: FseCaller = {
  audience: SIMULATED_FSE_AUDIENCE,
  fiscalCode: 'MDCPRV65B12X001Y',
  role: 'APR',
  organizationId: '010',
  organizationName: 'Regione Piemonte',
  locality: 'STUDIO DI PROVA^^^^^&2.999.3&ISO^^^^000001',
  application: { id: 'PROGRAMMA-PROVA', vendor: 'FORNITORE DI PROVA', version: '0.0.0' },
};
const doctorCert = createTestCertificate({ commonName: 'Medica Inventata' });

async function pdfOf(input: PssCdaInput, xml = buildPssCda(input)) {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText('Profilo di prova', {
    x: 50,
    y: 780,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return withEmbeddedCda(await doc.save(), xml, created);
}
const sign = (pdf: Uint8Array) =>
  signPades(pdf, {
    certificateDer: doctorCert.der,
    issuerAndSerialDer: doctorCert.issuerAndSerialDer,
    key: privateKeyOf(doctorCert),
    name: 'Medica Inventata',
    reason: 'Profilo Sanitario Sintetico',
    at: created,
  });
const metadata = (input: PssCdaInput, wii: string): FsePublicationMetadata => ({
  workflowInstanceId: wii,
  healthDataFormat: 'CDA',
  mode: 'ATTACHMENT',
  tipologiaStruttura: 'Territorio',
  identificativoDoc: `${input.document.id.root}^${input.document.id.extension}`,
  identificativoRep: '2.999.4',
  tipoDocumentoLivAlto: 'SUM',
  assettoOrganizzativo: 'AD_PSC130',
  tipoAttivitaClinica: 'OBS',
  identificativoSottomissione: '2.999.5.1',
  administrativeRequest: ['SSN'],
});
const problemType = (r: FseResult) => (r.outcome === 'problem' ? r.problem.type : r.outcome);

function setup(now = () => new Date('2026-11-18T10:00:00Z')) {
  const sim = new SimulatedFseGateway({ now });
  const credentials = sim.issueCredentials('Programma di prova');
  return { sim, credentials, now, client: new FseGatewayClient(sim, credentials, now) };
}

describe('Gateway del Fascicolo: cliente e simulatore', () => {
  it('valida, firma, pubblica; lo stato dice che i dati sono andati a INI', async () => {
    const { sim, client } = setup();
    const input = sampleInput();
    const pdf = await pdfOf(input);
    const v = await client.validate(caller, PATIENT, pdf);
    if (v.outcome !== 'ok') throw new Error(JSON.stringify(v));
    expect(v.status).toBe(201);
    expect(v.workflowInstanceId).toMatch(
      /^2\.999\.1\.1\.[0-9a-f]{64}\.[0-9a-f]{10}\^\^\^\^urn:ihe:iti:xdw:2013:workflowInstanceId$/,
    );
    // Senza firma non si pubblica.
    expect(
      problemType(
        await client.publish(caller, PATIENT, pdf, metadata(input, v.workflowInstanceId!)),
      ),
    ).toBe('/msg/simulatore-firma');
    const signed = await sign(pdf);
    const p = await client.publish(caller, PATIENT, signed, metadata(input, v.workflowInstanceId!));
    expect(p).toMatchObject({
      outcome: 'ok',
      status: 202,
      workflowInstanceId: v.workflowInstanceId,
    });
    const st = await client.status(caller, PATIENT, v.workflowInstanceId!);
    expect(st.outcome === 'ok' && st.events.map((e) => `${e.eventType} ${e.eventStatus}`)).toEqual([
      'VALIDATION SUCCESS',
      'PUBLICATION SUCCESS',
      'SEND_TO_INI SUCCESS',
    ]);
    expect(sim.published('2.999.1.1^PSS.1')).toBeDefined();
    // Lo stesso documento due volte no.
    expect(
      problemType(
        await client.publish(caller, PATIENT, signed, metadata(input, v.workflowInstanceId!)),
      ),
    ).toBe('/msg/simulatore-conflitto');
  });

  it('l’invio a INI può arrivare dopo la presa in carico: lo stato lo dice quando arriva', async () => {
    let mode: 'ok' | 'ini-pending' = 'ini-pending';
    const now = () => new Date('2026-11-18T10:00:00Z');
    const sim = new SimulatedFseGateway({ now, decide: () => mode });
    const client = new FseGatewayClient(sim, sim.issueCredentials('Programma di prova'), now);
    const input = sampleInput();
    const pdf = await pdfOf(input);
    const v = await client.validate(caller, PATIENT, pdf);
    if (v.outcome !== 'ok') throw new Error(JSON.stringify(v));
    const p = await client.publish(
      caller,
      PATIENT,
      await sign(pdf),
      metadata(input, v.workflowInstanceId!),
    );
    expect(p).toMatchObject({ outcome: 'ok', status: 202 });
    const events = async () => {
      const st = await client.status(caller, PATIENT, v.workflowInstanceId!);
      return st.outcome === 'ok' ? st.events.map((e) => e.eventType) : st.outcome;
    };
    expect(await events()).toEqual(['VALIDATION', 'PUBLICATION']);
    mode = 'ok';
    expect(await events()).toEqual(['VALIDATION', 'PUBLICATION', 'SEND_TO_INI']);
  });

  it('una versione nuova sostituisce la precedente', async () => {
    const { sim, client } = setup();
    const v1 = sampleInput();
    const pdf1 = await pdfOf(v1);
    const w1 = await client.validate(caller, PATIENT, pdf1);
    if (w1.outcome !== 'ok') throw new Error('validazione');
    await client.publish(caller, PATIENT, await sign(pdf1), metadata(v1, w1.workflowInstanceId!));
    const v2 = sampleInput();
    v2.document = {
      ...v2.document,
      id: { root: '2.999.1.1', extension: 'PSS.2' },
      version: 2,
      replaces: v1.document.id,
    };
    const pdf2 = await pdfOf(v2);
    const w2 = await client.validate(caller, PATIENT, pdf2);
    if (w2.outcome !== 'ok') throw new Error(JSON.stringify(w2));
    const r = await client.replace(
      caller,
      PATIENT,
      '2.999.1.1^PSS.1',
      await sign(pdf2),
      metadata(v2, w2.workflowInstanceId!),
    );
    expect(r).toMatchObject({ outcome: 'ok', status: 202 });
    expect(sim.published('2.999.1.1^PSS.1')?.replacedBy).toBe('2.999.1.1^PSS.2');
    // Un documento che non c'è non si sostituisce.
    const v3 = sampleInput();
    v3.document = {
      ...v3.document,
      id: { root: '2.999.1.1', extension: 'PSS.3' },
      version: 3,
      replaces: v2.document.id,
    };
    const pdf3 = await pdfOf(v3);
    const w3 = await client.validate(caller, PATIENT, pdf3);
    if (w3.outcome !== 'ok') throw new Error('validazione');
    expect(
      problemType(
        await client.replace(
          caller,
          PATIENT,
          '2.999.1.1^NONCE',
          await sign(pdf3),
          metadata(v3, w3.workflowInstanceId!),
        ),
      ),
    ).toBe('/msg/record-not-found');
  });

  it('il documento che non rispetta lo schematron, o con un codice fuori dizionario, è rifiutato', async () => {
    const { client } = setup();
    const input = sampleInput();
    const withoutAllergies = buildPssCda(input).replace(
      /<component><section ID="ALLERGIE_INTOLLERANZE">.*?<\/section><\/component>/,
      '',
    );
    const r = await client.validate(caller, PATIENT, await pdfOf(input, withoutAllergies));
    expect(r.outcome === 'problem' && [r.status, r.problem.type]).toEqual([422, '/msg/semantic']);
    expect(r.outcome === 'problem' && r.problem.detail).toContain('ERRORE-b1|');
    const badRoute = buildPssCda(input).replace('code="PO"', 'code="XX"');
    const v = await client.validate(caller, PATIENT, await pdfOf(input, badRoute));
    expect(v.outcome === 'problem' && [v.status, v.problem.type]).toEqual([400, '/msg/vocabulary']);
    expect(
      problemType(await client.validate(caller, PATIENT, new TextEncoder().encode('testo'))),
    ).toBe('/msg/document-type');
  });

  it('pubblicare un CDA diverso da quello validato, o con i metadati sbagliati, non si può', async () => {
    const { client } = setup();
    const input = sampleInput();
    const w = await client.validate(caller, PATIENT, await pdfOf(input));
    if (w.outcome !== 'ok') throw new Error('validazione');
    const other = sampleInput({ problems: { absent: 'no-known-problems' } });
    const signedOther = await sign(await pdfOf(other));
    expect(
      problemType(
        await client.publish(caller, PATIENT, signedOther, metadata(input, w.workflowInstanceId!)),
      ),
    ).toBe('/msg/cda-match');
    const signed = await sign(await pdfOf(input));
    const m = metadata(input, w.workflowInstanceId!);
    expect(
      problemType(
        await client.publish(caller, PATIENT, signed, { ...m, tipoDocumentoLivAlto: 'REF' }),
      ),
    ).toBe('/msg/invalid-format');
    expect(
      problemType(await client.publish(caller, PATIENT, signed, { ...m, identificativoRep: '' })),
    ).toBe('/msg/mandatory-element');
    expect(
      problemType(
        await client.publish(caller, PATIENT, signed, {
          ...m,
          identificativoDoc: '2.999.1.1^ALTRO',
        }),
      ),
    ).toBe('/msg/invalid-format');
  });

  it('i token: paziente diverso dal documento, certificati non rilasciati, token scaduti, file cambiato', async () => {
    const { sim, client, credentials, now } = setup();
    const input = sampleInput();
    const pdf = await pdfOf(input);
    expect(problemType(await client.validate(caller, 'ALTRPZ70A41X001X', pdf))).toBe(
      '/msg/jwt-validation',
    );
    // Certificati fatti da sé, non rilasciati dal Gateway.
    const own = createTestCertificate({ commonName: 'Fatto in casa' });
    // Stesso orologio del Gateway: il rifiuto deve venire dal certificato, non dall'ora dei token.
    const foreign = new FseGatewayClient(
      sim,
      { ...credentials, authentication: { der: own.der, privateKeyPem: own.privateKeyPem } },
      now,
    );
    expect(problemType(await foreign.validate(caller, PATIENT, pdf))).toBe('/msg/unauthorized');
    const unsignedTokens = new FseGatewayClient(
      sim,
      { ...credentials, signature: { der: own.der, privateKeyPem: own.privateKeyPem } },
      now,
    );
    const r0 = await unsignedTokens.validate(caller, PATIENT, pdf);
    expect(r0.outcome === 'problem' && [r0.problem.type, r0.problem.detail]).toEqual([
      '/msg/jwt-validation',
      'Certificato di firma del token non riconosciuto',
    ]);
    // Orologio del programma indietro di un'ora: i token sono già scaduti per il Gateway.
    const late = new FseGatewayClient(sim, credentials, () => new Date('2026-11-18T09:00:00Z'));
    const r = await late.validate(caller, PATIENT, pdf);
    expect(r.outcome === 'problem' && r.problem.detail).toBe('Token scaduto');
    // Un file cambiato dopo il calcolo dell'impronta del token di firma.
    const w = await client.validate(caller, PATIENT, pdf);
    if (w.outcome !== 'ok') throw new Error('validazione');
    const signed = await sign(pdf);
    const tampering: FseTransport = {
      environment: 'simulator',
      send: (req: FseHttpRequest) => {
        const file = new Uint8Array(req.file!);
        file[file.length - 10] = 32;
        return sim.send({ ...req, file });
      },
    };
    const via = new FseGatewayClient(
      tampering,
      credentials,
      () => new Date('2026-11-18T10:00:00Z'),
    );
    expect(
      problemType(
        await via.publish(caller, PATIENT, signed, metadata(input, w.workflowInstanceId!)),
      ),
    ).toBe('/msg/document-hash');
  });

  it('dopo 5 giorni il documento non si pubblica più (DM 7/9/2023, art. 12)', async () => {
    let now = new Date('2026-11-18T10:00:00Z');
    const { client } = setup(() => now);
    const input = sampleInput();
    const pdf = await pdfOf(input);
    const w = await client.validate(caller, PATIENT, pdf);
    if (w.outcome !== 'ok') throw new Error('validazione');
    now = new Date('2026-11-24T10:00:00Z');
    expect(
      problemType(
        await client.publish(
          caller,
          PATIENT,
          await sign(pdf),
          metadata(input, w.workflowInstanceId!),
        ),
      ),
    ).toBe('/msg/max-day-limit-exceed');
  });

  it('assenza di rete, nessuna risposta, errore interno', async () => {
    for (const [outcome, expected] of [
      ['unreachable', 'unreachable'],
      ['timeout', 'timeout'],
      ['internal-error', '/msg/generic-error'],
    ] as const) {
      const sim = new SimulatedFseGateway({ decide: () => outcome });
      const client = new FseGatewayClient(sim, sim.issueCredentials('Prova'));
      expect(problemType(await client.validate(caller, PATIENT, await pdfOf(sampleInput())))).toBe(
        expected,
      );
    }
  });
});
