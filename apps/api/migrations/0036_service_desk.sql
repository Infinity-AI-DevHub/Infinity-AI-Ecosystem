-- Infinity Workspace :: service desk (Phase 2)
--
-- One ticket model serves both the internal employee helpdesk and client support: the
-- requester is always a user, and a client requester is a guest whose organisation is
-- recorded on the ticket. Queues decide who works a ticket; SLA policies decide how fast.
--
-- Who may work a ticket is decided by queue membership, not by access level. A technician
-- is ordinarily a staff account, and giving every staff account the whole desk would put
-- HR and finance requests in front of everyone. `ticket.work` exists for the roles that
-- oversee every queue.
--
-- References to people and queues cascade. Neither is ever hard-deleted in normal use
-- (people are offboarded, queues deactivated), so the only DELETE that reaches them is a
-- whole-tenant removal - which RESTRICT would block outright. See 0005.
--
-- Portable across MySQL 8 and MariaDB 10.4+: no generated columns, no JSON functions in
-- constraints, CHECK constraints only where both engines enforce or ignore them safely.

CREATE TABLE service_queues (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  name                VARCHAR(120) NOT NULL,
  description         TEXT         NULL,
  -- 'internal' queues take employee requests; 'client' queues are offered in the portal.
  audience            VARCHAR(12)  NOT NULL DEFAULT 'internal',
  -- Told when a ticket in this queue breaches its resolution target.
  escalation_user_id  CHAR(36)     NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_by          CHAR(36)     NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_service_queue_company    FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_queue_escalation FOREIGN KEY (escalation_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_service_queue_name UNIQUE (company_id, name),
  CONSTRAINT service_queue_audience_chk CHECK (audience IN ('internal','client'))
) ENGINE=InnoDB;

CREATE TABLE service_queue_members (
  queue_id    CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  added_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (queue_id, user_id),
  CONSTRAINT fk_sqm_queue   FOREIGN KEY (queue_id)   REFERENCES service_queues (id) ON DELETE CASCADE,
  CONSTRAINT fk_sqm_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sqm_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_sqm_user ON service_queue_members (user_id, company_id);

CREATE TABLE service_categories (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  queue_id    CHAR(36)     NOT NULL,
  name        VARCHAR(120) NOT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_service_category_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_category_queue   FOREIGN KEY (queue_id)   REFERENCES service_queues (id) ON DELETE CASCADE,
  CONSTRAINT uq_service_category UNIQUE (queue_id, name)
) ENGINE=InnoDB;

-- One target per priority per company. Minutes are wall-clock minutes; business hours
-- are not modelled yet and the UI says so.
CREATE TABLE sla_policies (
  id                      CHAR(36)    NOT NULL PRIMARY KEY,
  company_id              CHAR(36)    NOT NULL,
  priority                VARCHAR(10) NOT NULL,
  first_response_minutes  INT         NOT NULL,
  resolution_minutes      INT         NOT NULL,
  updated_by              CHAR(36)    NULL,
  updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sla_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT uq_sla_priority UNIQUE (company_id, priority),
  CONSTRAINT sla_priority_chk CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT sla_minutes_chk CHECK (first_response_minutes > 0 AND resolution_minutes >= first_response_minutes)
) ENGINE=InnoDB;

-- Ticket numbers are per company and gap-free enough to read aloud: SD-1042.
CREATE TABLE ticket_counters (
  company_id   CHAR(36) NOT NULL PRIMARY KEY,
  next_number  INT      NOT NULL DEFAULT 1,
  CONSTRAINT fk_ticket_counter_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE tickets (
  id                         CHAR(36)     NOT NULL PRIMARY KEY,
  company_id                 CHAR(36)     NOT NULL,
  number                     INT          NOT NULL,
  subject                    VARCHAR(300) NOT NULL,
  description                TEXT         NOT NULL,
  type                       VARCHAR(12)  NOT NULL DEFAULT 'request',
  status                     VARCHAR(12)  NOT NULL DEFAULT 'new',
  priority                   VARCHAR(10)  NOT NULL DEFAULT 'normal',
  channel                    VARCHAR(10)  NOT NULL DEFAULT 'workspace',
  queue_id                   CHAR(36)     NOT NULL,
  category_id                CHAR(36)     NULL,
  requester_id               CHAR(36)     NOT NULL,
  client_org_id              CHAR(36)     NULL,
  assignee_id                CHAR(36)     NULL,
  task_id                    CHAR(36)     NULL,
  first_response_due_at      DATETIME(3)  NULL,
  resolution_due_at          DATETIME(3)  NULL,
  first_responded_at         DATETIME(3)  NULL,
  resolved_at                DATETIME(3)  NULL,
  closed_at                  DATETIME(3)  NULL,
  response_breached_at       DATETIME(3)  NULL,
  resolution_breached_at     DATETIME(3)  NULL,
  version                    INT          NOT NULL DEFAULT 1,
  created_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ticket_company   FOREIGN KEY (company_id)    REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_queue     FOREIGN KEY (queue_id)      REFERENCES service_queues (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_category  FOREIGN KEY (category_id)   REFERENCES service_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_requester FOREIGN KEY (requester_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_client    FOREIGN KEY (client_org_id) REFERENCES external_organizations (id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_assignee  FOREIGN KEY (assignee_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_task      FOREIGN KEY (task_id)       REFERENCES tasks (id) ON DELETE SET NULL,
  CONSTRAINT uq_ticket_number UNIQUE (company_id, number),
  CONSTRAINT ticket_type_chk     CHECK (type IN ('incident','request','question','problem')),
  CONSTRAINT ticket_status_chk   CHECK (status IN ('new','open','pending','resolved','closed')),
  CONSTRAINT ticket_priority_chk CHECK (priority IN ('low','normal','high','urgent')),
  CONSTRAINT ticket_channel_chk  CHECK (channel IN ('workspace','portal','email'))
) ENGINE=InnoDB;
CREATE INDEX idx_ticket_queue_status ON tickets (company_id, queue_id, status);
CREATE INDEX idx_ticket_assignee     ON tickets (company_id, assignee_id, status);
CREATE INDEX idx_ticket_requester    ON tickets (company_id, requester_id, created_at);
CREATE INDEX idx_ticket_client       ON tickets (company_id, client_org_id, created_at);
CREATE INDEX idx_ticket_sla          ON tickets (status, resolution_due_at);

-- Conversation. 'public' is seen by the requester (including a client in the portal);
-- 'internal' is seen only by people who can work the ticket.
CREATE TABLE ticket_comments (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  ticket_id   CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  author_id   CHAR(36)    NOT NULL,
  visibility  VARCHAR(10) NOT NULL DEFAULT 'public',
  body        TEXT        NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ticket_comment_ticket  FOREIGN KEY (ticket_id)  REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_comment_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_comment_author  FOREIGN KEY (author_id)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ticket_comment_visibility_chk CHECK (visibility IN ('public','internal'))
) ENGINE=InnoDB;
CREATE INDEX idx_ticket_comment_ticket ON ticket_comments (ticket_id, created_at);

-- Files attached to a ticket. The bytes live in the files domain, which scans them.
CREATE TABLE ticket_attachments (
  ticket_id   CHAR(36)    NOT NULL,
  file_id     CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  visibility  VARCHAR(10) NOT NULL DEFAULT 'public',
  added_by    CHAR(36)    NOT NULL,
  added_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket_id, file_id),
  CONSTRAINT fk_ticket_attachment_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_attachment_file   FOREIGN KEY (file_id)   REFERENCES files (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_attachment_user   FOREIGN KEY (added_by)  REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ticket_attachment_visibility_chk CHECK (visibility IN ('public','internal'))
) ENGINE=InnoDB;

-- The timeline: every change of state, who made it, from what to what.
CREATE TABLE ticket_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id   CHAR(36)     NOT NULL,
  company_id  CHAR(36)     NOT NULL,
  actor_id    CHAR(36)     NULL,
  kind        VARCHAR(40)  NOT NULL,
  from_value  VARCHAR(300) NULL,
  to_value    VARCHAR(300) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ticket_event_ticket  FOREIGN KEY (ticket_id)  REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_event_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_ticket_event_ticket ON ticket_events (ticket_id, id);

-- Satisfaction, given once by the requester after resolution.
CREATE TABLE ticket_feedback (
  ticket_id   CHAR(36)    NOT NULL PRIMARY KEY,
  company_id  CHAR(36)    NOT NULL,
  rating      TINYINT     NOT NULL,
  comment     TEXT        NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ticket_feedback_ticket  FOREIGN KEY (ticket_id)  REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_feedback_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT ticket_feedback_rating_chk CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- ticket.create  raise a request (every employee role)
-- ticket.read    see every ticket in the company (oversight and audit)
-- ticket.work    work every queue without being a member of it
-- service.manage configure queues, members, categories and SLA targets
--
-- Clients raise tickets through the portal with the portal.read they already hold,
-- scoped to their own organisation in the domain.
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'ticket.create'), ('admin', 'ticket.create'), ('manager', 'ticket.create'),
  ('staff', 'ticket.create'),       ('auditor', 'ticket.create'),
  ('super_admin', 'ticket.read'),   ('admin', 'ticket.read'),   ('auditor', 'ticket.read'),
  ('super_admin', 'ticket.work'),   ('admin', 'ticket.work'),
  ('super_admin', 'service.manage'), ('admin', 'service.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
