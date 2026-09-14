/**
 * Who is on call at a given instant.
 *
 * A schedule is an ordered list of people, a rotation length (a day or a week), the local
 * minute of the day the shift changes, and the local date the first person starts. Shift
 * boundaries are computed in the schedule's timezone, so a 09:00 handoff stays at 09:00 on
 * the wall clock through daylight-saving changes. An override covering the instant wins;
 * if several do, the most recently created one wins.
 */
import { zonedToInstant } from './business-hours.js';

export type RotationSchedule = {
  timezone: string;
  rotation: 'daily' | 'weekly';
  handoffMinute: number;
  /** YYYY-MM-DD in the schedule timezone. */
  rotationStart: string;
  members: string[];
};

export type Override = { userId: string; startsAt: Date; endsAt: Date; createdAt: Date };

export type Shift = { userId: string; startsAt: Date; endsAt: Date; override: boolean };

function shiftStart(schedule: RotationSchedule, index: number): number {
  const [y, m, d] = schedule.rotationStart.split('-').map(Number) as [number, number, number];
  const days = index * (schedule.rotation === 'daily' ? 1 : 7);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return zonedToInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), schedule.handoffMinute, schedule.timezone);
}

/** The rotation shift containing `at`, ignoring overrides. Null before the rotation starts. */
export function rotationShiftAt(schedule: RotationSchedule, at: Date): Shift | null {
  if (schedule.members.length === 0) return null;
  const t = at.getTime();
  const first = shiftStart(schedule, 0);
  if (t < first) return null;
  const period = (schedule.rotation === 'daily' ? 1 : 7) * 86_400_000;
  let index = Math.floor((t - first) / period);
  // A DST change can put the estimate one shift out; settle it against real boundaries.
  while (index > 0 && shiftStart(schedule, index) > t) index -= 1;
  while (shiftStart(schedule, index + 1) <= t) index += 1;
  const userId = schedule.members[((index % schedule.members.length) + schedule.members.length) % schedule.members.length]!;
  return { userId, startsAt: new Date(shiftStart(schedule, index)), endsAt: new Date(shiftStart(schedule, index + 1)), override: false };
}

export function onCallAt(schedule: RotationSchedule, overrides: Override[], at: Date): Shift | null {
  const t = at.getTime();
  const covering = overrides
    .filter((o) => o.startsAt.getTime() <= t && o.endsAt.getTime() > t)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (covering) return { userId: covering.userId, startsAt: covering.startsAt, endsAt: covering.endsAt, override: true };
  return rotationShiftAt(schedule, at);
}

/** The next `count` rotation shifts from `from`, for showing who is on call when. */
export function upcomingShifts(schedule: RotationSchedule, overrides: Override[], from: Date, count: number): Shift[] {
  const out: Shift[] = [];
  let cursor = rotationShiftAt(schedule, from);
  if (!cursor) {
    if (schedule.members.length === 0) return [];
    cursor = rotationShiftAt(schedule, new Date(shiftStart(schedule, 0)));
  }
  for (let i = 0; cursor && i < count; i += 1) {
    const active = onCallAt(schedule, overrides, cursor.startsAt.getTime() < from.getTime() ? from : cursor.startsAt);
    out.push(active && active.override ? { ...cursor, userId: active.userId, override: true } : cursor);
    cursor = rotationShiftAt(schedule, cursor.endsAt);
  }
  return out;
}
