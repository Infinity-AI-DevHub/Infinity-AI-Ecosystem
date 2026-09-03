-- What an employee may do.
--
-- Three things were wrong for the staff role.
--
-- 1. `external_org.read` let any employee open the client list: who the clients are,
--    their billing contacts and their addresses. That is commercial information, and
--    reading it is not part of doing the work.
--
-- 2. `task.create` and `task.assign` let an employee invent work and hand it to other
--    people. Deciding what gets done and who does it is the job of whoever runs the
--    project.
--
-- 3. `task.update` is the capability for editing a task's definition — its title, its
--    description, its priority, its due date. An employee needs to move a card across
--    the board, which is a smaller thing, and there was no smaller thing to grant.
--
-- So the update capability is split the way `task.assign` already was. `task.progress`
-- covers status and board position; `task.update` keeps everything that defines what the
-- task actually is. Roles that could edit tasks before can still do both.
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'task.progress'),
  ('admin',       'task.progress'),
  ('manager',     'task.progress'),
  ('staff',       'task.progress')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);

DELETE FROM role_capabilities
 WHERE role = 'staff'
   AND capability IN ('external_org.read', 'task.create', 'task.assign', 'task.update');
