import { describe, expect, it } from 'vitest';
import {
  ADVANCED_DRESSING_MAX_MONTHS,
  SUPPLY_CATEGORIES,
  sniffAttachmentType,
  supplyEndOn,
  supplyIssues,
  supplyState,
} from '../src/supplies';

describe('presidi e assistenza integrativa', () => {
  it('ogni categoria del decreto ha la sua fonte; «altro» no', () => {
    for (const c of SUPPLY_CATEGORIES.filter((x) => x.key !== 'altro'))
      expect(c.source, c.key).toBeTruthy();
    expect(SUPPLY_CATEGORIES.find((c) => c.key === 'altro')!.source).toBeNull();
  });

  it('fine della prescrizione: il giorno prima dello stesso giorno di N mesi dopo', () => {
    expect(supplyEndOn('2026-11-18', 6)).toBe('2027-05-17');
    expect(supplyEndOn('2026-01-01', 1)).toBe('2026-01-31');
    expect(supplyEndOn('2026-01-31', 1)).toBe('2026-02-27');
    expect(supplyEndOn('2028-01-31', 1)).toBe('2028-02-28');
    expect(supplyEndOn('2026-12-15', 3)).toBe('2027-03-14');
  });

  it('medicazioni avanzate del medico di famiglia: specialista prima, al massimo 6 mesi', () => {
    const base = {
      category: 'medicazione_avanzata' as const,
      prescriber: 'mmg' as const,
      startOn: '2026-11-18',
    };
    expect(ADVANCED_DRESSING_MAX_MONTHS).toBe(6);
    expect(supplyIssues({ ...base, months: 3 })).toEqual([
      'Medicazioni avanzate: la prima prescrizione è dello specialista; indica chi e quando',
    ]);
    const withSpecialist = { ...base, firstSpecialist: 'X', firstSpecialistOn: '2026-10-01' };
    expect(supplyIssues({ ...withSpecialist, months: 6 })).toEqual([]);
    expect(supplyIssues({ ...withSpecialist, months: 7 })).toEqual([
      'Medicazioni avanzate: il medico di famiglia le prescrive per al massimo 6 mesi',
    ]);
    expect(supplyIssues({ ...base, prescriber: 'specialista', months: 12 })).toEqual([]);
    expect(supplyIssues({ ...withSpecialist, firstSpecialistOn: '2026-12-01', months: 1 })).toEqual(
      ['La prima prescrizione dello specialista non può venire dopo l’inizio'],
    );
    expect(supplyIssues({ ...base, category: 'diabetici', months: 12 })).toEqual([]);
  });

  it('stato alla data', () => {
    expect(supplyState({ status: 'active', endOn: '2026-11-18' }, '2026-11-18')).toBe('in_corso');
    expect(supplyState({ status: 'active', endOn: '2026-11-17' }, '2026-11-18')).toBe('scaduta');
    expect(supplyState({ status: 'ended', endOn: '2027-01-01' }, '2026-11-18')).toBe('conclusa');
    expect(supplyState({ status: 'annulled', endOn: '2027-01-01' }, '2026-11-18')).toBe(
      'annullata',
    );
  });

  it('il tipo di un allegato dai primi byte', () => {
    expect(sniffAttachmentType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffAttachmentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(
      sniffAttachmentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(sniffAttachmentType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(sniffAttachmentType(new Uint8Array([]))).toBeNull();
  });
});
