/**
 * Attendance: clocking in, clocking out, and what has to be shown for the time claimed.
 *
 * The policy this encodes is deliberately small, because it is the only one there is:
 * six hours a day, counted across however many sessions it took. There are no fixed
 * working hours, so nothing here cares what time of day the work happened.
 *
 * Three rules are worth stating plainly, because they are the ones that shape the code:
 *
 *  1. A session is closed by the server, not by the client. The app reports that it is
 *     still there; when it stops, the server closes the session. A graceful "I am
 *     quitting" message cannot be relied on - a crash, a kill, or a flat battery sends
 *     nothing at all - so the heartbeat is the mechanism and the goodbye is a courtesy.
 *
 *  2. A clock-out without a note and evidence is still recorded. Refusing it would mean
 *     the time is simply lost, and somebody who genuinely worked would be punished for
 *     a missing attachment. It is recorded and flagged for a reviewer instead.
 *
 *  3. The reviewer's decision is separate from the flag. A flag says "look at this"; the
 *     decision says "this counts" or "it does not".
 */
import { many, newId, one, pool, transaction } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';

/** The whole policy: six hours a day. */
export const MINIMUM_MINUTES_PER_DAY = 6 * 60;

/**
 * How long the server waits after the last heartbeat before closing a session.
 *
 * Long enough to survive a sleeping laptop briefly losing the network, short enough that
 * a forgotten session does not accrue hours nobody worked. The heartbeat itself is far
 * more frequent, so several may be missed before this trips.
 */
export const STALE_AFTER_MINUTES = 6;

export type SessionRow = {
  id: string;
  company_id: string;
  user_id: string;
  clocked_in_at: Date;
  clocked_out_at: Date | null;
  worked_minutes: number | null;
  close_reason: string;
  last_seen_at: Date;
  note: string | null;
  flagged: number;
  flag_reason: string | null;
  review_state: string;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
};

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - new Date(from).getTime()) / 60000));

/**
 * The local calendar day a moment falls in, as `YYYY-MM-DD`.
 *
 * Attendance is counted per working day, and a working day is the one the person was
 * living in - not UTC. A Colombo team is UTC+5:30, so a UTC day would cut their day in
 * half at half past five in the morning.
 */
export function localDay(at: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at));
  } catch {
    // An unknown timezone must not stop somebody clocking in.
    return new Date(at).toISOString().slice(0, 10);
  }
}

async function timezoneOf(userId: string): Promise<string | null> {
  const row = await one<{ timezone: string | null }>(
    'SELECT timezone FROM users WHERE id = $1', [userId],
  );
  return row?.timezone ?? null;
}

/** The session currently running for this person, if any. */
export async function currentSession(actor: Actor): Promise<SessionRow | null> {
  return (await one<SessionRow>(
    `SELECT * FROM attendance_sessions
      WHERE company_id = $1 AND user_id = $2 AND close_reason = 'open'
      ORDER BY clocked_in_at DESC LIMIT 1`,
    [actor.companyId, actor.userId],
  )) ?? null;
}

export async function clockIn(actor: Actor): Promise<SessionRow> {
  await authorize({ actor, capability: 'attendance.record', resourceless: true });

  const open = await currentSession(actor);
  // Idempotent rather than an error: a reconnecting app should not be told off for
  // asking, and two clock-ins would make the day's total meaningless.
  if (open) return open;

  const id = newId();
  await pool.query(
    `INSERT INTO attendance_sessions
       (id, company_id, user_id, clocked_in_at, last_seen_at, close_reason)
     VALUES ($1,$2,$3,NOW(3),NOW(3),'open')`,
    [id, actor.companyId, actor.userId],
  );
  await auditFromActor(actor, 'attendance.clock_in', {
    resourceType: 'attendance_session', resourceId: id,
  });
  return (await one<SessionRow>('SELECT * FROM attendance_sessions WHERE id = $1', [id]))!;
}

/**
 * The app saying it is still running.
 *
 * Cheap on purpose - one indexed UPDATE - because it is called for every clocked-in
 * person for as long as they are working.
 */
export async function heartbeat(actor: Actor): Promise<{ open: boolean }> {
  const res = await pool.query(
    `UPDATE attendance_sessions SET last_seen_at = NOW(3)
      WHERE company_id = $1 AND user_id = $2 AND close_reason = 'open'`,
    [actor.companyId, actor.userId],
  );
  return { open: (res.rowCount ?? 0) > 0 };
}

/**
 * Clocking out.
 *
 * The note and the evidence are what turn "I was logged in" into "here is the work".
 * Both are expected; neither is enforced, because refusing the clock-out would lose the
 * time altogether. What is missing is named in the flag so the reviewer knows what to
 * ask for.
 */
export async function clockOut(
  actor: Actor,
  input: { note?: string | null; evidenceFileIds?: string[] },
): Promise<SessionRow> {
  await authorize({ actor, capability: 'attendance.record', resourceless: true });

  const open = await currentSession(actor);
  if (!open) throw conflict('You are not clocked in');

  const note = (input.note ?? '').trim();
  const fileIds = [...new Set(input.evidenceFileIds ?? [])];

  // Only files this person may actually read, so an id cannot be used to attach
  // somebody else's document as evidence.
  const usable = fileIds.length === 0 ? [] : await many<{ id: string }>(
    `SELECT id FROM files
      WHERE company_id = $1 AND state <> 'recycled'
        AND id IN (${fileIds.map((_, i) => `$${i + 2}`).join(',')})`,
    [actor.companyId, ...fileIds],
  );

  const missing: string[] = [];
  if (!note) missing.push('no note');
  if (usable.length === 0) missing.push('no evidence');

  const session = await transaction(async (tx) => {
    await tx.query(
      `UPDATE attendance_sessions
          SET clocked_out_at = NOW(3),
              worked_minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, clocked_in_at, NOW(3))),
              close_reason = 'manual',
              note = $1,
              flagged = $2,
              flag_reason = $3,
              last_seen_at = NOW(3)
        WHERE id = $4`,
      [note || null, missing.length > 0 ? 1 : 0,
       missing.length > 0 ? `Clocked out with ${missing.join(' and ')}` : null, open.id],
    );

    for (const file of usable) {
      await tx.query(
        `INSERT IGNORE INTO attendance_evidence (id, company_id, session_id, file_id)
         VALUES ($1,$2,$3,$4)`,
        [newId(), actor.companyId, open.id, file.id],
      );
    }

    await auditFromActor(actor, 'attendance.clock_out', {
      resourceType: 'attendance_session',
      resourceId: open.id,
      metadata: { flagged: missing.length > 0, evidence: usable.length },
    }, tx);

    const saved = (await tx.query<SessionRow>(
      'SELECT * FROM attendance_sessions WHERE id = $1', [open.id],
    )).rows[0]!;

    // Reviewers are told about the ones needing attention, not about every clock-out.
    if (missing.length > 0) {
      await emit({
        companyId: actor.companyId,
        type: 'attendance.flagged',
        actorId: actor.userId,
        payload: { sessionId: open.id, userId: actor.userId, reason: saved.flag_reason },
      }, tx);
    }
    return saved;
  });

  return session;
}

/**
 * Closes sessions whose app has stopped reporting.
 *
 * This is the auto clock-out. Run from the scheduler, because the event it responds to
 * is an absence - no message arrives to say the app died.
 *
 * Always flagged: nobody wrote a note or attached anything, and the end time is the last
 * moment we know the person was there rather than now, so a laptop left shut overnight
 * cannot claim the night.
 */
export async function closeStaleSessions(): Promise<{ closed: number }> {
  const stale = await many<{ id: string; company_id: string; user_id: string }>(
    `SELECT id, company_id, user_id FROM attendance_sessions
      WHERE close_reason = 'open'
        AND last_seen_at < DATE_SUB(NOW(3), INTERVAL ${STALE_AFTER_MINUTES} MINUTE)`,
  );
  if (stale.length === 0) return { closed: 0 };

  for (const session of stale) {
    await pool.query(
      `UPDATE attendance_sessions
          SET clocked_out_at = last_seen_at,
              worked_minutes = GREATEST(0, TIMESTAMPDIFF(MINUTE, clocked_in_at, last_seen_at)),
              close_reason = 'auto',
              flagged = 1,
              flag_reason = 'The app stopped running, so this was closed automatically with no note or evidence'
        WHERE id = $1 AND close_reason = 'open'`,
      [session.id],
    );
    await emit({
      companyId: session.company_id,
      type: 'attendance.flagged',
      actorId: null,
      payload: { sessionId: session.id, userId: session.user_id, reason: 'auto clock-out' },
    });
  }
  return { closed: stale.length };
}

type DaySummary = {
  day: string;
  minutes: number;
  sessions: number;
  meetsMinimum: boolean;
  flagged: boolean;
  workingDay: boolean;
};

/**
 * Saturday and Sunday are not working days.
 *
 * People may still clock in on one — plenty do — and the time is recorded exactly as any
 * other. What changes is only the policy: the six-hour minimum is a weekday expectation,
 * so a short Saturday is not a shortfall and is not held against anyone. The day string is
 * already a local calendar date, so it is read back at UTC noon to keep it that date.
 */
export function isWorkingDay(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** Sessions grouped into the working days they belong to, with the policy applied. */
function summarise(rows: SessionRow[], timezone: string | null): DaySummary[] {
  const days = new Map<string, DaySummary>();
  for (const row of rows) {
    const day = localDay(row.clocked_in_at, timezone);
    const minutes = row.worked_minutes ?? minutesBetween(row.clocked_in_at, new Date());
    const entry = days.get(day)
      ?? { day, minutes: 0, sessions: 0, meetsMinimum: false, flagged: false, workingDay: isWorkingDay(day) };
    entry.minutes += minutes;
    entry.sessions += 1;
    entry.flagged = entry.flagged || row.flagged === 1;
    days.set(day, entry);
  }
  for (const entry of days.values()) {
    entry.meetsMinimum = !entry.workingDay || entry.minutes >= MINIMUM_MINUTES_PER_DAY;
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** My own attendance. */
export async function myAttendance(actor: Actor, days = 30) {
  await authorize({ actor, capability: 'attendance.record', resourceless: true });
  const timezone = await timezoneOf(actor.userId);
  const rows = await many<SessionRow>(
    `SELECT * FROM attendance_sessions
      WHERE company_id = $1 AND user_id = $2
        AND clocked_in_at > DATE_SUB(NOW(3), INTERVAL ${Math.min(365, Math.max(1, days))} DAY)
      ORDER BY clocked_in_at DESC`,
    [actor.companyId, actor.userId],
  );
  const open = rows.find((r) => r.close_reason === 'open') ?? null;
  return {
    open,
    sessions: rows,
    days: summarise(rows, timezone),
    minimumMinutes: MINIMUM_MINUTES_PER_DAY,
    today: summarise(rows, timezone).find((d) => d.day === localDay(new Date(), timezone)) ?? null,
  };
}

/** Everyone's attendance, for a reviewer. */
export async function listForReview(
  actor: Actor,
  filters: { state?: string; flaggedOnly?: boolean; userId?: string; days?: number; limit?: number },
) {
  await authorize({ actor, capability: 'attendance.review', resourceless: true });
  const days = Math.min(365, Math.max(1, filters.days ?? 30));
  const rows = await many<SessionRow & {
    display_name: string; timezone: string | null; evidence_count: number; reviewer_name: string | null;
  }>(
    `SELECT s.*, u.display_name, u.timezone,
            (SELECT COUNT(*) FROM attendance_evidence e WHERE e.session_id = s.id) AS evidence_count,
            r.display_name AS reviewer_name
       FROM attendance_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users r ON r.id = s.reviewed_by
      WHERE s.company_id = $1
        AND s.clocked_in_at > DATE_SUB(NOW(3), INTERVAL ${days} DAY)
        AND ($2 IS NULL OR s.review_state = $2)
        AND ($3 = 0 OR s.flagged = 1)
        AND ($4 IS NULL OR s.user_id = $4)
      ORDER BY s.flagged DESC, s.clocked_in_at DESC
      LIMIT $5`,
    [
      actor.companyId,
      filters.state ?? null,
      filters.flaggedOnly ? 1 : 0,
      filters.userId ?? null,
      Math.min(500, filters.limit ?? 100),
    ],
  );
  return rows.map((row) => ({ ...row, day: localDay(row.clocked_in_at, row.timezone) }));
}

/** One session, with its evidence, for whoever is allowed to see it. */
export async function getSession(actor: Actor, sessionId: string) {
  const session = await one<SessionRow & { display_name: string; timezone: string | null }>(
    `SELECT s.*, u.display_name, u.timezone
       FROM attendance_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.company_id = $2`,
    [sessionId, actor.companyId],
  );
  if (!session) throw notFound('That attendance record could not be found');

  // Your own record, or a reviewer's. Nobody else's business.
  if (session.user_id !== actor.userId) {
    await authorize({ actor, capability: 'attendance.review', resourceless: true });
  }

  const evidence = await many<{
    id: string; file_id: string; name: string; mime_type: string | null; size_bytes: number;
  }>(
    `SELECT e.id, e.file_id, f.name, f.mime_type, f.size_bytes
       FROM attendance_evidence e JOIN files f ON f.id = e.file_id
      WHERE e.session_id = $1 ORDER BY e.created_at`,
    [sessionId],
  );

  return { ...session, day: localDay(session.clocked_in_at, session.timezone), evidence };
}

/**
 * A reviewer's decision.
 *
 * Recorded against the reviewer with a note, because "disqualified" without a reason is
 * something the person cannot act on. Reversible: a decision made on a misread record
 * should be correctable, and the audit trail keeps both.
 */
export async function review(
  actor: Actor,
  sessionId: string,
  input: { state: 'approved' | 'disqualified'; note?: string | null },
): Promise<SessionRow> {
  await authorize({ actor, capability: 'attendance.review', resourceless: true });

  const session = await one<SessionRow>(
    'SELECT * FROM attendance_sessions WHERE id = $1 AND company_id = $2',
    [sessionId, actor.companyId],
  );
  if (!session) throw notFound('That attendance record could not be found');
  if (session.close_reason === 'open') {
    throw conflict('This session is still running. It can be reviewed once it has ended.');
  }
  if (session.user_id === actor.userId) {
    throw forbidden('You cannot review your own attendance');
  }

  const note = (input.note ?? '').trim();
  if (input.state === 'disqualified' && !note) {
    throw badRequest('Say why the work was disqualified — the person needs to know what to fix');
  }

  await pool.query(
    `UPDATE attendance_sessions
        SET review_state = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(3)
      WHERE id = $4`,
    [input.state, note || null, actor.userId, sessionId],
  );
  await auditFromActor(actor, 'attendance.reviewed', {
    resourceType: 'attendance_session',
    resourceId: sessionId,
    metadata: { state: input.state },
  });
  await emit({
    companyId: actor.companyId,
    type: 'attendance.reviewed',
    actorId: actor.userId,
    payload: { sessionId, userId: session.user_id, state: input.state, note: note || null },
  });

  return (await one<SessionRow>('SELECT * FROM attendance_sessions WHERE id = $1', [sessionId]))!;
}
