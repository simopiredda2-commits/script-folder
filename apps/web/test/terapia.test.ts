import { describe, expect, it } from 'vitest';
import {
  dailyUnits,
  parseDose,
  patientReading,
  scheduleMoment,
  SCHEDULE_MOMENTS,
} from '../src/lib/therapy';
import { draftBody, draftFromTherapy, emptyDraft, validateDraft } from '../src/pages/TherapyForm';
import { registryPatch } from '../src/pages/RegistrySection';
import type { TherapyFull } from '../src/pages/RecordPage';

describe('scheda della terapia: calcoli proposti (D80)', () => {
  it('la dose: interi, decimali con la virgola, frazioni; il resto non è un numero', () => {
    expect(parseDose('1')).toBe(1);
    expect(parseDose('0,5')).toBe(0.5);
    expect(parseDose('1/2')).toBe(0.5);
    expect(parseDose(' 2 ')).toBe(2);
    expect(parseDose('mezza')).toBeNull();
    expect(parseDose('')).toBeNull();
    expect(parseDose('1/0')).toBeNull();
  });

  it('unità al giorno = dose × volte al giorno; vuote se non si possono dire', () => {
    expect(dailyUnits('1', '1 volta al giorno', 'chronic')).toBe('1');
    expect(dailyUnits('1', '2 volte al giorno', 'chronic')).toBe('2');
    expect(dailyUnits('2', '3 volte al giorno', 'cycle')).toBe('6');
    expect(dailyUnits('1/2', '1 volta al giorno', 'chronic')).toBe('0.5');
    expect(dailyUnits('1', 'a giorni alterni', 'chronic')).toBe('0.5');
    expect(dailyUnits('1', '1 volta a settimana', 'chronic')).toBe('0.143');
    // Al bisogno, dose o frequenza mancanti o fuori elenco: niente numero, niente contatore.
    expect(dailyUnits('1', '1 volta al giorno', 'as_needed')).toBeNull();
    expect(dailyUnits('', '1 volta al giorno', 'chronic')).toBeNull();
    expect(dailyUnits('1', '', 'chronic')).toBeNull();
    expect(dailyUnits('1', 'quando serve', 'chronic')).toBeNull();
    expect(dailyUnits('0', '1 volta al giorno', 'chronic')).toBeNull();
  });

  it('come la legge il paziente: plurale, frequenza a parole, momento e via', () => {
    expect(
      patientReading({
        dose: '1',
        doseUnit: 'compressa',
        frequency: '1 volta al giorno',
        timeOfDay: 'la sera',
        route: 'per bocca',
        kind: 'chronic',
      }),
    ).toBe('1 compressa una volta al giorno, la sera, per bocca');
    expect(
      patientReading({
        dose: '2',
        doseUnit: 'goccia',
        frequency: '3 volte al giorno',
        timeOfDay: 'indifferente',
        kind: 'chronic',
      }),
    ).toBe('2 gocce tre volte al giorno');
    expect(patientReading({ dose: '1', doseUnit: 'bustina', kind: 'as_needed' })).toBe(
      '1 bustina, al bisogno',
    );
    expect(patientReading({ kind: 'as_needed' })).toBe('Al bisogno');
    expect(patientReading({ kind: 'chronic' })).toBe('');
  });

  it('lo schema orario mette ogni terapia in un solo momento della giornata', () => {
    expect(scheduleMoment({ timeOfDay: 'al mattino', kind: 'chronic' })).toBe('Mattino');
    expect(scheduleMoment({ timeOfDay: 'a pranzo', kind: 'chronic' })).toBe('Pranzo');
    expect(scheduleMoment({ timeOfDay: 'la sera', kind: 'cycle' })).toBe('Sera');
    expect(scheduleMoment({ timeOfDay: 'indifferente', kind: 'chronic' })).toBe(
      'In qualsiasi momento',
    );
    expect(scheduleMoment({ timeOfDay: null, kind: 'chronic' })).toBe('In qualsiasi momento');
    expect(scheduleMoment({ timeOfDay: 'la sera', kind: 'as_needed' })).toBe('Al bisogno');
    for (const m of ['Mattino', 'Pranzo', 'Sera', 'In qualsiasi momento', 'Al bisogno'])
      expect(SCHEDULE_MOMENTS).toContain(m);
  });
});

const saved: TherapyFull = {
  id: 't1',
  drugName: 'AMLODIPINA DOC GENERICI 5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC',
  drugAic: '038092019',
  activeIngredient: 'AMLODIPINA BESILATO',
  kind: 'chronic',
  status: 'active',
  dose: '1',
  doseUnit: 'compressa',
  frequency: '2 volte al giorno',
  timeOfDay: 'la sera',
  aifaNote: null,
  reserved: false,
  important: false,
  atc: 'C08CA01',
  drugClass: 'A',
  equivalenceGroup: null,
  dpc: false,
  route: 'per bocca',
  unitsPerDay: '2',
  startOn: '2026-01-01',
  endOn: null,
  packsPerPrescription: 1,
  indicationEntryId: null,
  habitualExemptionCode: null,
  suggestedByName: null,
  suggestedByFacility: null,
  suggestedOn: null,
  patientInstructions: null,
  notReimbursable: false,
  byActiveIngredient: false,
  notSubstitutable: false,
  notSubstitutableReason: null,
  multiPrescription: false,
  suggestedS: false,
  hospitalH: false,
  suspendedReason: null,
};

describe('scheda della terapia: controlli formali e corpo per il servizio', () => {
  it('la scheda vuota chiede il farmaco; una scheda salvata è valida', () => {
    expect(Object.keys(validateDraft(emptyDraft('2026-11-18')))).toEqual(['drugName']);
    expect(validateDraft(draftFromTherapy(saved))).toEqual({});
  });

  it('gli stessi controlli del servizio: R13, ciclo, date, suggerita, confezioni, unità', () => {
    const d = draftFromTherapy(saved);
    expect(validateDraft({ ...d, notSubstitutable: true }).notSubstitutableReason).toMatch(/R13/);
    expect(validateDraft({ ...d, kind: 'cycle' }).endOn).toMatch(/manca la data di fine/);
    expect(validateDraft({ ...d, endOn: '2025-12-31' }).endOn).toMatch(/prima dell’inizio/);
    expect(validateDraft({ ...d, typology: 'S' }).suggestedByName).toMatch(/suggeritore/);
    expect(validateDraft({ ...d, packs: '0' }).packs).toBeDefined();
    expect(validateDraft({ ...d, packs: '100' }).packs).toBeDefined();
    expect(validateDraft({ ...d, unitsPerDay: 'due' }).unitsPerDay).toBeDefined();
    expect(validateDraft({ ...d, unitsPerDay: '0,5' })).toEqual({});
  });

  it('le unità al giorno corrette a mano restano a mano', () => {
    expect(draftFromTherapy(saved).unitsAuto).toBe(true);
    const manual = draftFromTherapy({ ...saved, unitsPerDay: '1.5' });
    expect(manual.unitsAuto).toBe(false);
    expect(manual.unitsPerDay).toBe('1,5');
  });

  it('il corpo: vuoti come null, tipologia S/H, motivazione solo se non sostituibile', () => {
    const body = draftBody({
      ...draftFromTherapy(saved),
      aifaNote: '  ',
      typology: 'H',
      notSubstitutable: false,
      notSubstitutableReason: 'resta fuori',
    });
    expect(body).toMatchObject({
      drugName: 'AMLODIPINA DOC GENERICI 5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC',
      aifaNote: null,
      packsPerPrescription: 1,
      suggestedS: false,
      hospitalH: true,
      notSubstitutableReason: null,
      unitsPerDay: '2',
    });
    // Tornando dalla scheda salvata si riottengono gli stessi valori.
    expect(draftBody(draftFromTherapy(saved))).toMatchObject({
      dose: '1',
      frequency: '2 volte al giorno',
      timeOfDay: 'la sera',
      route: 'per bocca',
      endOn: null,
    });
  });
});

describe('recapiti: si manda solo quello che cambia', () => {
  const blank = {
    phone: '',
    email: '',
    residenceStreet: '',
    residenceNumber: '',
    residenceTown: '',
    residenceProvince: '',
    domicile: '',
    occupation: '',
    employerEmail: '',
  };
  it('campo cambiato, campo svuotato, sigla della provincia in maiuscolo', () => {
    expect(
      registryPatch(
        { phone: '011 000 0000', email: 'prova@example.invalid', residenceProvince: null },
        { ...blank, phone: '011 000 0000', email: '', residenceProvince: 'to' },
      ),
    ).toEqual({ email: null, residenceProvince: 'TO' });
    expect(registryPatch({ phone: '1' }, { ...blank, phone: '1' })).toEqual({});
  });
});
