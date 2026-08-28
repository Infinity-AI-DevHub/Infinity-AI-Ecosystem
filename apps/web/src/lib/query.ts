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

/**
 * Counts how many times each key has been invalidated.
 *
 * A mounted component refetches when this number moves, never merely because a request
 * settled. Deciding by "is the cache empty?" instead caused a self-sustaining storm: a
 * failed request leaves the cache empty, notifying subscribers, which refetch, which
 * fail again. One broken endpoint became thousands of requests a minute and could not
 * recover once it tripped the rate limiter.
 */
const invalidations = new Map<string, number>();

/**
 * Consecutive failures per key, used as a circuit breaker.
 *
 * The invalidation counter already stops a failed request retriggering itself, but this
 * bounds the damage from any future path that requests too eagerly - a chatty realtime
 * channel invalidating on every frame, for example. After this many consecutive
 * failures the key stops fetching automatically; an explicit reload() still works, so
 * the reader's "Try again" is never disabled.
 */
const failures = new Map<string, number>();
const MAX_CONSECUTIVE_FAILURES = 5;

const DEFAULT_TTL_MS = 30_000;

function notify(key: string): void {
  for (const handler of subscribers.get(key) ?? []) handler();
}

function bumpInvalidation(key: string): void {
  invalidations.set(key, (invalidations.get(key) ?? 0) + 1);
}

/** Drops cached entries whose key starts with `prefix`, then refetches live consumers. */
export function invalidate(prefix: string): void {
  const keys = new Set([...cache.keys(), ...subscribers.keys()]);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    failures.delete(key);
    bumpInvalidation(key);
    notify(key);
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
  failures.clear();
  for (const key of subscribers.keys()) {
    bumpInvalidation(key);
    notify(key);
  }
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

      if (!force && (failures.get(key) ?? 0) >= MAX_CONSECUTIVE_FAILURES) return;

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
        failures.delete(key);
        setError(null);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        failures.set(key, (failures.get(key) ?? 0) + 1);
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

    /**
     * Invalidation drops the cached entry and notifies subscribers. A mounted component
     * must then refetch, not just re-render - otherwise it renders its loading state
     * forever and only recovers when it happens to remount.
     *
     * The refetch is driven by the invalidation counter rather than by an empty cache,
     * so a request that keeps failing cannot retrigger itself. A failed query stays
     * failed and offers the reader a retry.
     */
    let seenInvalidation = invalidations.get(key) ?? 0;
    const handler = () => {
      forceRender((n) => n + 1);
      const current = invalidations.get(key) ?? 0;
      if (current === seenInvalidation) return;
      seenInvalidation = current;
      if (!inFlight.has(key)) void run(true);
    };

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
    reload: () => {
      if (key !== null) failures.delete(key);
      void run(true);
    },
  };
}

/** Wraps a write so pending state, field errors and cache invalidation are consistent. */
export function useMutation<TArgs extends unknown[], TResult>(
  perform: (...args: TArgs) => Promise<TResult>,
  options: { invalidates?: string[]; onSuccess?: (result: TResult) => void } = {},
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | NetworkError | null>(null);
  const performRef = useRef(perform);
  const optionsRef = useRef(options);
  performRef.current = perform;
  optionsRef.current = options;

  const mutate = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      setPending(true);
      setError(null);
      try {
        const result = await performRef.current(...args);
        for (const prefix of optionsRef.current.invalidates ?? []) invalidate(prefix);
        optionsRef.current.onSuccess?.(result);
        return result;
      } catch (err) {
        setError(err instanceof ApiError || err instanceof NetworkError ? err : new NetworkError());
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  return { mutate, pending, error, reset: () => setError(null) };
}
