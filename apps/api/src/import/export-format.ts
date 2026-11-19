import { createHash } from 'node:crypto';
import {
  ALLERGY_AGENT_DB,
  ALLERGY_CRITICALITY_DB,
  ALLERGY_KIND_DB,
  ANAMNESIS_KIND,
  CONTACT_KIND,
  importDestination,
  keyOf,
  MEASURES,
  MOTOR_CAPACITIES,
  PATIENT_STATUSES,
  PROBLEM_CATEGORY_KIND,
  relativeByCode,
  REMINDER_CHANNELS,
  type ImportDestinationKey,
} from '@mmg/domain';
import type { ImportMapping } from './mapping';
import { columnLetter, FileRejected, type ImportTable } from './table';

/**
 * La nostra esportazione completa (`mmg-esportazione`, versione 1, docs/esportazione.md) come
 * file da importare in un altro studio che usa il programma (tappa 15). Le righe del database
 * diventano tabelle già smistate, una per menu, con il codice fiscale del paziente al posto degli
 * identificativi interni, e la mappatura è proposta già fatta. Gli identificativi d'origine delle
 * righe evitano i doppioni se l'esportazione si importa due volte.
 *
 * Prima di tutto si controllano le impronte di ogni tabella (SHA-256 del JSON, come le calcola
 * l'esportazione): un file cambiato dopo l'esportazione non entra.
 *
 * Restano fuori, e il rapporto lo dice: voci annullate, referti con gli allegati, piani
 * terapeutici, consensi, deleghe, scelte, nuclei familiari, appuntamenti, certificati, Profilo
 * sanitario, registro e storico dello studio d'origine (restano nel file, verificabili).
 */

type Row = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);
const yes = (v: unknown) => (v === true ? '1' : v === false ? '0' : '');
/** Una data o un istante del database come data AAAA-MM-GG. */
const day = (v: unknown) => text(v).slice(0, 10);

/** Le righe di una destinazione, con le intestazioni uguali alle etichette del catalogo. */
function table(
  name: string,
  destination: ImportDestinationKey,
  rows: Record<string, string>[],
): { table: ImportTable; part: ImportMapping['parti'][number] } | null {
  if (!rows.length) return null;
  const d = importDestination(destination)!;
  const keys = d.fields.map((f) => f.key).filter((k) => rows.some((r) => (r[k] ?? '') !== ''));
  const labels = keys.map((k) => d.fields.find((f) => f.key === k)!.label);
  return {
    table: {
      name,
      width: keys.length,
      records: [
        { line: 1, cells: labels },
        ...rows.map((r, i) => ({ line: i + 2, cells: keys.map((k) => r[k] ?? '') })),
      ],
    },
    part: {
      tabella: name,
      intestazione: 1,
      destinazione: destination,
      campi: Object.fromEntries(
        keys.map((k, i) => [k, { colonna: { lettera: columnLetter(i), nome: labels[i]! } }]),
      ),
    },
  };
}

export interface ExportRead {
  tables: ImportTable[];
  mapping: ImportMapping;
  notes: string[];
}

export function exportTables(doc: Record<string, unknown>): ExportRead {
  const tabelle = doc.tabelle;
  const impronte = doc.impronte;
  if (!isObject(tabelle) || !isObject(impronte))
    throw new FileRejected('Esportazione incompleta: mancano le tabelle o le impronte.');
  // Impronte: lo stesso calcolo dell'esportazione, tabella per tabella.
  for (const [name, rows] of Object.entries(tabelle)) {
    const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    if (impronte[name] !== digest)
      throw new FileRejected(
        `L’esportazione è stata modificata dopo essere stata creata (tabella «${name.slice(0, 60)}»): non si importa.`,
      );
  }
  const rows = (name: string): Row[] => {
    const v = tabelle[name];
    return Array.isArray(v) ? v.filter(isObject) : [];
  };
  const cfOf = new Map(rows('patient').map((p) => [text(p.id), text(p.fiscal_code)]));
  const byEntry = (name: string) => new Map(rows(name).map((r) => [text(r.entry_id), r]));
  const notes: string[] = [];

  const patients = rows('patient').map((p) => ({
    codiceFiscale: text(p.fiscal_code),
    cognome: text(p.last_name),
    nome: text(p.first_name),
    sesso: text(p.sex),
    nascita: day(p.birth_date),
    luogoNascitaCodice: text(p.birth_place_code),
    luogoNascita: text(p.birth_place_name),
    telefono: text(p.phone),
    email: text(p.email),
    residenzaVia: text(p.residence_street),
    residenzaCivico: text(p.residence_number),
    residenzaCap: text(p.residence_postal_code),
    residenzaComune: text(p.residence_town),
    residenzaProvincia: text(p.residence_province),
    domicilio: text(p.domicile),
    asl: text(p.asl),
    distretto: text(p.district),
    tipoAssistenza: text(p.assistance_type),
    stato: PATIENT_STATUSES.find((s) => s.db === p.status)?.key ?? '',
    decedutoIl: day(p.deceased_on),
    causaDecesso: text(p.death_cause_icd),
    tesseraTeam: text(p.foreign_health_card),
    enteEstero: text(p.foreign_institution),
    professione: text(p.occupation),
    condizioneProfessionale: text(p.employment_condition),
    emailDatoreLavoro: text(p.employer_email),
    canalePromemoria: REMINDER_CHANNELS.find((c) => c.db === p.reminder_channel)?.key ?? '',
    recapitoPromemoria: text(p.reminder_contact),
    canaleSceltoIl: day(p.reminder_channel_chosen_on),
  }));

  // Esenzioni: solo quelle in vigore; le annullate (D197) restano nell'esportazione.
  const annulledExemptions = rows('exemption').filter((e) => text(e.annulled_at) !== '').length;
  if (annulledExemptions)
    notes.push(
      `${annulledExemptions} esenzioni annullate nello studio d’origine: non si importano`,
    );
  const exemptions = rows('exemption')
    .filter((e) => text(e.annulled_at) === '')
    .map((e) => ({
      codiceFiscale: cfOf.get(text(e.patient_id)) ?? '',
      codice: text(e.code),
      dal: day(e.valid_from),
      al: day(e.valid_to),
      codiceRicetta: text(e.prescription_code),
      idOrigine: text(e.id),
    }));

  // Voci cliniche: solo quelle in vigore; le annullate restano nell'esportazione.
  const entries = rows('clinical_entry');
  const annulled = entries.filter((e) => e.status !== 'active').length;
  if (annulled) notes.push(`${annulled} voci annullate nello studio d’origine: non si importano`);
  const active = entries.filter((e) => e.status === 'active');
  const common = (e: Row) => ({
    codiceFiscale: cfOf.get(text(e.patient_id)) ?? '',
    data: day(e.occurred_on),
    note: text(e.notes),
    riservata: yes(e.reserved),
    oscurata: yes(e.obscured),
    idOrigine: text(e.id),
  });
  const details = {
    problem: byEntry('problem_detail'),
    allergy: byEntry('allergy_detail'),
    diary: byEntry('diary_detail'),
    anamnesis: byEntry('anamnesis_detail'),
    risk_factor: byEntry('risk_factor_detail'),
    examination: byEntry('examination_detail'),
    functional_status: byEntry('functional_status_detail'),
    measurement: byEntry('measurement_detail'),
    vaccination: byEntry('vaccination_detail'),
    lab_result: byEntry('lab_result_detail'),
  };
  const of = (kind: keyof typeof details) =>
    active
      .filter((e) => e.kind === kind)
      .flatMap((e) => {
        const d = details[kind].get(text(e.id));
        return d ? [{ e, d }] : [];
      });
  const reports = active.filter((e) => e.kind === 'report').length;
  if (reports)
    notes.push(
      `${reports} referti con allegati: non si importano da qui (gli allegati restano nell’esportazione)`,
    );

  const problems = of('problem').map(({ e, d }) => ({
    ...common(e),
    descrizione: text(d.description),
    codice: text(d.icd_code),
    stato: d.state === 'resolved' ? 'risolto' : 'attivo',
    dal: day(d.onset_on),
    risoltoIl: day(d.resolved_on),
    quesitoAperto: yes(d.open_question),
    cronico: yes(d.chronic),
    categoria: keyOf(PROBLEM_CATEGORY_KIND, text(d.category)) ?? '',
  }));
  const allergies = of('allergy').map(({ e, d }) => ({
    ...common(e),
    sostanza: text(d.substance),
    reazione: text(d.reaction),
    daFarmaco: yes(d.drug_related),
    natura: keyOf(ALLERGY_KIND_DB, text(d.kind)) ?? '',
    agente: keyOf(ALLERGY_AGENT_DB, text(d.agent_category)) ?? '',
    codiceAgente: text(d.agent_code),
    criticita: keyOf(ALLERGY_CRITICALITY_DB, text(d.criticality)) ?? '',
    attiva: yes(d.active),
  }));
  const diary = of('diary').map(({ e, d }) => ({
    ...common(e),
    contatto: keyOf(CONTACT_KIND, text(d.contact_type)) ?? '',
    testo: text(d.text),
  }));
  const anamnesis = of('anamnesis').map(({ e, d }) => ({
    ...common(e),
    sezione: keyOf(ANAMNESIS_KIND, text(d.section)) ?? '',
    testo: text(d.text),
    parente: relativeByCode(text(d.relative_code))?.key ?? '',
    codice: text(d.icd_code),
    etaEsordio: text(d.onset_age),
  }));
  const lifestyle = of('risk_factor').map(({ e, d }) => ({
    ...common(e),
    fattore: text(d.factor),
    valore: text(d.value),
  }));
  const examination = of('examination').map(({ e, d }) => ({
    ...common(e),
    testo: text(d.text),
    scala: text(d.scale),
    punteggio: text(d.score),
  }));
  const motor = of('functional_status').map(({ e, d }) => ({
    ...common(e),
    capacita: MOTOR_CAPACITIES.find((m) => m.code === d.motor_capacity)?.key ?? '',
  }));
  const measures = of('measurement').map(({ e, d }) => ({
    ...common(e),
    parametro: MEASURES.find((m) => m.label === d.measure)?.key ?? '',
    valore: text(d.value),
  }));
  const vaccinations = of('vaccination').map(({ e, d }) => ({
    ...common(e),
    vaccino: text(d.vaccine),
    lotto: text(d.lot),
    dose: text(d.dose_number),
    campagna: text(d.campaign),
  }));
  const labs = of('lab_result').map(({ e, d }) => ({
    ...common(e),
    analita: text(d.analyte),
    valore: text(d.value),
    unita: text(d.unit),
    minimo: text(d.reference_low),
    massimo: text(d.reference_high),
    riferimento: text(d.reference_text),
    codicePrestazione: text(d.service_code),
  }));

  const kinds = { chronic: 'cronica', as_needed: 'al_bisogno', cycle: 'ciclo' } as const;
  const states = { active: 'in_corso', ended: 'conclusa', suspended: 'sospesa' } as const;
  const therapies = rows('therapy').map((t) => ({
    codiceFiscale: cfOf.get(text(t.patient_id)) ?? '',
    farmaco: text(t.drug_name),
    aic: text(t.drug_aic),
    principioAttivo: text(t.active_ingredient),
    atc: text(t.atc),
    tipo: kinds[text(t.kind) as keyof typeof kinds] ?? '',
    inizio: day(t.start_on),
    fine: day(t.end_on),
    stato: states[text(t.status) as keyof typeof states] ?? '',
    motivoSospensione: text(t.suspended_reason),
    dose: text(t.dose),
    unitaDose: text(t.dose_unit),
    frequenza: text(t.frequency),
    momento: text(t.time_of_day),
    via: text(t.route),
    unitaAlGiorno: text(t.units_per_day),
    confezioni: text(t.packs_per_prescription),
    esenzioneAbituale: text(t.habitual_exemption_code),
    notaAifa: text(t.aifa_note),
    istruzioni: text(t.patient_instructions),
    riservata: yes(t.reserved),
    importante: yes(t.important),
    nonSostituibile: yes(t.not_substitutable),
    motivoNonSostituibile: text(t.not_substitutable_reason),
    idOrigine: text(t.id),
  }));

  // Ricette: quelle passate di altri programmi, e le nostre inviate o stampate, riga per riga.
  const medico = isObject(doc.medico) ? doc.medico : {};
  const lines = rows('prescription_line');
  const sent = rows('prescription').filter((p) => p.status === 'sent' || p.status === 'paper');
  const past = [
    ...rows('historical_prescription')
      .filter((h) => !h.annulled_at)
      .map((h) => ({
        codiceFiscale: cfOf.get(text(h.patient_id)) ?? '',
        data: day(h.prescribed_on),
        tipo: text(h.kind),
        farmaco: text(h.drug_name),
        aic: text(h.drug_aic),
        principioAttivo: text(h.active_ingredient),
        atc: text(h.atc_code),
        quantita: text(h.quantity),
        posologia: text(h.posology_text),
        codicePrestazione: text(h.service_code),
        descrizionePrestazione: text(h.service_description),
        nre: text(h.nre),
        prescrittore: text(h.prescriber_name),
        note: text(h.notes),
        idOrigine: text(h.id),
      })),
    ...sent
      .filter((p) => p.kind !== 'devices')
      .flatMap((p) =>
        lines
          .filter((l) => l.prescription_id === p.id)
          .map((l) => ({
            codiceFiscale: cfOf.get(text(p.patient_id)) ?? '',
            data: day(p.sent_at ?? p.paper_printed_at),
            tipo: p.kind === 'specialist_ssn' ? 'prestazione' : 'farmaco',
            farmaco: text(l.drug_name),
            aic: text(l.drug_aic),
            principioAttivo: text(l.active_ingredient),
            atc: '',
            quantita: text(l.quantity),
            posologia: text(l.posology_text),
            codicePrestazione: text(l.service_code),
            descrizionePrestazione: text(l.service_description),
            nre: text(p.nre),
            prescrittore: p.signed_by === medico.id ? text(medico.nome) : '',
            note: '',
            idOrigine: text(l.id),
          })),
      ),
  ];
  const devices = sent.filter((p) => p.kind === 'devices').length;
  if (devices) notes.push(`${devices} prescrizioni di presidi: non si importano da qui`);
  for (const t of [
    'therapeutic_plan',
    'consent',
    'delegation',
    'patient_choice',
    'supply_prescription',
    'appointment',
    'sick_leave_certificate',
    'pss_document',
  ])
    if (rows(t).length)
      notes.push(`Tabella «${t}» (${rows(t).length} righe): non si importa ancora da qui`);

  const built = [
    table('Pazienti', 'pazienti', patients),
    table('Esenzioni', 'esenzioni', exemptions),
    table('Problemi e diagnosi', 'problemi', problems),
    table('Allergie e reazioni avverse', 'allergie', allergies),
    table('Diario clinico', 'diario', diary),
    table('Anamnesi', 'anamnesi', anamnesis),
    table('Stili di vita', 'stili_di_vita', lifestyle),
    table('Esame obiettivo', 'esame_obiettivo', examination),
    table('Capacità motoria', 'capacita_motoria', motor),
    table('Parametri', 'parametri', measures),
    table('Vaccinazioni', 'vaccinazioni', vaccinations),
    table('Esami di laboratorio', 'esami_laboratorio', labs),
    table('Terapie', 'terapie', therapies),
    table('Ricette passate', 'ricette_passate', past),
  ].flatMap((x) => (x ? [x] : []));
  if (!built.length) throw new FileRejected('L’esportazione non contiene dati da importare.');
  return {
    tables: built.map((b) => b.table),
    mapping: { parti: built.map((b) => b.part) },
    notes,
  };
}
