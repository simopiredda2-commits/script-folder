import { buildFiscalCode, composeNre } from '@mmg/domain';
import type { DpcmPrescription, ServiceAuth } from '@mmg/integrations';
import { describe, expect, it } from 'vitest';
import { DPCM_SEND_TYPE, SAR_LOT_TYPE, SimulatedSar } from '..';

// Codici fiscali e numeri inventati (D12): luogo di nascita con la X.
const DOCTOR = buildFiscalCode({
  surname: 'Marchi',
  name: 'Elena',
  birthDate: '1970-01-01',
  sex: 'F',
  placeCode: 'X001',
});
const PATIENT = buildFiscalCode({
  surname: 'Rossetti',
  name: 'Lina',
  birthDate: '1950-03-14',
  sex: 'F',
  placeCode: 'X101',
});

/** Una ricetta specialistica con il catalogo e il tipo di accesso in Prescrizione2 (V06, 4.2.1). */
const specialistica = (nre: string): DpcmPrescription => ({
  bar1: '01026',
  bar2: '0001234057',
  patientFiscalCode: PATIENT,
  kind: 'P',
  exemptionCode: null,
  notExempt: true,
  diagnosisText: 'Controllo dopo la terapia',
  compiledAt: '2026-11-25',
  visitType: 'A',
  patientProvince: 'TO',
  patientAsl: '301',
  priority: 'P',
  nre,
  doctorFiscalCode: DOCTOR,
  lines: [
    {
      productCode: '90.62.2',
      description: 'EMOCROMO: ESAME CROMOCITOMETRICO E CONTEGGIO LEUCOCITARIO',
      quantity: 1,
      prescription2: 'CODCATPRESCR=90.62.2_0$TIPOACC=P$',
    },
  ],
});

describe('ricetta DPCM nel simulatore del SAR (V06, 4.2; D270)', () => {
  const auth: ServiceAuth = {
    username: 'utente-di-prova',
    password: 'parola-di-prova',
    pin: '1234',
  };
  const withLot = async (sar: SimulatedSar) => {
    const r = await sar.requestLot(
      { regionCode: '010', lotType: SAR_LOT_TYPE, doctorFiscalCode: DOCTOR },
      auth,
    );
    if (r.outcome !== 'assigned') throw new Error('atteso un lotto');
    return composeNre(r.lot, 5);
  };

  it('accoglie con un protocollo di 23 cifre; l’esito prima è «in attesa», poi senza errori', async () => {
    const sar = new SimulatedSar({ now: () => new Date('2026-11-25T10:00:00Z') });
    const nre = await withLot(sar);
    const r = await sar.sendDpcm(
      { prescription: specialistica(nre), fileName: 'ricetta01_PROVA.zip' },
      auth,
    );
    if (r.outcome !== 'accepted') throw new Error(JSON.stringify(r));
    expect(r.protocol).toMatch(/^99\d{21}$/);
    expect(sar.dpcmFiles[0]!.xml).toContain(`<TipoInvio>${DPCM_SEND_TYPE}</TipoInvio>`);
    expect(DPCM_SEND_TYPE).toBe('RPS');
    expect(await sar.dpcmSummary({ protocol: r.protocol }, auth)).toMatchObject({
      outcome: 'ok',
      state: 1,
    });
    expect(await sar.dpcmSummary({ protocol: r.protocol }, auth)).toMatchObject({
      outcome: 'ok',
      state: 2,
    });
    const a = await sar.dpcmAnalytic({ protocol: r.protocol }, auth);
    expect(a).toMatchObject({
      outcome: 'ok',
      records: [{ protocol: r.protocol, barcode: '010260001234057', errors: [] }],
    });
  });

  it('il giorno dopo la compilazione dà l’avviso 2090, che non si corregge', async () => {
    const sar = new SimulatedSar({
      now: () => new Date('2026-11-26T10:00:00Z'),
      dpcmPendingChecks: 0,
    });
    const nre = await withLot(sar);
    const r = await sar.sendDpcm(
      { prescription: specialistica(nre), fileName: 'ricetta01_PROVA.zip' },
      auth,
    );
    if (r.outcome !== 'accepted') throw new Error('attesa accolta');
    expect(await sar.dpcmSummary({ protocol: r.protocol }, auth)).toMatchObject({ state: 3 });
    const a = await sar.dpcmAnalytic({ protocol: r.protocol }, auth);
    expect(a.outcome === 'ok' && a.records[0]!.errors).toEqual([
      { code: '2090', description: 'Avviso: Data compilazione precedente alla data di ricezione' },
    ]);
  });

  it('rifiuta il token, un nome di file corto e un NRE che non è dei lotti del medico', async () => {
    const sar = new SimulatedSar();
    const nre = await withLot(sar);
    const ok = { prescription: specialistica(nre), fileName: 'ricetta01_PROVA.zip' };
    expect(await sar.sendDpcm(ok, { bearer: 'token-di-prova' })).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
    });
    expect(await sar.sendDpcm({ ...ok, fileName: 'a.zip' }, auth)).toMatchObject({
      outcome: 'rejected',
      code: '101',
    });
    expect(
      await sar.sendDpcm({ ...ok, prescription: specialistica('010A04000000000') }, auth),
    ).toMatchObject({ outcome: 'rejected', code: 'SIM-NRE-LOTTO' });
  });

  it('simula errori scartanti, rete assente e tempo scaduto', async () => {
    const sar = new SimulatedSar({
      dpcmPendingChecks: 0,
      decideDpcm: () => ({
        state: 4,
        errors: [{ code: 'SIM-ERR', description: 'Errore scartante (simulato)' }],
      }),
    });
    const nre = await withLot(sar);
    const r = await sar.sendDpcm(
      { prescription: specialistica(nre), fileName: 'ricetta01_PROVA.zip' },
      auth,
    );
    if (r.outcome !== 'accepted') throw new Error('attesa accolta');
    expect(await sar.dpcmSummary({ protocol: r.protocol }, auth)).toMatchObject({ state: 4 });
    for (const outcome of ['unreachable', 'timeout'] as const) {
      const down = new SimulatedSar({ decideDpcmReceipt: () => outcome });
      expect(
        (
          await down.sendDpcm(
            { prescription: specialistica(nre), fileName: 'ricetta01_PROVA.zip' },
            auth,
          )
        ).outcome,
      ).toBe(outcome);
    }
  });
});
