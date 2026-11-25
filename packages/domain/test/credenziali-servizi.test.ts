import { describe, expect, it } from 'vitest';
import {
  NEEDS_SECOND_FACTOR,
  passwordExpiry,
  passwordState,
  SERVICE_FOR_USE,
  usernameHint,
} from '../src/service-credentials';

describe('credenziali dei servizi', () => {
  it('la password RUPAR scade dopo tre mesi solari; quella del Sistema TS non ha scadenza nota', () => {
    expect(passwordExpiry('rupar_piemonte', '2026-08-18')).toBe('2026-11-18');
    expect(passwordExpiry('rupar_piemonte', '2026-11-30')).toBe('2027-02-28');
    expect(passwordExpiry('sistema_ts', '2026-08-18')).toBeNull();
  });

  it('avvisa da 14 giorni prima e dice quando è scaduta', () => {
    expect(passwordState('rupar_piemonte', '2026-08-18', '2026-11-03')).toBe('valida');
    expect(passwordState('rupar_piemonte', '2026-08-18', '2026-11-04')).toBe('in_scadenza');
    expect(passwordState('rupar_piemonte', '2026-08-18', '2026-11-17')).toBe('in_scadenza');
    expect(passwordState('rupar_piemonte', '2026-08-18', '2026-11-18')).toBe('scaduta');
    expect(passwordState('sistema_ts', '2020-01-01', '2026-11-18')).toBe('senza_scadenza');
  });

  it('ricetta SSN, Fascicolo regionale, lotto di NRE e ricetta rossa con RUPAR, bianca e certificati con il Sistema TS; secondo fattore solo per le ricette', () => {
    expect(SERVICE_FOR_USE).toEqual({
      ricetta_ssn: 'rupar_piemonte',
      ricetta_bianca: 'sistema_ts',
      certificato_inps: 'sistema_ts',
      fascicolo_regionale: 'rupar_piemonte',
      lotto_nre: 'rupar_piemonte',
      ricetta_dpcm: 'rupar_piemonte',
    });
    // Il modulo del CSI del 2019 chiede utente, password e PIN RUPAR, senza secondo fattore (D220).
    // Lotto di NRE e ricetta rossa: «esclusivamente» utente, password e PIN RUPAR (V06, 3.1.1).
    expect(NEEDS_SECOND_FACTOR).toEqual({
      ricetta_ssn: true,
      ricetta_bianca: true,
      certificato_inps: false,
      fascicolo_regionale: false,
      lotto_nre: false,
      ricetta_dpcm: false,
    });
  });

  it('dell’utente si mostrano solo le ultime tre lettere', () => {
    expect(usernameHint('  RSSMRA70A01X001Z ')).toBe('…01Z');
  });
});
