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
  | 'lettura_registro';

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
