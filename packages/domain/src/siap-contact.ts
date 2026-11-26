import { CONTACT_MODE_OF_DIARY } from './siap';
import type { ContactAccessType, ContactMode, ProblemState } from './siap';

/**
 * Il contatto del SIAP ricavato dagli atti del medico (D291): per un paziente, un medico e un
 * giorno, la proposta di modalità, tipologia di accesso, stato del problema e attività e
 * prestazioni con tipologia, dettaglio e quantità (specifiche funzionali del Ministero 1.3,
 * § 3.9.2, allegato 2). È una proposta: il medico la cambia, la conferma o la scarta. I codici
 * di tipologia e dettaglio sono quelli dell'allegato 2, controllati con la trascrizione.
 */

/** Il tipo di contatto di una nota del diario. */
export type DiaryContactType = keyof typeof CONTACT_MODE_OF_DIARY;

/** Un atto del medico che entra nel contatto: tipo, identificativo e quel che serve a classificarlo. */
export type SiapAct =
  | { kind: 'diary'; id: string; contactType: DiaryContactType }
  /** Ricetta farmaceutica: se ha righe di una terapia continuativa in corso, e righe nuove. */
  | { kind: 'pharma'; id: string; continuing: boolean; newDrugs: boolean }
  /** Ricetta specialistica: se ha visite, e altre prestazioni. */
  | { kind: 'specialist'; id: string; visits: boolean; others: boolean }
  | { kind: 'sick_leave'; id: string }
  /** Certificato dai modelli: se è l'idoneità sportiva non agonistica. */
  | { kind: 'certificate'; id: string; sport: boolean }
  /** Vaccinazione: se è stagionale (influenza o COVID) e l'età del paziente quel giorno. */
  | { kind: 'vaccination'; id: string; seasonal: boolean; ageYears: number }
  /** Prestazione aggiuntiva, con il dettaglio della corrispondenza con l'ACN. */
  | { kind: 'ppip'; id: string; detail: number }
  /** Scelta del medico che comincia quel giorno: la presa in carico. */
  | { kind: 'choice'; id: string };

export type SiapActKind = SiapAct['kind'];

/** Un'attività del contatto: tipologia e dettaglio dell'allegato 2, quantità. */
export interface SiapService {
  tipologia: number;
  dettaglio: number;
  quantita: number;
}

/** Il campo della quantità ha una cifra (§ 3.9.2, campo 16). */
export const SIAP_MAX_QUANTITY = 9;

/**
 * Il codice generico del problema quando non c'è un problema emergente (§ 3.9.2, campo 11:
 * l'esempio del Ministero è «V70 esame medico generale»; nell'elenco ICD-9-CM il codice è V70.0).
 */
export const SIAP_GENERIC_PROBLEM = 'V70.0';

/** Tipologie e dettagli dell'allegato 2 usati dalla proposta, con il loro nome nel documento. */
export const SIAP_ACT_SERVICES = {
  /** 0 Censimento, 1 Presa in carico iniziale paziente. */
  presaInCarico: { tipologia: 0, dettaglio: 1 },
  /** 1 Visite, 2 Visita di controllo. */
  visitaDiControllo: { tipologia: 1, dettaglio: 2 },
  /** 1 Visite, 4 Altro. */
  visitaAltro: { tipologia: 1, dettaglio: 4 },
  /** 5 PIPP: il dettaglio viene dalla corrispondenza con l'ACN. */
  pipp: { tipologia: 5 },
  /** 6 Certificati, 1 Malattia. */
  certificatoMalattia: { tipologia: 6, dettaglio: 1 },
  /** 6 Certificati, 3 Idoneità svolgimento attività sportive non agonistiche. */
  certificatoSportivo: { tipologia: 6, dettaglio: 3 },
  /** 6 Certificati, 7 Altro. */
  certificatoAltro: { tipologia: 6, dettaglio: 7 },
  /** 7 Vaccinazioni: 1 stagionali, 2 dell'infanzia, 3 dell'adolescenza, 4 dell'età adulta. */
  vaccinazioneStagionale: { tipologia: 7, dettaglio: 1 },
  vaccinazioneInfanzia: { tipologia: 7, dettaglio: 2 },
  vaccinazioneAdolescenza: { tipologia: 7, dettaglio: 3 },
  vaccinazioneAdulta: { tipologia: 7, dettaglio: 4 },
  /** 8 Prescrizioni farmaceutiche: 1 rinnovo farmaci continuativi, 2 nuovi farmaci. */
  rinnovoFarmaci: { tipologia: 8, dettaglio: 1 },
  nuoviFarmaci: { tipologia: 8, dettaglio: 2 },
  /** 9 Prescrizioni di specialistica: 1 visite specialistiche, 2 esami diagnostici. */
  visiteSpecialistiche: { tipologia: 9, dettaglio: 1 },
  esamiDiagnostici: { tipologia: 9, dettaglio: 2 },
} as const;

/** Età sotto la quale una vaccinazione non stagionale è dell'infanzia, e dell'adolescenza (D291). */
export const SIAP_VACCINATION_AGES = { infanzia: 12, adolescenza: 18 } as const;

type Pair = { tipologia: number; dettaglio: number };

/** Le attività di un atto: una o due, secondo che cosa contiene. */
export function servicesOfAct(act: SiapAct): Pair[] {
  const s = SIAP_ACT_SERVICES;
  switch (act.kind) {
    case 'diary':
      return [act.contactType === 'phone' ? s.visitaAltro : s.visitaDiControllo];
    case 'pharma':
      return [
        ...(act.continuing ? [s.rinnovoFarmaci] : []),
        ...(act.newDrugs || !act.continuing ? [s.nuoviFarmaci] : []),
      ];
    case 'specialist':
      return [
        ...(act.visits ? [s.visiteSpecialistiche] : []),
        ...(act.others || !act.visits ? [s.esamiDiagnostici] : []),
      ];
    case 'sick_leave':
      return [s.certificatoMalattia];
    case 'certificate':
      return [act.sport ? s.certificatoSportivo : s.certificatoAltro];
    case 'vaccination':
      if (act.seasonal) return [s.vaccinazioneStagionale];
      if (act.ageYears < SIAP_VACCINATION_AGES.infanzia) return [s.vaccinazioneInfanzia];
      if (act.ageYears < SIAP_VACCINATION_AGES.adolescenza) return [s.vaccinazioneAdolescenza];
      return [s.vaccinazioneAdulta];
    case 'ppip':
      return [{ tipologia: s.pipp.tipologia, dettaglio: act.detail }];
    case 'choice':
      return [s.presaInCarico];
  }
}

/**
 * Le attività e prestazioni del contatto: una per tipologia e dettaglio, con quanti atti le hanno,
 * al più 9. In ordine di tipologia e dettaglio, come nel tracciato.
 */
export function servicesOf(acts: readonly SiapAct[]): SiapService[] {
  const counts = new Map<string, SiapService>();
  for (const act of acts)
    for (const p of servicesOfAct(act)) {
      const key = `${p.tipologia}.${p.dettaglio}`;
      const found = counts.get(key);
      if (found) found.quantita = Math.min(SIAP_MAX_QUANTITY, found.quantita + 1);
      else counts.set(key, { ...p, quantita: 1 });
    }
  return [...counts.values()].sort(
    (a, b) => a.tipologia - b.tipologia || a.dettaglio - b.dettaglio,
  );
}

/** Con più note del diario nel giorno vale la prima di queste (D291). */
const MODE_ORDER: readonly DiaryContactType[] = ['home', 'office', 'televisit', 'phone'];

/** La modalità del contatto dalle note del diario; senza note, «non noto». */
export function modeOf(acts: readonly SiapAct[]): ContactMode {
  const types = new Set(acts.flatMap((a) => (a.kind === 'diary' ? [a.contactType] : [])));
  const first = MODE_ORDER.find((t) => types.has(t));
  return first ? CONTACT_MODE_OF_DIARY[first] : 'unknown';
}

/**
 * La tipologia di accesso: programmato con un appuntamento quel giorno, diretto con una nota del
 * diario senza appuntamento, altrimenti non noto (D291, da confermare).
 */
export function accessTypeOf(acts: readonly SiapAct[], hasAppointment: boolean): ContactAccessType {
  if (hasAppointment) return 'scheduled';
  return acts.some((a) => a.kind === 'diary') ? 'direct' : 'unknown';
}

/**
 * Lo stato del problema scelto dal medico: sospetto con il quesito aperto, associato alla
 * patologia cronica se cronico, in evoluzione negli altri casi; senza problema, non noto (D291).
 */
export function problemStateOf(
  problem: { openQuestion: boolean; chronic: boolean } | null,
): ProblemState {
  if (!problem) return 'unknown';
  if (problem.openQuestion) return 'suspected';
  if (problem.chronic) return 'chronic';
  return 'evolving';
}

/** La proposta di un contatto dagli atti del giorno. */
export function proposeContact(acts: readonly SiapAct[], hasAppointment: boolean) {
  return {
    modalita: modeOf(acts),
    regime: 'choice' as const,
    accesso: accessTypeOf(acts, hasAppointment),
    problema: SIAP_GENERIC_PROBLEM,
    statoProblema: problemStateOf(null),
    prestazioni: servicesOf(acts),
  };
}
