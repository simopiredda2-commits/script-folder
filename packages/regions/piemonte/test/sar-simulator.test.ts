import {
  newPkceVerifier,
  pkceChallenge,
  SimulatedGateway,
  type PrescriptionMessage,
} from '@mmg/integrations';
import { describe, expect, it } from 'vitest';
import { piemonte, SAR_TEXTS, SimulatedSar, SimulatedSirpedAccess } from '..';

/** Una ricetta inventata: il simulatore guarda le credenziali e l'NRE, non il contenuto. */
const message: PrescriptionMessage = {
  localId: 'r1',
  kind: 'pharma_ssn',
  patientFiscalCode: 'RTOLNI50C54X101X',
  doctor: { userId: 'u1', name: 'Dott.ssa di prova' },
  lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
  compiledAt: '2026-11-18',
};

describe('SAR simulato: le credenziali della Regione (REL-STC-01 V08; D266, D300)', () => {
  it('accetta il token al posto di utente, password e PIN; revocato, rifiuta', async () => {
    const oauth = new SimulatedSirpedAccess();
    const sar = new SimulatedSar({ oauth });
    const verifier = newPkceVerifier();
    const code = oauth.approve({
      clientId: 'MIOAPPLICATIVO_301',
      redirectUri: '/r',
      scope: ['prescrizione'],
      codeChallenge: pkceChallenge(verifier),
      fiscalCode: 'CF',
    });
    const token = await oauth.exchange({
      code,
      redirectUri: '/r',
      clientId: 'MIOAPPLICATIVO_301',
      codeVerifier: verifier,
    });
    if (token.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect((await sar.send(message, { bearer: token.accessToken })).outcome).toBe('accepted');
    expect(sar.receivedAuth.at(-1)).toEqual({
      username: '',
      sessionId: null,
      bearer: true,
      software: null,
    });
    // Il token non si manda insieme a utente, password e PIN (V08, 4.3.6).
    expect(
      await sar.send(message, {
        bearer: token.accessToken,
        username: 'utente',
        password: 'parola',
        pin: '1',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'CREDENZIALI', authProblem: 'credentials' });
    await oauth.revoke({ clientId: 'MIOAPPLICATIVO_301', accessToken: token.accessToken });
    expect(await sar.send(message, { bearer: token.accessToken })).toMatchObject({
      outcome: 'rejected',
      code: 'TOKEN',
      authProblem: 'session',
    });
  });

  it('con l’Id-Sessione per email vuole X-Gestionale; il Sistema TS no', async () => {
    const auth = { username: 'utente', password: 'parola', pin: '1', sessionId: 's' };
    const sar = new SimulatedSar();
    expect(await sar.send(message, auth)).toMatchObject({
      outcome: 'rejected',
      code: 'GESTIONALE',
    });
    expect(await sar.send(message, { ...auth, software: 'MIOAPPLICATIVO' })).toMatchObject({
      outcome: 'rejected',
      code: 'GESTIONALE',
    });
    expect((await sar.send(message, { ...auth, software: 'MIOAPPLICATIVO_301' })).outcome).toBe(
      'accepted',
    );
    expect(sar.receivedAuth.at(-1)?.software).toBe('MIOAPPLICATIVO_301');
    const ts = new SimulatedGateway('sistema_ts');
    expect((await ts.send({ ...message, kind: 'white' }, auth)).outcome).toBe('accepted');
  });
});

describe('il SAR come servizio delle ricette del Piemonte (D300)', () => {
  it('è la via della regione: lotti di NRE del tipo 1, ricetta rossa in DPCM, codice regionale nel promemoria', () => {
    const p = piemonte.integrations!.prescription!({});
    if (p.route !== 'gateway') throw new Error(p.route);
    expect(p.gateway).toBeInstanceOf(SimulatedSar);
    expect(p.gateway.system).toBe('regional');
    expect(p.nreLots?.lotType).toBe('1');
    expect(p.nreLots?.service).toBe(p.gateway);
    expect(p.dpcm).toBe(p.gateway);
    expect(p.reminderDoctorCode).toBe(true);
    expect(p.credentialService).toBe('rupar');
    expect(p.texts).toBe(SAR_TEXTS);
    expect(p.texts.service).toEqual({
      name: 'SAR',
      the: 'il SAR',
      to: 'al SAR',
      from: 'dal SAR',
      of: 'del SAR',
    });
    expect(p.texts.lotCredentials).toMatch(/PIN RUPAR .*V06, 3\.1\.1/);
    expect(p.texts.reportTo).toBe('al CSI Piemonte');
  });

  it('con un servizio dato si usa quello, con le parole e le scelte del SAR; senza lotti né DPCM, niente', () => {
    const given = new SimulatedGateway('regional');
    const p = piemonte.integrations!.prescription!({ gateway: given });
    if (p.route !== 'gateway') throw new Error(p.route);
    expect(p.gateway).toBe(given);
    expect(p.nreLots).toBeUndefined();
    expect(p.dpcm).toBeUndefined();
    expect(p.texts.service.name).toBe('SAR');
  });
});
