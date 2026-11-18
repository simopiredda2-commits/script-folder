import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { accessLog } from '../db/schema';
import type { Tx } from '../db/tx';

/** Azioni registrate. Le parole sono in italiano: il registro lo legge il medico. */
export type AccessAction =
  | 'accesso'
  | 'accesso_fallito'
  | 'secondo_fattore_fallito'
  | 'secondo_fattore_attivato'
  | 'uscita'
  | 'sessione_bloccata'
  | 'sessione_sbloccata'
  | 'apertura_cartella'
  | 'lettura_diario'
  | 'lettura_terapie'
  | 'modifica_anagrafica'
  | 'esportazione'
  | 'impostazioni_archivio'
  | 'ricetta_bozza'
  | 'ricetta_ripetizione'
  | 'ricetta_da_firmare'
  | 'ricetta_modifica'
  | 'ricetta_firma_invio'
  | 'ricetta_annullamento'
  | 'ricetta_cartacea'
  | 'lettura_ricette'
  | 'ricetta_controllo'
  | 'lettura_registro'
  | 'lettura_storico_prescrizioni'
  | 'lettura_cronologia'
  | 'lettura_esami'
  | 'ricetta_stato'
  | 'nuova_terapia'
  | 'modifica_terapia'
  | 'sospensione_terapia'
  | 'stampa_promemoria'
  | 'invio_promemoria'
  | 'lettura_consegne_promemoria'
  | 'lettura_recapiti_promemoria'
  | 'lettura_certificati'
  | 'certificato_bozza'
  | 'certificato_modifica'
  | 'certificato_controllo'
  | 'certificato_invio'
  | 'certificato_rettifica'
  | 'certificato_annullamento'
  | 'stampa_certificato'
  | 'consegna_certificato'
  | 'lettura_consegne_certificato'
  | 'lettura_voci'
  | 'nuova_voce'
  | 'modifica_voce'
  | 'annullamento_voce'
  | 'nuovi_parametri'
  | 'lettura_parametri'
  | 'lettura_privacy'
  | 'nuovo_consenso'
  | 'revoca_consenso'
  | 'nuova_delega'
  | 'revoca_delega'
  | 'lettura_piani'
  | 'nuovo_piano'
  | 'modifica_piano'
  | 'annullamento_piano'
  | 'lettura_seguito'
  | 'nuova_esecuzione'
  | 'annullamento_esecuzione'
  | 'lettura_allegato'
  | 'lettura_presidi'
  | 'nuovo_presidio'
  | 'rinnovo_presidio'
  | 'annullamento_presidio'
  | 'lettura_profilo_sanitario'
  | 'bozza_profilo_sanitario'
  | 'validazione_profilo_sanitario'
  | 'pubblicazione_profilo_sanitario'
  | 'stato_profilo_sanitario'
  | 'lettura_certificati_modelli'
  | 'anteprima_certificato_modello'
  | 'rilascio_certificato_modello'
  | 'stampa_certificato_modello'
  | 'annullamento_certificato_modello'
  | 'scarto_profilo_sanitario'
  | 'pdf_profilo_sanitario';

export interface AccessEntry {
  studioId?: string | null;
  userId?: string | null;
  patientId?: string | null;
  action: AccessAction;
  outcome: 'consentito' | 'negato' | 'riuscito' | 'fallito';
  workstation?: string | null;
  details?: Record<string, unknown>;
}

/** Scrive una riga del registro. Numero e impronte li assegna il database. */
export async function logAccess(db: Database | Tx, entry: AccessEntry): Promise<void> {
  await db.insert(accessLog).values({
    studioId: entry.studioId ?? null,
    userId: entry.userId ?? null,
    patientId: entry.patientId ?? null,
    action: entry.action,
    outcome: entry.outcome,
    workstation: entry.workstation ?? null,
    details: entry.details ?? {},
  });
}

/** Verifica la catena del registro: null se integra, altrimenti il primo numero rotto. */
export async function verifyAccessLog(db: Database): Promise<number | null> {
  const res = await db.execute<{ broken: string | null }>(
    sql`select mmg_access_log_verify()::text as broken`,
  );
  const broken = res.rows[0]?.broken;
  return broken == null ? null : Number(broken);
}
