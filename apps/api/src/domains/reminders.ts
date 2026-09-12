/**
 * Reminders.
 *
 * The workspace could already tell you a meeting was starting or an invoice had gone
 * unpaid, because those are things it owns. Everything else — the subscription that
 * renews on the 4th, the domain expiring in March, the job you promised for Friday and
 * want prodding about from Tuesday — lived in somebody's head or a phone alarm.
 *
 * Two ideas carry the whole module:
 *
 *   * A reminder has a day it is *due* and a day the *nagging starts*, and those are
 *     different. A renewal eleven months away is not news; three weeks out it is.
 *   * A repeating reminder is one row that moves forward. Completing this month's
 *     subscription payment sets the next one, so nobody maintains twelve rows.
 */
import { many, newId, one, pool, query, transaction } from '../core/db.js';
import { badRequest, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';

export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type Kind = 'task' | 'payment' | 'renewal' | 'other';

export type ReminderRow = {
  id: string;
  title: string;
  notes: string | null;
  kind: string;
  due_on: string;
  lead_days: number;
  repeat_every: Repeat;
  repeat_interval: number;
  amount: string | null;
  currency: string | null;
  status: string;
  snoozed_until: string | null;
  owner_id: string;
  owner_name?: string | null;
};

/* ------------------------------------------------------------------- the dates */

/** `2026-09-12`, in no timezone at all: a reminder is about a day, not an instant. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A day, however the driver handed it over.
 *
 * MySQL DATE columns arrive as JS Date objects on this driver, whose string form is
 * "Fri Sep 18 2026 …". Slicing ten characters off that gives "Fri Sep 18", which is not
 * a date anybody can parse — every derived date came out NaN. One place to convert, and
 * every reader goes through it.
 */
export function toDay(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return isoDay(value);
  const text = String(value);
  // Already ISO, or something the Date constructor understands.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : isoDay(parsed);
}

function parseDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/**
 * The day the nagging starts: `lead_days` before it is due.
 *
 * Kept separate from the due date because that is the whole point — "remind me from
 * Tuesday about Friday" is one reminder, not a reminder plus a second reminder.
 */
export function remindFrom(dueOn: string, leadDays: number): string {
  const date = parseDay(dueOn);
  date.setDate(date.getDate() - Math.max(0, leadDays));
  return isoDay(date);
}

/**
 * The next occurrence after this one.
 *
 * Month and year steps clamp to the end of the target month rather than rolling over:
 * a subscription taken on the 31st bills on the 28th of February, not the 3rd of March,
 * and a reminder that silently drifted a few days each month would be worse than none.
 */
export function nextDue(dueOn: string, repeat: Repeat, interval = 1): string | null {
  if (repeat === 'none') return null;
  const step = Math.max(1, interval);
  const date = parseDay(dueOn);

  if (repeat === 'daily') date.setDate(date.getDate() + step);
  else if (repeat === 'weekly') date.setDate(date.getDate() + step * 7);
  else {
    const months = repeat === 'monthly' ? step : step * 12;
    const day = date.getDate();
    // Move to the first of the target month, then put the day back, clamped to that
    // month's length. Setting the month directly on the 31st overshoots.
    date.setDate(1);
    date.setMonth(date.getMonth() + months);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }
  return isoDay(date);
}

/**
 * A repeating reminder whose date is in the past, caught up to the future.
 *
 * A monthly payment nobody ticked off for three months should ask about the next one
 * due, not walk forward one notification a day until it catches up.
 */
export function catchUp(dueOn: string, repeat: Repeat, interval: number, today: string): string {
  if (repeat === 'none') return dueOn;
  let next = dueOn;
  // Bounded: a corrupt row must not spin here.
  for (let i = 0; i < 400 && next <= today; i += 1) {
    const candidate = nextDue(next, repeat, interval);
    if (!candidate || candidate === next) break;
    next = candidate;
  }
  return next;
}

/* ------------------------------------------------------------------ reading them */

/** Everyone who should hear about a reminder: its owner, and anyone watching it. */
async function audienceOf(reminderId: string, ownerId: string): Promise<string[]> {
  const watchers = await many<{ user_id: string }>(
    'SELECT user_id FROM reminder_watchers WHERE reminder_id = $1', [reminderId],
  );
  return [...new Set([ownerId, ...watchers.map((w) => w.user_id)])];
}

/**
 * The reminders this person should see: their own, and the ones they watch.
 *
 * Never everybody's. A reminder is a private note as often as it is a company duty, and
 * a list of what a colleague has promised to do is not the reader's business.
 */
export async function listMine(
  actor: Actor,
  opts: { status?: string; includeDone?: boolean } = {},
) {
  await authorize({ actor, capability: 'reminder.manage', resourceless: true });
  const rows = await many<ReminderRow & { watcher_count: number }>(
    `SELECT r.*, u.display_name AS owner_name,
            (SELECT COUNT(*) FROM reminder_watchers w WHERE w.reminder_id = r.id) AS watcher_count
       FROM reminders r
       JOIN users u ON u.id = r.owner_id
      WHERE r.company_id = $1
        AND (r.owner_id = $2
             OR EXISTS (SELECT 1 FROM reminder_watchers w
                         WHERE w.reminder_id = r.id AND w.user_id = $2))
        AND ($3 OR r.status = 'active')
      ORDER BY r.status = 'active' DESC, r.due_on, r.created_at
      LIMIT 500`,
    [actor.companyId, actor.userId, Boolean(opts.includeDone)],
  );
  return rows.map(publicReminder);
}

export function publicReminder(row: ReminderRow & { watcher_count?: number }) {
  const dueOn = toDay(row.due_on);
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    kind: row.kind,
    dueOn,
    leadDays: Number(row.lead_days),
    remindFrom: remindFrom(dueOn, Number(row.lead_days)),
    repeatEvery: row.repeat_every,
    repeatInterval: Number(row.repeat_interval),
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency,
    status: row.status,
    snoozedUntil: row.snoozed_until ? toDay(row.snoozed_until) : null,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? null,
    watchers: Number(row.watcher_count ?? 0),
  };
}

async function loadOwned(actor: Actor, reminderId: string): Promise<ReminderRow> {
  const row = await one<ReminderRow>(
    `SELECT r.* FROM reminders r
      WHERE r.id = $1 AND r.company_id = $2
        AND (r.owner_id = $3
             OR EXISTS (SELECT 1 FROM reminder_watchers w
                         WHERE w.reminder_id = r.id AND w.user_id = $3))`,
    [reminderId, actor.companyId, actor.userId],
  );
  if (!row) throw notFound('Reminder not found');
  return row;
}

/* ----------------------------------------------------------------- writing them */

export type ReminderInput = {
  title: string;
  notes?: string | null;
  kind?: Kind;
  dueOn: string;
  leadDays?: number;
  repeatEvery?: Repeat;
  repeatInterval?: number;
  amount?: number | null;
  currency?: string | null;
  watcherIds?: string[];
};

export async function createReminder(actor: Actor, input: ReminderInput) {
  await authorize({ actor, capability: 'reminder.manage', resourceless: true });
  const dueOn = input.dueOn.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    throw badRequest('Give the day it is due as a date');
  }

  const id = newId();
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO reminders
         (id, company_id, title, notes, kind, due_on, lead_days, repeat_every,
          repeat_interval, amount, currency, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [
        id, actor.companyId, input.title.trim(), input.notes?.trim() || null,
        input.kind ?? 'task', dueOn, input.leadDays ?? 0,
        input.repeatEvery ?? 'none', input.repeatInterval ?? 1,
        input.amount ?? null, input.currency ?? null, actor.userId,
      ],
    );
    await addWatchers(tx, id, actor, input.watcherIds ?? []);
  });

  await auditFromActor(actor, 'reminder.create', { resourceType: 'reminder', resourceId: id });
  return getReminder(actor, id);
}

/** Watchers must be colleagues: a client has no business in the renewal calendar. */
async function addWatchers(
  tx: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  reminderId: string,
  actor: Actor,
  userIds: string[],
): Promise<void> {
  const wanted = userIds.filter((id) => id !== actor.userId);
  if (wanted.length === 0) return;
  await tx.query(
    `INSERT IGNORE INTO reminder_watchers (reminder_id, user_id)
     SELECT $1, id FROM users
      WHERE company_id = $2 AND access_level <> 'guest'
        AND status IN ('invited', 'active')
        AND id IN (${wanted.map((_, i) => `$${i + 3}`).join(',')})`,
    [reminderId, actor.companyId, ...wanted],
  );
}

export async function getReminder(actor: Actor, reminderId: string) {
  const row = await loadOwned(actor, reminderId);
  const watchers = await many(
    `SELECT u.id, u.display_name AS name FROM reminder_watchers w
       JOIN users u ON u.id = w.user_id WHERE w.reminder_id = $1 ORDER BY u.display_name`,
    [reminderId],
  );
  const owner = await one<{ display_name: string }>(
    'SELECT display_name FROM users WHERE id = $1', [row.owner_id],
  );
  return {
    ...publicReminder({ ...row, owner_name: owner?.display_name ?? null }),
    watcherList: watchers,
  };
}

export async function updateReminder(actor: Actor, reminderId: string, input: Partial<ReminderInput>) {
  const existing = await loadOwned(actor, reminderId);
  await query(
    `UPDATE reminders SET
       title = COALESCE($2, title),
       notes = CASE WHEN $3 THEN $4 ELSE notes END,
       kind = COALESCE($5, kind),
       due_on = COALESCE($6, due_on),
       lead_days = COALESCE($7, lead_days),
       repeat_every = COALESCE($8, repeat_every),
       repeat_interval = COALESCE($9, repeat_interval),
       amount = CASE WHEN $10 THEN $11 ELSE amount END,
       currency = CASE WHEN $10 THEN $12 ELSE currency END,
       -- Changing the dates means the old "already told them" no longer applies.
       last_notified_on = CASE WHEN $6 IS NULL AND $7 IS NULL THEN last_notified_on ELSE NULL END
     WHERE id = $1`,
    [
      reminderId, input.title?.trim() ?? null,
      input.notes !== undefined, input.notes?.trim() || null,
      input.kind ?? null, input.dueOn?.slice(0, 10) ?? null,
      input.leadDays ?? null, input.repeatEvery ?? null, input.repeatInterval ?? null,
      input.amount !== undefined, input.amount ?? null, input.currency ?? null,
    ],
  );
  if (input.watcherIds) {
    await transaction(async (tx) => {
      await tx.query('DELETE FROM reminder_watchers WHERE reminder_id = $1', [reminderId]);
      await addWatchers(tx, reminderId, actor, input.watcherIds!);
    });
  }
  await auditFromActor(actor, 'reminder.update', {
    resourceType: 'reminder', resourceId: reminderId, metadata: { title: existing.title },
  });
  return getReminder(actor, reminderId);
}

/**
 * Done with this one.
 *
 * A repeating reminder is not finished by being done — it moves to its next date and
 * starts again, which is the difference between a subscription and an errand. Stopping
 * one for good is `cancel`.
 */
export async function complete(actor: Actor, reminderId: string) {
  const row = await loadOwned(actor, reminderId);
  const today = isoDay(new Date());
  const dueOn = toDay(row.due_on);
  const next = nextDue(dueOn, row.repeat_every, Number(row.repeat_interval));

  if (next) {
    await query(
      `UPDATE reminders
          SET due_on = $2, snoozed_until = NULL, last_notified_on = NULL
        WHERE id = $1`,
      [reminderId, catchUp(next, row.repeat_every, Number(row.repeat_interval), today)],
    );
  } else {
    await query(
      `UPDATE reminders
          SET status = 'done', completed_at = NOW(3), completed_by = $2
        WHERE id = $1`,
      [reminderId, actor.userId],
    );
  }
  await auditFromActor(actor, 'reminder.complete', {
    resourceType: 'reminder', resourceId: reminderId,
  });
  return getReminder(actor, reminderId);
}

/** Quiet until a day, without pretending it is done. */
export async function snooze(actor: Actor, reminderId: string, until: string) {
  await loadOwned(actor, reminderId);
  const day = until.slice(0, 10);
  if (day <= isoDay(new Date())) throw badRequest('Choose a day in the future');
  await query('UPDATE reminders SET snoozed_until = $2 WHERE id = $1', [reminderId, day]);
  return getReminder(actor, reminderId);
}

export async function cancel(actor: Actor, reminderId: string): Promise<void> {
  await loadOwned(actor, reminderId);
  await query(
    `UPDATE reminders SET status = 'cancelled', completed_at = NOW(3), completed_by = $2
      WHERE id = $1`,
    [reminderId, actor.userId],
  );
  await auditFromActor(actor, 'reminder.cancel', {
    resourceType: 'reminder', resourceId: reminderId,
  });
}

/* --------------------------------------------------------------- the nagging */

/**
 * Everything that should be mentioned today, mentioned once.
 *
 * Run from the scheduler. `last_notified_on` is what makes it once a day rather than
 * once a tick, and it is written in the same statement that selects, so two instances
 * racing cannot both send.
 */
export async function notifyDue(): Promise<{ notified: number }> {
  const today = isoDay(new Date());
  const rows = await many<ReminderRow & { company_id: string }>(
    `SELECT r.* FROM reminders r
      WHERE r.status = 'active'
        AND (r.snoozed_until IS NULL OR r.snoozed_until <= $1)
        AND (r.last_notified_on IS NULL OR r.last_notified_on < $1)
        -- The window has opened: due today, overdue, or inside the lead-in.
        AND DATE_SUB(r.due_on, INTERVAL r.lead_days DAY) <= $1
      ORDER BY r.due_on
      LIMIT 500`,
    [today],
  );

  let notified = 0;
  for (const row of rows) {
    const claimed = await query(
      `UPDATE reminders SET last_notified_on = $2
        WHERE id = $1 AND (last_notified_on IS NULL OR last_notified_on < $2)`,
      [row.id, today],
    );
    if (claimed.rowCount === 0) continue; // another instance got there first

    const dueOn = toDay(row.due_on);
    const daysLeft = Math.round(
      (parseDay(dueOn).getTime() - parseDay(today).getTime()) / 86_400_000,
    );
    await emit({
      companyId: row.company_id,
      type: 'reminder.due',
      actorId: null,
      payload: {
        reminderId: row.id,
        title: row.title,
        notes: row.notes,
        kind: row.kind,
        dueOn,
        daysLeft,
        amount: row.amount == null ? null : Number(row.amount),
        currency: row.currency,
        recipients: await audienceOf(row.id, row.owner_id),
      },
    });
    notified += 1;
  }
  return { notified };
}
