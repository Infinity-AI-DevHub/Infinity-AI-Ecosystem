-- Invoicing, project billing, online meetings and document attachments.
--
-- Money is DECIMAL throughout, matching the expense tables. Floating point cannot
-- represent 0.10, and an invoice that is a cent out is a conversation with a client.
--
-- Overdue is deliberately NOT a stored status. It is a function of due_date and the
-- outstanding balance, so storing it would mean a row that is wrong between the moment
-- it falls due and the moment some job notices. Every query derives it.

-- ---------------------------------------------------------------------------
-- Online meetings: a link people join rather than a room they walk to.
-- ---------------------------------------------------------------------------
ALTER TABLE calendar_events
  ADD COLUMN online_url VARCHAR(600) NULL AFTER location;

-- ---------------------------------------------------------------------------
-- Projects gain the client they are billed to. Nullable: internal projects exist.
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN client_org_id CHAR(36) NULL AFTER owner_id,
  ADD CONSTRAINT projects_client_fk
    FOREIGN KEY (client_org_id) REFERENCES external_organizations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Documents can be shared with clients through the same link machinery as files,
-- which already carries expiry, revocation, use limits and a recipient address.
-- ---------------------------------------------------------------------------
ALTER TABLE share_links DROP CONSTRAINT share_links_type_chk;
ALTER TABLE share_links
  ADD CONSTRAINT share_links_type_chk
  CHECK (resource_type IN ('file','folder','doc','invoice'));

-- Files attached to a documentation page. The bytes live in the files table like any
-- other upload, so scanning, quota and retention apply without a second code path.
CREATE TABLE IF NOT EXISTS doc_attachments (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  company_id  CHAR(36)    NOT NULL,
  page_id     CHAR(36)    NOT NULL,
  file_id     CHAR(36)    NOT NULL,
  uploaded_by CHAR(36)    NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY doc_attachments_unique (page_id, file_id),
  KEY doc_attachments_page (company_id, page_id),
  CONSTRAINT doc_attachments_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT doc_attachments_page_fk FOREIGN KEY (page_id) REFERENCES doc_pages(id) ON DELETE CASCADE,
  CONSTRAINT doc_attachments_file_fk FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  CONSTRAINT doc_attachments_user_fk FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  client_org_id  CHAR(36)     NOT NULL,
  project_id     CHAR(36)     NULL,
  -- Human reference. Unique per company so two people cannot issue the same number.
  number         VARCHAR(40)  NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'draft',
  currency       CHAR(3)      NOT NULL DEFAULT 'LKR',
  issue_date     DATE         NOT NULL,
  due_date       DATE         NOT NULL,
  subtotal       DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL DEFAULT 0,
  -- Denormalised from invoice_payments so a list of invoices does not need a subquery
  -- per row. Maintained in the same transaction as the payment it reflects.
  amount_paid    DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes          TEXT         NULL,
  terms          TEXT         NULL,
  -- Reminder cadence, per invoice so a difficult client can be chased differently.
  reminders_enabled  TINYINT(1) NOT NULL DEFAULT 1,
  reminder_interval_days INT    NOT NULL DEFAULT 7,
  reminder_last_sent_at  DATETIME(3) NULL,
  reminder_count     INT        NOT NULL DEFAULT 0,
  sent_at        DATETIME(3)  NULL,
  created_by     CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  version        INT          NOT NULL DEFAULT 1,
  UNIQUE KEY invoices_number (company_id, number),
  KEY invoices_client (company_id, client_org_id, status),
  KEY invoices_project (company_id, project_id),
  -- The reminder job scans on exactly this: unpaid, past due, reminders on.
  KEY invoices_due (company_id, status, due_date),
  CONSTRAINT invoices_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  -- CASCADE, not RESTRICT, for the reason set out in 0005: clients are archived and
  -- never hard-deleted, so the only DELETE that ever reaches this row is a whole-tenant
  -- removal. RESTRICT would block that entirely while protecting nothing, because no
  -- code path deletes an organisation. Refusing to remove a client that still has
  -- invoices belongs in the application, where it can say why.
  CONSTRAINT invoices_client_fk FOREIGN KEY (client_org_id) REFERENCES external_organizations(id) ON DELETE CASCADE,
  CONSTRAINT invoices_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  CONSTRAINT invoices_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT invoices_status_chk CHECK (status IN ('draft','open','partially_paid','paid','void')),
  CONSTRAINT invoices_total_chk CHECK (total >= 0),
  CONSTRAINT invoices_paid_chk CHECK (amount_paid >= 0),
  CONSTRAINT invoices_interval_chk CHECK (reminder_interval_days BETWEEN 1 AND 90),
  CONSTRAINT invoices_dates_chk CHECK (due_date >= issue_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  invoice_id  CHAR(36)     NOT NULL,
  description VARCHAR(500) NOT NULL,
  quantity    DECIMAL(12,3) NOT NULL DEFAULT 1,
  unit_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2)  NOT NULL DEFAULT 0,
  amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  sort_order  INT          NOT NULL DEFAULT 0,
  KEY invoice_lines_invoice (invoice_id, sort_order),
  CONSTRAINT invoice_lines_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT invoice_lines_qty_chk CHECK (quantity > 0),
  CONSTRAINT invoice_lines_tax_chk CHECK (tax_rate >= 0 AND tax_rate <= 100)
) ENGINE=InnoDB;

-- Payments are append-only. A correction is a negative adjustment with its own reason,
-- never an edit: an invoice's payment history is the record you produce in a dispute.
CREATE TABLE IF NOT EXISTS invoice_payments (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  invoice_id     CHAR(36)     NOT NULL,
  amount         DECIMAL(14,2) NOT NULL,
  paid_on        DATE         NOT NULL,
  method         VARCHAR(30)  NOT NULL DEFAULT 'bank_transfer',
  reference      VARCHAR(120) NULL,
  note           TEXT         NULL,
  -- Receipts are numbered separately from invoices: a client may pay one invoice in
  -- three instalments and needs three receipts they can each refer to.
  receipt_number VARCHAR(40)  NULL,
  receipt_sent_at DATETIME(3) NULL,
  recorded_by    CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY invoice_payments_receipt (company_id, receipt_number),
  KEY invoice_payments_invoice (invoice_id, paid_on),
  CONSTRAINT invoice_payments_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT invoice_payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  CONSTRAINT invoice_payments_user_fk FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT invoice_payments_method_chk CHECK (method IN ('bank_transfer','card','cash','cheque','online','other'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- Issuing an invoice and recording a payment against it are separated on purpose, the
-- same way approving an expense is separated from paying it: the person who decides
-- what a client owes should not silently be the person who marks it settled.
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'invoice.read'),   ('admin', 'invoice.read'),
  ('manager', 'invoice.read'),       ('auditor', 'invoice.read'),
  ('super_admin', 'invoice.manage'), ('admin', 'invoice.manage'),
  ('super_admin', 'payment.record'), ('admin', 'payment.record')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
