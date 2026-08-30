-- Infinity Workspace :: employment records and performance.
--
-- The directory knows someone's name, title and manager. It does not know when they
-- joined, on what terms, what they are paid, what was agreed at their last review, or
-- what they are working towards. On a platform that is the company's only system, that
-- means the employment relationship itself lives in a spreadsheet somewhere.

-- Employment history rather than current state, because "what were they on in March"
-- is a question payroll, disputes and audits all ask, and a single row of current values
-- silently loses the answer every time something changes.
CREATE TABLE IF NOT EXISTS employment_records (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  employment_type VARCHAR(30) NOT NULL DEFAULT 'permanent',
  job_title      VARCHAR(160) NOT NULL,
  department_id  CHAR(36)     NULL,
  manager_id     CHAR(36)     NULL,
  effective_from DATE         NOT NULL,
  effective_to   DATE         NULL,
  -- Compensation is encrypted at rest with the same field cipher used elsewhere. It is
  -- the one thing in this system that is sensitive between colleagues rather than only
  -- to outsiders, so a database reader should not get it for free.
  salary_encrypted TEXT       NULL,
  salary_currency CHAR(3)     NOT NULL DEFAULT 'USD',
  salary_period  VARCHAR(20)  NOT NULL DEFAULT 'year',
  weekly_hours   DECIMAL(5,2) NULL,
  probation_ends DATE         NULL,
  change_reason  VARCHAR(300) NULL,
  recorded_by    CHAR(36)     NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY employment_user (user_id, effective_from),
  KEY employment_company (company_id, effective_from),
  CONSTRAINT employment_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT employment_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT employment_department_fk FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
  CONSTRAINT employment_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT employment_recorder_fk FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT employment_type_chk CHECK (employment_type IN ('permanent','fixed_term','contractor','intern','part_time')),
  CONSTRAINT employment_period_chk CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB;

-- A review cycle is the container: "H1 2026", open between two dates, covering everyone
-- or one department. Reviews hang off it so a cycle can be closed as a unit.
CREATE TABLE IF NOT EXISTS review_cycles (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  name         VARCHAR(120) NOT NULL,
  opens_on     DATE         NOT NULL,
  closes_on    DATE         NOT NULL,
  state        VARCHAR(20)  NOT NULL DEFAULT 'draft',
  created_by   CHAR(36)     NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY review_cycles_company (company_id, state),
  CONSTRAINT review_cycles_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT review_cycles_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT review_cycles_state_chk CHECK (state IN ('draft','open','closed')),
  CONSTRAINT review_cycles_period_chk CHECK (closes_on >= opens_on)
) ENGINE=InnoDB;

-- Self-assessment and manager assessment are separate columns on one row rather than two
-- rows, because they are two halves of one conversation and a review with only one half
-- filled in should be visibly incomplete.
CREATE TABLE IF NOT EXISTS performance_reviews (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  cycle_id       CHAR(36)     NOT NULL,
  subject_id     CHAR(36)     NOT NULL,
  reviewer_id    CHAR(36)     NOT NULL,
  self_assessment MEDIUMTEXT  NULL,
  self_submitted_at DATETIME(3) NULL,
  manager_assessment MEDIUMTEXT NULL,
  manager_submitted_at DATETIME(3) NULL,
  rating         VARCHAR(30)  NULL,
  state          VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- Shared is a deliberate third state: a manager writes, then decides when the person
  -- sees it. Without it, either the subject reads half-finished notes or never sees them.
  shared_at      DATETIME(3)  NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY performance_unique (cycle_id, subject_id),
  KEY performance_subject (subject_id),
  KEY performance_reviewer (reviewer_id, state),
  CONSTRAINT performance_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT performance_cycle_fk FOREIGN KEY (cycle_id) REFERENCES review_cycles(id) ON DELETE CASCADE,
  CONSTRAINT performance_subject_fk FOREIGN KEY (subject_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT performance_reviewer_fk FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT performance_state_chk CHECK (state IN ('pending','self_done','manager_done','shared','closed'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS goals (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  user_id      CHAR(36)     NOT NULL,
  cycle_id     CHAR(36)     NULL,
  title        VARCHAR(300) NOT NULL,
  detail       TEXT         NULL,
  -- Progress is a number the person owns; status is the judgement. Keeping them apart
  -- means "80% done but at risk" is expressible, which is the state that matters.
  progress     TINYINT      NOT NULL DEFAULT 0,
  status       VARCHAR(20)  NOT NULL DEFAULT 'active',
  due_on       DATE         NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY goals_user (user_id, status),
  KEY goals_cycle (cycle_id),
  CONSTRAINT goals_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT goals_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT goals_cycle_fk FOREIGN KEY (cycle_id) REFERENCES review_cycles(id) ON DELETE SET NULL,
  CONSTRAINT goals_progress_chk CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT goals_status_chk CHECK (status IN ('active','at_risk','achieved','dropped'))
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  -- Reading your own record needs nothing special; reading everyone's is an HR act.
  ('super_admin', 'hr.read_all'), ('admin', 'hr.read_all'), ('auditor', 'hr.read_all'),
  ('super_admin', 'hr.manage'), ('admin', 'hr.manage'),
  -- Compensation is separated from the rest of the record on purpose: plenty of people
  -- need to see an employment history without seeing what someone earns.
  ('super_admin', 'hr.compensation'), ('admin', 'hr.compensation'),
  ('super_admin', 'review.manage'), ('admin', 'review.manage'),
  ('super_admin', 'review.conduct'), ('admin', 'review.conduct'), ('manager', 'review.conduct'),
  ('super_admin', 'goal.manage'), ('admin', 'goal.manage'),
  ('manager', 'goal.manage'), ('staff', 'goal.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
