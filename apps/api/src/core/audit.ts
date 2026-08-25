/**
 * Append-only audit trail (blueprint 12/15). Written in the same transaction as the
 * change it describes. Content is deliberately narrow: no credentials, no tokens,
 * no full message bodies, no unnecessary personal data.
 */
import { pool, type Queryable } from './db.js';
import type { Actor } from './authz.js';

export type AuditInput = {
  companyId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result?: 'success' | 'denied' | 'error';
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'tokenHash',
  'secret',
  'mfa_secret_enc',
  'mfaSecret',
  'recovery_codes',
  'recoveryCodes',
  'csrf_secret',
  'body',
  'body_text',
  'body_html_sanitized',
  'authorization',
  'cookie',
]);

/** Strips secrets and truncates long text so the trail stays redaction-safe. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

export async function recordAudit(input: AuditInput, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (company_id, actor_id, actor_email, action, resource_type, resource_id,
        result, ip, user_agent, correlation_id, before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.companyId,
      input.actorId ?? null,
      input.actorEmail ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.result ?? 'success',
      input.ip ?? null,
      input.userAgent ?? null,
      input.correlationId ?? null,
      input.before === undefined ? null : JSON.stringify(redact(input.before)),
      input.after === undefined ? null : JSON.stringify(redact(input.after)),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

/** Convenience wrapper for the common "actor did X to resource Y" case. */
export async function auditFromActor(
  actor: Actor,
  action: string,
  extra: Omit<AuditInput, 'companyId' | 'actorId' | 'actorEmail' | 'action'>,
  db: Queryable = pool,
): Promise<void> {
  await recordAudit(
    {
      companyId: actor.companyId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action,
      ...extra,
    },
    db,
  );
}
