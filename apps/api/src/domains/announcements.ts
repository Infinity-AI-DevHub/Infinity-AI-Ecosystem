/**
 * Announcements (blueprint 04). Targeted company/department/group broadcasts with
 * scheduling, acknowledgements, expiry and administrator moderation.
 */
import { many, one, pool, transaction } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';
import * as searchIndex from './search.js';

export type Audience =
  | { scope: 'company' }
  | { scope: 'department'; departmentIds: string[] }
  | { scope: 'group'; groupIds: string[] };

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
    const res = await tx.query<AnnouncementRow>(
      `INSERT INTO announcements
         (company_id, author_id, title, body, priority, audience, requires_ack, publish_at, expires_at, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, now()),$9,'published')
       RETURNING *`,
      [
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
    const created = res.rows[0]!;
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

/** Returns the announcements this specific person is targeted by. */
export async function listForUser(actor: Actor, limit = 20) {
  return many(
    `SELECT a.id, a.title, a.body, a.priority, a.requires_ack, a.publish_at, a.expires_at,
            u.display_name AS author_name,
            r.read_at, r.acknowledged_at
       FROM announcements a
       LEFT JOIN users u ON u.id = a.author_id
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
      WHERE a.company_id = $1
        AND a.state = 'published'
        AND a.publish_at <= now()
        AND (a.expires_at IS NULL OR a.expires_at > now())
        AND (
          a.audience->>'scope' = 'company'
          OR (a.audience->>'scope' = 'department'
              AND $3::uuid IS NOT NULL
              AND a.audience->'departmentIds' ? $3::text)
          OR (a.audience->>'scope' = 'group'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(a.audience->'groupIds') g
                 WHERE g.value = ANY($4::text[])))
        )
      ORDER BY
        CASE a.priority WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
        a.publish_at DESC
      LIMIT $5`,
    [actor.companyId, actor.userId, actor.departmentId, actor.groupIds.map(String), limit],
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
        AND a.publish_at <= now()
        AND (a.expires_at IS NULL OR a.expires_at > now())
        AND (
          a.audience->>'scope' = 'company'
          OR (a.audience->>'scope' = 'department'
              AND $4::uuid IS NOT NULL
              AND a.audience->'departmentIds' ? $4::text)
          OR (a.audience->>'scope' = 'group'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(a.audience->'groupIds') g
                 WHERE g.value = ANY($5::text[])))
        )`,
    [actor.companyId, actor.userId, announcementId, actor.departmentId, actor.groupIds.map(String)],
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
     VALUES ($1,$2, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (announcement_id, user_id) DO UPDATE
       SET acknowledged_at = COALESCE(announcement_reads.acknowledged_at,
                                      CASE WHEN $3 THEN now() ELSE NULL END)`,
    [announcementId, actor.userId, acknowledge],
  );
}

/** Delivery and acknowledgement statistics for the author or an administrator. */
export async function stats(actor: Actor, announcementId: string) {
  await authorize({ actor, capability: 'announcement.create', resourceless: true });
  const row = await one<{ reads: number; acks: number; audience_size: number }>(
    `SELECT (SELECT count(*)::int FROM announcement_reads WHERE announcement_id = $1) AS reads,
            (SELECT count(*)::int FROM announcement_reads
              WHERE announcement_id = $1 AND acknowledged_at IS NOT NULL) AS acks,
            (SELECT count(*)::int FROM users WHERE company_id = $2 AND status = 'active') AS audience_size`,
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
