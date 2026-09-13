/**
 * Knowledge base.
 *
 * Articles are written for one of two audiences. `internal` articles are read by every
 * employee; `public` articles are also offered to clients in the portal. A draft is seen
 * only by people who can write articles. Bodies are stored sanitized, through the same
 * allow-list as document pages, so an article can never carry script to whoever opens it.
 *
 * Writers are people holding `kb.write`, anyone holding `ticket.work`, and members of any
 * service queue - the technicians who answer the questions are the ones who should be
 * able to write the answer down.
 */
import { many, newId, one, pool } from '../core/db.js';
import { conflict, forbidden, notFound, preconditionFailed, unprocessable } from '../core/errors.js';
import { hasCapability, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';
import { htmlToText, sanitizeEmailHtml, snippet } from '../core/sanitize.js';
import * as searchIndex from './search.js';

type ArticleRow = {
  id: string;
  company_id: string;
  title: string;
  summary: string | null;
  body: string;
  audience: 'internal' | 'public';
  status: 'draft' | 'published' | 'archived';
  queue_id: string | null;
  category_id: string | null;
  author_id: string;
  updated_by: string | null;
  published_at: Date | null;
  helpful_count: number;
  unhelpful_count: number;
  view_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export async function canWrite(actor: Actor): Promise<boolean> {
  if (actor.accessLevel === 'guest' || actor.status !== 'active') return false;
  if (hasCapability(actor, 'kb.write') || hasCapability(actor, 'ticket.work')) return true;
  const member = await one('SELECT 1 FROM service_queue_members WHERE user_id = $1 AND company_id = $2 LIMIT 1', [actor.userId, actor.companyId]);
  return Boolean(member);
}

async function requireWriter(actor: Actor): Promise<void> {
  if (!(await canWrite(actor))) throw forbidden('Only people who work the service desk can write articles');
}

function visibleTo(actor: Actor, article: ArticleRow, writer: boolean): boolean {
  if (article.company_id !== actor.companyId) return false;
  if (article.status !== 'published') return writer;
  if (actor.accessLevel === 'guest') return article.audience === 'public';
  return true;
}

function present(a: ArticleRow & { author_name?: string | null; queue_name?: string | null; category_name?: string | null }, includeBody: boolean) {
  return {
    id: a.id,
    title: a.title,
    summary: a.summary ?? snippet(htmlToText(a.body), 200),
    body: includeBody ? a.body : undefined,
    audience: a.audience,
    status: a.status,
    queueId: a.queue_id,
    categoryId: a.category_id,
    queueName: a.queue_name ?? null,
    categoryName: a.category_name ?? null,
    authorName: a.author_name ?? null,
    publishedAt: a.published_at,
    updatedAt: a.updated_at,
    helpful: Number(a.helpful_count),
    unhelpful: Number(a.unhelpful_count),
    views: Number(a.view_count),
    version: a.version,
  };
}

async function index(article: ArticleRow): Promise<void> {
  if (article.status !== 'published') {
    await searchIndex.remove('article', article.id);
    return;
  }
  await searchIndex.index({
    companyId: article.company_id,
    docType: 'article',
    resourceId: article.id,
    title: article.title,
    body: `${article.summary ?? ''} ${htmlToText(article.body)}`,
    aclCompanyWide: true,
    link: `/service/knowledge/${article.id}`,
  });
}

/** MySQL boolean-mode query from free text: each term required, prefix-matched. */
function booleanQuery(text: string): string | null {
  const terms = text.replace(/[+\-><()~*"@]+/g, ' ').split(/\s+/).filter((t) => t.length > 2).slice(0, 10);
  return terms.length ? terms.map((t) => `+${t}*`).join(' ') : null;
}

export async function listArticles(
  actor: Actor,
  filter: { q?: string; status?: 'draft' | 'published' | 'archived'; audience?: 'internal' | 'public'; queueId?: string; limit: number },
) {
  const writer = await canWrite(actor);
  const where = ['a.company_id = $1'];
  const params: unknown[] = [actor.companyId];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (!writer || !filter.status) where.push(writer ? "a.status <> 'archived'" : "a.status = 'published'");
  if (writer && filter.status) where.push(`a.status = ${p(filter.status)}`);
  if (actor.accessLevel === 'guest') where.push("a.audience = 'public'");
  else if (filter.audience) where.push(`a.audience = ${p(filter.audience)}`);
  if (filter.queueId && actor.accessLevel !== 'guest') where.push(`a.queue_id = ${p(filter.queueId)}`);
  const bq = filter.q ? booleanQuery(filter.q) : null;
  if (filter.q && !bq) where.push(`a.title LIKE ${p(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
  if (bq) where.push(`MATCH(a.title, a.summary, a.body) AGAINST (${p(bq)} IN BOOLEAN MODE)`);

  const rows = await many<ArticleRow & { author_name: string; queue_name: string | null; category_name: string | null }>(
    `SELECT a.*, u.display_name AS author_name, q.name AS queue_name, c.name AS category_name
       FROM kb_articles a
       JOIN users u ON u.id = a.author_id
       LEFT JOIN service_queues q ON q.id = a.queue_id
       LEFT JOIN service_categories c ON c.id = a.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${bq ? `MATCH(a.title, a.summary, a.body) AGAINST (${p(bq)} IN BOOLEAN MODE) DESC,` : ''} a.updated_at DESC
      LIMIT ${p(filter.limit)}`,
    params,
  );
  const guest = actor.accessLevel === 'guest';
  return {
    canWrite: writer,
    items: rows.map((r) => ({ ...present(r, false), queueName: guest ? null : r.queue_name, authorName: guest ? null : r.author_name })),
  };
}

export async function getArticle(actor: Actor, id: string) {
  const writer = await canWrite(actor);
  const article = await one<ArticleRow & { author_name: string; editor_name: string | null; queue_name: string | null; category_name: string | null }>(
    `SELECT a.*, u.display_name AS author_name, e.display_name AS editor_name, q.name AS queue_name, c.name AS category_name
       FROM kb_articles a
       JOIN users u ON u.id = a.author_id
       LEFT JOIN users e ON e.id = a.updated_by
       LEFT JOIN service_queues q ON q.id = a.queue_id
       LEFT JOIN service_categories c ON c.id = a.category_id
      WHERE a.id = $1 AND a.company_id = $2`,
    [id, actor.companyId],
  );
  if (!article || !visibleTo(actor, article, writer)) throw notFound('Article not found');
  if (article.status === 'published') {
    // Once per person per day: refreshing, or re-reading after voting, is not a new reader.
    const seen = await pool.query('INSERT IGNORE INTO kb_article_views (article_id, user_id, view_day) VALUES ($1,$2,CURDATE())', [id, actor.userId]);
    if (seen.rowCount > 0) {
      await pool.query('UPDATE kb_articles SET view_count = view_count + 1 WHERE id = $1', [id]);
      article.view_count = Number(article.view_count) + 1;
    }
  }
  const vote = await one<{ helpful: number }>('SELECT helpful FROM kb_votes WHERE article_id = $1 AND user_id = $2', [id, actor.userId]);
  const guest = actor.accessLevel === 'guest';
  return {
    ...present(article, true),
    queueName: guest ? null : article.queue_name,
    authorName: guest ? null : article.author_name,
    editorName: guest ? null : article.editor_name,
    myVote: vote ? Boolean(vote.helpful) : null,
    canEdit: writer,
  };
}

type ArticleInput = {
  title: string;
  summary?: string | null;
  body: string;
  audience?: 'internal' | 'public';
  queueId?: string | null;
  categoryId?: string | null;
};

async function assertPlacement(companyId: string, queueId: string | null | undefined, categoryId: string | null | undefined) {
  if (queueId && !(await one('SELECT 1 FROM service_queues WHERE id = $1 AND company_id = $2', [queueId, companyId]))) {
    throw unprocessable('Queue not found', [{ field: 'queueId', message: 'Choose a queue' }]);
  }
  if (categoryId) {
    const cat = await one<{ queue_id: string }>('SELECT queue_id FROM service_categories WHERE id = $1 AND company_id = $2', [categoryId, companyId]);
    if (!cat || (queueId && cat.queue_id !== queueId)) throw unprocessable('That category is not in this queue', [{ field: 'categoryId', message: 'Choose a category in the queue' }]);
  }
}

function cleanBody(html: string): string {
  const body = sanitizeEmailHtml(html, false);
  if (!htmlToText(body).trim()) throw unprocessable('Write the article before saving it', [{ field: 'body', message: 'The article is empty' }]);
  return body;
}

export async function createArticle(actor: Actor, input: ArticleInput) {
  await requireWriter(actor);
  await assertPlacement(actor.companyId, input.queueId, input.categoryId);
  const id = newId();
  await pool.query(
    `INSERT INTO kb_articles (id, company_id, title, summary, body, audience, queue_id, category_id, author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, actor.companyId, input.title.trim(), input.summary?.trim() || null, cleanBody(input.body), input.audience ?? 'internal',
      input.queueId ?? null, input.categoryId ?? null, actor.userId],
  );
  await auditFromActor(actor, 'kb.article.create', { resourceType: 'kb_article', resourceId: id, metadata: { title: input.title } });
  return getArticle(actor, id);
}

export async function updateArticle(actor: Actor, id: string, input: Partial<ArticleInput>, expectedVersion?: number) {
  await requireWriter(actor);
  const article = await one<ArticleRow>('SELECT * FROM kb_articles WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!article) throw notFound('Article not found');
  if (expectedVersion !== undefined && expectedVersion !== article.version) throw preconditionFailed('Someone else saved this article since you opened it. Reload to see their changes.');
  const queueId = input.queueId !== undefined ? input.queueId : article.queue_id;
  const categoryId = input.categoryId !== undefined ? input.categoryId : article.category_id;
  await assertPlacement(actor.companyId, queueId, categoryId);
  const res = await pool.query(
    `UPDATE kb_articles SET title = $3, summary = $4, body = $5, audience = $6, queue_id = $7, category_id = $8,
            updated_by = $9, version = version + 1
      WHERE id = $1 AND company_id = $2 AND version = $10`,
    [id, actor.companyId, input.title?.trim() ?? article.title,
      input.summary !== undefined ? input.summary?.trim() || null : article.summary,
      input.body !== undefined ? cleanBody(input.body) : article.body,
      input.audience ?? article.audience, queueId, categoryId, actor.userId, article.version],
  );
  if (res.rowCount === 0) throw preconditionFailed('Someone else saved this article since you opened it. Reload to see their changes.');
  await auditFromActor(actor, 'kb.article.update', { resourceType: 'kb_article', resourceId: id, metadata: { changes: Object.keys(input) } });
  const fresh = (await one<ArticleRow>('SELECT * FROM kb_articles WHERE id = $1', [id]))!;
  await index(fresh);
  return getArticle(actor, id);
}

export async function setArticleStatus(actor: Actor, id: string, status: 'draft' | 'published' | 'archived') {
  await requireWriter(actor);
  const article = await one<ArticleRow>('SELECT * FROM kb_articles WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!article) throw notFound('Article not found');
  await pool.query(
    `UPDATE kb_articles SET status = $3, updated_by = $4, version = version + 1,
            published_at = CASE WHEN $3 = 'published' THEN COALESCE(published_at, NOW(3)) ELSE published_at END
      WHERE id = $1 AND company_id = $2`,
    [id, actor.companyId, status, actor.userId],
  );
  await auditFromActor(actor, `kb.article.${status}`, { resourceType: 'kb_article', resourceId: id, metadata: { audience: article.audience } });
  await index((await one<ArticleRow>('SELECT * FROM kb_articles WHERE id = $1', [id]))!);
  return getArticle(actor, id);
}

export async function vote(actor: Actor, id: string, helpful: boolean) {
  const writer = await canWrite(actor);
  const article = await one<ArticleRow>('SELECT * FROM kb_articles WHERE id = $1 AND company_id = $2', [id, actor.companyId]);
  if (!article || !visibleTo(actor, article, writer) || article.status !== 'published') throw notFound('Article not found');
  const previous = await one<{ helpful: number }>('SELECT helpful FROM kb_votes WHERE article_id = $1 AND user_id = $2', [id, actor.userId]);
  if (previous && Boolean(previous.helpful) === helpful) return getArticle(actor, id);
  await pool.query(
    `INSERT INTO kb_votes (article_id, user_id, helpful) VALUES ($1,$2,$3)
     ON DUPLICATE KEY UPDATE helpful = VALUES(helpful)`,
    [id, actor.userId, helpful],
  );
  // Counts move with the vote, so changing your mind does not count twice.
  await pool.query(
    `UPDATE kb_articles SET
       helpful_count = helpful_count + $2 - $3,
       unhelpful_count = unhelpful_count + $4 - $5
     WHERE id = $1`,
    [id, helpful ? 1 : 0, previous && previous.helpful ? 1 : 0, helpful ? 0 : 1, previous && !previous.helpful ? 1 : 0],
  );
  return getArticle(actor, id);
}

/**
 * Articles that might answer a request before it is raised. Only published articles the
 * person may read, best match first.
 */
export async function suggest(actor: Actor, text: string, limit = 5) {
  const bq = booleanQuery(text);
  if (!bq) return [];
  // Suggestions match any term rather than all of them: a subject is a sentence, not a query.
  const any = bq.replaceAll('+', '');
  const rows = await many<ArticleRow>(
    `SELECT a.* FROM kb_articles a
      WHERE a.company_id = $1 AND a.status = 'published'
        ${actor.accessLevel === 'guest' ? "AND a.audience = 'public'" : ''}
        AND MATCH(a.title, a.summary, a.body) AGAINST ($2 IN BOOLEAN MODE)
      ORDER BY MATCH(a.title, a.summary, a.body) AGAINST ($2 IN BOOLEAN MODE) DESC, a.helpful_count DESC
      LIMIT $3`,
    [actor.companyId, any, limit],
  );
  return rows.map((r) => present(r, false));
}

export async function linkToTicket(actor: Actor, ticketId: string, articleId: string, workerCheck: (actor: Actor, ticketId: string) => Promise<void>) {
  await workerCheck(actor, ticketId);
  const article = await one<ArticleRow>("SELECT * FROM kb_articles WHERE id = $1 AND company_id = $2 AND status = 'published'", [articleId, actor.companyId]);
  if (!article) throw unprocessable('Only published articles can be linked', [{ field: 'articleId', message: 'Publish the article first' }]);
  const existing = await one('SELECT 1 FROM ticket_articles WHERE ticket_id = $1 AND article_id = $2', [ticketId, articleId]);
  if (existing) throw conflict('That article is already linked');
  await pool.query('INSERT INTO ticket_articles (ticket_id, article_id, linked_by) VALUES ($1,$2,$3)', [ticketId, articleId, actor.userId]);
  await auditFromActor(actor, 'ticket.article.link', { resourceType: 'ticket', resourceId: ticketId, metadata: { articleId } });
  return article;
}

/** Linked articles as a ticket viewer may see them: clients only see public ones. */
export async function articlesForTicket(actor: Actor, ticketId: string) {
  return many<{ id: string; title: string; audience: string }>(
    `SELECT a.id, a.title, a.audience FROM ticket_articles ta JOIN kb_articles a ON a.id = ta.article_id
      WHERE ta.ticket_id = $1 AND a.status = 'published' ${actor.accessLevel === 'guest' ? "AND a.audience = 'public'" : ''}
      ORDER BY ta.linked_at`,
    [ticketId],
  );
}
