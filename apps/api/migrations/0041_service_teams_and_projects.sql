-- Infinity Workspace :: services belong to teams and projects (Phase 4 completion)
--
-- A person owns a service; a team (an existing group) is responsible for it and a project
-- is where its work is planned. Both are optional and clear themselves if the group or
-- project goes away.

ALTER TABLE services
  ADD COLUMN team_group_id CHAR(36) NULL AFTER owner_user_id,
  ADD COLUMN project_id    CHAR(36) NULL AFTER team_group_id,
  ADD CONSTRAINT fk_service_team    FOREIGN KEY (team_group_id) REFERENCES `groups` (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_service_project FOREIGN KEY (project_id)    REFERENCES projects (id) ON DELETE SET NULL;
