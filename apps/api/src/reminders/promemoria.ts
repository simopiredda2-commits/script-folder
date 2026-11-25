import type { PrescriptionLineMessage, ReceiptMessage } from '@mmg/integrations';
import { specialistValidityDays } from '@mmg/rules';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  patient,
  prescription,
  prescriptionLine,
  refDrugTransparency,
  studio,
  therapy,
} from '../db/schema';
import { HttpError } from '../http/errors';
import { prescriptionTypology } from '../prescriptions/typology';
import { ReferenceData } from '../reference/lookup';

/**
 * Il promemoria della ricetta SSN. Si fissa all'invio, con un numero di versione: ogni ristampa è
 * identica, anche dopo un cambio del modello.
 *
 * - **Versione 2** (dal 20/11/2026, D217): campo per campo come le «Specifiche tecniche per la
 *   stampa del promemoria della ricetta dematerializzata (D.M. 2 novembre 2011)» del Sistema TS,
 *   versione 28/02/2024, che sostituiscono il modello dell'allegato tecnico del DM. I numeri dei
 *   campi sono quelli delle specifiche.
 * - **Versione 1**: il modello del DM 2 novembre 2011 (allegato 2), con le aggiunte delle specifiche
 *   del Sistema TS sulla prescrizione (5/12/2024) e della Regione Piemonte (SIRPED, «Cartelle
 *   cliniche MMG e PLS», V06, 4.3.3). Resta per ristampare i promemoria fissati prima.
 */
export type PromemoriaData = PromemoriaDataV1 | PromemoriaDataV2;

/** Specifiche di stampa del promemoria, versione 28/02/2024. */
export interface PromemoriaDataV2 {
  versione: 2;
  tipo: 'pharma_ssn' | 'specialist_ssn';
  /** Campo 1: la Regione di emissione, come la dice l'intestazione. */
  regione: string;
  /** Campo 2: NRE, a barre in due parti e in chiaro. */
  nre: string;
  /** Campo 26. */
  codiceAutenticazione: string;
  /**
   * Anteprima prima della firma (D253): al posto dell'NRE, che non c'è ancora, «BOZZA – NON
   * VALIDA», senza codici a barre. Mai nei dati fissati all'invio.
   */
  bozza?: true;
  assistito: {
    /** Campo 9: a barre e in chiaro. */
    codiceFiscale: string;
    /** Campi 3–8; null se oscurati su richiesta del paziente o non compilati. */
    cognomeNome: string | null;
    indirizzo: string | null;
    cap: string | null;
    citta: string | null;
    provincia: string | null;
    oscurato: boolean;
    /** Campi 11 e 12. */
    siglaProvincia: string | null;
    codiceAsl: string | null;
  };
  /** Campo 10: il codice, oppure «NON ESENTE». */
  esenzione: string;
  /** Campo 13. */
  disposizioniRegionali: string | null;
  /** Campo 14: «S» (stampato «SUGG») o «H» («RICOV»). */
  tipologia: 'S' | 'H' | null;
  /** Campo 15: «Altro», biffato o con un valore della Regione. */
  altro: string | null;
  /** Campo 16. */
  priorita: 'U' | 'B' | 'D' | 'P' | null;
  /** Ricetta specialistica: giorni di validità ai fini della prenotazione, nell'intestazione. */
  validitaGiorni: number | null;
  /** Campi 17–20 (17A e 18A per la specialistica), una voce per prescrizione. */
  righe: {
    /** Campo 17 o 17A: una o due righe (gruppo di equivalenza e nome commerciale). */
    prescrizione: string[];
    /** Campo 18 o 18A; null se non c'è niente da stampare. */
    dettagli: string | null;
    /** Campo 19. */
    quantita: number;
    /** Campo 20: la nota, oppure «---». */
    nota: string;
  }[];
  /** Farmaci in DPC: la frase del messaggio 0196 della ricevuta, sotto l'ultima prescrizione. */
  fraseDpc: string | null;
  /** Campo 21. */
  quesitoDiagnostico: string | null;
  /** Campo 22: somma delle quantità. */
  numeroConfezioniPrestazioni: number;
  /** Campo 23. */
  tipoRicetta: string | null;
  /** Assicurati da istituzioni estere: i dati che il programma conosce (facsimile 4). */
  esteri: { tessera: string | null; istituzione: string | null } | null;
  /** Campo 24: data di compilazione, AAAA-MM-GG. */
  data: string;
  medico: {
    /** Campo 25. */
    codiceFiscale: string;
    /** Regione Piemonte (SIRPED, «Cartelle cliniche MMG e PLS», V06, 4.3.3): davanti al nome, nel campo 27. */
    codiceRegionale: string | null;
    /** Campo 27: come lo restituisce il SAC; se manca, il nome nel programma. */
    nominativo: string;
  };
  dicitura: string;
  /** Campo 28: la frase di interesse sanitario della Regione, se c'è. */
  fraseRegionale: string | null;
}

/** DM 2 novembre 2011, allegato 2: i promemoria fissati prima del 20/11/2026. */
export interface PromemoriaDataV1 {
  versione: 1;
  tipo: 'pharma_ssn' | 'specialist_ssn';
  /** Campo 1. */
  intestazione: string;
  /** Campo 2: NRE, a barre e in chiaro. */
  nre: string;
  codiceAutenticazione: string;
  assistito: {
    /** Campi 3 e 3 bis. */
    codiceFiscale: string;
    /** Campo 4; null se oscurato su richiesta del paziente. */
    cognomeNome: string | null;
    /** Campo 5; null se oscurato. */
    indirizzo: string | null;
    oscurato: boolean;
    /** Campo 6. */
    siglaProvincia: string | null;
    codiceAsl: string | null;
  };
  /** Campo 7: il codice, oppure «NON ESENTE». */
  esenzione: string;
  /** Campo 8. */
  disposizioniRegionali: string | null;
  /** Campo 9: vuoto per gli assistiti SSN residenti. */
  tipoRicetta: string | null;
  /** Ricetta specialistica: «Primo accesso» o «Altra tipologia di accesso» (D79). */
  tipoAccesso: string | null;
  /** Campi 10–14. */
  righe: {
    descrizione: string;
    quantita: number;
    notaAifa: string | null;
    tipologia: 'S' | 'H' | null;
    priorita: string | null;
  }[];
  /** Campo 15: somma delle quantità. */
  numeroConfezioniPrestazioni: number;
  /** Campi 16 e 17. */
  diagnosi: { codice: string | null; descrizione: string | null };
  /** Campo 18, solo per gli assicurati da istituzioni estere. */
  esteri: { tessera: string | null; istituzione: string | null } | null;
  /** Campo 19: data di compilazione. */
  data: string;
  medico: {
    /** Campo 20. */
    codiceFiscale: string;
    codiceRegionale: string | null;
    /** Come lo restituisce il SAC; se manca, il nome nel programma. */
    nominativo: string;
  };
  dicitura: string;
}

/** Versione 1: campi 4 e 5 oscurati (DM 2 novembre 2011, allegato 2). */
export const OBSCURED_TEXT = 'OSCURATO AI SENSI DELL’ART 87, COMMA 2, DLG 30 giugno 2003, N.196';

/** Versione 1: dicitura in fondo al modello (DM 2 novembre 2011, allegato 2). */
export const RELEASE_TEXT = 'Rilasciato ai sensi dell’art 11 comma 16 del DL 78 del 30 maggio 2010';

/** Versione 2: al posto dei campi 3–8 oscurati (specifiche del 28/02/2024, campo 3). */
export const OBSCURED_TEXT_2024 =
  'DATI DELL’ASSISTITO OSCURATI AI SENSI DELL’ARTICOLO 87 DEL DL 30 giugno 2003, n. 196';

/** Versione 2: dicitura in fondo al modello (specifiche del 28/02/2024). */
export const RELEASE_TEXT_2024 =
  'Rilasciato ai sensi dell’art.11, comma 16 del DL 31 mag 2010,n.78 e dell’art.1, comma 4 del DM 2 nov 2011';

/** Campo 10 senza codice di esenzione. */
export const NOT_EXEMPT = 'NON ESENTE';

/** Al posto dell'NRE nell'anteprima prima della firma (D253). */
export const DRAFT_TEXT = 'BOZZA – NON VALIDA';

/** Campo 20 vuoto: la nota non si può compilare (specifiche del 28/02/2024). */
export const NO_NOTE = '---';

/** Campo 23 per gli assistiti del SSN: il medico non lo compila, la stampa lo riporta. */
export const SSN_RECIPE_TYPE = 'Assist. SSN';

/**
 * Validità della ricetta specialistica ai fini della prenotazione, nell'intestazione della
 * prescrizione: 180 giorni, o meno se la Regione lo ha comunicato al Sistema TS (specifiche del
 * 28/02/2024, 2.1). Per il Piemonte i giorni vengono dalla regola R1 in vigore alla data della
 * ricetta, secondo il tipo di accesso (D.D. 710/2026, punto 4; D260); questo valore resta per le
 * versioni delle regole che non li hanno. Che la Regione li abbia comunicati al Sistema TS si
 * vede al collaudo.
 */
export const SPECIALIST_VALIDITY_DAYS = 180;

/** Campo 14. */
export const TYPOLOGY_TEXT = { S: 'SUGG', H: 'RICOV' } as const;

/** Campo 16. */
export const PRIORITY_TEXT = {
  U: 'Nel più breve tempo possibile; se differibile entro 72 ore',
  B: 'Entro 10 giorni',
  D: 'Entro 30 (visite), entro 60 gg (visite strumentali)',
  P: 'Programmabile',
} as const;

/** Campo 18A: la tipologia di accesso, coerente con il PNGLA. */
export const ACCESS_TEXT_2024 = {
  first: 'PRIMO ACCESSO',
  subsequent: 'ALTRA TIPOLOGIA DI ACCESSO',
} as const;

/** Campo 18: farmaco non sostituibile. */
export const NOT_SUBSTITUTABLE_TEXT = 'NON SOSTITUIBILE';

/** Codice del messaggio della ricevuta con la frase sui farmaci in DPC. */
export const DPC_MESSAGE_CODE = '0196';

/** Campo 1: «REGIONE PIEMONTE»; una Provincia autonoma resta com'è scritta. */
export function regionHeading(regionName: string): string {
  const name = regionName.trim().toUpperCase();
  return /^(REGIONE|PROVINCIA)\b/.test(name) ? name : `REGIONE ${name}`;
}

/**
 * Gruppo di equivalenza di ogni AIC secondo la lista di trasparenza AIFA in vigore alla data:
 * codice e denominazione, cioè principio attivo e confezione di riferimento, le colonne che nella
 * lista definiscono il gruppo. Senza la lista, o fuori dalla lista, niente.
 */
async function equivalenceGroups(
  db: Database,
  aics: readonly string[],
  date: string,
): Promise<Map<string, string>> {
  const wanted = [...new Set(aics.filter(Boolean))];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const ids = (await new ReferenceData(db).inEffect('farmaci_trasparenza', date)).map((d) => d.id);
  if (!ids.length) return out;
  const rows = await db
    .select({
      aic: refDrugTransparency.aic,
      activeIngredient: refDrugTransparency.activeIngredient,
      referencePack: refDrugTransparency.referencePack,
      group: refDrugTransparency.equivalenceGroup,
    })
    .from(refDrugTransparency)
    .where(
      and(inArray(refDrugTransparency.datasetId, ids), inArray(refDrugTransparency.aic, wanted)),
    )
    .orderBy(asc(refDrugTransparency.aic), asc(refDrugTransparency.id));
  for (const r of rows) {
    if (!r.group || out.has(r.aic)) continue;
    const name = [r.activeIngredient?.toUpperCase(), r.referencePack].filter(Boolean).join(' ');
    out.set(r.aic, name ? `${r.group} - ${name}` : r.group);
  }
  return out;
}

/**
 * Dati del promemoria dalla ricetta appena accettata, con il codice di autenticazione e i messaggi
 * della ricevuta. Le righe della specialistica usano i codici proprio come sono partiti (`sent`):
 * il codice del nomenclatore può venire dal catalogo regionale al momento dell'invio (D154).
 */
/** I dati del paziente che vanno sul promemoria: fotografati alla firma per l'esito a mano (D239). */
export type PromemoriaPatient = Pick<
  typeof patient.$inferSelect,
  | 'fiscalCode'
  | 'lastName'
  | 'firstName'
  | 'residenceStreet'
  | 'residenceNumber'
  | 'residencePostalCode'
  | 'residenceTown'
  | 'residenceProvince'
  | 'asl'
  | 'foreignHealthCard'
  | 'foreignInstitution'
>;

export function promemoriaPatientOf(pt: typeof patient.$inferSelect): PromemoriaPatient {
  return {
    fiscalCode: pt.fiscalCode,
    lastName: pt.lastName,
    firstName: pt.firstName,
    residenceStreet: pt.residenceStreet,
    residenceNumber: pt.residenceNumber,
    residencePostalCode: pt.residencePostalCode,
    residenceTown: pt.residenceTown,
    residenceProvince: pt.residenceProvince,
    asl: pt.asl,
    foreignHealthCard: pt.foreignHealthCard,
    foreignInstitution: pt.foreignInstitution,
  };
}

export async function buildPromemoriaData(
  db: Database,
  prescriptionId: string,
  accepted: {
    nre: string;
    authCode: string;
    sacDoctorName: string | null;
    compiledAt: string;
    messages?: readonly ReceiptMessage[] | null;
  },
  sent?: readonly PrescriptionLineMessage[],
  /** Il paziente com'era alla firma, per l'esito segnato a mano (D239); altrimenti com'è ora. */
  patientAt?: PromemoriaPatient | null,
  /** Il medico del promemoria se la ricetta non è ancora firmata: l'anteprima (D253). */
  doctorId?: string,
  /**
   * La tipologia S o H partita con la ricetta (indicazionePrescr, D273); assente per le ricette
   * partite prima, e allora si legge dalle terapie.
   */
  sentIndication?: 'S' | 'H' | null,
): Promise<PromemoriaDataV2> {
  const [row] = await db
    .select({ p: prescription, pt: patient, st: studio })
    .from(prescription)
    .innerJoin(patient, eq(patient.id, prescription.patientId))
    .innerJoin(studio, eq(studio.id, patient.studioId))
    .where(eq(prescription.id, prescriptionId));
  if (!row) throw new HttpError(404, 'Ricetta non trovata');
  const { p, st } = row;
  const pt = patientAt ? { ...row.pt, ...patientAt } : row.pt;
  if (p.kind !== 'pharma_ssn' && p.kind !== 'specialist_ssn')
    throw new HttpError(409, 'Il promemoria del modello SSN vale per le ricette SSN');
  if (!st.regionName)
    throw new HttpError(
      409,
      'Manca la regione dello studio: serve per l’intestazione del promemoria (campo 1)',
    );
  const [doctor] = await db
    .select({ name: appUser.displayName, profile: doctorProfile })
    .from(appUser)
    .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
    .where(eq(appUser.id, doctorId ?? p.signedBy!));
  if (!doctor?.profile?.fiscalCode)
    throw new HttpError(
      409,
      'Manca il codice fiscale del medico nel profilo: va sul promemoria (campo 25)',
    );

  const lines = await db
    .select()
    .from(prescriptionLine)
    .where(eq(prescriptionLine.prescriptionId, p.id))
    .orderBy(asc(prescriptionLine.position));
  const therapyIds = lines.map((l) => l.therapyId).filter((x): x is string => !!x);
  const therapies = therapyIds.length
    ? await db
        .select({ id: therapy.id, suggestedS: therapy.suggestedS, hospitalH: therapy.hospitalH })
        .from(therapy)
        .where(and(inArray(therapy.id, therapyIds), eq(therapy.patientId, pt.id)))
    : [];
  // Campo 14, uno per ricetta: la tipologia c'è se tutte le prescrizioni la hanno uguale. Se la
  // ricetta è partita con indicazionePrescr, vale quella partita (D273).
  const tipologia =
    sentIndication !== undefined ? sentIndication : prescriptionTypology(lines, therapies);

  const specialist = p.kind === 'specialist_ssn';
  const groups = specialist
    ? new Map<string, string>()
    : await equivalenceGroups(
        db,
        lines.map((l) => l.drugAic ?? ''),
        accepted.compiledAt,
      );
  const accessText = specialist && p.accessType ? ACCESS_TEXT_2024[p.accessType] : null;

  const righe = lines.map((l, i) => {
    if (specialist) {
      const nationalCode = sent?.[i]?.serviceNationalCode ?? l.serviceNationalCode;
      const codes = [nationalCode, l.serviceCode && `(${l.serviceCode})`].filter(Boolean).join(' ');
      const description = l.serviceDescription ?? '';
      return {
        // 17A: codice nomenclatore (codice catalogo) – descrizione del catalogo.
        prescrizione: [codes && description ? `${codes} – ${description}` : codes || description],
        // 18A: tipologia di accesso; ambulatorio, televisita, note e sedute non sono nella ricetta.
        dettagli: accessText,
        quantita: l.quantity,
        // 20: le note del DM 9/12/2015 non sono nella ricetta.
        nota: NO_NOTE,
      };
    }
    const group = l.drugAic ? (groups.get(l.drugAic) ?? null) : null;
    // AIC e nome; senza il nome, almeno l'AIC che è partito al SAR: mai una riga vuota (D232).
    const product = [l.drugAic, l.drugName].filter(Boolean).join(' - ') || null;
    // 17: gruppo di equivalenza e nome commerciale; per principio attivo solo il gruppo.
    const prescrizione = l.byActiveIngredient
      ? [group ?? l.activeIngredient ?? l.drugName ?? l.drugAic ?? '']
      : [group, product ?? ''].filter((x): x is string => x !== null);
    // Le note partite con la ricetta (motivazNote): per la terapia del dolore posologia e
    // telefono del medico, che vanno stampati sul promemoria («Nota STUP», D272).
    const notes = sent?.[i]?.notes?.trim() || null;
    // «NON SOSTITUIBILE» e la motivazione «scritta o codificata» (specifiche di stampa, campo 18):
    // il codice delle linee guida e, se c'è, la precisazione del medico (D273).
    const notSubstitutable = l.notSubstitutable
      ? [
          NOT_SUBSTITUTABLE_TEXT,
          l.notSubstitutableCode?.trim() ? `motivazione ${l.notSubstitutableCode.trim()}` : null,
          l.notSubstitutableReason?.trim(),
        ]
          .filter(Boolean)
          .join(' - ')
      : null;
    return {
      prescrizione,
      dettagli: [notSubstitutable, notes].filter(Boolean).join(' · ') || null,
      quantita: l.quantity,
      nota: l.aifaNote?.trim() || NO_NOTE,
    };
  });

  const street = [pt.residenceStreet, pt.residenceNumber].filter(Boolean).join(' ');
  const obscured = p.obscured;
  return {
    versione: 2,
    tipo: p.kind,
    regione: regionHeading(st.regionName),
    nre: accepted.nre,
    codiceAutenticazione: accepted.authCode,
    assistito: {
      codiceFiscale: pt.fiscalCode,
      cognomeNome: obscured ? null : `${pt.lastName} ${pt.firstName}`,
      indirizzo: obscured ? null : street || null,
      cap: obscured ? null : pt.residencePostalCode,
      citta: obscured ? null : pt.residenceTown,
      provincia: obscured ? null : pt.residenceProvince,
      oscurato: obscured,
      siglaProvincia: pt.residenceProvince,
      codiceAsl: pt.asl,
    },
    esenzione: p.exemptionCode ?? NOT_EXEMPT,
    disposizioniRegionali: null,
    tipologia,
    altro: null,
    priorita: specialist ? p.priority : null,
    validitaGiorni: specialist
      ? ((p.accessType && specialistValidityDays(accepted.compiledAt, p.accessType)) ??
        SPECIALIST_VALIDITY_DAYS)
      : null,
    righe,
    fraseDpc: accepted.messages?.find((m) => m.code === DPC_MESSAGE_CODE)?.text.trim() || null,
    quesitoDiagnostico: p.diagnosticQuestion,
    numeroConfezioniPrestazioni: lines.reduce((sum, l) => sum + l.quantity, 0),
    // La ricetta parte come ricetta di un assistito del SSN: gli altri tipi (UE, EE, ST, NA…)
    // non sono nel messaggio di invio, da completare con l'adattatore vero.
    tipoRicetta: SSN_RECIPE_TYPE,
    esteri:
      pt.foreignHealthCard || pt.foreignInstitution
        ? { tessera: pt.foreignHealthCard, istituzione: pt.foreignInstitution }
        : null,
    data: accepted.compiledAt,
    medico: {
      codiceFiscale: doctor.profile.fiscalCode,
      codiceRegionale: doctor.profile.regionalCode,
      nominativo: accepted.sacDoctorName ?? doctor.name,
    },
    dicitura: RELEASE_TEXT_2024,
    fraseRegionale: null,
  };
}

/**
 * L'anteprima del promemoria prima della firma (D253): gli stessi dati del promemoria vero, dalla
 * ricetta com'è ora e con il medico che la firmerà, ma con «BOZZA – NON VALIDA» al posto dell'NRE
 * e senza codice di autenticazione. Non si salva: si rifà a ogni richiesta.
 */
export async function buildPromemoriaPreview(
  db: Database,
  prescriptionId: string,
  doctorId: string,
  date: string,
): Promise<PromemoriaDataV2> {
  const data = await buildPromemoriaData(
    db,
    prescriptionId,
    { nre: DRAFT_TEXT, authCode: '—', sacDoctorName: null, compiledAt: date },
    undefined,
    null,
    doctorId,
  );
  return { ...data, bozza: true };
}
