import { describe, expect, it } from 'vitest';
import {
  newPkceVerifier,
  pkceChallenge,
  SimulatedGateway,
  SimulatedRegionalAuthorization,
  type PrescriptionMessage,
} from '../src';

const message: PrescriptionMessage = {
  localId: 'r1',
  kind: 'pharma_ssn',
  patientFiscalCode: 'RTOLNI50C54X101X',
  doctor: { userId: 'u1', name: 'Medico inventato' },
  lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
  compiledAt: '2026-11-18',
};

describe('accesso regionale con SPID o CIE (D109)', () => {
  it('PKCE S256 come nell’esempio della RFC 7636 (appendice B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const v = newPkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('l’indirizzo di autorizzazione porta i parametri della specifica', () => {
    const sim = new SimulatedRegionalAuthorization();
    const url = new URL(
      sim.authorizeUrl({
        clientId: 'GESTIONALE_000',
        redirectUri: '/ritorno',
        scope: ['prescrizione'],
        state: 'stato-di-prova',
        codeChallenge: 'sfida',
      }),
      'http://programma.invalid',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'GESTIONALE_000',
      response_type: 'code',
      redirect_uri: '/ritorno',
      scope: 'prescrizione',
      state: 'stato-di-prova',
      code_challenge: 'sfida',
      code_challenge_method: 'S256',
    });
  });

  it('codice monouso, PKCE e redirect verificati; token di 8 ore, poi scaduto; revoca', async () => {
    let t = Date.parse('2026-11-18T08:00:00Z');
    const sim = new SimulatedRegionalAuthorization({ now: () => new Date(t) });
    const verifier = newPkceVerifier();
    const base = {
      clientId: 'GESTIONALE_000',
      redirectUri: '/ritorno',
      scope: ['prescrizione'],
      codeChallenge: pkceChallenge(verifier),
      fiscalCode: 'MRCLNE70A41X001X',
    };
    const exchange = (code: string, over: object = {}) =>
      sim.exchange({
        code,
        redirectUri: '/ritorno',
        clientId: 'GESTIONALE_000',
        codeVerifier: verifier,
        ...over,
      });

    expect(await exchange(sim.approve(base), { codeVerifier: newPkceVerifier() })).toMatchObject({
      outcome: 'rejected',
      error: 'invalid_client',
    });
    expect(await exchange(sim.approve(base), { redirectUri: '/altro' })).toMatchObject({
      outcome: 'rejected',
      error: 'invalid_grant',
    });
    const late = sim.approve(base);
    t += 5 * 60_000;
    expect((await exchange(late)).outcome).toBe('rejected');

    const code = sim.approve(base);
    const ok = await exchange(code);
    if (ok.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect(ok).toMatchObject({
      expiresIn: 8 * 3600,
      fiscalCode: 'MRCLNE70A41X001X',
      scope: ['prescrizione'],
    });
    expect((await exchange(code)).outcome).toBe('rejected');
    expect(sim.isValid(ok.accessToken)).toBe(true);
    expect(await sim.verify({ accessToken: ok.accessToken, fiscalCode: 'ALTRO' })).toMatchObject({
      outcome: 'invalid',
    });

    t += 8 * 3_600_000;
    expect(
      await sim.verify({ accessToken: ok.accessToken, fiscalCode: 'MRCLNE70A41X001X' }),
    ).toEqual({
      outcome: 'invalid',
      state: 'scaduto',
    });

    const again = await exchange(sim.approve(base));
    if (again.outcome !== 'ok') throw new Error('scambio non riuscito');
    await sim.revoke({ accessToken: again.accessToken });
    expect(
      await sim.verify({ accessToken: again.accessToken, fiscalCode: 'MRCLNE70A41X001X' }),
    ).toEqual({
      outcome: 'invalid',
      state: 'revocato',
    });
  });

  it('il SAR simulato accetta il token al posto di utente, password e PIN; revocato, rifiuta', async () => {
    const oauth = new SimulatedRegionalAuthorization();
    const sar = new SimulatedGateway('sar', { oauth });
    const verifier = newPkceVerifier();
    const code = oauth.approve({
      clientId: 'G',
      redirectUri: '/r',
      scope: ['prescrizione'],
      codeChallenge: pkceChallenge(verifier),
      fiscalCode: 'CF',
    });
    const token = await oauth.exchange({
      code,
      redirectUri: '/r',
      clientId: 'G',
      codeVerifier: verifier,
    });
    if (token.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect((await sar.send(message, { bearer: token.accessToken })).outcome).toBe('accepted');
    expect(sar.receivedAuth.at(-1)).toEqual({ username: '', sessionId: null, bearer: true });
    await oauth.revoke({ accessToken: token.accessToken });
    expect(await sar.send(message, { bearer: token.accessToken })).toMatchObject({
      outcome: 'rejected',
      code: 'TOKEN',
      authProblem: 'session',
    });
  });
});
