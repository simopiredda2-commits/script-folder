import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatedGateway, systemFor, type PrescriptionMessage } from '../src';

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
    const a = await sar.send(message('a'));
    const b = await sar.send(message('b'));
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
      const r = await sar.send(message());
      expect(r.outcome).toBe(outcome);
      if (r.outcome === 'rejected') expect(r.message).toMatch(/rifiutata/);
    },
  );

  it('annulla solo ricette che ha emesso, una volta', async () => {
    const sar = new SimulatedGateway('sar');
    const r = await sar.send(message());
    if (r.outcome !== 'accepted') throw new Error('atteso accettato');
    const doctor = message().doctor;
    expect((await sar.cancel({ nre: r.nre, reason: 'prova', doctor })).outcome).toBe('accepted');
    expect((await sar.cancel({ nre: r.nre, reason: 'prova', doctor })).outcome).toBe('rejected');
    expect((await sar.cancel({ nre: 'SIMR999', reason: 'prova', doctor })).outcome).toBe(
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
    const sent = await g.send({
      localId: 'r1',
      kind: 'specialist_ssn',
      patientFiscalCode: 'XXXXXX00X00X000X',
      doctor,
      lines: [{ serviceDescription: 'Visita di prova', quantity: 1 }],
      compiledAt: '2026-11-18',
    });
    if (sent.outcome !== 'accepted') throw new Error('invio non accettato');
    expect(await g.status({ nre: sent.nre, doctor })).toMatchObject({
      outcome: 'ok',
      state: 'non_erogata',
    });
    await g.cancel({ nre: sent.nre, reason: 'prova', doctor });
    expect(await g.status({ nre: sent.nre, doctor })).toMatchObject({
      outcome: 'ok',
      state: 'annullata',
    });
    expect((await g.status({ nre: 'SCONOSCIUTO', doctor })).outcome).toBe('rejected');
  });

  it('nelle prove si sceglie lo stato, anche «non raggiungibile»', async () => {
    const g = new SimulatedGateway('sar', {
      decideStatus: (nre) => (nre === 'A' ? 'erogata' : 'unreachable'),
    });
    expect(await g.status({ nre: 'A', doctor })).toMatchObject({ outcome: 'ok', state: 'erogata' });
    expect((await g.status({ nre: 'B', doctor })).outcome).toBe('unreachable');
  });
});
