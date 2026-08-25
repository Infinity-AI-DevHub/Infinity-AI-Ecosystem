-- Infinity Workspace :: module schema (mail, calendar, chat, tasks, files, approvals)

-- =============================================================== mail
CREATE TABLE mailboxes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  address     text NOT NULL,
  display_name text NOT NULL,
  type        text NOT NULL DEFAULT 'user' CHECK (type IN ('user','shared','resource')),
  provider_id text,
  provision_state text NOT NULL DEFAULT 'pending'
              CHECK (provision_state IN ('pending','provisioning','ready','failed','disabled')),
  quota_bytes bigint NOT NULL DEFAULT 21474836480,
  used_bytes  bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mailboxes_address_key ON mailboxes (company_id, address);

CREATE TABLE mailbox_delegates (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access     text NOT NULL DEFAULT 'read' CHECK (access IN ('read','send','full')),
  PRIMARY KEY (mailbox_id, user_id)
);

CREATE TABLE mail_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'custom'
             CHECK (kind IN ('inbox','sent','drafts','archive','trash','spam','quarantine','custom')),
  position   integer NOT NULL DEFAULT 100,
  UNIQUE (mailbox_id, name)
);

CREATE TABLE mail_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id  uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  subject     text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 0,
  unread_count  integer NOT NULL DEFAULT 0
);
CREATE INDEX mail_threads_mailbox_idx ON mail_threads (mailbox_id, last_message_at DESC);

CREATE TABLE mail_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mailbox_id    uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder_id     uuid NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  thread_id     uuid REFERENCES mail_threads(id) ON DELETE SET NULL,
  provider_message_id text,
  message_id_header   text,
  in_reply_to   text,
  direction     text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_address  text NOT NULL,
  from_name     text,
  to_addresses  text[] NOT NULL DEFAULT '{}',
  cc_addresses  text[] NOT NULL DEFAULT '{}',
  bcc_addresses text[] NOT NULL DEFAULT '{}',
  subject       text NOT NULL DEFAULT '',
  body_text     text NOT NULL DEFAULT '',
  body_html_sanitized text,
  snippet       text NOT NULL DEFAULT '',
  size_bytes    integer NOT NULL DEFAULT 0,
  is_read       boolean NOT NULL DEFAULT false,
  is_flagged    boolean NOT NULL DEFAULT false,
  is_draft      boolean NOT NULL DEFAULT false,
  labels        text[] NOT NULL DEFAULT '{}',
  delivery_state text NOT NULL DEFAULT 'stored'
                CHECK (delivery_state IN ('draft','queued','sending','sent','delivered','bounced','failed','stored','quarantined')),
  delivery_detail text,
  scan_state    text NOT NULL DEFAULT 'clean' CHECK (scan_state IN ('pending','clean','infected','skipped')),
  retention_until timestamptz,
  version       integer NOT NULL DEFAULT 1,
  sent_at       timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_messages_folder_idx ON mail_messages (folder_id, received_at DESC);
CREATE INDEX mail_messages_mailbox_unread_idx ON mail_messages (mailbox_id) WHERE is_read = false;
CREATE UNIQUE INDEX mail_provider_dedupe_idx ON mail_messages (mailbox_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX mail_messages_search_idx ON mail_messages
  USING gin (to_tsvector('english', subject || ' ' || body_text));

CREATE TABLE mail_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  bigint NOT NULL,
  object_key  text NOT NULL,
  checksum    text,
  scan_state  text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending','clean','infected'))
);

CREATE TABLE mail_signatures (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  body_text  text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================== calendar
CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  capacity   integer NOT NULL DEFAULT 4,
  location   text,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, name)
);

CREATE TABLE calendar_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  organizer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  location      text,
  room_id       uuid REFERENCES rooms(id) ON DELETE SET NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  all_day       boolean NOT NULL DEFAULT false,
  recurrence_rule text,
  recurrence_parent_id uuid REFERENCES calendar_events(id) ON DELETE CASCADE,
  visibility    text NOT NULL DEFAULT 'company' CHECK (visibility IN ('private','company','public')),
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  meeting_room_key text,
  meeting_provider text,
  agenda        text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  reminder_minutes integer NOT NULL DEFAULT 10,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX events_company_time_idx ON calendar_events (company_id, starts_at);
CREATE INDEX events_room_time_idx ON calendar_events (room_id, starts_at) WHERE room_id IS NOT NULL;

CREATE TABLE event_attendees (
  event_id  uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'attendee' CHECK (role IN ('host','attendee','optional')),
  rsvp      text NOT NULL DEFAULT 'needs_action'
            CHECK (rsvp IN ('needs_action','accepted','declined','tentative')),
  responded_at timestamptz,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE meeting_participants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  role       text NOT NULL DEFAULT 'participant' CHECK (role IN ('host','participant'))
);

-- =============================================================== chat
CREATE TABLE chat_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('channel','group','direct')),
  name        text,
  topic       text,
  visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','company')),
  direct_key  text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  last_message_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_direct_key_idx ON chat_rooms (company_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE UNIQUE INDEX chat_channel_name_idx ON chat_rooms (company_id, lower(name)) WHERE type = 'channel';

CREATE TABLE chat_members (
  room_id     uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  read_cursor bigint NOT NULL DEFAULT 0,
  muted       boolean NOT NULL DEFAULT false,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_id  uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
  body       text NOT NULL DEFAULT '',
  mentions   uuid[] NOT NULL DEFAULT '{}',
  file_id    uuid,
  edited_at  timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, seq)
);
CREATE INDEX chat_messages_room_idx ON chat_messages (room_id, seq DESC);
CREATE INDEX chat_messages_search_idx ON chat_messages USING gin (to_tsvector('english', body));

CREATE TABLE chat_reactions (
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE SEQUENCE IF NOT EXISTS chat_room_seq;

-- =============================================================== tasks
CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  key        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','manager','member','viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      integer NOT NULL,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled')),
  priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at      timestamptz,
  start_at    timestamptz,
  labels      text[] NOT NULL DEFAULT '{}',
  checklist   jsonb NOT NULL DEFAULT '[]'::jsonb,
  position    double precision NOT NULL DEFAULT 1000,
  version     integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);

CREATE TABLE task_dependencies (
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

CREATE TABLE task_watchers (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE task_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_activity (
  id         bigserial PRIMARY KEY,
  company_id uuid NOT NULL,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id   uuid,
  field      text NOT NULL,
  before_value text,
  after_value  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================================== files
CREATE TABLE folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES folders(id) ON DELETE CASCADE,
  name       text NOT NULL,
  owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  path       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, path)
);

CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id      uuid REFERENCES folders(id) ON DELETE SET NULL,
  name           text NOT NULL,
  owner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  classification text NOT NULL DEFAULT 'internal'
                 CHECK (classification IN ('public','internal','confidential','restricted')),
  state          text NOT NULL DEFAULT 'processing'
                 CHECK (state IN ('processing','quarantined','active','recycled','legal_hold','expired')),
  current_version integer NOT NULL DEFAULT 0,
  size_bytes     bigint NOT NULL DEFAULT 0,
  mime_type      text NOT NULL DEFAULT 'application/octet-stream',
  recycled_at    timestamptz,
  retention_until timestamptz,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_folder_idx ON files (folder_id) WHERE state = 'active';
CREATE INDEX files_owner_idx ON files (owner_id);

CREATE TABLE file_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  object_key  text NOT NULL,
  size_bytes  bigint NOT NULL,
  checksum    text NOT NULL,
  mime_type   text NOT NULL,
  scan_state  text NOT NULL DEFAULT 'pending' CHECK (scan_state IN ('pending','clean','infected','skipped')),
  scan_detail text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version)
);

CREATE TABLE upload_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     uuid REFERENCES files(id) ON DELETE CASCADE,
  folder_id   uuid REFERENCES folders(id) ON DELETE SET NULL,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  declared_size bigint NOT NULL,
  object_key  text NOT NULL,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','finalizing','complete','aborted')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================== approvals
CREATE TABLE approval_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  form_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  routing     jsonb NOT NULL DEFAULT '[]'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);

CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES approval_definitions(id) ON DELETE RESTRICT,
  reference     text NOT NULL,
  requester_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  amount        numeric(14,2),
  currency      text NOT NULL DEFAULT 'USD',
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','returned','cancelled','expired')),
  current_step  integer NOT NULL DEFAULT 1,
  due_at        timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, reference)
);
CREATE INDEX approvals_status_idx ON approval_requests (company_id, status);

CREATE TABLE approval_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_id  uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  approver_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delegate_of uuid REFERENCES users(id) ON DELETE SET NULL,
  mode        text NOT NULL DEFAULT 'sequential' CHECK (mode IN ('sequential','parallel')),
  state       text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','active','done','skipped')),
  UNIQUE (request_id, step_number, approver_id)
);

-- decisions are immutable history
CREATE TABLE approval_decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_id  uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  approver_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision    text NOT NULL CHECK (decision IN ('approved','rejected','returned')),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- =============================================================== announcements
CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  priority    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','critical')),
  audience    jsonb NOT NULL DEFAULT '{"scope":"company"}'::jsonb,
  requires_ack boolean NOT NULL DEFAULT false,
  publish_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  state       text NOT NULL DEFAULT 'published' CHECK (state IN ('draft','published','withdrawn')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcement_reads (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  PRIMARY KEY (announcement_id, user_id)
);

-- =============================================================== search projection
CREATE TABLE search_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type      text NOT NULL,
  resource_id   uuid NOT NULL,
  title         text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  classification text NOT NULL DEFAULT 'internal',
  acl_user_ids  uuid[] NOT NULL DEFAULT '{}',
  acl_group_ids uuid[] NOT NULL DEFAULT '{}',
  acl_company_wide boolean NOT NULL DEFAULT false,
  link          text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector,
  UNIQUE (doc_type, resource_id)
);
CREATE INDEX search_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX search_acl_users_idx ON search_documents USING gin (acl_user_ids);

CREATE OR REPLACE FUNCTION search_documents_tsv() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A')
          || setweight(to_tsvector('english', coalesce(NEW.body,'')), 'B');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER search_documents_tsv_trg BEFORE INSERT OR UPDATE ON search_documents
  FOR EACH ROW EXECUTE FUNCTION search_documents_tsv();
