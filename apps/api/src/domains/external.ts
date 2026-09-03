/**
 * External collaboration: client and vendor organisations, guest accounts and share
 * links.
 *
 * Client work is central here, and nothing could previously cross the company boundary:
 * the only sharing capability was internal, and every account had to sit on a verified
 * domain. This module opens that boundary deliberately and narrowly.
 *
 * The rule everything below follows: a guest holds capabilities that do nothing on their
 * own. The decision pipeline checks the capability first and then demands authorization
 * on the specific record, so a guest reaches exactly what has been granted to them
 * through resource_grants and nothing else. That is only true while no guest-reachable
 * endpoint performs a resourceless check - a resourceless capability check would turn a
 * scoped guest into a company-wide one, which is why guests hold no capability that any
 * resourceless endpoint requires.
 */
import { jsonArray, many, newId, one, pool, reload, transaction } from '../core/db.js';
import { conflict, notFound, unprocessable } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { generateToken, hashToken, hashPassword, verifyPassword } from '../core/crypto.js';
import { config } from '../core/config.js';
import { emit } from '../core/outbox.js';

export type OrganizationKind = 'client' | 'vendor' | 'partner' | 'contractor';

export type OrganizationRow = {
  id: string;
  company_id: string;
  name: string;
  kind: string;
  status: string;
  website: string | null;
  notes: string | null;
  created_at: Date;
};

// ------------------------------------------------------------------ organisations

export async function createOrganization(
  actor: Actor,
  input: {
    name: string;
    kind?: OrganizationKind;
    website?: string | null;
    notes?: string | null;
  billingEmail?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  representative?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxRegistration?: string | null;
  },
): Promise<OrganizationRow> {
  await authorize({ actor, capability: 'external_org.manage', resourceless: true });
  const name = input.name.trim();

  const existing = await one<{ id: string }>(
    'SELECT id FROM external_organizations WHERE company_id = $1 AND name = $2',
    [actor.companyId, name],
  );
  if (existing) {
    throw conflict('An organisation with that name already exists');
  }

  return transaction(async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO external_organizations
         (id, company_id, name, kind, website, notes, created_by,
          billing_email, contact_name, contact_phone, representative,
          address_line1, address_line2, city, postal_code, country, tax_registration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        actor.companyId,
        name,
        input.kind ?? 'client',
        input.website?.trim() || null,
        input.notes?.trim() || null,
        actor.userId,
        input.billingEmail?.trim().toLowerCase() || null,
        input.contactName?.trim() || null,
        input.contactPhone?.trim() || null,
        input.representative?.trim() || null,
        input.addressLine1?.trim() || null,
        input.addressLine2?.trim() || null,
        input.city?.trim() || null,
        input.postalCode?.trim() || null,
        input.country?.trim() || null,
        input.taxRegistration?.trim() || null,
      ],
    );
    await auditFromActor(
      actor,
      'external_org.create',
      { resourceType: 'external_org', resourceId: id, metadata: { name, kind: input.kind ?? 'client' } },
      tx,
    );
    return (await reload<OrganizationRow>(tx, 'external_organizations', id))!;
  });
}

/**
 * Removing a client.
 *
 * Refused while anything financial still points at it. `invoices.client_org_id` cascades
 * on delete, so removing an organisation with invoices would silently take a year of
 * billing history with it - and the person clicking "delete" is thinking about a
 * duplicate record, not about their accounts.
 *
 * A relationship that has simply ended should be marked completed instead; the message
 * says so, because otherwise the refusal reads as the system being obstructive.
 */
export async function deleteOrganization(actor: Actor, id: string): Promise<void> {
  await authorize({ actor, capability: 'external_org.manage', resourceless: true });
  const org = await getOrganization(actor, id);

  const blockers = await one<{ invoices: number; projects: number; guests: number }>(
    `SELECT
       (SELECT COUNT(*) FROM invoices WHERE client_org_id = $1) AS invoices,
       (SELECT COUNT(*) FROM projects WHERE client_org_id = $1) AS projects,
       (SELECT COUNT(*) FROM external_memberships WHERE organization_id = $1) AS guests`,
    [id],
  );

  const held: string[] = [];
  if (Number(blockers?.invoices ?? 0) > 0) held.push(`${blockers!.invoices} invoice(s)`);
  if (Number(blockers?.projects ?? 0) > 0) held.push(`${blockers!.projects} project(s)`);
  if (Number(blockers?.guests ?? 0) > 0) held.push(`${blockers!.guests} guest account(s)`);

  if (held.length > 0) {
    throw conflict(
      `${org.name} still has ${held.join(', ')} attached, so deleting it would remove them too. `
        + 'Mark it completed instead to keep the history.',
    );
  }

  await pool.query('DELETE FROM external_organizations WHERE id = $1 AND company_id = $2', [
    id, actor.companyId,
  ]);
  await auditFromActor(actor, 'external_org.delete', {
    resourceType: 'external_org', resourceId: id, metadata: { name: org.name },
  });
}

export async function listOrganizations(
  actor: Actor,
  options: { status?: string; kind?: OrganizationKind; q?: string } = {},
): Promise<OrganizationRow[]> {
  await authorize({ actor, capability: 'external_org.read', resourceless: true });
  return many<OrganizationRow>(
    `SELECT o.*,
            (SELECT COUNT(*) FROM external_memberships m WHERE m.organization_id = o.id) AS guest_count
       FROM external_organizations o
      WHERE o.company_id = $1
        AND ($2 IS NULL OR o.status = $2)
        AND ($3 IS NULL OR o.kind = $3)
        AND ($4 IS NULL OR o.name LIKE CONCAT('%', $4, '%'))
      ORDER BY o.name`,
    [actor.companyId, options.status ?? null, options.kind ?? null, options.q?.trim() || null],
  );
}

export async function getOrganization(actor: Actor, id: string): Promise<OrganizationRow> {
  await authorize({ actor, capability: 'external_org.read', resourceless: true });
  const row = await one<OrganizationRow>(
    'SELECT * FROM external_organizations WHERE id = $1 AND company_id = $2',
    [id, actor.companyId],
  );
  if (!row) throw notFound('Organisation not found');
  return row;
}

export async function updateOrganization(
  actor: Actor,
  id: string,
  input: {
    name?: string;
    kind?: OrganizationKind;
    status?: 'upcoming' | 'active' | 'completed' | 'archived';
    website?: string | null;
    notes?: string | null;
  billingEmail?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  representative?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxRegistration?: string | null;
  },
): Promise<OrganizationRow> {
  await authorize({ actor, capability: 'external_org.manage', resourceless: true });
  await getOrganization(actor, id);

  return transaction(async (tx) => {
    await tx.query(
      `UPDATE external_organizations
          SET name = COALESCE($3, name),
              kind = COALESCE($4, kind),
              status = COALESCE($5, status),
              website = COALESCE($6, website),
              notes = COALESCE($7, notes),
              billing_email = COALESCE($8, billing_email),
              contact_name = COALESCE($9, contact_name),
              contact_phone = COALESCE($10, contact_phone),
              representative = COALESCE($11, representative),
              address_line1 = COALESCE($12, address_line1),
              address_line2 = COALESCE($13, address_line2),
              city = COALESCE($14, city),
              postal_code = COALESCE($15, postal_code),
              country = COALESCE($16, country),
              tax_registration = COALESCE($17, tax_registration),
              updated_at = NOW(3)
        WHERE id = $1 AND company_id = $2`,
      [
        id,
        actor.companyId,
        input.name?.trim() ?? null,
        input.kind ?? null,
        input.status ?? null,
        input.website === undefined ? null : input.website?.trim() || null,
        input.notes === undefined ? null : input.notes?.trim() || null,
        input.billingEmail === undefined ? null : input.billingEmail?.trim().toLowerCase() || null,
        input.contactName === undefined ? null : input.contactName?.trim() || null,
        input.contactPhone === undefined ? null : input.contactPhone?.trim() || null,
        input.representative === undefined ? null : input.representative?.trim() || null,
        input.addressLine1 === undefined ? null : input.addressLine1?.trim() || null,
        input.addressLine2 === undefined ? null : input.addressLine2?.trim() || null,
        input.city === undefined ? null : input.city?.trim() || null,
        input.postalCode === undefined ? null : input.postalCode?.trim() || null,
        input.country === undefined ? null : input.country?.trim() || null,
        input.taxRegistration === undefined ? null : input.taxRegistration?.trim() || null,
      ],
    );
    await auditFromActor(
      actor,
      'external_org.update',
      { resourceType: 'external_org', resourceId: id, metadata: { changes: Object.keys(input) } },
      tx,
    );
    return (await reload<OrganizationRow>(tx, 'external_organizations', id))!;
  });
}

// ------------------------------------------------------------------ guest accounts

export type GuestRow = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  organization_id: string;
  organization_name: string;
  role_label: string | null;
  access_expires_at: Date | null;
};

/**
 * Invites a guest from an external organisation.
 *
 * Deliberately not createUser: that enforces a verified company domain, which is exactly
 * wrong here - the whole point is that this person's address belongs to someone else.
 * The compensating controls are that a guest is always tied to an organisation, always
 * created at the guest access level, and given an access expiry by default.
 */
export async function inviteGuest(
  actor: Actor,
  input: {
    organizationId: string;
    email: string;
    displayName: string;
    roleLabel?: string | null;
    accessExpiresAt?: string | null;
  },
  ctx: { ip: string | null; userAgent: string | null; correlationId: string | null },
): Promise<{ userId: string; invitationUrl: string }> {
  await authorize({ actor, capability: 'guest.manage', resourceless: true });
  const organization = await getOrganization(actor, input.organizationId);
  const email = input.email.toLowerCase().trim();

  // A colleague's address must never become a guest account: it would silently demote a
  // real employee to the guest role and strip everything they can reach.
  const company = await one<{ verified_domains: unknown }>(
    'SELECT verified_domains FROM companies WHERE id = $1',
    [actor.companyId],
  );
  // The driver hands JSON columns back already parsed, so jsonArray is the helper that
  // copes with both that and a string, rather than JSON.parse which chokes on the former.
  const domains = jsonArray(company?.verified_domains);
  const domain = email.split('@')[1] ?? '';
  if (domains.includes(domain)) {
    throw unprocessable('That address belongs to this company', [
      {
        field: 'email',
        message: 'Colleagues are added through People, not as guests',
      },
    ]);
  }

  const existing = await one<{ id: string; access_level: string }>(
    'SELECT id, access_level FROM users WHERE company_id = $1 AND email = $2',
    [actor.companyId, email],
  );
  if (existing) throw conflict('That address already has an account here');

  // Access ends by default. An engagement that finishes without anyone remembering to
  // revoke is how a client keeps a working door into the company for years.
  const expiresAt = input.accessExpiresAt
    ? new Date(input.accessExpiresAt)
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  const token = generateToken();
  const userId = newId();

  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO users (id, company_id, email, email_display, display_name, access_level, status, modules)
       VALUES ($1,$2,$3,$4,$5,'guest','invited', JSON_ARRAY())`,
      [userId, actor.companyId, email, input.email.trim(), input.displayName.trim()],
    );
    await tx.query('INSERT INTO identities (user_id) VALUES ($1)', [userId]);
    await tx.query(
      `INSERT INTO external_memberships (user_id, organization_id, company_id, role_label, access_expires_at, invited_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, organization.id, actor.companyId, input.roleLabel?.trim() || null, expiresAt, actor.userId],
    );
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
    await auditFromActor(
      actor,
      'guest.invite',
      {
        resourceType: 'user',
        resourceId: userId,
        metadata: { organizationId: organization.id, organizationName: organization.name, email },
      },
      tx,
    );
    await emit(
      {
        companyId: actor.companyId,
        type: 'user.invited',
        actorId: actor.userId,
        correlationId: ctx.correlationId,
        payload: {
          userId,
          email,
          displayName: input.displayName.trim(),
          invitationToken: token,
          /*
           * Marks this as a client invitation rather than a colleague's.
           *
           * The two need different letters: a client is being invited to the portal,
           * which is on the web and needs nothing installed, and telling them to
           * "activate your Infinity Workspace account" points them at an application
           * they will never be allowed into.
           */
          portal: true,
          organisationName: organization.name,
        },
      },
      tx,
    );
  });

  // The portal's own activation link: same token, but it lands them in the portal
  // rather than at the staff workspace's sign-in screen.
  return { userId, invitationUrl: `${config.publicUrl}/portal/activate?token=${token}` };
}

export async function listGuests(actor: Actor, organizationId?: string): Promise<GuestRow[]> {
  await authorize({ actor, capability: 'external_org.read', resourceless: true });
  return many<GuestRow>(
    `SELECT u.id, u.email, u.display_name, u.status,
            m.organization_id, m.role_label, m.access_expires_at,
            o.name AS organization_name
       FROM external_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN external_organizations o ON o.id = m.organization_id
      WHERE m.company_id = $1
        AND ($2 IS NULL OR m.organization_id = $2)
      ORDER BY o.name, u.display_name`,
    [actor.companyId, organizationId ?? null],
  );
}

/**
 * Grants a guest access to one specific resource.
 *
 * This is the only thing that makes a guest's capabilities mean anything, so it is the
 * single place where the company boundary actually opens, and it always names both the
 * resource and an expiry inherited from the guest's own access window.
 */
export async function grantGuestAccess(
  actor: Actor,
  input: {
    guestId: string;
    resourceType: 'project' | 'folder' | 'file' | 'chat_room';
    resourceId: string;
    capabilities: string[];
    expiresAt?: string | null;
  },
): Promise<void> {
  await authorize({ actor, capability: 'guest.manage', resourceless: true });

  const membership = await one<{ user_id: string; access_expires_at: Date | null }>(
    'SELECT user_id, access_expires_at FROM external_memberships WHERE user_id = $1 AND company_id = $2',
    [input.guestId, actor.companyId],
  );
  if (!membership) throw notFound('Guest not found');

  // A grant may not outlive the guest's own access. Otherwise revoking someone at the
  // end of an engagement would leave individually granted resources still reachable.
  const guestExpiry = membership.access_expires_at ? new Date(membership.access_expires_at) : null;
  const requested = input.expiresAt ? new Date(input.expiresAt) : guestExpiry;
  const expiresAt =
    requested && guestExpiry && requested > guestExpiry ? guestExpiry : requested ?? guestExpiry;

  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO resource_grants
         (id, company_id, subject_type, subject_id, resource_type, resource_id, effect, capabilities, conditions, granted_by, expires_at)
       VALUES ($1,$2,'user',$3,$4,$5,'allow',$6, JSON_OBJECT(), $7, $8)`,
      [
        newId(),
        actor.companyId,
        input.guestId,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.capabilities),
        actor.userId,
        expiresAt,
      ],
    );
    await auditFromActor(
      actor,
      'guest.grant',
      {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: { guestId: input.guestId, capabilities: input.capabilities, expiresAt },
      },
      tx,
    );
  });
}

/** Ends a guest's access immediately: every grant, every session, every token. */
export async function revokeGuest(actor: Actor, guestId: string, reason: string): Promise<void> {
  await authorize({ actor, capability: 'guest.manage', resourceless: true });
  const membership = await one<{ user_id: string }>(
    'SELECT user_id FROM external_memberships WHERE user_id = $1 AND company_id = $2',
    [guestId, actor.companyId],
  );
  if (!membership) throw notFound('Guest not found');

  await transaction(async (tx) => {
    await tx.query(
      `UPDATE users SET status = 'suspended', suspended_at = NOW(3), version = version + 1, updated_at = NOW(3)
        WHERE id = $1 AND company_id = $2`,
      [guestId, actor.companyId],
    );
    await tx.query(
      `UPDATE resource_grants SET expires_at = NOW(3)
        WHERE company_id = $1 AND subject_type = 'user' AND subject_id = $2
          AND (expires_at IS NULL OR expires_at > NOW(3))`,
      [actor.companyId, guestId],
    );
    await tx.query('UPDATE sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [guestId]);
    await tx.query('UPDATE api_tokens SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL', [guestId]);
    await auditFromActor(
      actor,
      'guest.revoke',
      { resourceType: 'user', resourceId: guestId, metadata: { reason } },
      tx,
    );
  });
}

/** What a guest can currently reach, for the reviewer deciding whether it is still needed. */
export async function listGuestGrants(actor: Actor, guestId: string): Promise<unknown[]> {
  await authorize({ actor, capability: 'external_org.read', resourceless: true });
  return many(
    `SELECT id, resource_type, resource_id, capabilities, expires_at, created_at
       FROM resource_grants
      WHERE company_id = $1 AND subject_type = 'user' AND subject_id = $2
      ORDER BY created_at DESC`,
    [actor.companyId, guestId],
  );
}

// ------------------------------------------------------------------ share links

export type ShareLinkRow = {
  id: string;
  company_id: string;
  resource_type: string;
  resource_id: string;
  recipient_email: string | null;
  allow_download: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
};

const MAX_SHARE_DAYS = 90;

/**
 * Creates an expiring link to a file or folder for someone with no account.
 *
 * The token is a capability in a URL: anyone holding it holds the access. So it is
 * stored only as a hash, always expires, may be capped by use count, and may carry a
 * password as a second factor for genuinely sensitive material.
 */
export async function createShareLink(
  actor: Actor,
  input: {
    resourceType: 'file' | 'folder' | 'doc';
    resourceId: string;
    expiresInDays?: number;
    password?: string | null;
    recipientEmail?: string | null;
    allowDownload?: boolean;
    maxUses?: number | null;
    resourceName?: string;
    message?: string | null;
  },
): Promise<{ link: ShareLinkRow; url: string }> {
  /**
   * The share table calls a documentation page 'doc'; the authorization layer calls it
   * 'doc_page'. Mapping here keeps both vocabularies honest rather than widening the
   * permission type to accept a name it has no policy for.
   */
  await authorize({
    actor,
    capability: 'file.share_external',
    resourceType: input.resourceType === 'doc' ? 'doc_page' : input.resourceType,
    resourceId: input.resourceId,
  });

  const days = Math.min(Math.max(input.expiresInDays ?? 14, 1), MAX_SHARE_DAYS);
  const token = generateToken();
  const id = newId();

  const link = await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO share_links
         (id, company_id, resource_type, resource_id, token_hash, password_hash,
          recipient_email, allow_download, max_uses, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, DATE_ADD(NOW(3), INTERVAL $10 DAY), $11)`,
      [
        id,
        actor.companyId,
        input.resourceType,
        input.resourceId,
        hashToken(token),
        input.password ? await hashPassword(input.password) : null,
        input.recipientEmail?.toLowerCase().trim() || null,
        input.allowDownload ?? true,
        input.maxUses ?? null,
        days,
        actor.userId,
      ],
    );
    /**
     * Tell the recipient the link exists.
     *
     * A share nobody is told about is a link sitting in someone's clipboard, which is
     * how "I sent you that file" becomes an argument. Emitted inside the transaction so
     * the link and the message that announces it succeed or fail together.
     *
     * The token is deliberately not audited below - it is the whole credential.
     */
    if (input.recipientEmail) {
      await emit(
        {
          companyId: actor.companyId,
          type: 'share.granted',
          actorId: actor.userId,
          payload: {
            resourceType: input.resourceType,
            resourceName: input.resourceName ?? input.resourceType,
            recipients: [input.recipientEmail.toLowerCase().trim()],
            url: `${config.publicUrl}/shared/${token}`,
            grantedBy: actor.displayName,
            message: input.message ?? null,
          },
        },
        tx,
      );
    }

    await auditFromActor(
      actor,
      'file.share_external',
      {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: {
          shareLinkId: id,
          recipientEmail: input.recipientEmail ?? null,
          expiresInDays: days,
          passwordProtected: Boolean(input.password),
        },
      },
      tx,
    );
    return (await reload<ShareLinkRow>(tx, 'share_links', id))!;
  });

  return { link, url: `${config.publicUrl}/shared/${token}` };
}

export type ShareResolution = {
  link: ShareLinkRow;
  requiresPassword: boolean;
};

/**
 * Resolves a share token without consuming it.
 *
 * Every refusal returns the same shape of failure, because an anonymous caller must not
 * be able to tell a revoked link from an expired one from a token that never existed -
 * that difference is enough to confirm a guess.
 */
export async function resolveShareLink(token: string): Promise<ShareLinkRow | null> {
  const link = await one<ShareLinkRow>(
    `SELECT * FROM share_links
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW(3)
        AND (max_uses IS NULL OR use_count < max_uses)`,
    [hashToken(token)],
  );
  return link ?? null;
}

/**
 * Records a use of the link and enforces the password when one is set.
 *
 * The use counter increments only on a successful open, and the conditional UPDATE means
 * two simultaneous opens cannot both slip past a use cap.
 */
export async function consumeShareLink(
  token: string,
  input: { password?: string | null; ip: string | null; userAgent: string | null; action: string },
): Promise<ShareLinkRow> {
  const link = await resolveShareLink(token);
  if (!link) throw notFound('This link is no longer available');

  const stored = await one<{ password_hash: string | null }>(
    'SELECT password_hash FROM share_links WHERE id = $1',
    [link.id],
  );
  if (stored?.password_hash) {
    // Distinguishing "none given" from "wrong" is safe here and stops the second attempt
    // reading as though the first was ignored. It leaks nothing: the preview already
    // confirmed this link exists, so the only fact on offer is one the holder has.
    if (!input.password) {
      throw unprocessable('This link needs a password', [
        { field: 'password', message: 'Enter the password you were given' },
      ]);
    }
    if (!(await verifyPassword(input.password, stored.password_hash))) {
      throw unprocessable('That password is not correct', [
        { field: 'password', message: 'Check it with whoever sent you the link' },
      ]);
    }
  }

  return transaction(async (tx) => {
    const claimed = await tx.query(
      `UPDATE share_links
          SET use_count = use_count + 1, last_used_at = NOW(3)
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW(3)
          AND (max_uses IS NULL OR use_count < max_uses)`,
      [link.id],
    );
    if (claimed.rowCount === 0) throw notFound('This link is no longer available');

    await tx.query(
      `INSERT INTO share_link_accesses (share_link_id, ip, user_agent, action)
       VALUES ($1,$2,$3,$4)`,
      [link.id, input.ip, input.userAgent?.slice(0, 400) ?? null, input.action],
    );
    return (await reload<ShareLinkRow>(tx, 'share_links', link.id))!;
  });
}

export async function listShareLinks(
  actor: Actor,
  options: { resourceId?: string } = {},
): Promise<ShareLinkRow[]> {
  await authorize({ actor, capability: 'file.read', resourceless: true });
  return many<ShareLinkRow>(
    `SELECT s.*, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM share_link_accesses a WHERE a.share_link_id = s.id) AS access_count
       FROM share_links s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.company_id = $1
        AND ($2 IS NULL OR s.resource_id = $2)
      ORDER BY s.created_at DESC
      LIMIT 200`,
    [actor.companyId, options.resourceId ?? null],
  );
}

export async function revokeShareLink(actor: Actor, id: string): Promise<void> {
  await authorize({ actor, capability: 'file.share_external', resourceless: true });
  const link = await one<ShareLinkRow>(
    'SELECT * FROM share_links WHERE id = $1 AND company_id = $2',
    [id, actor.companyId],
  );
  if (!link) throw notFound('Share link not found');

  await transaction(async (tx) => {
    // Revoked rather than deleted: who shared what with whom is exactly what an audit
    // asks about afterwards, and a deleted row cannot answer.
    await tx.query('UPDATE share_links SET revoked_at = NOW(3) WHERE id = $1 AND revoked_at IS NULL', [id]);
    await auditFromActor(
      actor,
      'file.share_revoke',
      { resourceType: link.resource_type as never, resourceId: link.resource_id, metadata: { shareLinkId: id } },
      tx,
    );
  });
}

/** The access log for one link - the only trace of what left the company through it. */
export async function shareLinkAccesses(actor: Actor, id: string): Promise<unknown[]> {
  await authorize({ actor, capability: 'audit.read', resourceless: true });
  return many(
    `SELECT a.ip, a.user_agent, a.action, a.created_at
       FROM share_link_accesses a
       JOIN share_links s ON s.id = a.share_link_id
      WHERE a.share_link_id = $1 AND s.company_id = $2
      ORDER BY a.created_at DESC
      LIMIT 500`,
    [id, actor.companyId],
  );
}

/** Whether a link carries a password, without revealing the hash to the caller. */
export async function shareLinkNeedsPassword(linkId: string): Promise<boolean> {
  const row = await one<{ password_hash: string | null }>(
    'SELECT password_hash FROM share_links WHERE id = $1',
    [linkId],
  );
  return Boolean(row?.password_hash);
}

/**
 * The minimum an anonymous recipient needs to recognise what they were sent.
 *
 * Deliberately thin. The person holding this link is outside the company, so they get a
 * name and a size and nothing else - not the owner, not the folder path, not who else it
 * was shared with, none of which they are entitled to and all of which would leak
 * structure about the company from a single link.
 */
export async function describeSharedResource(
  link: Pick<ShareLinkRow, 'resource_type' | 'resource_id'>,
): Promise<{ name: string; sizeBytes: number | null; itemCount: number | null } | null> {
  if (link.resource_type === 'file') {
    const file = await one<{ name: string; size_bytes: number }>(
      "SELECT name, size_bytes FROM files WHERE id = $1 AND state = 'active'",
      [link.resource_id],
    );
    return file ? { name: file.name, sizeBytes: Number(file.size_bytes), itemCount: null } : null;
  }

  const folder = await one<{ name: string }>('SELECT name FROM folders WHERE id = $1', [
    link.resource_id,
  ]);
  if (!folder) return null;
  const count = await one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM files WHERE folder_id = $1 AND state = 'active'",
    [link.resource_id],
  );
  return { name: folder.name, sizeBytes: null, itemCount: Number(count?.c ?? 0) };
}
