import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { accessLog } from '../db/schema';
import type { Tx } from '../db/tx';
import type { HttpError } from '../http/errors';

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
  | 'lettura_farmaci_prescritti'
  | 'lettura_prestazioni_prescritte'
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
  | 'lettura_ppip'
  | 'nuova_ppip'
  | 'annullamento_ppip'
  | 'distinta_ppip'
  | 'esportazione_distinta_ppip'
  | 'invio_distinta_ppip'
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
  | 'pdf_profilo_sanitario'
  /** Apertura del Fascicolo regionale del paziente dalla cartella (D220). */
  | 'apertura_fascicolo_regionale'
  | 'impostazioni_aft'
  | 'consultazione_aft'
  | 'attivita_aft'
  /** Tappa 14: azioni di amministrazione (dati in `details.area` e `details.azione`, mai segreti). */
  | 'amministrazione'
  | 'cambio_password'
  | 'autorizzazione_archivio'
  | 'revoca_autorizzazione'
  | 'lettura_registro_amministrazione'
  | 'lettura_avvisi_accessi'
  /** Tappa 15: pannello amministrativo del paziente, ricette passate, importazione. */
  | 'nuovo_paziente'
  | 'modifica_dati_amministrativi'
  | 'correzione_identita'
  | 'lettura_dati_amministrativi'
  | 'nuova_esenzione'
  | 'modifica_esenzione'
  | 'nuova_scelta'
  | 'modifica_scelta'
  | 'nuova_ricetta_passata'
  | 'annullamento_ricetta_passata'
  | 'prova_importazione'
  | 'importazione'
  | 'lettura_importazioni'
  /** Tappa 16: blocco del conto dopo i tentativi sbagliati e lettura dei suoi avvisi (D188). */
  | 'conto_bloccato'
  | 'lettura_blocchi'
  /** Tappa 16: ripristino delle credenziali con SPID o CIE (D189). */
  | 'ripristino_avviato'
  | 'ripristino_rifiutato'
  | 'ripristino_riconosciuto'
  | 'ripristino_credenziali'
  /** Esenzioni e scelte lette da AURA, e lettura delle variazioni (D197). */
  | 'aggiornamento_aura'
  | 'lettura_variazioni_aura'
  | 'lettura_nuovi_assistiti_aura'
  | 'nuovo_assistito_non_registrato'
  | 'lettura_cambi_medico'
  | 'spostamento_archivio'
  | 'cambio_medico_non_spostato'
  | 'lettura_riepiloghi'
  | 'esportazione_riepiloghi';

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

/**
 * Un rifiuto con la sua riga del registro (D226). Dentro una transazione la riga non si scrive:
 * tornerebbe indietro con la transazione, e su un'altra connessione aspetterebbe la fine della
 * transazione, se questa ha già scritto nel registro (la catena delle righe si blocca fino alla fine,
 * migrazione 0002). Chi ha aperto la transazione, dopo il ritorno indietro, la scrive con
 * `settleRefusal` e risponde con l'errore.
 */
export class Refusal extends Error {
  constructor(
    readonly error: HttpError,
    readonly entry: AccessEntry,
  ) {
    super(error.message);
  }
}

/** Fuori da ogni transazione: la riga del rifiuto nel registro, poi il suo errore. Gli altri errori come sono. */
export async function settleRefusal(db: Database, err: unknown): Promise<unknown> {
  if (!(err instanceof Refusal)) return err;
  await logAccess(db, err.entry);
  return err.error;
}

/**
 * La stessa riga per molti pazienti, in un solo comando (importazione). La catena del registro
 * (migrazione 0002) mette in fila tutte le righe di tutto il servizio fino al commit: con una
 * richiesta al database per paziente restava presa per secondi, e intanto ogni accesso aspettava
 * (terza revisione dei poteri dell'amministratore). Il trigger della catena è VOLATILE: ogni riga
 * vede le precedenti dello stesso comando, e la catena resta senza buchi.
 */
export async function logAccessForPatients(
  db: Database | Tx,
  patientIds: readonly string[],
  entry: Omit<AccessEntry, 'patientId'>,
): Promise<void> {
  if (patientIds.length === 0) return;
  // Un solo parametro per tutti gli identificativi (uuid letti dal database): nessun limite sul
  // numero dei parametri di un comando.
  const ids = `{${patientIds.join(',')}}`;
  await db.execute(sql`
    insert into access_log (studio_id, user_id, patient_id, action, outcome, workstation, details)
    select ${entry.studioId ?? null}::uuid, ${entry.userId ?? null}::uuid, x.p, ${entry.action},
      ${entry.outcome}, ${entry.workstation ?? null}, ${JSON.stringify(entry.details ?? {})}::jsonb
    from unnest(${ids}::uuid[]) with ordinality as x(p, n)
    order by x.n`);
}

/** Verifica la catena del registro: null se integra, altrimenti il primo numero rotto. */
export async function verifyAccessLog(db: Database): Promise<number | null> {
  const res = await db.execute<{ broken: string | null }>(
    sql`select mmg_access_log_verify()::text as broken`,
  );
  const broken = res.rows[0]?.broken;
  return broken == null ? null : Number(broken);
}
