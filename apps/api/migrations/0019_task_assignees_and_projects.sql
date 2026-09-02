-- Multiple assignees per task, and the missing project operations.
--
-- tasks.assignee_id is kept and maintained as the *primary* assignee. It is denormalised
-- on purpose: notifications, the search index and several existing queries read it, and
-- rewriting all of them to aggregate a join is a larger change than this needs. The join
-- table is the truth; the column is the first row of it.

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id     CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  assigned_by CHAR(36)    NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_id, user_id),
  KEY task_assignees_user (user_id),
  CONSTRAINT task_assignees_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_assignees_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT task_assignees_by_fk FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Carry across whoever is already assigned, so nothing appears unassigned after deploy.
INSERT INTO task_assignees (task_id, user_id)
SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL
ON DUPLICATE KEY UPDATE task_id = task_id;

-- ---------------------------------------------------------------------------
-- Projects gain the fields an editable project needs.
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN starts_on DATE NULL AFTER status,
  ADD COLUMN ends_on   DATE NULL AFTER starts_on,
  ADD COLUMN updated_at DATETIME(3) NOT NULL
    DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

-- 'archived' already existed; 'on_hold' is the state people actually use for a project
-- that is paused rather than finished.
ALTER TABLE projects DROP CONSTRAINT projects_status_chk;
ALTER TABLE projects
  ADD CONSTRAINT projects_status_chk CHECK (status IN ('active','on_hold','archived'));
