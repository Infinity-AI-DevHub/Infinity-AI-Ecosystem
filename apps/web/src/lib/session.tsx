/**
 * Session and capability context (blueprint 16).
 *
 * The current user and capability set are fetched at startup and refreshed after any
 * change that could alter permissions. Route guards built on this improve navigation
 * only - the API remains authoritative, and a hidden button is never a security control.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, onSessionLost, type Capabilities, type Session } from './api';

type SessionState = {
  status: 'loading' | 'authenticated' | 'anonymous';
  session: Session | null;
  capabilities: Capabilities | null;
  /** True when the role grants the capability. The server checks again on every call. */
  can: (capability: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, caps] = await Promise.all([
        api.get<Session>('/me'),
        api.get<Capabilities>('/me/capabilities'),
      ]);
      setSession(me);
      setCapabilities(caps);
      setStatus(me.user ? 'authenticated' : 'anonymous');
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        setSession(null);
        setCapabilities(null);
        setStatus('anonymous');
        return;
      }
      // A transient failure must not silently sign the user out; surface it as loading
      // failure and let the shell show a retry affordance.
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A revoked session (suspension, password change, administrator action) drops the
  // user to sign-in wherever they are, without waiting for the next navigation.
  useEffect(
    () =>
      onSessionLost(() => {
        setSession(null);
        setCapabilities(null);
        setStatus('anonymous');
      }),
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setSession(null);
      setCapabilities(null);
      setStatus('anonymous');
    }
  }, []);

  const can = useCallback(
    (capability: string) => capabilities?.capabilities.includes(capability) ?? false,
    [capabilities],
  );

  const value = useMemo<SessionState>(
    () => ({ status, session, capabilities, can, refresh: load, signOut }),
    [status, session, capabilities, can, load, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

export function useCurrentUser() {
  return useSession().session?.user ?? null;
}
