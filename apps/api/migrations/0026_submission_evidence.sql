-- Evidence attached to a submission: a leave request, or an approval request.
--
-- One table for both rather than one per module. The two are the same shape — a
-- submission somebody has to judge, and the files that justify it — and an approver
-- reads them through the same screen. A second table would mean a second read path, a
-- second retention rule and a second place to forget the tenant check.
--
-- The bytes are not stored again. A row joins a submission to a file that already went
-- through the normal upload path, which is what does the scanning, the quota accounting
-- and the retention. This mirrors doc_attachments and attendance_evidence.
-- The table deliberately inherits the database collation so its UUID foreign keys match
-- the existing tenant, file and user tables on both MySQL and MariaDB.
CREATE TABLE submission_evidence (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  company_id   CHAR(36)    NOT NULL,

  -- 'leave' -> leave_requests.id, 'approval' -> approval_requests.id. Not a foreign key,
  -- because it points at one of two tables; the domain checks the subject exists and
  -- belongs to the company before writing, and both parents cascade through company_id.
  subject_type VARCHAR(16) NOT NULL,
  subject_id   CHAR(36)    NOT NULL,

  file_id      CHAR(36)    NOT NULL,
  uploaded_by  CHAR(36)    NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_submission_evidence_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_submission_evidence_file    FOREIGN KEY (file_id)    REFERENCES files (id)     ON DELETE CASCADE,
  CONSTRAINT fk_submission_evidence_user    FOREIGN KEY (uploaded_by) REFERENCES users (id)    ON DELETE CASCADE,

  -- The same file twice on one submission says nothing new.
  CONSTRAINT uq_submission_evidence UNIQUE (subject_type, subject_id, file_id)
) ENGINE=InnoDB;

CREATE INDEX idx_submission_evidence_subject ON submission_evidence (subject_type, subject_id);
