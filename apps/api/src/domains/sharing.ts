/**
 * Sharing work with clients and guests.
 *
 * All three kinds of share — a task, a document, a folder — are the same underlying act:
 * a grant naming a subject, a resource and the capabilities that subject holds on it.
 * The difference between "view only" and "view and upload" is which capabilities go in
 * the grant, not a separate mechanism.
 *
 * Guests hold nothing company-wide. A guest with file.create can create a file inside a
 * folder they were granted and nowhere else, because every read and write still
 * authorizes against the specific record.
 */
import { many, newId, one, pool, transaction } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { emit } from '../core/outbox.js';

export type ShareableType = 'task' | 'doc' | 'folder';
export type AccessLevel = 'view' | 'contribute';

/**
 * What each level actually grants.
 *
 * Tasks and documents are view-only on purpose: an external contact commenting on a task
 * or editing a handbook page is a different feature with different consequences, and
 * quietly allowing it because the capability existed would be the wrong default.
 */
const CAPABILITIES: Record<ShareableType, Record<AccessLevel, string[]>> = {
  task: { view: ['task.read'], contribute: ['task.read'] },
  doc: { view: ['doc.read'], contribute: ['doc.read'] },
  folder: {
    view: ['file.read'],
    contribute: ['file.read', 'file.create', 'file.update'],
  },
};

/** The capability someone needs to give a resource away. */
const SHARE_CAPABILITY: Record<ShareableType, string> = {
  // Not `task.update`: editing a task and choosing who may see it are different powers,
  // and an employee is trusted with the first only.
  task: 'task.share',
  doc: 'doc.update',
  folder: 'file.share_external',
};

const TABLE: Record<ShareableType, string> = {
  task: 'tasks',
  doc: 'doc_pages',
  folder: 'folders',
};

const LABEL_COLUMN: Record<ShareableType, string> = {
  task: 'title',
  doc: 'title',
  folder: 'name',
};

export async function shareWithPeople(
  actor: Actor,
  input: {
    resourceType: ShareableType;
    resourceId: string;
    userIds: string[];
    access: AccessLevel;
    expiresAt?: string | null;
    note?: string | null;
  },
) {
  await authorize({ actor, capability: SHARE_CAPABILITY[input.resourceType], resourceless: true });

  if (input.userIds.length === 0) throw badRequest('Choose at least one person to share with');
  if (input.resourceType !== 'folder' && input.access === 'contribute') {
    throw badRequest('Tasks and documents can only be shared to view');
  }

  const resource = await one<Record<string, unknown>>(
    `SELECT id, ${LABEL_COLUMN[input.resourceType]} AS label
       FROM ${TABLE[input.resourceType]} WHERE id = $1 AND company_id = $2`,
    [input.resourceId, actor.companyId],
  );
  if (!resource) throw notFound('That could not be found');

  const people = await many<{ id: string; display_name: string; access_level: string }>(
    // 'invited' as well as 'active': a guest is invited precisely so that something can
    // then be shared with them, and the invitation itself says they will see nothing
    // until it is. Requiring activation first made the documented order impossible.
    `SELECT id, display_name, access_level FROM users
      WHERE company_id = $1 AND status IN ('invited', 'active')
        AND id IN (${input.userIds.map((_, i) => `$${i + 2}`).join(',')})`,
    [actor.companyId, ...input.userIds],
  );
  if (people.length === 0) throw notFound('None of those people could be found');

  const capabilities = CAPABILITIES[input.resourceType][input.access];

  await transaction(async (tx) => {
    for (const person of people) {
      /*
       * Replace rather than accumulate. Sharing the same folder twice at different
       * levels would otherwise leave two grants, and the union of them is whatever the
       * evaluation order happens to be — which is not something anyone can reason about
       * when they are trying to revoke access.
       */
      await tx.query(
        `DELETE FROM resource_grants
          WHERE company_id = $1 AND subject_type = 'user' AND subject_id = $2
            AND resource_type = $3 AND resource_id = $4`,
        [actor.companyId, person.id, input.resourceType, input.resourceId],
      );
      await tx.query(
        `INSERT INTO resource_grants
           (id, company_id, subject_type, subject_id, resource_type, resource_id,
            effect, capabilities, conditions, granted_by, expires_at)
         VALUES ($1,$2,'user',$3,$4,$5,'allow',$6,'{}',$7,$8)`,
        [newId(), actor.companyId, person.id, input.resourceType, input.resourceId,
         JSON.stringify(capabilities), actor.userId, input.expiresAt ?? null],
      );
    }

    await emit({
      companyId: actor.companyId,
      type: 'share.granted',
      actorId: actor.userId,
      payload: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        label: String(resource.label ?? ''),
        access: input.access,
        userIds: people.map((p) => p.id),
        sharedBy: actor.displayName,
        note: input.note ?? null,
      },
    }, tx);

    await auditFromActor(actor, 'resource.shared', {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: { with: people.map((p) => p.id), access: input.access },
    }, tx);
  });

  return { shared: people.length };
}

/** Who currently has this, and at what level. */
/**
 * Who a document, task or folder can be shared with.
 *
 * Deliberately not the employee directory: that one excludes guests on purpose, so a
 * client contact never reads as a colleague. But sharing is the one place where the
 * whole point is to reach those external people, and pointing the share picker at the
 * directory meant an invited guest could never be selected - the feature was unusable
 * from the moment it was built.
 *
 * Guests carry the organisation they belong to, so the picker can say whose side a
 * person is on rather than showing a bare name.
 */
export async function shareCandidates(actor: Actor) {
  await authorize({ actor, capability: 'user.read', resourceless: true });
  return many<{
    id: string; display_name: string; email_display: string;
    access_level: string; organisation_name: string | null;
  }>(
    `SELECT u.id, u.display_name, u.email_display, u.access_level,
            o.name AS organisation_name
       FROM users u
       LEFT JOIN external_memberships m
              ON m.user_id = u.id AND m.company_id = u.company_id
       LEFT JOIN external_organizations o ON o.id = m.organization_id
      WHERE u.company_id = $1
        AND u.status IN ('invited', 'active')
        AND u.id <> $2
        -- An expired guest keeps the account but has lost access, so offering them as a
        -- share recipient would only produce a share that resolves to nothing.
        AND (m.access_expires_at IS NULL OR m.access_expires_at > NOW(3))
      ORDER BY u.access_level = 'guest', u.display_name
      LIMIT 500`,
    [actor.companyId, actor.userId],
  );
}

export async function listShares(actor: Actor, resourceType: ShareableType, resourceId: string) {
  await authorize({ actor, capability: SHARE_CAPABILITY[resourceType], resourceless: true });
  return many(
    `SELECT g.id, g.capabilities, g.expires_at, g.created_at,
            u.id AS user_id, u.display_name, u.email_display, u.access_level
       FROM resource_grants g
       JOIN users u ON u.id = g.subject_id
      WHERE g.company_id = $1 AND g.subject_type = 'user'
        AND g.resource_type = $2 AND g.resource_id = $3
      ORDER BY u.display_name`,
    [actor.companyId, resourceType, resourceId],
  );
}

export async function revokeShare(
  actor: Actor, resourceType: ShareableType, resourceId: string, userId: string,
) {
  await authorize({ actor, capability: SHARE_CAPABILITY[resourceType], resourceless: true });
  const result = await pool.query(
    `DELETE FROM resource_grants
      WHERE company_id = $1 AND subject_type = 'user' AND subject_id = $2
        AND resource_type = $3 AND resource_id = $4`,
    [actor.companyId, userId, resourceType, resourceId],
  );
  if (result.rowCount === 0) throw notFound('That share could not be found');
  await auditFromActor(actor, 'resource.share_revoked', {
    resourceType, resourceId, metadata: { user: userId },
  });
}

/**
 * A message written by a person and sent to people.
 *
 * Recorded in outbound_messages because "did anyone tell the client" is a question that
 * gets asked, and a message with no trace is indistinguishable from one never sent.
 */
export async function sendMessage(
  actor: Actor,
  input: {
    subject: string;
    body: string;
    userIds?: string[];
    groupIds?: string[];
    orgIds?: string[];
    /** Everyone active. Deliberately explicit rather than an empty selection. */
    everyone?: boolean;
  },
) {
  await authorize({ actor, capability: 'message.broadcast', resourceless: true });
  if (!input.subject.trim()) throw badRequest('Give the message a subject');
  if (!input.body.trim()) throw badRequest('The message is empty');

  const ids = new Set<string>();

  if (input.everyone) {
    for (const row of await many<{ id: string }>(
      // Colleagues who have not activated yet are still colleagues, and a message to
      // "everyone in the company" that quietly skips them is worse than useless.
      // Guests stay excluded: "everyone" means the company, not its clients.
      `SELECT id FROM users
        WHERE company_id = $1 AND status IN ('invited', 'active') AND access_level <> 'guest'`,
      [actor.companyId],
    )) ids.add(row.id);
  }
  for (const id of input.userIds ?? []) ids.add(id);

  if ((input.groupIds ?? []).length > 0) {
    for (const row of await many<{ user_id: string }>(
      `SELECT gm.user_id FROM group_members gm
        WHERE gm.group_id IN (${(input.groupIds ?? []).map((_, i) => `$${i + 1}`).join(',')})`,
      input.groupIds ?? [],
    )) ids.add(row.user_id);
  }
  if ((input.orgIds ?? []).length > 0) {
    for (const row of await many<{ user_id: string }>(
      `SELECT user_id FROM external_memberships
        WHERE organization_id IN (${(input.orgIds ?? []).map((_, i) => `$${i + 1}`).join(',')})`,
      input.orgIds ?? [],
    )) ids.add(row.user_id);
  }

  // Never to yourself: a copy of your own message reads as a bug.
  ids.delete(actor.userId);

  const recipients = await many<{ id: string; email_display: string; display_name: string }>(
    ids.size === 0 ? 'SELECT NULL AS id, NULL AS email_display, NULL AS display_name WHERE FALSE'
      // 'invited' as well: the picker offers them, so refusing them here produced a
      // message that reached nobody for a selection that looked perfectly valid.
      : `SELECT id, email_display, display_name FROM users
          WHERE company_id = $1 AND status IN ('invited', 'active')
            AND id IN (${[...ids].map((_, i) => `$${i + 2}`).join(',')})`,
    ids.size === 0 ? [] : [actor.companyId, ...ids],
  );
  if (recipients.length === 0) throw badRequest('That selection reaches nobody');

  const id = newId();
  await pool.query(
    `INSERT INTO outbound_messages
       (id, company_id, subject, body, recipients, recipient_count, audience, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, actor.companyId, input.subject.trim(), input.body,
     JSON.stringify(recipients.map((r) => ({ id: r.id, email: r.email_display }))),
     recipients.length, input.everyone ? 'everyone' : 'people', actor.userId],
  );

  await emit({
    companyId: actor.companyId,
    type: 'message.broadcast',
    actorId: actor.userId,
    payload: {
      messageId: id,
      subject: input.subject.trim(),
      body: input.body,
      from: actor.displayName,
      userIds: recipients.map((r) => r.id),
    },
  });

  await auditFromActor(actor, 'message.broadcast', {
    resourceType: 'company', resourceId: actor.companyId,
    metadata: { subject: input.subject, recipients: recipients.length },
  });

  return { id, recipients: recipients.length };
}

export async function listMessages(actor: Actor) {
  await authorize({ actor, capability: 'message.broadcast', resourceless: true });
  return many(
    `SELECT m.id, m.subject, m.recipient_count, m.audience, m.sent_at,
            u.display_name AS sent_by_name
       FROM outbound_messages m
       LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.company_id = $1
      ORDER BY m.sent_at DESC
      LIMIT 100`,
    [actor.companyId],
  );
}
