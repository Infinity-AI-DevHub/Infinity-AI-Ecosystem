/**
 * Files attached to a documentation page.
 *
 * The bytes are not stored again: an attachment is a row joining a doc page to a file
 * that already went through the normal upload path. That path does the scanning, the
 * quota accounting and the retention, so a second route to storage would be a second
 * place for all three to be forgotten.
 */
import { many, newId, one, pool } from '../core/db.js';
import { conflict, notFound } from '../core/errors.js';
import { authorize, type Actor } from '../core/authz.js';
import { auditFromActor } from '../core/audit.js';

export async function attach(actor: Actor, pageId: string, fileId: string) {
  await authorize({ actor, capability: 'doc.write', resourceType: 'doc_page', resourceId: pageId });

  // Both sides must belong to the caller's company: an attachment is otherwise a way to
  // pull a file from another tenant into a page this one can read.
  const page = await one<{ id: string }>(
    'SELECT id FROM doc_pages WHERE id = $1 AND company_id = $2', [pageId, actor.companyId],
  );
  if (!page) throw notFound('Page not found');
  const file = await one<{ id: string; name: string }>(
    `SELECT id, name FROM files WHERE id = $1 AND company_id = $2 AND state <> 'expired'`,
    [fileId, actor.companyId],
  );
  if (!file) throw notFound('File not found');

  /**
   * Checked explicitly rather than leaning on ON DUPLICATE KEY UPDATE. A no-op upsert
   * does not report a consistent affected-row count across drivers, so the "already
   * attached" case silently succeeded and the caller was told nothing.
   */
  const existing = await one<{ id: string }>(
    'SELECT id FROM doc_attachments WHERE page_id = $1 AND file_id = $2', [pageId, fileId],
  );
  if (existing) throw conflict('That file is already attached to this page');

  const id = newId();
  await pool.query(
    `INSERT INTO doc_attachments (id, company_id, page_id, file_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, actor.companyId, pageId, fileId, actor.userId],
  );

  await auditFromActor(actor, 'doc.attach', {
    resourceType: 'doc_page', resourceId: pageId, metadata: { fileId, name: file.name },
  });
  return { id, fileId, name: file.name };
}

export async function list(actor: Actor, pageId: string) {
  await authorize({ actor, capability: 'doc.read', resourceType: 'doc_page', resourceId: pageId });
  return many(
    `SELECT a.id, a.file_id, a.created_at, f.name, f.size_bytes, f.mime_type,
            u.display_name AS uploaded_by_name
       FROM doc_attachments a
       JOIN files f ON f.id = a.file_id
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.page_id = $1 AND a.company_id = $2 AND f.state <> 'expired'
      ORDER BY a.created_at`,
    [pageId, actor.companyId],
  );
}

export async function detach(actor: Actor, pageId: string, attachmentId: string): Promise<void> {
  await authorize({ actor, capability: 'doc.write', resourceType: 'doc_page', resourceId: pageId });
  // Only the join is removed. The file keeps its own lifecycle, because it may be
  // referenced elsewhere and deleting it here would be a surprise.
  const result = await pool.query(
    'DELETE FROM doc_attachments WHERE id = $1 AND page_id = $2 AND company_id = $3',
    [attachmentId, pageId, actor.companyId],
  );
  if (result.rowCount === 0) throw notFound('Attachment not found');
  await auditFromActor(actor, 'doc.detach', {
    resourceType: 'doc_page', resourceId: pageId, metadata: { attachmentId },
  });
}
