import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, onAuthProblem } from './api';
import { clearStored } from './storage';

export interface Me {
  id: string;
  nome: string;
  ruoli: { codice: string; nome: string }[];
  postazione: string | null;
  /** L'archivio di cui l'utente è titolare: impostazioni ed esportazione (pagina Archivio). */
  archivio: { id: string; nome: string } | null;
  /** Il nome con cui si accede: il modulo del cambio della password lo dà ai gestori di password. */
  nomeUtente?: string | null;
  /** Password temporanea (tappa 14): finché non la cambia, l'utente vede solo il cambio. */
  devoCambiarePassword?: boolean;
  /** L'amministratore ha corretto il codice fiscale del medico: aspetta la sua conferma (D181). */
  codiceFiscaleDaConfermare?: boolean;
}

type State =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'locked' }
  | { status: 'ready'; me: Me };

interface Session {
  state: State;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Vero se l'utente è un medico (titolare o sostituto): firma e invia. */
  isDoctor: boolean;
  /** Vero se l'utente è amministratore dello studio (tappa 14). */
  isAdmin: boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', me: await api<Me>('/api/io') });
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) setState({ status: 'locked' });
      else setState({ status: 'anonymous' });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthProblem((status) => {
      // Sessione finita: niente dati dei pazienti resta nel browser. Bloccata: si riprende da lì.
      if (status === 401) clearStored();
      setState(status === 423 ? { status: 'locked' } : { status: 'anonymous' });
    });
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/api/uscita', { method: 'POST', body: {} });
    clearStored();
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<Session>(() => {
    const roles = state.status === 'ready' ? state.me.ruoli.map((r) => r.codice) : [];
    return {
      state,
      refresh,
      logout,
      isDoctor: roles.includes('owner_doctor') || roles.includes('substitute_doctor'),
      isAdmin: roles.includes('administrator'),
    };
  }, [state, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession fuori da SessionProvider');
  return s;
}
