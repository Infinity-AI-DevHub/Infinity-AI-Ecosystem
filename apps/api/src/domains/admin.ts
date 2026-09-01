/**
 * Administration and audit access (blueprint 04/15).
 * Audit reads are themselves privileged and are recorded - access monitoring is part of
 * the control, not an afterthought.
 */
import { jsonArray, many, newId, one, pool } from '../core/db.js';
import { notFound, forbidden } from '../core/errors.js';
import { authorize, invalidateCapabilityCache, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { decodeCursor, encodeCursor } from '../core/validation.js';
import { stats as realtimeStats } from '../core/realtime.js';
import { config } from '../core/config.js';

export async function companySettings(actor: Actor) {
  await authorize({ actor, capability: 'settings.read', resourceless: true });
  const company = await one(
    `SELECT id, name, legal_name, verified_domains, region, status, settings, created_at
       FROM companies WHERE id = $1`,
    [actor.companyId],
  );
  if (!company) throw notFound('Company not found');
  return company;
}

export async function updateSettings(
  actor: Actor,
  input: { name?: string; legalName?: string | null; settings?: Record<string, unknown> },
) {
  await authorize({ actor, capability: 'settings.update', resourceless: true });
  const before = await companySettings(actor);
  await pool.query(
    `UPDATE companies SET
       name = COALESCE($2, name),
       legal_name = CASE WHEN $3 THEN $4 ELSE legal_name END,
       settings = COALESCE($5, settings),
       updated_at = NOW(3)
     WHERE id = $1`,
    [
      actor.companyId,
      input.name ?? null,
      'legalName' in input,
      input.legalName ?? null,
      input.settings ? JSON.stringify(input.settings) : null,
    ],
  );
  const res = await pool.query(
    `SELECT id, name, legal_name, verified_domains, region, status, settings
       FROM companies WHERE id = $1`,
    [actor.companyId],
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
  // JSON_ARRAY_APPEND is a no-op guarded by the JSON_CONTAINS test, so re-adding an
  // existing domain neither duplicates it nor errors.
  await pool.query(
    `UPDATE companies
        SET verified_domains = JSON_ARRAY_APPEND(verified_domains, '$', $2),
            updated_at = NOW(3)
      WHERE id = $1 AND NOT JSON_CONTAINS(verified_domains, JSON_QUOTE($2))`,
    [actor.companyId, clean],
  );
  const res = await pool.query<{ verified_domains: unknown }>(
    'SELECT verified_domains FROM companies WHERE id = $1',
    [actor.companyId],
  );
  await auditFromActor(actor, 'company.domain_added', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { domain: clean },
  });
  return res.rows[0] ? { verified_domains: jsonArray(res.rows[0].verified_domains) } : companySettings(actor);
}

export async function listGroups(actor: Actor) {
  await authorize({ actor, capability: 'user.read', resourceless: true });
  return many(
    `SELECT g.id, g.name, g.description,
            (SELECT count(*) FROM group_members m WHERE m.group_id = g.id) AS member_count
       FROM \`groups\` g WHERE g.company_id = $1 ORDER BY g.name`,
    [actor.companyId],
  );
}

export async function createGroup(actor: Actor, name: string, description?: string) {
  await authorize({ actor, capability: 'user.update', resourceless: true });
  const groupId = newId();
  const res = await pool.query(
    'INSERT IGNORE INTO `groups` (id, company_id, name, description) VALUES ($1,$2,$3,$4)',
    [groupId, actor.companyId, name.trim(), description ?? null],
  );
  if (res.rowCount === 0) {
    const { conflict } = await import('../core/errors.js');
    throw conflict('A group with that name already exists');
  }
  await auditFromActor(actor, 'group.create', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { name },
  });
  return { id: groupId, name: name.trim(), description: description ?? null };
}

/** The editor needs the actual membership set, not just its count, to avoid destructive saves. */
export async function listGroupMemberIds(actor: Actor, groupId: string): Promise<string[]> {
  await authorize({ actor, capability: 'user.read', resourceless: true });
  const group = await one('SELECT 1 FROM `groups` WHERE id = $1 AND company_id = $2', [
    groupId,
    actor.companyId,
  ]);
  if (!group) throw notFound('Group not found');
  const rows = await many<{ user_id: string }>(
    'SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY user_id',
    [groupId],
  );
  return rows.map((row) => row.user_id);
}

/** Apply only the administrator's changes, preserving memberships changed elsewhere meanwhile. */
export async function changeGroupMembers(
  actor: Actor,
  groupId: string,
  input: { addUserIds: string[]; removeUserIds: string[] },
): Promise<void> {
  await authorize({ actor, capability: 'user.update', resourceless: true });
  const group = await one('SELECT 1 FROM `groups` WHERE id = $1 AND company_id = $2', [
    groupId,
    actor.companyId,
  ]);
  if (!group) throw notFound('Group not found');

  const removed = [...new Set(input.removeUserIds)];
  const removedSet = new Set(removed);
  const added = [...new Set(input.addUserIds)].filter((userId) => !removedSet.has(userId));

  if (removed.length > 0) {
    await pool.query(
      `DELETE FROM group_members
        WHERE group_id = $1 AND JSON_CONTAINS($2, JSON_QUOTE(user_id))`,
      [groupId, JSON.stringify(removed)],
    );
  }
  for (const userId of added) {
    await pool.query(
      `INSERT IGNORE INTO group_members (group_id, user_id) SELECT $1, id FROM users
        WHERE id = $2 AND company_id = $3`,
      [groupId, userId, actor.companyId],
    );
  }
  invalidateCapabilityCache();
  await auditFromActor(actor, 'group.members_changed', {
    resourceType: 'company',
    resourceId: actor.companyId,
    metadata: { groupId, added: added.length, removed: removed.length },
  });
}

export async function listDepartments(companyId: string) {
  return many(
    `SELECT d.id, d.name, d.parent_id,
            (SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.status = 'active') AS headcount
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
    `SELECT id, actor_email, action, resource_type, resource_id, result, ip,
            correlation_id, metadata, created_at
       FROM audit_events
      WHERE company_id = $1
        AND ($2 IS NULL OR action = $2)
        AND ($3 IS NULL OR actor_id = $3)
        AND ($4 IS NULL OR resource_type = $4)
        AND ($5 IS NULL OR resource_id = $5)
        AND ($6 IS NULL OR created_at >= $6)
        AND ($7 IS NULL OR created_at <= $7)
        AND ($8 IS NULL OR (created_at, id) < ($8, $9))
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
      `SELECT count(*) AS pending,
              TIMESTAMPDIFF(SECOND, min(available_at), NOW(3)) AS oldest_seconds
         FROM outbox_events WHERE processed_at IS NULL`,
    ),
    one<{ count: number }>(`SELECT count(*) AS count FROM dead_letters WHERE created_at > DATE_SUB(NOW(3), INTERVAL 7 DAY)`),
    one<{ active: number; invited: number; suspended: number }>(
      `SELECT COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
              COUNT(CASE WHEN status = 'invited' THEN 1 END) AS invited,
              COUNT(CASE WHEN status = 'suspended' THEN 1 END) AS suspended
         FROM users WHERE company_id = $1`,
      [actor.companyId],
    ),
    one<{ count: number }>(
      `SELECT count(*) AS count FROM sessions
        WHERE company_id = $1 AND revoked_at IS NULL AND expires_at > NOW(3)`,
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
    `SELECT created_at, actor_email, action, resource_type, resource_id, result, ip
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
