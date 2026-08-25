-- Infinity Workspace :: role -> capability baseline (blueprint appendix A)
-- A role grants an action CATEGORY only. Final authorization additionally evaluates
-- tenant, resource membership/ownership, classification, lifecycle and policy conditions.

INSERT INTO role_capabilities (role, capability) VALUES
-- staff: personal work surface
('staff','user.read'),
('staff','mail.read'),('staff','mail.send'),('staff','mail.delete'),
('staff','calendar.read'),('staff','event.create'),('staff','event.update'),('staff','event.cancel'),
('staff','freebusy.read'),
('staff','meeting.join'),
('staff','room.create'),('staff','room.join'),('staff','message.send'),('staff','message.edit'),
('staff','message.delete'),
('staff','task.create'),('staff','task.update'),('staff','task.assign'),
('staff','file.read'),('staff','file.create'),('staff','file.update'),('staff','file.delete'),
('staff','file.share_internal'),
('staff','request.create'),('staff','request.cancel'),
('staff','search.query'),

-- manager: staff plus leadership actions
('manager','user.read'),
('manager','mail.read'),('manager','mail.send'),('manager','mail.delete'),
('manager','calendar.read'),('manager','event.create'),('manager','event.update'),('manager','event.cancel'),
('manager','freebusy.read'),('manager','room.manage'),
('manager','meeting.join'),('manager','meeting.host'),('manager','participant.manage'),
('manager','room.create'),('manager','room.join'),('manager','member.manage'),
('manager','message.send'),('manager','message.edit'),('manager','message.delete'),('manager','moderation.manage'),
('manager','project.create'),('manager','project.manage'),
('manager','task.create'),('manager','task.update'),('manager','task.assign'),('manager','task.delete'),
('manager','report.read'),
('manager','file.read'),('manager','file.create'),('manager','file.update'),('manager','file.delete'),
('manager','file.share_internal'),('manager','file.restore'),
('manager','request.create'),('manager','request.cancel'),('manager','decision.make'),
('manager','delegation.manage'),('manager','approval.report'),
('manager','announcement.create'),
('manager','search.query'),

-- auditor: read-only compliance
('auditor','user.read'),('auditor','audit.read'),('auditor','audit.export'),
('auditor','approval.report'),('auditor','report.read'),('auditor','search.query'),
('auditor','settings.read'),('auditor','backup.view'),

-- admin: everything operational
('admin','user.read'),('admin','user.create'),('admin','user.update'),('admin','user.suspend'),
('admin','user.reactivate'),('admin','role.assign'),('admin','session.revoke'),
('admin','mail.read'),('admin','mail.send'),('admin','mail.delete'),('admin','mailbox.delegate'),
('admin','shared_mailbox.manage'),('admin','quarantine.manage'),
('admin','calendar.read'),('admin','event.create'),('admin','event.update'),('admin','event.cancel'),
('admin','room.manage'),('admin','freebusy.read'),
('admin','meeting.join'),('admin','meeting.host'),('admin','participant.manage'),
('admin','recording.start'),('admin','recording.read'),('admin','transcript.read'),
('admin','room.create'),('admin','room.join'),('admin','member.manage'),('admin','message.send'),
('admin','message.edit'),('admin','message.delete'),('admin','moderation.manage'),
('admin','project.create'),('admin','project.manage'),('admin','task.create'),('admin','task.assign'),
('admin','task.update'),('admin','task.delete'),('admin','report.read'),
('admin','file.read'),('admin','file.create'),('admin','file.update'),('admin','file.delete'),
('admin','file.share_internal'),('admin','file.restore'),('admin','legal_hold.manage'),
('admin','request.create'),('admin','request.cancel'),('admin','decision.make'),
('admin','delegation.manage'),('admin','definition.manage'),('admin','approval.report'),
('admin','announcement.create'),('admin','announcement.manage'),
('admin','settings.read'),('admin','settings.update'),('admin','integration.manage'),
('admin','retention.manage'),('admin','audit.read'),('admin','audit.export'),('admin','backup.view'),
('admin','search.query'),

-- guest: explicitly shared resources only
('guest','file.read'),('guest','message.send'),('guest','room.join'),('guest','meeting.join'),

-- service: machine integration, narrow by token scope
('service','mail.send'),('service','search.query')
ON CONFLICT DO NOTHING;

-- super_admin inherits every admin capability plus platform ownership.
INSERT INTO role_capabilities (role, capability)
SELECT 'super_admin', capability FROM role_capabilities WHERE role = 'admin'
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities (role, capability) VALUES
('super_admin','company.manage'),('super_admin','domain.manage'),('super_admin','superadmin.grant')
ON CONFLICT DO NOTHING;
