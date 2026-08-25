/**
 * Meeting adapter (blueprint 10).
 *
 * Infinity Workspace creates meetings and issues short-lived, signed join tokens that
 * carry room, user, company and host/participant permissions. Media transport - SFU
 * routing, NAT traversal, adaptive bitrate, screen share, recording - is the media
 * platform's job. Custom WebRTC media infrastructure is explicitly out of scope.
 *
 * If no provider is configured the meeting metadata still works and the join call
 * reports a clear degraded state rather than failing the whole calendar.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../core/config.js';

export type MeetingGrant = {
  roomKey: string;
  userId: string;
  companyId: string;
  displayName: string;
  role: 'host' | 'participant';
  canPublish: boolean;
  canScreenShare: boolean;
  canRecord: boolean;
};

export type JoinTicket = {
  provider: string;
  /** Empty when the provider is unavailable; the client shows a degraded state. */
  url: string;
  token: string;
  expiresAt: string;
  degraded: boolean;
  reason?: string;
};

export interface MeetingDriver {
  readonly name: string;
  createRoom(eventId: string): Promise<{ roomKey: string }>;
  issueToken(grant: MeetingGrant): Promise<JoinTicket>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Signed JWT (HS256) - the format LiveKit and most SFUs accept. */
function signJwt(payload: Record<string, unknown>, secret: string, apiKey: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({ iss: apiKey, sub: payload.sub, nbf: now - 5, exp: now + ttlSeconds, ...payload }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

class NoMeetingDriver implements MeetingDriver {
  readonly name = 'none';

  async createRoom(eventId: string): Promise<{ roomKey: string }> {
    return { roomKey: `iw-${eventId}` };
  }

  async issueToken(grant: MeetingGrant): Promise<JoinTicket> {
    return {
      provider: 'none',
      url: '',
      token: '',
      expiresAt: new Date(Date.now() + config.meetings.tokenTtlSeconds * 1000).toISOString(),
      degraded: true,
      reason:
        'No media provider is configured. Meeting details, agenda and notes remain available.',
    };
  }
}

class LiveKitDriver implements MeetingDriver {
  readonly name = 'livekit';

  async createRoom(eventId: string): Promise<{ roomKey: string }> {
    return { roomKey: `iw-${eventId}-${randomUUID().slice(0, 8)}` };
  }

  async issueToken(grant: MeetingGrant): Promise<JoinTicket> {
    const ttl = config.meetings.tokenTtlSeconds;
    if (!config.meetings.livekitApiKey || !config.meetings.livekitApiSecret) {
      return {
        provider: 'livekit',
        url: config.meetings.livekitUrl,
        token: '',
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        degraded: true,
        reason: 'Media provider credentials are missing.',
      };
    }
    const token = signJwt(
      {
        sub: grant.userId,
        name: grant.displayName,
        metadata: JSON.stringify({ companyId: grant.companyId, role: grant.role }),
        video: {
          room: grant.roomKey,
          roomJoin: true,
          canPublish: grant.canPublish,
          canSubscribe: true,
          canPublishData: true,
          roomAdmin: grant.role === 'host',
          // Recording stays off unless policy and consent are approved.
          recorder: grant.canRecord && config.meetings.recordingEnabled,
        },
      },
      config.meetings.livekitApiSecret,
      config.meetings.livekitApiKey,
      ttl,
    );
    return {
      provider: 'livekit',
      url: config.meetings.livekitUrl,
      token,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      degraded: false,
    };
  }
}

export const meetingDriver: MeetingDriver =
  config.meetings.provider === 'livekit' ? new LiveKitDriver() : new NoMeetingDriver();
