import { useCallback, useEffect, useState } from 'react';

/**
 * Memoria della scheda del browser (sessionStorage): sopravvive al ricaricamento, sparisce quando
 * si chiude la scheda e si svuota all'uscita. Può mancare (navigazione privata, blocchi): allora
 * l'interfaccia funziona lo stesso, senza ricordare.
 */
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Memoria non disponibile: si continua senza.
  }
}

export function removeStored(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // come sopra
  }
}

/** All'uscita dal programma: niente dati dei pazienti resta nel browser. */
export function clearStored(): void {
  try {
    sessionStorage.clear();
  } catch {
    // come sopra
  }
}

/** Stato di un componente ricordato nella memoria della scheda, con la sua chiave. */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => readStored(key, initial));
  // Cambiando chiave (un altro paziente) si legge il suo stato.
  useEffect(() => setValue(readStored(key, initial)), [key]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        writeStored(key, next);
        return next;
      }),
    [key],
  );
  const reset = useCallback(() => {
    removeStored(key);
    setValue(initial);
  }, [key]);
  return [value, set, reset];
}

/**
 * Nome della postazione, ricordato in questo browser anche dopo l'uscita (localStorage). Descrive
 * il computer o il tablet, non una persona né un paziente, e serve alle preferenze di stampa della
 * postazione: senza, quasi tutti gli accessi risulterebbero dalla postazione proposta (D178).
 */
const WORKSTATION_KEY = 'postazione';
export const DEFAULT_WORKSTATION = 'Studio';

export function rememberedWorkstation(): string {
  try {
    const v = localStorage.getItem(WORKSTATION_KEY)?.trim();
    return v ? v : DEFAULT_WORKSTATION;
  } catch {
    return DEFAULT_WORKSTATION;
  }
}

export function rememberWorkstation(name: string): void {
  try {
    const v = name.trim();
    if (v) localStorage.setItem(WORKSTATION_KEY, v);
  } catch {
    // Memoria non disponibile: la prossima volta si propone di nuovo il nome di difetto.
  }
}
