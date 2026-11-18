import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { z } from 'zod';
import { readCsv } from './csv';
import { DATASET_KINDS, type DatasetKind } from './kinds';
import { readXlsx } from './xlsx';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Righe di un file tabellare, secondo l'estensione. */
export function readTable(bytes: Uint8Array, fileName: string): string[][] {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return readCsv(bytes).rows;
  if (ext === '.xlsx') return readXlsx(bytes).rows;
  throw new Error(`formato non importabile: ${ext || 'senza estensione'}`);
}

// --------------------------------------------------------------------------- stato di sync

/**
 * Una voce di stato.json, come la scrive sync/banche_dati.py (elabora_file). I campi in alto
 * descrivono la versione in uso; «in_attesa» una versione nuova che aspetta la verifica a mano.
 */
const syncEntrySchema = z
  .object({
    fonte: z.string(),
    chiave: z.string(),
    url: z.string().optional(),
    nome_originale: z.string().optional(),
    sha256: z.string().optional(),
    byte: z.number().optional(),
    scaricato_il: z.string().optional(),
    /** Ultimo controllo riuscito alla fonte (anche se il file non era cambiato). */
    controllato_il: z.string().optional(),
    righe: z.number().nullable().optional(),
    colonne: z.number().nullable().optional(),
    intestazione: z.array(z.string()).nullable().optional(),
    corrente: z.string().optional(),
    in_attesa: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const syncStateSchema = z.object({
  versione: z.number(),
  file: z.record(z.string(), syncEntrySchema),
});

export type SyncEntry = z.infer<typeof syncEntrySchema>;

/** Legge stato.json nella cartella dei dati di sync. */
export function readSyncState(dir: string): SyncEntry[] {
  const raw: unknown = JSON.parse(readFileSync(join(dir, 'stato.json'), 'utf-8'));
  return Object.values(syncStateSchema.parse(raw).file);
}

/** Esiti di un file nel rapporto di sync (Contesto.esito in sync/banche_dati.py). */
export const SYNC_OUTCOMES = [
  'invariato',
  'nuovo',
  'aggiornato',
  'da_verificare',
  'errore',
  'registrato',
] as const;

const syncReportSchema = z.object({
  versione: z.literal(1),
  banche_dati: z.string(),
  /** Identificativo del giro: distingue il rapporto di questo giro da quello del precedente. */
  giro: z.string(),
  iniziato_il: z.string(),
  finito_il: z.string(),
  /** Le fonti elaborate in quel giro (tutte, o quelle di --solo). */
  fonti: z.array(z.string()),
  righe: z.array(
    z.object({
      fonte: z.string(),
      nome: z.string(),
      esito: z.enum(SYNC_OUTCOMES),
      note: z.array(z.string()),
      righe: z.number().nullable(),
    }),
  ),
});

export type SyncReport = z.infer<typeof syncReportSchema>;

/** Legge ultimo-rapporto.json, il rapporto dell'ultimo giro di sync; null se non c'è. */
export function readSyncReport(dir: string): SyncReport | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'ultimo-rapporto.json'), 'utf-8');
  } catch {
    return null;
  }
  return syncReportSchema.parse(JSON.parse(text));
}

// --------------------------------------------------------------------------- trascrizioni

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Scheda di una trascrizione: chi ha copiato i dati da un PDF, chi li ha controllati, da quale
 * file (con la sua impronta) e da quando valgono. I PDF non si estraggono da soli (A8).
 */
const transcriptionSchema = z
  .object({
    tipo: z.enum(DATASET_KINDS as [DatasetKind, ...DatasetKind[]]),
    /** Versioni successive della stessa tabella (per esempio due determine sul catalogo). */
    serie: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** File d'origine scaricato da sync; tutti e tre, oppure nessuno (atto non scaricabile). */
    fonte: z.string().nullable(),
    chiave: z.string().nullable(),
    sha256_origine: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    atto: z.string().min(1),
    in_vigore_dal: isoDate,
    trascritto_da: z.string().min(1),
    trascritto_il: isoDate,
    controllato_da: z.string().min(1),
    /**
     * Il CSV elenca solo le voci che l'atto aggiunge e toglie, con la colonna «operazione»: la
     * versione intera si ricostruisce dalla versione della serie in vigore il giorno prima (D157).
     */
    solo_modifiche: z.boolean().default(false),
    nota: z.string().optional(),
  })
  .refine((t) => !t.solo_modifiche || t.serie !== undefined, {
    message: 'una trascrizione con solo_modifiche deve dire la serie che modifica',
  })
  .refine(
    (t) =>
      [t.fonte, t.chiave, t.sha256_origine].every((x) => x === null) ||
      [t.fonte, t.chiave, t.sha256_origine].every((x) => x !== null),
    { message: 'fonte, chiave e sha256_origine vanno indicati tutti e tre, oppure nessuno' },
  );

export type Transcription = z.infer<typeof transcriptionSchema>;

export interface TranscriptionFile {
  /** Percorso della scheda JSON, relativo alla cartella delle trascrizioni. */
  path: string;
  sheet: Transcription;
  csvPath: string;
}

/** Trova le schede (.json) con il loro CSV accanto, nella cartella e nelle sottocartelle. */
export function findTranscriptions(dir: string): {
  found: TranscriptionFile[];
  invalid: { path: string; problem: string }[];
} {
  const found: TranscriptionFile[] = [];
  const invalid: { path: string; problem: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) {
        const rel = relative(dir, p);
        const csvPath = p.slice(0, -'.json'.length) + '.csv';
        try {
          statSync(csvPath);
        } catch {
          invalid.push({ path: rel, problem: 'manca il CSV con lo stesso nome' });
          continue;
        }
        const parsed = transcriptionSchema.safeParse(JSON.parse(readFileSync(p, 'utf-8')));
        if (parsed.success) found.push({ path: rel, sheet: parsed.data, csvPath });
        else
          invalid.push({
            path: rel,
            problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
      }
    }
  };
  walk(dir);
  return { found, invalid };
}
