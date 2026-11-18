import type { PssCdaInput } from '../../src/fse/cda';

/** Dati inventati (regola 1): codici fiscali con un comune che non esiste (X001). */
const place = { istatCode: '999999', city: 'Comune di prova', province: 'XX' };
export function sampleInput(over: Partial<PssCdaInput> = {}): PssCdaInput {
  const created = new Date('2026-11-18T09:30:00Z');
  return {
    document: {
      id: { root: '2.999.1.1', extension: 'PSS.1' },
      setId: { root: '2.999.1.1', extension: 'PSS.1' },
      version: 1,
      createdAt: created,
      confidentiality: 'N',
    },
    patient: {
      fiscalCode: 'PRVPZN70A41X001X',
      firstName: 'Paziente',
      lastName: 'Di Prova',
      sex: 'F',
      birthDate: '1970-01-01',
      birthPlace: place,
      address: { ...place, postalCode: '00000', street: 'Via Inventata 1' },
    },
    author: {
      fiscalCode: 'MDCPRV65B12X001Y',
      firstName: 'Medica',
      lastName: 'Inventata',
      prefix: 'Dott.ssa',
      telecoms: {
        phone: '000 0000000',
        email: 'studio@esempio.invalid',
        pec: 'medico@pec.invalid',
      },
      time: created,
    },
    custodian: {
      id: { root: '2.999.2', extension: 'CUSTODE' },
      name: 'Custode di prova',
      address: { ...place, street: 'Via del Custode 2' },
    },
    legalAuthenticatorTime: created,
    serviceTime: created,
    allergies: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: { code: 'DALG', display: 'Drug Allergy' },
        agent: { code: 'J01CA04', system: 'ATC', display: 'Amoxicillina' },
        status: 'active',
        onsetOn: '2010-05-01',
        criticality: 'H',
        comment: 'Orticaria diffusa & prurito <grave>',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: { code: 'ALG', display: 'Allergy' },
        agent: { code: '288328004', system: 'ALLERGENI', display: "Veleno d'api" },
        status: 'inactive',
        onsetOn: '2001-07-10',
        endOn: '2015-01-01',
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: { code: 'FINT', display: 'Food Intolerance' },
        agent: { text: 'Latte vaccino' },
        status: 'active',
      },
    ],
    therapies: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        drug: {
          aic: '000000001',
          atc: 'C09AA02',
          name: 'Farmaco di prova 20 mg',
          atcName: 'Enalapril',
        },
        route: { code: 'PO', display: 'Swallow, oral', label: 'per bocca' },
        startOn: '2020-03-01',
        status: 'active',
        dosage: '1 compressa al mattino',
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        drug: { atc: 'A10AE04', name: 'Insulina di prova', atcName: 'Insulina glargine' },
        route: { code: 'SQ', display: 'Injection, subcutaneous' },
        startOn: '2021-01-15',
        status: 'active',
      },
    ],
    problems: [
      {
        id: '00000000-0000-4000-8000-000000000021',
        code: { code: '250.00', system: 'ICD9CM', display: 'Diabete mellito tipo II' },
        text: 'Diabete mellito di tipo 2',
        state: 'active',
        chronic: true,
        onsetOn: '2019-06-01',
      },
      {
        id: '00000000-0000-4000-8000-000000000022',
        code: {
          code: 'Z90.4',
          system: 'ORGANI_MANCANTI',
          display: 'Mancanza di parti del tratto digerente',
        },
        text: 'Colecistectomia',
        state: 'resolved',
        chronic: false,
        onsetOn: '2012-02-01',
        resolvedOn: '2012-03-01',
      },
    ],
    familyHistory: [
      {
        id: '00000000-0000-4000-8000-000000000031',
        relative: { code: 'FTH', display: 'Padre', sex: 'M' },
        code: { code: '410.9', display: 'Infarto miocardico acuto' },
        text: 'Infarto del padre',
        onsetAge: 55,
      },
    ],
    vitals: [
      {
        id: '00000000-0000-4000-8000-000000000041',
        loinc: '29463-7',
        label: 'Peso',
        value: '70',
        unit: 'kg',
        measuredOn: '2026-11-01',
      },
      {
        id: '00000000-0000-4000-8000-000000000042',
        loinc: '8480-6',
        label: 'Pressione sistolica',
        value: '130',
        unit: 'mm[Hg]',
        measuredOn: '2026-11-01',
      },
    ],
    lifestyle: [
      {
        id: '00000000-0000-4000-8000-000000000051',
        loinc: '72166-2',
        label: 'Fumo',
        text: 'Ex fumatrice dal 2015',
        recordedOn: '2026-10-01',
      },
    ],
    motorCapacity: { code: 'LA21285-4', display: 'Autonomo', since: '2026-01-10' },
    ...over,
  };
}
