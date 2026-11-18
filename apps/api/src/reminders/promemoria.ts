import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  patient,
  prescription,
  prescriptionLine,
  studio,
  therapy,
} from '../db/schema';
import { HttpError } from '../http/errors';

/**
 * Il promemoria della ricetta SSN, campo per campo come nel modello del DM 2 novembre 2011
 * (allegato 2, «Descrizione dei campi del promemoria»), con le aggiunte delle specifiche del
 * Sistema TS (prescrizione, 5/12/2024: codice di autenticazione, cognome e nome del medico dal SAC)
 * e della Regione Piemonte (SIRPE, «Cartelle cliniche MMG e PLS», 4.4.3: codice regionale e
 * nominativo del medico sotto il codice fiscale). Si fissa all'invio: ogni ristampa è identica.
 *
 * Le posizioni sulla pagina del documento «Specifiche tecniche per la stampa del promemoria»
 * (versione 1/3/2016, citata dalla Regione) non sono state trovate sul portale: da completare.
 */
export interface PromemoriaData {
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

/** Campi 4 e 5 oscurati (DM 2 novembre 2011, allegato 2). */
export const OBSCURED_TEXT = 'OSCURATO AI SENSI DELL’ART 87, COMMA 2, DLG 30 giugno 2003, N.196';

/** Dicitura in fondo al modello (DM 2 novembre 2011, allegato 2). */
export const RELEASE_TEXT = 'Rilasciato ai sensi dell’art 11 comma 16 del DL 78 del 30 maggio 2010';

const ACCESS_TYPE: Record<string, string> = {
  first: 'Primo accesso',
  subsequent: 'Altra tipologia di accesso',
};

/** Dati del promemoria dalla ricetta appena accettata, con il codice di autenticazione. */
export async function buildPromemoriaData(
  db: Database,
  prescriptionId: string,
  accepted: { nre: string; authCode: string; sacDoctorName: string | null; compiledAt: string },
): Promise<PromemoriaData> {
  const [row] = await db
    .select({ p: prescription, pt: patient, st: studio })
    .from(prescription)
    .innerJoin(patient, eq(patient.id, prescription.patientId))
    .innerJoin(studio, eq(studio.id, patient.studioId))
    .where(eq(prescription.id, prescriptionId));
  if (!row) throw new HttpError(404, 'Ricetta non trovata');
  const { p, pt, st } = row;
  if (p.kind !== 'pharma_ssn' && p.kind !== 'specialist_ssn')
    throw new HttpError(409, 'Il promemoria del modello SSN vale per le ricette SSN');
  if (!st.regionName)
    throw new HttpError(
      409,
      'Manca la regione dello studio: serve per l’intestazione del promemoria (DM 2/11/2011, campo 1)',
    );
  const [doctor] = await db
    .select({ name: appUser.displayName, profile: doctorProfile })
    .from(appUser)
    .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
    .where(eq(appUser.id, p.signedBy!));
  if (!doctor?.profile?.fiscalCode)
    throw new HttpError(
      409,
      'Manca il codice fiscale del medico nel profilo: va sul promemoria (DM 2/11/2011, campo 20)',
    );

  const lines = await db
    .select()
    .from(prescriptionLine)
    .where(eq(prescriptionLine.prescriptionId, p.id))
    .orderBy(asc(prescriptionLine.position));
  const therapyIds = lines.map((l) => l.therapyId).filter((x): x is string => !!x);
  const therapies = therapyIds.length
    ? await db
        .select({ id: therapy.id, s: therapy.suggestedS, h: therapy.hospitalH })
        .from(therapy)
        .where(and(inArray(therapy.id, therapyIds), eq(therapy.patientId, pt.id)))
    : [];
  const typology = (therapyId: string | null) => {
    const t = therapies.find((x) => x.id === therapyId);
    return t?.s ? 'S' : t?.h ? 'H' : null;
  };

  const address = [
    [pt.residenceStreet, pt.residenceNumber].filter(Boolean).join(' '),
    [pt.residencePostalCode, pt.residenceTown, pt.residenceProvince && `(${pt.residenceProvince})`]
      .filter(Boolean)
      .join(' '),
  ]
    .filter(Boolean)
    .join(', ');

  return {
    versione: 1,
    tipo: p.kind,
    intestazione: `SERVIZIO SANITARIO NAZIONALE – REGIONE ${st.regionName.toUpperCase()}`,
    nre: accepted.nre,
    codiceAutenticazione: accepted.authCode,
    assistito: {
      codiceFiscale: pt.fiscalCode,
      cognomeNome: p.obscured ? null : `${pt.lastName} ${pt.firstName}`,
      indirizzo: p.obscured ? null : address || null,
      oscurato: p.obscured,
      siglaProvincia: pt.residenceProvince,
      codiceAsl: pt.asl,
    },
    esenzione: p.exemptionCode ?? 'NON ESENTE',
    disposizioniRegionali: null,
    tipoRicetta: null,
    tipoAccesso: p.kind === 'specialist_ssn' && p.accessType ? ACCESS_TYPE[p.accessType]! : null,
    righe: lines.map((l) => ({
      descrizione:
        p.kind === 'specialist_ssn'
          ? [l.serviceDescription, l.serviceCode && `(${l.serviceCode})`].filter(Boolean).join(' ')
          : [
              l.byActiveIngredient ? (l.activeIngredient ?? l.drugName) : l.drugName,
              l.notSubstitutable ? '– NON SOSTITUIBILE' : null,
            ]
              .filter(Boolean)
              .join(' '),
      quantita: l.quantity,
      notaAifa: l.aifaNote,
      tipologia: typology(l.therapyId),
      priorita: p.kind === 'specialist_ssn' ? p.priority : null,
    })),
    numeroConfezioniPrestazioni: lines.reduce((sum, l) => sum + l.quantity, 0),
    diagnosi: { codice: null, descrizione: p.diagnosticQuestion },
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
    dicitura: RELEASE_TEXT,
  };
}
