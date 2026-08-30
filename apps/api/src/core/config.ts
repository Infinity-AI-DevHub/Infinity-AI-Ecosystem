/**
 * Runtime configuration. Every value comes from the environment; nothing secret
 * is ever committed (blueprint 12: "no secrets in code, browser bundle, logs").
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { isPrivateHost, validateOutboundUrl } from './security.js';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function url(name: string, fallback: string, options: { required?: boolean; httpsInProd?: boolean } = {}): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    if (options.required) throw new Error(`Missing required environment variable ${name}`);
    return value;
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`${name} must use http or https`);
    }
    if (options.httpsInProd && isProd && parsed.protocol !== 'https:') {
      throw new Error(`${name} must use https in production`);
    }
    return parsed.toString().replace(/\/$/, '');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(name)) throw err;
    throw new Error(`Environment variable ${name} must be a valid URL`);
  }
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

/** In production every secret must be supplied explicitly; dev gets an ephemeral one. */
function secret(name: string): string {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} must be set to at least 32 characters in production`);
  }
  return randomBytes(32).toString('hex');
}

/**
 * The notification driver, refusing the no-op in production.
 *
 * 'log' accepts a message and delivers nothing. That is right for development and
 * catastrophic in production: activation invitations and password resets would be
 * swallowed silently, and the first sign of trouble is a new joiner who cannot get in.
 * The documentation already promised this was refused; it was not.
 */
function notifyDriver(): 'log' | 'smtp' | 'provider' {
  const driver = (process.env.NOTIFY_DRIVER ?? 'log') as 'log' | 'smtp' | 'provider';
  if (isProd && driver === 'log') {
    throw new Error(
      'NOTIFY_DRIVER=log delivers nothing and is refused in production. ' +
        'Set it to smtp or provider so invitations and password resets actually arrive.',
    );
  }
  if (isProd && driver === 'smtp' && !process.env.SMTP_HOST) {
    throw new Error('NOTIFY_DRIVER=smtp requires SMTP_HOST');
  }
  return driver;
}

export const config = {
  env: nodeEnv,
  isProd,
  port: int('PORT', 3500),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: url('PUBLIC_URL', 'http://localhost:4600', { httpsInProd: true }),
  /**
   * Additional browser origins permitted to call the API.
   *
   * The desktop client is served from its own scheme and is handled separately, but there
   * is more than one browser origin in play: the public surface on its own host, and in
   * development a second Vite server for it. Listing them beats widening the check,
   * because a wildcard here would let any site the employee visits call the API with
   * their cookies attached.
   */
  extraOrigins: (process.env.CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean),
  apiUrl: url('API_URL', 'http://localhost:3500', { httpsInProd: true }),
  logLevel: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  trustProxy: bool('TRUST_PROXY', isProd),

  db: {
    url: req('DATABASE_URL', 'mysql://root:root@localhost:8889/ecosystem'),
    poolMax: int('DATABASE_POOL_MAX', 10),
    ssl: bool('DATABASE_SSL', false),
    statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 15000),
  },

  security: {
    /** Encrypts sensitive fields at rest. Rotate through KMS in production. */
    dataKey: secret('DATA_ENCRYPTION_KEY'),
    sessionCookie: process.env.SESSION_COOKIE_NAME ?? 'iw_session',
    csrfCookie: process.env.CSRF_COOKIE_NAME ?? 'iw_csrf',
    sessionTtlMinutes: int('SESSION_TTL_MINUTES', 12 * 60),
    // Browser sessions end after this long without activity.
    sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 30),
    /**
     * Desktop access tokens are short and refresh silently; the refresh itself is capped
     * by desktopSessionDays, which is not extended by use. A desktop session therefore
     * ends five days after sign-in no matter how continuously it has been used, and there
     * is deliberately no idle timeout - an application left open on a locked laptop is a
     * different risk from a browser tab left open on a shared machine.
     */
    desktopAccessMinutes: int('DESKTOP_ACCESS_MINUTES', 15),
    desktopSessionDays: int('DESKTOP_SESSION_DAYS', 5),
    invitationTtlHours: int('INVITATION_TTL_HOURS', 72),
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    /** scrypt work factor. 2^17 keeps hashing near 100ms on modern hardware. */
    scryptCost: int('SCRYPT_COST', 1 << 17),
    maxFailedLogins: int('MAX_FAILED_LOGINS', 8),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
  },

  limits: {
    loginPerMinute: int('RATE_LOGIN_PER_MIN', 10),
    apiPerMinute: int('RATE_API_PER_MIN', 600),
    mailSendPerHour: int('RATE_MAIL_PER_HOUR', 200),
    uploadMaxBytes: int('UPLOAD_MAX_BYTES', 250 * 1024 * 1024),
    maxPageSize: int('MAX_PAGE_SIZE', 100),
  },

  storage: {
    /** 'local' writes to a private directory; 's3' uses any S3-compatible service. */
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localRoot: process.env.STORAGE_LOCAL_ROOT ?? './var/objects',
    bucket: process.env.S3_BUCKET ?? 'infinity-files',
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT
      ? validateOutboundUrl('S3_ENDPOINT', process.env.S3_ENDPOINT, { allowPrivateHosts: !isProd, httpsInProd: isProd })
      : '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    signedUrlTtlSeconds: int('SIGNED_URL_TTL_SECONDS', 300),
  },

  /**
   * Outbound transactional email only - activation invitations and security notices.
   * Employee mailboxes live in a separate email application, so nothing here reads,
   * stores or syncs anyone's mail.
   */
  notifications: {
    /** 'log' prints messages (development only); 'smtp' and 'provider' really deliver. */
    driver: notifyDriver(),
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: int('SMTP_PORT', 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPassword: process.env.SMTP_PASSWORD ?? '',
    providerApiUrl: process.env.NOTIFY_PROVIDER_API_URL
      ? validateOutboundUrl('NOTIFY_PROVIDER_API_URL', process.env.NOTIFY_PROVIDER_API_URL, { allowPrivateHosts: false, httpsInProd: isProd })
      : '',
    providerApiKey: process.env.NOTIFY_PROVIDER_API_KEY ?? '',
    /** Envelope sender for system messages. Must be on a verified domain. */
    fromAddress: process.env.NOTIFY_FROM_ADDRESS ?? '',
    defaultDomain: process.env.NOTIFY_DEFAULT_DOMAIN ?? 'iinfinityai.com',
  },

  meetings: {
    provider: (process.env.MEETING_PROVIDER ?? 'none') as 'none' | 'livekit',
    livekitUrl: process.env.LIVEKIT_URL
      ? validateOutboundUrl('LIVEKIT_URL', process.env.LIVEKIT_URL, { allowPrivateHosts: !isProd, httpsInProd: isProd })
      : '',
    livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
    livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
    tokenTtlSeconds: int('MEETING_TOKEN_TTL_SECONDS', 900),
    recordingEnabled: bool('MEETING_RECORDING_ENABLED', false),
  },

  jobs: {
    enabled: bool('WORKERS_ENABLED', true),
    pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', 1000),
    batchSize: int('WORKER_BATCH_SIZE', 25),
    maxAttempts: int('WORKER_MAX_ATTEMPTS', 8),
  },

  retention: {
    recycleBinDays: int('RETENTION_RECYCLE_BIN_DAYS', 30),
    auditDays: int('RETENTION_AUDIT_DAYS', 730),
    notificationDays: int('RETENTION_NOTIFICATION_DAYS', 90),
  },
} as const;

if (config.isProd) {
  if (isPrivateHost(config.publicUrl) || isPrivateHost(config.apiUrl)) {
    throw new Error('PUBLIC_URL and API_URL must be public HTTPS origins in production');
  }
  if (
    config.notifications.driver === 'provider' &&
    (!config.notifications.providerApiUrl || !config.notifications.providerApiKey)
  ) {
    throw new Error(
      'NOTIFY_PROVIDER_API_URL and NOTIFY_PROVIDER_API_KEY are required for the provider notifier',
    );
  }
  if (config.notifications.driver === 'smtp' && !config.notifications.smtpHost) {
    throw new Error('SMTP_HOST is required when NOTIFY_DRIVER=smtp');
  }
  if (config.storage.driver === 's3' && (!config.storage.accessKeyId || !config.storage.secretAccessKey)) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for S3 storage');
  }
}

export type Config = typeof config;
