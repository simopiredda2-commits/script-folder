import { describe, expect, it } from 'vitest';
import { buildPssCda, hl7Date, hl7Time, itDate, unitLabel, type PssCdaInput } from '../src/fse/cda';
import { sampleInput } from './helpers/pss-esempio';
import { pssSchematron } from '../src/fse/schematron';

const check = (input: PssCdaInput) => pssSchematron().validate(buildPssCda(input));

describe('documento CDA2 del Profilo Sanitario Sintetico', () => {
  it('con tutte le sezioni rispetta lo schematron ufficiale: nessun errore, nessun avviso', () => {
    const r = check(sampleInput());
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([]);
  });

  it('senza dati nelle sezioni obbligatorie: l’assenza scritta con i codici ufficiali', () => {
    const r = check(
      sampleInput({
        allergies: { absent: 'no-known-allergies' },
        therapies: { absent: 'no-medication-info' },
        problems: { absent: 'no-known-problems' },
        familyHistory: { absent: 'no-problem-info' },
        vitals: [],
        lifestyle: [],
        motorCapacity: null,
      }),
    );
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it('una versione nuova sostituisce la precedente (relatedDocument RPLC)', () => {
    const v2 = sampleInput();
    v2.document = {
      ...v2.document,
      id: { root: '2.999.1.1', extension: 'PSS.2' },
      version: 2,
      replaces: { root: '2.999.1.1', extension: 'PSS.1' },
    };
    expect(check(v2).errors).toEqual([]);
    // Senza il riferimento alla precedente lo schematron la rifiuta.
    expect(
      check({ ...v2, document: { ...v2.document, replaces: null } }).errors.map((e) => e.code),
    ).toContain('ERRORE-9');
  });

  it('il testo del medico non rompe il documento', () => {
    const xml = buildPssCda(sampleInput());
    expect(xml).toContain('Orticaria diffusa &amp; prurito &lt;grave&gt;');
    expect(xml).not.toContain('<grave>');
  });

  it('il testo leggibile è in italiano; i codici restano quelli ufficiali', () => {
    const xml = buildPssCda(sampleInput());
    // Per chi legge: via in italiano, mmHg, date come le scrive un medico italiano.
    expect(xml).toContain('<td>per bocca</td>');
    expect(xml).toMatch(/<td>\d+ mmHg<\/td>/);
    expect(xml).toContain('<td>01/11/2026</td>');
    expect(xml).toContain('<td>dal 01/03/2020</td>');
    expect(xml).not.toMatch(/<td>[^<]*mm\[Hg\][^<]*<\/td>/);
    expect(xml).not.toMatch(/<td>[^<]*\d{4}-\d{2}-\d{2}[^<]*<\/td>/);
    // Per la macchina: codici, nomi e unità dei dizionari ufficiali.
    expect(xml).toContain('displayName="Swallow, oral"');
    expect(xml).toContain('unit="mm[Hg]"');
    expect(itDate('2026-11-18')).toBe('18/11/2026');
    expect(unitLabel('mm[Hg]')).toBe('mmHg');
  });

  it('date e ore nel formato HL7, nel fuso di Roma', () => {
    expect(hl7Time(new Date('2026-11-18T09:30:00Z'))).toBe('20261118103000+0100');
    expect(hl7Time(new Date('2026-07-01T09:30:00Z'))).toBe('20260701113000+0200');
    expect(hl7Date('2026-11-18')).toBe('20261118');
  });
});
