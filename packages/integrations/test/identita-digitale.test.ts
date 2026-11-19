import { describe, expect, it } from 'vitest';
import { newPkceVerifier, pkceChallenge, SimulatedDigitalIdentity } from '../src';

/** Codice fiscale inventato, con la X come luogo di nascita (D12). */
const CF = 'SRVMRT80A41X101B';

describe('identità digitale simulata: SPID o CIE per il programma (D189)', () => {
  it('l’indirizzo porta state e code_challenge con il metodo S256', () => {
    const sim = new SimulatedDigitalIdentity();
    const url = new URL(
      sim.authorizeUrl({
        clientId: 'PROVA',
        redirectUri: '/api/ripristino/ritorno',
        state: 'stato-di-prova',
        codeChallenge: 'x'.repeat(43),
      }),
      'http://localhost',
    );
    expect(url.pathname).toBe('/api/simulatore/identita-digitale');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'PROVA',
      response_type: 'code',
      redirect_uri: '/api/ripristino/ritorno',
      state: 'stato-di-prova',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
  });

  it('il codice vale una volta, con il verifier giusto e lo stesso ritorno; poi scade', async () => {
    let t = Date.now();
    const sim = new SimulatedDigitalIdentity({ now: () => new Date(t) });
    const verifier = newPkceVerifier();
    const request = {
      clientId: 'PROVA',
      redirectUri: '/api/ripristino/ritorno',
      codeChallenge: pkceChallenge(verifier),
    };
    const code = sim.approve({ ...request, fiscalCode: ` ${CF.toLowerCase()} `, method: 'cie' });
    const exchange = (over: Partial<{ redirectUri: string; codeVerifier: string }> = {}) =>
      sim.exchange({
        code,
        clientId: 'PROVA',
        redirectUri: request.redirectUri,
        codeVerifier: verifier,
        ...over,
      });
    expect(await exchange()).toMatchObject({ outcome: 'ok', fiscalCode: CF, method: 'cie' });
    expect(await exchange()).toMatchObject({ outcome: 'rejected', error: 'invalid_grant' });

    const second = sim.approve({ ...request, fiscalCode: CF, method: 'spid' });
    expect(
      await sim.exchange({
        code: second,
        clientId: 'PROVA',
        redirectUri: request.redirectUri,
        codeVerifier: newPkceVerifier(),
      }),
    ).toMatchObject({ outcome: 'rejected', error: 'invalid_client' });

    const late = sim.approve({ ...request, fiscalCode: CF, method: 'spid' });
    t += 5 * 60_000 + 1;
    expect(
      await sim.exchange({
        code: late,
        clientId: 'PROVA',
        redirectUri: request.redirectUri,
        codeVerifier: verifier,
      }),
    ).toMatchObject({ outcome: 'rejected', error: 'invalid_grant' });
  });
});
