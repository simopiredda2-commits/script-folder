import { MAX_UPLOAD_BYTES_IN_MEMORY, MAX_UPLOADS_PER_USER, UPLOAD_TTL_MS } from './limits';
import type { ReadFile } from './table';

/**
 * File caricati, tenuti in memoria tra il caricamento e l'importazione (tappa 15). Il file si
 * carica una volta; mappatura, anteprima, prova e importazione lavorano sulle tabelle lette. Il
 * contenuto non va mai nel database: dopo l'importazione, o dopo un'ora, si dimentica; nella storia
 * restano nome, impronta e dimensione. Un riavvio del servizio lo dimentica: si ricarica il file.
 * Con più istanze del servizio il file sta in quella che l'ha ricevuto (da rivedere allora).
 */

export interface StoredUpload {
  batchId: string;
  archiveId: string;
  userId: string;
  file: ReadFile;
  /** Dimensione del file caricato, per il tetto della memoria. */
  size: number;
  expiresAt: number;
}

export class UploadStore {
  private readonly items = new Map<string, StoredUpload>();
  constructor(private readonly now: () => Date) {}

  private sweep() {
    const t = this.now().getTime();
    for (const [k, v] of this.items) if (v.expiresAt <= t) this.items.delete(k);
  }

  private total() {
    let n = 0;
    for (const v of this.items.values()) n += v.size;
    return n;
  }

  put(u: Omit<StoredUpload, 'expiresAt'>): void {
    this.sweep();
    // Di ogni utente restano gli ultimi file caricati; poi, per la memoria del servizio, esce il
    // più vecchio di tutti finché il nuovo ci sta.
    const own = [...this.items.values()].filter((v) => v.userId === u.userId);
    for (const old of own.slice(0, Math.max(0, own.length - (MAX_UPLOADS_PER_USER - 1))))
      this.items.delete(old.batchId);
    while (this.items.size > 0 && this.total() + u.size > MAX_UPLOAD_BYTES_IN_MEMORY) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    this.items.set(u.batchId, { ...u, expiresAt: this.now().getTime() + UPLOAD_TTL_MS });
  }

  /** Il file di un'importazione, solo per chi l'ha caricato. */
  get(batchId: string, userId: string): StoredUpload | undefined {
    this.sweep();
    const u = this.items.get(batchId);
    return u && u.userId === userId ? u : undefined;
  }

  delete(batchId: string): void {
    this.items.delete(batchId);
  }
}
