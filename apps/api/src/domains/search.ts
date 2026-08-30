/**
 * Cross-module search (blueprint 11).
 *
 * Every indexed document carries company ID, resource ID, classification and ACL
 * tokens. The query layer computes access filters server-side, so an unauthorized hit
 * is never returned and then hidden in the client. Snippets are HTML-escaped.
 */
import { jsonArrayOverlaps, many, newId, pool, type Queryable } from '../core/db.js';
import { escapeHtml } from '../core/validation.js';
import type { Actor } from '../core/authz.js';

export type DocType = 'chat' | 'file' | 'person' | 'task' | 'meeting' | 'announcement' | 'doc';

export type IndexInput = {
  companyId: string;
  docType: DocType;
  resourceId: string;
  title: string;
  body: string;
  classification?: string;
  aclUserIds?: string[];
  aclGroupIds?: string[];
  aclCompanyWide?: boolean;
  link?: string;
};

export async function index(input: IndexInput, db: Queryable = pool): Promise<void> {
  await db.query(
    `INSERT INTO search_documents
       (id, company_id, doc_type, resource_id, title, body, classification,
        acl_user_ids, acl_group_ids, acl_company_wide, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       body = VALUES(body),
       classification = VALUES(classification),
       acl_user_ids = VALUES(acl_user_ids),
       acl_group_ids = VALUES(acl_group_ids),
       acl_company_wide = VALUES(acl_company_wide),
       link = VALUES(link)`,
    [
      newId(),
      input.companyId,
      input.docType,
      input.resourceId,
      input.title.slice(0, 1000),
      input.body.slice(0, 50_000),
      input.classification ?? 'internal',
      JSON.stringify(input.aclUserIds ?? []),
      JSON.stringify(input.aclGroupIds ?? []),
      input.aclCompanyWide ?? false,
      input.link ?? null,
    ],
  );
}

export async function remove(docType: DocType, resourceId: string, db: Queryable = pool): Promise<void> {
  await db.query('DELETE FROM search_documents WHERE doc_type = $1 AND resource_id = $2', [
    docType,
    resourceId,
  ]);
}

/** Permission changes must reach the index urgently, not on the next nightly rebuild. */
export async function reindexForUserAccessChange(userId: string): Promise<void> {
  // JSON_SEARCH returns NULL when the value is absent, and JSON_REMOVE rejects a NULL
  // path, so the WHERE clause must exclude non-matching rows before the path is built.
  await pool.query(
    `UPDATE search_documents
        SET acl_user_ids = JSON_REMOVE(
              acl_user_ids,
              JSON_UNQUOTE(JSON_SEARCH(acl_user_ids, 'one', $1))
            )
      WHERE doc_type IN ('chat','file')
        AND acl_company_wide = 0
        AND JSON_SEARCH(acl_user_ids, 'one', $1) IS NOT NULL`,
    [userId],
  );
}

export type SearchHit = {
  docType: DocType;
  resourceId: string;
  title: string;
  snippet: string;
  link: string | null;
  score: number;
};

export type SearchResponse = { hits: SearchHit[]; facets: Record<string, number>; total: number };

function safeInternalLink(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

export async function search(
  actor: Actor,
  queryText: string,
  opts: { types?: DocType[]; limit: number },
): Promise<SearchResponse> {
  const trimmed = queryText.trim();
  if (trimmed.length < 2) return { hits: [], facets: {}, total: 0 };

  // Restricted material is excluded unless the actor holds an audit/compliance role.
  const canSeeRestricted = actor.capabilities.has('audit.read');

  // MySQL's FULLTEXT boolean mode treats several characters as operators. Stripping
  // them means a user's punctuation cannot change the query's meaning or make it a
  // syntax error, and each term is required (+) with a prefix match (*).
  const terms = trimmed
    .replace(/[+\-><()~*"@]+/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, 12);
  if (terms.length === 0) return { hits: [], facets: {}, total: 0 };
  const booleanQuery = terms.map((term) => `+${term}*`).join(' ');

  // Placeholders 1-6 are fixed; the group ids occupy 7 onwards.
  const groupClause = jsonArrayOverlaps('acl_group_ids', actor.groupIds, 7);
  const rows = await many<{
    doc_type: DocType;
    resource_id: string;
    title: string;
    link: string | null;
    body: string;
    score: number;
    total: number;
  }>(
    `SELECT doc_type, resource_id, title, link, body,
            MATCH(title, body) AGAINST ($2 IN BOOLEAN MODE) AS score,
            COUNT(*) OVER () AS total
       FROM search_documents
      WHERE company_id = $1
        AND MATCH(title, body) AGAINST ($2 IN BOOLEAN MODE)
        AND ($3 IS NULL OR JSON_CONTAINS($3, JSON_QUOTE(doc_type)))
        AND ($5 OR classification <> 'restricted')
        AND (
          acl_company_wide = 1
          OR JSON_CONTAINS(acl_user_ids, JSON_QUOTE($4))
          OR ${groupClause}
        )
      ORDER BY score DESC
      LIMIT $6`,
    [
      actor.companyId,
      booleanQuery,
      opts.types && opts.types.length > 0 ? JSON.stringify(opts.types) : null,
      actor.userId,
      canSeeRestricted,
      opts.limit,
      // Group ids last, so expanding them cannot shift the placeholders before them.
      ...actor.groupIds,
    ],
  );

  const facets: Record<string, number> = {};
  for (const row of rows) facets[row.doc_type] = (facets[row.doc_type] ?? 0) + 1;

  return {
    total: rows[0]?.total ?? 0,
    facets,
    hits: rows.map((row) => ({
      docType: row.doc_type,
      resourceId: row.resource_id,
      title: row.title,
      // The snippet is escaped first, then the highlight markers become safe markup.
      snippet: escapeHtml(buildSnippet(row.body, terms))
        .replaceAll('&lt;&lt;', '<mark>')
        .replaceAll('&gt;&gt;', '</mark>'),
      link: safeInternalLink(row.link),
      score: Number(row.score),
    })),
  };
}

/**
 * Builds a highlighted excerpt around the first matching term.
 *
 * PostgreSQL had ts_headline for this; MySQL has no equivalent, so the excerpt is
 * assembled here. Markers are the same `<<`/`>>` sentinels the caller escapes and then
 * converts to <mark>, so the surrounding output-encoding rules are unchanged and the
 * body text can never introduce markup of its own.
 */
export function buildSnippet(body: string, terms: string[], width = 180): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';

  const lower = text.toLowerCase();
  let found = -1;
  let matched = '';
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at !== -1 && (found === -1 || at < found)) {
      found = at;
      matched = term;
    }
  }
  if (found === -1) {
    return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  }

  const start = Math.max(0, found - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const excerpt = text.slice(start, end);
  const offset = found - start;

  const highlighted =
    excerpt.slice(0, offset) +
    '<<' +
    excerpt.slice(offset, offset + matched.length) +
    '>>' +
    excerpt.slice(offset + matched.length);

  return `${start > 0 ? '…' : ''}${highlighted}${end < text.length ? '…' : ''}`;
}
