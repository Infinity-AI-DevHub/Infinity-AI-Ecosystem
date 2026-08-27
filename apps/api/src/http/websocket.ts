/**
 * WebSocket gateway (blueprint 08).
 *
 * The connection is authenticated before it is registered, and every channel
 * subscription is authorized against the database - a client cannot subscribe to a room
 * or project it does not belong to by simply naming it.
 */
import type { FastifyInstance } from 'fastify';
import { one } from '../core/db.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { register, subscribe, unregister, unsubscribe, type Connection } from '../core/realtime.js';
import { resolveActor } from './context.js';
import type { Actor } from '../core/authz.js';

type ClientFrame =
  | { action: 'subscribe'; channel: string }
  | { action: 'unsubscribe'; channel: string }
  | { action: 'ping' };

/** Channel authorization: user channels are self-only; others require membership. */
async function canSubscribe(actor: Actor, channel: string): Promise<boolean> {
  const [kind, id] = channel.split(':');
  if (!kind || !id || !/^[0-9a-f-]{36}$/i.test(id)) return false;

  switch (kind) {
    case 'user':
      return id === actor.userId;
    case 'room': {
      const member = await one('SELECT 1 FROM chat_members WHERE room_id = $1 AND user_id = $2', [
        id,
        actor.userId,
      ]);
      if (member) return true;
      const open = await one(
        `SELECT 1 FROM chat_rooms WHERE id = $1 AND company_id = $2
           AND type = 'channel' AND visibility = 'company'`,
        [id, actor.companyId],
      );
      return Boolean(open);
    }
    case 'meeting': {
      const attendee = await one(
        'SELECT 1 FROM event_attendees WHERE event_id = $1 AND user_id = $2',
        [id, actor.userId],
      );
      return Boolean(attendee);
    }
    case 'project': {
      const member = await one('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
        id,
        actor.userId,
      ]);
      return Boolean(member);
    }
    default:
      return false;
  }
}

export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/ws', { websocket: true }, async (socket, request) => {
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (config.isProd && origin !== config.publicUrl && origin !== config.apiUrl) {
      socket.close(4403, 'origin_not_allowed');
      return;
    }

    const actor = await resolveActor(request).catch(() => null);
    if (!actor || actor.status !== 'active') {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const connection: Connection = register({
      socket: socket as unknown as Connection['socket'],
      userId: actor.userId,
      companyId: actor.companyId,
      sessionId: actor.sessionId,
    });

    socket.send(JSON.stringify({ channel: `user:${actor.userId}`, type: 'connected', data: { userId: actor.userId } }));

    // Heartbeat: a socket that stops answering is dropped rather than leaked.
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, 30_000);

    socket.on('message', async (raw: Buffer) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString('utf8')) as ClientFrame;
      } catch {
        return;
      }
      if (frame.action === 'ping') {
        socket.send(JSON.stringify({ channel: 'system', type: 'pong', data: {} }));
        return;
      }
      if (frame.action === 'subscribe') {
        if (connection.channels.size >= 100) return;
        if (await canSubscribe(actor, frame.channel)) {
          subscribe(connection, frame.channel);
          socket.send(JSON.stringify({ channel: frame.channel, type: 'subscribed', data: {} }));
        } else {
          socket.send(
            JSON.stringify({ channel: frame.channel, type: 'subscribe_denied', data: { reason: 'forbidden' } }),
          );
        }
        return;
      }
      if (frame.action === 'unsubscribe') {
        unsubscribe(connection, frame.channel);
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      unregister(connection);
    });
    socket.on('error', (err: Error) => {
      logger.warn({ err }, 'websocket error');
      clearInterval(heartbeat);
      unregister(connection);
    });
  });
}
