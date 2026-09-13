-- Infinity Workspace :: SLA business hours, SLA pausing, honest article view counts
--
-- A target of "4 hours" set on a Friday evening should not expire before Monday morning
-- when the desk only works weekdays. Each SLA policy can now count business minutes on the
-- company's service calendar instead of wall-clock minutes.
--
-- While a ticket waits on its requester (status 'pending') its targets stop. The pause is
-- recorded when it starts; when the ticket leaves 'pending' the due times move out by the
-- paused duration (in the same kind of minutes the policy counts), and the running total
-- is kept so recalculating a target after a priority change still honours earlier pauses.

CREATE TABLE service_business_hours (
  company_id  CHAR(36)    NOT NULL PRIMARY KEY,
  timezone    VARCHAR(64) NOT NULL DEFAULT 'UTC',
  -- {"1":[540,1020], ...}: ISO weekday (1 = Monday) to [start, end] minutes after midnight.
  -- A weekday that is absent is closed.
  schedule    JSON        NOT NULL,
  -- ["2026-12-25", ...]: whole days closed, in the calendar's own timezone.
  holidays    JSON        NOT NULL,
  updated_by  CHAR(36)    NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sbh_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_sbh_user    FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE sla_policies ADD COLUMN use_business_hours TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE tickets ADD COLUMN sla_paused_at DATETIME(3) NULL;
ALTER TABLE tickets ADD COLUMN sla_paused_minutes INT NOT NULL DEFAULT 0;

-- A view counts once per person per day, so re-rendering an article after voting on it,
-- or refreshing it, does not inflate the number.
CREATE TABLE kb_article_views (
  article_id  CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  view_day    DATE     NOT NULL,
  PRIMARY KEY (article_id, user_id, view_day),
  CONSTRAINT fk_kbv_article FOREIGN KEY (article_id) REFERENCES kb_articles (id) ON DELETE CASCADE,
  CONSTRAINT fk_kbv_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;
