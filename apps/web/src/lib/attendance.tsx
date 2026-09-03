/**
 * Being clocked in, for as long as the app is open.
 *
 * This lives at the top of the application rather than on the attendance page, because
 * the whole point is that it keeps running while you work somewhere else. Close the app
 * and the heartbeat stops; the server notices the silence and closes the session.
 *
 * Nothing here tries to detect the app closing. A `beforeunload` handler is a courtesy
 * that fires for a tidy quit and not for a crash, a force-quit or a dead battery, so the
 * server's own timeout is the mechanism and this only has to be honest about being alive.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { useSession } from './session';

/** Well inside the server's staleness window, so a single missed beat is harmless. */
const HEARTBEAT_MS = 60_000;

export type AttendanceDay = {
  day: string;
  minutes: number;
  sessions: number;
  meetsMinimum: boolean;
  flagged: boolean;
  /** Saturday and Sunday are not working days, so the minimum does not apply. */
  workingDay: boolean;
};

export type OpenSession = {
  id: string;
  clocked_in_at: string;
  last_seen_at: string;
};

type State = {
  open: OpenSession | null;
  today: AttendanceDay | null;
  minimumMinutes: number;
  loading: boolean;
  /** Seconds worked in the open session, ticking locally so the clock reads live. */
  elapsedSeconds: number;
  refresh: () => Promise<void>;
  clockIn: () => Promise<void>;
};

const AttendanceContext = createContext<State | null>(null);

export function AttendanceProvider({ children }: { children: ReactNode }) {
  const { session, can } = useSession();
  const enabled = Boolean(session?.user) && can('attendance.record');

  const [open, setOpen] = useState<OpenSession | null>(null);
  const [today, setToday] = useState<AttendanceDay | null>(null);
  const [minimumMinutes, setMinimumMinutes] = useState(360);
  const [loading, setLoading] = useState(true);
  const [elapsedSeconds, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    try {
      const result = await api.get<{
        open: OpenSession | null; today: AttendanceDay | null; minimumMinutes: number;
      }>('/attendance/me?days=1');
      setOpen(result.open);
      setToday(result.today);
      setMinimumMinutes(result.minimumMinutes);
      startedAt.current = result.open ? new Date(result.open.clocked_in_at).getTime() : null;
    } catch {
      // Attendance is not worth breaking the app over; the page shows its own error.
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The heartbeat. `open: false` in the reply means the server closed the session while
  // we were away - most likely the machine slept - so the UI corrects itself.
  useEffect(() => {
    if (!enabled || !open) return;
    const beat = async () => {
      try {
        const result = await api.post<{ open: boolean }>('/attendance/heartbeat', {});
        if (!result.open) { setOpen(null); startedAt.current = null; void refresh(); }
      } catch {
        // A missed beat is expected on a flaky connection; the window is generous.
      }
    };
    void beat();
    const timer = window.setInterval(() => { void beat(); }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [enabled, open, refresh]);

  // A local second hand, so the elapsed time reads as a clock rather than a number that
  // only moves when something else refetches.
  useEffect(() => {
    if (!open) { setElapsed(0); return; }
    const tick = () => {
      if (startedAt.current) setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const clockIn = useCallback(async () => {
    await api.post('/attendance/clock-in', {});
    await refresh();
  }, [refresh]);

  const value = useMemo<State>(
    () => ({ open, today, minimumMinutes, loading, elapsedSeconds, refresh, clockIn }),
    [open, today, minimumMinutes, loading, elapsedSeconds, refresh, clockIn],
  );

  return <AttendanceContext.Provider value={value}>{children}</AttendanceContext.Provider>;
}

export function useAttendance(): State {
  const value = useContext(AttendanceContext);
  if (!value) throw new Error('useAttendance must be used inside AttendanceProvider');
  return value;
}

/** `7h 12m`, or `0m`. Used wherever a duration is shown. */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** `03:14:07` for a running session, where the seconds matter to the person watching. */
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
