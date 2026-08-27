-- Infinity Workspace :: row-level security baseline.
--
-- Application code still performs capability and resource checks first. RLS is the
-- database backstop: any role subject to RLS must carry a transaction-local
-- `infinity.company_id` setting to see or mutate tenant data.

CREATE OR REPLACE FUNCTION infinity_company_id() RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(current_setting('infinity.company_id', true), '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION enable_company_rls(table_name regclass) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (company_id = infinity_company_id())
       WITH CHECK (company_id = infinity_company_id())',
    table_name
  );
END;
$$ LANGUAGE plpgsql;

SELECT enable_company_rls(t::regclass)
FROM unnest(ARRAY[
  'departments',
  'users',
  'invitations',
  'sessions',
  'api_tokens',
  'groups',
  'resource_grants',
  'audit_events',
  'outbox_events',
  'notifications',
  'mailboxes',
  'mail_folders',
  'mail_threads',
  'mail_messages',
  'mail_attachments',
  'mail_signatures',
  'rooms',
  'calendar_events',
  'meeting_participants',
  'chat_rooms',
  'chat_messages',
  'projects',
  'tasks',
  'task_activity',
  'folders',
  'files',
  'file_versions',
  'upload_sessions',
  'approval_definitions',
  'approval_requests',
  'approval_steps',
  'approval_decisions',
  'announcements',
  'search_documents'
]::text[]) AS t;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_self_isolation ON companies;
CREATE POLICY company_self_isolation ON companies
  USING (id = infinity_company_id())
  WITH CHECK (id = infinity_company_id());

ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_tenant_isolation ON identities;
CREATE POLICY identity_tenant_isolation ON identities
  USING (EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = identities.user_id
      AND u.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = identities.user_id
      AND u.company_id = infinity_company_id()
  ));

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS group_member_tenant_isolation ON group_members;
CREATE POLICY group_member_tenant_isolation ON group_members
  USING (EXISTS (
    SELECT 1 FROM groups g
    WHERE g.id = group_members.group_id
      AND g.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM groups g
    WHERE g.id = group_members.group_id
      AND g.company_id = infinity_company_id()
  ));

ALTER TABLE mailbox_delegates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mailbox_delegate_tenant_isolation ON mailbox_delegates;
CREATE POLICY mailbox_delegate_tenant_isolation ON mailbox_delegates
  USING (EXISTS (
    SELECT 1 FROM mailboxes m
    WHERE m.id = mailbox_delegates.mailbox_id
      AND m.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM mailboxes m
    WHERE m.id = mailbox_delegates.mailbox_id
      AND m.company_id = infinity_company_id()
  ));

ALTER TABLE event_attendees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_attendee_tenant_isolation ON event_attendees;
CREATE POLICY event_attendee_tenant_isolation ON event_attendees
  USING (EXISTS (
    SELECT 1 FROM calendar_events e
    WHERE e.id = event_attendees.event_id
      AND e.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calendar_events e
    WHERE e.id = event_attendees.event_id
      AND e.company_id = infinity_company_id()
  ));

ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_member_tenant_isolation ON chat_members;
CREATE POLICY chat_member_tenant_isolation ON chat_members
  USING (EXISTS (
    SELECT 1 FROM chat_rooms r
    WHERE r.id = chat_members.room_id
      AND r.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM chat_rooms r
    WHERE r.id = chat_members.room_id
      AND r.company_id = infinity_company_id()
  ));

ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_reaction_tenant_isolation ON chat_reactions;
CREATE POLICY chat_reaction_tenant_isolation ON chat_reactions
  USING (EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m.id = chat_reactions.message_id
      AND m.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m.id = chat_reactions.message_id
      AND m.company_id = infinity_company_id()
  ));

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_member_tenant_isolation ON project_members;
CREATE POLICY project_member_tenant_isolation ON project_members
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_members.project_id
      AND p.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_members.project_id
      AND p.company_id = infinity_company_id()
  ));

ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_dependency_tenant_isolation ON task_dependencies;
CREATE POLICY task_dependency_tenant_isolation ON task_dependencies
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_dependencies.task_id
      AND t.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_dependencies.task_id
      AND t.company_id = infinity_company_id()
  ));

ALTER TABLE task_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_watcher_tenant_isolation ON task_watchers;
CREATE POLICY task_watcher_tenant_isolation ON task_watchers
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_watchers.task_id
      AND t.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_watchers.task_id
      AND t.company_id = infinity_company_id()
  ));

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_comment_tenant_isolation ON task_comments;
CREATE POLICY task_comment_tenant_isolation ON task_comments
  USING (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_comments.task_id
      AND t.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.id = task_comments.task_id
      AND t.company_id = infinity_company_id()
  ));

ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS announcement_read_tenant_isolation ON announcement_reads;
CREATE POLICY announcement_read_tenant_isolation ON announcement_reads
  USING (EXISTS (
    SELECT 1 FROM announcements a
    WHERE a.id = announcement_reads.announcement_id
      AND a.company_id = infinity_company_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM announcements a
    WHERE a.id = announcement_reads.announcement_id
      AND a.company_id = infinity_company_id()
  ));

DROP FUNCTION enable_company_rls(regclass);
