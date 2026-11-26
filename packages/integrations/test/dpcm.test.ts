import { buildFiscalCode } from '@mmg/domain';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  dpcmFileName,
  dpcmInsertXml,
  dpcmPackage,
  dpcmPrescriptionProblem,
  SIMULATED_DPCM_CRYPTO,
  toBasicLatin,
  type DpcmPrescription,
} from '../src';

/**
 * Le sequenze degli elementi di RicettaMIR.xsd, versione 2.1 (Sistema TS, «WSDL e schemi XSD» del
 * 5/9/2011, 3.1), trascritte dal documento: il file deve rispettarne l'ordine.
 */
const TESTATA = ['PinCode', 'TipoInvio', 'Testata1', 'Testata2'];
const RICETTA_I = [
  'Bar1',
  'Bar2',
  'Altro',
  'NoteInvio',
  'CodiceAss',
  'TipoPrescrizione',
  'CodEsenzione',
  'NonEsente',
  'Reddito',
  'CodiceDiagnosi',
  'DescrizioneDiagnosi',
  'TotPezzi',
  'TipoRic',
  'DataCompilazione',
  'TipoVisita',
  'DispReg',
  'ProvAssistito',
  'AslAssistito',
  'IndicazionePrescr',
  'ClassePriorita',
  'StatoEstero',
  'IstituzCompetente',
  'NumIdentPers',
  'NumIdentTess',
  'DataNascitaEstero',
  'DataScadTessera',
  'Ricetta1',
  'Ricetta2',
  'Prescrizione',
];
const PRESCRIZIONE = [
  'CodProdPrest',
  'DescrProdPrest',
  'NotaProd',
  'Quantita',
  'Prescrizione1',
  'Prescrizione2',
];

/** I figli di un elemento seguono la sequenza dello schema (gli opzionali possono mancare). */
function inOrder(el: Element, sequence: string[]) {
  const names: string[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) names.push(n.nodeName);
  let at = 0;
  for (const name of names) {
    const i = sequence.indexOf(name, at);
    if (i < 0) throw new Error(`${name} fuori posto in ${el.nodeName}: ${names.join(', ')}`);
    at = name === 'Prescrizione' ? i : i + 1;
  }
  return names;
}

// Codici fiscali e numeri inventati (D12): luogo di nascita con la X.
const DOCTOR = buildFiscalCode({
  surname: 'Marchi',
  name: 'Elena',
  birthDate: '1970-01-01',
  sex: 'F',
  placeCode: 'X001',
});
const PATIENT = buildFiscalCode({
  surname: 'Rossetti',
  name: 'Lina',
  birthDate: '1950-03-14',
  sex: 'F',
  placeCode: 'X101',
});

/** Il tipo di invio lo dà la regione (D300): qui un valore di prova. */
const SEND_TYPE = 'TST';

const specialistica = (nre = '010ZZ4000123000'): DpcmPrescription => ({
  bar1: '01026',
  bar2: '0001234057',
  patientFiscalCode: PATIENT,
  kind: 'P',
  exemptionCode: null,
  notExempt: true,
  diagnosisText: 'Controllo dopo la terapia: è più stanca del solito',
  compiledAt: '2026-11-25',
  visitType: 'A',
  patientProvince: 'TO',
  patientAsl: '301',
  priority: 'P',
  nre,
  doctorFiscalCode: DOCTOR,
  lines: [
    {
      productCode: '90.62.2',
      description: 'EMOCROMO: ESAME CROMOCITOMETRICO E CONTEGGIO LEUCOCITARIO',
      quantity: 1,
      prescription2: 'CODCATPRESCR=90.62.2_0$TIPOACC=P$',
    },
  ],
});

describe('file della ricetta DPCM (RicettaMIR.xsd 2.1; D270)', () => {
  it('rispetta l’ordine degli elementi dello schema, con il TipoInvio della regione e l’NRE in Ricetta1', () => {
    const xml = dpcmInsertXml(specialistica(), {
      pinCode: '1234',
      crypto: SIMULATED_DPCM_CRYPTO,
      sendType: SEND_TYPE,
    });
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement!;
    expect(root.nodeName).toBe('RicetteMIR');
    expect(inOrder(root, ['Testata', 'RicettaI'])).toEqual(['Testata', 'RicettaI']);
    inOrder(doc.getElementsByTagName('Testata')[0]!, TESTATA);
    const names = inOrder(doc.getElementsByTagName('RicettaI')[0]!, RICETTA_I);
    expect(names).toContain('Ricetta1');
    inOrder(doc.getElementsByTagName('Prescrizione')[0]!, PRESCRIZIONE);
    const one = (n: string) => doc.getElementsByTagName(n)[0]?.textContent;
    expect(one('TipoInvio')).toBe(SEND_TYPE);
    expect(one('Bar1')).toBe('01026');
    expect(one('Bar2')).toBe('0001234057');
    expect(one('Ricetta1')).toBe('010ZZ4000123000');
    expect(one('Ricetta2')).toBe(DOCTOR);
    expect(one('TotPezzi')).toBe('1');
    expect(one('NonEsente')).toBe('1');
    // PIN e codice fiscale dell'assistito cifrati (V06, 3.1.2): mai in chiaro nel file.
    expect(xml).not.toContain(PATIENT);
    expect(xml).not.toContain('<PinCode>1234<');
  });

  it('solo caratteri «BasicLatin», come vuole lo schema: niente accenti né virgolette tipografiche', () => {
    expect(toBasicLatin('È più l’ultima «prova» – ok')).toBe('E piu l\'ultima "prova" - ok');
    // Il resto, che non ha un equivalente semplice, si toglie: niente «€», «°», «ß» o «µ».
    expect(toBasicLatin('Dose 5 µg, 37 °C, 2 €, Straße')).toBe('Dose 5 g, 37 C, 2 , Strae');
    // A capo e tabulazioni separano le parole: diventano uno spazio, non spariscono.
    expect(toBasicLatin('Controllo\ndella\r\nfunzione\trenale')).toBe(
      'Controllo della funzione renale',
    );
    const xml = dpcmInsertXml(specialistica(), {
      pinCode: '1',
      crypto: SIMULATED_DPCM_CRYPTO,
      sendType: SEND_TYPE,
    });
    expect(/^[\x20-\x7e]*$/.test(xml)).toBe(true);
    expect(xml).toContain('<DescrizioneDiagnosi>Controllo dopo la terapia: e piu stanca');
  });

  it('ferma prima di comporre ciò che lo schema o il manuale non ammettono', () => {
    const p = specialistica();
    expect(dpcmPrescriptionProblem(p)).toBeNull();
    expect(dpcmPrescriptionProblem({ ...p, bar2: '123' })).toMatch(/Poligrafico/);
    expect(dpcmPrescriptionProblem({ ...p, diagnosisText: '' })).toMatch(/diagnosi/);
    expect(
      dpcmPrescriptionProblem({ ...p, lines: [{ ...p.lines[0]!, productCode: null }] }),
    ).toMatch(/codice della prestazione/);
    expect(dpcmPrescriptionProblem({ ...p, patientAsl: null })).toMatch(/Provincia e ASL/);
    expect(dpcmPrescriptionProblem({ ...p, lines: [{ ...p.lines[0]!, quantity: 1000 }] })).toMatch(
      /da 1 a 999/,
    );
    expect(() =>
      dpcmInsertXml(
        { ...p, lines: [] },
        { pinCode: '1', crypto: SIMULATED_DPCM_CRYPTO, sendType: SEND_TYPE },
      ),
    ).toThrow(/non ha righe/);
  });

  it('nome del file: da 6 a 60 caratteri, con chi produce il programma dopo «_» (6.1.1)', () => {
    const name = dpcmFileName('ricetta20261125a1', 'Società di prova software');
    expect(name).toBe('ricetta20261125a1_SOCIETADIP.zip');
    expect(name.length).toBeGreaterThanOrEqual(6);
    expect(dpcmFileName('x'.repeat(80), 'P').length).toBeLessThanOrEqual(60);
  });

  it('il pacchetto è uno zip con un solo file XML, uguale a ogni composizione', () => {
    const a = dpcmPackage(specialistica(), {
      pinCode: '1',
      crypto: SIMULATED_DPCM_CRYPTO,
      sendType: SEND_TYPE,
      xmlName: 'ricetta.xml',
    });
    const b = dpcmPackage(specialistica(), {
      pinCode: '1',
      crypto: SIMULATED_DPCM_CRYPTO,
      sendType: SEND_TYPE,
      xmlName: 'ricetta.xml',
    });
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
    const files = unzipSync(a.zip);
    expect(Object.keys(files)).toEqual(['ricetta.xml']);
    expect(strFromU8(files['ricetta.xml']!)).toBe(a.xml);
  });
});
