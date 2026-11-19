import { describe, expect, it } from 'vitest';
import { CONSENT_KINDS, consentKind, currentConsents, delegationValidOn } from '../src/privacy';

describe('privacy: consensi e deleghe', () => {
  it('i consensi del Fascicolo e dell’AFT hanno la loro fonte; «altro» no', () => {
    for (const k of CONSENT_KINDS.filter((x) => x.key.startsWith('fse_')))
      expect(k.source, k.key).toMatch(/^DM 7 settembre 2023, art\. 8/);
    // Condivisione nell'AFT (D161): consenso specifico, come per il dossier sanitario.
    expect(consentKind('aft_condivisione')!.source).toMatch(/Dossier sanitario/);
    expect(consentKind('altro')!.source).toBeNull();
    expect(consentKind('inesistente')).toBeUndefined();
  });

  it('in vigore l’ultima espressione di ogni tipo, per data e poi per registrazione', () => {
    const at = (s: string) => new Date(s);
    const rows = [
      { id: 'a', kind: 'fse_cura', givenOn: '2026-01-10', recordedAt: at('2026-01-10T10:00:00Z') },
      { id: 'b', kind: 'fse_cura', givenOn: '2026-03-01', recordedAt: at('2026-03-01T10:00:00Z') },
      { id: 'c', kind: 'fse_cura', givenOn: '2026-03-01', recordedAt: at('2026-03-01T11:00:00Z') },
      { id: 'd', kind: 'fse_profilassi', givenOn: '2026-02-01', recordedAt: null },
      { id: 'e', kind: 'altro', givenOn: '2026-05-01', recordedAt: null },
    ];
    const current = currentConsents(rows);
    expect(current.get('fse_cura')!.id).toBe('c');
    expect(current.get('fse_profilassi')!.id).toBe('d');
    expect(current.has('altro')).toBe(false);
  });

  it('delega valida: nel periodo e fino al giorno prima della revoca', () => {
    const d = { validFrom: '2026-01-01', validTo: '2026-12-31', revokedOn: null };
    expect(delegationValidOn(d, '2025-12-31')).toBe(false);
    expect(delegationValidOn(d, '2026-01-01')).toBe(true);
    expect(delegationValidOn(d, '2026-12-31')).toBe(true);
    expect(delegationValidOn(d, '2027-01-01')).toBe(false);
    const open = { validFrom: '2026-01-01', validTo: null, revokedOn: '2026-06-01' };
    expect(delegationValidOn(open, '2026-05-31')).toBe(true);
    expect(delegationValidOn(open, '2026-06-01')).toBe(false);
    expect(delegationValidOn(open, '2030-01-01')).toBe(false);
  });
});
