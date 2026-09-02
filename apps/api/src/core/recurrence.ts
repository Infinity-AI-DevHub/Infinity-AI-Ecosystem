/**
 * Expanding a recurrence rule into the occurrences that fall in a window.
 *
 * Occurrences are computed rather than stored. Materialising a year of rows at creation
 * would need backfilling whenever the series is edited, and a series with no end date
 * has no sensible number of rows to write. Computing means an edit to the parent is
 * immediately true of every future occurrence.
 *
 * Only the subset of RFC 5545 the application accepts is handled - FREQ, INTERVAL,
 * COUNT, UNTIL and BYDAY - because that is what the validator lets through. Anything
 * else would be a rule that could not have been stored.
 */

export type Recurrence = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  count: number | null;
  until: Date | null;
  /** Weekly only: MO, TU, … Empty means "the weekday the series started on". */
  byDay: string[];
};

const DAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** A hard ceiling, so a malformed or very long series cannot spin. */
const MAX_OCCURRENCES = 500;

export function parseRecurrence(rule: string | null): Recurrence | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const segment of rule.split(';')) {
    const [key, value] = segment.split('=');
    if (key && value) parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;

  const interval = Number(parts.get('INTERVAL') ?? '1');
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;

  // UNTIL is either a bare date (20261231) or a UTC timestamp (20261231T235959Z).
  let until: Date | null = null;
  const rawUntil = parts.get('UNTIL');
  if (rawUntil) {
    const m = rawUntil.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    if (m) {
      until = new Date(Date.UTC(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? 23), Number(m[5] ?? 59), Number(m[6] ?? 59),
      ));
    }
  }

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 52) : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? Math.min(count, MAX_OCCURRENCES) : null,
    until,
    byDay: (parts.get('BYDAY') ?? '').split(',').map((d) => d.trim()).filter((d) => d in DAY_INDEX),
  };
}

/**
 * Every start time in [windowFrom, windowTo], given the first occurrence.
 *
 * COUNT is counted from the beginning of the series, not from the window: the eighth of
 * eight occurrences is the eighth overall, so a window late in the series has to walk
 * from the start to know whether the series has already finished.
 */
export function occurrencesBetween(
  seriesStart: Date,
  durationMs: number,
  rule: Recurrence,
  windowFrom: Date,
  windowTo: Date,
): Date[] {
  const out: Date[] = [];
  let emitted = 0;

  const push = (start: Date): boolean => {
    if (rule.count !== null && emitted >= rule.count) return false;
    if (rule.until && start > rule.until) return false;
    emitted += 1;
    // Overlap, not containment: a meeting that began before the window opened but is
    // still running belongs in it.
    if (start.getTime() + durationMs > windowFrom.getTime() && start < windowTo) out.push(start);
    return true;
  };

  if (rule.freq === 'WEEKLY' && rule.byDay.length > 0) {
    // Walk week by week, emitting each named weekday within it.
    const weekStart = new Date(seriesStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    for (let week = 0; week < MAX_OCCURRENCES; week += 1) {
      const base = new Date(weekStart);
      base.setUTCDate(base.getUTCDate() + week * 7 * rule.interval);
      if (base > windowTo && out.length > 0) break;
      let stop = false;
      for (const day of rule.byDay) {
        const occurrence = new Date(base);
        occurrence.setUTCDate(occurrence.getUTCDate() + DAY_INDEX[day]!);
        occurrence.setUTCHours(
          seriesStart.getUTCHours(), seriesStart.getUTCMinutes(),
          seriesStart.getUTCSeconds(), seriesStart.getUTCMilliseconds(),
        );
        if (occurrence < seriesStart) continue;
        if (!push(occurrence)) { stop = true; break; }
      }
      if (stop) break;
      if (base > windowTo) break;
    }
    return out.sort((a, b) => a.getTime() - b.getTime());
  }

  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    const occurrence = new Date(seriesStart);
    if (rule.freq === 'DAILY') {
      occurrence.setUTCDate(occurrence.getUTCDate() + index * rule.interval);
    } else if (rule.freq === 'WEEKLY') {
      occurrence.setUTCDate(occurrence.getUTCDate() + index * 7 * rule.interval);
    } else {
      // Monthly on the same day number. A 31st in a short month lands on the last day
      // rather than skipping into the next one, which is what people expect from
      // "monthly on the 31st".
      const target = new Date(seriesStart);
      target.setUTCMonth(target.getUTCMonth() + index * rule.interval, 1);
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      occurrence.setUTCFullYear(target.getUTCFullYear(), target.getUTCMonth(),
        Math.min(seriesStart.getUTCDate(), lastDay));
    }
    if (!push(occurrence)) break;
    if (occurrence > windowTo) break;
  }
  return out;
}
