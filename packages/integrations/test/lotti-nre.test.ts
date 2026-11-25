import { buildFiscalCode, composeNre, nreProblem } from '@mmg/domain';
import { describe, expect, it } from 'vitest';
import { SimulatedGateway, type PrescriptionMessage, type ServiceAuth } from '../src';

/** Credenziali inventate: il simulatore ne controlla solo la forma. */
const auth: ServiceAuth = {
  username: 'utente-di-prova',
  password: 'parola-di-prova',
  pin: '1234',
  software: 'MIOAPPLICATIVO_301',
};

// Codici fiscali inventati: luogo di nascita con la X, che nessun comune ha (D12).
const cf = (surname: string, name: string) =>
  buildFiscalCode({ surname, name, birthDate: '1970-01-01', sex: 'F', placeCode: 'X001' });
const MARCHI = cf('Marchi', 'Elena');
const SERRA = cf('Serra', 'Paola');

const request = (doctorFiscalCode = MARCHI) => ({
  regionCode: '010',
  lotType: '1',
  doctorFiscalCode,
});

const message = (nre: string | null, fiscalCode = MARCHI, localId = 'r1'): PrescriptionMessage => ({
  localId,
  kind: 'pharma_ssn',
  patientFiscalCode: 'RTOLNI50C54X101X',
  doctor: { userId: 'u1', name: 'Dott.ssa di prova', fiscalCode },
  lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
  compiledAt: '2026-11-25',
  nre,
});

describe('lotti di NRE nel simulatore del SAR (V06, 3.2 e 4.1; D269)', () => {
  it('dà un lotto «estratto» come nell’esempio della V06, uno nuovo a ogni richiesta', async () => {
    const sar = new SimulatedGateway('sar');
    const a = await sar.requestLot(request(), auth);
    const b = await sar.requestLot(request(), auth);
    if (a.outcome !== 'assigned' || b.outcome !== 'assigned') throw new Error('atteso un lotto');
    // Identificativo del lotto del SAR (4), non quello chiesto (1); raggruppamento «ZZ» per
    // riconoscere i numeri simulati.
    expect(a.lot).toMatchObject({ regionCode: '010', groupCode: 'ZZ', lotType: '4' });
    expect(a.lot.lotCode).toMatch(/^\d{6}$/);
    // Un codice dopo l'altro; dopo un riavvio si riparte da un numero a caso.
    expect(Number(b.lot.lotCode)).toBe((Number(a.lot.lotCode) + 1) % 1_000_000);
    expect(nreProblem(composeNre(a.lot, 0))).toBeNull();
    expect(a.raw).toMatchObject({ CodRagLotto: 'ZZ', IdentificativoLotto: '4', CFMedico: MARCHI });
    expect(sar.lotRequests).toHaveLength(2);
  });

  it.each([
    [{ lotType: '' }, '02'],
    [{ lotType: '2' }, '03'],
    [{ regionCode: '' }, '04'],
    [{ regionCode: '020' }, '05'],
    [{ doctorFiscalCode: 'NONVALIDO' }, '06'],
  ])('rifiuta la richiesta %o con il codice %s della V06', async (change, code) => {
    const sar = new SimulatedGateway('sar');
    const r = await sar.requestLot({ ...request(), ...change }, auth);
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.code).toBe(code);
  });

  it('vuole utente, password e PIN RUPAR: niente token dell’accesso regionale (V06, 3.1.1)', async () => {
    const sar = new SimulatedGateway('sar');
    const r = await sar.requestLot(request(), { bearer: 'token-di-prova' });
    expect(r).toMatchObject({ outcome: 'rejected', authProblem: 'credentials' });
    const senzaPin = await sar.requestLot(request(), { username: 'u', password: 'p' });
    expect(senzaPin).toMatchObject({ outcome: 'rejected', authProblem: 'credentials' });
  });

  it.each(['unreachable', 'timeout'] as const)('simula l’esito «%s»', async (outcome) => {
    const sar = new SimulatedGateway('sar', { decideLot: () => outcome });
    expect((await sar.requestLot(request(), auth)).outcome).toBe(outcome);
  });

  it('il lotto lo dà solo il SAR', async () => {
    const ts = new SimulatedGateway('sistema_ts');
    expect((await ts.requestLot(request(), auth)).outcome).toBe('rejected');
  });
});

describe('ricetta con l’NRE della cartella (V06, 4.1 e 4.3.1)', () => {
  const lotOf = async (sar: SimulatedGateway, doctorFiscalCode = MARCHI) => {
    const r = await sar.requestLot(request(doctorFiscalCode), auth);
    if (r.outcome !== 'assigned') throw new Error('atteso un lotto');
    return r.lot;
  };

  it('accetta l’NRE del lotto del medico e lo restituisce com’è', async () => {
    const sar = new SimulatedGateway('sar');
    const nre = composeNre(await lotOf(sar), 7);
    const r = await sar.send(message(nre), auth);
    expect(r).toMatchObject({ outcome: 'accepted', nre });
  });

  it('rifiuta un NRE fuori dai lotti, di un altro medico o già usato', async () => {
    const sar = new SimulatedGateway('sar');
    const lot = await lotOf(sar);
    // L'esempio della V06: un lotto vero, che il simulatore non ha dato.
    const fuori = await sar.send(message('010A04000000000'), auth);
    expect(fuori).toMatchObject({ outcome: 'rejected', code: 'SIM-NRE-LOTTO' });
    const altro = await sar.send(message(composeNre(lot, 1), SERRA), auth);
    expect(altro).toMatchObject({ outcome: 'rejected', code: 'SIM-NRE-MEDICO' });
    expect((await sar.send(message(composeNre(lot, 2)), auth)).outcome).toBe('accepted');
    const usato = await sar.send(message(composeNre(lot, 2), MARCHI, 'r2'), auth);
    expect(usato).toMatchObject({ outcome: 'rejected', code: 'SIM-NRE-USATO' });
  });

  it('dopo un rifiuto la stessa ricetta si rimanda con lo stesso NRE (caso 3)', async () => {
    let first = true;
    const sar = new SimulatedGateway('sar', {
      decide: () => (first ? ((first = false), 'rejected') : 'accepted'),
    });
    const nre = composeNre(await lotOf(sar), 3);
    expect((await sar.send(message(nre), auth)).outcome).toBe('rejected');
    expect(await sar.send(message(nre), auth)).toMatchObject({ outcome: 'accepted', nre });
  });

  it('simula l’eccezione di sistema (caso 4)', async () => {
    const sar = new SimulatedGateway('sar', { decide: () => 'fault' });
    const r = await sar.send(message(composeNre(await lotOf(sar), 0)), auth);
    expect(r.outcome).toBe('fault');
  });

  it('un lotto simulato dato prima di un riavvio si accetta ancora', async () => {
    const before = new SimulatedGateway('sar');
    const nre = composeNre(await lotOf(before), 9);
    const after = new SimulatedGateway('sar');
    expect(await after.send(message(nre), auth)).toMatchObject({ outcome: 'accepted', nre });
  });

  it('senza NRE della cartella il simulatore ne dà uno di fantasia, come prima', async () => {
    const sar = new SimulatedGateway('sar');
    const r = await sar.send(message(null), auth);
    if (r.outcome !== 'accepted') throw new Error('atteso accettato');
    expect(r.nre).toMatch(/^SIMR\d{12}$/);
  });
});
