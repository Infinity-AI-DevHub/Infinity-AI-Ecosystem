-- Billing details for a client, and the approval gate on issuing an invoice.
--
-- These columns exist because the invoice features assumed them. Issuing an invoice,
-- sending a receipt and chasing an overdue payment all email the client, and the client
-- record had no address, no contact person and no postal address to print. Vendors
-- already carried contact_email; clients did not, so the gap was invisible until
-- something tried to send.

ALTER TABLE external_organizations
  ADD COLUMN billing_email     VARCHAR(320) NULL AFTER website,
  ADD COLUMN contact_name      VARCHAR(200) NULL AFTER billing_email,
  ADD COLUMN contact_phone     VARCHAR(40)  NULL AFTER contact_name,
  -- The authorised representative is who the invoice is addressed to, which is not
  -- always the person whose inbox it arrives in.
  ADD COLUMN representative    VARCHAR(200) NULL AFTER contact_phone,
  ADD COLUMN address_line1     VARCHAR(200) NULL AFTER representative,
  ADD COLUMN address_line2     VARCHAR(200) NULL AFTER address_line1,
  ADD COLUMN city              VARCHAR(120) NULL AFTER address_line2,
  ADD COLUMN postal_code       VARCHAR(30)  NULL AFTER city,
  ADD COLUMN country           VARCHAR(80)  NULL AFTER postal_code,
  -- Printed on the invoice where the jurisdiction requires it.
  ADD COLUMN tax_registration  VARCHAR(60)  NULL AFTER country;

-- ---------------------------------------------------------------------------
-- Approval before an invoice reaches a client.
--
-- Anyone with invoice.manage may draft one; only a super administrator may release it.
-- Modelled as an explicit state rather than a boolean so the transition has somewhere
-- to record who approved it and when - "who sent this to the client" is the first
-- question asked when an invoice is wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN approved_by   CHAR(36)    NULL AFTER created_by,
  ADD COLUMN approved_at   DATETIME(3) NULL AFTER approved_by,
  ADD COLUMN submitted_at  DATETIME(3) NULL AFTER approved_at,
  ADD CONSTRAINT invoices_approver_fk
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- 'pending_approval' sits between draft and open: submitted by its author, not yet
-- released to the client.
ALTER TABLE invoices DROP CONSTRAINT invoices_status_chk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_chk
  CHECK (status IN ('draft','pending_approval','open','partially_paid','paid','void'));

-- ---------------------------------------------------------------------------
-- Invoice and receipt presentation, per company.
--
-- Stored as columns rather than a template language: a company needs its own header,
-- footer and payment instructions, not the ability to execute markup that later gets
-- rendered into a PDF and emailed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_settings (
  company_id        CHAR(36)     NOT NULL PRIMARY KEY,
  legal_name        VARCHAR(200) NULL,
  address_line1     VARCHAR(200) NULL,
  address_line2     VARCHAR(200) NULL,
  city              VARCHAR(120) NULL,
  postal_code       VARCHAR(30)  NULL,
  country           VARCHAR(80)  NULL,
  tax_registration  VARCHAR(60)  NULL,
  contact_email     VARCHAR(320) NULL,
  contact_phone     VARCHAR(40)  NULL,
  -- Where the money should go. Free text because bank detail formats differ by country
  -- and a structured schema here would fit one of them.
  payment_instructions TEXT      NULL,
  invoice_footer    TEXT         NULL,
  receipt_footer    TEXT         NULL,
  default_terms     TEXT         NULL,
  default_due_days  INT          NOT NULL DEFAULT 30,
  invoice_prefix    VARCHAR(12)  NOT NULL DEFAULT 'INV',
  receipt_prefix    VARCHAR(12)  NOT NULL DEFAULT 'RCP',
  accent_colour     VARCHAR(16)  NULL,
  logo_file_id      CHAR(36)     NULL,
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT billing_settings_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT billing_settings_logo_fk FOREIGN KEY (logo_file_id) REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT billing_settings_due_chk CHECK (default_due_days BETWEEN 0 AND 365)
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'invoice.approve'),
  ('super_admin', 'billing.configure'), ('admin', 'billing.configure')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
