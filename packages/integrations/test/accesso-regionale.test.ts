import { describe, expect, it } from 'vitest';
import {
  newPkceVerifier,
  pkceChallenge,
  readRegionalToken,
  sarAuthentication,
  SimulatedGateway,
  SimulatedRegionalAuthorization,
  tokenResultFrom,
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
    // La scadenza viene dal campo exp del token: 8 ore dopo l'emissione (V08, 3 e 4.3.2).
    expect(ok).toMatchObject({
      validUntil: '2026-11-18T16:05:00.000Z',
      fiscalCode: 'MRCLNE70A41X001X',
      clientId: 'GESTIONALE_000',
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

    // Revocare un token scaduto: 401, «invalid» (V08, 4.3.5).
    expect(await sim.revoke({ accessToken: ok.accessToken })).toEqual({ outcome: 'invalid' });

    const again = await exchange(sim.approve(base));
    if (again.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect(await sim.revoke({ accessToken: again.accessToken })).toEqual({ outcome: 'revoked' });
    expect(
      await sim.verify({ accessToken: again.accessToken, fiscalCode: 'MRCLNE70A41X001X' }),
    ).toEqual({
      outcome: 'invalid',
      state: 'revocato',
    });
    // Già revocato, o mai visto: 401 anche questi.
    expect(await sim.revoke({ accessToken: again.accessToken })).toEqual({ outcome: 'invalid' });
    expect(await sim.revoke({ accessToken: 'sconosciuto' })).toEqual({ outcome: 'invalid' });
  });

  it('il token ha i campi della V08 (4.3.2); la scadenza si legge da exp, non da expires_in', async () => {
    const t0 = Date.parse('2026-11-18T08:00:00Z');
    const sim = new SimulatedRegionalAuthorization({ now: () => new Date(t0) });
    const verifier = newPkceVerifier();
    const code = sim.approve({
      clientId: 'MIOAPPLICATIVO_301',
      redirectUri: '/r',
      scope: ['prescrizione'],
      codeChallenge: pkceChallenge(verifier),
      fiscalCode: 'MRCLNE70A41X001X',
    });
    const r = await sim.exchange({
      code,
      redirectUri: '/r',
      clientId: 'MIOAPPLICATIVO_301',
      codeVerifier: verifier,
    });
    if (r.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect(r.accessToken.split('.')).toHaveLength(3);
    expect(readRegionalToken(r.accessToken)).toEqual({
      sub: 'MRCLNE70A41X001X',
      aud: 'MIOAPPLICATIVO_301',
      exp: t0 / 1000 + 8 * 3600,
      iat: t0 / 1000,
      nbf: t0 / 1000,
      jti: expect.any(String),
      iss: expect.any(String),
      scope: ['prescrizione'],
      sessionId: r.sessionId,
      organization: '301',
      level: 'iso-iec-29115-LoA3',
      method: 'SpidL2',
    });
    // La risposta non porta il token nel registro.
    expect(JSON.stringify(r.raw)).not.toContain(r.accessToken);

    // Come nell'esempio della V08: expires_in 7199, ma vale exp del token.
    const exp = Date.parse('2026-11-18T18:00:00Z') / 1000;
    const jwt = (claims: object) =>
      `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    const claims = {
      sub: 'CF',
      aud: 'G_301',
      exp,
      jti: 'j1',
      userData: { idSessione: 's1' },
    };
    expect(
      tokenResultFrom({
        access_token: jwt(claims),
        scope: 'prescrizione erogazione',
        token_type: 'Bearer',
        expires_in: 7199,
      }),
    ).toMatchObject({
      outcome: 'ok',
      validUntil: '2026-11-18T18:00:00.000Z',
      scope: ['prescrizione', 'erogazione'],
      sessionId: 's1',
      clientId: 'G_301',
    });
    // Senza exp, o senza Id-Sessione, il token non si usa.
    for (const broken of [
      { ...claims, exp: undefined },
      { ...claims, userData: {} },
      { ...claims, aud: '' },
    ])
      expect(
        tokenResultFrom({ access_token: jwt(broken), token_type: 'Bearer', expires_in: 7199 }),
      ).toMatchObject({ outcome: 'rejected', error: 'invalid_token' });
    expect(tokenResultFrom({ access_token: jwt(claims), token_type: 'MAC' })).toMatchObject({
      outcome: 'rejected',
    });
    expect(readRegionalToken('non-un-jwt')).toBeNull();
  });

  it('chiamate al SAR come nella V08: con il token solo X-OAuth2-Authorization, niente Basic, PIN vuoto', () => {
    const withToken = sarAuthentication({ bearer: 'jwt-di-prova', sessionId: null }, 'G_301');
    expect(withToken).toEqual({
      outcome: 'ok',
      headers: { 'X-OAuth2-Authorization': 'Bearer jwt-di-prova' },
      pinCode: { kind: 'vuoto' },
    });
    // Con l'Id-Sessione dell'email certificata: Basic, X-idSessione, X-Gestionale; PIN da cifrare.
    const withMail = sarAuthentication(
      { username: 'utente', password: 'parola', pin: '12345678', sessionId: 'id-sessione' },
      'MIOAPPLICATIVO_301',
    );
    expect(withMail).toEqual({
      outcome: 'ok',
      headers: {
        Authorization: `Basic ${Buffer.from('utente:parola').toString('base64')}`,
        'X-idSessione': 'Bearer id-sessione',
        'X-Gestionale': 'MIOAPPLICATIVO_301',
      },
      pinCode: { kind: 'da-cifrare', pin: '12345678' },
    });
    expect(
      sarAuthentication({ username: 'u', password: 'p', pin: '1', sessionId: null }, 'G_301'),
    ).toMatchObject({ outcome: 'problem', code: 'ID_SESSIONE' });
    expect(
      sarAuthentication({ username: 'u', password: 'p', pin: '1', sessionId: 's' }, null),
    ).toMatchObject({ outcome: 'problem', code: 'GESTIONALE' });
    // Token e credenziali insieme: no (4.3.6).
    for (const mixed of [
      { bearer: 'jwt', username: 'u' },
      { bearer: 'jwt', password: 'p' },
      { bearer: 'jwt', pin: '1' },
      { bearer: 'jwt', sessionId: 's' },
    ])
      expect(sarAuthentication(mixed, 'G_301')).toMatchObject({
        outcome: 'problem',
        code: 'CREDENZIALI',
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
    // Il token non si manda insieme a utente, password e PIN (V08, 4.3.6).
    expect(
      await sar.send(message, {
        bearer: token.accessToken,
        username: 'utente',
        password: 'parola',
        pin: '1',
      }),
    ).toMatchObject({ outcome: 'rejected', code: 'CREDENZIALI', authProblem: 'credentials' });
    await oauth.revoke({ accessToken: token.accessToken });
    expect(await sar.send(message, { bearer: token.accessToken })).toMatchObject({
      outcome: 'rejected',
      code: 'TOKEN',
      authProblem: 'session',
    });
  });
});
