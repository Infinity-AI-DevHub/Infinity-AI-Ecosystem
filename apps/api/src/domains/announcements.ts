/**
 * Announcements (blueprint 04). Targeted company/department/group broadcasts with
 * scheduling, acknowledgements, expiry and administrator moderation.
 */
import { jsonArrayOverlaps, many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import * as searchIndex from './search.js';

export type Audience =
  | { scope: 'company' }
  | { scope: 'department'; departmentIds: string[] }
  | { scope: 'group'; groupIds: string[] }
  /**
   * A notice addressed to client organisations, read through the portal.
   *
   * Deliberately not handled by `listForUser`, which every employee reads: that query
   * matches 'company' for anyone in the row, and a guest holds a row in the same
   * company. Portal notices are read by a separate query that can only ever match this
   * scope, so an internal notice cannot reach a client by being one condition too broad.
   */
  | { scope: 'organisation'; organisationIds: string[] };

export type AnnouncementRow = {
  id: string;
  company_id: string;
  author_id: string | null;
  title: string;
  body: string;
  priority: string;
  audience: Audience;
  requires_ack: boolean;
  publish_at: Date;
  expires_at: Date | null;
  state: string;
  created_at: Date;
};

/**
 * The stored audience, however the driver hands it back.
 *
 * MySQL JSON columns arrive already parsed on some driver versions and as a string on
 * others, and getting this wrong silently addresses a notice to nobody.
 */
function parseAudience(value: unknown): Audience {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Audience; } catch { return { scope: 'company' }; }
  }
  return (value as Audience) ?? { scope: 'company' };
}

export async function create(
  actor: Actor,
  input: {
    title: string;
    body: string;
    priority?: 'normal' | 'important' | 'critical';
    audience?: Audience;
    requiresAck?: boolean;
    publishAt?: string;
    expiresAt?: string | null;
  },
): Promise<AnnouncementRow> {
  await authorize({ actor, capability: 'announcement.create', resourceless: true });
  const audience = input.audience ?? { scope: 'company' };

  const announcement = await transaction(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO announcements
         (id, company_id, author_id, title, body, priority, audience, requires_ack, publish_at, expires_at, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, NOW(3)),$10,'published')`,
      [
        id,
        actor.companyId,
        actor.userId,
        input.title.trim(),
        input.body,
        input.priority ?? 'normal',
        JSON.stringify(audience),
        input.requiresAck ?? false,
        input.publishAt ? new Date(input.publishAt) : null,
        input.expiresAt ? new Date(input.expiresAt) : null,
      ],
    );
    const created = (await reload<AnnouncementRow>(tx, 'announcements', id))!;
    await auditFromActor(
      actor,
      'announcement.publish',
      { resourceType: 'announcement', resourceId: created.id, metadata: { priority: created.priority } },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'announcement.published',
        actorId: actor.userId,
        payload: { announcementId: created.id, title: created.title, audience },
        availableAt: created.publish_at,
      },
      tx,
    );
    return created;
  });

  await searchIndex.index({
    companyId: actor.companyId,
    docType: 'announcement',
    resourceId: announcement.id,
    title: announcement.title,
    body: announcement.body,
    aclCompanyWide: audience.scope === 'company',
    aclGroupIds: audience.scope === 'group' ? audience.groupIds : [],
    link: `/announcements/${announcement.id}`,
  });
  return announcement;
}

/**
 * Correcting an announcement that has already gone out.
 *
 * A notice with the wrong date or venue is worse than no notice, and the only remedy
 * before this was to withdraw it and publish a second one - which reads as a mistake and
 * leaves two records. The audience is deliberately not editable: re-aiming a notice at a
 * different group after it has been read by the first one is a new announcement, not an
 * edit of this one.
 *
 * Everyone it was addressed to is told again, because a correction nobody sees is not a
 * correction.
 */
export async function update(
  actor: Actor,
  announcementId: string,
  input: {
    title?: string;
    body?: string;
    priority?: 'normal' | 'important' | 'critical';
    requiresAck?: boolean;
    expiresAt?: string | null;
  },
): Promise<AnnouncementRow> {
  const existing = await one<AnnouncementRow>(
    'SELECT * FROM announcements WHERE id = $1 AND company_id = $2',
    [announcementId, actor.companyId],
  );
  if (!existing) throw notFound('Announcement not found');
  if (existing.state !== 'published') {
    throw conflict('A withdrawn announcement cannot be edited');
  }

  await authorize({
    actor,
    capability: 'announcement.create',
    resourceType: 'announcement',
    resourceId: announcementId,
    membership: existing.author_id === actor.userId,
  });

  const announcement = await transaction(async (tx) => {
    await tx.query(
      `UPDATE announcements
          SET title = COALESCE($1, title),
              body = COALESCE($2, body),
              priority = COALESCE($3, priority),
              requires_ack = COALESCE($4, requires_ack),
              expires_at = CASE WHEN $6 THEN $5 ELSE expires_at END
        WHERE id = $7 AND company_id = $8`,
      [
        input.title?.trim() ?? null,
        input.body ?? null,
        input.priority ?? null,
        input.requiresAck ?? null,
        input.expiresAt ? new Date(input.expiresAt) : null,
        input.expiresAt !== undefined,
        announcementId,
        actor.companyId,
      ],
    );
    const saved = (await reload<AnnouncementRow>(tx, 'announcements', announcementId))!;
    await auditFromActor(
      actor,
      'announcement.edit',
      { resourceType: 'announcement', resourceId: announcementId, metadata: { title: saved.title } },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'announcement.updated',
        actorId: actor.userId,
        payload: {
          announcementId,
          title: saved.title,
          audience: parseAudience(saved.audience),
        },
      },
      tx,
    );
    return saved;
  });

  const audience = parseAudience(announcement.audience);
  await searchIndex.index({
    companyId: actor.companyId,
    docType: 'announcement',
    resourceId: announcement.id,
    title: announcement.title,
    body: announcement.body,
    aclCompanyWide: audience.scope === 'company',
    aclGroupIds: audience.scope === 'group' ? audience.groupIds ?? [] : [],
    link: `/announcements/${announcement.id}`,
  });
  return announcement;
}

/** Returns the announcements this specific person is targeted by. */
export async function listForUser(actor: Actor, limit = 20) {
  const groupClause = jsonArrayOverlaps("JSON_EXTRACT(a.audience, '$.groupIds')", actor.groupIds, 5);
  return many(
    `SELECT a.id, a.title, a.body, a.priority, a.requires_ack, a.publish_at, a.expires_at,
            u.display_name AS author_name,
            r.read_at, r.acknowledged_at
       FROM announcements a
       LEFT JOIN users u ON u.id = a.author_id
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
      WHERE a.company_id = $1
        AND a.state = 'published'
        AND a.publish_at <= NOW(3)
        AND (a.expires_at IS NULL OR a.expires_at > NOW(3))
        AND (
          JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'company'
          OR (JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'department'
              AND $3 IS NOT NULL
              AND JSON_CONTAINS(JSON_EXTRACT(a.audience, '$.departmentIds'), JSON_QUOTE($3)))
          OR (JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'group' AND ${groupClause})
        )
      ORDER BY
        CASE a.priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
        a.publish_at DESC
      LIMIT $4`,
    // Group ids go last so expanding them cannot shift the placeholders before them.
    [actor.companyId, actor.userId, actor.departmentId, limit, ...actor.groupIds],
  );
}

/**
 * A single announcement, scoped to the caller's audience.
 *
 * Deriving the detail view from the list would break deep links to anything outside the
 * first page, and would briefly show "not found" straight after publishing. Fetching it
 * directly also re-checks the audience, so a link forwarded to someone outside the
 * target group reads as not found rather than leaking the content.
 */
export async function getForUser(actor: Actor, announcementId: string) {
  const groupClause = jsonArrayOverlaps("JSON_EXTRACT(a.audience, '$.groupIds')", actor.groupIds, 5);
  const row = await one(
    `SELECT a.id, a.title, a.body, a.priority, a.requires_ack, a.publish_at, a.expires_at,
            u.display_name AS author_name,
            r.read_at, r.acknowledged_at
       FROM announcements a
       LEFT JOIN users u ON u.id = a.author_id
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
      WHERE a.id = $3
        AND a.company_id = $1
        AND a.state = 'published'
        AND a.publish_at <= NOW(3)
        AND (a.expires_at IS NULL OR a.expires_at > NOW(3))
        AND (
          JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'company'
          OR (JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'department'
              AND $4 IS NOT NULL
              AND JSON_CONTAINS(JSON_EXTRACT(a.audience, '$.departmentIds'), JSON_QUOTE($4)))
          OR (JSON_UNQUOTE(JSON_EXTRACT(a.audience, '$.scope')) = 'group' AND ${groupClause})
        )`,
    // Group ids last, so expanding them cannot shift the placeholders before them.
    [actor.companyId, actor.userId, announcementId, actor.departmentId, ...actor.groupIds],
  );
  if (!row) throw notFound('Announcement not found');
  return row;
}

export async function markRead(actor: Actor, announcementId: string, acknowledge: boolean): Promise<void> {
  const exists = await one('SELECT 1 FROM announcements WHERE id = $1 AND company_id = $2', [
    announcementId,
    actor.companyId,
  ]);
  if (!exists) throw notFound('Announcement not found');
  await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id, acknowledged_at)
     VALUES ($1,$2, CASE WHEN $3 THEN NOW(3) ELSE NULL END)
     ON DUPLICATE KEY UPDATE
       acknowledged_at = COALESCE(announcement_reads.acknowledged_at,
                                  CASE WHEN $3 THEN NOW(3) ELSE NULL END)`,
    [announcementId, actor.userId, acknowledge],
  );
}

/** Delivery and acknowledgement statistics for the author or an administrator. */
export async function stats(actor: Actor, announcementId: string) {
  await authorize({ actor, capability: 'announcement.create', resourceless: true });
  const row = await one<{ reads: number; acks: number; audience_size: number }>(
    `SELECT (SELECT count(*) FROM announcement_reads WHERE announcement_id = $1) AS \`reads\`,
            (SELECT count(*) FROM announcement_reads
              WHERE announcement_id = $1 AND acknowledged_at IS NOT NULL) AS acks,
            (SELECT count(*) FROM users WHERE company_id = $2 AND status = 'active') AS audience_size`,
    [announcementId, actor.companyId],
  );
  return row ?? { reads: 0, acks: 0, audience_size: 0 };
}

export async function withdraw(actor: Actor, announcementId: string): Promise<void> {
  await authorize({ actor, capability: 'announcement.manage', resourceless: true });
  const res = await pool.query(
    `UPDATE announcements SET state = 'withdrawn' WHERE id = $1 AND company_id = $2`,
    [announcementId, actor.companyId],
  );
  if (res.rowCount === 0) throw notFound('Announcement not found');
  await searchIndex.remove('announcement', announcementId);
  await auditFromActor(actor, 'announcement.withdraw', {
    resourceType: 'announcement',
    resourceId: announcementId,
  });
}
