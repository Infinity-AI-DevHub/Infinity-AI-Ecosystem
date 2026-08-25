/**
 * Cross-module search (blueprint 11).
 *
 * Every indexed document carries company ID, resource ID, classification and ACL
 * tokens. The query layer computes access filters server-side, so an unauthorized hit
 * is never returned and then hidden in the client. Snippets are HTML-escaped.
 */
import { many, pool, type Queryable } from '../core/db.js';
import { escapeHtml } from '../core/validation.js';
import type { Actor } from '../core/authz.js';

export type DocType = 'mail' | 'chat' | 'file' | 'person' | 'task' | 'meeting' | 'announcement';

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
       (company_id, doc_type, resource_id, title, body, classification,
        acl_user_ids, acl_group_ids, acl_company_wide, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (doc_type, resource_id) DO UPDATE SET
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       classification = EXCLUDED.classification,
       acl_user_ids = EXCLUDED.acl_user_ids,
       acl_group_ids = EXCLUDED.acl_group_ids,
       acl_company_wide = EXCLUDED.acl_company_wide,
       link = EXCLUDED.link`,
    [
      input.companyId,
      input.docType,
      input.resourceId,
      input.title.slice(0, 1000),
      input.body.slice(0, 50_000),
      input.classification ?? 'internal',
      input.aclUserIds ?? [],
      input.aclGroupIds ?? [],
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
  await pool.query(
    `UPDATE search_documents SET acl_user_ids = array_remove(acl_user_ids, $1::uuid)
      WHERE $1::uuid = ANY(acl_user_ids)
        AND doc_type IN ('mail','chat','file')
        AND NOT acl_company_wide`,
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

export async function search(
  actor: Actor,
  queryText: string,
  opts: { types?: DocType[]; limit: number },
): Promise<SearchResponse> {
  const trimmed = queryText.trim();
  if (trimmed.length < 2) return { hits: [], facets: {}, total: 0 };

  // Restricted material is excluded unless the actor holds an audit/compliance role.
  const canSeeRestricted = actor.capabilities.has('audit.read');

  const rows = await many<{
    doc_type: DocType;
    resource_id: string;
    title: string;
    link: string | null;
    snippet: string;
    score: number;
    total: number;
  }>(
    `WITH matched AS (
       SELECT doc_type, resource_id, title, link, body,
              ts_rank(tsv, websearch_to_tsquery('english', $2)) AS score
         FROM search_documents
        WHERE company_id = $1
          AND tsv @@ websearch_to_tsquery('english', $2)
          AND ($3::text[] IS NULL OR doc_type = ANY($3))
          AND ($6::boolean OR classification <> 'restricted')
          AND (
            acl_company_wide
            OR $4::uuid = ANY(acl_user_ids)
            OR acl_group_ids && $5::uuid[]
          )
     )
     SELECT doc_type, resource_id, title, link, score,
            ts_headline('english', body, websearch_to_tsquery('english', $2),
                        'MaxWords=28, MinWords=10, StartSel=<<, StopSel=>>') AS snippet,
            count(*) OVER () AS total
       FROM matched
      ORDER BY score DESC
      LIMIT $7`,
    [
      actor.companyId,
      trimmed,
      opts.types && opts.types.length > 0 ? opts.types : null,
      actor.userId,
      actor.groupIds,
      canSeeRestricted,
      opts.limit,
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
      snippet: escapeHtml(row.snippet).replaceAll('&lt;&lt;', '<mark>').replaceAll('&gt;&gt;', '</mark>'),
      link: row.link,
      score: Number(row.score),
    })),
  };
}
