/**
 * Per-person navigation preferences: sidebar state, favourites and recently visited pages.
 *
 * These are conveniences, not records, so they live in local storage keyed by user id -
 * two people sharing a machine never see each other's recents. Storage can be missing or
 * throw (private windows, blocked site data); every access degrades to defaults.
 */
import { useCallback, useEffect, useState } from 'react';

export type RecentEntry = { path: string; label: string; visitedAt: number };

const MAX_RECENTS = 8;
const MAX_FAVOURITES = 12;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* preferences are best-effort */
  }
}

/** Kept on the key the previous shell used, so an existing preference carries over. */
const COLLAPSED_KEY = 'infinity:sidebar-collapsed';

export function useNavPreferences(userId: string | undefined) {
  const scope = userId ?? 'anonymous';
  const favKey = `infinity:nav:${scope}:favourites`;
  const recentKey = `infinity:nav:${scope}:recents`;

  const [collapsed, setCollapsed] = useState<boolean>(() => read(COLLAPSED_KEY, false));
  const [favourites, setFavourites] = useState<string[]>(() => read(favKey, []));
  const [recents, setRecents] = useState<RecentEntry[]>(() => read(recentKey, []));

  // The user id arrives after the first render; reload the lists for the right person.
  useEffect(() => {
    setFavourites(read(favKey, []));
    setRecents(read(recentKey, []));
  }, [favKey, recentKey]);

  useEffect(() => write(COLLAPSED_KEY, collapsed), [collapsed]);

  const toggleFavourite = useCallback((to: string) => {
    setFavourites((current) => {
      const next = current.includes(to)
        ? current.filter((item) => item !== to)
        : [...current, to].slice(-MAX_FAVOURITES);
      write(favKey, next);
      return next;
    });
  }, [favKey]);

  const recordVisit = useCallback((path: string, label: string) => {
    setRecents((current) => {
      const next = [{ path, label, visitedAt: Date.now() }, ...current.filter((r) => r.path !== path)]
        .slice(0, MAX_RECENTS);
      write(recentKey, next);
      return next;
    });
  }, [recentKey]);

  return { collapsed, setCollapsed, favourites, toggleFavourite, recents, recordVisit };
}
