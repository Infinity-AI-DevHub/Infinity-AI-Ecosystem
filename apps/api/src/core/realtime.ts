/**
 * WebSocket hub (blueprint 08). Channels are authorized at subscribe time, not at
 * publish time, and a suspended user's sockets are closed immediately.
 *
 * The database remains the source of truth: sockets carry notifications about durable
 * records that were already committed.
 */
import type { WebSocket } from 'ws';
import { logger } from './logger.js';

export type Channel = `user:${string}` | `room:${string}` | `meeting:${string}` | `project:${string}`;

type Connection = {
  socket: WebSocket;
  userId: string;
  companyId: string;
  sessionId: string | null;
  channels: Set<string>;
};

const connections = new Set<Connection>();
const byChannel = new Map<string, Set<Connection>>();
const byUser = new Map<string, Set<Connection>>();

export function register(conn: Omit<Connection, 'channels'>): Connection {
  const record: Connection = { ...conn, channels: new Set() };
  connections.add(record);
  let set = byUser.get(conn.userId);
  if (!set) {
    set = new Set();
    byUser.set(conn.userId, set);
  }
  set.add(record);
  // Every connection is implicitly subscribed to its own private user channel.
  subscribe(record, `user:${conn.userId}`);
  return record;
}

export function subscribe(conn: Connection, channel: string): void {
  conn.channels.add(channel);
  let set = byChannel.get(channel);
  if (!set) {
    set = new Set();
    byChannel.set(channel, set);
  }
  set.add(conn);
}

export function unsubscribe(conn: Connection, channel: string): void {
  conn.channels.delete(channel);
  byChannel.get(channel)?.delete(conn);
}

export function unregister(conn: Connection): void {
  for (const channel of conn.channels) byChannel.get(channel)?.delete(conn);
  byUser.get(conn.userId)?.delete(conn);
  connections.delete(conn);
}

export type RealtimeMessage = {
  channel: string;
  type: string;
  data: Record<string, unknown>;
  at?: string;
};

export function publish(channel: string, type: string, data: Record<string, unknown>): void {
  const targets = byChannel.get(channel);
  if (!targets || targets.size === 0) return;
  const frame = JSON.stringify({ channel, type, data, at: new Date().toISOString() });
  for (const conn of targets) {
    try {
      if (conn.socket.readyState === 1) conn.socket.send(frame);
    } catch (err) {
      logger.warn({ err, channel }, 'failed to deliver realtime frame');
    }
  }
}

export function publishToUser(userId: string, type: string, data: Record<string, unknown>): void {
  publish(`user:${userId}`, type, data);
}

/** Called when a user is suspended or their sessions are revoked. */
export function disconnectUser(userId: string, reason: string): void {
  const set = byUser.get(userId);
  if (!set) return;
  for (const conn of [...set]) {
    try {
      conn.socket.send(JSON.stringify({ channel: `user:${userId}`, type: 'session.revoked', data: { reason } }));
      conn.socket.close(4001, reason);
    } catch {
      // socket already gone
    }
    unregister(conn);
  }
}

export function disconnectSession(sessionId: string, reason: string): void {
  for (const conn of [...connections]) {
    if (conn.sessionId === sessionId) {
      try {
        conn.socket.close(4001, reason);
      } catch {
        // already closed
      }
      unregister(conn);
    }
  }
}

export function stats(): { connections: number; channels: number } {
  return { connections: connections.size, channels: byChannel.size };
}

export type { Connection };
