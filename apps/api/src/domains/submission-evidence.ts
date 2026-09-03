/**
 * Evidence attached to something somebody has to judge.
 *
 * A leave request with a medical certificate and an expense claim with a receipt are the
 * same problem: an approver is being asked to decide, and the decision is only as good as
 * what they were shown. Both go through here so the tenant check, the file-state check
 * and the approver's read path are written once.
 *
 * Files are joined, never re-stored — see `attachments.ts` for the same reasoning.
 */
import { many, newId, one, type Queryable } from '../core/db.js';
import { badRequest, notFound } from '../core/errors.js';
import type { Actor } from '../core/authz.js';

export type SubjectType = 'leave' | 'approval';

export type Evidence = {
  id: string;
  file_id: string;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_by_name: string | null;
  created_at: string;
};

/** At most this many per submission: enough to make a case, not enough to be a dump. */
const MAX_PER_SUBJECT = 10;

/**
 * Attach files to a submission, inside the transaction that created it.
 *
 * Every file is checked against the caller's own company and must be one they uploaded.
 * Without that, a file id from another tenant — or another person's private file — could
 * be pulled into a request the approver is allowed to read.
 */
export async function attachEvidence(
  tx: Queryable,
  actor: Actor,
  subjectType: SubjectType,
  subjectId: string,
  fileIds: string[],
): Promise<number> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return 0;
  if (unique.length > MAX_PER_SUBJECT) {
    throw badRequest(`Attach at most ${MAX_PER_SUBJECT} files`);
  }

  for (const fileId of unique) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM files
        WHERE id = $1 AND company_id = $2 AND owner_id = $3
          AND state IN ('active','legal_hold')`,
      [fileId, actor.companyId, actor.userId],
    );
    if (found.rows.length === 0) throw notFound('One of those files could not be found');

    await tx.query(
      `INSERT INTO submission_evidence (id, company_id, subject_type, subject_id, file_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(), actor.companyId, subjectType, subjectId, fileId, actor.userId],
    );
  }
  return unique.length;
}

/**
 * The evidence on one submission.
 *
 * Access is the caller's problem: this is only ever reached from a read path that has
 * already established the caller may see the submission itself.
 */
export async function listEvidence(
  companyId: string,
  subjectType: SubjectType,
  subjectId: string,
): Promise<Evidence[]> {
  return many<Evidence>(
    `SELECT e.id, e.file_id, e.created_at, f.name, f.mime_type, f.size_bytes,
            u.display_name AS uploaded_by_name
       FROM submission_evidence e
       JOIN files f ON f.id = e.file_id
       LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.subject_type = $1 AND e.subject_id = $2 AND e.company_id = $3
        AND f.state <> 'expired'
      ORDER BY e.created_at`,
    [subjectType, subjectId, companyId],
  );
}

/** How many files each of these submissions carries, for a list view. */
export async function evidenceCounts(
  companyId: string,
  subjectType: SubjectType,
  subjectIds: string[],
): Promise<Map<string, number>> {
  if (subjectIds.length === 0) return new Map();
  const placeholders = subjectIds.map((_, i) => `$${i + 3}`).join(', ');
  const rows = await many<{ subject_id: string; total: number }>(
    `SELECT subject_id, COUNT(*) AS total
       FROM submission_evidence
      WHERE subject_type = $1 AND company_id = $2 AND subject_id IN (${placeholders})
      GROUP BY subject_id`,
    [subjectType, companyId, ...subjectIds],
  );
  return new Map(rows.map((r) => [r.subject_id, Number(r.total)]));
}

/** Whether a submission has any evidence at all — used where a count is overkill. */
export async function hasEvidence(
  companyId: string,
  subjectType: SubjectType,
  subjectId: string,
): Promise<boolean> {
  const row = await one<{ total: number }>(
    `SELECT COUNT(*) AS total FROM submission_evidence
      WHERE subject_type = $1 AND subject_id = $2 AND company_id = $3`,
    [subjectType, subjectId, companyId],
  );
  return Number(row?.total ?? 0) > 0;
}
