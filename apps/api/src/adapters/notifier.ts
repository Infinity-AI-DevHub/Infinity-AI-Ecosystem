/**
 * Transactional notification sender.
 *
 * The workspace does not host mailboxes - a separate email application owns that.
 * What remains here is the system's own outbound messages: activation invitations,
 * security notices and notification digests. Without this an invited person could never
 * receive their activation link, so it is not optional.
 *
 * Internet delivery - SMTP reputation, DKIM signing, bounce and abuse handling -
 * belongs to a managed provider. This interface keeps that vendor replaceable.
 *
 * Drivers:
 *   log      - development only; records the message and reports success
 *   smtp     - direct SMTP submission to a relay that handles reputation
 *   provider - HTTP API of a managed provider
 */
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { serviceUnavailable } from '../core/errors.js';

export type OutboundAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export type OutboundMessage = {
  from: { address: string; name?: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string | null;
  messageId?: string;
  attachments?: OutboundAttachment[];
};

export type SendResult = {
  providerMessageId: string;
  accepted: string[];
  rejected: string[];
};

export interface NotifierDriver {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

// -------------------------------------------------------------- MIME construction

function encodeHeaderValue(value: string): string {
  // RFC 2047 encoded-word for any non-ASCII header content.
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Header injection guard: newlines in an address or subject must never reach the wire. */
export function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Illegal newline in mail header field ${field}`);
  }
}

export function buildMime(message: OutboundMessage): { raw: string; messageId: string } {
  const messageId = message.messageId ?? `<${randomUUID()}@${config.notifications.defaultDomain}>`;
  const boundary = `iw_${randomUUID().replaceAll('-', '')}`;
  const altBoundary = `iwa_${randomUUID().replaceAll('-', '')}`;

  for (const address of [message.from.address, ...message.to, ...(message.cc ?? [])]) {
    assertNoHeaderInjection(address, 'address');
  }
  assertNoHeaderInjection(message.subject, 'subject');

  const fromHeader = message.from.name
    ? `${encodeHeaderValue(message.from.name)} <${message.from.address}>`
    : message.from.address;

  const headers = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${fromHeader}`,
    `To: ${message.to.join(', ')}`,
  ];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.join(', ')}`);
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${message.inReplyTo}`, `References: ${message.inReplyTo}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(message.subject)}`, 'MIME-Version: 1.0');

  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const bodyParts: string[] = [];

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(message.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  if (message.html) {
    alternative.push(
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(message.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
  }
  alternative.push(`--${altBoundary}--`);

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    bodyParts.push(
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      ...alternative,
    );
    for (const attachment of message.attachments ?? []) {
      const safeName = attachment.filename.replace(/[\r\n"]/g, '');
      bodyParts.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
      );
    }
    bodyParts.push(`--${boundary}--`);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    bodyParts.push(...alternative);
  }

  return { raw: [...headers, '', ...bodyParts].join('\r\n'), messageId };
}

// -------------------------------------------------------------- drivers

class LogNotifier implements NotifierDriver {
  readonly name = 'log';

  async send(message: OutboundMessage): Promise<SendResult> {
    const { messageId } = buildMime(message);
    logger.info(
      { to: message.to, subject: message.subject, messageId },
      'notifier "log": message accepted (not delivered)',
    );
    return { providerMessageId: messageId, accepted: message.to, rejected: [] };
  }
}

/** Minimal ESMTP submission client: EHLO, STARTTLS, AUTH LOGIN, MAIL/RCPT/DATA. */
class SmtpNotifier implements NotifierDriver {
  readonly name = 'smtp';

  async send(message: OutboundMessage): Promise<SendResult> {
    const { raw, messageId } = buildMime(message);
    const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
    await smtpSubmit(message.from.address, recipients, raw);
    return { providerMessageId: messageId, accepted: recipients, rejected: [] };
  }
}

class ProviderNotifier implements NotifierDriver {
  readonly name = 'provider';

  private async call<T>(path: string, body: unknown): Promise<T> {
    if (!config.notifications.providerApiUrl || !config.notifications.providerApiKey) {
      throw serviceUnavailable('Notification provider is not configured');
    }
    const res = await fetch(`${config.notifications.providerApiUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.notifications.providerApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw serviceUnavailable(`Notification provider error ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const { raw, messageId } = buildMime(message);
    const result = await this.call<{ id?: string; accepted?: string[]; rejected?: string[] }>(
      '/messages',
      { raw: Buffer.from(raw).toString('base64'), envelope: { from: message.from.address, to: message.to } },
    );
    return {
      providerMessageId: result.id ?? messageId,
      accepted: result.accepted ?? message.to,
      rejected: result.rejected ?? [],
    };
  }

}

async function smtpSubmit(from: string, recipients: string[], raw: string): Promise<void> {
  const host = config.notifications.smtpHost;
  const port = config.notifications.smtpPort;
  if (!host) throw serviceUnavailable('SMTP host is not configured');

  let socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const s = createConnection({ host, port, timeout: 20_000 }, () => resolve(s));
    s.once('error', reject);
  });

  let buffer = '';
  const waitFor = (expected: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n').filter(Boolean);
        const last = lines[lines.length - 1] ?? '';
        if (!/^\d{3} /.test(last)) return;
        socket.off('data', onData);
        const response = buffer;
        buffer = '';
        if (Number(last.slice(0, 3)) !== expected) {
          reject(new Error(`SMTP expected ${expected}, got: ${last}`));
          return;
        }
        resolve(response);
      };
      socket.on('data', onData);
      socket.once('error', reject);
    });

  const send = async (line: string, expected: number): Promise<string> => {
    socket.write(`${line}\r\n`);
    return waitFor(expected);
  };

  try {
    await waitFor(220);
    const greeting = await send(`EHLO ${config.notifications.defaultDomain}`, 250);

    if (greeting.includes('STARTTLS')) {
      await send('STARTTLS', 220);
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ socket: socket as Socket, servername: host }, () => resolve(secure));
        secure.once('error', reject);
      });
      await send(`EHLO ${config.notifications.defaultDomain}`, 250);
    } else if (config.isProd) {
      throw new Error('SMTP relay does not offer STARTTLS; refusing to send in production');
    }

    if (config.notifications.smtpUser) {
      await send('AUTH LOGIN', 334);
      await send(Buffer.from(config.notifications.smtpUser).toString('base64'), 334);
      await send(Buffer.from(config.notifications.smtpPassword).toString('base64'), 235);
    }

    await send(`MAIL FROM:<${from}>`, 250);
    for (const rcpt of recipients) await send(`RCPT TO:<${rcpt}>`, 250);
    await send('DATA', 354);
    // Dot-stuffing per RFC 5321.
    const body = raw.replace(/\r\n\./g, '\r\n..');
    socket.write(`${body}\r\n.\r\n`);
    await waitFor(250);
    await send('QUIT', 221).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}

function selectDriver(): NotifierDriver {
  switch (config.notifications.driver) {
    case 'smtp':
      return new SmtpNotifier();
    case 'provider':
      return new ProviderNotifier();
    default:
      // A silent no-op sender in production would mean invitations never arrive.
      if (config.isProd) {
        throw new Error('NOTIFY_DRIVER=log is not permitted in production');
      }
      return new LogNotifier();
  }
}

export const notifier: NotifierDriver = selectDriver();
