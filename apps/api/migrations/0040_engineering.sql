-- Infinity Workspace :: engineering (Phase 4)
--
-- The software catalogue extends `services` from Phase 3 rather than keeping a second list
-- of the same systems: one row is both "is it up" and "who owns it, where is the code, how
-- is it deployed".
--
-- Source control is integrated, not rebuilt. GitHub and GitLab send webhooks (signed with a
-- per-connection secret); Workspace records repositories, pull requests and deployments
-- from them. Nothing here clones code or calls the providers' APIs, so no provider token is
-- stored and nothing makes outbound requests to addresses someone typed in.

ALTER TABLE services
  ADD COLUMN kind      VARCHAR(12)  NOT NULL DEFAULT 'service' AFTER tier,
  ADD COLUMN lifecycle VARCHAR(12)  NOT NULL DEFAULT 'production' AFTER kind,
  ADD COLUMN language  VARCHAR(40)  NULL AFTER lifecycle,
  ADD CONSTRAINT service_kind_chk      CHECK (kind IN ('service','website','library','job','data','mobile')),
  ADD CONSTRAINT service_lifecycle_chk CHECK (lifecycle IN ('experimental','production','deprecated'));

-- "A depends on B": an outage in B is a likely cause of trouble in A.
CREATE TABLE service_dependencies (
  service_id    CHAR(36)     NOT NULL,
  depends_on_id CHAR(36)     NOT NULL,
  company_id    CHAR(36)     NOT NULL,
  note          VARCHAR(200) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (service_id, depends_on_id),
  CONSTRAINT fk_sdep_service FOREIGN KEY (service_id)    REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_sdep_target  FOREIGN KEY (depends_on_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_sdep_company FOREIGN KEY (company_id)    REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_sdep_target ON service_dependencies (depends_on_id);

-- Runbooks, docs and dashboards. A runbook may be a knowledge base article, so it is
-- searchable and versioned where the service desk already keeps how-tos.
CREATE TABLE service_links (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  service_id  CHAR(36)     NOT NULL,
  kind        VARCHAR(12)  NOT NULL,
  title       VARCHAR(200) NOT NULL,
  url         VARCHAR(500) NULL,
  article_id  CHAR(36)     NULL,
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_slink_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_slink_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_slink_article FOREIGN KEY (article_id) REFERENCES kb_articles (id) ON DELETE CASCADE,
  CONSTRAINT fk_slink_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT slink_kind_chk   CHECK (kind IN ('runbook','docs','dashboard','design','other')),
  CONSTRAINT slink_target_chk CHECK (url IS NOT NULL OR article_id IS NOT NULL)
) ENGINE=InnoDB;
CREATE INDEX idx_slink_service ON service_links (service_id);

CREATE TABLE service_environments (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  service_id  CHAR(36)     NOT NULL,
  name        VARCHAR(60)  NOT NULL,
  kind        VARCHAR(12)  NOT NULL DEFAULT 'other',
  url         VARCHAR(500) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_senv_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_senv_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT uq_senv_name UNIQUE (service_id, name),
  CONSTRAINT senv_kind_chk CHECK (kind IN ('production','staging','development','other'))
) ENGINE=InnoDB;

-- The API catalogue: what each service exposes, its version and where its spec lives.
CREATE TABLE service_apis (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  service_id  CHAR(36)     NOT NULL,
  name        VARCHAR(160) NOT NULL,
  protocol    VARCHAR(10)  NOT NULL DEFAULT 'rest',
  version     VARCHAR(40)  NULL,
  lifecycle   VARCHAR(12)  NOT NULL DEFAULT 'active',
  visibility  VARCHAR(10)  NOT NULL DEFAULT 'internal',
  description TEXT         NULL,
  spec_url    VARCHAR(500) NULL,
  docs_url    VARCHAR(500) NULL,
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sapi_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_sapi_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_sapi_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_sapi_name UNIQUE (service_id, name, version),
  CONSTRAINT sapi_protocol_chk   CHECK (protocol IN ('rest','graphql','grpc','event','soap','other')),
  CONSTRAINT sapi_lifecycle_chk  CHECK (lifecycle IN ('draft','active','deprecated','retired')),
  CONSTRAINT sapi_visibility_chk CHECK (visibility IN ('internal','partner','public'))
) ENGINE=InnoDB;

-- Onboarding: what a new service must have before it is considered ready, usually seeded
-- from a template.
CREATE TABLE service_checklist (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  service_id  CHAR(36)     NOT NULL,
  title       VARCHAR(200) NOT NULL,
  position    INT          NOT NULL DEFAULT 0,
  done_at     DATETIME(3)  NULL,
  done_by     CHAR(36)     NULL,
  CONSTRAINT fk_scheck_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_scheck_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_scheck_done_by FOREIGN KEY (done_by)    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;
CREATE INDEX idx_scheck_service ON service_checklist (service_id, position);

CREATE TABLE service_templates (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(500) NULL,
  kind         VARCHAR(12)  NOT NULL DEFAULT 'service',
  tier         VARCHAR(10)  NOT NULL DEFAULT 'standard',
  -- JSON arrays of strings: checklist items and environment names to create.
  checklist    JSON         NOT NULL,
  environments JSON         NOT NULL,
  created_by   CHAR(36)     NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_stpl_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_stpl_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_stpl_name UNIQUE (company_id, name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Source control
-- ---------------------------------------------------------------------------

-- One webhook endpoint per connection. GitHub signs the body with the secret
-- (X-Hub-Signature-256); GitLab sends it back as X-Gitlab-Token.
CREATE TABLE scm_connections (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  company_id         CHAR(36)     NOT NULL,
  provider           VARCHAR(8)   NOT NULL,
  name               VARCHAR(120) NOT NULL,
  endpoint_key       CHAR(32)     NOT NULL,
  secret_encrypted   TEXT         NOT NULL,
  secret_fingerprint CHAR(12)     NOT NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  last_received_at   DATETIME(3)  NULL,
  created_by         CHAR(36)     NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_scm_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_scm_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_scm_key UNIQUE (endpoint_key),
  CONSTRAINT scm_provider_chk CHECK (provider IN ('github','gitlab'))
) ENGINE=InnoDB;

-- Delivery ids already processed, so a redelivery or a replayed request is a no-op.
CREATE TABLE scm_deliveries (
  connection_id CHAR(36)    NOT NULL,
  delivery_id   VARCHAR(80) NOT NULL,
  received_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (connection_id, delivery_id),
  CONSTRAINT fk_scmd_connection FOREIGN KEY (connection_id) REFERENCES scm_connections (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_scmd_received ON scm_deliveries (received_at);

-- Repositories appear when their first event arrives; a manager links each to a service.
CREATE TABLE repositories (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  connection_id       CHAR(36)     NULL,
  provider            VARCHAR(8)   NOT NULL,
  full_name           VARCHAR(200) NOT NULL,
  url                 VARCHAR(500) NULL,
  default_branch      VARCHAR(120) NULL,
  service_id          CHAR(36)     NULL,
  last_push_at        DATETIME(3)  NULL,
  last_commit_sha     VARCHAR(64)  NULL,
  last_commit_message VARCHAR(300) NULL,
  last_pusher         VARCHAR(120) NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_repo_company    FOREIGN KEY (company_id)    REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_repo_connection FOREIGN KEY (connection_id) REFERENCES scm_connections (id) ON DELETE SET NULL,
  CONSTRAINT fk_repo_service    FOREIGN KEY (service_id)    REFERENCES services (id) ON DELETE SET NULL,
  CONSTRAINT uq_repo_name UNIQUE (company_id, provider, full_name)
) ENGINE=InnoDB;
CREATE INDEX idx_repo_service ON repositories (service_id);

CREATE TABLE pull_requests (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  repository_id CHAR(36)     NOT NULL,
  number        INT          NOT NULL,
  title         VARCHAR(300) NOT NULL,
  author        VARCHAR(120) NULL,
  state         VARCHAR(8)   NOT NULL,
  url           VARCHAR(500) NULL,
  opened_at     DATETIME(3)  NOT NULL,
  merged_at     DATETIME(3)  NULL,
  closed_at     DATETIME(3)  NULL,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pr_company FOREIGN KEY (company_id)    REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_repo    FOREIGN KEY (repository_id) REFERENCES repositories (id) ON DELETE CASCADE,
  CONSTRAINT uq_pr_number UNIQUE (repository_id, number),
  CONSTRAINT pr_state_chk CHECK (state IN ('open','merged','closed'))
) ENGINE=InnoDB;
CREATE INDEX idx_pr_state ON pull_requests (company_id, state);

CREATE TABLE deployments (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  service_id     CHAR(36)     NOT NULL,
  environment_id CHAR(36)     NOT NULL,
  version        VARCHAR(80)  NULL,
  commit_sha     VARCHAR(64)  NULL,
  status         VARCHAR(12)  NOT NULL,
  source         VARCHAR(8)   NOT NULL DEFAULT 'manual',
  -- Provider deployment id, so status updates for one deployment update one row.
  external_id    VARCHAR(80)  NULL,
  url            VARCHAR(500) NULL,
  notes          VARCHAR(1000) NULL,
  change_id      CHAR(36)     NULL,
  deployed_by    CHAR(36)     NULL,
  external_actor VARCHAR(120) NULL,
  started_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at    DATETIME(3)  NULL,
  CONSTRAINT fk_dep_company FOREIGN KEY (company_id)     REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_dep_service FOREIGN KEY (service_id)     REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_dep_env     FOREIGN KEY (environment_id) REFERENCES service_environments (id) ON DELETE CASCADE,
  CONSTRAINT fk_dep_change  FOREIGN KEY (change_id)      REFERENCES change_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_dep_user    FOREIGN KEY (deployed_by)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_dep_external UNIQUE (company_id, source, external_id),
  CONSTRAINT dep_status_chk CHECK (status IN ('in_progress','succeeded','failed','rolled_back')),
  CONSTRAINT dep_source_chk CHECK (source IN ('manual','github','gitlab'))
) ENGINE=InnoDB;
CREATE INDEX idx_dep_service ON deployments (service_id, started_at);
CREATE INDEX idx_dep_company ON deployments (company_id, started_at);

-- ---------------------------------------------------------------------------
-- Capabilities
--   engineering.read    the catalogue, APIs, repositories, deployments, scorecards
--   engineering.manage  create services, edit any catalogue entry, templates, link repos
--   deployment.record   record a deployment by hand
--   scm.manage          source control connections (they hold webhook secrets)
--
-- A service's owner may edit its catalogue entry without engineering.manage; that rule is
-- in the domain.
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'engineering.read'), ('admin', 'engineering.read'), ('manager', 'engineering.read'),
  ('staff', 'engineering.read'), ('auditor', 'engineering.read'),
  ('super_admin', 'engineering.manage'), ('admin', 'engineering.manage'), ('manager', 'engineering.manage'),
  ('super_admin', 'deployment.record'), ('admin', 'deployment.record'), ('manager', 'deployment.record'), ('staff', 'deployment.record'),
  ('super_admin', 'scm.manage'), ('admin', 'scm.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
