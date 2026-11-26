import { describe, expect, it } from 'vitest';
import {
  buildPssCda,
  derivedUuid,
  hl7Date,
  hl7Time,
  itDate,
  unitLabel,
  type PssCdaInput,
} from '../src/fse/cda';
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

/** Guida HL7 Italia v1.5, dove non contrasta con lo schematron del Ministero (D281). */
describe('Profilo secondo la guida HL7 Italia v1.5', () => {
  const OID = /^[0-2](\.(0|[1-9]\d*))*$/;
  const UUID = /^[A-Fa-f\d]{8}-[A-Fa-f\d]{4}-[A-Fa-f\d]{4}-[A-Fa-f\d]{4}-[A-Fa-f\d]{12}$/;
  const ABSENT = {
    allergies: { absent: 'no-known-allergies' },
    therapies: { absent: 'no-medication-info' },
    problems: { absent: 'no-known-problems' },
    familyHistory: { absent: 'no-problem-info' },
  } as const;
  /** Le radici di tutti gli `id`, e quelle senza extension (le voci e le loro osservazioni). */
  const ids = (xml: string) => {
    const all = [...xml.matchAll(/<id root="([^"]*)"( extension="[^"]*")?/g)];
    return {
      roots: all.map((m) => m[1]!),
      entries: all.filter((m) => !m[2]).map((m) => m[1]!),
    };
  };

  it('il modello del documento dichiara la versione 1.5', () => {
    expect(buildPssCda(sampleInput())).toContain(
      '<templateId root="2.16.840.1.113883.2.9.10.1.4.1.1" extension="1.5"',
    );
  });

  it('l’assenza di allergie usa il sistema di codici della guida, che il Ministero accetta', () => {
    const xml = buildPssCda(sampleInput(ABSENT));
    expect(xml).toContain('code="OINT" codeSystem="2.16.840.1.113883.1.11.19700"');
    expect(check(sampleInput(ABSENT)).errors).toEqual([]);
  });

  it('l’indirizzo del custode dice l’uso, come vuole la guida', () => {
    const xml = buildPssCda(sampleInput());
    const custodian = /<custodian>.*<\/custodian>/s.exec(xml)![0];
    expect(custodian).toContain('<addr use="WP">');
  });

  it('ogni identificativo è un OID o un UUID, anche nelle voci di assenza', () => {
    for (const xml of [buildPssCda(sampleInput()), buildPssCda(sampleInput(ABSENT))]) {
      const bad = ids(xml).roots.filter((r) => !OID.test(r) && !UUID.test(r));
      expect(bad).toEqual([]);
    }
  });

  it('gli identificativi delle voci sono unici nel documento e sempre gli stessi', () => {
    for (const input of [sampleInput(), sampleInput(ABSENT)]) {
      const { entries } = ids(buildPssCda(input));
      expect(entries.length).toBeGreaterThan(3);
      expect(new Set(entries).size).toBe(entries.length);
      expect(ids(buildPssCda(input)).entries).toEqual(entries);
    }
    // Le voci di assenza di un altro documento hanno identificativi loro (le voci della cartella,
    // come i parametri, restano quelle della cartella).
    const onlyAbsent = { ...ABSENT, vitals: [], lifestyle: [], motorCapacity: null };
    const other = sampleInput(onlyAbsent);
    other.document = { ...other.document, id: { root: '2.999.1.1', extension: 'PSS.9' } };
    const a = ids(buildPssCda(sampleInput(onlyAbsent))).entries;
    const b = ids(buildPssCda(other)).entries;
    expect(a).toHaveLength(6);
    expect(a.filter((x) => b.includes(x))).toEqual([]);
  });

  it('l’identificativo ricavato è un UUID della versione 5', () => {
    const u = derivedUuid('prova');
    expect(u).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(derivedUuid('prova')).toBe(u);
    expect(derivedUuid('prova2')).not.toBe(u);
  });
});
