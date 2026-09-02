-- Quotations, their revision history, and signatures that can be verified later.
--
-- A prospect is an external_organization with status 'upcoming'; accepting a quotation
-- moves it to 'active'. Reusing that record rather than inventing a separate prospects
-- table means the address, contact and history carry across at conversion instead of
-- being retyped, and a prospect that never converts still leaves a record of why.
--
-- What makes a signature here worth anything is not the image. It is that the row
-- records which authenticated account placed it, when, from where, and - crucially -
-- a hash of exactly what the document said at that moment. Change a line afterwards and
-- the hashes no longer match, which is detectable rather than deniable.

CREATE TABLE IF NOT EXISTS quotations (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  org_id         CHAR(36)     NOT NULL,
  number         VARCHAR(40)  NOT NULL,
  -- A revised quotation is a new row superseding the old one, never an edit of a signed
  -- document. revision counts within a series sharing the same root.
  root_id        CHAR(36)     NULL,
  revision       INT          NOT NULL DEFAULT 1,
  superseded_by  CHAR(36)     NULL,
  status         VARCHAR(24)  NOT NULL DEFAULT 'draft',
  currency       CHAR(3)      NOT NULL DEFAULT 'LKR',
  issue_date     DATE         NOT NULL,
  valid_until    DATE         NULL,
  subtotal       DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL DEFAULT 0,
  summary        TEXT         NULL,
  terms          TEXT         NULL,
  -- SHA-256 over the canonical content. Recomputed on read; a mismatch against a
  -- signature's recorded hash means the document changed after it was signed.
  content_hash   CHAR(64)     NULL,
  -- Why a prospect said no. The most useful field on a quotation that failed.
  decline_reason TEXT         NULL,
  sent_at        DATETIME(3)  NULL,
  decided_at     DATETIME(3)  NULL,
  -- The countersigned copy the client returns, uploaded back into the portal.
  signed_copy_file_id CHAR(36) NULL,
  created_by     CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version        INT          NOT NULL DEFAULT 1,
  UNIQUE KEY quotations_number (company_id, number),
  KEY quotations_org (company_id, org_id, status),
  KEY quotations_root (root_id, revision),
  CONSTRAINT quotations_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT quotations_org_fk FOREIGN KEY (org_id) REFERENCES external_organizations(id) ON DELETE CASCADE,
  CONSTRAINT quotations_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT quotations_copy_fk FOREIGN KEY (signed_copy_file_id) REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT quotations_status_chk CHECK (status IN (
    'draft',                -- being prepared
    'awaiting_countersign', -- the author has signed; a second person must
    'ready_to_send',        -- both internal signatures present
    'sent',                 -- with the prospect
    'under_revision',       -- they asked for changes; a new revision is being drawn up
    'accepted',             -- signed by the client and countersigned copy received
    'declined',             -- not converted
    'superseded'            -- replaced by a later revision
  )),
  CONSTRAINT quotations_total_chk CHECK (total >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quotation_lines (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  quotation_id CHAR(36)     NOT NULL,
  description  VARCHAR(500) NOT NULL,
  quantity     DECIMAL(12,3) NOT NULL DEFAULT 1,
  unit_price   DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate     DECIMAL(5,2)  NOT NULL DEFAULT 0,
  amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  sort_order   INT          NOT NULL DEFAULT 0,
  KEY quotation_lines_q (quotation_id, sort_order),
  CONSTRAINT quotation_lines_fk FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE,
  CONSTRAINT quotation_lines_qty_chk CHECK (quantity > 0)
) ENGINE=InnoDB;

-- A person's saved signature image, uploaded once and reused.
--
-- The image is convenience, not proof: it is what a reader recognises. The proof is the
-- quotation_signatures row beside it, which records the authenticated account.
CREATE TABLE IF NOT EXISTS user_signatures (
  user_id    CHAR(36)    NOT NULL PRIMARY KEY,
  file_id    CHAR(36)    NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT user_signatures_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_signatures_file_fk FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Signatures, for any document that needs them.
--
-- One table across quotations, invoices and receipts rather than three: the rules about
-- what a signature means, and the verification that it still matches the document, are
-- identical in all three cases. Three tables would be three places to keep that logic
-- correct.
--
-- Append-only. A signature is withdrawn by superseding the document, never by deleting
-- the row: "who signed what, and when" has to survive somebody changing their mind.
--
-- document_id carries no foreign key because it points at one of three tables. The
-- company_id key still scopes it to a tenant, and the domain layer resolves the document
-- before writing - a constraint MySQL cannot express is enforced where it can be.
CREATE TABLE IF NOT EXISTS document_signatures (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  document_type  VARCHAR(16)  NOT NULL,
  document_id    CHAR(36)     NOT NULL,
  /*
   * Who is signing, in which capacity.
   *
   * internal_1 and internal_2 are ours; client_1 and client_2 are theirs. A quotation
   * and an invoice need three (two ours, one theirs); a receipt needs four, because both
   * sides acknowledge that money changed hands.
   */
  role           VARCHAR(12)  NOT NULL,
  signer_user_id CHAR(36)     NULL,
  signer_name    VARCHAR(200) NOT NULL,
  signer_email   VARCHAR(320) NULL,
  image_file_id  CHAR(36)     NULL,
  -- Placement as fractions of the page, so the document renders at any size and the
  -- signature stays where it was put.
  page           INT          NOT NULL DEFAULT 1,
  pos_x          DECIMAL(6,5) NULL,
  pos_y          DECIMAL(6,5) NULL,
  width          DECIMAL(6,5) NULL,
  -- What the document said when this was signed.
  signed_hash    CHAR(64)     NOT NULL,
  signed_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  signed_ip      VARCHAR(64)  NULL,
  user_agent     VARCHAR(300) NULL,
  UNIQUE KEY document_signatures_role (document_type, document_id, role),
  KEY document_signatures_doc (company_id, document_type, document_id),
  CONSTRAINT document_signatures_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT document_signatures_user_fk FOREIGN KEY (signer_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT document_signatures_file_fk FOREIGN KEY (image_file_id) REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT document_signatures_type_chk CHECK (document_type IN ('quotation','invoice','receipt')),
  CONSTRAINT document_signatures_role_chk CHECK (role IN ('internal_1','internal_2','client_1','client_2'))
) ENGINE=InnoDB;

-- Invoices and receipts gain the same content hash and returned-copy fields quotations
-- have, so the identical verification applies to all three.
ALTER TABLE invoices
  ADD COLUMN content_hash CHAR(64) NULL AFTER terms,
  ADD COLUMN signed_copy_file_id CHAR(36) NULL AFTER content_hash,
  ADD CONSTRAINT invoices_signed_copy_fk
    FOREIGN KEY (signed_copy_file_id) REFERENCES files(id) ON DELETE SET NULL;

ALTER TABLE invoice_payments
  ADD COLUMN content_hash CHAR(64) NULL AFTER receipt_sent_at,
  ADD COLUMN signed_copy_file_id CHAR(36) NULL AFTER content_hash,
  ADD CONSTRAINT invoice_payments_signed_copy_fk
    FOREIGN KEY (signed_copy_file_id) REFERENCES files(id) ON DELETE SET NULL;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'quotation.read'),   ('admin', 'quotation.read'),
  ('manager', 'quotation.read'),       ('auditor', 'quotation.read'),
  ('super_admin', 'quotation.manage'), ('admin', 'quotation.manage'),
  ('manager', 'quotation.manage'),
  -- Signing is its own capability: drafting a quotation and committing the company to
  -- it are different acts, and the second is the one that binds.
  ('super_admin', 'quotation.sign'),   ('admin', 'quotation.sign'),
  ('manager', 'quotation.sign'),
  -- The same capability governs signing an invoice or a receipt: it is the act of
  -- committing the company to a document, not a per-document-type permission.
  ('super_admin', 'document.sign'),    ('admin', 'document.sign'), ('manager', 'document.sign')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
