import { newPkceVerifier, pkceChallenge, SimulatedSecondFactor } from '@mmg/integrations';
import { describe, expect, it } from 'vitest';
import {
  piemonte,
  PRESCRIBER_SCOPE,
  readRegionalToken,
  regionalSoftwareId,
  RUPAR_CREDENTIALS,
  sarAuthentication,
  SimulatedSirpedAccess,
  softwareCodeProblem,
  tokenResultFrom,
} from '..';

/**
 * L'accesso con SPID o CIE della Regione (REL-STC-01 V08, 4.3; D109) e le credenziali RUPAR
 * (D301): il simulatore del SIRPED, la lettura del token, le chiamate al SAR, il codice del
 * gestionale con il codice ASL del medico e il secondo fattore con l'informazione «APP».
 */

describe('accesso regionale con SPID o CIE (D109)', () => {
  it('l’indirizzo di autorizzazione porta i parametri della specifica', () => {
    const sim = new SimulatedSirpedAccess();
    const url = new URL(
      sim.authorizeUrl({
        clientId: 'MIOAPPLICATIVO_301',
        redirectUri: '/ritorno',
        scope: ['prescrizione'],
        state: 'stato-di-prova',
        codeChallenge: 'sfida',
      }),
      'http://programma.invalid',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'MIOAPPLICATIVO_301',
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
    const sim = new SimulatedSirpedAccess({ now: () => new Date(t) });
    const verifier = newPkceVerifier();
    const base = {
      clientId: 'MIOAPPLICATIVO_301',
      redirectUri: '/ritorno',
      scope: ['prescrizione'],
      codeChallenge: pkceChallenge(verifier),
      fiscalCode: 'MRCLNE70A41X001X',
    };
    const exchange = (code: string, over: object = {}) =>
      sim.exchange({
        code,
        redirectUri: '/ritorno',
        clientId: 'MIOAPPLICATIVO_301',
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
      clientId: 'MIOAPPLICATIVO_301',
      scope: ['prescrizione'],
    });
    expect((await exchange(code)).outcome).toBe('rejected');
    expect(sim.isValid(ok.accessToken)).toBe(true);
    expect(
      await sim.verify({
        clientId: 'MIOAPPLICATIVO_301',
        accessToken: ok.accessToken,
        fiscalCode: 'ALTRO',
      }),
    ).toMatchObject({
      outcome: 'invalid',
    });

    t += 8 * 3_600_000;
    expect(
      await sim.verify({
        clientId: 'MIOAPPLICATIVO_301',
        accessToken: ok.accessToken,
        fiscalCode: 'MRCLNE70A41X001X',
      }),
    ).toEqual({
      outcome: 'invalid',
      state: 'scaduto',
    });

    // Revocare un token scaduto: 401, «invalid» (V08, 4.3.5).
    expect(
      await sim.revoke({ clientId: 'MIOAPPLICATIVO_301', accessToken: ok.accessToken }),
    ).toEqual({ outcome: 'invalid' });

    const again = await exchange(sim.approve(base));
    if (again.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect(
      await sim.revoke({ clientId: 'MIOAPPLICATIVO_301', accessToken: again.accessToken }),
    ).toEqual({ outcome: 'revoked' });
    expect(
      await sim.verify({
        clientId: 'MIOAPPLICATIVO_301',
        accessToken: again.accessToken,
        fiscalCode: 'MRCLNE70A41X001X',
      }),
    ).toEqual({
      outcome: 'invalid',
      state: 'revocato',
    });
    // Già revocato, o mai visto: 401 anche questi.
    expect(
      await sim.revoke({ clientId: 'MIOAPPLICATIVO_301', accessToken: again.accessToken }),
    ).toEqual({ outcome: 'invalid' });
    expect(
      await sim.revoke({ clientId: 'MIOAPPLICATIVO_301', accessToken: 'sconosciuto' }),
    ).toEqual({ outcome: 'invalid' });
  });

  it('il token ha i campi della V08 (4.3.2); la scadenza si legge da exp, non da expires_in', async () => {
    const t0 = Date.parse('2026-11-18T08:00:00Z');
    const sim = new SimulatedSirpedAccess({ now: () => new Date(t0) });
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
    const withToken = sarAuthentication({ bearer: 'jwt-di-prova', sessionId: null });
    expect(withToken).toEqual({
      outcome: 'ok',
      headers: { 'X-OAuth2-Authorization': 'Bearer jwt-di-prova' },
      pinCode: { kind: 'vuoto' },
    });
    // Con l'Id-Sessione dell'email certificata: Basic, X-idSessione, X-Gestionale; PIN da cifrare.
    const withMail = sarAuthentication({
      username: 'utente',
      password: 'parola',
      pin: '12345678',
      sessionId: 'id-sessione',
      software: 'MIOAPPLICATIVO_301',
    });
    expect(withMail).toEqual({
      outcome: 'ok',
      headers: {
        Authorization: `Basic ${Buffer.from('utente:parola').toString('base64')}`,
        'X-idSessione': 'Bearer id-sessione',
        'X-Gestionale': 'MIOAPPLICATIVO_301',
      },
      pinCode: { kind: 'da-cifrare', pin: '12345678' },
    });
    const mail = { username: 'u', password: 'p', pin: '1' };
    expect(sarAuthentication({ ...mail, sessionId: null, software: 'G_301' })).toMatchObject({
      outcome: 'problem',
      code: 'ID_SESSIONE',
    });
    // X-Gestionale: il codice del gestionale con il codice ASL del medico, sempre (4.2.5).
    for (const software of [undefined, null, '', 'MIOAPPLICATIVO', 'MIOAPPLICATIVO_30', '_301'])
      expect(
        sarAuthentication({ ...mail, sessionId: 's', software }),
        String(software),
      ).toMatchObject({
        outcome: 'problem',
        code: 'GESTIONALE',
      });
    // Token e credenziali insieme: no (4.3.6).
    for (const mixed of [
      { bearer: 'jwt', username: 'u' },
      { bearer: 'jwt', password: 'p' },
      { bearer: 'jwt', pin: '1' },
      { bearer: 'jwt', sessionId: 's' },
    ])
      expect(sarAuthentication(mixed)).toMatchObject({
        outcome: 'problem',
        code: 'CREDENZIALI',
      });
  });
});

describe('codice del gestionale con il codice ASL del medico (REL-STC-01 V08; D266)', () => {
  it('client_id, X-Gestionale e «APP»: il codice del gestionale, «_» e le tre cifre dell’ASL', () => {
    expect(regionalSoftwareId('MIOAPPLICATIVO', '301')).toEqual({
      ok: true,
      value: 'MIOAPPLICATIVO_301',
    });
    expect(regionalSoftwareId(' MIO-APP_2 ', ' 203 ')).toEqual({
      ok: true,
      value: 'MIO-APP_2_203',
    });
    expect(regionalSoftwareId('MIOAPPLICATIVO', null)).toMatchObject({
      ok: false,
      code: 'ASL',
      message: expect.stringMatching(/^Manca il codice ASL del medico/),
    });
    expect(regionalSoftwareId('MIOAPPLICATIVO', '30')).toMatchObject({ ok: false, code: 'ASL' });
    expect(regionalSoftwareId('MIOAPPLICATIVO', 'TO3')).toMatchObject({ ok: false, code: 'ASL' });
    expect(regionalSoftwareId('', '301')).toMatchObject({ ok: false, code: 'GESTIONALE' });
    expect(regionalSoftwareId('MIO APP', '301')).toMatchObject({ ok: false, code: 'GESTIONALE' });
  });

  it('il servizio regionale simulato rifiuta un client_id senza ASL e chi non ha chiesto il token', async () => {
    const sim = new SimulatedSirpedAccess();
    const verifier = newPkceVerifier();
    const approve = (clientId: string) =>
      sim.approve({
        clientId,
        redirectUri: '/r',
        scope: ['prescrizione'],
        codeChallenge: pkceChallenge(verifier),
        fiscalCode: 'MRCLNE70A41X001X',
      });
    const exchange = (clientId: string) =>
      sim.exchange({
        code: approve(clientId),
        redirectUri: '/r',
        clientId,
        codeVerifier: verifier,
      });
    expect(await exchange('MIOAPPLICATIVO')).toMatchObject({
      outcome: 'rejected',
      error: 'invalid_client',
    });
    const ok = await exchange('MIOAPPLICATIVO_301');
    if (ok.outcome !== 'ok') throw new Error('scambio non riuscito');
    expect(readRegionalToken(ok.accessToken)?.organization).toBe('301');
    // Verifica e revoca con un altro client_id: per il servizio il token non è suo (4.3.4, 4.3.5).
    const other = { clientId: 'MIOAPPLICATIVO_203', accessToken: ok.accessToken };
    expect(await sim.verify({ ...other, fiscalCode: 'MRCLNE70A41X001X' })).toMatchObject({
      outcome: 'invalid',
    });
    expect(await sim.revoke(other)).toEqual({ outcome: 'invalid' });
    expect(sim.isValid(ok.accessToken)).toBe(true);
  });

  it('secondo fattore della RUPAR: «APP» in richiesta e verifica; il Sistema TS non la usa', async () => {
    const auth = { username: 'utente', password: 'parola', pin: '1' };
    const withApp = { ...auth, software: 'MIOAPPLICATIVO_301' };
    const fiscalCode = 'MRCLNE70A41X001X';
    const rupar = RUPAR_CREDENTIALS.secondFactor!({});
    if (!(rupar instanceof SimulatedSecondFactor)) throw new Error('il simulatore non c’è');
    expect(await rupar.requestCode({ auth, fiscalCode })).toMatchObject({
      outcome: 'rejected',
      code: 'APP',
    });
    const sent = await rupar.requestCode({ auth: withApp, fiscalCode });
    if (sent.outcome !== 'sent' || !sent.testCode) throw new Error('codice non inviato');
    expect(await rupar.check({ auth, fiscalCode, sessionId: sent.testCode })).toMatchObject({
      outcome: 'invalid',
    });
    expect(
      await rupar.check({ auth: withApp, fiscalCode, sessionId: sent.testCode }),
    ).toMatchObject({ outcome: 'valid' });
    expect(rupar.receivedSoftware).toEqual([
      null,
      'MIOAPPLICATIVO_301',
      null,
      'MIOAPPLICATIVO_301',
    ]);
    // Credenziali sbagliate: il servizio simulato lo dice prima di «APP».
    expect(await rupar.requestCode({ auth: { ...auth, username: '' }, fiscalCode })).toMatchObject({
      outcome: 'rejected',
      authProblem: 'credentials',
    });
    const ts = new SimulatedSecondFactor('sistema_ts');
    expect((await ts.requestCode({ auth, fiscalCode })).outcome).toBe('sent');
    expect(ts.receivedSoftware).toEqual([]);
  });
});

describe('credenziali RUPAR nel pacchetto del Piemonte (D301)', () => {
  it('il manifesto dà le credenziali RUPAR, con la chiave di sempre e i tre mesi della password', () => {
    expect(piemonte.integrations?.credentials).toBe(RUPAR_CREDENTIALS);
    expect(RUPAR_CREDENTIALS).toMatchObject({
      // La chiave con cui le credenziali sono cifrate da quando ci sono (D100): non cambia.
      key: 'rupar_piemonte',
      slug: 'rupar',
      name: 'RUPAR Piemonte',
      passwordValidityMonths: 3,
      // Lotto di NRE e ricetta rossa (V06, 3.1.1), Fascicolo dalla cartella (LCCE V13) e
      // Profilo (V09, 3.2.1): senza secondo fattore. La ricetta SSN lo chiede per legge.
      secondFactorUses: [],
    });
    expect(RUPAR_CREDENTIALS.strongAccess?.scope).toEqual([PRESCRIBER_SCOPE]);
    expect(RUPAR_CREDENTIALS.software?.variable).toBe('APP_CODICE_GESTIONALE');
    // Le integrazioni della Regione usano queste credenziali.
    expect(piemonte.integrations?.prescription?.({})).toMatchObject({
      credentialService: 'rupar',
    });
  });

  it('il codice del gestionale della configurazione: lettere, cifre, «-» e «_»', () => {
    expect(softwareCodeProblem('MIOAPPLICATIVO')).toBeNull();
    expect(softwareCodeProblem('MIO-APP_2')).toBeNull();
    expect(softwareCodeProblem('MIO APP')).toMatch(/lettere, cifre/);
    expect(softwareCodeProblem('')).toMatch(/lettere, cifre/);
    expect(RUPAR_CREDENTIALS.software?.identify('G', '301')).toEqual({ ok: true, value: 'G_301' });
  });

  it('l’accesso con SPID o CIE e il secondo fattore si creano con l’orologio del servizio', async () => {
    let t = Date.parse('2026-11-18T08:00:00Z');
    const now = () => new Date(t);
    const second = RUPAR_CREDENTIALS.secondFactor!({ now });
    const sent = await second.requestCode({
      auth: { username: 'u', password: 'p', pin: '1', software: 'G_301' },
      fiscalCode: 'MRCLNE70A41X001X',
    });
    if (sent.outcome !== 'sent' || !sent.testCode) throw new Error('codice non inviato');
    t += 8 * 3_600_000;
    expect(
      await second.check({
        auth: { username: 'u', password: 'p', pin: '1', software: 'G_301' },
        fiscalCode: 'MRCLNE70A41X001X',
        sessionId: sent.testCode,
      }),
    ).toMatchObject({ outcome: 'invalid' });
    expect(RUPAR_CREDENTIALS.strongAccess!.gateway({ now }).environment).toBe('simulator');
  });
});
