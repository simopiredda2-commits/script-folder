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

/** Credenziali inventate: i simulatori ne controllano solo la forma. */
const auth: ServiceAuth = { username: 'utente-di-prova', password: 'parola-di-prova', pin: '1234' };

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
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/https?:\/\//);
      expect(text, f).not.toMatch(/\bfetch\(|node:https?|from 'undici'|axios/);
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
