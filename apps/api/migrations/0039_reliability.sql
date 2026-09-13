-- Infinity Workspace :: reliability (Phase 3)
--
-- Services and their health, alert intake from existing monitoring tools, incidents with
-- a timeline and responders, on-call schedules and escalation policies, maintenance
-- windows, status pages and postmortems.
--
-- Workspace does not probe anything. Alerts arrive from the tools that already watch the
-- systems (a signed webhook per integration), or as heartbeats a job sends while it is
-- healthy - a missing heartbeat is the alert. That keeps the server from being a machine
-- that makes outbound requests to addresses someone typed in.
--
-- `services` is the shared catalogue: Phase 4's engineering catalogue extends this table
-- rather than keeping a second list of the same systems.

CREATE TABLE services (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  company_id           CHAR(36)     NOT NULL,
  name                 VARCHAR(160) NOT NULL,
  slug                 VARCHAR(80)  NOT NULL,
  description          TEXT         NULL,
  tier                 VARCHAR(10)  NOT NULL DEFAULT 'standard',
  owner_user_id        CHAR(36)     NULL,
  -- Where incident follow-up tickets land.
  support_queue_id     CHAR(36)     NULL,
  escalation_policy_id CHAR(36)     NULL,
  status               VARCHAR(16)  NOT NULL DEFAULT 'operational',
  status_changed_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_public            TINYINT(1)   NOT NULL DEFAULT 0,
  public_name          VARCHAR(160) NULL,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  created_by           CHAR(36)     NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_service_company FOREIGN KEY (company_id)       REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_owner   FOREIGN KEY (owner_user_id)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_service_queue   FOREIGN KEY (support_queue_id) REFERENCES service_queues (id) ON DELETE SET NULL,
  CONSTRAINT fk_service_creator FOREIGN KEY (created_by)       REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_service_slug UNIQUE (company_id, slug),
  CONSTRAINT service_tier_chk   CHECK (tier IN ('critical','high','standard')),
  CONSTRAINT service_status_chk CHECK (status IN ('operational','degraded','partial_outage','major_outage','maintenance'))
) ENGINE=InnoDB;

-- Every status a service has been in, with when it started and ended: availability is
-- computed from this, not estimated.
CREATE TABLE service_status_history (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  service_id  CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  status      VARCHAR(16) NOT NULL,
  started_at  DATETIME(3) NOT NULL,
  ended_at    DATETIME(3) NULL,
  incident_id CHAR(36)    NULL,
  CONSTRAINT fk_ssh_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_ssh_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_ssh_service_time ON service_status_history (service_id, started_at);

-- ------------------------------------------------------------------- on-call

CREATE TABLE oncall_schedules (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  company_id      CHAR(36)     NOT NULL,
  name            VARCHAR(120) NOT NULL,
  timezone        VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  rotation        VARCHAR(8)   NOT NULL DEFAULT 'weekly',
  -- Local minute of the day the shift changes, and the date the first member starts.
  handoff_minute  INT          NOT NULL DEFAULT 540,
  rotation_start  DATE         NOT NULL,
  -- Ordered member ids; the rotation walks this list.
  members         JSON         NOT NULL,
  created_by      CHAR(36)     NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_oncall_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_oncall_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_oncall_name UNIQUE (company_id, name),
  CONSTRAINT oncall_rotation_chk CHECK (rotation IN ('daily','weekly')),
  CONSTRAINT oncall_handoff_chk  CHECK (handoff_minute >= 0 AND handoff_minute < 1440)
) ENGINE=InnoDB;

CREATE TABLE oncall_overrides (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  schedule_id CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  starts_at   DATETIME(3) NOT NULL,
  ends_at     DATETIME(3) NOT NULL,
  reason      VARCHAR(300) NULL,
  created_by  CHAR(36)    NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_override_schedule FOREIGN KEY (schedule_id) REFERENCES oncall_schedules (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_override_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT override_window_chk CHECK (ends_at > starts_at)
) ENGINE=InnoDB;
CREATE INDEX idx_override_window ON oncall_overrides (schedule_id, starts_at, ends_at);

CREATE TABLE escalation_policies (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  name          VARCHAR(120) NOT NULL,
  -- [{"delayMinutes": 0, "targets": [{"type": "schedule"|"user", "id": "..."}]}, ...]
  levels        JSON         NOT NULL,
  -- How many times the whole policy repeats if nobody acknowledges.
  repeat_count  INT          NOT NULL DEFAULT 1,
  created_by    CHAR(36)     NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_escalation_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_escalation_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_escalation_name UNIQUE (company_id, name),
  CONSTRAINT escalation_repeat_chk CHECK (repeat_count BETWEEN 0 AND 5)
) ENGINE=InnoDB;

ALTER TABLE services ADD CONSTRAINT fk_service_escalation FOREIGN KEY (escalation_policy_id) REFERENCES escalation_policies (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- incidents

CREATE TABLE incident_counters (
  company_id  CHAR(36) NOT NULL PRIMARY KEY,
  next_number INT      NOT NULL DEFAULT 1,
  CONSTRAINT fk_incident_counter_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE incidents (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  company_id           CHAR(36)     NOT NULL,
  number               INT          NOT NULL,
  title                VARCHAR(300) NOT NULL,
  severity             VARCHAR(4)   NOT NULL DEFAULT 'sev3',
  status               VARCHAR(14)  NOT NULL DEFAULT 'investigating',
  summary              TEXT         NULL,
  customer_impact      TEXT         NULL,
  commander_id         CHAR(36)     NULL,
  escalation_policy_id CHAR(36)     NULL,
  -- Escalation progress: which level has been paged, which repeat, and when the next is due.
  escalation_level     INT          NOT NULL DEFAULT 0,
  escalation_round     INT          NOT NULL DEFAULT 0,
  escalation_next_at   DATETIME(3)  NULL,
  acknowledged_at      DATETIME(3)  NULL,
  acknowledged_by      CHAR(36)     NULL,
  detected_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  mitigated_at         DATETIME(3)  NULL,
  resolved_at          DATETIME(3)  NULL,
  source               VARCHAR(10)  NOT NULL DEFAULT 'manual',
  is_public            TINYINT(1)   NOT NULL DEFAULT 0,
  public_title         VARCHAR(300) NULL,
  problem_ticket_id    CHAR(36)     NULL,
  created_by           CHAR(36)     NULL,
  version              INT          NOT NULL DEFAULT 1,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_incident_company    FOREIGN KEY (company_id)           REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_incident_commander  FOREIGN KEY (commander_id)         REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_escalation FOREIGN KEY (escalation_policy_id) REFERENCES escalation_policies (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_ack        FOREIGN KEY (acknowledged_by)      REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_problem    FOREIGN KEY (problem_ticket_id)    REFERENCES tickets (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_creator    FOREIGN KEY (created_by)           REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_incident_number UNIQUE (company_id, number),
  CONSTRAINT incident_severity_chk CHECK (severity IN ('sev1','sev2','sev3','sev4')),
  CONSTRAINT incident_status_chk   CHECK (status IN ('investigating','identified','monitoring','resolved')),
  CONSTRAINT incident_source_chk   CHECK (source IN ('manual','alert','heartbeat'))
) ENGINE=InnoDB;
CREATE INDEX idx_incident_status ON incidents (company_id, status, detected_at);
CREATE INDEX idx_incident_escalation ON incidents (status, escalation_next_at);

CREATE TABLE incident_services (
  incident_id CHAR(36)    NOT NULL,
  service_id  CHAR(36)    NOT NULL,
  impact      VARCHAR(16) NOT NULL DEFAULT 'degraded',
  PRIMARY KEY (incident_id, service_id),
  CONSTRAINT fk_is_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_is_service  FOREIGN KEY (service_id)  REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT incident_impact_chk CHECK (impact IN ('degraded','partial_outage','major_outage'))
) ENGINE=InnoDB;
CREATE INDEX idx_is_service ON incident_services (service_id);

CREATE TABLE incident_responders (
  incident_id  CHAR(36)    NOT NULL,
  user_id      CHAR(36)    NOT NULL,
  role         VARCHAR(20) NOT NULL DEFAULT 'responder',
  paged_at     DATETIME(3) NULL,
  joined_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (incident_id, user_id),
  CONSTRAINT fk_ir_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_ir_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT incident_role_chk CHECK (role IN ('commander','responder','communications','subject_expert'))
) ENGINE=InnoDB;

-- The timeline. 'public' entries are the status updates shown on the status page; nothing
-- becomes public unless someone publishes it as such.
CREATE TABLE incident_events (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  incident_id CHAR(36)     NOT NULL,
  company_id  CHAR(36)     NOT NULL,
  actor_id    CHAR(36)     NULL,
  kind        VARCHAR(30)  NOT NULL,
  body        TEXT         NULL,
  visibility  VARCHAR(8)   NOT NULL DEFAULT 'internal',
  status      VARCHAR(14)  NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ie_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_ie_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT incident_event_visibility_chk CHECK (visibility IN ('internal','public'))
) ENGINE=InnoDB;
CREATE INDEX idx_ie_incident ON incident_events (incident_id, id);

CREATE TABLE incident_tickets (
  incident_id CHAR(36)    NOT NULL,
  ticket_id   CHAR(36)    NOT NULL,
  linked_by   CHAR(36)    NULL,
  linked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (incident_id, ticket_id),
  CONSTRAINT fk_it_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_it_ticket   FOREIGN KEY (ticket_id)   REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_it_user     FOREIGN KEY (linked_by)   REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ alerting

CREATE TABLE alert_integrations (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  company_id           CHAR(36)     NOT NULL,
  service_id           CHAR(36)     NOT NULL,
  name                 VARCHAR(120) NOT NULL,
  kind                 VARCHAR(10)  NOT NULL DEFAULT 'webhook',
  endpoint_key         CHAR(32)     NOT NULL,
  secret_encrypted     TEXT         NOT NULL,
  secret_fingerprint   CHAR(12)     NOT NULL,
  -- Alerts at or above this severity open an incident; NULL records them only.
  incident_severity    VARCHAR(8)   NULL DEFAULT 'critical',
  heartbeat_minutes    INT          NULL,
  last_received_at     DATETIME(3)  NULL,
  heartbeat_missed_at  DATETIME(3)  NULL,
  is_active            TINYINT(1)   NOT NULL DEFAULT 1,
  created_by           CHAR(36)     NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ai_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_ai_key UNIQUE (endpoint_key),
  CONSTRAINT ai_kind_chk CHECK (kind IN ('webhook','heartbeat')),
  CONSTRAINT ai_severity_chk CHECK (incident_severity IS NULL OR incident_severity IN ('critical','warning')),
  CONSTRAINT ai_heartbeat_chk CHECK (heartbeat_minutes IS NULL OR heartbeat_minutes BETWEEN 1 AND 10080)
) ENGINE=InnoDB;

CREATE TABLE alerts (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  company_id      CHAR(36)     NOT NULL,
  integration_id  CHAR(36)     NOT NULL,
  service_id      CHAR(36)     NOT NULL,
  -- The sender's stable identity for "the same alert"; repeats update, not duplicate.
  fingerprint     VARCHAR(200) NOT NULL,
  title           VARCHAR(300) NOT NULL,
  severity        VARCHAR(8)   NOT NULL,
  status          VARCHAR(8)   NOT NULL DEFAULT 'firing',
  first_seen_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at     DATETIME(3)  NULL,
  occurrences     INT          NOT NULL DEFAULT 1,
  incident_id     CHAR(36)     NULL,
  details         TEXT         NULL,
  source_url      VARCHAR(500) NULL,
  suppressed      TINYINT(1)   NOT NULL DEFAULT 0,
  CONSTRAINT fk_alert_company     FOREIGN KEY (company_id)     REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_integration FOREIGN KEY (integration_id) REFERENCES alert_integrations (id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_service     FOREIGN KEY (service_id)     REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_alert_incident    FOREIGN KEY (incident_id)    REFERENCES incidents (id) ON DELETE SET NULL,
  CONSTRAINT alert_severity_chk CHECK (severity IN ('critical','warning','info')),
  CONSTRAINT alert_status_chk   CHECK (status IN ('firing','resolved'))
) ENGINE=InnoDB;
CREATE INDEX idx_alert_open ON alerts (integration_id, fingerprint, status);
CREATE INDEX idx_alert_time ON alerts (company_id, first_seen_at);

-- ---------------------------------------------------------------- maintenance

CREATE TABLE maintenance_windows (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  title       VARCHAR(300) NOT NULL,
  description TEXT         NULL,
  starts_at   DATETIME(3)  NOT NULL,
  ends_at     DATETIME(3)  NOT NULL,
  is_public   TINYINT(1)   NOT NULL DEFAULT 1,
  -- Alerts on the affected services are recorded but do not page anyone during the window.
  suppress_alerts TINYINT(1) NOT NULL DEFAULT 1,
  status      VARCHAR(12)  NOT NULL DEFAULT 'scheduled',
  change_id   CHAR(36)     NULL,
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_mw_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_mw_change  FOREIGN KEY (change_id)  REFERENCES change_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_mw_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT mw_window_chk CHECK (ends_at > starts_at),
  CONSTRAINT mw_status_chk CHECK (status IN ('scheduled','cancelled'))
) ENGINE=InnoDB;
CREATE INDEX idx_mw_time ON maintenance_windows (company_id, starts_at, ends_at);

CREATE TABLE maintenance_services (
  window_id  CHAR(36) NOT NULL,
  service_id CHAR(36) NOT NULL,
  PRIMARY KEY (window_id, service_id),
  CONSTRAINT fk_ms_window  FOREIGN KEY (window_id)  REFERENCES maintenance_windows (id) ON DELETE CASCADE,
  CONSTRAINT fk_ms_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- postmortems

CREATE TABLE postmortems (
  incident_id     CHAR(36)    NOT NULL PRIMARY KEY,
  company_id      CHAR(36)    NOT NULL,
  summary         TEXT        NULL,
  impact          TEXT        NULL,
  root_cause      TEXT        NULL,
  went_well       TEXT        NULL,
  went_wrong      TEXT        NULL,
  lessons         TEXT        NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'draft',
  author_id       CHAR(36)    NULL,
  published_at    DATETIME(3) NULL,
  version         INT         NOT NULL DEFAULT 1,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pm_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_pm_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_pm_author   FOREIGN KEY (author_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT pm_status_chk CHECK (status IN ('draft','published'))
) ENGINE=InnoDB;

CREATE TABLE postmortem_actions (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  incident_id CHAR(36)     NOT NULL,
  company_id  CHAR(36)     NOT NULL,
  title       VARCHAR(300) NOT NULL,
  owner_id    CHAR(36)     NULL,
  task_id     CHAR(36)     NULL,
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pma_incident FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
  CONSTRAINT fk_pma_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_pma_owner    FOREIGN KEY (owner_id)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_pma_task     FOREIGN KEY (task_id)     REFERENCES tasks (id) ON DELETE SET NULL,
  CONSTRAINT fk_pma_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- status page

-- One public status page per company, off until someone turns it on. The slug is global
-- because the page is served without a session: /status/<slug>.
CREATE TABLE status_pages (
  company_id  CHAR(36)     NOT NULL PRIMARY KEY,
  slug        VARCHAR(60)  NOT NULL,
  title       VARCHAR(160) NOT NULL,
  intro       VARCHAR(500) NULL,
  is_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  updated_by  CHAR(36)     NULL,
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sp_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_sp_user    FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_sp_slug UNIQUE (slug)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- reliability.read    see services, incidents, on-call and the internal status page
-- incident.declare    open an incident and join it as a responder
-- incident.manage     run any incident: severity, status, commander, public updates
-- reliability.manage  services, integrations, schedules, escalation, maintenance,
--                     status page configuration
--
-- Responders on an incident can post updates to it without incident.manage; that rule is
-- in the domain.
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'reliability.read'), ('admin', 'reliability.read'), ('manager', 'reliability.read'),
  ('staff', 'reliability.read'), ('auditor', 'reliability.read'),
  ('super_admin', 'incident.declare'), ('admin', 'incident.declare'), ('manager', 'incident.declare'), ('staff', 'incident.declare'),
  ('super_admin', 'incident.manage'), ('admin', 'incident.manage'), ('manager', 'incident.manage'),
  ('super_admin', 'reliability.manage'), ('admin', 'reliability.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
