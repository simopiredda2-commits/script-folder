import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Icon } from './Icon';

/** I documenti che il programma stampa (stesse chiavi di `PRINT_DOCUMENT_KEYS` in @mmg/domain). */
export type PrintKind =
  | 'promemoria'
  | 'promemoria_bianca'
  | 'certificato_inps'
  | 'certificato_modello'
  | 'schema_orario'
  | 'profilo_sanitario';

export type PrintSource = 'postazione' | 'studio' | 'predefinito';

/** Le preferenze che valgono per un documento alla postazione della sessione. */
export interface EffectivePrint {
  tipo: PrintKind;
  nome: string;
  uscita: 'pdf' | 'pagina';
  /** Null: nessuna stampante consigliata, vale quella proposta dalla finestra di stampa. */
  stampante: string | null;
  copie: number;
  carta: 'A4' | 'A5' | null;
  cartaScelta: boolean;
  variante: 'completo' | 'solo_nre' | null;
  da: Record<'stampante' | 'copie' | 'carta' | 'variante', PrintSource>;
  /** Il testo accanto ai pulsanti di stampa; null se nessuno ha impostato nulla. */
  suggerimento: string | null;
}

export interface PrintPreferences {
  postazione: { scritta: string; riconosciuta: { id: string; nome: string } | null };
  preferenze: EffectivePrint[];
}

/**
 * Una lettura sola per pagina: accanto a ogni certificato o promemoria c'è lo stesso
 * suggerimento. La copia vale un minuto, e si dimentica quando l'amministratore cambia le
 * preferenze; cambia anche con l'utente o la postazione della sessione.
 */
const KEEP_MS = 60_000;
let cached: { key: string; at: number; value: Promise<PrintPreferences> } | null = null;

/** Dopo un cambio delle preferenze: i suggerimenti si rileggono alla prossima pagina. */
export function forgetPrintPreferences() {
  cached = null;
}

function load(key: string): Promise<PrintPreferences> {
  const now = Date.now();
  if (cached && cached.key === key && now - cached.at < KEEP_MS) return cached.value;
  const value = api<PrintPreferences>('/api/stampa/preferenze');
  cached = { key, at: now, value };
  // Una lettura non riuscita non resta: la prossima pagina riprova.
  void value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

/** Le preferenze di stampa della postazione della sessione; null finché non sono lette. */
export function usePrintPreferences(): PrintPreferences | null {
  const { state } = useSession();
  const key = state.status === 'ready' ? `${state.me.id}|${state.me.postazione ?? ''}` : null;
  const [data, setData] = useState<{ key: string; value: PrintPreferences } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void load(key)
      .then((value) => {
        if (alive) setData({ key, value });
      })
      // Il suggerimento non è essenziale: senza, si stampa come sempre.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return data && data.key === key ? data.value : null;
}

/** Le preferenze di un documento alla postazione della sessione; null finché non sono lette. */
export function usePrintPreference(kind: PrintKind): EffectivePrint | null {
  return usePrintPreferences()?.preferenze.find((p) => p.tipo === kind) ?? null;
}

/**
 * Suggerimento accanto ai pulsanti di stampa (tappa 14): stampante consigliata, copie e carta
 * della postazione, per esempio «Stampante consigliata: Ambulatorio, 2 copie, carta A5». Il
 * programma non può scegliere la stampante né stampare da solo: si confermano nella finestra di
 * stampa. Non compare se nessuno ha impostato nulla per quel documento.
 */
export function PrintHint({ kind, id }: { kind: PrintKind; id?: string }) {
  const pref = usePrintPreference(kind);
  if (!pref?.suggerimento) return null;
  return (
    <p className="aiuto" id={id}>
      <Icon name="stampa" size={18} /> {pref.suggerimento}.{' '}
      <span>Si confermano nella finestra di stampa.</span>
    </p>
  );
}
