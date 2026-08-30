-- Infinity Workspace :: account recovery, role assignment and offboarding.
--
-- This platform is the company's only system, which changes what a lost password means.
-- There is no second place to sign in from and no identity provider behind it, so an
-- administrator who cannot authenticate cannot be rescued by anything outside these
-- tables. Recovery is therefore part of the product, not an operational afterthought.

-- Single-use, short-lived password reset tokens. Only the hash is stored, so a database
-- reader cannot mint a session; the plaintext exists only in the message sent to the
-- address on file.
-- Tables here name no charset or collation of their own. Writing `DEFAULT CHARSET=utf8mb4`
-- without a collation takes the *charset's* default rather than the database's, which
-- differs between MySQL 8 (utf8mb4_0900_ai_ci) and MariaDB (utf8mb4_general_ci) - so the
-- CHAR(36) keys created here stop matching the ones created earlier, and every foreign
-- key across the boundary is rejected as incompatible. Inheriting from the database keeps
-- one collation throughout, whichever the operator chose.
CREATE TABLE IF NOT EXISTS password_resets (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  token_hash    CHAR(64)     NOT NULL,
  requested_ip  VARCHAR(45)  NULL,
  expires_at    DATETIME(3)  NOT NULL,
  consumed_at   DATETIME(3)  NULL,
  invalidated_at DATETIME(3) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY password_resets_token (token_hash),
  KEY password_resets_user (user_id, consumed_at),
  KEY password_resets_expiry (expires_at),
  CONSTRAINT password_resets_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Offboarding is a record, not just a status flag. It names who inherited the departing
-- person's work, so "who owns this now?" has an answer months later, and so the transfer
-- itself is auditable.
CREATE TABLE IF NOT EXISTS offboardings (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  successor_id   CHAR(36)     NULL,
  performed_by   CHAR(36)     NULL,
  reason         VARCHAR(500) NOT NULL,
  -- Counts of what moved, kept for the audit trail even after the rows change again.
  transferred    JSON         NOT NULL,
  last_day       DATE         NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY offboardings_user (user_id),
  KEY offboardings_company (company_id, created_at),
  CONSTRAINT offboardings_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT offboardings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT offboardings_successor_fk FOREIGN KEY (successor_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT offboardings_actor_fk FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 'offboarded' is distinct from 'suspended': suspension is reversible and says nothing
-- about where the work went, whereas offboarding is terminal and always has a record.
ALTER TABLE users
  ADD COLUMN offboarded_at DATETIME(3) NULL AFTER suspended_at;

-- Recovery must survive the loss of every interactive credential, so the break-glass CLI
-- writes here. Recording it in the database rather than only in logs means the next
-- administrator can see that it happened even if log retention has rolled over.
CREATE TABLE IF NOT EXISTS break_glass_events (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NULL,
  user_id     CHAR(36)     NULL,
  reason      VARCHAR(500) NOT NULL,
  operator    VARCHAR(200) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY break_glass_created (created_at)
) ENGINE=InnoDB;
