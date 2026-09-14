/**
 * Business-hours arithmetic for SLA targets.
 *
 * Pure functions over a weekly schedule in an IANA timezone plus a list of closed days.
 * Everything is computed in the schedule's own local time, so a desk in Colombo that opens
 * at 09:00 opens at 09:00 Colombo time whatever the server's clock says, and daylight-saving
 * transitions in zones that have them move the opening hour with the wall clock.
 *
 * No timezone library: Intl gives the local wall-clock parts of an instant, and the reverse
 * (local wall time to instant) is found by correcting a UTC guess by the zone offset, twice,
 * which settles across a DST change.
 */

export type Schedule = {
  timezone: string;
  /** ISO weekday (1 = Monday .. 7 = Sunday) to [startMinute, endMinute). Absent = closed. */
  days: Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, [number, number]>>;
  /** Closed days as YYYY-MM-DD in the schedule's timezone. */
  holidays: string[];
};

type Parts = { y: number; m: number; d: number; hh: number; mm: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timezone, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

function localParts(instant: number, timezone: string): Parts & { ss: number } {
  const out: Record<string, string> = {};
  for (const p of formatter(timezone).formatToParts(new Date(instant))) out[p.type] = p.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    hh: Number(out.hour), mm: Number(out.minute), ss: Number(out.second), weekday: WEEKDAY[out.weekday!]!,
  };
}

/** Offset of the zone from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timezone: string): number {
  const p = localParts(instant, timezone);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the local wall clock in `timezone` reads y-m-d + minutes. */
export function zonedToInstant(y: number, m: number, d: number, minutes: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let instant = guess - offsetAt(guess, timezone);
  instant = guess - offsetAt(instant, timezone);
  return instant;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Open windows as [startInstant, endInstant), day by day, from the local day containing `from`. */
function* windows(from: number, schedule: Schedule, maxDays = 800): Generator<[number, number]> {
  const start = localParts(from, schedule.timezone);
  // Walk calendar days using a UTC date as a counter; only its y/m/d are used.
  const cursor = new Date(Date.UTC(start.y, start.m - 1, start.d));
  const holidays = new Set(schedule.holidays);
  for (let i = 0; i < maxDays; i += 1) {
    const y = cursor.getUTCFullYear(); const m = cursor.getUTCMonth() + 1; const d = cursor.getUTCDate();
    const weekday = ((cursor.getUTCDay() + 6) % 7) + 1;
    const hours = schedule.days[weekday as 1];
    if (hours && hours[1] > hours[0] && !holidays.has(iso(y, m, d))) {
      yield [zonedToInstant(y, m, d, hours[0], schedule.timezone), zonedToInstant(y, m, d, hours[1], schedule.timezone)];
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function hasOpenDay(schedule: Schedule): boolean {
  return Object.values(schedule.days).some((h) => h && h[1] > h[0]);
}

/** `start` moved forward by `minutes` of open time. Wall-clock if the schedule is never open. */
export function addBusinessMinutes(start: Date, minutes: number, schedule: Schedule): Date {
  if (minutes <= 0) return new Date(start);
  if (!hasOpenDay(schedule)) return new Date(start.getTime() + minutes * 60_000);
  let remaining = minutes * 60_000;
  const from = start.getTime();
  for (const [open, close] of windows(from, schedule)) {
    if (close <= from) continue;
    const begin = Math.max(open, from);
    const span = close - begin;
    if (remaining <= span) return new Date(begin + remaining);
    remaining -= span;
  }
  // Only reachable if holidays close every day for years; fall back rather than hang.
  return new Date(start.getTime() + minutes * 60_000);
}

/** Open minutes between two instants (0 if `to` is not after `from`). */
export function businessMinutesBetween(from: Date, to: Date, schedule: Schedule): number {
  const a = from.getTime(); const b = to.getTime();
  if (b <= a) return 0;
  if (!hasOpenDay(schedule)) return Math.round((b - a) / 60_000);
  let total = 0;
  for (const [open, close] of windows(a, schedule)) {
    if (open >= b) break;
    const s = Math.max(open, a); const e = Math.min(close, b);
    if (e > s) total += e - s;
  }
  return Math.round(total / 60_000);
}

export const DEFAULT_SCHEDULE: Schedule = {
  timezone: 'UTC',
  days: { 1: [540, 1020], 2: [540, 1020], 3: [540, 1020], 4: [540, 1020], 5: [540, 1020] },
  holidays: [],
};
