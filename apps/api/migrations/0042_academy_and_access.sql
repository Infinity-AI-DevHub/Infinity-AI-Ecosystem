-- Infinity Workspace :: academy and access governance (Phase 5)
--
-- Academy: courses with lessons and an optional quiz, assignments with due dates,
-- certifications (earned from a course or recorded from outside and verified), a skills
-- register, and policies that people must read and acknowledge - again when a new
-- version is published.
--
-- Access governance: a catalogue of the systems people can be given access to, requests
-- that go through the approvals engine, grants that may be temporary, periodic reviews
-- in which owners confirm or revoke each grant, and the follow-up work an offboarding
-- creates.
--
-- Workspace records access; it does not reach into the systems themselves. Each grant
-- and removal is confirmed by the person who carried it out, so the record says what was
-- actually done, not only what was approved.
--
-- Secrets are deliberately absent: see docs/secrets-vault-threat-model.md.

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------
CREATE TABLE skills (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  category    VARCHAR(60)  NULL,
  description VARCHAR(300) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_skill_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT uq_skill_name UNIQUE (company_id, name)
) ENGINE=InnoDB;

-- Level 1 aware, 2 working, 3 practitioner, 4 expert. A manager's confirmation is recorded
-- separately so a self-assessment is never mistaken for a verified one.
CREATE TABLE user_skills (
  user_id     CHAR(36)    NOT NULL,
  skill_id    CHAR(36)    NOT NULL,
  company_id  CHAR(36)    NOT NULL,
  level       TINYINT     NOT NULL,
  source      VARCHAR(8)  NOT NULL DEFAULT 'self',
  verified_by CHAR(36)    NULL,
  verified_at DATETIME(3) NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, skill_id),
  CONSTRAINT fk_uskill_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_uskill_skill    FOREIGN KEY (skill_id)    REFERENCES skills (id) ON DELETE CASCADE,
  CONSTRAINT fk_uskill_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_uskill_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uskill_level_chk  CHECK (level BETWEEN 1 AND 4),
  CONSTRAINT uskill_source_chk CHECK (source IN ('self','course','manager'))
) ENGINE=InnoDB;
CREATE INDEX idx_uskill_skill ON user_skills (skill_id, level);

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------
CREATE TABLE courses (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  company_id         CHAR(36)     NOT NULL,
  title              VARCHAR(200) NOT NULL,
  summary            VARCHAR(500) NULL,
  category           VARCHAR(60)  NULL,
  status             VARCHAR(10)  NOT NULL DEFAULT 'draft',
  -- Percentage needed to pass the quiz; NULL when the course has no quiz.
  pass_mark          TINYINT      NULL,
  -- When set, completing the course issues a certification with this name.
  certification_name VARCHAR(160) NULL,
  validity_months    SMALLINT     NULL,
  owner_id           CHAR(36)     NULL,
  created_by         CHAR(36)     NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_course_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_course_owner   FOREIGN KEY (owner_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_course_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT course_status_chk   CHECK (status IN ('draft','published','archived')),
  CONSTRAINT course_passmark_chk CHECK (pass_mark IS NULL OR pass_mark BETWEEN 1 AND 100)
) ENGINE=InnoDB;
CREATE FULLTEXT INDEX ft_course ON courses (title, summary);

CREATE TABLE course_lessons (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  course_id   CHAR(36)     NOT NULL,
  position    INT          NOT NULL DEFAULT 0,
  title       VARCHAR(200) NOT NULL,
  body        MEDIUMTEXT   NOT NULL,
  video_url   VARCHAR(500) NULL,
  minutes     SMALLINT     NOT NULL DEFAULT 5,
  CONSTRAINT fk_lesson_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_lesson_course ON course_lessons (course_id, position);

CREATE TABLE course_questions (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  course_id     CHAR(36)     NOT NULL,
  position      INT          NOT NULL DEFAULT 0,
  prompt        VARCHAR(500) NOT NULL,
  options       JSON         NOT NULL,
  correct_index TINYINT      NOT NULL,
  CONSTRAINT fk_question_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Skills a course develops, and the level completing it confirms.
CREATE TABLE course_skills (
  course_id CHAR(36) NOT NULL,
  skill_id  CHAR(36) NOT NULL,
  level     TINYINT  NOT NULL DEFAULT 2,
  PRIMARY KEY (course_id, skill_id),
  CONSTRAINT fk_cskill_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE,
  CONSTRAINT fk_cskill_skill  FOREIGN KEY (skill_id)  REFERENCES skills (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One enrolment per person per course. Retaking an expired certification reopens it.
CREATE TABLE enrolments (
  id            CHAR(36)    NOT NULL PRIMARY KEY,
  company_id    CHAR(36)    NOT NULL,
  course_id     CHAR(36)    NOT NULL,
  user_id       CHAR(36)    NOT NULL,
  source        VARCHAR(8)  NOT NULL DEFAULT 'self',
  assigned_by   CHAR(36)    NULL,
  due_at        DATETIME(3) NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'in_progress',
  score         TINYINT     NULL,
  attempts      SMALLINT    NOT NULL DEFAULT 0,
  started_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at  DATETIME(3) NULL,
  reminded_at   DATETIME(3) NULL,
  CONSTRAINT fk_enrol_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_enrol_course   FOREIGN KEY (course_id)   REFERENCES courses (id) ON DELETE CASCADE,
  CONSTRAINT fk_enrol_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_enrol_assigner FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_enrol UNIQUE (course_id, user_id),
  CONSTRAINT enrol_status_chk CHECK (status IN ('in_progress','completed')),
  CONSTRAINT enrol_source_chk CHECK (source IN ('self','assigned'))
) ENGINE=InnoDB;
CREATE INDEX idx_enrol_user ON enrolments (user_id, status);

CREATE TABLE lesson_progress (
  enrolment_id CHAR(36)    NOT NULL,
  lesson_id    CHAR(36)    NOT NULL,
  completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (enrolment_id, lesson_id),
  CONSTRAINT fk_lprog_enrol  FOREIGN KEY (enrolment_id) REFERENCES enrolments (id) ON DELETE CASCADE,
  CONSTRAINT fk_lprog_lesson FOREIGN KEY (lesson_id)    REFERENCES course_lessons (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE quiz_attempts (
  id           CHAR(36)    NOT NULL PRIMARY KEY,
  enrolment_id CHAR(36)    NOT NULL,
  score        TINYINT     NOT NULL,
  passed       TINYINT(1)  NOT NULL,
  answers      JSON        NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_attempt_enrol FOREIGN KEY (enrolment_id) REFERENCES enrolments (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Earned from a course, or recorded from outside (a vendor exam) and verified by a manager.
CREATE TABLE certifications (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  course_id      CHAR(36)     NULL,
  name           VARCHAR(160) NOT NULL,
  issuer         VARCHAR(120) NULL,
  credential_url VARCHAR(500) NULL,
  issued_at      DATETIME(3)  NOT NULL,
  expires_at     DATETIME(3)  NULL,
  source         VARCHAR(8)   NOT NULL,
  verified_by    CHAR(36)     NULL,
  verified_at    DATETIME(3)  NULL,
  reminded_at    DATETIME(3)  NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_cert_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_cert_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_cert_course   FOREIGN KEY (course_id)   REFERENCES courses (id) ON DELETE SET NULL,
  CONSTRAINT fk_cert_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT cert_source_chk CHECK (source IN ('course','external'))
) ENGINE=InnoDB;
CREATE INDEX idx_cert_user ON certifications (user_id, expires_at);
CREATE INDEX idx_cert_expiry ON certifications (company_id, expires_at);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
CREATE TABLE policies (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  company_id      CHAR(36)     NOT NULL,
  title           VARCHAR(200) NOT NULL,
  category        VARCHAR(60)  NULL,
  status          VARCHAR(10)  NOT NULL DEFAULT 'draft',
  current_version INT          NULL,
  -- NULL means everyone employed; otherwise members of the group.
  audience_group_id CHAR(36)   NULL,
  ack_due_days    SMALLINT     NOT NULL DEFAULT 14,
  owner_id        CHAR(36)     NULL,
  draft_body      MEDIUMTEXT   NULL,
  created_by      CHAR(36)     NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_policy_company  FOREIGN KEY (company_id)        REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_policy_group    FOREIGN KEY (audience_group_id) REFERENCES `groups` (id) ON DELETE SET NULL,
  CONSTRAINT fk_policy_owner    FOREIGN KEY (owner_id)          REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_policy_creator  FOREIGN KEY (created_by)        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT policy_status_chk CHECK (status IN ('draft','published','retired'))
) ENGINE=InnoDB;

-- Published text is immutable: an acknowledgement is of exactly these words.
CREATE TABLE policy_versions (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  policy_id    CHAR(36)     NOT NULL,
  version      INT          NOT NULL,
  body         MEDIUMTEXT   NOT NULL,
  change_note  VARCHAR(500) NULL,
  published_by CHAR(36)     NULL,
  published_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pver_policy    FOREIGN KEY (policy_id)    REFERENCES policies (id) ON DELETE CASCADE,
  CONSTRAINT fk_pver_publisher FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_pver UNIQUE (policy_id, version)
) ENGINE=InnoDB;

CREATE TABLE policy_acknowledgements (
  version_id      CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  company_id      CHAR(36)    NOT NULL,
  acknowledged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ip              VARCHAR(64) NULL,
  PRIMARY KEY (version_id, user_id),
  CONSTRAINT fk_pack_version FOREIGN KEY (version_id) REFERENCES policy_versions (id) ON DELETE CASCADE,
  CONSTRAINT fk_pack_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_pack_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE INDEX idx_pack_user ON policy_acknowledgements (user_id);

-- ---------------------------------------------------------------------------
-- Access governance
-- ---------------------------------------------------------------------------
CREATE TABLE access_resources (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  company_id         CHAR(36)     NOT NULL,
  name               VARCHAR(160) NOT NULL,
  description        VARCHAR(1000) NULL,
  kind               VARCHAR(16)  NOT NULL DEFAULT 'application',
  -- JSON array of role names people can be given, e.g. ["Viewer","Admin"].
  roles              JSON         NOT NULL,
  risk               VARCHAR(8)   NOT NULL DEFAULT 'medium',
  -- The person who approves requests and carries out grants and removals.
  owner_id           CHAR(36)     NULL,
  service_id         CHAR(36)     NULL,
  -- Longest grant allowed, in days; NULL allows permanent access.
  max_days           SMALLINT     NULL,
  -- A course that must have been completed (and not expired) before access is requested.
  required_course_id CHAR(36)     NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_by         CHAR(36)     NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ares_company FOREIGN KEY (company_id)         REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_ares_owner   FOREIGN KEY (owner_id)           REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ares_service FOREIGN KEY (service_id)         REFERENCES services (id) ON DELETE SET NULL,
  CONSTRAINT fk_ares_course  FOREIGN KEY (required_course_id) REFERENCES courses (id) ON DELETE SET NULL,
  CONSTRAINT fk_ares_creator FOREIGN KEY (created_by)         REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_ares_name UNIQUE (company_id, name),
  CONSTRAINT ares_kind_chk CHECK (kind IN ('application','infrastructure','data','physical','other')),
  CONSTRAINT ares_risk_chk CHECK (risk IN ('low','medium','high'))
) ENGINE=InnoDB;

CREATE TABLE access_requests (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  company_id          CHAR(36)     NOT NULL,
  number              INT          NOT NULL,
  resource_id         CHAR(36)     NOT NULL,
  role                VARCHAR(60)  NOT NULL,
  requester_id        CHAR(36)     NOT NULL,
  user_id             CHAR(36)     NOT NULL,
  justification       VARCHAR(1000) NOT NULL,
  -- NULL for permanent access.
  duration_days       SMALLINT     NULL,
  status              VARCHAR(10)  NOT NULL DEFAULT 'pending',
  approval_request_id CHAR(36)     NULL,
  grant_id            CHAR(36)     NULL,
  decided_at          DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_areq_company   FOREIGN KEY (company_id)          REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_areq_resource  FOREIGN KEY (resource_id)         REFERENCES access_resources (id) ON DELETE CASCADE,
  CONSTRAINT fk_areq_requester FOREIGN KEY (requester_id)        REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_areq_user      FOREIGN KEY (user_id)             REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_areq_approval  FOREIGN KEY (approval_request_id) REFERENCES approval_requests (id) ON DELETE SET NULL,
  CONSTRAINT uq_areq_number UNIQUE (company_id, number),
  CONSTRAINT areq_status_chk CHECK (status IN ('pending','approved','rejected','cancelled'))
) ENGINE=InnoDB;
CREATE INDEX idx_areq_user ON access_requests (user_id, status);

CREATE TABLE access_grants (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  company_id           CHAR(36)     NOT NULL,
  resource_id          CHAR(36)     NOT NULL,
  role                 VARCHAR(60)  NOT NULL,
  user_id              CHAR(36)     NOT NULL,
  -- pending_grant: approved, not yet set up in the system
  -- active: confirmed as set up
  -- pending_removal: must be taken away (expired, revoked in review, offboarded)
  -- removed: confirmed as taken away
  status               VARCHAR(16)  NOT NULL DEFAULT 'pending_grant',
  source               VARCHAR(10)  NOT NULL DEFAULT 'request',
  request_id           CHAR(36)     NULL,
  granted_by           CHAR(36)     NULL,
  expires_at           DATETIME(3)  NULL,
  provisioned_at       DATETIME(3)  NULL,
  provisioned_by       CHAR(36)     NULL,
  removal_reason       VARCHAR(20)  NULL,
  removal_note         VARCHAR(500) NULL,
  removal_requested_at DATETIME(3)  NULL,
  removed_at           DATETIME(3)  NULL,
  removed_by           CHAR(36)     NULL,
  expiry_reminded_at   DATETIME(3)  NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_agrant_company     FOREIGN KEY (company_id)     REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_agrant_resource    FOREIGN KEY (resource_id)    REFERENCES access_resources (id) ON DELETE CASCADE,
  CONSTRAINT fk_agrant_user        FOREIGN KEY (user_id)        REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_agrant_request     FOREIGN KEY (request_id)     REFERENCES access_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_agrant_granted_by  FOREIGN KEY (granted_by)     REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_agrant_provisioner FOREIGN KEY (provisioned_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_agrant_remover     FOREIGN KEY (removed_by)     REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT agrant_status_chk CHECK (status IN ('pending_grant','active','pending_removal','removed')),
  CONSTRAINT agrant_source_chk CHECK (source IN ('request','manual')),
  CONSTRAINT agrant_reason_chk CHECK (removal_reason IS NULL OR removal_reason IN ('expired','review','revoked','offboarding','superseded','declined'))
) ENGINE=InnoDB;
CREATE INDEX idx_agrant_user ON access_grants (user_id, status);
CREATE INDEX idx_agrant_resource ON access_grants (resource_id, status);
CREATE INDEX idx_agrant_expiry ON access_grants (company_id, status, expires_at);

ALTER TABLE access_requests ADD CONSTRAINT fk_areq_grant FOREIGN KEY (grant_id) REFERENCES access_grants (id) ON DELETE SET NULL;

CREATE TABLE access_reviews (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  name        VARCHAR(160) NOT NULL,
  -- NULL reviews every resource.
  resource_id CHAR(36)     NULL,
  due_at      DATETIME(3)  NOT NULL,
  status      VARCHAR(8)   NOT NULL DEFAULT 'open',
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at   DATETIME(3)  NULL,
  CONSTRAINT fk_arev_company  FOREIGN KEY (company_id)  REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_arev_resource FOREIGN KEY (resource_id) REFERENCES access_resources (id) ON DELETE CASCADE,
  CONSTRAINT fk_arev_creator  FOREIGN KEY (created_by)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT arev_status_chk CHECK (status IN ('open','closed'))
) ENGINE=InnoDB;

CREATE TABLE access_review_items (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  review_id   CHAR(36)     NOT NULL,
  grant_id    CHAR(36)     NOT NULL,
  reviewer_id CHAR(36)     NULL,
  decision    VARCHAR(8)   NULL,
  note        VARCHAR(500) NULL,
  decided_at  DATETIME(3)  NULL,
  CONSTRAINT fk_aritem_review   FOREIGN KEY (review_id)   REFERENCES access_reviews (id) ON DELETE CASCADE,
  CONSTRAINT fk_aritem_grant    FOREIGN KEY (grant_id)    REFERENCES access_grants (id) ON DELETE CASCADE,
  CONSTRAINT fk_aritem_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_aritem UNIQUE (review_id, grant_id),
  CONSTRAINT aritem_decision_chk CHECK (decision IS NULL OR decision IN ('keep','revoke'))
) ENGINE=InnoDB;
CREATE INDEX idx_aritem_reviewer ON access_review_items (reviewer_id, decision);

-- The follow-up work a departure creates: access to take away, equipment to collect, and
-- anything else the person offboarding adds.
CREATE TABLE offboarding_tasks (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  offboarding_id CHAR(36)     NOT NULL,
  kind           VARCHAR(8)   NOT NULL,
  title          VARCHAR(300) NOT NULL,
  reference_id   CHAR(36)     NULL,
  assignee_id    CHAR(36)     NULL,
  done_at        DATETIME(3)  NULL,
  done_by        CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_obt_company     FOREIGN KEY (company_id)     REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_obt_offboarding FOREIGN KEY (offboarding_id) REFERENCES offboardings (id) ON DELETE CASCADE,
  CONSTRAINT fk_obt_assignee    FOREIGN KEY (assignee_id)    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_obt_done_by     FOREIGN KEY (done_by)        REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_obt_reference UNIQUE (offboarding_id, kind, reference_id),
  CONSTRAINT obt_kind_chk CHECK (kind IN ('access','asset','custom'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Capabilities
--   academy.learn     take courses, record skills and outside certifications, read and
--                     acknowledge policies (every employee)
--   academy.manage    author courses, assign training, verify skills and certifications
--   policy.manage     write, publish and retire policies; see acknowledgement coverage
--   access.request    ask for access for yourself or someone you manage
--   access.manage     the access catalogue, reviews, manual grants and revocation
--   access.audit      read every grant, request, review and offboarding (auditors)
--
-- Resource owners approve requests and confirm grants for their own resources without
-- access.manage; that rule is in the domain.
-- ---------------------------------------------------------------------------
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'academy.learn'), ('admin', 'academy.learn'), ('manager', 'academy.learn'), ('staff', 'academy.learn'), ('auditor', 'academy.learn'),
  ('super_admin', 'academy.manage'), ('admin', 'academy.manage'), ('manager', 'academy.manage'),
  ('super_admin', 'policy.manage'), ('admin', 'policy.manage'),
  ('super_admin', 'access.request'), ('admin', 'access.request'), ('manager', 'access.request'), ('staff', 'access.request'),
  ('super_admin', 'access.manage'), ('admin', 'access.manage'),
  ('super_admin', 'access.audit'), ('admin', 'access.audit'), ('auditor', 'access.audit')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
