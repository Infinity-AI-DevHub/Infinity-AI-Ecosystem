-- Employees may make work; they may not decide who sees it.
--
-- Creating is restored: an employee opening a project and adding tasks to it is ordinary
-- work, and refusing it just moves the request into somebody else's inbox. What stays out
-- of their hands is the audience.
--
-- Visibility in this system comes from two places, and an employee holds neither:
--
--   * `project.manage` — adding and removing project members, which is what decides who
--     can see a project's tasks at all.
--   * `task.share`     — new below. Sharing a task hands it to someone outside the
--     project, a client included. It used to be guarded by `task.update`, so restoring
--     the ability to edit a task would have quietly restored the ability to publish one.
--     Splitting it keeps those two decisions apart.
--
-- Administrators are unaffected: `decide()` already grants them an override on any
-- individual record, and the task listing is corrected in the same change so a project an
-- employee created cannot be invisible to the people accountable for it.
INSERT INTO role_capabilities (role, capability) VALUES
  ('staff', 'project.create'),
  ('staff', 'task.create'),
  ('staff', 'task.update'),

  -- Sharing a task is a separate decision from editing one.
  ('super_admin', 'task.share'),
  ('admin',       'task.share'),
  ('manager',     'task.share')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);

-- Still withheld from employees, and deliberately: the client list is commercial
-- information, and assignment plus membership decide who a piece of work reaches.
DELETE FROM role_capabilities
 WHERE role = 'staff'
   AND capability IN ('external_org.read', 'task.assign');
