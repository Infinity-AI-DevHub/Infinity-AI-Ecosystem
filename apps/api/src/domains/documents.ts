/**
 * Documents: the company's written knowledge.
 *
 * Files hold binary blobs and announcements are one-way broadcast. Neither is somewhere
 * two people can write and edit the same page, which meant policies, runbooks, decision
 * records and onboarding notes had nowhere to live on a platform that is the company's
 * only system.
 *
 * Two decisions shape everything below. Pages store sanitized HTML rather than raw
 * markup, because "authored by someone with an account" is not the same as trustworthy
 * and a stored-XSS payload in a company handbook would be read by everyone. And every
 * save keeps the version it replaced, because a wiki without history is one nobody edits
 * - there is no way back from a mistake, so people stop making changes at all.
 */
import { many, newId, one, reload, transaction } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { authorize, decide, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { sanitizeEmailHtml, htmlToText, snippet } from '../core/sanitize.js';
import * as searchIndex from './search.js';

export type SpaceRow = {
  id: string;
  company_id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: string;
  colour: string;
  archived_at: Date | null;
};

export type PageRow = {
  id: string;
  company_id: string;
  space_id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  body: string;
  excerpt: string | null;
  state: string;
  version: number;
  position: number;
  created_by: string | null;
  updated_by: string | null;
  published_at: Date | null;
  updated_at: Date;
};

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 140);
  return base || 'untitled';
}

/**
 * Whether the actor may reach a space.
 *
 * Company-visible spaces need only the capability. A restricted space additionally needs
 * an explicit grant, which is evaluated by the same engine that governs files and
 * projects rather than a second set of rules invented here.
 */
async function assertSpaceAccess(
  actor: Actor,
  space: SpaceRow,
  capability: 'doc.read' | 'doc.write',
): Promise<void> {
  if (space.visibility === 'company') {
    await authorize({ actor, capability, resourceless: true });
    return;
  }
  const decision = await decide({
    actor,
    capability,
    resourceType: 'doc_space',
    resourceId: space.id,
  });
  if (!decision.allowed) throw forbidden('This space is restricted');
}

async function requireSpace(actor: Actor, spaceId: string): Promise<SpaceRow> {
  const space = await one<SpaceRow>(
    'SELECT * FROM doc_spaces WHERE id = $1 AND company_id = $2',
    [spaceId, actor.companyId],
  );
  if (!space) throw notFound('Space not found');
  return space;
}

/** Applies a page's owning-space ACL for related resources such as attachments. */
export async function assertPageAccess(
  actor: Actor,
  pageId: string,
  capability: 'doc.read' | 'doc.write',
): Promise<PageRow> {
  const page = await one<PageRow>(
    'SELECT * FROM doc_pages WHERE id = $1 AND company_id = $2',
    [pageId, actor.companyId],
  );
  if (!page) throw notFound('Page not found');
  const space = await requireSpace(actor, page.space_id);
  await assertSpaceAccess(actor, space, capability);
  return page;
}

// ------------------------------------------------------------------ spaces

export async function listSpaces(actor: Actor): Promise<SpaceRow[]> {
  await authorize({ actor, capability: 'doc.read', resourceless: true });
  const spaces = await many<SpaceRow>(
    `SELECT s.*, (SELECT COUNT(*) FROM doc_pages p WHERE p.space_id = s.id AND p.state = 'published') AS page_count
       FROM doc_spaces s
      WHERE s.company_id = $1 AND s.archived_at IS NULL
      ORDER BY s.name`,
    [actor.companyId],
  );

  // Restricted spaces are filtered rather than refused: a list that errors because one
  // entry is private is useless, and their existence should not be advertised either.
  const visible: SpaceRow[] = [];
  for (const space of spaces) {
    if (space.visibility === 'company') {
      visible.push(space);
      continue;
    }
    const decision = await decide({
      actor,
      capability: 'doc.read',
      resourceType: 'doc_space',
      resourceId: space.id,
    });
    if (decision.allowed) visible.push(space);
  }
  return visible;
}

export async function createSpace(
  actor: Actor,
  input: { key: string; name: string; description?: string | null; visibility?: 'company' | 'restricted'; readerIds?: string[]; colour?: string },
): Promise<SpaceRow> {
  await authorize({ actor, capability: 'doc.space_manage', resourceless: true });
  const key = slugify(input.key || input.name);
  const visibility = input.visibility ?? 'company';
  const readerIds = [...new Set(input.readerIds ?? [])].filter((id) => id !== actor.userId);
  if (visibility === 'restricted' && readerIds.length === 0) {
    throw unprocessable('Choose at least one person who can read this restricted space', [
      { field: 'readerIds', message: 'Select at least one workspace member' },
    ]);
  }
  if (visibility === 'restricted') {
    const validReaders = await many<{ id: string }>(
      `SELECT id FROM users WHERE company_id = $1 AND status = 'active' AND JSON_CONTAINS($2, JSON_QUOTE(id))`,
      [actor.companyId, JSON.stringify(readerIds)],
    );
    if (validReaders.length !== readerIds.length) {
      throw unprocessable('One or more selected readers are unavailable', [
        { field: 'readerIds', message: 'Choose active members of this workspace' },
      ]);
    }
  }

  const existing = await one<{ id: string }>(
    'SELECT id FROM doc_spaces WHERE company_id = $1 AND `key` = $2',
    [actor.companyId, key],
  );
  if (existing) throw conflict('A space with that key already exists');

  const id = newId();
  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO doc_spaces (id, company_id, \`key\`, name, description, visibility, colour, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        actor.companyId,
        key,
        input.name.trim(),
        input.description?.trim() || null,
        visibility,
        input.colour ?? '#6366f1',
        actor.userId,
      ],
    );
    if (visibility === 'restricted') {
      const grants = [
        { userId: actor.userId, capabilities: ['doc.read', 'doc.write'] },
        ...readerIds.map((userId) => ({ userId, capabilities: ['doc.read'] })),
      ];
      for (const grant of grants) {
        await tx.query(
          `INSERT INTO resource_grants
             (id, company_id, subject_type, subject_id, resource_type, resource_id,
              capabilities, conditions, granted_by)
           VALUES ($1,$2,'user',$3,'doc_space',$4,$5,'{}',$6)`,
          [newId(), actor.companyId, grant.userId, id, JSON.stringify(grant.capabilities), actor.userId],
        );
      }
    }
    await auditFromActor(actor, 'doc.space_create', {
      resourceType: 'doc_space',
      resourceId: id,
      metadata: { key, name: input.name, visibility, readerCount: readerIds.length },
    }, tx);
    return (await reload<SpaceRow>(tx, 'doc_spaces', id))!;
  });
}

// ------------------------------------------------------------------ pages

export async function listPages(actor: Actor, spaceId: string): Promise<PageRow[]> {
  const space = await requireSpace(actor, spaceId);
  await assertSpaceAccess(actor, space, 'doc.read');
  return many<PageRow>(
    `SELECT p.id, p.space_id, p.parent_id, p.slug, p.title, p.excerpt, p.state, p.position,
            p.version, p.updated_at, u.display_name AS updated_by_name
       FROM doc_pages p
       LEFT JOIN users u ON u.id = p.updated_by
      WHERE p.space_id = $1 AND p.state <> 'archived'
      ORDER BY p.position, p.title`,
    [spaceId],
  );
}

export async function getPage(actor: Actor, pageId: string): Promise<PageRow> {
  const page = await one<PageRow>(
    `SELECT p.*, u.display_name AS updated_by_name, c.display_name AS created_by_name,
            s.name AS space_name, s.\`key\` AS space_key
       FROM doc_pages p
       JOIN doc_spaces s ON s.id = p.space_id
       LEFT JOIN users u ON u.id = p.updated_by
       LEFT JOIN users c ON c.id = p.created_by
      WHERE p.id = $1 AND p.company_id = $2`,
    [pageId, actor.companyId],
  );
  if (!page) throw notFound('Page not found');
  const space = await requireSpace(actor, page.space_id);
  await assertSpaceAccess(actor, space, 'doc.read');
  return page;
}

export async function createPage(
  actor: Actor,
  input: { spaceId: string; title: string; body?: string; parentId?: string | null; publish?: boolean },
): Promise<PageRow> {
  const space = await requireSpace(actor, input.spaceId);
  await assertSpaceAccess(actor, space, 'doc.write');

  const title = input.title.trim();
  if (!title) {
    throw unprocessable('A page needs a title', [{ field: 'title', message: 'Give it a name' }]);
  }

  // Slugs are unique per space, so a second "Onboarding" gets a suffix rather than
  // failing the save - the person naming it should not have to know what already exists.
  let slug = slugify(title);
  for (let attempt = 1; attempt < 50; attempt += 1) {
    const clash = await one<{ id: string }>(
      'SELECT id FROM doc_pages WHERE space_id = $1 AND slug = $2',
      [input.spaceId, slug],
    );
    if (!clash) break;
    slug = `${slugify(title)}-${attempt + 1}`;
  }

  const body = sanitizeEmailHtml(input.body ?? '', false);
  const text = htmlToText(body);
  const id = newId();
  const publish = input.publish ?? false;

  return transaction(async (tx) => {
    await tx.query(
      `INSERT INTO doc_pages
         (id, company_id, space_id, parent_id, slug, title, body, excerpt, state, created_by, updated_by, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
      [
        id,
        actor.companyId,
        input.spaceId,
        input.parentId ?? null,
        slug,
        title,
        body,
        snippet(text, 300),
        publish ? 'published' : 'draft',
        actor.userId,
        publish ? new Date() : null,
      ],
    );
    await tx.query(
      `INSERT INTO doc_page_versions (id, page_id, version, title, body, change_note, author_id)
       VALUES ($1,$2,1,$3,$4,'Created',$5)`,
      [newId(), id, title, body, actor.userId],
    );
    await auditFromActor(actor, 'doc.create', {
      resourceType: 'doc_page',
      resourceId: id,
      metadata: { spaceId: input.spaceId, title },
    }, tx);

    if (publish) {
      await searchIndex.index(
        {
          companyId: actor.companyId,
          docType: 'doc',
          resourceId: id,
          title,
          body: text,
          aclCompanyWide: space.visibility === 'company',
          link: `/docs/${space.key}/${slug}`,
        },
        tx,
      );
    }
    return (await reload<PageRow>(tx, 'doc_pages', id))!;
  });
}

/**
 * Saves a page.
 *
 * Two people editing the same page is the normal case for a wiki, not an edge case, so
 * the expected version is required and a mismatch is refused rather than resolved. The
 * caller is told to reload; silently overwriting the other person's work is the outcome
 * worth preventing, and the alternative - merging prose automatically - is worse.
 */
export async function updatePage(
  actor: Actor,
  pageId: string,
  input: { title?: string; body?: string; changeNote?: string | null; publish?: boolean },
  expectedVersion: number,
): Promise<PageRow> {
  const page = await getPage(actor, pageId);
  const space = await requireSpace(actor, page.space_id);
  await assertSpaceAccess(actor, space, 'doc.write');

  if (page.version !== expectedVersion) {
    throw preconditionFailed(
      'Someone else saved this page while you were editing. Reload to see their changes.',
    );
  }

  const title = (input.title ?? page.title).trim();
  const body = input.body === undefined ? page.body : sanitizeEmailHtml(input.body, false);
  const text = htmlToText(body);
  const nextVersion = page.version + 1;
  const publish = input.publish ?? page.state === 'published';

  return transaction(async (tx) => {
    // The conditional UPDATE is the actual guard: the check above races, this does not.
    const saved = await tx.query(
      `UPDATE doc_pages
          SET title = $2, body = $3, excerpt = $4, state = $5,
              version = version + 1, updated_by = $6, updated_at = NOW(3),
              published_at = CASE WHEN $5 = 'published' AND published_at IS NULL THEN NOW(3) ELSE published_at END
        WHERE id = $1 AND version = $7`,
      [pageId, title, body, snippet(text, 300), publish ? 'published' : 'draft', actor.userId, expectedVersion],
    );
    if (saved.rowCount === 0) {
      throw preconditionFailed('Someone else saved this page. Reload to see their changes.');
    }

    await tx.query(
      `INSERT INTO doc_page_versions (id, page_id, version, title, body, change_note, author_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId(), pageId, nextVersion, title, body, input.changeNote?.trim() || null, actor.userId],
    );
    await auditFromActor(actor, 'doc.update', {
      resourceType: 'doc_page',
      resourceId: pageId,
      metadata: { version: nextVersion, published: publish },
    }, tx);

    if (publish) {
      await searchIndex.index(
        {
          companyId: actor.companyId,
          docType: 'doc',
          resourceId: pageId,
          title,
          body: text,
          aclCompanyWide: space.visibility === 'company',
          link: `/docs/${space.key}/${page.slug}`,
        },
        tx,
      );
    } else {
      // A page pulled back to draft leaves the index: an unpublished page surfacing in
      // search is the same leak as never having unpublished it.
      await searchIndex.remove('doc', pageId, tx);
    }

    return (await reload<PageRow>(tx, 'doc_pages', pageId))!;
  });
}

export async function pageHistory(actor: Actor, pageId: string): Promise<unknown[]> {
  await getPage(actor, pageId);
  return many(
    `SELECT v.version, v.title, v.change_note, v.created_at, u.display_name AS author_name
       FROM doc_page_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.page_id = $1
      ORDER BY v.version DESC
      LIMIT 100`,
    [pageId],
  );
}

export async function getVersion(actor: Actor, pageId: string, version: number): Promise<unknown> {
  await getPage(actor, pageId);
  const row = await one(
    `SELECT v.version, v.title, v.body, v.change_note, v.created_at, u.display_name AS author_name
       FROM doc_page_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.page_id = $1 AND v.version = $2`,
    [pageId, version],
  );
  if (!row) throw notFound('That version does not exist');
  return row;
}

/** Puts an old version back as a new one, so the history stays append-only. */
export async function restoreVersion(
  actor: Actor,
  pageId: string,
  version: number,
): Promise<PageRow> {
  const page = await getPage(actor, pageId);
  const target = (await getVersion(actor, pageId, version)) as { title: string; body: string };
  return updatePage(
    actor,
    pageId,
    {
      title: target.title,
      body: target.body,
      changeNote: `Restored version ${version}`,
    },
    page.version,
  );
}

export async function archivePage(actor: Actor, pageId: string): Promise<void> {
  const page = await getPage(actor, pageId);
  await authorize({ actor, capability: 'doc.delete', resourceless: true });

  await transaction(async (tx) => {
    await tx.query("UPDATE doc_pages SET state = 'archived', updated_at = NOW(3) WHERE id = $1", [
      pageId,
    ]);
    await searchIndex.remove('doc', pageId, tx);
    await auditFromActor(actor, 'doc.archive', {
      resourceType: 'doc_page',
      resourceId: pageId,
      metadata: { title: page.title },
    }, tx);
  });
}
