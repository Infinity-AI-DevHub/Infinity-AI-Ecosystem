-- The columns the missing edit and delete operations need.
--
-- Most of these tables could already be created but never corrected: a vendor's details,
-- a budget's amount, a mistyped expense category, a group's name. Each needed either a
-- lifecycle column to retire a row, or nothing but the code that was never written.
--
-- Nothing here hard-deletes. Every one of these rows is referenced by something that has
-- to keep resolving - an expense claim names its category, an asset names its vendor -
-- so retiring hides it from the pickers while history stays intact.

-- Budgets had no lifecycle at all, so a superseded budget could only be left in place.
ALTER TABLE budgets
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER name,
  ADD COLUMN updated_at DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ADD CONSTRAINT budgets_status_chk CHECK (status IN ('active','closed'));

-- Groups were create-and-forget: no rename, no description edit, no way to remove one.
ALTER TABLE `groups`
  ADD COLUMN archived_at DATETIME(3) NULL,
  ADD COLUMN updated_at DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE expense_categories
  ADD COLUMN updated_at DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE vendors
  ADD COLUMN updated_at DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Client lifecycle.
--
-- 'upcoming' for work that is agreed but not started, 'completed' for a relationship
-- that has finished but whose invoices and history must stay readable. 'archived' is
-- kept so existing rows remain valid.
-- ---------------------------------------------------------------------------
ALTER TABLE external_organizations DROP CONSTRAINT external_org_status_chk;
ALTER TABLE external_organizations
  ADD CONSTRAINT external_org_status_chk
  CHECK (status IN ('upcoming','active','completed','archived'));
