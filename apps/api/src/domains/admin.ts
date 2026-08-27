/**
 * Administration and audit access (blueprint 04/15).
 * Audit reads are themselves privileged and are recorded - access monitoring is part of
 * the control, not an afterthought.
 */
import { many, one, pool } from '../core/db.js';
import { notFound, forbidden } from '../core/errors.js';
import { authorize, invalidateCapabilityCache, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { decodeCursor, encodeCursor } from '../core/validation.js';
import { stats as realtimeStats } from '../core/realtime.js';
import { config } from '../core/config.js';

export async function companySettings(actor: Actor) {
  await authorize({ actor, capability: 'settings.read', resourceless: true });
  const company = await one(
    'SELECT id, name, verified_domains, region, status, settings, created_at FROM companies WHERE id = $1',
    [actor.companyId],
  );
  if (!company) throw notFound('Company not found');
  return company;
}

export async function updateSettings(
  actor: Actor,
  input: { name?: string; settings?: Record<string, unknown> },
) {
  await authorize({ actor, capability: 'settings.update', resourceless: true });
  const before = await companySettings(actor);
  const res = await pool.query(
    `UPDATE companies SET
       name = COALESCE($2, name),
       settings = COALESCE($3::jsonb, settings),
       updated_at = now()
     WHERE id = $1
     RETURNING id, name, verified_domains, region, status, settings`,
    [actor.companyId, input.name ?? null, input.settings ? JSON.stringify(input.settings) : null],
  );
  await auditFromActor(actor, 'settings.update', {
    resourceType: 'company',
    resourceId: actor.companyId,
    before,
    after: res.rows[0],
  });
  return res.rows[0];
}

/** Domain verification is a super-administrator action - it changes who can be created. */
export async function addVerifiedDomain(actor: Actor, domain: string) {
  if (actor.accessLevel !== 'super_admin') {
    throw forbidden('Only a super administrator can change verified domains');
  }
  await authorize({ actor, capability: 'domain.manage', resourceless: true });
  const clean = domain.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)) {
    const { unprocessable } = await import('../core/errors.js');
    throw unprocessable('That is not a valid domain name', [{ field: 'domain', message: 'Example: company.com' }]);
  }
  const res = await pool.query<{ verified_domains: string[] }>(
    `UPDATE companies SET verified_domains = array_append(verified_domains, $2), updated_at = now()
      WHERE id = $1 AND NOT ($2 = ANY(verified_domains))
      RETURNING verified_domains`,
    [actor.companyId, clean],
  );
  await auditFromActor(actor, 'company.domain_added', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { domain: clean },
  });
  return res.rows[0] ?? (await companySettings(actor));
}

export async function listGroups(actor: Actor) {
  await authorize({ actor, capability: 'user.read', resourceless: true });
  return many(
    `SELECT g.id, g.name, g.description,
            (SELECT count(*)::int FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM groups g WHERE g.company_id = $1 ORDER BY g.name`,
    [actor.companyId],
  );
}

export async function createGroup(actor: Actor, name: string, description?: string) {
  await authorize({ actor, capability: 'user.update', resourceless: true });
  const res = await pool.query(
    `INSERT INTO groups (company_id, name, description) VALUES ($1,$2,$3)
     ON CONFLICT (company_id, name) DO NOTHING RETURNING id, name, description`,
    [actor.companyId, name.trim(), description ?? null],
  );
  if (!res.rows[0]) {
    const { conflict } = await import('../core/errors.js');
    throw conflict('A group with that name already exists');
  }
  await auditFromActor(actor, 'group.create', { resourceType: 'company', resourceId: actor.companyId, metadata: { name } });
  return res.rows[0];
}

export async function setGroupMembers(actor: Actor, groupId: string, userIds: string[]) {
  await authorize({ actor, capability: 'user.update', resourceless: true });
  const group = await one('SELECT 1 FROM groups WHERE id = $1 AND company_id = $2', [groupId, actor.companyId]);
  if (!group) throw notFound('Group not found');
  await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id <> ALL($2::uuid[])', [
    groupId,
    userIds,
  ]);
  for (const userId of userIds) {
    await pool.query(
      `INSERT INTO group_members (group_id, user_id) SELECT $1, id FROM users
        WHERE id = $2 AND company_id = $3 ON CONFLICT DO NOTHING`,
      [groupId, userId, actor.companyId],
    );
  }
  // Group membership feeds authorization; caches must not keep the old answer.
  invalidateCapabilityCache();
  await auditFromActor(actor, 'group.members_set', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { groupId, count: userIds.length },
  });
}

export async function listDepartments(companyId: string) {
  return many(
    `SELECT d.id, d.name, d.parent_id,
            (SELECT count(*)::int FROM users u WHERE u.department_id = d.id AND u.status = 'active') AS headcount
       FROM departments d WHERE d.company_id = $1 ORDER BY d.name`,
    [companyId],
  );
}

/** Privileged, filtered, paginated audit access. The read itself is audited. */
export async function readAudit(
  actor: Actor,
  filters: {
    action?: string;
    actorId?: string;
    resourceType?: string;
    resourceId?: string;
    from?: string;
    to?: string;
    limit: number;
    cursor?: string;
  },
) {
  await authorize({ actor, capability: 'audit.read', resourceless: true });
  const cursor = decodeCursor(filters.cursor);
  const rows = await many<{
    id: number;
    actor_email: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    result: string;
    ip: string | null;
    correlation_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, actor_email, action, resource_type, resource_id, result, host(ip) AS ip,
            correlation_id, metadata, created_at
       FROM audit_events
      WHERE company_id = $1
        AND ($2::text IS NULL OR action = $2)
        AND ($3::uuid IS NULL OR actor_id = $3)
        AND ($4::text IS NULL OR resource_type = $4)
        AND ($5::uuid IS NULL OR resource_id = $5)
        AND ($6::timestamptz IS NULL OR created_at >= $6)
        AND ($7::timestamptz IS NULL OR created_at <= $7)
        AND ($8::timestamptz IS NULL OR (created_at, id) < ($8, $9::bigint))
      ORDER BY created_at DESC, id DESC
      LIMIT $10`,
    [
      actor.companyId,
      filters.action ?? null,
      filters.actorId ?? null,
      filters.resourceType ?? null,
      filters.resourceId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      cursor?.at ?? null,
      cursor?.id ?? null,
      filters.limit + 1,
    ],
  );
  await auditFromActor(actor, 'audit.read', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { filters: { action: filters.action ?? null, from: filters.from ?? null } },
  });
  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }) : null,
  };
}

/** Operational health for the admin console: queue depth, sockets, failures. */
export async function operationsSnapshot(actor: Actor) {
  await authorize({ actor, capability: 'settings.read', resourceless: true });
  const [queue, deadLetters, users, sessions] = await Promise.all([
    one<{ pending: number; oldest_seconds: number | null }>(
      `SELECT count(*)::int AS pending,
              EXTRACT(EPOCH FROM (now() - min(available_at)))::int AS oldest_seconds
         FROM outbox_events WHERE processed_at IS NULL`,
    ),
    one<{ count: number }>(`SELECT count(*)::int AS count FROM dead_letters WHERE created_at > now() - interval '7 days'`),
    one<{ active: number; invited: number; suspended: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'invited')::int AS invited,
              count(*) FILTER (WHERE status = 'suspended')::int AS suspended
         FROM users WHERE company_id = $1`,
      [actor.companyId],
    ),
    one<{ count: number }>(
      `SELECT count(*)::int AS count FROM sessions
        WHERE company_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [actor.companyId],
    ),
  ]);
  return {
    queue: { pending: queue?.pending ?? 0, oldestSeconds: queue?.oldest_seconds ?? 0 },
    deadLetters: deadLetters?.count ?? 0,
    users: users ?? { active: 0, invited: 0, suspended: 0 },
    activeSessions: sessions?.count ?? 0,
    realtime: realtimeStats(),
    providers: {
      notifications: config.notifications.driver,
      storage: config.storage.driver,
      meetings: config.meetings.provider,
      malwareScanner: process.env.CLAMAV_HOST ? 'clamav' : 'not configured',
    },
    retention: config.retention,
  };
}

/** CSV export for compliance. Exports are capability-gated and audited. */
export async function exportAudit(actor: Actor, from: string, to: string): Promise<string> {
  await authorize({ actor, capability: 'audit.export', resourceless: true });
  const rows = await many<{
    created_at: Date;
    actor_email: string | null;
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    result: string;
    ip: string | null;
  }>(
    `SELECT created_at, actor_email, action, resource_type, resource_id, result, host(ip) AS ip
       FROM audit_events
      WHERE company_id = $1 AND created_at >= $2 AND created_at <= $3
      ORDER BY created_at
      LIMIT 100000`,
    [actor.companyId, from, to],
  );
  await auditFromActor(actor, 'audit.export', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { from, to, rowCount: rows.length },
  });
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const header = 'timestamp,actor,action,resource_type,resource_id,result,ip';
  const lines = rows.map((r) =>
    [r.created_at.toISOString(), r.actor_email, r.action, r.resource_type, r.resource_id, r.result, r.ip]
      .map(escape)
      .join(','),
  );
  return [header, ...lines].join('\n');
}
