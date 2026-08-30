-- Infinity Workspace :: expenses, budgets, vendors and the asset register.
--
-- The approvals engine could already route an expense or purchase request, but there was
-- nothing underneath it: someone could ask for four hundred pounds of travel and the
-- system held no receipt, no reimbursement status, and no record of which budget it came
-- out of. The workflow existed without the thing it was a workflow over.

-- Money is DECIMAL throughout. Floating point cannot represent 0.10, and an accounting
-- record that is nearly right is wrong.
CREATE TABLE IF NOT EXISTS expense_categories (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  `key`       VARCHAR(40)  NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  -- A per-item ceiling above which the claim needs more than a manager's nod.
  limit_amount DECIMAL(12,2) NULL,
  requires_receipt_above DECIMAL(12,2) NOT NULL DEFAULT 0,
  active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY expense_categories_key (company_id, `key`),
  CONSTRAINT expense_categories_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A claim is the unit that gets approved and paid; items are what it is made of. Kept
-- apart because a trip is one decision and eleven receipts, and approving each receipt
-- separately is how expense systems become hated.
CREATE TABLE IF NOT EXISTS expense_claims (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  claimant_id         CHAR(36)     NOT NULL,
  reference           VARCHAR(40)  NOT NULL,
  title               VARCHAR(200) NOT NULL,
  currency            CHAR(3)      NOT NULL DEFAULT 'USD',
  total_amount        DECIMAL(12,2) NOT NULL DEFAULT 0,
  status              VARCHAR(20)  NOT NULL DEFAULT 'draft',
  approval_request_id CHAR(36)     NULL,
  budget_id           CHAR(36)     NULL,
  submitted_at        DATETIME(3)  NULL,
  decided_at          DATETIME(3)  NULL,
  -- Reimbursement is tracked separately from approval: an approved claim that nobody has
  -- paid is the single most common complaint about expense systems, and it is invisible
  -- unless the two states are held apart.
  reimbursed_at       DATETIME(3)  NULL,
  reimbursed_by       CHAR(36)     NULL,
  payment_reference   VARCHAR(120) NULL,
  rejection_reason    VARCHAR(500) NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY expense_claims_reference (company_id, reference),
  KEY expense_claims_claimant (claimant_id, status),
  KEY expense_claims_status (company_id, status, created_at),
  CONSTRAINT expense_claims_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT expense_claims_claimant_fk FOREIGN KEY (claimant_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT expense_claims_approval_fk FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT expense_claims_payer_fk FOREIGN KEY (reimbursed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT expense_claims_status_chk CHECK (status IN ('draft','submitted','approved','rejected','reimbursed','cancelled'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expense_items (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  claim_id     CHAR(36)     NOT NULL,
  category_id  CHAR(36)     NULL,
  spent_on     DATE         NOT NULL,
  merchant     VARCHAR(200) NULL,
  description  VARCHAR(500) NULL,
  amount       DECIMAL(12,2) NOT NULL,
  tax_amount   DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- The receipt is a real file, so it is scanned for malware and retained like any other.
  receipt_file_id CHAR(36)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY expense_items_claim (claim_id),
  CONSTRAINT expense_items_claim_fk FOREIGN KEY (claim_id) REFERENCES expense_claims(id) ON DELETE CASCADE,
  CONSTRAINT expense_items_category_fk FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
  CONSTRAINT expense_items_receipt_fk FOREIGN KEY (receipt_file_id) REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT expense_items_amount_chk CHECK (amount >= 0)
) ENGINE=InnoDB;

-- Budgets are per department per period. Committed and spent are held apart for the same
-- reason as leave: an approved-but-unpaid claim has already consumed the budget in every
-- sense that matters for planning, even though no money has moved.
CREATE TABLE IF NOT EXISTS budgets (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  department_id  CHAR(36)     NULL,
  name           VARCHAR(120) NOT NULL,
  period_start   DATE         NOT NULL,
  period_end     DATE         NOT NULL,
  currency       CHAR(3)      NOT NULL DEFAULT 'USD',
  amount         DECIMAL(14,2) NOT NULL,
  committed_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  spent_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_by     CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY budgets_company_period (company_id, period_start, period_end),
  KEY budgets_department (department_id),
  CONSTRAINT budgets_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT budgets_department_fk FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT budgets_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT budgets_period_chk CHECK (period_end >= period_start)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vendors (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  name        VARCHAR(200) NOT NULL,
  -- A vendor may also be an external organisation we collaborate with; linking them
  -- means the client screen and the finance screen are talking about the same company.
  organization_id CHAR(36) NULL,
  contact_email VARCHAR(320) NULL,
  contact_phone VARCHAR(40) NULL,
  tax_id      VARCHAR(60)  NULL,
  notes       TEXT         NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY vendors_name (company_id, name),
  CONSTRAINT vendors_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT vendors_org_fk FOREIGN KEY (organization_id) REFERENCES external_organizations(id) ON DELETE SET NULL,
  CONSTRAINT vendors_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT vendors_status_chk CHECK (status IN ('active','archived'))
) ENGINE=InnoDB;

-- The asset register. Laptops walk out of companies with departing employees more often
-- than anything else, which is why assignment is a history rather than a column.
CREATE TABLE IF NOT EXISTS assets (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  asset_tag      VARCHAR(60)  NOT NULL,
  name           VARCHAR(200) NOT NULL,
  category       VARCHAR(60)  NOT NULL DEFAULT 'laptop',
  serial_number  VARCHAR(120) NULL,
  vendor_id      CHAR(36)     NULL,
  purchased_on   DATE         NULL,
  purchase_cost  DECIMAL(12,2) NULL,
  currency       CHAR(3)      NOT NULL DEFAULT 'USD',
  warranty_until DATE         NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'in_stock',
  assigned_to    CHAR(36)     NULL,
  location       VARCHAR(120) NULL,
  notes          TEXT         NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY assets_tag (company_id, asset_tag),
  KEY assets_assignee (assigned_to),
  KEY assets_status (company_id, status),
  CONSTRAINT assets_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT assets_vendor_fk FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL,
  CONSTRAINT assets_assignee_fk FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT assets_status_chk CHECK (status IN ('in_stock','assigned','repair','retired','lost'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS asset_assignments (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  asset_id    CHAR(36)     NOT NULL,
  user_id     CHAR(36)     NULL,
  assigned_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  returned_at DATETIME(3)  NULL,
  condition_note VARCHAR(500) NULL,
  recorded_by CHAR(36)     NULL,
  KEY asset_assignments_asset (asset_id, assigned_at),
  KEY asset_assignments_user (user_id, returned_at),
  CONSTRAINT asset_assignments_asset_fk FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  CONSTRAINT asset_assignments_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT asset_assignments_recorder_fk FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'expense.submit'), ('admin', 'expense.submit'),
  ('manager', 'expense.submit'), ('staff', 'expense.submit'),
  ('super_admin', 'expense.read_all'), ('admin', 'expense.read_all'),
  ('manager', 'expense.read_all'), ('auditor', 'expense.read_all'),
  -- Marking a claim paid is a financial act distinct from approving it, so that the
  -- person who approves is not automatically the person who pays.
  ('super_admin', 'expense.reimburse'), ('admin', 'expense.reimburse'),
  ('super_admin', 'budget.manage'), ('admin', 'budget.manage'),
  ('super_admin', 'budget.read'), ('admin', 'budget.read'),
  ('manager', 'budget.read'), ('auditor', 'budget.read'),
  ('super_admin', 'vendor.manage'), ('admin', 'vendor.manage'), ('manager', 'vendor.manage'),
  ('super_admin', 'asset.manage'), ('admin', 'asset.manage'),
  ('super_admin', 'asset.read'), ('admin', 'asset.read'),
  ('manager', 'asset.read'), ('auditor', 'asset.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
