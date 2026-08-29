/**
 * Identity domain (blueprint 02).
 *
 * Owns users, credential references, sessions, invitations and login policy. It must not own project permissions or business approvals - those domains
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
  generateToken,
  hashPassword,
  hashToken,
  passwordNeedsRehash,
  verifyPassword,
} from '../core/crypto.js';
import { config } from '../core/config.js';
import { recordAudit } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import { disconnectUser } from '../core/realtime.js';
import { authorize, invalidateCapabilityCache, loadAuthorizationContext, type AccessLevel, type Actor } from '../core/authz.js';
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
  const byDomain = await one<{ id: string; status: string }>(
    'SELECT id, status FROM companies WHERE JSON_CONTAINS(verified_domains, JSON_QUOTE($1)) LIMIT 1',
    [domain.toLowerCase()],
  );
  if (byDomain) return byDomain;

  /**
   * Guests are the deliberate exception. Their address belongs to the client or vendor
   * they work for, so it will never match a verified domain - that is the whole point of
   * them being external. Their company is resolved through the guest account itself.
   *
   * Restricted to exactly one match on purpose: email is unique per company, not
   * globally, so the same client contact could hold guest accounts at two companies in a
   * multi-tenant deployment. Guessing which one they meant would sign them into the
   * wrong workspace, so an ambiguous address simply fails to resolve.
   */
  const guestCompanies = await many<{ id: string; status: string }>(
    `SELECT DISTINCT c.id, c.status
       FROM users u
       JOIN companies c ON c.id = u.company_id
      WHERE u.email = $1 AND u.access_level = 'guest'
      LIMIT 2`,
    [email.toLowerCase()],
  );
  return guestCompanies.length === 1 ? guestCompanies[0] : undefined;
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

export type ActivationResult = { user: UserRow };

/** Consumes a single-use invitation and sets the account's password. */
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
          SET password_hash = $2, password_set_at = NOW(3),
              failed_attempts = 0, locked_until = NULL, updated_at = NOW(3)
        WHERE user_id = $1`,
      [user.id, passwordHash],
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

  return { user: updated };
}

// ----------------------------------------------------------------- authentication

export type LoginOutcome = {
  status: 'authenticated';
  sessionToken: string;
  csrfToken: string;
  user: UserRow;
};

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
        failed_attempts: number;
        locked_until: Date | null;
      }>(
        'SELECT password_hash, failed_attempts, locked_until FROM identities WHERE user_id = $1',
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

  const session = await createSession(user, ctx);
  await auditLogin(user, 'success', 'password', ctx);
  return { status: 'authenticated', ...session, user };
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
): Promise<{ sessionToken: string; csrfToken: string }> {
  const sessionToken = generateToken();
  const csrfToken = generateToken(24);
  await pool.query(
    `INSERT INTO sessions
       (id, company_id, user_id, token_hash, csrf_secret, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, DATE_ADD(NOW(3), INTERVAL $8 MINUTE))`,
    [
      newId(),
      user.company_id,
      user.id,
      hashToken(sessionToken),
      csrfToken,
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
  expires_at: Date;
  last_seen_at: Date;
};

/** Resolves a session cookie into an actor, enforcing absolute and idle expiry. */
export async function resolveSession(sessionToken: string): Promise<{ session: SessionRecord; user: UserRow } | null> {
  const session = await one<SessionRecord & { kind: string }>(
    `SELECT id, user_id, company_id, csrf_secret, expires_at, last_seen_at, kind
       FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW(3)
        AND (absolute_expires_at IS NULL OR absolute_expires_at > NOW(3))`,
    [hashToken(sessionToken)],
  );
  if (!session) return null;

  /**
   * Idle expiry applies to browsers only.
   *
   * A browser tab left open on a shared machine is the risk that timeout exists for. A
   * desktop application sits behind the operating system's own lock screen, and its
   * ceiling is the absolute five-day cap enforced in the query above - which use does not
   * extend.
   */
  if (session.kind !== 'desktop') {
    const idleLimitMs = config.security.sessionIdleMinutes * 60_000;
    if (Date.now() - new Date(session.last_seen_at).getTime() > idleLimitMs) {
      await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [session.id]);
      return null;
    }
  }

  const user = await findUserById(session.user_id);
  if (!user || user.status !== 'active') {
    await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [session.id]);
    return null;
  }

  /**
   * Guest access ends on a date, and that date has to be enforced on every request
   * rather than by a nightly job. A finished engagement whose cleanup did not run is
   * otherwise a live door into the company for however long it takes someone to notice.
   */
  if (user.access_level === 'guest') {
    const membership = await one<{ expired: number }>(
      `SELECT (access_expires_at IS NOT NULL AND access_expires_at <= NOW(3)) AS expired
         FROM external_memberships WHERE user_id = $1`,
      [user.id],
    );
    // No membership row means the guest is not attached to any organisation, which
    // should be impossible; refuse rather than guess.
    if (!membership || membership.expired) {
      await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [session.id]);
      return null;
    }
  }

  // Touch last_seen without blocking the request path.
  pool
    .query('UPDATE sessions SET last_seen_at = NOW(3) WHERE id = $1', [session.id])
    .catch((err) => logger.warn({ err }, 'failed to touch session'));

  return { session, user };
}

export async function buildActor(
  user: UserRow,
  session: { id: string } | null,
  tokenScopes: string[] | null = null,
  tokenId: string | null = null,
): Promise<Actor> {
  const { capabilities, groupIds } = await loadAuthorizationContext(user.id, user.access_level);
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
    `SELECT id, device, ip, user_agent, last_seen_at, created_at, expires_at
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
  // An offboarded account is closed for good. Activation would refuse the link anyway,
  // but issuing one at all suggests a departed employee can be let back in by clicking
  // it - and hands out a live-looking credential for an account that must stay shut.
  if (user.status === 'offboarded') {
    throw conflict('This account has been offboarded; create a new account instead');
  }

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
    // Deliberately not 401. The caller's session is perfectly valid - they mistyped one
    // field. Answering with 401 makes the client's global "session is gone" handler fire
    // and signs the person out mid-form, with no message explaining why. This is a field
    // validation failure and is reported as one.
    throw unprocessable('Current password is not correct', [
      { field: 'currentPassword', message: 'Current password is not correct' },
    ]);
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
        -- Guests are external people, not colleagues. They must not surface in the
        -- employee directory, the people pickers that feed off it, or the mention and
        -- assignee lists built from those - a client contact appearing as a colleague is
        -- both a leak of the relationship and an invitation to assign them work.
        AND access_level <> 'guest'
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

// ---------------------------------------------------------------- password recovery

/**
 * Password recovery.
 *
 * This platform is the company's only system: there is no identity provider behind it
 * and no second place to sign in from. An account that cannot authenticate therefore has
 * no route back in except this one, which is why recovery is part of the product rather
 * than an operational script. Re-issuing an activation invitation does not cover it -
 * that refuses accounts which are already active, which is everyone who has ever used
 * the product.
 */
const RESET_TTL_MINUTES = 60;

export type ResetIssue = { token: string; url: string; userId: string };

/**
 * Starts a reset for the address, if it belongs to a live account.
 *
 * Returns null when it does not. Callers must answer identically either way: whether an
 * address has an account here is exactly the fact an attacker wants, and the sign-in
 * path already refuses to leak it.
 */
export async function requestPasswordReset(
  email: string,
  ctx: RequestContext,
): Promise<ResetIssue | null> {
  const normalized = email.toLowerCase().trim();
  const company = await companyForEmail(normalized);
  const user = company ? await findUserByEmail(company.id, normalized) : undefined;
  // Invited accounts are deliberately excluded: they have no password to reset, and an
  // activation invitation is the correct instrument for them.
  if (!user || user.status !== 'active') return null;

  const token = generateToken();
  await transaction(async (tx) => {
    // Only the newest link may work. Without this, every previously mailed link stays
    // live for its full hour, so one intercepted message keeps its value even after the
    // person notices and requests another.
    await tx.query(
      `UPDATE password_resets SET invalidated_at = NOW(3)
        WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [user.id],
    );
    await tx.query(
      `INSERT INTO password_resets (id, company_id, user_id, token_hash, requested_ip, expires_at)
       VALUES ($1,$2,$3,$4,$5, DATE_ADD(NOW(3), INTERVAL $6 MINUTE))`,
      [newId(), user.company_id, user.id, hashToken(token), ctx.ip, RESET_TTL_MINUTES],
    );
    await recordAudit(
      {
        companyId: user.company_id,
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.password_reset_requested',
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
        type: 'user.password_reset_requested',
        actorId: user.id,
        correlationId: ctx.correlationId,
        payload: {
          userId: user.id,
          email: user.email,
          url: `${config.publicUrl}/reset?token=${token}`,
          expiresInMinutes: RESET_TTL_MINUTES,
        },
      },
      tx,
    );
  });

  return { token, url: `${config.publicUrl}/reset?token=${token}`, userId: user.id };
}

/** Consumes a single-use reset token and sets a new password. */
export async function completePasswordReset(
  token: string,
  newPassword: string,
  ctx: RequestContext,
): Promise<void> {
  const reset = await one<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_resets
      WHERE token_hash = $1 AND consumed_at IS NULL AND invalidated_at IS NULL
        AND expires_at > NOW(3)`,
    [hashToken(token)],
  );
  if (!reset) throw badRequest('This reset link is invalid or has expired');

  const user = await findUserById(reset.user_id);
  if (!user) throw notFound('Account not found');
  if (user.status !== 'active') throw forbidden('This account is not available');

  await assertPasswordAcceptable(newPassword, user.email);
  const passwordHash = await hashPassword(newPassword);

  await transaction(async (tx) => {
    // Single-use, enforced by the UPDATE matching only while unconsumed, so two
    // simultaneous submissions of the same link cannot both set a password.
    const claimed = await tx.query(
      'UPDATE password_resets SET consumed_at = NOW(3) WHERE id = $1 AND consumed_at IS NULL',
      [reset.id],
    );
    if (claimed.rowCount === 0) throw badRequest('This reset link has already been used');

    await tx.query(
      `UPDATE identities
          SET password_hash = $2, password_set_at = NOW(3),
              failed_attempts = 0, locked_until = NULL, updated_at = NOW(3)
        WHERE user_id = $1`,
      [user.id, passwordHash],
    );
    // A reset is the remedy for a suspected compromise, so every existing session and
    // token goes with it. The lockout from failed attempts is cleared above for the same
    // reason: the person proved control of the mailbox, and leaving them locked out
    // would defeat the recovery they just completed.
    await revokeAllAccess(user.id, 'password_reset', tx);
    await recordAudit(
      {
        companyId: user.company_id,
        actorId: user.id,
        actorEmail: user.email,
        action: 'auth.password_reset_completed',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------- offboarding

export type OffboardInput = {
  successorId: string | null;
  reason: string;
  lastDay?: string | null;
};

export type OffboardResult = {
  user: UserRow;
  transferred: Record<string, number>;
};

/**
 * Offboards someone and moves their work to a named successor.
 *
 * Suspension was the only tool here, and it says nothing about where the work went. On a
 * platform that holds everything the company has, that is how a departure quietly turns
 * into data loss: projects, folders and open tasks keep pointing at someone who will
 * never log in again, their reports lose the manager that approval routing depends on,
 * and any request waiting on their decision stalls indefinitely. Every one of those
 * pointers is moved here, in one transaction, and the counts are recorded so the
 * transfer can be read back long afterwards.
 *
 * A successor is optional but strongly preferred - without one, the work is released
 * rather than reassigned, and the record says so.
 */
export async function offboardUser(
  actor: Actor,
  userId: string,
  input: OffboardInput,
  ctx: RequestContext,
): Promise<OffboardResult> {
  await authorize({ actor, capability: 'user.suspend', resourceless: true });

  const existing = await findUserById(userId);
  if (!existing || existing.company_id !== actor.companyId) throw notFound('Account not found');
  if (userId === actor.userId) throw forbidden('You cannot offboard your own account');
  if (existing.access_level === 'super_admin' && actor.accessLevel !== 'super_admin') {
    throw forbidden('Only a super administrator can offboard a super administrator');
  }
  if (existing.status === 'offboarded') throw conflict('This account is already offboarded');
  if (input.reason.trim().length < 3) {
    throw unprocessable('Give a reason for the offboarding', [
      { field: 'reason', message: 'A reason is required and is recorded in the audit trail' },
    ]);
  }

  let successor: UserRow | undefined;
  if (input.successorId) {
    successor = await findUserById(input.successorId);
    if (!successor || successor.company_id !== actor.companyId) {
      throw unprocessable('The successor account was not found', [
        { field: 'successorId', message: 'Choose someone in this company' },
      ]);
    }
    if (successor.id === userId) {
      throw unprocessable('Someone cannot succeed themselves', [
        { field: 'successorId', message: 'Choose a different person' },
      ]);
    }
    if (successor.status !== 'active') {
      throw unprocessable('The successor must be an active account', [
        { field: 'successorId', message: 'Choose someone who can actually pick this work up' },
      ]);
    }
  }

  const transferred: Record<string, number> = {};

  const updated = await transaction(async (tx) => {
    const move = async (label: string, sql: string, params: unknown[]) => {
      const result = await tx.query(sql, params);
      transferred[label] = result.rowCount ?? 0;
    };

    if (successor) {
      await move(
        'projects',
        'UPDATE projects SET owner_id = $2 WHERE owner_id = $1 AND company_id = $3',
        [userId, successor.id, actor.companyId],
      );
      // Only work still in flight moves. Reassigning a finished task would rewrite
      // history and misattribute who actually did it.
      await move(
        'tasks',
        `UPDATE tasks SET assignee_id = $2, updated_at = NOW(3)
          WHERE assignee_id = $1 AND company_id = $3 AND status NOT IN ('done','cancelled')`,
        [userId, successor.id, actor.companyId],
      );
      await move('files', 'UPDATE files SET owner_id = $2 WHERE owner_id = $1 AND company_id = $3', [
        userId,
        successor.id,
        actor.companyId,
      ]);
      await move(
        'folders',
        'UPDATE folders SET owner_id = $2 WHERE owner_id = $1 AND company_id = $3',
        [userId, successor.id, actor.companyId],
      );
      // Direct reports must not be left without a manager: approval routing resolves
      // through this column, and an unresolvable route now refuses outright.
      await move(
        'direct_reports',
        'UPDATE users SET manager_id = $2, updated_at = NOW(3) WHERE manager_id = $1 AND company_id = $3',
        [userId, successor.id, actor.companyId],
      );
      // Any decision still waiting on them would otherwise wait forever.
      await move(
        'pending_approvals',
        `UPDATE approval_steps s
            JOIN approval_requests r ON r.id = s.request_id
            SET s.approver_id = $2
          WHERE s.approver_id = $1 AND s.state = 'active' AND r.company_id = $3`,
        [userId, successor.id, actor.companyId],
      );
    } else {
      transferred.projects = 0;
      transferred.tasks = 0;
      transferred.files = 0;
      transferred.folders = 0;
      transferred.direct_reports = 0;
      transferred.pending_approvals = 0;
    }

    await tx.query(
      `UPDATE users
          SET status = 'offboarded', offboarded_at = NOW(3), suspended_at = NOW(3),
              version = version + 1, updated_at = NOW(3)
        WHERE id = $1 AND company_id = $2`,
      [userId, actor.companyId],
    );

    await tx.query(
      `INSERT INTO offboardings (id, company_id, user_id, successor_id, performed_by, reason, transferred, last_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        newId(),
        actor.companyId,
        userId,
        successor?.id ?? null,
        actor.userId,
        input.reason.trim(),
        JSON.stringify(transferred),
        input.lastDay ? new Date(input.lastDay) : null,
      ],
    );

    await revokeAllAccess(userId, 'offboarded', tx);

    await recordAudit(
      {
        companyId: actor.companyId,
        actorId: actor.userId,
        actorEmail: actor.email,
        action: 'user.offboard',
        resourceType: 'user',
        resourceId: userId,
        metadata: { successorId: successor?.id ?? null, reason: input.reason.trim(), transferred },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.offboarded',
        actorId: actor.userId,
        correlationId: ctx.correlationId,
        payload: { userId, successorId: successor?.id ?? null, transferred },
      },
      tx,
    );

    return (await reload<UserRow>(tx, 'users', userId))!;
  });

  return { user: updated, transferred };
}

/** The offboarding record for someone, so "who inherited this?" stays answerable. */
export async function getOffboarding(
  actor: Actor,
  userId: string,
): Promise<Record<string, unknown> | undefined> {
  await authorize({ actor, capability: 'user.read', resourceless: true });
  return one(
    `SELECT o.*, s.display_name AS successor_name, p.display_name AS performed_by_name
       FROM offboardings o
       LEFT JOIN users s ON s.id = o.successor_id
       LEFT JOIN users p ON p.id = o.performed_by
      WHERE o.user_id = $1 AND o.company_id = $2
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [userId, actor.companyId],
  );
}

// ---------------------------------------------------------------- desktop sessions

export type DesktopGrant = {
  accessToken: string;
  refreshToken: string;
  /** When the access token dies and the client should refresh. */
  expiresAt: string;
  /** The hard ceiling. After this the person signs in again, however active they were. */
  absoluteExpiresAt: string;
};

/**
 * Issues a desktop session: a short access token plus the refresh token that renews it.
 *
 * Both are opaque and stored only as hashes, exactly like the browser session token, so a
 * database reader cannot mint either. The access token doubles as the session row's
 * token_hash, which means everything already built on sessions - revocation, suspension
 * closing access immediately, the signed-in-devices screen - applies to desktop clients
 * without a second code path to keep in step.
 */
export async function issueDesktopSession(
  user: UserRow,
  ctx: RequestContext,
  deviceLabel?: string | null,
): Promise<DesktopGrant> {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const id = newId();

  await pool.query(
    `INSERT INTO sessions
       (id, company_id, user_id, kind, token_hash, refresh_token_hash, csrf_secret,
        device, ip, user_agent, expires_at, absolute_expires_at)
     VALUES ($1,$2,$3,'desktop',$4,$5,$6,$7,$8,$9,
             DATE_ADD(NOW(3), INTERVAL $10 MINUTE),
             DATE_ADD(NOW(3), INTERVAL $11 DAY))`,
    [
      id,
      user.company_id,
      user.id,
      hashToken(accessToken),
      hashToken(refreshToken),
      // Bearer-authenticated calls carry no cookie, so there is nothing for a
      // double-submit token to prove. The column stays populated rather than nullable so
      // the browser path's assumptions hold unchanged.
      generateToken(24),
      deviceLabel?.slice(0, 160) ?? null,
      ctx.ip,
      ctx.userAgent?.slice(0, 400) ?? null,
      config.security.desktopAccessMinutes,
      config.security.desktopSessionDays,
    ],
  );

  const row = await one<{ expires_at: Date; absolute_expires_at: Date }>(
    'SELECT expires_at, absolute_expires_at FROM sessions WHERE id = $1',
    [id],
  );
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(row!.expires_at).toISOString(),
    absoluteExpiresAt: new Date(row!.absolute_expires_at).toISOString(),
  };
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * The refresh token rotates on every use, and a token that has already been rotated is
 * treated as stolen rather than as a mistake: presenting one revokes the entire chain it
 * belongs to, so an attacker who copied a token off a machine loses access the moment the
 * real client refreshes, and the real client loses it too and has to sign in. That is the
 * intended outcome - a silent race between two holders of the same credential is worse
 * than an interrupted session.
 *
 * The absolute expiry is carried forward untouched, so refreshing cannot extend a session
 * past its five days.
 */
export async function refreshDesktopSession(
  refreshToken: string,
  ctx: RequestContext,
): Promise<DesktopGrant> {
  const hashed = hashToken(refreshToken);

  const current = await one<{
    id: string;
    user_id: string;
    company_id: string;
    revoked_at: Date | null;
    absolute_expires_at: Date;
    device: string | null;
  }>(
    `SELECT id, user_id, company_id, revoked_at, absolute_expires_at, device
       FROM sessions
      WHERE refresh_token_hash = $1 AND kind = 'desktop'`,
    [hashed],
  );

  if (!current) throw unauthenticated('This session is no longer valid');

  // Already rotated or explicitly revoked: the credential is in more hands than it should
  // be, so the whole chain goes.
  if (current.revoked_at) {
    await revokeSessionChain(current.id);
    throw unauthenticated('This session was ended for security reasons; sign in again');
  }

  if (new Date(current.absolute_expires_at) <= new Date()) {
    await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [current.id]);
    throw unauthenticated('Your session has reached its limit; sign in again');
  }

  const user = await findUserById(current.user_id);
  if (!user || user.status !== 'active') {
    await pool.query('UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1', [current.id]);
    throw unauthenticated('This account is not available');
  }

  const accessToken = generateToken();
  const nextRefresh = generateToken();
  const id = newId();

  await transaction(async (tx) => {
    // Retiring the old row and inserting the new one together means there is never a
    // moment where both are live, and never one where neither is.
    const retired = await tx.query(
      'UPDATE sessions SET revoked_at = NOW(3) WHERE id = $1 AND revoked_at IS NULL',
      [current.id],
    );
    if (retired.rowCount === 0) throw unauthenticated('This session is no longer valid');

    await tx.query(
      `INSERT INTO sessions
         (id, company_id, user_id, kind, token_hash, refresh_token_hash, csrf_secret,
          device, ip, user_agent, expires_at, absolute_expires_at, rotated_from)
       VALUES ($1,$2,$3,'desktop',$4,$5,$6,$7,$8,$9,
               DATE_ADD(NOW(3), INTERVAL $10 MINUTE), $11, $12)`,
      [
        id,
        current.company_id,
        current.user_id,
        hashToken(accessToken),
        hashToken(nextRefresh),
        generateToken(24),
        current.device,
        ctx.ip,
        ctx.userAgent?.slice(0, 400) ?? null,
        config.security.desktopAccessMinutes,
        current.absolute_expires_at,
        current.id,
      ],
    );
  });

  const row = await one<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE id = $1', [id]);
  return {
    accessToken,
    refreshToken: nextRefresh,
    expiresAt: new Date(row!.expires_at).toISOString(),
    absoluteExpiresAt: new Date(current.absolute_expires_at).toISOString(),
  };
}

/**
 * Revokes every session in a rotation chain, walking both directions from one member.
 *
 * A stolen refresh token is only useful because it descends from a real sign-in, so
 * cutting the branch it sits on is not enough - the whole lineage goes.
 */
export async function revokeSessionChain(sessionId: string): Promise<void> {
  const seen = new Set<string>();
  const queue = [sessionId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const parent = await one<{ rotated_from: string | null }>(
      'SELECT rotated_from FROM sessions WHERE id = $1',
      [id],
    );
    if (parent?.rotated_from) queue.push(parent.rotated_from);

    const children = await many<{ id: string }>(
      'SELECT id FROM sessions WHERE rotated_from = $1',
      [id],
    );
    for (const child of children) queue.push(child.id);
  }

  if (seen.size > 0) {
    await pool.query(
      `UPDATE sessions SET revoked_at = NOW(3)
        WHERE id IN (${[...seen].map((_, i) => `$${i + 1}`).join(',')}) AND revoked_at IS NULL`,
      [...seen],
    );
  }
}
