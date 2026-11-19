import {
  ALLERGY_AGENT_DB,
  ALLERGY_CRITICALITY_DB,
  ALLERGY_KIND_DB,
  CRITICALITY_HL7,
  intoleranceType,
  keyOf,
  lifestyleFor,
  MOTOR_CAPACITIES,
  PROBLEM_CATEGORY_KIND,
  PSS_VITALS,
  relativeByCode,
  routeFor,
  type AllergyAgent,
} from '@mmg/domain';
import {
  FSE_DICTIONARIES,
  fseDictionaryEntry,
  itDate,
  type CdaAddress,
  type CdaAllergy,
  type CdaFamilyCondition,
  type CdaLifestyle,
  type CdaProblem,
  type CdaTherapy,
  type CdaVital,
} from '@mmg/integrations';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  allergyDetail,
  anamnesisDetail,
  clinicalEntry,
  functionalStatusDetail,
  measurementDetail,
  problemDetail,
  riskFactorDetail,
  therapy,
} from '../db/schema';

/**
 * Composizione del Profilo Sanitario Sintetico dalla cartella (tappa 11, D134). Si propongono
 * i dati obbligatori del DM 27/6/2025; i facoltativi si propongono anche loro, e il medico toglie
 * quello che non vuole. Le voci oscurate non entrano mai (DM 7/9/2023, art. 4, c. 3); le
 * riservate non si propongono. Il medico controlla tutto prima della validazione.
 */

export interface PssItem<T> {
  /** Voce di origine: la voce della cartella o la terapia. */
  id: string;
  etichetta: string;
  incluso: boolean;
  /** Che cosa manca perché la voce possa entrare; vuoto se può entrare. */
  manca: string[];
  dati: T;
}

export interface PssMotorCapacity {
  id: string;
  code: string;
  display: string;
  since: string;
}

export interface PssSections {
  allergie: PssItem<CdaAllergy>[];
  terapie: PssItem<CdaTherapy>[];
  problemi: PssItem<CdaProblem>[];
  anamnesiFamiliare: PssItem<CdaFamilyCondition>[];
  parametri: PssItem<CdaVital>[];
  stiliDiVita: PssItem<CdaLifestyle>[];
  capacitaMotoria: PssItem<PssMotorCapacity>[];
}

export const PSS_SECTION_KEYS = [
  'allergie',
  'terapie',
  'problemi',
  'anamnesiFamiliare',
  'parametri',
  'stiliDiVita',
  'capacitaMotoria',
] as const satisfies readonly (keyof PssSections)[];
export type PssSectionKey = (typeof PSS_SECTION_KEYS)[number];

/** Quando una sezione obbligatoria resta vuota: «nessuna nota» o «nessuna informazione». */
export interface PssAbsences {
  allergie: 'no-known-allergies' | 'no-allergy-info';
  terapie: 'no-known-medications' | 'no-medication-info';
  problemi: 'no-known-problems' | 'no-problem-info';
  anamnesiFamiliare: 'no-known-problems' | 'no-problem-info';
}

export interface PssContent {
  composto: string;
  paziente: {
    cf: string;
    nome: string;
    cognome: string;
    sesso: 'M' | 'F' | null;
    nascita: string;
    luogoNascita: CdaAddress | null;
  };
  sezioni: PssSections;
  /** Per difetto «nessuna informazione»: «nessuna nota» lo decide il medico. */
  assenze: PssAbsences;
  esclusi: { oscurate: number; riservate: number };
  /** Voci che non possono entrare così come sono, con il motivo. */
  nonInseribili: { etichetta: string; motivo: string }[];
}

export const DEFAULT_ABSENCES: PssAbsences = {
  allergie: 'no-allergy-info',
  terapie: 'no-medication-info',
  problemi: 'no-problem-info',
  anamnesiFamiliare: 'no-problem-info',
};

const CRITICALITY_FROM_DB = Object.fromEntries(
  Object.entries(ALLERGY_CRITICALITY_DB).map(([k, v]) => [
    v,
    CRITICALITY_HL7[k as keyof typeof CRITICALITY_HL7],
  ]),
) as Record<string, 'L' | 'M' | 'H'>;

/** Quello che la cartella offre al Profilo, voce per voce. */
export async function composePss(
  db: Database,
  patientId: string,
  today: string,
): Promise<Omit<PssContent, 'paziente' | 'composto'>> {
  const entries = await db
    .select()
    .from(clinicalEntry)
    .where(and(eq(clinicalEntry.patientId, patientId), eq(clinicalEntry.status, 'active')))
    .orderBy(desc(clinicalEntry.occurredOn), desc(clinicalEntry.createdAt));
  const excluded = { oscurate: 0, riservate: 0 };
  const usable = entries.filter((e) => {
    if (e.obscured) {
      excluded.oscurate++;
      return false;
    }
    if (e.reserved) {
      excluded.riservate++;
      return false;
    }
    return true;
  });
  const byId = new Map(usable.map((e) => [e.id, e]));
  const ids = [...byId.keys()];
  const of = <T extends { entryId: string }>(rows: T[]) =>
    rows.filter((r) => byId.has(r.entryId)).map((r) => ({ e: byId.get(r.entryId)!, d: r }));
  const [problems, allergies, anamnesis, measures, risks, functional] = ids.length
    ? await Promise.all([
        db.select().from(problemDetail).where(inArray(problemDetail.entryId, ids)),
        db.select().from(allergyDetail).where(inArray(allergyDetail.entryId, ids)),
        db.select().from(anamnesisDetail).where(inArray(anamnesisDetail.entryId, ids)),
        db.select().from(measurementDetail).where(inArray(measurementDetail.entryId, ids)),
        db.select().from(riskFactorDetail).where(inArray(riskFactorDetail.entryId, ids)),
        db
          .select()
          .from(functionalStatusDetail)
          .where(inArray(functionalStatusDetail.entryId, ids)),
      ])
    : [[], [], [], [], [], []];
  const order = (a: { e: { occurredOn: string } }, b: { e: { occurredOn: string } }) =>
    b.e.occurredOn.localeCompare(a.e.occurredOn);
  const notInsertable: PssContent['nonInseribili'] = [];

  // Allergie: le attive proposte; le non più attive a scelta del medico.
  const allergie: PssItem<CdaAllergy>[] = of(allergies)
    .sort(order)
    .map(({ e, d }) => {
      const agent: AllergyAgent =
        (d.agentCategory ? keyOf(ALLERGY_AGENT_DB, d.agentCategory) : undefined) ??
        (d.drugRelated ? 'farmaco' : 'altro');
      const kind = keyOf(ALLERGY_KIND_DB, d.kind) ?? 'allergia';
      const comment = [d.reaction, e.notes].filter(Boolean).join('. ');
      return {
        id: e.id,
        etichetta: d.substance,
        incluso: d.active,
        manca: [],
        dati: {
          id: e.id,
          type: intoleranceType(kind, agent),
          agent:
            d.agentCode && d.agentSystem
              ? {
                  code: d.agentCode,
                  system: d.agentSystem as 'AIC' | 'ATC' | 'ALLERGENI',
                  display: d.substance,
                }
              : { text: d.substance },
          status: d.active ? 'active' : 'inactive',
          onsetOn: e.occurredOn,
          endOn: d.active ? null : today,
          criticality: d.criticality ? (CRITICALITY_FROM_DB[d.criticality] ?? null) : null,
          comment: comment || null,
        },
      };
    });

  // Problemi: cronici attivi, organi mancanti, trapianti e malformazioni proposti; gli altri no.
  const problemi: PssItem<CdaProblem>[] = of(problems)
    .sort(order)
    .map(({ e, d }) => {
      const category = keyOf(PROBLEM_CATEGORY_KIND, d.category) ?? 'diagnosi';
      const organ = category === 'organo_mancante';
      const dictionary =
        organ && d.icdCode
          ? fseDictionaryEntry(FSE_DICTIONARIES.missingOrgans, d.icdCode)
          : undefined;
      const manca = !d.icdCode
        ? ['Manca il codice ICD-9-CM del problema']
        : organ && !dictionary
          ? ['Il codice non è nell’elenco ufficiale degli organi mancanti']
          : [];
      const proposed = category !== 'diagnosi' || (d.chronic && d.state === 'active');
      return {
        id: e.id,
        etichetta: d.description,
        incluso: proposed && !manca.length,
        manca,
        dati: {
          id: e.id,
          code: {
            code: d.icdCode ?? '',
            system: organ ? 'ORGANI_MANCANTI' : 'ICD9CM',
            display: dictionary?.description ?? d.description,
          },
          text: d.description,
          state: d.state,
          chronic: d.chronic,
          onsetOn: d.onsetOn,
          resolvedOn: d.resolvedOn,
        },
      };
    });

  // Anamnesi familiare: entra solo con il parente e il codice della patologia.
  const anamnesiFamiliare: PssItem<CdaFamilyCondition>[] = [];
  for (const { e, d } of of(anamnesis).sort(order)) {
    if (d.section !== 'family') continue;
    const relative = d.relativeCode ? relativeByCode(d.relativeCode) : undefined;
    if (!relative || !d.icdCode) {
      notInsertable.push({
        etichetta: `Anamnesi familiare: ${d.text.slice(0, 80)}`,
        motivo: 'Indica il parente e il codice ICD-9-CM della patologia',
      });
      continue;
    }
    anamnesiFamiliare.push({
      id: e.id,
      etichetta: `${relative.label}: ${d.text}`,
      incluso: true,
      manca: [],
      dati: {
        id: e.id,
        relative: { code: relative.code, display: relative.label, sex: relative.sex },
        code: { code: d.icdCode, display: d.text },
        text: d.text,
        onsetAge: d.onsetAge,
      },
    });
  }

  // Parametri: l'ultimo valore di altezza, peso, BMI e pressione (facoltativi, proposti).
  const parametri: PssItem<CdaVital>[] = [];
  const seenMeasures = new Set<string>();
  for (const { e, d } of of(measures).sort(order)) {
    const def = PSS_VITALS[d.measure as keyof typeof PSS_VITALS];
    if (!def || seenMeasures.has(d.measure)) continue;
    seenMeasures.add(d.measure);
    parametri.push({
      id: e.id,
      etichetta: `${d.measure}: ${d.value} ${d.unit} (${itDate(e.occurredOn)})`,
      incluso: true,
      manca: [],
      dati: {
        id: e.id,
        loinc: def.loinc,
        label: d.measure,
        value: d.value,
        unit: def.unit,
        measuredOn: e.occurredOn,
      },
    });
  }

  // Stili di vita: l'ultimo valore di fumo, alcol e attività fisica.
  const stiliDiVita: PssItem<CdaLifestyle>[] = [];
  const seenFactors = new Set<string>();
  for (const { e, d } of of(risks).sort(order)) {
    const map = lifestyleFor(d.factor);
    if (!map) {
      notInsertable.push({
        etichetta: `${d.factor}: ${d.value}`,
        motivo: 'Il Profilo ha i codici solo per fumo, alcol e attività fisica',
      });
      continue;
    }
    if (seenFactors.has(map.factor)) continue;
    seenFactors.add(map.factor);
    stiliDiVita.push({
      id: e.id,
      etichetta: `${map.label}: ${d.value}`,
      incluso: true,
      manca: [],
      dati: {
        id: e.id,
        loinc: map.loinc,
        label: map.label,
        text: d.value,
        recordedOn: e.occurredOn,
      },
    });
  }

  // Capacità motoria: l'ultima.
  const capacitaMotoria: PssItem<PssMotorCapacity>[] = [];
  const latest = of(functional).sort(order)[0];
  if (latest) {
    const m = MOTOR_CAPACITIES.find((x) => x.code === latest.d.motorCapacity);
    if (m)
      capacitaMotoria.push({
        id: latest.e.id,
        etichetta: `${m.label} (dal ${itDate(latest.e.occurredOn)})`,
        incluso: true,
        manca: [],
        dati: { id: latest.e.id, code: m.code, display: m.label, since: latest.e.occurredOn },
      });
  }

  // Terapie: le croniche in corso proposte; le altre a scelta. Le riservate non si propongono.
  const therapies = await db
    .select()
    .from(therapy)
    .where(and(eq(therapy.patientId, patientId), eq(therapy.status, 'active')))
    .orderBy(therapy.startOn);
  const terapie: PssItem<CdaTherapy>[] = [];
  for (const t of therapies) {
    if (t.reserved) {
      excluded.riservate++;
      continue;
    }
    const route = routeFor(t.route);
    const manca = [
      ...(!t.drugAic && !t.atc ? ['Manca il codice AIC o ATC del farmaco'] : []),
      ...(!route ? ['Scegli la via di somministrazione nella scheda della terapia'] : []),
    ];
    const dosage = [
      t.dose && `${t.dose}${t.doseUnit ? ` ${t.doseUnit}` : ''}`,
      t.frequency,
      t.timeOfDay,
    ]
      .filter(Boolean)
      .join(', ');
    terapie.push({
      id: t.id,
      etichetta: t.drugName,
      incluso: t.kind === 'chronic' && !manca.length,
      manca,
      dati: {
        id: t.id,
        drug: { aic: t.drugAic, atc: t.atc, name: t.drugName, atcName: t.activeIngredient },
        route: route
          ? { code: route.code, display: route.display, label: route.label }
          : { code: '', display: '' },
        startOn: t.startOn,
        endOn: t.endOn,
        status: 'active',
        dosage: dosage || null,
      },
    });
  }

  return {
    sezioni: {
      allergie,
      terapie,
      problemi,
      anamnesiFamiliare,
      parametri,
      stiliDiVita,
      capacitaMotoria,
    },
    assenze: { ...DEFAULT_ABSENCES },
    esclusi: excluded,
    nonInseribili: notInsertable,
  };
}

/** Le scelte del medico su un contenuto nuovo: si tengono quelle sulle voci che ci sono ancora. */
export function keepChoices(fresh: PssContent, previous: PssContent | null): PssContent {
  if (!previous) return fresh;
  const out = structuredClone(fresh);
  for (const key of PSS_SECTION_KEYS) {
    const before = new Map(
      (previous.sezioni[key] as PssItem<unknown>[]).map((i) => [i.id, i.incluso]),
    );
    for (const item of out.sezioni[key] as PssItem<unknown>[]) {
      const was = before.get(item.id);
      if (was !== undefined) item.incluso = was && !item.manca.length;
    }
  }
  out.assenze = { ...previous.assenze };
  return out;
}
