-- Infinity Workspace :: leave, and approval delegation.
--
-- A leave request already existed as a generic approval form: three fields and a routing
-- rule. That records that someone asked, and nothing else - no entitlement, no balance,
-- no notion of which days are working days, and no trace on the calendar. This adds the
-- part that makes it a leave system rather than a form.
--
-- Delegation ships alongside it deliberately. Unroutable approval requests now refuse
-- outright rather than stranding, which is correct, but it means an approver going on
-- holiday hard-blocks everything routed to them. Leave without delegation would create
-- exactly that outage on purpose.

CREATE TABLE IF NOT EXISTS leave_types (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  `key`         VARCHAR(40)  NOT NULL,
  name          VARCHAR(80)  NOT NULL,
  paid          TINYINT(1)   NOT NULL DEFAULT 1,
  -- Sick leave is commonly taken first and justified afterwards; the type decides.
  requires_approval TINYINT(1) NOT NULL DEFAULT 1,
  -- Deducted from a balance, or simply recorded (unpaid leave has no entitlement).
  deducts_balance TINYINT(1) NOT NULL DEFAULT 1,
  default_annual_days DECIMAL(5,2) NOT NULL DEFAULT 0,
  colour        VARCHAR(16)  NOT NULL DEFAULT '#6366f1',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY leave_types_key (company_id, `key`),
  CONSTRAINT leave_types_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per person, per type, per leave year. Balances are held rather than derived so
-- that a mid-year change to entitlement - a promotion, a contract change - does not
-- silently rewrite what someone was entitled to last year.
CREATE TABLE IF NOT EXISTS leave_balances (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  leave_type_id  CHAR(36)     NOT NULL,
  year           SMALLINT     NOT NULL,
  entitled_days  DECIMAL(5,2) NOT NULL DEFAULT 0,
  carried_days   DECIMAL(5,2) NOT NULL DEFAULT 0,
  -- Taken and pending are tracked apart so a person can see what they have committed to
  -- but not yet used, which is what stops double-booking a holiday.
  taken_days     DECIMAL(5,2) NOT NULL DEFAULT 0,
  pending_days   DECIMAL(5,2) NOT NULL DEFAULT 0,
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY leave_balances_unique (user_id, leave_type_id, year),
  KEY leave_balances_company (company_id, year),
  CONSTRAINT leave_balances_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT leave_balances_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT leave_balances_type_fk FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The domain record. It points at the approval request rather than reimplementing
-- routing, so leave inherits the manager fallback, separation of duties, escalation and
-- immutable decision history that the approvals engine already enforces.
CREATE TABLE IF NOT EXISTS leave_requests (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  user_id             CHAR(36)     NOT NULL,
  leave_type_id       CHAR(36)     NOT NULL,
  approval_request_id CHAR(36)     NULL,
  start_date          DATE         NOT NULL,
  end_date            DATE         NOT NULL,
  -- Half days are the common case for appointments, and only ever at the edges.
  half_day_start      TINYINT(1)   NOT NULL DEFAULT 0,
  half_day_end        TINYINT(1)   NOT NULL DEFAULT 0,
  working_days        DECIMAL(5,2) NOT NULL,
  reason              VARCHAR(1000) NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
  calendar_event_id   CHAR(36)     NULL,
  cancelled_reason    VARCHAR(500) NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY leave_requests_user (user_id, start_date),
  KEY leave_requests_company_range (company_id, start_date, end_date),
  KEY leave_requests_status (company_id, status),
  CONSTRAINT leave_requests_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT leave_requests_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT leave_requests_type_fk FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE RESTRICT,
  CONSTRAINT leave_requests_approval_fk FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE SET NULL,
  CONSTRAINT leave_requests_status_chk CHECK (status IN ('pending','approved','rejected','cancelled')),
  CONSTRAINT leave_requests_range_chk CHECK (end_date >= start_date)
) ENGINE=InnoDB;

-- Public holidays are company data, not a library: they differ by country and by year,
-- and a wrong list silently miscounts everyone's entitlement.
CREATE TABLE IF NOT EXISTS company_holidays (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  holiday_date DATE        NOT NULL,
  name        VARCHAR(120) NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY company_holidays_date (company_id, holiday_date),
  CONSTRAINT company_holidays_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Delegation: while this window is open, decisions routed to from_user go to to_user
-- instead. Stored as a window rather than a flag so it can be arranged in advance and
-- expires on its own, which is what makes it usable for a holiday booked months out.
CREATE TABLE IF NOT EXISTS approval_delegations (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  from_user_id CHAR(36)     NOT NULL,
  to_user_id   CHAR(36)     NOT NULL,
  starts_at    DATETIME(3)  NOT NULL,
  ends_at      DATETIME(3)  NOT NULL,
  reason       VARCHAR(500) NULL,
  -- Set when the delegation was created automatically by an approved leave request, so
  -- cancelling the leave can withdraw it again.
  leave_request_id CHAR(36) NULL,
  created_by   CHAR(36)     NULL,
  revoked_at   DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY delegations_active (company_id, from_user_id, starts_at, ends_at),
  KEY delegations_leave (leave_request_id),
  CONSTRAINT delegations_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT delegations_from_fk FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT delegations_to_fk FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT delegations_leave_fk FOREIGN KEY (leave_request_id) REFERENCES leave_requests(id) ON DELETE SET NULL,
  CONSTRAINT delegations_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT delegations_window_chk CHECK (ends_at > starts_at),
  -- Self-delegation is a no-op that would silently swallow the request.
  CONSTRAINT delegations_distinct_chk CHECK (from_user_id <> to_user_id)
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'leave.request'), ('admin', 'leave.request'),
  ('manager', 'leave.request'), ('staff', 'leave.request'),
  ('super_admin', 'leave.read_all'), ('admin', 'leave.read_all'),
  ('manager', 'leave.read_all'), ('auditor', 'leave.read_all'),
  ('super_admin', 'leave.manage'), ('admin', 'leave.manage'),
  -- Anyone who can hold an approval must be able to hand it on while they are away.
  ('super_admin', 'delegation.manage'), ('admin', 'delegation.manage'),
  ('manager', 'delegation.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
