import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SimulatedGateway,
  SimulatedSecondFactor,
  SimulatedSickLeaveGateway,
  systemFor,
  type PrescriptionMessage,
  type ServiceAuth,
} from '../src';

/**
 * Credenziali inventate: i simulatori ne controllano solo la forma. Con l'Id-Sessione per email il
 * SAR vuole anche X-Gestionale, la RUPAR l'informazione «APP» (REL-STC-01 V08; D266).
 */
const auth: ServiceAuth = {
  username: 'utente-di-prova',
  password: 'parola-di-prova',
  pin: '1234',
  software: 'MIOAPPLICATIVO_301',
};

const message = (localId = 'r1'): PrescriptionMessage => ({
  localId,
  kind: 'pharma_ssn',
  patientFiscalCode: 'RTOLNI50C54X101X',
  doctor: { userId: 'u1', name: 'Dott.ssa di prova' },
  lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
  compiledAt: '2026-11-18',
});

describe('simulatore del SAR e del Sistema TS', () => {
  it('per difetto accetta e dà numeri di ricetta di fantasia, uno diverso per ricetta', async () => {
    const sar = new SimulatedGateway('sar');
    const a = await sar.send(message('a'), auth);
    const b = await sar.send(message('b'), auth);
    expect(a.outcome).toBe('accepted');
    if (a.outcome === 'accepted' && b.outcome === 'accepted') {
      expect(a.nre).toMatch(/^SIMR\d{12}$/);
      expect(a.nre).not.toBe(b.nre);
    }
    expect(sar.received.map((m) => m.localId)).toEqual(['a', 'b']);
  });

  it.each(['rejected', 'unreachable', 'timeout'] as const)(
    'simula l’esito «%s»',
    async (outcome) => {
      const sar = new SimulatedGateway('sar', { decide: () => outcome });
      const r = await sar.send(message(), auth);
      expect(r.outcome).toBe(outcome);
      if (r.outcome === 'rejected') expect(r.message).toMatch(/rifiutata/);
    },
  );

  it('non sostituibile senza il codice della motivazione: rifiutata, come dal SAC (D273)', async () => {
    const sar = new SimulatedGateway('sar');
    const line = {
      drugName: 'Farmaco di prova',
      drugAic: '099998011',
      quantity: 1,
      notSubstitutable: true,
    };
    await expect(sar.send({ ...message('a'), lines: [line] }, auth)).resolves.toMatchObject({
      outcome: 'rejected',
      code: 'SIM-MOTIVAZIONE',
    });
    await expect(
      sar.send({ ...message('b'), lines: [{ ...line, notSubstitutableCode: '1' }] }, auth),
    ).resolves.toMatchObject({ outcome: 'accepted' });
  });

  it('annulla solo ricette che ha emesso, una volta', async () => {
    const sar = new SimulatedGateway('sar');
    const r = await sar.send(message(), auth);
    if (r.outcome !== 'accepted') throw new Error('atteso accettato');
    const doctor = message().doctor;
    expect((await sar.cancel({ nre: r.nre, reason: 'prova', doctor }, auth)).outcome).toBe(
      'accepted',
    );
    expect((await sar.cancel({ nre: r.nre, reason: 'prova', doctor }, auth)).outcome).toBe(
      'rejected',
    );
    expect((await sar.cancel({ nre: 'SIMR999', reason: 'prova', doctor }, auth)).outcome).toBe(
      'rejected',
    );
  });

  it('la ricetta bianca va al Sistema TS, le altre al SAR', () => {
    expect(systemFor('white')).toBe('sistema_ts');
    for (const k of ['pharma_ssn', 'specialist_ssn', 'devices'] as const)
      expect(systemFor(k)).toBe('sar');
  });
});

describe('nessuna chiamata a servizi reali (regola 7)', () => {
  it('il codice delle integrazioni non contiene indirizzi di rete né richieste HTTP', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    /** Nomi di spazi XML: sono identificatori, non indirizzi da chiamare. */
    // Spazi dei nomi XML: identificativi dei messaggi, non indirizzi da chiamare. Quelli dei
    // messaggi SOAP del Fascicolo regionale sono della V09 (5.2.1) e di WS-Security (D280).
    const XML_NAMESPACES = [
      'http://purl.oclc.org/dsdl/schematron',
      'http://www.w3.org/2001/XMLSchema-instance',
      'http://www.w3.org/2003/05/soap-envelope',
      'http://schemas.xmlsoap.org/soap/envelope/',
      'http://dmaclbl.csi.it/',
      'http://tipodaticomunicazionemetadati.xsd.fse.ini.finanze.it',
      'http://dma.csi.it/',
      'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
      'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText',
    ];
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    expect(files.map((e) => e.name)).toContain('schematron.ts');
    for (const e of files) {
      let text = readFileSync(join(e.parentPath, e.name), 'utf8');
      for (const ns of XML_NAMESPACES) text = text.replaceAll(ns, '');
      expect(text, e.name).not.toMatch(/https?:\/\//);
      expect(text, e.name).not.toMatch(/\bfetch\(|node:https?|from 'undici'|axios/);
    }
  });
});

describe('stato di erogazione (D70)', () => {
  const doctor = { userId: 'u1', name: 'Medico inventato' };
  it('per difetto non ancora presa in carico; annullata dopo l’annullamento; sconosciuta se l’NRE non c’è', async () => {
    const g = new SimulatedGateway('sar');
    const sent = await g.send(
      {
        localId: 'r1',
        kind: 'specialist_ssn',
        patientFiscalCode: 'XXXXXX00X00X000X',
        doctor,
        lines: [{ serviceDescription: 'Visita di prova', quantity: 1 }],
        compiledAt: '2026-11-18',
      },
      auth,
    );
    if (sent.outcome !== 'accepted') throw new Error('invio non accettato');
    expect(await g.status({ nre: sent.nre, doctor }, auth)).toMatchObject({
      outcome: 'ok',
      state: 'non_erogata',
    });
    await g.cancel({ nre: sent.nre, reason: 'prova', doctor }, auth);
    expect(await g.status({ nre: sent.nre, doctor }, auth)).toMatchObject({
      outcome: 'ok',
      state: 'annullata',
    });
    expect((await g.status({ nre: 'SCONOSCIUTO', doctor }, auth)).outcome).toBe('rejected');
  });

  it('nelle prove si sceglie lo stato, anche «non raggiungibile»', async () => {
    const g = new SimulatedGateway('sar', {
      decideStatus: (nre) => (nre === 'A' ? 'erogata' : 'unreachable'),
    });
    expect(await g.status({ nre: 'A', doctor }, auth)).toMatchObject({
      outcome: 'ok',
      state: 'erogata',
    });
    expect((await g.status({ nre: 'B', doctor }, auth)).outcome).toBe('unreachable');
  });
});

describe('credenziali e secondo fattore nei simulatori (D100–D102)', () => {
  it('senza utente, password o PIN il simulatore rifiuta come il SAR', async () => {
    const sar = new SimulatedGateway('sar');
    expect(await sar.send(message(), { ...auth, password: '' })).toMatchObject({
      outcome: 'rejected',
      code: 'CREDENZIALI',
      message: 'Credenziali invalide (from client)',
      authProblem: 'credentials',
    });
    expect(await sar.send(message(), { ...auth, pin: '' })).toMatchObject({
      outcome: 'rejected',
      code: 'EA01',
      authProblem: 'credentials',
    });
    expect(sar.receivedAuth.at(-1)).toEqual({
      username: 'utente-di-prova',
      sessionId: null,
      bearer: false,
      software: 'MIOAPPLICATIVO_301',
    });
    expect(JSON.stringify(sar.receivedAuth)).not.toMatch(/parola-di-prova|1234/);
  });

  it('il codice arriva «per email», vale 8 ore, e uno nuovo annulla il precedente', async () => {
    let t = Date.parse('2026-11-18T08:00:00Z');
    const sf = new SimulatedSecondFactor('rupar_piemonte', { now: () => new Date(t) });
    const cf = 'MRCLNE70A41X001X';
    const first = await sf.requestCode({ auth, fiscalCode: cf });
    if (first.outcome !== 'sent' || !first.testCode) throw new Error('codice non inviato');
    expect(sf.outbox).toEqual([{ fiscalCode: cf, code: first.testCode }]);
    expect(await sf.check({ auth, fiscalCode: cf, sessionId: first.testCode })).toMatchObject({
      outcome: 'valid',
      validUntil: '2026-11-18T16:00:00.000Z',
    });
    expect((await sf.check({ auth, fiscalCode: 'ALTRO', sessionId: first.testCode })).outcome).toBe(
      'invalid',
    );
    const second = await sf.requestCode({ auth, fiscalCode: cf });
    if (second.outcome !== 'sent') throw new Error('codice non inviato');
    expect(sf.isValid(first.testCode)).toBe(false);
    expect(sf.isValid(second.testCode)).toBe(true);
    t += 8 * 3_600_000;
    expect(sf.isValid(second.testCode)).toBe(false);
  });

  it('il codice non si chiede senza credenziali, né con la password scaduta', async () => {
    const sf = new SimulatedSecondFactor('rupar_piemonte', {
      rejectCredentials: () => 'expired',
    });
    expect(
      await sf.requestCode({ auth: { ...auth, username: '' }, fiscalCode: 'X' }),
    ).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
    });
    expect(await sf.requestCode({ auth, fiscalCode: 'X' })).toMatchObject({
      outcome: 'rejected',
      message: 'Password scaduta (from client)',
    });
  });

  it('con il secondo fattore, il SAR simulato vuole un Id-Sessione valido a ogni chiamata', async () => {
    const sf = new SimulatedSecondFactor('rupar_piemonte');
    const sar = new SimulatedGateway('sar', { sessions: sf });
    expect(await sar.send(message(), auth)).toMatchObject({
      outcome: 'rejected',
      code: 'ID_SESSIONE',
      authProblem: 'session',
    });
    const r = await sf.requestCode({ auth, fiscalCode: 'CF' });
    if (r.outcome !== 'sent' || !r.testCode) throw new Error('codice non inviato');
    const ok = await sar.send(message(), { ...auth, sessionId: r.testCode });
    expect(ok.outcome).toBe('accepted');
    await sf.revoke({ auth, fiscalCode: 'CF', sessionId: r.testCode });
    if (ok.outcome !== 'accepted') throw new Error('invio non accettato');
    expect(
      (
        await sar.status(
          { nre: ok.nre, doctor: message().doctor },
          { ...auth, sessionId: r.testCode },
        )
      ).outcome,
    ).toBe('rejected');
  });

  it('il simulatore dei certificati vuole le credenziali del Sistema TS', async () => {
    const inps = new SimulatedSickLeaveGateway();
    const doctor = { userId: 'u1', name: 'Medico inventato', fiscalCode: 'CF' };
    expect(
      await inps.cancel({ protocol: 'SIM1', workerFiscalCode: 'W', doctor }, { ...auth, pin: '' }),
    ).toMatchObject({ outcome: 'rejected', code: 'EA01', authProblem: 'credentials' });
    expect(inps.receivedAuth).toEqual([{ operation: 'annullamento', username: 'utente-di-prova' }]);
  });
});
