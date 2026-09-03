-- Two things the portal needs that the workspace had no shape for.
--
-- 1. A notice addressed to a client organisation.
--
-- Announcements could reach the company, a department or a group - all internal. There
-- was no way to tell a client anything, so "we are closed next week" had to be an email
-- somebody remembered to send. The audience column is already JSON, so the new scope
-- needs no schema change; this index is what stops every portal load scanning the table.
CREATE INDEX idx_announcements_company_publish
  ON announcements (company_id, publish_at);

-- 2. A document the client sends us.
--
-- Everything else in the portal travels outwards. A client also needs to hand something
-- back - their own invoice, a remittance advice, a signed order - and email is where
-- those go to be lost. The bytes live in the ordinary file store, so scanning, quotas
-- and retention all apply; this table records what the upload was for and what we did
-- with it.
CREATE TABLE portal_uploads (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  org_id       CHAR(36)     NOT NULL,
  file_id      CHAR(36)     NOT NULL,
  uploaded_by  CHAR(36)     NOT NULL,

  -- What the client says it is. Not trusted as a classification, only as a label that
  -- saves whoever opens it from guessing.
  kind         VARCHAR(24)  NOT NULL DEFAULT 'other',
  note         TEXT         NULL,

  -- received -> nobody has looked yet; accepted/rejected once someone has.
  status       VARCHAR(16)  NOT NULL DEFAULT 'received',
  reviewed_by  CHAR(36)     NULL,
  reviewed_at  DATETIME(3)  NULL,
  review_note  TEXT         NULL,

  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_portal_upload_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_portal_upload_org     FOREIGN KEY (org_id)     REFERENCES external_organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_portal_upload_file    FOREIGN KEY (file_id)    REFERENCES files (id) ON DELETE CASCADE,
  CONSTRAINT fk_portal_upload_user    FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT uq_portal_upload_file    UNIQUE (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_portal_uploads_org ON portal_uploads (company_id, org_id, created_at);
CREATE INDEX idx_portal_uploads_status ON portal_uploads (company_id, status);

-- Uploading is the one thing a client does rather than reads, so it is its own
-- capability: a portal can be handed to somebody read-only by withholding just this.
INSERT INTO role_capabilities (role, capability) VALUES
  ('guest', 'portal.upload')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
