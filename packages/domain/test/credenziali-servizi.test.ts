import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_SERVICE_KEY,
  CREDENTIAL_SERVICE_SLUG,
  NATIONAL_CREDENTIALS,
  NATIONAL_USES,
  needsSecondFactor,
  passwordExpiry,
  passwordState,
  REGIONAL_USES,
  SERVICE_USES,
  usernameHint,
} from '../src/service-credentials';

describe('credenziali dei servizi', () => {
  it('la password scade dopo i mesi solari che dice il servizio; senza, nessuna scadenza', () => {
    expect(passwordExpiry(3, '2026-08-18')).toBe('2026-11-18');
    expect(passwordExpiry(3, '2026-11-30')).toBe('2027-02-28');
    expect(passwordExpiry(null, '2026-08-18')).toBeNull();
    // Il Sistema TS: nelle fonti lette non c'è una scadenza.
    expect(passwordExpiry(NATIONAL_CREDENTIALS.passwordValidityMonths, '2026-08-18')).toBeNull();
  });

  it('avvisa da 14 giorni prima e dice quando è scaduta', () => {
    expect(passwordState(3, '2026-08-18', '2026-11-03')).toBe('valida');
    expect(passwordState(3, '2026-08-18', '2026-11-04')).toBe('in_scadenza');
    expect(passwordState(3, '2026-08-18', '2026-11-17')).toBe('in_scadenza');
    expect(passwordState(3, '2026-08-18', '2026-11-18')).toBe('scaduta');
    expect(passwordState(null, '2020-01-01', '2026-11-18')).toBe('senza_scadenza');
  });

  it('ogni invio è del Sistema TS o della regione dello studio, una volta sola', () => {
    expect([...NATIONAL_USES, ...REGIONAL_USES].sort()).toEqual([...SERVICE_USES].sort());
    expect(NATIONAL_USES).toEqual(['ricetta_bianca', 'certificato_inps']);
  });

  it('secondo fattore per legge per le ricette SSN e bianca, in ogni regione; per gli altri invii della regione lo dice la regione', () => {
    expect(needsSecondFactor('ricetta_ssn')).toBe(true);
    expect(needsSecondFactor('ricetta_bianca')).toBe(true);
    expect(needsSecondFactor('certificato_inps')).toBe(false);
    // Una regione non può togliere il secondo fattore che chiede la legge.
    expect(needsSecondFactor('ricetta_ssn', [])).toBe(true);
    for (const use of [
      'fascicolo_regionale',
      'lotto_nre',
      'ricetta_dpcm',
      'profilo_sanitario',
    ] as const) {
      expect(needsSecondFactor(use)).toBe(false);
      expect(needsSecondFactor(use, [use])).toBe(true);
    }
  });

  it('il Sistema TS ha una chiave e un nome corto nella forma di tutti i servizi', () => {
    expect(NATIONAL_CREDENTIALS.key).toMatch(CREDENTIAL_SERVICE_KEY);
    expect(NATIONAL_CREDENTIALS.slug).toMatch(CREDENTIAL_SERVICE_SLUG);
    expect('Sistema TS').toBe(NATIONAL_CREDENTIALS.name);
    expect(CREDENTIAL_SERVICE_KEY.test('A_maiuscola')).toBe(false);
    expect(CREDENTIAL_SERVICE_KEY.test('x')).toBe(false);
    expect(CREDENTIAL_SERVICE_SLUG.test('con_trattino_basso')).toBe(false);
  });

  it('dell’utente si mostrano solo le ultime tre lettere', () => {
    expect(usernameHint('  RSSMRA70A01X001Z ')).toBe('…01Z');
  });
});
