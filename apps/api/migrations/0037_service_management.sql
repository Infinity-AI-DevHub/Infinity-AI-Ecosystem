-- Infinity Workspace :: service management, the rest of Phase 2
--
-- Knowledge base, request forms, problem and change management, software licences,
-- vendor contracts, asset links on tickets, expiry reminders and email-to-ticket.
--
-- Everything reuses what exists: vendors and assets (0012), the approvals engine for
-- change approval, the files domain for contract documents, and the ticket model (0036).
-- References to people cascade for the reason given in 0005 and 0036.

-- ---------------------------------------------------------------- knowledge base

CREATE TABLE kb_articles (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  title         VARCHAR(300) NOT NULL,
  summary       VARCHAR(500) NULL,
  body          MEDIUMTEXT   NOT NULL,
  -- 'internal' is for employees; 'public' is also shown to clients in the portal.
  audience      VARCHAR(10)  NOT NULL DEFAULT 'internal',
  status        VARCHAR(10)  NOT NULL DEFAULT 'draft',
  queue_id      CHAR(36)     NULL,
  category_id   CHAR(36)     NULL,
  author_id     CHAR(36)     NOT NULL,
  updated_by    CHAR(36)     NULL,
  published_at  DATETIME(3)  NULL,
  helpful_count INT          NOT NULL DEFAULT 0,
  unhelpful_count INT        NOT NULL DEFAULT 0,
  view_count    INT          NOT NULL DEFAULT 0,
  version       INT          NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_kb_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_queue    FOREIGN KEY (queue_id)    REFERENCES service_queues (id) ON DELETE SET NULL,
  CONSTRAINT fk_kb_category FOREIGN KEY (category_id) REFERENCES service_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_kb_author   FOREIGN KEY (author_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_editor   FOREIGN KEY (updated_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT kb_audience_chk CHECK (audience IN ('internal','public')),
  CONSTRAINT kb_status_chk   CHECK (status IN ('draft','published','archived'))
) ENGINE=InnoDB;
CREATE INDEX idx_kb_company_status ON kb_articles (company_id, status, audience);
CREATE FULLTEXT INDEX ft_kb ON kb_articles (title, summary, body);

-- One vote per person per article, so a count cannot be stuffed.
CREATE TABLE kb_votes (
  article_id  CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  helpful     TINYINT(1)  NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (article_id, user_id),
  CONSTRAINT fk_kb_vote_article FOREIGN KEY (article_id) REFERENCES kb_articles (id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_vote_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Articles used to answer a ticket.
CREATE TABLE ticket_articles (
  ticket_id   CHAR(36)    NOT NULL,
  article_id  CHAR(36)    NOT NULL,
  linked_by   CHAR(36)    NOT NULL,
  linked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket_id, article_id),
  CONSTRAINT fk_ta_ticket  FOREIGN KEY (ticket_id)  REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_article FOREIGN KEY (article_id) REFERENCES kb_articles (id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_user    FOREIGN KEY (linked_by)  REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ request forms

-- A category may ask for structured details: the asset tag for a hardware fault, the
-- system name for an access request. The schema is a JSON array of field definitions,
-- validated in the domain; answers are stored against the ticket.
ALTER TABLE service_categories ADD COLUMN form_fields JSON NULL;
ALTER TABLE tickets ADD COLUMN form_answers JSON NULL;

-- ------------------------------------------------------------------ problems

-- Incidents caused by the same underlying fault point at one problem ticket.
CREATE TABLE ticket_problem_links (
  incident_id  CHAR(36)    NOT NULL PRIMARY KEY,
  problem_id   CHAR(36)    NOT NULL,
  company_id   CHAR(36)    NOT NULL,
  linked_by    CHAR(36)    NOT NULL,
  linked_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_tpl_incident FOREIGN KEY (incident_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_tpl_problem  FOREIGN KEY (problem_id)  REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_tpl_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_tpl_user     FOREIGN KEY (linked_by)   REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_tpl_problem ON ticket_problem_links (problem_id);

-- Root cause and workaround live on the problem ticket itself.
ALTER TABLE tickets ADD COLUMN root_cause TEXT NULL;
ALTER TABLE tickets ADD COLUMN workaround TEXT NULL;

-- ------------------------------------------------------------------ changes

CREATE TABLE change_counters (
  company_id   CHAR(36) NOT NULL PRIMARY KEY,
  next_number  INT      NOT NULL DEFAULT 1,
  CONSTRAINT fk_change_counter_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE change_requests (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  number              INT          NOT NULL,
  title               VARCHAR(300) NOT NULL,
  description         TEXT         NOT NULL,
  -- standard: pre-approved and routine; normal: approved each time; emergency: expedited.
  change_type         VARCHAR(10)  NOT NULL DEFAULT 'normal',
  risk                VARCHAR(10)  NOT NULL DEFAULT 'medium',
  impact              TEXT         NULL,
  implementation_plan TEXT         NULL,
  rollback_plan       TEXT         NULL,
  test_plan           TEXT         NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'draft',
  requester_id        CHAR(36)     NOT NULL,
  owner_id            CHAR(36)     NULL,
  queue_id            CHAR(36)     NULL,
  planned_start       DATETIME(3)  NULL,
  planned_end         DATETIME(3)  NULL,
  implemented_at      DATETIME(3)  NULL,
  outcome             VARCHAR(12)  NULL,
  outcome_notes       TEXT         NULL,
  approval_request_id CHAR(36)     NULL,
  version             INT          NOT NULL DEFAULT 1,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_change_company   FOREIGN KEY (company_id)   REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_change_requester FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_change_owner     FOREIGN KEY (owner_id)     REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_change_queue     FOREIGN KEY (queue_id)     REFERENCES service_queues (id) ON DELETE SET NULL,
  CONSTRAINT fk_change_approval  FOREIGN KEY (approval_request_id) REFERENCES approval_requests (id) ON DELETE SET NULL,
  CONSTRAINT uq_change_number UNIQUE (company_id, number),
  CONSTRAINT change_type_chk    CHECK (change_type IN ('standard','normal','emergency')),
  CONSTRAINT change_risk_chk    CHECK (risk IN ('low','medium','high')),
  CONSTRAINT change_status_chk  CHECK (status IN ('draft','pending_approval','approved','rejected','scheduled','in_progress','implemented','failed','cancelled','closed')),
  CONSTRAINT change_outcome_chk CHECK (outcome IS NULL OR outcome IN ('successful','failed','rolled_back')),
  CONSTRAINT change_window_chk  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start)
) ENGINE=InnoDB;
CREATE INDEX idx_change_status ON change_requests (company_id, status, planned_start);

CREATE TABLE change_ticket_links (
  change_id   CHAR(36)    NOT NULL,
  ticket_id   CHAR(36)    NOT NULL,
  linked_by   CHAR(36)    NOT NULL,
  linked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (change_id, ticket_id),
  CONSTRAINT fk_ctl_change FOREIGN KEY (change_id) REFERENCES change_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_ctl_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ctl_user   FOREIGN KEY (linked_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE change_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  change_id   CHAR(36)     NOT NULL,
  company_id  CHAR(36)     NOT NULL,
  actor_id    CHAR(36)     NULL,
  kind        VARCHAR(40)  NOT NULL,
  detail      VARCHAR(500) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_change_event_change  FOREIGN KEY (change_id)  REFERENCES change_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_change_event_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_change_event ON change_events (change_id, id);

-- ------------------------------------------------------------ licences and contracts

-- Licence keys are deliberately not stored. A key is a credential; it belongs in the
-- vendor portal or a secrets vault, which is a separately reviewed milestone.
CREATE TABLE software_licences (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  company_id      CHAR(36)      NOT NULL,
  name            VARCHAR(200)  NOT NULL,
  vendor_id       CHAR(36)      NULL,
  licence_type    VARCHAR(12)   NOT NULL DEFAULT 'subscription',
  seats           INT           NULL,
  cost            DECIMAL(12,2) NULL,
  currency        CHAR(3)       NOT NULL DEFAULT 'USD',
  billing_period  VARCHAR(10)   NULL,
  renews_on       DATE          NULL,
  -- Where the key or admin console actually lives, e.g. "Microsoft 365 admin centre".
  managed_at      VARCHAR(300)  NULL,
  owner_id        CHAR(36)      NULL,
  status          VARCHAR(10)   NOT NULL DEFAULT 'active',
  notes           TEXT          NULL,
  created_by      CHAR(36)      NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_licence_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_licence_vendor  FOREIGN KEY (vendor_id)  REFERENCES vendors (id) ON DELETE SET NULL,
  CONSTRAINT fk_licence_owner   FOREIGN KEY (owner_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_licence_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT licence_type_chk   CHECK (licence_type IN ('subscription','perpetual','open_source','trial')),
  CONSTRAINT licence_status_chk CHECK (status IN ('active','expired','cancelled')),
  CONSTRAINT licence_seats_chk  CHECK (seats IS NULL OR seats >= 0)
) ENGINE=InnoDB;
CREATE INDEX idx_licence_renewal ON software_licences (company_id, status, renews_on);

CREATE TABLE licence_assignments (
  licence_id   CHAR(36)    NOT NULL,
  user_id      CHAR(36)    NOT NULL,
  company_id   CHAR(36)    NOT NULL,
  assigned_by  CHAR(36)    NULL,
  assigned_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (licence_id, user_id),
  CONSTRAINT fk_la_licence FOREIGN KEY (licence_id) REFERENCES software_licences (id) ON DELETE CASCADE,
  CONSTRAINT fk_la_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_la_by      FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX idx_la_user ON licence_assignments (user_id);

CREATE TABLE vendor_contracts (
  id              CHAR(36)      NOT NULL PRIMARY KEY,
  company_id      CHAR(36)      NOT NULL,
  vendor_id       CHAR(36)      NOT NULL,
  title           VARCHAR(200)  NOT NULL,
  reference       VARCHAR(120)  NULL,
  starts_on       DATE          NULL,
  ends_on         DATE          NULL,
  notice_days     INT           NOT NULL DEFAULT 30,
  auto_renews     TINYINT(1)    NOT NULL DEFAULT 0,
  value           DECIMAL(14,2) NULL,
  currency        CHAR(3)       NOT NULL DEFAULT 'USD',
  owner_id        CHAR(36)      NULL,
  document_file_id CHAR(36)     NULL,
  status          VARCHAR(10)   NOT NULL DEFAULT 'active',
  notes           TEXT          NULL,
  created_by      CHAR(36)      NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_contract_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_contract_vendor  FOREIGN KEY (vendor_id)  REFERENCES vendors (id) ON DELETE CASCADE,
  CONSTRAINT fk_contract_owner   FOREIGN KEY (owner_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_file    FOREIGN KEY (document_file_id) REFERENCES files (id) ON DELETE SET NULL,
  CONSTRAINT fk_contract_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT contract_status_chk CHECK (status IN ('active','ended','cancelled')),
  CONSTRAINT contract_dates_chk  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT contract_notice_chk CHECK (notice_days >= 0)
) ENGINE=InnoDB;
CREATE INDEX idx_contract_end ON vendor_contracts (company_id, status, ends_on);

-- Which devices a ticket is about.
CREATE TABLE ticket_assets (
  ticket_id   CHAR(36)    NOT NULL,
  asset_id    CHAR(36)    NOT NULL,
  linked_by   CHAR(36)    NOT NULL,
  linked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket_id, asset_id),
  CONSTRAINT fk_tas_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_tas_asset  FOREIGN KEY (asset_id)  REFERENCES assets (id) ON DELETE CASCADE,
  CONSTRAINT fk_tas_user   FOREIGN KEY (linked_by) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_tas_asset ON ticket_assets (asset_id);

-- ------------------------------------------------------------------ email-to-ticket

-- One inbound channel per company. The signing secret is encrypted at rest with the
-- application data key (core/crypto encryptField); only its fingerprint is ever shown.
CREATE TABLE service_inbound_email (
  company_id        CHAR(36)     NOT NULL PRIMARY KEY,
  queue_id          CHAR(36)     NOT NULL,
  -- Routing key in the webhook URL; not a secret on its own.
  endpoint_key      CHAR(32)     NOT NULL,
  secret_encrypted  TEXT         NOT NULL,
  secret_fingerprint CHAR(12)    NOT NULL,
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  last_received_at  DATETIME(3)  NULL,
  rotated_by        CHAR(36)     NULL,
  rotated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_inbound_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_inbound_queue   FOREIGN KEY (queue_id)   REFERENCES service_queues (id) ON DELETE CASCADE,
  CONSTRAINT fk_inbound_user    FOREIGN KEY (rotated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_inbound_key UNIQUE (endpoint_key)
) ENGINE=InnoDB;

-- Every inbound message, including refused ones, so a missing ticket can be explained.
-- The Message-ID makes a redelivered webhook a no-op.
CREATE TABLE service_inbound_messages (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  message_id   VARCHAR(300) NOT NULL,
  from_address VARCHAR(320) NOT NULL,
  subject      VARCHAR(300) NULL,
  outcome      VARCHAR(20)  NOT NULL,
  ticket_id    CHAR(36)     NULL,
  detail       VARCHAR(300) NULL,
  received_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_inbound_msg_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_inbound_msg_ticket  FOREIGN KEY (ticket_id)  REFERENCES tickets (id) ON DELETE SET NULL,
  CONSTRAINT uq_inbound_message UNIQUE (company_id, message_id),
  CONSTRAINT inbound_outcome_chk CHECK (outcome IN ('created','replied','rejected_sender','rejected_closed','duplicate'))
) ENGINE=InnoDB;
CREATE INDEX idx_inbound_msg_time ON service_inbound_messages (company_id, received_at);

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- kb.write        write and publish knowledge articles (reading follows audience;
--                 people who work a queue may also write, checked in the domain)
-- change.create   raise change requests
-- change.manage   schedule, implement and close changes of any owner
-- licence.manage  software licences and vendor contracts
-- (asset.read / asset.manage / vendor.manage already exist and are reused.)
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'kb.write'), ('admin', 'kb.write'), ('manager', 'kb.write'),
  ('super_admin', 'change.create'), ('admin', 'change.create'), ('manager', 'change.create'), ('staff', 'change.create'),
  ('super_admin', 'change.manage'), ('admin', 'change.manage'),
  ('super_admin', 'licence.manage'), ('admin', 'licence.manage'),
  ('super_admin', 'licence.read'), ('admin', 'licence.read'), ('manager', 'licence.read'), ('auditor', 'licence.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
