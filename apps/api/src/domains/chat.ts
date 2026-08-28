/**
 * Chat domain (blueprint 04).
 *
 * Real-time delivery uses WebSocket; the database remains the source of truth. Every
 * message gets a monotonic per-room sequence so a reconnecting client can catch up
 * exactly, without gaps or duplicates.
 */
import { jsonArray, many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { publish } from '../core/realtime.js';
import * as searchIndex from './search.js';

export type RoomRow = {
  id: string;
  company_id: string;
  type: 'channel' | 'group' | 'direct';
  name: string | null;
  topic: string | null;
  visibility: string;
  direct_key: string | null;
  created_by: string | null;
  archived_at: Date | null;
  last_message_at: Date | null;
};

export type MessageRow = {
  id: string;
  room_id: string;
  seq: number;
  author_id: string | null;
  parent_id: string | null;
  body: string;
  mentions: unknown;
  file_id: string | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
};

/** Membership is the authorization boundary for every chat operation. */
export async function membership(roomId: string, userId: string) {
  return one<{ role: string; read_cursor: number }>(
    'SELECT role, read_cursor FROM chat_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
}

export async function requireMembership(actor: Actor, roomId: string, capability = 'room.join') {
  const room = await one<RoomRow>('SELECT * FROM chat_rooms WHERE id = $1 AND company_id = $2', [
    roomId,
    actor.companyId,
  ]);
  if (!room) throw notFound('Conversation not found');
  const member = await membership(roomId, actor.userId);
  // Open company channels may be joined by any active employee; everything else requires
  // an existing membership or an explicit grant.
  const openChannel = room.type === 'channel' && room.visibility === 'company';
  await authorize({
    actor,
    capability,
    resourceType: 'chat_room',
    resourceId: roomId,
    membership: Boolean(member) || openChannel,
  });
  return { room, member };
}

export async function createChannel(
  actor: Actor,
  input: { name: string; topic?: string; visibility: 'private' | 'company'; memberIds: string[] },
): Promise<RoomRow> {
  await authorize({ actor, capability: 'room.create', resourceless: true });
  const name = input.name.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9][a-z0-9-_]{1,60}$/.test(name)) {
    throw unprocessable('Channel name is not valid', [
      { field: 'name', message: 'Use 2-60 letters, numbers, hyphens or underscores' },
    ]);
  }
  return transaction(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM chat_rooms WHERE company_id = $1 AND lower(name) = $2', [
      actor.companyId,
      name,
    ]);
    if (existing.rowCount && existing.rowCount > 0) throw conflict('A channel with that name already exists');

    const roomId = newId();
    await tx.query(
      `INSERT INTO chat_rooms (id, company_id, type, name, topic, visibility, created_by)
       VALUES ($1,$2,'channel',$3,$4,$5,$6)`,
      [roomId, actor.companyId, name, input.topic ?? null, input.visibility, actor.userId],
    );
    const room = (await reload<RoomRow>(tx, 'chat_rooms', roomId))!;
    await tx.query(`INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'owner')`, [
      room.id,
      actor.userId,
    ]);
    for (const userId of input.memberIds.filter((id) => id !== actor.userId)) {
      await tx.query(
        `INSERT IGNORE INTO chat_members (room_id, user_id) SELECT $1, id FROM users
          WHERE id = $2 AND company_id = $3 AND status = 'active'`,
        [room.id, userId, actor.companyId],
      );
    }
    await auditFromActor(actor, 'chat.room_create', { resourceType: 'chat_room', resourceId: room.id }, tx);
    return room;
  });
}

/** Direct conversations are keyed by the sorted participant pair, so they are never duplicated. */
export async function openDirect(actor: Actor, otherUserId: string): Promise<RoomRow> {
  if (otherUserId === actor.userId) throw unprocessable('Choose someone else to message', []);
  const other = await one<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND company_id = $2 AND status = 'active'`,
    [otherUserId, actor.companyId],
  );
  if (!other) throw notFound('Person not found');

  const key = [actor.userId, otherUserId].sort().join(':');
  return transaction(async (tx) => {
    const existing = await tx.query<RoomRow>(
      'SELECT * FROM chat_rooms WHERE company_id = $1 AND direct_key = $2',
      [actor.companyId, key],
    );
    if (existing.rows[0]) return existing.rows[0];
    const roomId = newId();
    await tx.query(
      `INSERT INTO chat_rooms (id, company_id, type, visibility, direct_key, created_by)
       VALUES ($1,$2,'direct','private',$3,$4)`,
      [roomId, actor.companyId, key, actor.userId],
    );
    const room = (await reload<RoomRow>(tx, 'chat_rooms', roomId))!;
    for (const userId of [actor.userId, otherUserId]) {
      await tx.query(`INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'member')`, [
        room.id,
        userId,
      ]);
    }
    return room;
  });
}

export async function listRooms(actor: Actor) {
  return many<{
    id: string;
    type: string;
    name: string | null;
    topic: string | null;
    last_message_at: Date | null;
    unread: number;
    counterpart_name: string | null;
    counterpart_id: string | null;
  }>(
    `SELECT r.id, r.type, r.name, r.topic, r.last_message_at,
            (SELECT count(*) FROM chat_messages m
              WHERE m.room_id = r.id AND m.seq > cm.read_cursor AND m.deleted_at IS NULL
                AND m.author_id <> $2) AS unread,
            (SELECT u.display_name FROM chat_members c2
               JOIN users u ON u.id = c2.user_id
              WHERE c2.room_id = r.id AND c2.user_id <> $2 AND r.type = 'direct'
              LIMIT 1) AS counterpart_name,
            (SELECT u.id FROM chat_members c2
               JOIN users u ON u.id = c2.user_id
              WHERE c2.room_id = r.id AND c2.user_id <> $2 AND r.type = 'direct'
              LIMIT 1) AS counterpart_id
       FROM chat_rooms r
       JOIN chat_members cm ON cm.room_id = r.id AND cm.user_id = $2
      WHERE r.company_id = $1 AND r.archived_at IS NULL
      -- MySQL sorts NULLs first on DESC, so the guard reproduces NULLS LAST.
      ORDER BY r.last_message_at IS NULL, r.last_message_at DESC, r.id`,
    [actor.companyId, actor.userId],
  );
}

export async function history(
  actor: Actor,
  roomId: string,
  opts: { before?: number; after?: number; limit: number },
) {
  await requireMembership(actor, roomId);
  const rows = await many<MessageRow & { author_name: string | null; avatar_color: string | null }>(
    `SELECT m.*, u.display_name AS author_name, u.avatar_color
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.room_id = $1
        AND ($2 IS NULL OR m.seq < $2)
        AND ($3 IS NULL OR m.seq > $3)
      ORDER BY m.seq DESC
      LIMIT $4`,
    [roomId, opts.before ?? null, opts.after ?? null, opts.limit],
  );
  return rows.reverse().map(publicMessage);
}

export async function send(
  actor: Actor,
  roomId: string,
  input: { body: string; parentId?: string | null; fileId?: string | null; mentions?: string[] },
): Promise<MessageRow> {
  const { room } = await requireMembership(actor, roomId, 'message.send');
  if (room.archived_at) throw conflict('This conversation is archived');
  const body = input.body.trim();
  if (!body && !input.fileId) {
    throw unprocessable('Message cannot be empty', [{ field: 'body', message: 'Write something' }]);
  }
  if (body.length > 8000) {
    throw unprocessable('Message is too long', [{ field: 'body', message: 'Maximum 8000 characters' }]);
  }

  const message = await transaction(async (tx) => {
    // Joining an open channel by posting also creates the membership row.
    await tx.query(
      `INSERT IGNORE INTO chat_members (room_id, user_id) VALUES ($1,$2)`,
      [roomId, actor.userId],
    );
    // Serialise sequence allocation by locking the room row itself. Postgres does not
    // allow FOR UPDATE alongside an aggregate, and locking the parent is what actually
    // orders concurrent senders: two posts to the same room cannot claim the same seq.
    await tx.query('SELECT 1 FROM chat_rooms WHERE id = $1 FOR UPDATE', [roomId]);
    const seqRes = await tx.query<{ seq: number }>(
      `SELECT COALESCE(max(seq), 0) + 1 AS seq FROM chat_messages WHERE room_id = $1`,
      [roomId],
    );
    const seq = seqRes.rows[0]?.seq ?? 1;

    const messageId = newId();
    await tx.query(
      `INSERT INTO chat_messages
         (id, company_id, room_id, seq, author_id, parent_id, body, mentions, file_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        messageId,
        actor.companyId,
        roomId,
        seq,
        actor.userId,
        input.parentId ?? null,
        body,
        JSON.stringify(input.mentions ?? []),
        input.fileId ?? null,
      ],
    );
    await tx.query('UPDATE chat_rooms SET last_message_at = NOW(3) WHERE id = $1', [roomId]);
    await tx.query(
      'UPDATE chat_members SET read_cursor = $3 WHERE room_id = $1 AND user_id = $2',
      [roomId, actor.userId, seq],
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'chat.message.created',
        actorId: actor.userId,
        payload: { roomId, messageId, mentions: input.mentions ?? [] },
      },
      tx,
    );
    return (await reload<MessageRow>(tx, 'chat_messages', messageId))!;
  });

  // Fan out only after the row is durably committed.
  publish(`room:${roomId}`, 'message.created', {
    ...publicMessage({ ...message, author_name: actor.displayName, avatar_color: null }),
    roomId,
  });
  return message;
}

export async function edit(actor: Actor, roomId: string, messageId: string, body: string) {
  await requireMembership(actor, roomId, 'message.edit');
  const existing = await one<MessageRow>(
    'SELECT * FROM chat_messages WHERE id = $1 AND room_id = $2',
    [messageId, roomId],
  );
  if (!existing || existing.deleted_at) throw notFound('Message not found');
  if (existing.author_id !== actor.userId) throw forbidden('You can only edit your own messages');

  await pool.query(
    `UPDATE chat_messages SET body = $3, edited_at = NOW(3) WHERE id = $1 AND room_id = $2`,
    [messageId, roomId, body.trim()],
  );
  publish(`room:${roomId}`, 'message.updated', { id: messageId, body: body.trim(), roomId });
  return (await reload<MessageRow>(pool, 'chat_messages', messageId))!;
}

/**
 * Deletion is a moderation action: the row is tombstoned rather than removed, so the
 * retention and audit obligations still hold.
 */
export async function remove(actor: Actor, roomId: string, messageId: string) {
  const { member } = await requireMembership(actor, roomId, 'message.delete');
  const existing = await one<MessageRow>(
    'SELECT * FROM chat_messages WHERE id = $1 AND room_id = $2',
    [messageId, roomId],
  );
  if (!existing || existing.deleted_at) throw notFound('Message not found');
  const isModerator = member?.role === 'owner' || member?.role === 'moderator';
  if (existing.author_id !== actor.userId && !isModerator && !actor.capabilities.has('moderation.manage')) {
    throw forbidden('You can only delete your own messages');
  }
  await pool.query(
    `UPDATE chat_messages SET deleted_at = NOW(3), deleted_by = $3, body = '' WHERE id = $1 AND room_id = $2`,
    [messageId, roomId, actor.userId],
  );
  await auditFromActor(actor, 'chat.message_delete', {
    resourceType: 'chat_room',
    resourceId: roomId,
    metadata: { messageId, moderated: existing.author_id !== actor.userId },
  });
  await searchIndex.remove('chat', messageId);
  publish(`room:${roomId}`, 'message.deleted', { id: messageId, roomId });
}

export async function markRead(actor: Actor, roomId: string, seq: number): Promise<void> {
  await pool.query(
    `UPDATE chat_members SET read_cursor = GREATEST(read_cursor, $3) WHERE room_id = $1 AND user_id = $2`,
    [roomId, actor.userId, seq],
  );
}

export async function addMembers(actor: Actor, roomId: string, userIds: string[]): Promise<void> {
  const { room, member } = await requireMembership(actor, roomId, 'member.manage');
  if (room.type === 'direct') throw conflict('People cannot be added to a direct conversation');
  if (member?.role !== 'owner' && !actor.capabilities.has('member.manage')) {
    throw forbidden('Only a channel owner can add people');
  }
  for (const userId of userIds) {
    await pool.query(
      `INSERT IGNORE INTO chat_members (room_id, user_id) SELECT $1, id FROM users
        WHERE id = $2 AND company_id = $3 AND status = 'active'`,
      [roomId, userId, actor.companyId],
    );
  }
  await auditFromActor(actor, 'chat.members_added', {
    resourceType: 'chat_room',
    resourceId: roomId,
    metadata: { count: userIds.length },
  });
  await emit({
    companyId: actor.companyId,
    type: 'chat.member.added',
    actorId: actor.userId,
    payload: { roomId, userIds },
  });
}

export async function listMembers(actor: Actor, roomId: string) {
  await requireMembership(actor, roomId);
  return many(
    `SELECT cm.user_id, cm.role, u.display_name, u.email_display AS email, u.avatar_color, u.status
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.room_id = $1 ORDER BY cm.role, u.display_name`,
    [roomId],
  );
}

export async function react(actor: Actor, roomId: string, messageId: string, emoji: string): Promise<void> {
  await requireMembership(actor, roomId);
  const clean = emoji.slice(0, 16);
  const existing = await one('SELECT 1 FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
    messageId,
    actor.userId,
    clean,
  ]);
  if (existing) {
    await pool.query('DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
      messageId,
      actor.userId,
      clean,
    ]);
  } else {
    await pool.query(
      'INSERT IGNORE INTO chat_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)',
      [messageId, actor.userId, clean],
    );
  }
  publish(`room:${roomId}`, 'message.reacted', { messageId, emoji: clean, userId: actor.userId });
}

/** Typing and presence are ephemeral: broadcast only, never persisted. */
export async function typing(actor: Actor, roomId: string): Promise<void> {
  const member = await membership(roomId, actor.userId);
  if (!member) return;
  publish(`room:${roomId}`, 'typing', { userId: actor.userId, displayName: actor.displayName });
}

export function publicMessage(row: MessageRow & { author_name?: string | null; avatar_color?: string | null }) {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: Number(row.seq),
    authorId: row.author_id,
    authorName: row.author_name ?? null,
    avatarColor: row.avatar_color ?? null,
    parentId: row.parent_id,
    body: row.deleted_at ? '' : row.body,
    mentions: jsonArray(row.mentions),
    fileId: row.file_id,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted_at),
    createdAt: row.created_at,
  };
}
