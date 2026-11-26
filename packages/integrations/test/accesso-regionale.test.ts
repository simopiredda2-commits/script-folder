import { describe, expect, it } from 'vitest';
import {
  authShapeProblem,
  isSimulatedAuthorizationPage,
  newPkceVerifier,
  pkceChallenge,
  SimulatedSecondFactor,
  type RegionalAuthorizationGateway,
} from '../src';

/**
 * Il contratto nazionale dell'accesso con SPID o CIE della regione e del secondo fattore (D109,
 * D301): PKCE, il simulatore con la sua pagina, il controllo di come il programma si presenta. Il
 * servizio di una regione, con il suo token, sta nel pacchetto della regione.
 */

describe('accesso con SPID o CIE della regione: il contratto nazionale (D109, D301)', () => {
  it('PKCE S256 come nell’esempio della RFC 7636 (appendice B)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const v = newPkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('un simulatore con la sua pagina si riconosce; un servizio vero no', () => {
    const base: RegionalAuthorizationGateway = {
      environment: 'simulator',
      authorizeUrl: () => '/pagina',
      exchange: () => Promise.resolve({ outcome: 'unreachable', message: 'prova' }),
      verify: () => Promise.resolve({ outcome: 'unreachable', message: 'prova' }),
      revoke: () => Promise.resolve({ outcome: 'unreachable', message: 'prova' }),
    };
    expect(isSimulatedAuthorizationPage(base)).toBe(false);
    expect(isSimulatedAuthorizationPage({ ...base, approve: () => 'codice' } as never)).toBe(true);
    // Un servizio vero con un metodo che si chiama allo stesso modo non apre la pagina simulata.
    expect(
      isSimulatedAuthorizationPage({
        ...base,
        environment: 'production',
        approve: () => 'c',
      } as never),
    ).toBe(false);
  });
});

describe('secondo fattore simulato: come si presenta il programma, se il servizio lo vuole (D301)', () => {
  const auth = { username: 'utente', password: 'parola', pin: '1' };
  const fiscalCode = 'RTOLNI50C54X101X';

  it('senza la richiesta del servizio non si controlla e non si registra', async () => {
    const plain = new SimulatedSecondFactor('servizio_inventato');
    expect((await plain.requestCode({ auth, fiscalCode })).outcome).toBe('sent');
    expect(plain.receivedSoftware).toEqual([]);
  });

  it('con la richiesta del servizio: rifiuto con il suo codice e il suo motivo, in richiesta e verifica', async () => {
    const strict = new SimulatedSecondFactor('servizio_inventato', {
      label: 'Servizio inventato',
      softwareProblem: (s) => (s === 'PROG_999' ? null : 'programma non riconosciuto (prova)'),
      softwareCode: 'PROG',
    });
    expect(await strict.requestCode({ auth, fiscalCode })).toMatchObject({
      outcome: 'rejected',
      code: 'PROG',
      message: 'programma non riconosciuto (prova)',
    });
    const sent = await strict.requestCode({ auth: { ...auth, software: 'PROG_999' }, fiscalCode });
    if (sent.outcome !== 'sent' || !sent.testCode) throw new Error('codice non inviato');
    expect(await strict.check({ auth, fiscalCode, sessionId: sent.testCode })).toMatchObject({
      outcome: 'invalid',
      message: 'programma non riconosciuto (prova)',
    });
    expect(strict.receivedSoftware).toEqual([null, 'PROG_999', null]);
  });

  it('il nome del servizio nei messaggi è quello dato', async () => {
    const down = new SimulatedSecondFactor('servizio_inventato', {
      label: 'Servizio inventato',
      decide: () => 'unreachable',
    });
    expect(await down.requestCode({ auth, fiscalCode })).toMatchObject({
      outcome: 'unreachable',
      message: expect.stringMatching(/^Servizio inventato: /),
    });
  });
});

describe('forma delle credenziali nei simulatori nazionali', () => {
  it('credenziali e PIN mancanti; token con altri dati', () => {
    expect(authShapeProblem({})).toMatchObject({ code: 'CREDENZIALI' });
    expect(authShapeProblem({ username: 'u', password: 'p' })).toMatchObject({ code: 'PIN' });
    expect(authShapeProblem({ username: 'u', password: 'p', pin: '1' })).toBeNull();
    expect(authShapeProblem({ bearer: 't' })).toBeNull();
    expect(authShapeProblem({ bearer: 't', sessionId: 's' })).toMatchObject({
      code: 'CREDENZIALI',
    });
  });
});
