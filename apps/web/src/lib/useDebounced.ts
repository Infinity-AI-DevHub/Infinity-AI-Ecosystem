import { useEffect, useState } from 'react';

/**
 * Delays a fast-changing value so a per-keystroke input drives one request per pause
 * rather than one per character.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
