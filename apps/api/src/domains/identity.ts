/**
 * Identity domain (blueprint 02).
 *
 * Owns users, credential references, MFA, sessions, invitations, recovery and login
 * policy. It must not own project permissions or business approvals - those domains
 * subscribe to identity events instead.
 */
import { randomUUID } from 'node:crypto';
import {
  isPgError,
  jsonArray,
  many,
  newId,
  one,
  PG,
  pool,
  reload,
  transaction,
  type Queryable,
} from '../core/db.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthenticated,
  unprocessable,
} from '../core/errors.js';
import {
  decryptField,
  encryptField,
  generateRecoveryCodes,
  generateToken,
  generateTotpSecret,
  hashPassword,
  hashToken,
  passwordNeedsRehash,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../core/crypto.js';
import { config } from '../core/config.js';
import { recordAudit } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { disconnectUser } from '../core/realtime.js';
import { invalidateCapabilityCache, loadAuthorizationContext, type AccessLevel, type Actor } from '../core/authz.js';
import { logger } from '../core/logger.js';

export type UserRow = {
  id: string;
  company_id: string;
  email: string;
  email_display: string;
  display_name: string;
  legal_name: string | null;
  title: string | null;
  department_id: string | null;
  manager_id: string | null;
  access_level: AccessLevel;
  status: string;
  locale: string;
  timezone: string;
  phone: string | null;
  avatar_color: string;
  modules: string[];
  version: number;
  activated_at: Date | null;
  suspended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type RequestContext = {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
};

const PASSWORD_MIN_LENGTH = 12;

/**
 * Password policy. A breached-password check belongs here too; the hook is explicit so
 * the integration point is not forgotten (blueprint 12).
 */
export async function assertPasswordAcceptable(password: string, email: string): Promise<void> {
  const issues: { field: string; message: string }[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push({ field: 'password', message: `Must be at least ${PASSWORD_MIN_LENGTH} characters` });
  }
  if (password.length > 512) {
    issues.push({ field: 'password', message: 'Must be at most 512 characters' });
  }
  const local = email.split('@')[0] ?? '';
  if (local.length > 2 && password.toLowerCase().includes(local.toLowerCase())) {
    issues.push({ field: 'password', message: 'Must not contain your email address' });
  }
  if (/^(.)\1+$/.test(password)) {
    issues.push({ field: 'password', message: 'Must not be a single repeated character' });
  }
  if (await isBreachedPassword(password)) {
    issues.push({ field: 'password', message: 'This password appears in known breach data' });
  }
  if (issues.length > 0) throw unprocessable('Password does not meet policy', issues);
}

/**
 * k-anonymity breached-password lookup. Only the first five characters of the SHA-1
 * digest ever leave this process, and a lookup failure never blocks the user.
 */
async function isBreachedPassword(password: string): Promise<boolean> {
  if (process.env.BREACHED_PASSWORD_CHECK !== 'enabled') return false;
  try {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0] === digest.slice(5));
  } catch {
    return false;
  }
}

export async function findUserByEmail(companyId: string, email: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE company_id = $1 AND email = $2', [
    companyId,
    email.toLowerCase(),
  ]);
}

export async function findUserById(id: string): Promise<UserRow | undefined> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

/** Resolves which company a login attempt belongs to, from the address domain. */
export async function companyForEmail(email: string): Promise<{ id: string; status: string } | undefined> {
  const domain = email.split('@')[1];
  if (!domain) return undefined;
  return one<{ id: string; status: string }>(
    'SELECT id, status FROM companies WHERE JSON_CONTAINS(verified_domains, JSON_QUOTE($1)) LIMIT 1',
    [domain.toLowerCase()],
  );
}

// ----------------------------------------------------------------- account creation

export type CreateUserInput = {
  email: string;
  displayName: string;
  legalName?: string;
  title?: string;
  accessLevel: AccessLevel;
  departmentId?: string | null;
  managerId?: string | null;
  modules?: string[];
  groupIds?: string[];
};

export type CreatedUser = { user: UserRow; invitationToken: string; invitationUrl: string };

/**
 * Creates an invited account and the single-use activation invitation. A permanent
 * password is never generated or emailed (blueprint 03).
 */
export async function createUser(
  actor: Actor,
  input: CreateUserInput,
  ctx: RequestContext,
): Promise<CreatedUser> {
  const email = input.email.toLowerCase().trim();
  const domain = email.split('@')[1];
  const company = await one<{ verified_domains: unknown }>(
    'SELECT verified_domains FROM companies WHERE id = $1',
    [actor.companyId],
  );
  if (!company) throw notFound('Company not found');
  const verifiedDomains = jsonArray(company.verified_domains);
  if (!domain || !verifiedDomains.includes(domain)) {
    throw unprocessable('Address must use a verified company domain', [
      { field: 'email', message: `Allowed domains: ${verifiedDomains.join(', ') || 'none configured'}` },
    ]);
  }
  // Only a super administrator may mint another administrator-class account.
  if (
    (input.accessLevel === 'admin' || input.accessLevel === 'super_admin') &&
    actor.accessLevel !== 'super_admin'
  ) {
    throw forbidden('Only a super administrator can create administrator accounts');
  }

  return transaction(async (tx) => {
    let user: UserRow;
    const userId = newId();
    try {
      await tx.query(
        `INSERT INTO users
           (id, company_id, email, email_display, display_name, legal_name, title,
            department_id, manager_id, access_level, modules, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'invited')`,
        [
          userId,
          actor.companyId,
          email,
          input.email.trim(),
          input.displayName.trim(),
          input.legalName ?? null,
          input.title ?? null,
          input.departmentId ?? null,
          input.managerId ?? null,
          input.accessLevel,
          JSON.stringify(input.modules ?? []),
        ],
      );
      user = (await reload<UserRow>(tx, 'users', userId))!;
    } catch (err) {
      if (isPgError(err, PG.UNIQUE_VIOLATION)) {
        throw conflict('An account with this address already exists');
      }
      throw err;
    }

    await tx.query('INSERT INTO identities (user_id) VALUES ($1)', [user.id]);

    for (const groupId of input.groupIds ?? []) {
      await tx.query(
        'INSERT IGNORE INTO group_members (group_id, user_id) VALUES ($1,$2)',
        [groupId, user.id],
      );
    }

    const token = generateToken();
    await tx.query(
      `INSERT INTO invitations (id, company_id, user_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4, DATE_ADD(NOW(3), INTERVAL $5 HOUR), $6)`,
      [
        newId(),
        actor.companyId,
        user.id,
        hashToken(token),
        config.security.invitationTtlHours,
        actor.userId,
      ],
    );

    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'user.create',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
        after: {
          email: user.email,
          accessLevel: user.access_level,
          modules: user.modules,
          departmentId: user.department_id,
        },
      },
      tx,
    );

    // Mailbox provisioning and the activation email happen asynchronously; the admin
    // sees "pending" until the provider confirms (blueprint 09).
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.invited',
        actorId: actor.userId,
        correlationId: ctx.correlationId,
        payload: {
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          invitationToken: token,
        },
      },
      tx,
    );

    return {
      user,
      invitationToken: token,
      invitationUrl: `${config.publicUrl}/activate?token=${token}`,
    };
  });
}

// ----------------------------------------------------------------- activation

export type ActivationResult = { user: UserRow; recoveryCodes: string[]; mfaSecret: string; mfaUri: string };

/** Consumes a single-use invitation, sets credentials and enrols MFA. */
export async function activateAccount(
  token: string,
  password: string,
  ctx: RequestContext,
): Promise<ActivationResult> {
  const invitation = await one<{ id: string; user_id: string; company_id: string }>(
    `SELECT id, user_id, company_id FROM invitations
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW(3)`,
    [hashToken(token)],
  );
  if (!invitation) throw badRequest('This invitation is invalid or has expired');

  const user = await findUserById(invitation.user_id);
  if (!user) throw notFound('Account not found');
  if (user.status === 'suspended' || user.status === 'offboarded') {
    throw forbidden('This account is not available');
  }
  await assertPasswordAcceptable(password, user.email);

  const passwordHash = await hashPassword(password);
  const mfaSecret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const hashedRecovery = recoveryCodes.map((code) => hashToken(code));

  const updated = await transaction(async (tx) => {
    // Single-use: the UPDATE only matches while the invitation is still unused, so two
    // concurrent activations cannot both succeed.
    const claimed = await tx.query(
      'UPDATE invitations SET used_at = NOW(3) WHERE id = $1 AND used_at IS NULL',
      [invitation.id],
    );
    if (claimed.rowCount === 0) throw badRequest('This invitation has already been used');

    await tx.query(
      `UPDATE identities
          SET password_hash = $2, password_set_at = NOW(3), mfa_secret_enc = $3,
              recovery_codes = $4, failed_attempts = 0, locked_until = NULL, updated_at = NOW(3)
        WHERE user_id = $1`,
      [user.id, passwordHash, encryptField(mfaSecret), JSON.stringify(hashedRecovery)],
    );
    await tx.query(
      `UPDATE users SET status = 'active', activated_at = NOW(3), updated_at = NOW(3), version = version + 1
        WHERE id = $1`,
      [user.id],
    );
    await recordAudit(
      {
        companyId: user.company_id,
        actorId: user.id,
        actorEmail: user.email,
        action: 'user.activate',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
      tx,
    );
    await emit(
      {
        companyId: user.company_id,
        type: 'user.activated',
        actorId: user.id,
        correlationId: ctx.correlationId,
        payload: { userId: user.id, email: user.email },
      },
      tx,
    );
    return (await reload<UserRow>(tx, 'users', user.id))!;
  });

  return {
    user: updated,
    recoveryCodes,
    mfaSecret,
    mfaUri: totpUri(mfaSecret, updated.email, 'Infinity Workspace'),
  };
}

/**
 * Confirms the enrolled authenticator; MFA is not considered active until this passes.
 * The activation token proves the caller owns the just-consumed invitation, preventing
 * a UUID plus lucky TOTP guess from enabling MFA on another account.
 */
export async function confirmMfa(userId: string, activationToken: string, code: string): Promise<void> {
  const activation = await one<{ id: string }>(
    `SELECT id FROM invitations
      WHERE user_id = $1
        AND token_hash = $2
        AND used_at > DATE_SUB(NOW(3), INTERVAL 30 MINUTE)`,
    [userId, hashToken(activationToken)],
  );
  if (!activation) throw badRequest('This MFA confirmation session is invalid or has expired');

  const identity = await one<{ mfa_secret_enc: string | null }>(
    'SELECT mfa_secret_enc FROM identities WHERE user_id = $1',
    [userId],
  );
  if (!identity?.mfa_secret_enc) throw badRequest('No authenticator is enrolled');
  if (!verifyTotp(decryptField(identity.mfa_secret_enc), code)) {
    throw badRequest('That verification code is not valid');
  }
  await pool.query(
    `UPDATE identities SET mfa_enabled = true, mfa_confirmed_at = NOW(3), updated_at = NOW(3)
      WHERE user_id = $1`,
    [userId],
  );
}

// ----------------------------------------------------------------- authentication

export type LoginOutcome =
  | { status: 'mfa_required'; challengeToken: string }
  | { status: 'authenticated'; sessionToken: string; csrfToken: string; user: UserRow };

/**
 * Password verification.
 *
 * Responses are deliberately uniform: an unknown address, a wrong password and a
 * suspended account all produce the same neutral failure so the endpoint cannot be used
 * to enumerate employees.
 */
export async function authenticate(
  email: string,
  password: string,
  ctx: RequestContext,
): Promise<LoginOutcome> {
  const normalized = email.toLowerCase().trim();
  const company = await companyForEmail(normalized);
  const user = company ? await findUserByEmail(company.id, normalized) : undefined;

  const identity = user
    ? await one<{
        password_hash: string | null;
        mfa_enabled: boolean;
        failed_attempts: number;
        locked_until: Date | null;
      }>(
        'SELECT password_hash, mfa_enabled, failed_attempts, locked_until FROM identities WHERE user_id = $1',
        [user.id],
      )
    : undefined;

  // Always spend comparable time, even for unknown accounts.
  const valid = await verifyPassword(password, identity?.password_hash ?? null);

  const neutralFailure = () => unauthenticated('Email address or password is not correct');

  if (!user || !company) throw neutralFailure();
  if (company.status !== 'active') throw neutralFailure();
  if (identity?.locked_until && identity.locked_until > new Date()) {
    await auditLogin(user, 'denied', 'account_locked', ctx);
    throw neutralFailure();
  }
  if (!valid) {
    await registerFailedAttempt(user.id);
    await auditLogin(user, 'denied', 'bad_credentials', ctx);
    throw neutralFailure();
  }
  if (user.status !== 'active') {
    await auditLogin(user, 'denied', `status_${user.status}`, ctx);
    // Suspended accounts get a neutral response plus a support path (blueprint 03).
    throw new (await import('../core/errors.js')).AppError(
      403,
      'account_unavailable',
      'This account is not available. Please contact your administrator.',
    );
  }

  await pool.query(
    `UPDATE identities SET failed_attempts = 0, locked_until = NULL, last_auth_at = NOW(3) WHERE user_id = $1`,
    [user.id],
  );
  if (passwordNeedsRehash(identity?.password_hash ?? null)) {
    // Silently upgrade the stored hash to current parameters.
    await pool.query('UPDATE identities SET password_hash = $2 WHERE user_id = $1', [
      user.id,
      await hashPassword(password),
    ]);
  }

  const mfaRequired =
    identity?.mfa_enabled ||
    (config.security.requireMfaForAdmins &&
      (user.access_level === 'admin' || user.access_level === 'super_admin'));

  if (mfaRequired) {
    const challengeToken = generateToken();
    await pool.query(
      `INSERT INTO rate_counters (bucket, count, expires_at)
       VALUES ($1, 0, DATE_ADD(NOW(3), INTERVAL 5 MINUTE))
       ON DUPLICATE KEY UPDATE expires_at = DATE_ADD(NOW(3), INTERVAL 5 MINUTE), count = 0`,
      [`mfa_challenge:${hashToken(challengeToken)}:${user.id}`],
    );
    return { status: 'mfa_required', challengeToken: `${user.id}.${challengeToken}` };
  }

  const session = await createSession(user, ctx, false);
  await auditLogin(user, 'success', 'password', ctx);
  return { status: 'authenticated', ...session, user };
}

/** Second factor: an authenticator code or a single-use recovery code. */
export async function verifyMfaChallenge(
  challengeToken: string,
  code: string,
  ctx: RequestContext,
): Promise<{ sessionToken: string; csrfToken: string; user: UserRow }> {
  const [userId, secretPart] = challengeToken.split('.');
  if (!userId || !secretPart) throw unauthenticated('Invalid verification challenge');

  const bucket = `mfa_challenge:${hashToken(secretPart)}:${userId}`;
  const challenge = await one<{ bucket: string }>(
    'SELECT bucket FROM rate_counters WHERE bucket = $1 AND expires_at > NOW(3)',
    [bucket],
  );
  if (!challenge) throw unauthenticated('This verification challenge has expired');

  const user = await findUserById(userId);
  if (!user || user.status !== 'active') throw unauthenticated('Invalid verification challenge');

  const identityRow = await one<{ mfa_secret_enc: string | null; recovery_codes: unknown }>(
    'SELECT mfa_secret_enc, recovery_codes FROM identities WHERE user_id = $1',
    [userId],
  );
  const identity = identityRow
    ? { mfa_secret_enc: identityRow.mfa_secret_enc, recovery_codes: jsonArray(identityRow.recovery_codes) }
    : undefined;

  let method: 'totp' | 'recovery' | null = null;
  if (identity?.mfa_secret_enc && verifyTotp(decryptField(identity.mfa_secret_enc), code)) {
    method = 'totp';
  } else if (identity?.recovery_codes?.includes(hashToken(code.trim().toUpperCase()))) {
    method = 'recovery';
    // Single use: the consumed code is removed from the stored JSON array.
    const remaining = identity.recovery_codes.filter(
      (stored) => stored !== hashToken(code.trim().toUpperCase()),
    );
    await pool.query('UPDATE identities SET recovery_codes = $2 WHERE user_id = $1', [
      userId,
      JSON.stringify(remaining),
    ]);
  }

  if (!method) {
    await registerFailedAttempt(userId);
    await auditLogin(user, 'denied', 'bad_mfa_code', ctx);
    throw unauthenticated('That verification code is not valid');
  }

  await pool.query('DELETE FROM rate_counters WHERE bucket = $1', [bucket]);
  const session = await createSession(user, ctx, true);
  await auditLogin(user, 'success', `mfa_${method}`, ctx);
  return { ...session, user };
}

async function registerFailedAttempt(userId: string): Promise<void> {
  await pool.query(
    `UPDATE identities
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN DATE_ADD(NOW(3), INTERVAL $3 MINUTE)
                                ELSE locked_until END,
            updated_at = NOW(3)
      WHERE user_id = $1`,
    [userId, config.security.maxFailedLogins, config.security.lockoutMinutes],
  );
}

async function auditLogin(
  user: UserRow,
  result: 'success' | 'denied',
  reason: string,
  ctx: RequestContext,
): Promise<void> {
  await recordAudit({
    companyId: user.company_id,
    actorId: user.id,
    actorEmail: user.email,
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    result,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    correlationId: ctx.correlationId,
    metadata: { reason },
  });
}

// ----------------------------------------------------------------- sessions

export async function createSession(
  user: UserRow,
  ctx: RequestContext,
  mfaSatisfied: boolean,
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = generateToken();
  const csrfToken = generateToken(24);
  await pool.query(
    `INSERT INTO sessions
       (id, company_id, user_id, token_hash, csrf_secret, mfa_satisfied, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, DATE_ADD(NOW(3), INTERVAL $9 MINUTE))`,
    [
      newId(),
      user.company_id,
      user.id,
      hashToken(sessionToken),
      csrfToken,
      mfaSatisfied,
      ctx.ip,
      ctx.userAgent?.slice(0, 400) ?? null,
      config.security.sessionTtlMinutes,
    ],
  );
  return { sessionToken, csrfToken };
}

export type SessionRecord = {
  id: string;
  user_id: string;
  company_id: string;
  csrf_secret: string;
  mfa_satisfied: boolean;
  expires_at: Date;
  last_seen_at: Date;
};

/** Resolves a session cookie into an actor, enforcing absolute and idle expiry. */
export async function resolveSession(sessionToken: string): Promise<{ session: SessionRecord; user: UserRow } | null> {
  const session = await one<SessionRecord>(
    `SELECT id, user_id, company_id, csrf_secret, mfa_satisfied, expires_at, last_seen_at
       FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW(3)`,
    [hashToken(sessionToken)],
  );
  if (!session) return null;

  const idleLimitMs = config.security.sessionIdleMinutes * 60_000;
  if (Date.now() - new Date(session.last_seen_at).getTime() > idleLimitMs) {
    await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [session.id]);
    return null;
  }

  const user = await findUserById(session.user_id);
  if (!user || user.status !== 'active') {
    await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [session.id]);
    return null;
  }
  // Touch last_seen without blocking the request path.
  pool
    .query('UPDATE sessions SET last_seen_at = NOW(3) WHERE id = $1', [session.id])
    .catch((err) => logger.warn({ err }, 'failed to touch session'));

  return { session, user };
}

export async function buildActor(
  user: UserRow,
  session: { id: string; mfa_satisfied: boolean } | null,
  tokenScopes: string[] | null = null,
  tokenId: string | null = null,
): Promise<Actor> {
  const { capabilities, groupIds } = await loadAuthorizationContext(user.id, user.access_level);
  const identity = await one<{ mfa_enabled: boolean }>(
    'SELECT mfa_enabled FROM identities WHERE user_id = $1',
    [user.id],
  );
  return {
    userId: user.id,
    companyId: user.company_id,
    email: user.email,
    displayName: user.display_name,
    accessLevel: user.access_level,
    status: user.status,
    departmentId: user.department_id,
    managerId: user.manager_id,
    capabilities,
    groupIds,
    mfaSatisfied: session?.mfa_satisfied ?? false,
    mfaEnabled: identity?.mfa_enabled ?? false,
    sessionId: session?.id ?? null,
    tokenId,
    tokenScopes,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
  ]);
  const { disconnectSession } = await import('../core/realtime.js');
  disconnectSession(sessionId, 'session_revoked');
}

export async function listSessions(userId: string) {
  return many(
    `SELECT id, device, ip, user_agent, mfa_satisfied, last_seen_at, created_at, expires_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW(3)
      ORDER BY last_seen_at DESC`,
    [userId],
  );
}

/** Revokes every session and API token for a user and closes their live sockets. */
export async function revokeAllAccess(userId: string, reason: string, db: Queryable = pool): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  await db.query('UPDATE api_tokens SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [
    userId,
  ]);
  disconnectUser(userId, reason);
}

// ----------------------------------------------------------------- lifecycle

export type UpdateUserInput = Partial<{
  displayName: string;
  title: string | null;
  departmentId: string | null;
  managerId: string | null;
  accessLevel: AccessLevel;
  modules: string[];
  timezone: string;
  locale: string;
  phone: string | null;
}>;

export async function updateUser(
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
  expectedVersion: number | null,
  ctx: RequestContext,
): Promise<UserRow> {
  const existing = await findUserById(userId);
  if (!existing || existing.company_id !== actor.companyId) throw notFound('Account not found');
  if (expectedVersion !== null && existing.version !== expectedVersion) {
    const { preconditionFailed } = await import('../core/errors.js');
    throw preconditionFailed('This account was changed by someone else; reload and retry');
  }
  if (input.accessLevel && input.accessLevel !== existing.access_level) {
    // Privileged role changes require super-administrator authority (separation of duties).
    const privileged = ['admin', 'super_admin'];
    if (
      (privileged.includes(input.accessLevel) || privileged.includes(existing.access_level)) &&
      actor.accessLevel !== 'super_admin'
    ) {
      throw forbidden('Only a super administrator can change administrator access');
    }
    if (userId === actor.userId) {
      throw forbidden('You cannot change your own access level');
    }
  }
  if (input.managerId === userId) {
    throw unprocessable('A person cannot be their own manager', [
      { field: 'managerId', message: 'Choose a different manager' },
    ]);
  }

  return transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET
         display_name  = COALESCE($3, display_name),
         title         = CASE WHEN $4 THEN $5 ELSE title END,
         department_id = CASE WHEN $6 THEN $7 ELSE department_id END,
         manager_id    = CASE WHEN $8 THEN $9 ELSE manager_id END,
         access_level  = COALESCE($10, access_level),
         modules       = COALESCE($11, modules),
         timezone      = COALESCE($12, timezone),
         locale        = COALESCE($13, locale),
         phone         = CASE WHEN $14 THEN $15 ELSE phone END,
         version       = version + 1,
         updated_at    = NOW(3)
       WHERE id = $1 AND company_id = $2`,
      [
        userId,
        actor.companyId,
        input.displayName ?? null,
        'title' in input,
        input.title ?? null,
        'departmentId' in input,
        input.departmentId ?? null,
        'managerId' in input,
        input.managerId ?? null,
        input.accessLevel ?? null,
        input.modules ?? null,
        input.timezone ?? null,
        input.locale ?? null,
        'phone' in input,
        input.phone ?? null,
      ],
    );
    const updated = (await reload<UserRow>(tx, 'users', userId))!;
    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: input.accessLevel && input.accessLevel !== existing.access_level ? 'user.role_change' : 'user.update',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
        before: {
          displayName: existing.display_name,
          accessLevel: existing.access_level,
          departmentId: existing.department_id,
          managerId: existing.manager_id,
          modules: existing.modules,
        },
        after: {
          displayName: updated.display_name,
          accessLevel: updated.access_level,
          departmentId: updated.department_id,
          managerId: updated.manager_id,
          modules: updated.modules,
        },
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.updated',
        actorId: actor.userId,
        correlationId: ctx.correlationId,
        payload: { userId, accessLevelChanged: updated.access_level !== existing.access_level },
      },
      tx,
    );
    return updated;
  }).then(async (updated) => {
    if (updated.access_level !== existing.access_level) {
      // A role change must not leave stale permissions in a live session.
      invalidateCapabilityCache();
      await revokeAllAccess(userId, 'access_changed');
    }
    return updated;
  });
}

/**
 * Suspension (blueprint 03). Sessions, tokens and live connections are revoked
 * immediately; files and ownership are preserved under retention. Email access is
 * revoked separately in the email application.
 */
export async function suspendUser(
  actor: Actor,
  userId: string,
  reason: string,
  ctx: RequestContext,
): Promise<UserRow> {
  const existing = await findUserById(userId);
  if (!existing || existing.company_id !== actor.companyId) throw notFound('Account not found');
  if (userId === actor.userId) throw forbidden('You cannot suspend your own account');
  if (existing.access_level === 'super_admin' && actor.accessLevel !== 'super_admin') {
    throw forbidden('Only a super administrator can suspend a super administrator');
  }

  const updated = await transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET status = 'suspended', suspended_at = NOW(3), version = version + 1, updated_at = NOW(3)
        WHERE id = $1 AND company_id = $2`,
      [userId, actor.companyId],
    );
    await revokeAllAccess(userId, 'account_suspended', tx);
    // Email lives in a separate application, so revoking access there is a step the
    // administrator performs in that system; this event is emitted for that purpose.
    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'user.suspend',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
        before: { status: existing.status },
        after: { status: 'suspended' },
        metadata: { reason },
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.suspended',
        actorId: actor.userId,
        correlationId: ctx.correlationId,
        payload: { userId, reason },
      },
      tx,
    );
    return (await reload<UserRow>(tx, 'users', userId))!;
  });

  disconnectUser(userId, 'account_suspended');
  return updated;
}

export async function reactivateUser(actor: Actor, userId: string, ctx: RequestContext): Promise<UserRow> {
  const existing = await findUserById(userId);
  if (!existing || existing.company_id !== actor.companyId) throw notFound('Account not found');
  if (existing.status !== 'suspended') throw conflict('Only a suspended account can be reactivated');

  return transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET status = 'active', suspended_at = NULL, version = version + 1, updated_at = NOW(3)
        WHERE id = $1`,
      [userId],
    );
    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'user.reactivate',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.reactivated',
        actorId: actor.userId,
        payload: { userId },
      },
      tx,
    );
    return (await reload<UserRow>(tx, 'users', userId))!;
  });
}

/** Re-issues an activation invitation, invalidating any outstanding one. */
export async function reissueInvitation(
  actor: Actor,
  userId: string,
  ctx: RequestContext,
): Promise<{ token: string; url: string }> {
  const user = await findUserById(userId);
  if (!user || user.company_id !== actor.companyId) throw notFound('Account not found');
  if (user.status === 'active') throw conflict('This account is already active');

  const token = generateToken();
  await transaction(async (tx) => {
    await tx.query('UPDATE invitations SET used_at = NOW(3) WHERE user_id = $1 AND used_at IS NULL', [
      userId,
    ]);
    await tx.query(
      `INSERT INTO invitations (id, company_id, user_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4, DATE_ADD(NOW(3), INTERVAL $5 HOUR), $6)`,
      [
        newId(),
        actor.companyId,
        userId,
        hashToken(token),
        config.security.invitationTtlHours,
        actor.userId,
      ],
    );
    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'user.invitation_reissued',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.invited',
        actorId: actor.userId,
        payload: { userId, email: user.email, displayName: user.display_name, invitationToken: token },
      },
      tx,
    );
  });
  return { token, url: `${config.publicUrl}/activate?token=${token}` };
}

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw notFound('Account not found');
  const identity = await one<{ password_hash: string | null }>(
    'SELECT password_hash FROM identities WHERE user_id = $1',
    [userId],
  );
  if (!(await verifyPassword(currentPassword, identity?.password_hash ?? null))) {
    throw unauthenticated('Current password is not correct');
  }
  await assertPasswordAcceptable(newPassword, user.email);
  const hash = await hashPassword(newPassword);
  await transaction(async (tx) => {
    await tx.query(
      'UPDATE identities SET password_hash = $2, password_set_at = NOW(3), updated_at = NOW(3) WHERE user_id = $1',
      [userId, hash],
    );
    await recordAudit(
      {
        companyId: user.company_id,
        actorId: userId,
        actorEmail: user.email,
        action: 'auth.password_change',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      },
      tx,
    );
  });
  // Other sessions are invalidated; the caller re-authenticates.
  await revokeAllAccess(userId, 'password_changed');
}

/** Directory listing with cursor pagination. */
export async function listUsers(
  actor: Actor,
  filters: { status?: string; departmentId?: string; query?: string; limit: number; cursor?: string },
) {
  const { decodeCursor, encodeCursor } = await import('../core/validation.js');
  const cursor = decodeCursor(filters.cursor);
  const rows = await many<UserRow>(
    `SELECT * FROM users
      WHERE company_id = $1
        AND ($2 IS NULL OR status = $2)
        AND ($3 IS NULL OR department_id = $3)
        -- The utf8mb4_0900_ai_ci collation is already case-insensitive, so LIKE gives
        -- the behaviour PostgreSQL needed ILIKE for.
        AND ($4 IS NULL OR display_name LIKE CONCAT('%', $4, '%') OR email LIKE CONCAT('%', $4, '%'))
        AND ($5 IS NULL OR (created_at, id) < ($5, $6))
      ORDER BY created_at DESC, id DESC
      LIMIT $7`,
    [
      actor.companyId,
      filters.status ?? null,
      filters.departmentId ?? null,
      filters.query ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      filters.limit + 1,
    ],
  );
  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
  };
}

/** Public projection of a user record - never exposes credential state. */
export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email_display,
    displayName: user.display_name,
    title: user.title,
    departmentId: user.department_id,
    managerId: user.manager_id,
    accessLevel: user.access_level,
    status: user.status,
    timezone: user.timezone,
    locale: user.locale,
    avatarColor: user.avatar_color,
    modules: user.modules,
    version: user.version,
    activatedAt: user.activated_at,
    createdAt: user.created_at,
  };
}

export { randomUUID };
