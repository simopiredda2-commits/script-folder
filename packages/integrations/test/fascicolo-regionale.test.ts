import { describe, expect, it } from 'vitest';
import {
  FSE_ACCESS_APPLICATION,
  FSE_ACCESS_ERRORS,
  FSE_ACCESS_ROLE,
  FSE_DOCUMENT_TYPES,
  MAX_TOKENS,
  SimulatedRegionalFseAccess,
  type FseAccessRequest,
} from '../src';

/** Credenziali RUPAR inventate: il simulatore controlla solo che ci siano. */
const auth = { username: 'medico.inventato', password: 'parola-inventata', pin: '0000' };
const request = (extra: Partial<FseAccessRequest> = {}): FseAccessRequest => ({
  patientFiscalCode: 'RSSMRA80A41X000Y',
  clientIp: '192.0.2.10',
  documentType: null,
  ...extra,
});
const tokenOf = (url: string) =>
  new URL(url, 'http://programma.invalid').searchParams.get('token')!;

describe('accesso al Fascicolo regionale dalla cartella, simulato (D220)', () => {
  it('con le credenziali dà l’indirizzo della pagina con il token; ruolo MMG, applicazione DMAWA', async () => {
    const fse = new SimulatedRegionalFseAccess();
    const r = await fse.authenticate(request(), auth);
    expect(r.outcome).toBe('success');
    if (r.outcome !== 'success') return;
    expect(r.url).toMatch(/^\/api\/simulatori\/fascicolo\?token=[0-9a-f-]{36}$/);
    expect(fse.received).toEqual([
      expect.objectContaining({ role: FSE_ACCESS_ROLE, application: FSE_ACCESS_APPLICATION }),
    ]);
    expect([FSE_ACCESS_ROLE, FSE_ACCESS_APPLICATION]).toEqual(['MMG', 'DMAWA']);
    // Le credenziali non restano nelle richieste ricevute.
    expect(JSON.stringify(fse.received)).not.toContain('parola-inventata');
  });

  it('il token vale una volta e solo dall’IP dichiarato', async () => {
    const fse = new SimulatedRegionalFseAccess();
    const r = await fse.authenticate(request({ documentType: '11502-2' }), auth);
    if (r.outcome !== 'success') throw new Error('accesso non riuscito');
    const token = tokenOf(r.url);
    expect(fse.open(token, '198.51.100.7')).toEqual({
      outcome: 'error',
      code: 'WEB_002',
      message: 'Controllo IP chiamante fallito',
    });
    expect(fse.open(token, '192.0.2.10')).toEqual({
      outcome: 'opened',
      patientFiscalCode: 'RSSMRA80A41X000Y',
      documentType: '11502-2',
    });
    expect(fse.open(token, '192.0.2.10')).toMatchObject({ outcome: 'error', code: 'WEB_001' });
    expect(fse.open('token-inventato', '192.0.2.10')).toMatchObject({ code: 'WEB_001' });
  });

  it('senza utente o password: errore di autenticazione; tipo di documento sconosciuto: FSE_ER_504', async () => {
    const fse = new SimulatedRegionalFseAccess();
    expect(await fse.authenticate(request(), { username: 'x' })).toEqual({
      outcome: 'failure',
      code: 'AUTH_ER_501',
      message: 'Errore di autenticazione',
    });
    expect(await fse.authenticate(request({ documentType: 'XYZ' }), auth)).toMatchObject({
      code: 'FSE_ER_504',
    });
    for (const documentType of ['constructor', 'toString', '__proto__'])
      expect(await fse.authenticate(request({ documentType }), auth), documentType).toMatchObject({
        code: 'FSE_ER_504',
      });
  });

  it('gli esiti scelti nelle prove: consenso mancante, paziente non trovato, servizio giù', async () => {
    let next: 'FSE_ER_505' | 'FSE_ER_503' | 'unreachable' = 'FSE_ER_505';
    const fse = new SimulatedRegionalFseAccess({ decide: () => next });
    expect(await fse.authenticate(request(), auth)).toEqual({
      outcome: 'failure',
      code: 'FSE_ER_505',
      message: 'Il paziente non ha fornito il consenso alla consultazione',
    });
    next = 'FSE_ER_503';
    expect(await fse.authenticate(request(), auth)).toMatchObject({
      message: 'Paziente non trovato',
    });
    next = 'unreachable';
    expect((await fse.authenticate(request(), auth)).outcome).toBe('unreachable');
  });

  it('codici e parole come nelle tabelle delle specifiche del 2019', () => {
    expect(Object.keys(FSE_ACCESS_ERRORS)).toEqual([
      'AUTH_ER_000',
      'AUTH_ER_501',
      'AUTH_ER_502',
      'AUTH_ER_506',
      'AUTH_ER_507',
      'FSE_ER_000',
      'FSE_ER_503',
      'FSE_ER_504',
      'FSE_ER_505',
      'WEB_000',
      'WEB_001',
      'WEB_002',
    ]);
    expect(Object.keys(FSE_DOCUMENT_TYPES)).toHaveLength(16);
    expect(FSE_DOCUMENT_TYPES['60591-5']).toBe('PROFILO SANITARIO SINTETICO / PATIENT SUMMARY');
    expect(FSE_DOCUMENT_TYPES['11502-2']).toBe('REFERTO DI LABORATORIO');
  });

  it('il simulatore non tiene i token senza limite: usati escono, i più vecchi oltre il limite pure (D232)', async () => {
    const fse = new SimulatedRegionalFseAccess();
    const tokenOf = async () => {
      const r = await fse.authenticate(request(), auth);
      if (r.outcome !== 'success') throw new Error(r.outcome);
      return new URL(r.url, 'http://prova').searchParams.get('token')!;
    };
    const first = await tokenOf();
    for (let i = 0; i < MAX_TOKENS; i++) await tokenOf();
    expect(fse.open(first, '192.0.2.10')).toMatchObject({ outcome: 'error', code: 'WEB_001' });
    const last = await tokenOf();
    expect(fse.open(last, '192.0.2.10')).toMatchObject({ outcome: 'opened' });
    expect(fse.open(last, '192.0.2.10')).toMatchObject({ outcome: 'error', code: 'WEB_001' });
  });
});
