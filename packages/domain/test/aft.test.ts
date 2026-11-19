import { describe, expect, it } from 'vitest';
import { aftAccess, type AftAccessInput, type AftMembership } from '../src/aft';

/** Regole della consultazione tra colleghi dell'AFT (tappa 12, D161). Persone inventate. */
const NOW = new Date('2026-11-19T10:00:00Z');
const member = (userId: string, over: Partial<AftMembership> = {}): AftMembership => ({
  aftId: 'aft-1',
  userId,
  since: new Date('2026-11-01T00:00:00Z'),
  until: null,
  sharing: true,
  ...over,
});
const input = (over: Partial<AftAccessInput> = {}): AftAccessInput => ({
  actor: { userId: 'collega', ownerDoctor: true },
  ownerUserId: 'curante',
  memberships: [member('collega'), member('curante')],
  consent: 'given',
  reason: 'Visita nell’ambulatorio serale dell’AFT',
  now: NOW,
  ...over,
});

describe('consultazione tra i medici dell’AFT (D161)', () => {
  it('stessa AFT, condivisione attiva, consenso dato e motivo scritto: si vede', () => {
    expect(aftAccess(input())).toEqual({
      allowed: true,
      reason: 'Collega dell’AFT, con il consenso del paziente',
      aftId: 'aft-1',
    });
  });

  it('ogni condizione che manca ferma l’accesso, con il suo motivo', () => {
    const denied = (over: Partial<AftAccessInput>) => aftAccess(input(over)).reason;
    expect(denied({ actor: { userId: 'collega', ownerDoctor: false } })).toMatch(
      /solo i medici titolari/,
    );
    expect(denied({ actor: { userId: 'curante', ownerDoctor: true } })).toMatch(
      /È un tuo paziente/,
    );
    expect(
      denied({ memberships: [member('collega'), member('curante', { aftId: 'aft-2' })] }),
    ).toMatch(/non è nella tua AFT/);
    expect(
      denied({ memberships: [member('collega'), member('curante', { sharing: false })] }),
    ).toMatch(/non condivide/);
    expect(denied({ consent: null })).toMatch(/non ha dato il consenso/);
    expect(denied({ consent: 'refused' })).toMatch(/ha negato il consenso/);
    expect(denied({ consent: 'revoked' })).toMatch(/ha revocato il consenso/);
    expect(denied({ reason: 'visita' })).toMatch(/motivo dell’accesso/);
  });

  it('le appartenenze contano solo nel loro periodo', () => {
    const left = member('curante', { until: new Date('2026-11-18T00:00:00Z') });
    expect(aftAccess(input({ memberships: [member('collega'), left] })).allowed).toBe(false);
    const future = member('collega', { since: new Date('2026-11-20T00:00:00Z') });
    expect(aftAccess(input({ memberships: [future, member('curante')] })).allowed).toBe(false);
  });
});
