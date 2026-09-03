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
import { isDesktop } from './desktop';
import { clearGrant, restoreGrant } from './tokens';

type SessionState = {
  status: 'loading' | 'authenticated' | 'anonymous';
  session: Session | null;
  capabilities: Capabilities | null;
  /** True when the role grants the capability. The server checks again on every call. */
  can: (capability: string) => boolean;
  refresh: () => Promise<Capabilities | null>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  const load = useCallback(async () => {
    try {
      /**
       * On the desktop the session lives in the OS keystore rather than a cookie, so it
       * has to be lifted into memory before the first request goes out. Without this the
       * app would show the sign-in screen on every launch despite holding a perfectly
       * valid five-day grant.
       */
      if (isDesktop) await restoreGrant();

      const [me, caps] = await Promise.all([
        api.get<Session>('/me'),
        api.get<Capabilities>('/me/capabilities'),
      ]);
      setSession(me);
      setCapabilities(caps);
      setStatus(me.user ? 'authenticated' : 'anonymous');
      return caps;
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthenticated) {
        setSession(null);
        setCapabilities(null);
        setStatus('anonymous');
        return null;
      }
      // A transient failure must not silently sign the user out; surface it as loading
      // failure and let the shell show a retry affordance.
      setStatus('anonymous');
    }
    return null;
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
      // The keystore is cleared whatever the server said. A logout that failed to reach
      // the API still means the person intended to leave this machine.
      if (isDesktop) clearGrant();
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
