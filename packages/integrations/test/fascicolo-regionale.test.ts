import { describe, expect, it } from 'vitest';
import {
  FSE_ACCESS_APPLICATION,
  FSE_ACCESS_ERRORS,
  FSE_ACCESS_PAGES,
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

describe('accesso al Fascicolo regionale dalla cartella, simulato (D220, LCCE V13)', () => {
  it('con le credenziali dà l’indirizzo della pagina con il token; ruolo MMG, applicazione DMAWACCE', async () => {
    const fse = new SimulatedRegionalFseAccess();
    const r = await fse.authenticate(request(), auth);
    expect(r.outcome).toBe('success');
    if (r.outcome !== 'success') return;
    expect(r.url).toMatch(/^\/api\/simulatori\/fascicolo\?token=[0-9a-f-]{36}$/);
    expect(fse.received).toEqual([
      expect.objectContaining({ role: FSE_ACCESS_ROLE, application: FSE_ACCESS_APPLICATION }),
    ]);
    // DMAWACCE, «Servizi FSE per Cartelle Cliniche» (V13, tabella 5; DMAWA è il portale dei medici).
    expect([FSE_ACCESS_ROLE, FSE_ACCESS_APPLICATION]).toEqual(['MMG', 'DMAWACCE']);
    expect(FSE_ACCESS_PAGES.tokenParameter).toBe('tokenCCEMed');
    // Le credenziali non restano nelle richieste ricevute.
    expect(JSON.stringify(fse.received)).not.toContain('parola-inventata');
  });

  it('il token vale una volta; l’IP si traccia, non si confronta (V13, 2.2 e tabella 6)', async () => {
    const fse = new SimulatedRegionalFseAccess();
    const r = await fse.authenticate(request({ documentType: '11502-2' }), auth);
    if (r.outcome !== 'success') throw new Error('accesso non riuscito');
    const token = tokenOf(r.url);
    expect(fse.open(token, '198.51.100.7')).toEqual({
      outcome: 'opened',
      patientFiscalCode: 'RSSMRA80A41X000Y',
      documentType: '11502-2',
      declaredIp: '192.0.2.10',
      openedFromIp: '198.51.100.7',
    });
    expect(fse.open(token, '192.0.2.10')).toEqual({
      outcome: 'error',
      code: 'WEB_001',
      message: 'Token di autenticazione non valido',
    });
    expect(fse.open('token-inventato', '192.0.2.10')).toMatchObject({ code: 'WEB_001' });
  });

  it('un token scaduto dà WEB_001; la durata, che la V13 non dice, è un’impostazione del simulatore', async () => {
    let now = Date.parse('2026-11-25T10:00:00Z');
    const fse = new SimulatedRegionalFseAccess({ tokenMinutes: 2, now: () => new Date(now) });
    const first = await fse.authenticate(request(), auth);
    const second = await fse.authenticate(request(), auth);
    if (first.outcome !== 'success' || second.outcome !== 'success') throw new Error('accesso');
    now += 60_000;
    expect(fse.open(tokenOf(first.url), null)).toMatchObject({ outcome: 'opened' });
    now += 61_000;
    expect(fse.open(tokenOf(second.url), null)).toEqual({
      outcome: 'error',
      code: 'WEB_001',
      message: 'Token di autenticazione non valido',
    });
  });

  it('utente, password e PIN obbligatori (V13, 3.3); tipo di documento sconosciuto: FSE_ER_504', async () => {
    const fse = new SimulatedRegionalFseAccess();
    expect(await fse.authenticate(request(), { username: 'x' })).toEqual({
      outcome: 'failure',
      code: 'AUTH_ER_516',
      message: 'Le credenziali devono essere valorizzate',
    });
    // Senza PIN: AUTH_ER_510, anche con utente e password (dalla V07 il PIN è obbligatorio).
    expect(
      await fse.authenticate(request(), { username: 'medico.inventato', password: 'parola' }),
    ).toEqual({
      outcome: 'failure',
      code: 'AUTH_ER_510',
      message: 'Il parametro Pin del richiedente deve essere valorizzato',
    });
    expect(await fse.authenticate(request(), { ...auth, pin: '  ' })).toMatchObject({
      code: 'AUTH_ER_510',
    });
    expect(await fse.authenticate(request({ patientFiscalCode: ' ' }), auth)).toMatchObject({
      code: 'AUTH_ER_514',
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

  it('codici e parole come nelle tabelle della V13 (tabelle 1, 3 e 6)', () => {
    expect(Object.keys(FSE_ACCESS_ERRORS)).toEqual([
      'AUTH_ER_000',
      'AUTH_ER_501',
      'AUTH_ER_502',
      'AUTH_ER_506',
      'AUTH_ER_507',
      'AUTH_ER_510',
      'AUTH_ER_511',
      'AUTH_ER_512',
      'AUTH_ER_513',
      'AUTH_ER_514',
      'AUTH_ER_515',
      'AUTH_ER_516',
      'AUTH_ER_517',
      'AUTH_ER_628',
      'FSE_ER_000',
      'FSE_ER_503',
      'FSE_ER_504',
      'FSE_ER_505',
      'WEB_000',
      'WEB_001',
    ]);
    expect(Object.keys(FSE_DOCUMENT_TYPES)).toEqual([
      '57833-6',
      '57832-8',
      '60591-5',
      'ATTO_OPERATORIO',
      '29304-3',
      '81223-0',
      '28653-4',
      '59258-4',
      '34105-7',
      '68604-8',
      '11488-4',
      '11526-1',
      '11502-2',
      '57829-4',
      '57827-8',
      'REG-87273-9',
      '87273-9',
      'PCP',
      'BDS',
      'REG-ESE-11488-4',
    ]);
    expect(FSE_DOCUMENT_TYPES['60591-5']).toBe('PROFILO SANITARIO SINTETICO / PATIENT SUMMARY');
    expect(FSE_DOCUMENT_TYPES['11502-2']).toBe('REFERTO DI LABORATORIO');
    expect(FSE_DOCUMENT_TYPES['57827-8']).toBe('ATTESTATO DI ESENZIONE');
    expect(FSE_DOCUMENT_TYPES['REG-ESE-11488-4']).toBe('CERTIFICATO DI CONDIZIONE O MALATTIA');
    // Il documento dei consensi della V03 non c'è più.
    expect(Object.hasOwn(FSE_DOCUMENT_TYPES, '59284-0')).toBe(false);
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
