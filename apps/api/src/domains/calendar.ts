/**
 * Calendar and meetings domain (blueprint 04/10).
 *
 * All timestamps are stored in UTC alongside an IANA time-zone identifier, so a meeting
 * booked in Colombo reads correctly in London and survives a DST transition.
 * Media transport is delegated to the meeting adapter.
 */
import { many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { meetingDriver, type JoinTicket } from '../adapters/meetings.js';
import * as searchIndex from './search.js';

export type EventRow = {
  id: string;
  company_id: string;
  organizer_id: string;
  title: string;
  description: string;
  location: string | null;
  room_id: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  all_day: boolean;
  recurrence_rule: string | null;
  visibility: string;
  status: string;
  meeting_room_key: string | null;
  meeting_provider: string | null;
  agenda: string;
  notes: string;
  reminder_minutes: number;
  version: number;
};

export type CreateEventInput = {
  title: string;
  description?: string;
  location?: string | null;
  roomId?: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  allDay?: boolean;
  recurrenceRule?: string | null;
  visibility?: 'private' | 'company';
  attendeeIds: string[];
  optionalAttendeeIds?: string[];
  agenda?: string;
  reminderMinutes?: number;
  withVideoRoom?: boolean;
};

function assertValidRecurrence(rule: string | null | undefined): void {
  if (!rule) return;
  // A deliberately small, testable RRULE subset - not a general iCalendar engine.
  if (!/^FREQ=(DAILY|WEEKLY|MONTHLY);?(INTERVAL=\d+;?)?(COUNT=\d+;?)?(UNTIL=\d{8}T\d{6}Z;?)?(BYDAY=[A-Z,]+;?)?$/.test(rule)) {
    throw unprocessable('Unsupported recurrence rule', [
      { field: 'recurrenceRule', message: 'Use FREQ=DAILY|WEEKLY|MONTHLY with optional INTERVAL, COUNT, UNTIL, BYDAY' },
    ]);
  }
}

export async function createEvent(
  actor: Actor,
  input: CreateEventInput,
  correlationId: string,
): Promise<EventRow> {
  await authorize({ actor, capability: 'event.create', resourceless: true });
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw unprocessable('Invalid start or end time', [{ field: 'startsAt', message: 'Use an RFC 3339 timestamp' }]);
  }
  if (endsAt <= startsAt) {
    throw unprocessable('The meeting must end after it starts', [
      { field: 'endsAt', message: 'End time must be later than the start time' },
    ]);
  }
  assertValidRecurrence(input.recurrenceRule);
  if (!isValidTimezone(input.timezone)) {
    throw unprocessable('Unknown time zone', [
      { field: 'timezone', message: 'Use an IANA identifier such as Asia/Colombo' },
    ]);
  }

  // Attendees must belong to the company; cross-tenant invitation is not possible.
  const attendees = await validateAttendees(actor.companyId, [
    ...input.attendeeIds,
    ...(input.optionalAttendeeIds ?? []),
  ]);

  if (input.roomId) {
    await assertRoomAvailable(actor.companyId, input.roomId, startsAt, endsAt, null);
  }

  const meeting = input.withVideoRoom ? await meetingDriver.createRoom(crypto.randomUUID()) : null;

  return transaction(async (tx) => {
    const eventId = newId();
    await tx.query(
      `INSERT INTO calendar_events
         (id, company_id, organizer_id, title, description, location, room_id, starts_at, ends_at,
          timezone, all_day, recurrence_rule, visibility, meeting_room_key, meeting_provider,
          agenda, notes, reminder_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'',$17)`,
      [
        eventId,
        actor.companyId,
        actor.userId,
        input.title.trim(),
        input.description ?? '',
        input.location ?? null,
        input.roomId ?? null,
        startsAt,
        endsAt,
        input.timezone,
        input.allDay ?? false,
        input.recurrenceRule ?? null,
        input.visibility ?? 'company',
        meeting?.roomKey ?? null,
        meeting ? meetingDriver.name : null,
        input.agenda ?? '',
        input.reminderMinutes ?? 10,
      ],
    );
    const event = (await reload<EventRow>(tx, 'calendar_events', eventId))!;

    await tx.query(
      `INSERT INTO event_attendees (event_id, user_id, role, rsvp)
       VALUES ($1,$2,'host','accepted')`,
      [event.id, actor.userId],
    );
    for (const id of input.attendeeIds.filter((a) => a !== actor.userId)) {
      await tx.query(
        `INSERT IGNORE INTO event_attendees (event_id, user_id, role) VALUES ($1,$2,'attendee')`,
        [event.id, id],
      );
    }
    for (const id of (input.optionalAttendeeIds ?? []).filter((a) => a !== actor.userId)) {
      await tx.query(
        `INSERT IGNORE INTO event_attendees (event_id, user_id, role) VALUES ($1,$2,'optional')`,
        [event.id, id],
      );
    }

    await auditFromActor(
      actor,
      'event.create',
      { resourceType: 'calendar_event', resourceId: event.id, correlationId, metadata: { attendees: attendees.length } },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'event.scheduled',
        actorId: actor.userId,
        correlationId,
        payload: { eventId: event.id, attendeeIds: attendees.map((a) => a.id), organizerId: actor.userId },
      },
      tx,
    );
    return event;
  });
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function validateAttendees(companyId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await many<{ id: string }>(
    `SELECT id FROM users
      WHERE company_id = $1 AND JSON_CONTAINS($2, JSON_QUOTE(id)) AND status = 'active'`,
    [companyId, JSON.stringify(unique)],
  );
  if (rows.length !== unique.length) {
    throw unprocessable('One or more attendees are not active accounts in this company', [
      { field: 'attendeeIds', message: 'Remove unknown or inactive people' },
    ]);
  }
  return rows;
}

/** Room double-booking is prevented server-side, not by hiding the button. */
async function assertRoomAvailable(
  companyId: string,
  roomId: string,
  startsAt: Date,
  endsAt: Date,
  excludeEventId: string | null,
): Promise<void> {
  const room = await one<{ id: string; active: boolean }>(
    'SELECT id, active FROM rooms WHERE id = $1 AND company_id = $2',
    [roomId, companyId],
  );
  if (!room || !room.active) throw notFound('Room not found');
  const clash = await one<{ id: string; title: string }>(
    `SELECT id, title FROM calendar_events
      WHERE room_id = $1 AND status = 'confirmed'
        AND ($4 IS NULL OR id <> $4)
        AND starts_at < $3 AND ends_at > $2`,
    [roomId, startsAt, endsAt, excludeEventId],
  );
  if (clash) throw conflict(`That room is already booked for "${clash.title}"`);
}

export async function listEvents(
  actor: Actor,
  range: { from: Date; to: Date; userId?: string },
) {
  const targetUser = range.userId ?? actor.userId;
  if (targetUser !== actor.userId) {
    // Viewing another person's calendar requires calendar.read plus company scope.
    await authorize({ actor, capability: 'calendar.read', resourceless: true });
  }
  const rows = await many<EventRow & { attendee_count: number; rsvp: string | null }>(
    `SELECT e.*,
            (SELECT count(*) FROM event_attendees a WHERE a.event_id = e.id) AS attendee_count,
            me.rsvp
       FROM calendar_events e
       JOIN event_attendees ea ON ea.event_id = e.id AND ea.user_id = $2
       LEFT JOIN event_attendees me ON me.event_id = e.id AND me.user_id = $5
      WHERE e.company_id = $1
        AND e.starts_at < $4 AND e.ends_at > $3
        AND e.status = 'confirmed'
      ORDER BY e.starts_at`,
    [actor.companyId, targetUser, range.from, range.to, actor.userId],
  );
  return rows.map(publicEvent);
}

/** Free/busy shows only availability, never the private content of someone's day. */
export async function freeBusy(actor: Actor, userIds: string[], from: Date, to: Date) {
  const rows = await many<{ user_id: string; starts_at: Date; ends_at: Date }>(
    `SELECT ea.user_id, e.starts_at, e.ends_at
       FROM calendar_events e
       JOIN event_attendees ea ON ea.event_id = e.id
      WHERE e.company_id = $1
        AND JSON_CONTAINS($2, JSON_QUOTE(ea.user_id))
        AND e.status = 'confirmed'
        AND ea.rsvp <> 'declined'
        AND e.starts_at < $4 AND e.ends_at > $3
      ORDER BY e.starts_at`,
    [actor.companyId, JSON.stringify(userIds), from, to],
  );
  const busy: Record<string, { from: Date; to: Date }[]> = {};
  for (const row of rows) {
    (busy[row.user_id] ??= []).push({ from: row.starts_at, to: row.ends_at });
  }
  return busy;
}

export async function getEvent(actor: Actor, eventId: string) {
  const event = await one<EventRow>(
    'SELECT * FROM calendar_events WHERE id = $1 AND company_id = $2',
    [eventId, actor.companyId],
  );
  if (!event) throw notFound('Meeting not found');
  const attendees = await many(
    `SELECT a.user_id, a.role, a.rsvp, u.display_name, u.email_display AS email, u.avatar_color
       FROM event_attendees a JOIN users u ON u.id = a.user_id
      WHERE a.event_id = $1 ORDER BY a.role, u.display_name`,
    [eventId],
  );
  const isAttendee = attendees.some((a) => (a as { user_id: string }).user_id === actor.userId);
  await authorize({
    actor,
    capability: 'calendar.read',
    resourceType: 'calendar_event',
    resourceId: eventId,
    membership: isAttendee || event.visibility === 'company',
  });
  return { ...publicEvent(event), attendees };
}

export async function updateEvent(
  actor: Actor,
  eventId: string,
  input: Partial<CreateEventInput>,
  expectedVersion: number | null,
  correlationId: string,
): Promise<EventRow> {
  const event = await one<EventRow>(
    'SELECT * FROM calendar_events WHERE id = $1 AND company_id = $2',
    [eventId, actor.companyId],
  );
  if (!event) throw notFound('Meeting not found');
  if (expectedVersion !== null && event.version !== expectedVersion) throw preconditionFailed();

  const isHost = event.organizer_id === actor.userId;
  await authorize({
    actor,
    capability: 'event.update',
    resourceType: 'calendar_event',
    resourceId: eventId,
    membership: isHost,
  });

  const startsAt = input.startsAt ? new Date(input.startsAt) : event.starts_at;
  const endsAt = input.endsAt ? new Date(input.endsAt) : event.ends_at;
  if (endsAt <= startsAt) {
    throw unprocessable('The meeting must end after it starts', [
      { field: 'endsAt', message: 'End time must be later than the start time' },
    ]);
  }
  const roomId = input.roomId === undefined ? event.room_id : input.roomId;
  if (roomId) await assertRoomAvailable(actor.companyId, roomId, startsAt, endsAt, eventId);
  assertValidRecurrence(input.recurrenceRule);

  return transaction(async (tx) => {
    await tx.query(
      `UPDATE calendar_events SET
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         location = CASE WHEN $5 THEN $6 ELSE location END,
         room_id = $7,
         starts_at = $8, ends_at = $9,
         timezone = COALESCE($10, timezone),
         recurrence_rule = CASE WHEN $11 THEN $12 ELSE recurrence_rule END,
         agenda = COALESCE($13, agenda),
         reminder_minutes = COALESCE($14, reminder_minutes),
         version = version + 1,
         updated_at = NOW(3)
       WHERE id = $1 AND company_id = $2`,
      [
        eventId,
        actor.companyId,
        input.title ?? null,
        input.description ?? null,
        'location' in input,
        input.location ?? null,
        roomId,
        startsAt,
        endsAt,
        input.timezone ?? null,
        'recurrenceRule' in input,
        input.recurrenceRule ?? null,
        input.agenda ?? null,
        input.reminderMinutes ?? null,
      ],
    );
    const updated = (await reload<EventRow>(tx, 'calendar_events', eventId))!;

    if (input.attendeeIds) {
      await validateAttendees(actor.companyId, input.attendeeIds);
      await tx.query(
        `DELETE FROM event_attendees
          WHERE event_id = $1 AND role <> 'host'
            AND NOT JSON_CONTAINS($2, JSON_QUOTE(user_id))`,
        [eventId, JSON.stringify(input.attendeeIds)],
      );
      for (const id of input.attendeeIds) {
        await tx.query(
          `INSERT IGNORE INTO event_attendees (event_id, user_id, role) VALUES ($1,$2,'attendee')`,
          [eventId, id],
        );
      }
    }

    await auditFromActor(
      actor,
      'event.update',
      { resourceType: 'calendar_event', resourceId: eventId, correlationId,
        before: { startsAt: event.starts_at, endsAt: event.ends_at, roomId: event.room_id },
        after: { startsAt: updated.starts_at, endsAt: updated.ends_at, roomId: updated.room_id } },
      tx,
    );
    await emit(
      { companyId: actor.companyId, type: 'event.updated', actorId: actor.userId, correlationId,
        payload: { eventId, timeChanged: startsAt.getTime() !== event.starts_at.getTime() } },
      tx,
    );
    return updated;
  });
}

export async function cancelEvent(actor: Actor, eventId: string, correlationId: string): Promise<void> {
  const event = await one<EventRow>(
    'SELECT * FROM calendar_events WHERE id = $1 AND company_id = $2',
    [eventId, actor.companyId],
  );
  if (!event) throw notFound('Meeting not found');
  await authorize({
    actor,
    capability: 'event.cancel',
    resourceType: 'calendar_event',
    resourceId: eventId,
    membership: event.organizer_id === actor.userId,
  });
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE calendar_events SET status = 'cancelled', version = version + 1, updated_at = NOW(3) WHERE id = $1`,
      [eventId],
    );
    await auditFromActor(actor, 'event.cancel', { resourceType: 'calendar_event', resourceId: eventId, correlationId }, tx);
    await emit(
      { companyId: actor.companyId, type: 'event.cancelled', actorId: actor.userId, correlationId,
        payload: { eventId, title: event.title } },
      tx,
    );
  });
  await searchIndex.remove('meeting', eventId);
}

export async function respond(
  actor: Actor,
  eventId: string,
  rsvp: 'accepted' | 'declined' | 'tentative',
): Promise<void> {
  const res = await pool.query(
    `UPDATE event_attendees SET rsvp = $3, responded_at = NOW(3)
      WHERE event_id = $1 AND user_id = $2`,
    [eventId, actor.userId, rsvp],
  );
  if (res.rowCount === 0) throw forbidden('You are not invited to this meeting');
  await auditFromActor(actor, 'event.rsvp', {
    resourceType: 'calendar_event',
    resourceId: eventId,
    metadata: { rsvp },
  });
  await emit({
    companyId: actor.companyId,
    type: 'event.rsvp',
    actorId: actor.userId,
    payload: { eventId, userId: actor.userId, rsvp },
  });
}

/**
 * Join ticket. Authorization is rechecked at join time, so a person suspended or
 * removed after the invitation was sent cannot enter the room.
 */
export async function joinMeeting(actor: Actor, eventId: string): Promise<JoinTicket & { event: ReturnType<typeof publicEvent> }> {
  const event = await one<EventRow>(
    `SELECT * FROM calendar_events WHERE id = $1 AND company_id = $2 AND status = 'confirmed'`,
    [eventId, actor.companyId],
  );
  if (!event) throw notFound('Meeting not found');
  const attendee = await one<{ role: string }>(
    'SELECT role FROM event_attendees WHERE event_id = $1 AND user_id = $2',
    [eventId, actor.userId],
  );
  await authorize({
    actor,
    capability: 'meeting.join',
    resourceType: 'calendar_event',
    resourceId: eventId,
    membership: Boolean(attendee) || event.visibility === 'company',
  });

  const isHost = attendee?.role === 'host' || event.organizer_id === actor.userId;
  const roomKey = event.meeting_room_key ?? `iw-${event.id}`;
  const ticket = await meetingDriver.issueToken({
    roomKey,
    userId: actor.userId,
    companyId: actor.companyId,
    displayName: actor.displayName,
    role: isHost ? 'host' : 'participant',
    canPublish: true,
    canScreenShare: true,
    canRecord: isHost && actor.capabilities.has('recording.start'),
  });

  await pool.query(
    `INSERT INTO meeting_participants (id, company_id, event_id, user_id, role)
     VALUES ($1,$2,$3,$4,$5)`,
    [newId(), actor.companyId, eventId, actor.userId, isHost ? 'host' : 'participant'],
  );
  await auditFromActor(actor, 'meeting.join', {
    resourceType: 'calendar_event',
    resourceId: eventId,
    metadata: { provider: ticket.provider, degraded: ticket.degraded },
  });
  return { ...ticket, event: publicEvent(event) };
}

export async function listRooms(companyId: string) {
  return many('SELECT id, name, capacity, location, active FROM rooms WHERE company_id = $1 ORDER BY name', [
    companyId,
  ]);
}

export function publicEvent(row: EventRow & { attendee_count?: number; rsvp?: string | null }) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    roomId: row.room_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    allDay: row.all_day,
    recurrenceRule: row.recurrence_rule,
    visibility: row.visibility,
    status: row.status,
    organizerId: row.organizer_id,
    hasVideoRoom: Boolean(row.meeting_room_key),
    meetingProvider: row.meeting_provider,
    agenda: row.agenda,
    notes: row.notes,
    reminderMinutes: row.reminder_minutes,
    attendeeCount: row.attendee_count,
    myRsvp: row.rsvp ?? null,
    version: row.version,
  };
}
