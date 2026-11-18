import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { date } from './format';
import { readStored, writeStored } from './storage';

/** Quante cartelle si tengono aperte insieme (richiesta di Simone, D68). */
export const MAX_OPEN_RECORDS = 20;
const KEY = 'cartelle-aperte';

export interface OpenRecord {
  id: string;
  lastName: string;
  firstName: string;
  birthDate: string;
  /** L'ultima pagina vista per quel paziente: la scheda riporta lì. */
  lastPath: string;
  /** Ordine d'uso: la più vecchia si chiude quando si supera il massimo. */
  lastUsed: number;
}

interface Stored {
  records: OpenRecord[];
  seq: number;
}

/**
 * Apre una cartella: se c'è già la aggiorna senza spostarla; se si supera il massimo chiude
 * quella usata meno di recente e la restituisce, perché l'interfaccia lo dica.
 */
export function addRecord(
  list: OpenRecord[],
  record: Omit<OpenRecord, 'lastUsed'>,
  seq: number,
  max = MAX_OPEN_RECORDS,
): { list: OpenRecord[]; closed: OpenRecord | null } {
  const existing = list.find((r) => r.id === record.id);
  if (existing) {
    return {
      list: list.map((r) =>
        r.id === record.id ? { ...r, ...record, lastPath: r.lastPath, lastUsed: seq } : r,
      ),
      closed: null,
    };
  }
  let kept = list;
  let closed: OpenRecord | null = null;
  if (list.length >= max) {
    closed = list.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a));
    kept = list.filter((r) => r !== closed);
  }
  return { list: [...kept, { ...record, lastUsed: seq }], closed };
}

/**
 * Nome sulla scheda: cognome e nome per intero (scambiare due pazienti è il rischio vero, D68);
 * se due cartelle aperte hanno lo stesso nome, anche la data di nascita.
 */
export function recordLabel(record: OpenRecord, all: OpenRecord[]): string {
  const name = `${record.lastName} ${record.firstName}`;
  const twins = all.filter((r) => `${r.lastName} ${r.firstName}` === name);
  return twins.length > 1 ? `${name} (${date(record.birthDate)})` : name;
}

interface OpenRecordsApi {
  records: OpenRecord[];
  /** Ultima cartella chiusa perché si è superato il massimo. */
  closedForLimit: OpenRecord | null;
  open: (r: Omit<OpenRecord, 'lastUsed' | 'lastPath'> & { lastPath?: string }) => void;
  visit: (id: string, path: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
}

const Ctx = createContext<OpenRecordsApi | null>(null);

export function OpenRecordsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Stored>(() =>
    readStored<Stored>(KEY, { records: [], seq: 0 }),
  );
  const [closedForLimit, setClosed] = useState<OpenRecord | null>(null);

  const update = useCallback((fn: (s: Stored) => Stored) => {
    setState((prev) => {
      const next = fn(prev);
      writeStored(KEY, next);
      return next;
    });
  }, []);

  const open = useCallback<OpenRecordsApi['open']>(
    (r) =>
      update((s) => {
        const seq = s.seq + 1;
        const { list, closed } = addRecord(
          s.records,
          { ...r, lastPath: r.lastPath ?? `/pazienti/${r.id}` },
          seq,
        );
        if (closed) setClosed(closed);
        return { records: list, seq };
      }),
    [update],
  );

  const visit = useCallback(
    (id: string, path: string) =>
      update((s) =>
        s.records.some((r) => r.id === id)
          ? {
              seq: s.seq + 1,
              records: s.records.map((r) =>
                r.id === id ? { ...r, lastPath: path, lastUsed: s.seq + 1 } : r,
              ),
            }
          : s,
      ),
    [update],
  );

  const close = useCallback(
    (id: string) => update((s) => ({ ...s, records: s.records.filter((r) => r.id !== id) })),
    [update],
  );
  const closeAll = useCallback(() => update((s) => ({ ...s, records: [] })), [update]);

  const value = useMemo(
    () => ({ records: state.records, closedForLimit, open, visit, close, closeAll }),
    [state.records, closedForLimit, open, visit, close, closeAll],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenRecords(): OpenRecordsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useOpenRecords fuori da OpenRecordsProvider');
  return c;
}

/** Il paziente di un percorso /pazienti/:id/…, se c'è. */
export function patientIdOf(pathname: string): string | null {
  return /^\/pazienti\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1] ?? null;
}
