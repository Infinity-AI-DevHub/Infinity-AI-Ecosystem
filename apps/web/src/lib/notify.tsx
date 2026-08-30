/**
 * In-app notifications: banners, sounds, badges and the preferences that govern them.
 *
 * Three decisions shape this.
 *
 * Sound is synthesized rather than shipped. A short tone from the Web Audio API needs no
 * binary asset, no network fetch and no decode, so it cannot arrive late or fail to load
 * - and an alert that plays half a second after the banner is worse than silence.
 *
 * Preferences are per device, in localStorage, not per account on the server. Whether
 * this machine should make noise is a property of where it is sitting - a shared desk, a
 * client meeting - not of who is signed in.
 *
 * Quiet hours suppress sound and OS banners, never the notification itself. Silencing
 * the record as well as the alert is how people miss things permanently.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type Severity = 'info' | 'success' | 'warning' | 'critical';

export type Toast = {
  id: string;
  severity: Severity;
  title: string;
  body?: string;
  /** An in-app route the banner links to. */
  link?: string;
  /** Critical alerts stay until dismissed; everything else clears itself. */
  sticky?: boolean;
};

export type Preferences = {
  soundEnabled: boolean;
  bannersEnabled: boolean;
  /** Local wall-clock hours, e.g. 22 to 8. Equal values mean no quiet period. */
  quietFrom: number;
  quietTo: number;
};

const PREF_KEY = 'iw.notify.prefs';

const DEFAULTS: Preferences = {
  soundEnabled: true,
  bannersEnabled: true,
  quietFrom: 0,
  quietTo: 0,
};

export function loadPreferences(): Preferences {
  // Wrapped: a private window, cleared site data or a browser set to block storage all
  // throw here, and a preferences read must never be what stops the app rendering.
  try {
    const raw = window.localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return DEFAULTS;
  }
}

function savePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
  } catch {
    /* Storage unavailable: the settings simply do not persist past this session. */
  }
}

/** True when the current local time falls inside the quiet window. */
export function inQuietHours(preferences: Preferences, now = new Date()): boolean {
  const { quietFrom, quietTo } = preferences;
  if (quietFrom === quietTo) return false;
  const hour = now.getHours();
  // A window that crosses midnight is two ranges, not one.
  return quietFrom < quietTo
    ? hour >= quietFrom && hour < quietTo
    : hour >= quietFrom || hour < quietTo;
}

/**
 * A short two-note figure per severity.
 *
 * Distinguishable without being musical: people learn "that was the urgent one" from
 * pitch direction long before they learn a melody.
 */
const TONES: Record<Severity, { freq: number[]; gain: number }> = {
  info: { freq: [660, 880], gain: 0.05 },
  success: { freq: [740, 1108], gain: 0.05 },
  warning: { freq: [560, 470], gain: 0.07 },
  critical: { freq: [440, 330], gain: 0.09 },
};

let audioContext: AudioContext | null = null;

export function playChime(severity: Severity): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    // Created lazily and reused: browsers cap how many contexts a page may open, and
    // one per notification exhausts that within a busy morning.
    audioContext ??= new Ctor();
    if (audioContext.state === 'suspended') void audioContext.resume();

    const { freq, gain } = TONES[severity];
    const now = audioContext.currentTime;
    freq.forEach((f, index) => {
      const osc = audioContext!.createOscillator();
      const amp = audioContext!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const start = now + index * 0.09;
      // Ramped rather than switched: an abrupt gain change is an audible click.
      amp.gain.setValueAtTime(0, start);
      amp.gain.linearRampToValueAtTime(gain, start + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(amp).connect(audioContext!.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    /* Audio blocked or unavailable. The banner still appears. */
  }
}

type NotifyApi = {
  toasts: Toast[];
  preferences: Preferences;
  setPreferences: (next: Preferences) => void;
  /** Raise a banner. Returns its id so a caller can dismiss it early. */
  notify: (input: Omit<Toast, 'id'>) => string;
  dismiss: (id: string) => void;
  /** Unread count, mirrored to the tab title and the OS badge. */
  setBadgeCount: (count: number) => void;
};

const NotifyContext = createContext<NotifyApi | null>(null);

const AUTO_DISMISS_MS: Record<Severity, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  critical: 0,
};

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [preferences, setPreferencesState] = useState<Preferences>(loadPreferences);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const baseTitle = useRef<string>(typeof document === 'undefined' ? '' : document.title);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (input: Omit<Toast, 'id'>): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toast: Toast = { ...input, id };

      setToasts((current) => {
        // Bounded: a burst of realtime frames must not bury the screen in banners.
        const next = [...current, toast];
        return next.length > 4 ? next.slice(next.length - 4) : next;
      });

      const quiet = inQuietHours(preferences);
      if (preferences.soundEnabled && !quiet) playChime(input.severity);

      const lifetime = input.sticky ? 0 : AUTO_DISMISS_MS[input.severity];
      if (lifetime > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), lifetime));
      }
      return id;
    },
    [dismiss, preferences],
  );

  const setPreferences = useCallback((next: Preferences) => {
    setPreferencesState(next);
    savePreferences(next);
  }, []);

  /**
   * The tab title carries the count for the web build, which has no dock badge. It is
   * the only unread signal available when the window is behind something else.
   */
  const setBadgeCount = useCallback((count: number) => {
    if (typeof document === 'undefined') return;
    document.title = count > 0 ? `(${count}) ${baseTitle.current}` : baseTitle.current;
  }, []);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const value = useMemo(
    () => ({ toasts, preferences, setPreferences, notify, dismiss, setBadgeCount }),
    [toasts, preferences, setPreferences, notify, dismiss, setBadgeCount],
  );

  return <NotifyContext.Provider value={value}>{children}</NotifyContext.Provider>;
}

export function useNotify(): NotifyApi {
  const context = useContext(NotifyContext);
  if (!context) throw new Error('useNotify must be used inside NotifyProvider');
  return context;
}
