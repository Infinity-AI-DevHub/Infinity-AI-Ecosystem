/**
 * Small server-state cache (blueprint 16: "server state via a query cache with
 * invalidation and realtime reconciliation; local UI state kept separate").
 *
 * Deliberately minimal rather than a large dependency: entries are keyed, deduplicated
 * while in flight, invalidated explicitly by mutations and by realtime events, and
 * every consumer sees loading, error and empty states distinctly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, NetworkError } from './api';

type Entry = { data: unknown; at: number };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<() => void>>();

const DEFAULT_TTL_MS = 30_000;

function notify(key: string): void {
  for (const handler of subscribers.get(key) ?? []) handler();
}

/** Drops cached entries whose key starts with `prefix`, then refetches live consumers. */
export function invalidate(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      notify(key);
    }
  }
  // Keys with no cached entry may still have mounted subscribers awaiting first load.
  for (const key of [...subscribers.keys()]) {
    if (key.startsWith(prefix)) notify(key);
  }
}

/** Writes a value directly, for reconciling a realtime event without a round trip. */
export function setCached<T>(key: string, updater: (current: T | undefined) => T): void {
  const current = cache.get(key)?.data as T | undefined;
  cache.set(key, { data: updater(current), at: Date.now() });
  notify(key);
}

export function clearCache(): void {
  cache.clear();
  inFlight.clear();
  for (const key of subscribers.keys()) notify(key);
}

export type QueryState<T> = {
  data: T | undefined;
  /** True only on the first load; a background refresh keeps showing current data. */
  loading: boolean;
  refreshing: boolean;
  error: ApiError | NetworkError | null;
  reload: () => void;
};

export function useQuery<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { ttlMs?: number; enabled?: boolean } = {},
): QueryState<T> {
  const { ttlMs = DEFAULT_TTL_MS, enabled = true } = options;
  const active = enabled && key !== null;

  const [, forceRender] = useState(0);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const cached = active ? cache.get(key) : undefined;
  const isFresh = cached !== undefined && Date.now() - cached.at < ttlMs;

  const run = useCallback(
    async (force: boolean) => {
      if (!active || key === null) return;
      const existing = cache.get(key);
      if (!force && existing && Date.now() - existing.at < ttlMs) return;

      // Deduplicate: several components mounting at once share one request.
      let promise = inFlight.get(key);
      if (!promise) {
        const controller = new AbortController();
        promise = fetcherRef
          .current(controller.signal)
          .then((data) => {
            cache.set(key, { data, at: Date.now() });
            return data;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
      }

      setRefreshing(true);
      try {
        await promise;
        setError(null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
      } finally {
        setRefreshing(false);
        notify(key);
      }
    },
    [active, key, ttlMs],
  );

  useEffect(() => {
    if (!active || key === null) return;
    const handler = () => forceRender((n) => n + 1);
    let set = subscribers.get(key);
    if (!set) {
      set = new Set();
      subscribers.set(key, set);
    }
    set.add(handler);
    void run(false);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) subscribers.delete(key);
    };
  }, [active, key, run]);

  const data = active && key !== null ? (cache.get(key)?.data as T | undefined) : undefined;

  return {
    data,
    loading: active && data === undefined && error === null,
    refreshing: refreshing && !isFresh,
    error,
    reload: () => void run(true),
  };
}

/** Wraps a write so pending state, field errors and cache invalidation are consistent. */
export function useMutation<TArgs extends unknown[], TResult>(
  perform: (...args: TArgs) => Promise<TResult>,
  options: { invalidates?: string[]; onSuccess?: (result: TResult) => void } = {},
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);

  const mutate = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      setPending(true);
      setError(null);
      try {
        const result = await perform(...args);
        for (const prefix of options.invalidates ?? []) invalidate(prefix);
        options.onSuccess?.(result);
        return result;
      } catch (err) {
        setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
        return undefined;
      } finally {
        setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [perform],
  );

  return { mutate, pending, error, reset: () => setError(null) };
}
