import { X509Certificate } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPssCda, type PssCdaInput } from '../src/fse/cda';
import { FseGatewayClient, type FseCaller } from '../src/fse/gateway';
import { SIMULATED_FSE_AUDIENCE, SimulatedFseGateway } from '../src/fse/gateway-simulator';
import { signPades, withEmbeddedCda } from '../src/fse/pdf';
import {
  RegionalFseClient,
  documentHash,
  type RegionalAuthor,
  type RegionalFseTransport,
  type RegionalPssMetadata,
  type RegionalSoapRequest,
} from '../src/fse/regional-publication';
import {
  SimulatedRegionalFse,
  type SimulatedRegionalFseOptions,
  type SimulatedRegionalOutcome,
} from '../src/fse/regional-publication-simulator';
import { createTestCertificate, privateKeyOf } from '../src/fse/x509';
import { sampleInput } from './helpers/pss-esempio';

/** Pubblicazione con i servizi del Fascicolo regionale (V09, D280). Persone inventate. */
const created = new Date('2026-11-18T09:30:00Z');
const PATIENT = 'PRVPZN70A41X001X';
const author: RegionalAuthor = {
  fiscalCode: 'MDCPRV65B12X001Y',
  firstName: 'Medica',
  lastName: 'Inventata',
  aslCode: '203',
};
const LOCALITY = 'STUDIO DI PROVA^^^^^&2.999.3&ISO^^^^000001';
const caller: FseCaller = {
  audience: SIMULATED_FSE_AUDIENCE,
  fiscalCode: author.fiscalCode,
  role: 'APR',
  organizationId: '010',
  organizationName: 'Regione Piemonte',
  locality: LOCALITY,
  application: { id: 'PROGRAMMA-PROVA', vendor: 'FORNITORE DI PROVA', version: '0.0.0' },
};
const AUTH = { username: 'utente.rupar', password: 'password-di-prova', pin: '12345678' };
const doctorCert = createTestCertificate({ commonName: 'Medica Inventata' });

async function pdfOf(input: PssCdaInput) {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText('Profilo di prova', {
    x: 50,
    y: 780,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  return withEmbeddedCda(await doc.save(), buildPssCda(input), created);
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
const metadata = (over: Partial<RegionalPssMetadata> = {}): RegionalPssMetadata => ({
  patientFiscalCode: PATIENT,
  confidentiality: 'N',
  writtenAt: created,
  regime: 'SSN',
  signed: true,
  ...over,
});

/** Il trasporto che guarda passare le richieste: per le prove sui messaggi interi. */
class Spy implements RegionalFseTransport {
  readonly environment = 'simulator' as const;
  readonly requests: RegionalSoapRequest[] = [];
  constructor(readonly inner: SimulatedRegionalFse) {}
  send(req: RegionalSoapRequest) {
    this.requests.push(req);
    return this.inner.send(req);
  }
}

function setup(
  over: Partial<SimulatedRegionalFseOptions> = {},
  gatewayDecide?: () => 'ok' | 'ini-pending',
) {
  const now = () => new Date('2026-11-18T10:00:00Z');
  const gateway = new SimulatedFseGateway({
    now,
    ...(gatewayDecide ? { decide: gatewayDecide } : {}),
  });
  const national = new FseGatewayClient(
    gateway,
    gateway.issueCredentials('Programma di prova'),
    now,
  );
  // Il PIN si confronta con quello del medico: un PIN in chiaro o cifrato male non passa.
  const sim = new SimulatedRegionalFse({
    gateway,
    now,
    credentials: (_u, _p, pin) => pin === AUTH.pin,
    ...over,
  });
  const spy = new Spy(sim);
  const client = new RegionalFseClient(spy, {
    encryptionCertificate: sim.encryptionCertificate,
    application: caller.application,
  });
  /** Validato sul Gateway e firmato: quello che la cartella manda alla Regione. */
  async function ready(input = sampleInput(), signed = true) {
    const pdf = await pdfOf(input);
    const v = await national.validate(caller, PATIENT, pdf);
    if (v.outcome !== 'ok') throw new Error(JSON.stringify(v));
    return {
      document: signed ? await sign(pdf) : pdf,
      workflowInstanceId: v.workflowInstanceId!,
      locality: LOCALITY,
      input,
    };
  }
  return { gateway, sim, spy, client, ready, now };
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'text/xml');
const valueOf = (s: string, name: string) => {
  const e = xml(s).getElementsByTagNameNS('*', name)[0];
  return e ? (e.textContent ?? '') : null;
};

describe('Fascicolo regionale (V09): cliente e simulatore', () => {
  it('CREATE con il documento validato e firmato, poi l’esito: OK con l’OID del documento', async () => {
    const { sim, client, ready, now } = setup();
    const doc = await ready();
    const sent = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    if (sent.outcome !== 'accepted') throw new Error(JSON.stringify(sent));
    expect(sent.esito).toBe('0000');
    expect(sent.temporaryId).toMatch(/^TEMP_010_\d+$/);
    const out = await client.outcome(
      { author, temporaryId: sent.temporaryId!, from: created, to: now() },
      AUTH,
    );
    if (out.outcome !== 'checked') throw new Error(JSON.stringify(out));
    expect(out.state).toBe('OK');
    expect(out.oid).toMatch(/^2\.16\.840\.1\.113883\.2\.9\.2\.10\.4\.4\^\d+$/);
    expect(out.gateway.traceId).toBeTruthy();
    expect(sim.stored(out.oid!)).toMatchObject({ patientCf: PATIENT, authorCf: author.fiscalCode });
  });

  it('il messaggio CREATE ha i valori della V09, campo per campo (5.2.2)', async () => {
    const { client, ready } = setup();
    const doc = await ready();
    const sent = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    const s = sent.sent;
    expect(xml(s).documentElement!.namespaceURI).toBe('http://www.w3.org/2003/05/soap-envelope');
    for (const [name, value] of [
      ['identificativoUtente', author.fiscalCode],
      ['identificativoOrganizzazione', '010'],
      ['strutturaUtente', '------'],
      ['ruoloUtente', 'APR'],
      ['contestoOperativo', 'TREATMENT'],
      ['identificativoAssistito', PATIENT],
      ['presaInCarico', 'true'],
      ['tipoAttivita', 'CREATE'],
      ['TipologiaStrutturaProdDoc', 'Territorio'],
      ['IdentificativoAssistito', PATIENT],
      ['TipoMime', 'application/pdf+text/x-cda-r2+xml'],
      ['LivelloConfidenzialita', 'N'],
      ['TipologiaDocumentoAlto', 'SUM'],
      ['TipologiaDocumentoMedio', '60591-5'],
      ['TipologiaDocumentoBasso', 'PDF'],
      ['DataValidazioneDocumento', '20261118103000'],
      ['RuoloAutore', 'APR'],
      ['IstituzioneAutore', '010203'],
      [
        'CodiceFiscaleAutore',
        'MDCPRV65B12X001Y^INVENTATA^MEDICA^^^^^^&2.16.840.1.113883.2.9.4.3.2&ISO',
      ],
      ['SpecialitaAutore', 'AD_PSC130'],
      ['HashDoc', documentHash(doc.document)],
      ['SizeDoc', String(doc.document.byteLength)],
      ['AssettoOrganizzativo', 'AD_PSC130'],
      ['TipoAttivitaClinica', 'ERP'],
      ['DataInizioPrestazione', '20261118103000'],
      ['DataFinePrestazione', '20261118103000'],
      ['DocumentoFirmato', 'true^Documento firmato'],
      ['RegimeDocumento', 'SSN'],
      ['WorkflowInstanceId', doc.workflowInstanceId],
      ['Locality', LOCALITY],
      ['ModalitaAlimentazione', 'FSE2.0'],
      ['IdentificativoApplicativoRichiedente', 'PROGRAMMA-PROVA'],
    ])
      expect([name, valueOf(s, name!)]).toEqual([name, value]);
    // In CREATE con «N» niente RegoleAccesso, riferimenti, associazione, rappresentante legale.
    for (const name of [
      'RegoleAccesso',
      'RiferimentoDocumento',
      'Associazione',
      'IdentificativoUnivocoDocumento',
      'RappresentanteLegale',
      'descrizioneOrganizzazione',
      'tipoDocumento',
    ])
      expect([name, valueOf(s, name)]).toEqual([name, null]);
    expect(valueOf(s, 'documento')).toBe(Buffer.from(doc.document).toString('base64'));
  });

  it('nel registro niente credenziali: password e PIN restano fuori, il PIN va cifrato', async () => {
    const { client, ready, spy } = setup();
    const doc = await ready();
    const sent = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    expect(sent.sent).not.toContain(AUTH.password);
    expect(sent.sent).not.toContain(AUTH.pin);
    expect(sent.sent).not.toContain('UsernameToken');
    expect(valueOf(sent.sent, 'pinCode')).toBe('[omessa]');
    // Quello che arriva al servizio: WS-Security e il PIN cifrato (RSA PKCS#1 v1.5, BASE64).
    const env = spy.requests.at(-1)!.envelope;
    expect(valueOf(env, 'Username')).toBe(AUTH.username);
    const pin = valueOf(env, 'pinCode')!;
    expect(pin).not.toBe(AUTH.pin);
    expect(Buffer.from(pin, 'base64')).toHaveLength(256);
  });

  it('«ELAB» finché la Regione non ha finito, poi OK; il medico richiede l’esito', async () => {
    const { client, ready, now } = setup({ elabPolls: 1 });
    const doc = await ready();
    const sent = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    if (sent.outcome !== 'accepted') throw new Error(JSON.stringify(sent));
    const ask = () =>
      client.outcome({ author, temporaryId: sent.temporaryId!, from: created, to: now() }, AUTH);
    expect(await ask()).toMatchObject({ outcome: 'checked', state: 'ELAB', oid: null });
    expect(await ask()).toMatchObject({ outcome: 'checked', state: 'OK' });
  });

  it('«ELAB» anche quando il Gateway ha pubblicato ma i metadati non sono ancora a INI', async () => {
    let pending = true;
    const { client, ready, now } = setup({}, () => (pending ? 'ini-pending' : 'ok'));
    const doc = await ready();
    const sent = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    if (sent.outcome !== 'accepted') throw new Error(JSON.stringify(sent));
    const ask = () =>
      client.outcome({ author, temporaryId: sent.temporaryId!, from: created, to: now() }, AUTH);
    expect(await ask()).toMatchObject({ outcome: 'checked', state: 'ELAB', oid: null });
    pending = false;
    expect(await ask()).toMatchObject({ outcome: 'checked', state: 'OK' });
  });

  it('«KO» con la motivazione: il documento non firmato il Gateway non lo pubblica', async () => {
    const { client, ready, now } = setup();
    const doc = await ready(sampleInput(), false);
    const sent = await client.create(
      { author, metadata: metadata({ signed: false }), ...doc },
      AUTH,
    );
    if (sent.outcome !== 'accepted') throw new Error(JSON.stringify(sent));
    const out = await client.outcome(
      { author, temporaryId: sent.temporaryId!, from: created, to: now() },
      AUTH,
    );
    expect(out).toMatchObject({ outcome: 'checked', state: 'KO', oid: null });
    expect(out.outcome === 'checked' && out.reason).toMatch(/PAdES/);
  });

  it('un workflowInstanceId che il Gateway non conosce si rifiuta subito, da correggere', async () => {
    const { client, ready } = setup();
    const doc = await ready();
    const sent = await client.create(
      { author, metadata: metadata(), ...doc, workflowInstanceId: 'sconosciuto' },
      AUTH,
    );
    expect(sent).toMatchObject({ outcome: 'rejected', esito: '9999', retryable: false });
    expect(sent.outcome === 'rejected' && sent.errors[0]!.code).toBe('SIM_WORKFLOW');
  });

  it('REPLACE: dall’OID all’UUID con la ricerca, poi la versione nuova al posto della vecchia', async () => {
    const { sim, client, ready, now } = setup();
    const first = await ready();
    const c = await client.create({ author, metadata: metadata(), ...first }, AUTH);
    if (c.outcome !== 'accepted') throw new Error(JSON.stringify(c));
    const o1 = await client.outcome(
      { author, temporaryId: c.temporaryId!, from: created, to: now() },
      AUTH,
    );
    if (o1.outcome !== 'checked' || !o1.oid) throw new Error(JSON.stringify(o1));
    const found = await client.search(
      { author, patientFiscalCode: PATIENT, documentOid: o1.oid },
      AUTH,
    );
    if (found.outcome !== 'found') throw new Error(JSON.stringify(found));
    expect(found.uuid).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    const base = sampleInput();
    const second = await ready(
      sampleInput({
        document: {
          ...base.document,
          id: { root: base.document.id.root, extension: `${base.document.id.extension}.2` },
          version: 2,
          replaces: base.document.id,
        },
      }),
    );
    const r = await client.replace(
      { author, metadata: metadata(), ...second, target: found.uuid },
      AUTH,
    );
    if (r.outcome !== 'accepted') throw new Error(JSON.stringify(r));
    // Associazione RPLC: sourceObject è l'UUID simbolico, targetObject il documento da sostituire.
    expect(valueOf(r.sent, 'tipoAttivita')).toBe('REPLACE');
    expect(valueOf(r.sent, 'associationType')).toBe('urn:ihe:iti:2007:AssociationType:RPLC');
    expect(valueOf(r.sent, 'sourceObject')).toBe(valueOf(r.sent, 'IdentificativoUnivocoDocumento'));
    expect(valueOf(r.sent, 'targetObject')).toBe(found.uuid);
    expect(valueOf(r.sent, 'RiferimentoDocumento')).toBe(found.uuid);
    expect(valueOf(r.sent, 'previousVersion')).toBeNull();
    expect(valueOf(r.sent, 'RappresentanteLegale')).toBe(author.fiscalCode);
    const o2 = await client.outcome(
      { author, temporaryId: r.temporaryId!, from: created, to: now() },
      AUTH,
    );
    if (o2.outcome !== 'checked' || !o2.oid) throw new Error(JSON.stringify(o2));
    expect(sim.stored(o1.oid)!.replacedBy).toBe(o2.oid);
  });

  it('UPDATE: solo i metadati; l’oscuramento è «V» con P99, e si toglie con «N»', async () => {
    const { sim, client, ready, now } = setup();
    const doc = await ready();
    const c = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    const o = await client.outcome(
      {
        author,
        temporaryId: c.outcome === 'accepted' ? c.temporaryId! : '',
        from: created,
        to: now(),
      },
      AUTH,
    );
    if (o.outcome !== 'checked' || !o.oid) throw new Error(JSON.stringify(o));
    const u = await client.update(
      { author, metadata: metadata({ confidentiality: 'V' }), documentOid: o.oid },
      AUTH,
    );
    expect(u).toMatchObject({ outcome: 'accepted', esito: '0000', temporaryId: null });
    for (const [name, value] of [
      ['tipoAttivita', 'UPDATE'],
      ['LivelloConfidenzialita', 'V'],
      ['RegoleAccesso', 'P99'],
      ['RiferimentoDocumento', o.oid],
      ['associationType', 'urn:oasis:names:tc:ebxmlregrep:AssociationType:HasMember'],
      ['sourceObject', 'source'],
      ['targetObject', 'target update'],
      ['submissionSetStatus', 'Original'],
      ['previousVersion', '1'],
      ['IdentificativoUnivocoDocumento', 'source'],
      ['RappresentanteLegale', author.fiscalCode],
    ])
      expect([name, valueOf(u.sent, name!)]).toEqual([name, value]);
    for (const name of ['documento', 'WorkflowInstanceId', 'Locality', 'HashDoc', 'SizeDoc'])
      expect([name, valueOf(u.sent, name)]).toEqual([name, null]);
    expect(sim.stored(o.oid)!.confidentiality).toBe('V');
    const back = await client.update({ author, metadata: metadata(), documentOid: o.oid }, AUTH);
    expect(back.outcome).toBe('accepted');
    expect(valueOf(back.sent, 'RegoleAccesso')).toBeNull();
    expect(sim.stored(o.oid)!.confidentiality).toBe('N');
  });

  it('cancellazione con l’OID, anche sul Gateway; una seconda volta «1103», solo l’autore', async () => {
    const { gateway, client, ready, now } = setup();
    const input = sampleInput();
    const doc = await ready(input);
    const c = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    const o = await client.outcome(
      {
        author,
        temporaryId: c.outcome === 'accepted' ? c.temporaryId! : '',
        from: created,
        to: now(),
      },
      AUTH,
    );
    if (o.outcome !== 'checked' || !o.oid) throw new Error(JSON.stringify(o));
    const other = { ...author, fiscalCode: 'LTRMDC70C10X001Z' };
    const denied = await client.remove(
      { author: other, patientFiscalCode: PATIENT, documentId: o.oid },
      AUTH,
    );
    expect(denied.outcome === 'rejected' && denied.errors[0]!.code).toBe('SIM_AUTORE');
    const d = await client.remove({ author, patientFiscalCode: PATIENT, documentId: o.oid }, AUTH);
    expect(d).toMatchObject({ outcome: 'accepted', esito: '0000' });
    expect(valueOf(d.sent, 'TipoDocumento')).toBe('60591-5');
    expect(valueOf(d.sent, 'TipoAttivita')).toBe('DELETE');
    expect(valueOf(d.sent, 'IdentificativoDocumento')).toBe(o.oid);
    const id = `${input.document.id.root}^${input.document.id.extension}`;
    expect(gateway.published(id)!.deleted).toBe(true);
    const again = await client.remove(
      { author, patientFiscalCode: PATIENT, documentId: o.oid },
      AUTH,
    );
    expect(again).toMatchObject({ outcome: 'rejected', esito: '9999', retryable: false });
    expect(again.outcome === 'rejected' && again.errors[0]!.code).toBe('1103');
  });

  it('ricerca senza risultati: «1059», nessun documento; esito di un identificativo sconosciuto', async () => {
    const { client, now } = setup();
    const r = await client.search(
      { author, patientFiscalCode: PATIENT, documentOid: '2.999^1' },
      AUTH,
    );
    expect(r).toMatchObject({ outcome: 'not-found' });
    expect(r.outcome === 'not-found' && r.warnings[0]!.code).toBe('1059');
    const o = await client.outcome(
      { author, temporaryId: 'TEMP_010_1', from: created, to: now() },
      AUTH,
    );
    expect(o).toMatchObject({ outcome: 'rejected', retryable: false });
  });

  it('credenziali: WS-Security o PIN rifiutati, anche decifrati vuoti, sono un problema di credenziali; un PIN mancante no', async () => {
    const { client, ready, sim, spy } = setup({ credentials: (_u, _p, pin) => pin === AUTH.pin });
    const doc = await ready();
    const noPassword = await client.create(
      { author, metadata: metadata(), ...doc },
      { ...AUTH, password: '' },
    );
    expect(noPassword).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
      retryable: false,
    });
    expect(
      await client.create({ author, metadata: metadata(), ...doc }, { ...AUTH, pin: '0000' }),
    ).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
    });
    // PIN cifrato con un altro certificato: decifrato dà un valore a caso, non quello del medico.
    // L'altro certificato ha il modulo più piccolo di quello della Regione. Con uno più grande il
    // valore cifrato può superarlo, e allora non si decifra affatto: è il PIN non cifrato con il
    // certificato della Regione, un errore del messaggio. Con chiavi nuove a ogni prova capitava a
    // caso: 118 volte su 1560 coppie di chiavi provate con Node 22, mai con il modulo più piccolo.
    const modulus = (der: Uint8Array) =>
      BigInt(
        `0x${Buffer.from(new X509Certificate(der).publicKey.export({ format: 'jwk' }).n!, 'base64url').toString('hex')}`,
      );
    let other = createTestCertificate({ commonName: 'Altro' });
    while (modulus(other.der) >= modulus(sim.encryptionCertificate))
      other = createTestCertificate({ commonName: 'Altro' });
    const wrongKey = new RegionalFseClient(sim, {
      encryptionCertificate: other.der,
      application: caller.application,
    });
    expect(await wrongKey.create({ author, metadata: metadata(), ...doc }, AUTH)).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
    });
    // Un PIN che si decifra vuoto è un PIN sbagliato, non un PIN mancante. Con la «implicit
    // rejection» capita anche al PIN cifrato con un'altra chiave, circa una volta su 230: qui il
    // caso si prova sempre, non solo quando capita (D286).
    expect(
      await client.create({ author, metadata: metadata(), ...doc }, { ...AUTH, pin: '' }),
    ).toMatchObject({ outcome: 'rejected', authProblem: 'credentials' });
    // Senza PIN nel messaggio: errore del messaggio, da correggere.
    await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    const envelope = spy.requests
      .at(-1)!
      .envelope.replace(/<pinCode>[^<]*<\/pinCode>/, '<pinCode></pinCode>');
    const res = await sim.send({ service: 'ComunicazioneMetadati', envelope });
    expect(valueOf('body' in res ? res.body : '', 'codEsito')).toBe('SIM_PIN');
  });

  it('rete assente, nessuna risposta, errore di sistema, risposta senza esito: si riprova', async () => {
    for (const [decide, expected] of [
      ['unreachable', { outcome: 'unreachable' }],
      ['timeout', { outcome: 'timeout' }],
      ['system-error', { outcome: 'rejected', esito: '9999', retryable: true }],
      ['no-esito', { outcome: 'rejected', retryable: true }],
    ] as [SimulatedRegionalOutcome, object][]) {
      const { client, ready } = setup({ decide: () => decide });
      const doc = await ready();
      expect([
        decide,
        await client.create({ author, metadata: metadata(), ...doc }, AUTH),
      ]).toMatchObject([decide, expected]);
    }
  });

  it('assistito non iscritto in Piemonte o senza consenso all’alimentazione: errore da correggere', async () => {
    for (const [patient, code] of [
      [{ enrolled: false, consent: true }, 'SIM_NON_ISCRITTO'],
      [{ enrolled: true, consent: false }, 'SIM_CONSENSO'],
    ] as const) {
      const { client, ready } = setup({ patient: () => patient });
      const doc = await ready();
      const r = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
      expect(r.outcome === 'rejected' && [r.retryable, r.errors[0]!.code]).toEqual([false, code]);
    }
  });

  it('il simulatore controlla le regole dei campi della V09 su un messaggio cambiato', async () => {
    const { spy, client, ready } = setup();
    const doc = await ready();
    await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    const good = spy.requests.at(-1)!.envelope;
    const cases: [string, string, string][] = [
      ['<tip:TipoAttivitaClinica>ERP<', '<tip:TipoAttivitaClinica>OBS<', 'TipoAttivitaClinica'],
      ['<tip:IstituzioneAutore>010203<', '<tip:IstituzioneAutore>010<', 'IstituzioneAutore'],
      [
        '<tip:LivelloConfidenzialita>N</tip:LivelloConfidenzialita>',
        '<tip:LivelloConfidenzialita>N</tip:LivelloConfidenzialita><tip:RegoleAccesso>P99</tip:RegoleAccesso>',
        'RegoleAccesso',
      ],
      [
        '<tip:DataFinePrestazione>20261118103000<',
        '<tip:DataFinePrestazione>20261118113000<',
        'DataFinePrestazione',
      ],
      ['<tip:SpecialitaAutore>AD_PSC130<', '<tip:SpecialitaAutore>AD_PSC001<', 'SpecialitaAutore'],
      ['<tip:RegimeDocumento>SSN<', '<tip:RegimeDocumento>AUTO<', 'RegimeDocumento'],
      [
        '<tip:TipologiaStrutturaProdDoc>Territorio<',
        '<tip:TipologiaStrutturaProdDoc>Ospedale<',
        'TipologiaStrutturaProdDoc',
      ],
      [
        '<identificativoOrganizzazione>010<',
        '<identificativoOrganizzazione>030<',
        'IdentificativoOrganizzazione',
      ],
      ['<ModalitaAlimentazione>FSE2.0<', '<ModalitaAlimentazione>FSE1.0<', 'ModalitaAlimentazione'],
      [
        '<tip:CodiceFiscaleAutore>MDCPRV65B12X001Y',
        '<tip:CodiceFiscaleAutore>LTRMDC70C10X001Z',
        'CodiceFiscaleAutore',
      ],
      [`<tip:SizeDoc>${doc.document.byteLength}<`, '<tip:SizeDoc>1<', 'SizeDoc'],
    ];
    for (const [from, to, rule] of cases) {
      expect([rule, good.includes(from)]).toEqual([rule, true]);
      const res = await spy.inner.send({
        service: 'ComunicazioneMetadati',
        envelope: good.replace(from, to),
      });
      const body = 'body' in res ? res.body : '';
      expect([rule, valueOf(body, 'Esito'), valueOf(body, 'esito')]).toEqual([
        rule,
        '9999',
        expect.stringContaining(rule),
      ]);
    }
  });
});

describe('Gateway: eliminazione del documento (specifiche 2.26, 6)', () => {
  it('DELETE con UPDATE e DELETE nei token; dopo, il documento non si sostituisce più', async () => {
    const { gateway, client, ready, now } = setup();
    const input = sampleInput();
    const doc = await ready(input);
    const c = await client.create({ author, metadata: metadata(), ...doc }, AUTH);
    await client.outcome(
      {
        author,
        temporaryId: c.outcome === 'accepted' ? c.temporaryId! : '',
        from: created,
        to: now(),
      },
      AUTH,
    );
    const national = new FseGatewayClient(
      gateway,
      gateway.issueCredentials('Altro programma'),
      now,
    );
    const id = `${input.document.id.root}^${input.document.id.extension}`;
    const removed = await national.remove(caller, PATIENT, id);
    expect(removed).toMatchObject({ outcome: 'ok', status: 200 });
    expect(gateway.log.at(-1)).toMatchObject({ operation: 'deletion', status: 200 });
    const again = await national.remove(caller, PATIENT, id);
    expect(again).toMatchObject({ outcome: 'problem', status: 404 });
  });
});
