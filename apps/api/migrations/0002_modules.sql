-- Infinity Workspace :: module schema (calendar, chat, tasks, files, approvals)
-- Employee email lives in a separate application, so there are no mailbox tables.

-- =============================================================== calendar
CREATE TABLE rooms (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  company_id CHAR(36)     NOT NULL,
  name       VARCHAR(160) NOT NULL,
  capacity   INT          NOT NULL DEFAULT 4,
  location   VARCHAR(200) NULL,
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY rooms_company_name (company_id, name),
  CONSTRAINT rooms_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE calendar_events (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  company_id           CHAR(36)     NOT NULL,
  organizer_id         CHAR(36)     NOT NULL,
  title                VARCHAR(300) NOT NULL,
  description          TEXT         NOT NULL,
  location             VARCHAR(300) NULL,
  room_id              CHAR(36)     NULL,
  starts_at            DATETIME(3)  NOT NULL,
  ends_at              DATETIME(3)  NOT NULL,
  timezone             VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  all_day              TINYINT(1)   NOT NULL DEFAULT 0,
  recurrence_rule      VARCHAR(300) NULL,
  recurrence_parent_id CHAR(36)     NULL,
  visibility           VARCHAR(20)  NOT NULL DEFAULT 'company',
  status               VARCHAR(20)  NOT NULL DEFAULT 'confirmed',
  meeting_room_key     VARCHAR(120) NULL,
  meeting_provider     VARCHAR(40)  NULL,
  agenda               TEXT         NOT NULL,
  notes                TEXT         NOT NULL,
  reminder_minutes     INT          NOT NULL DEFAULT 10,
  version              INT          NOT NULL DEFAULT 1,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY events_company_time (company_id, starts_at),
  KEY events_room_time (room_id, starts_at),
  CONSTRAINT events_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT events_organizer_fk FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT events_room_fk FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL,
  CONSTRAINT events_parent_fk FOREIGN KEY (recurrence_parent_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
  CONSTRAINT events_visibility_chk CHECK (visibility IN ('private','company','public')),
  CONSTRAINT events_status_chk CHECK (status IN ('confirmed','cancelled')),
  CONSTRAINT events_time_chk CHECK (ends_at > starts_at)
) ENGINE=InnoDB;

CREATE TABLE event_attendees (
  event_id     CHAR(36)    NOT NULL,
  user_id      CHAR(36)    NOT NULL,
  role         VARCHAR(20) NOT NULL DEFAULT 'attendee',
  rsvp         VARCHAR(20) NOT NULL DEFAULT 'needs_action',
  responded_at DATETIME(3) NULL,
  PRIMARY KEY (event_id, user_id),
  KEY event_attendees_user (user_id),
  CONSTRAINT event_attendees_event_fk FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
  CONSTRAINT event_attendees_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT event_attendees_role_chk CHECK (role IN ('host','attendee','optional')),
  CONSTRAINT event_attendees_rsvp_chk CHECK (rsvp IN ('needs_action','accepted','declined','tentative'))
) ENGINE=InnoDB;

CREATE TABLE meeting_participants (
  id         CHAR(36)    NOT NULL PRIMARY KEY,
  company_id CHAR(36)    NOT NULL,
  event_id   CHAR(36)    NOT NULL,
  user_id    CHAR(36)    NOT NULL,
  joined_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at    DATETIME(3) NULL,
  role       VARCHAR(20) NOT NULL DEFAULT 'participant',
  KEY meeting_participants_event (event_id),
  CONSTRAINT meeting_participants_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT meeting_participants_event_fk FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
  CONSTRAINT meeting_participants_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT meeting_participants_role_chk CHECK (role IN ('host','participant'))
) ENGINE=InnoDB;

-- =============================================================== chat
CREATE TABLE chat_rooms (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  company_id      CHAR(36)     NOT NULL,
  type            VARCHAR(10)  NOT NULL,
  name            VARCHAR(80)  NULL,
  topic           VARCHAR(300) NULL,
  visibility      VARCHAR(20)  NOT NULL DEFAULT 'private',
  direct_key      VARCHAR(80)  NULL,
  created_by      CHAR(36)     NULL,
  archived_at     DATETIME(3)  NULL,
  last_message_at DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Reproduces the PostgreSQL partial unique index on channel names: the generated
  -- column is NULL for non-channels, and MySQL allows repeated NULLs in a unique key.
  channel_key     VARCHAR(80) GENERATED ALWAYS AS
                    (CASE WHEN type = 'channel' THEN LOWER(name) ELSE NULL END) STORED,
  UNIQUE KEY chat_direct_key (company_id, direct_key),
  UNIQUE KEY chat_channel_name (company_id, channel_key),
  CONSTRAINT chat_rooms_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT chat_rooms_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chat_rooms_type_chk CHECK (type IN ('channel','group','direct')),
  CONSTRAINT chat_rooms_visibility_chk CHECK (visibility IN ('private','company'))
) ENGINE=InnoDB;

CREATE TABLE chat_members (
  room_id     CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'member',
  read_cursor BIGINT      NOT NULL DEFAULT 0,
  muted       TINYINT(1)  NOT NULL DEFAULT 0,
  joined_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (room_id, user_id),
  KEY chat_members_user (user_id),
  CONSTRAINT chat_members_room_fk FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
  CONSTRAINT chat_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chat_members_role_chk CHECK (role IN ('owner','moderator','member'))
) ENGINE=InnoDB;

CREATE TABLE chat_messages (
  id         CHAR(36)    NOT NULL PRIMARY KEY,
  company_id CHAR(36)    NOT NULL,
  room_id    CHAR(36)    NOT NULL,
  seq        BIGINT      NOT NULL,
  author_id  CHAR(36)    NULL,
  parent_id  CHAR(36)    NULL,
  body       TEXT        NOT NULL,
  mentions   JSON        NOT NULL,
  file_id    CHAR(36)    NULL,
  edited_at  DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  deleted_by CHAR(36)    NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY chat_messages_room_seq (room_id, seq),
  KEY chat_messages_room (room_id, seq DESC),
  FULLTEXT KEY chat_messages_search (body),
  CONSTRAINT chat_messages_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_room_fk FOREIGN KEY (room_id) REFERENCES chat_rooms(id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chat_messages_parent_fk FOREIGN KEY (parent_id) REFERENCES chat_messages(id) ON DELETE SET NULL,
  CONSTRAINT chat_messages_deleter_fk FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE chat_reactions (
  message_id CHAR(36)    NOT NULL,
  user_id    CHAR(36)    NOT NULL,
  emoji      VARCHAR(16) NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT chat_reactions_message_fk FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  CONSTRAINT chat_reactions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================== tasks
CREATE TABLE projects (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  name        VARCHAR(160) NOT NULL,
  `key`       VARCHAR(10)  NOT NULL,
  description TEXT         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active',
  owner_id    CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY projects_company_key (company_id, `key`),
  CONSTRAINT projects_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT projects_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT projects_status_chk CHECK (status IN ('active','archived'))
) ENGINE=InnoDB;

CREATE TABLE project_members (
  project_id CHAR(36)    NOT NULL,
  user_id    CHAR(36)    NOT NULL,
  role       VARCHAR(20) NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id),
  KEY project_members_user (user_id),
  CONSTRAINT project_members_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT project_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT project_members_role_chk CHECK (role IN ('owner','manager','member','viewer'))
) ENGINE=InnoDB;

CREATE TABLE tasks (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  project_id   CHAR(36)     NOT NULL,
  number       INT          NOT NULL,
  title        VARCHAR(300) NOT NULL,
  description  TEXT         NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'todo',
  priority     VARCHAR(20)  NOT NULL DEFAULT 'medium',
  assignee_id  CHAR(36)     NULL,
  reporter_id  CHAR(36)     NULL,
  due_at       DATETIME(3)  NULL,
  start_at     DATETIME(3)  NULL,
  labels       JSON         NOT NULL,
  checklist    JSON         NOT NULL,
  position     DOUBLE       NOT NULL DEFAULT 1000,
  version      INT          NOT NULL DEFAULT 1,
  completed_at DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY tasks_project_number (project_id, number),
  KEY tasks_project_status (project_id, status),
  KEY tasks_assignee (assignee_id, status),
  CONSTRAINT tasks_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT tasks_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT tasks_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT tasks_reporter_fk FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT tasks_status_chk CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled')),
  CONSTRAINT tasks_priority_chk CHECK (priority IN ('low','medium','high','urgent'))
) ENGINE=InnoDB;

CREATE TABLE task_dependencies (
  task_id    CHAR(36) NOT NULL,
  depends_on CHAR(36) NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  KEY task_dependencies_depends (depends_on),
  CONSTRAINT task_dependencies_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_dependencies_depends_fk FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_dependencies_self_chk CHECK (task_id <> depends_on)
) ENGINE=InnoDB;

CREATE TABLE task_watchers (
  task_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  PRIMARY KEY (task_id, user_id),
  KEY task_watchers_user (user_id),
  CONSTRAINT task_watchers_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_watchers_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE task_comments (
  id         CHAR(36)    NOT NULL PRIMARY KEY,
  company_id CHAR(36)    NOT NULL,
  task_id    CHAR(36)    NOT NULL,
  author_id  CHAR(36)    NULL,
  body       TEXT        NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY task_comments_task (task_id),
  CONSTRAINT task_comments_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT task_comments_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT task_comments_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE task_activity (
  id           BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  company_id   CHAR(36)    NOT NULL,
  task_id      CHAR(36)    NOT NULL,
  actor_id     CHAR(36)    NULL,
  field        VARCHAR(60) NOT NULL,
  before_value TEXT        NULL,
  after_value  TEXT        NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY task_activity_task (task_id, created_at DESC),
  CONSTRAINT task_activity_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================== files
CREATE TABLE folders (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  company_id CHAR(36)     NOT NULL,
  parent_id  CHAR(36)     NULL,
  name       VARCHAR(255) NOT NULL,
  owner_id   CHAR(36)     NULL,
  path       VARCHAR(700) NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY folders_company_path (company_id, path),
  CONSTRAINT folders_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT folders_parent_fk FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
  CONSTRAINT folders_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE files (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  company_id      CHAR(36)     NOT NULL,
  folder_id       CHAR(36)     NULL,
  name            VARCHAR(255) NOT NULL,
  owner_id        CHAR(36)     NULL,
  classification  VARCHAR(20)  NOT NULL DEFAULT 'internal',
  state           VARCHAR(20)  NOT NULL DEFAULT 'processing',
  current_version INT          NOT NULL DEFAULT 0,
  size_bytes      BIGINT       NOT NULL DEFAULT 0,
  mime_type       VARCHAR(200) NOT NULL DEFAULT 'application/octet-stream',
  recycled_at     DATETIME(3)  NULL,
  retention_until DATETIME(3)  NULL,
  version         INT          NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY files_folder (folder_id, state),
  KEY files_owner (owner_id),
  KEY files_state (company_id, state),
  CONSTRAINT files_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT files_folder_fk FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
  CONSTRAINT files_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT files_classification_chk CHECK (classification IN ('public','internal','confidential','restricted')),
  CONSTRAINT files_state_chk CHECK (state IN ('processing','quarantined','active','recycled','legal_hold','expired'))
) ENGINE=InnoDB;

CREATE TABLE file_versions (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  file_id     CHAR(36)     NOT NULL,
  version     INT          NOT NULL,
  object_key  VARCHAR(500) NOT NULL,
  size_bytes  BIGINT       NOT NULL,
  checksum    VARCHAR(64)  NOT NULL,
  mime_type   VARCHAR(200) NOT NULL,
  scan_state  VARCHAR(20)  NOT NULL DEFAULT 'pending',
  scan_detail VARCHAR(300) NULL,
  uploaded_by CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY file_versions_file_version (file_id, version),
  CONSTRAINT file_versions_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT file_versions_file_fk FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  CONSTRAINT file_versions_uploader_fk FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT file_versions_scan_chk CHECK (scan_state IN ('pending','clean','infected','skipped'))
) ENGINE=InnoDB;

CREATE TABLE upload_sessions (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  file_id       CHAR(36)     NULL,
  folder_id     CHAR(36)     NULL,
  filename      VARCHAR(255) NOT NULL,
  mime_type     VARCHAR(200) NOT NULL,
  declared_size BIGINT       NOT NULL,
  object_key    VARCHAR(500) NOT NULL,
  state         VARCHAR(20)  NOT NULL DEFAULT 'open',
  expires_at    DATETIME(3)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT upload_sessions_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_file_fk FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  CONSTRAINT upload_sessions_folder_fk FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL,
  CONSTRAINT upload_sessions_state_chk CHECK (state IN ('open','finalizing','complete','aborted'))
) ENGINE=InnoDB;

-- =============================================================== approvals
CREATE TABLE approval_definitions (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  `key`          VARCHAR(60)  NOT NULL,
  name           VARCHAR(160) NOT NULL,
  schema_version INT          NOT NULL DEFAULT 1,
  form_schema    JSON         NOT NULL,
  routing        JSON         NOT NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY approval_definitions_company_key (company_id, `key`),
  CONSTRAINT approval_definitions_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE approval_requests (
  id            CHAR(36)      NOT NULL PRIMARY KEY,
  company_id    CHAR(36)      NOT NULL,
  definition_id CHAR(36)      NOT NULL,
  reference     VARCHAR(60)   NOT NULL,
  requester_id  CHAR(36)      NOT NULL,
  title         VARCHAR(300)  NOT NULL,
  amount        DECIMAL(14,2) NULL,
  currency      VARCHAR(3)    NOT NULL DEFAULT 'USD',
  data          JSON          NOT NULL,
  status        VARCHAR(20)   NOT NULL DEFAULT 'pending',
  current_step  INT           NOT NULL DEFAULT 1,
  due_at        DATETIME(3)   NULL,
  version       INT           NOT NULL DEFAULT 1,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY approval_requests_reference (company_id, reference),
  KEY approvals_status (company_id, status),
  CONSTRAINT approval_requests_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT approval_requests_definition_fk FOREIGN KEY (definition_id) REFERENCES approval_definitions(id),
  CONSTRAINT approval_requests_requester_fk FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT approval_requests_status_chk CHECK (status IN
    ('pending','approved','rejected','returned','cancelled','expired'))
) ENGINE=InnoDB;

CREATE TABLE approval_steps (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  company_id  CHAR(36)    NOT NULL,
  request_id  CHAR(36)    NOT NULL,
  step_number INT         NOT NULL,
  approver_id CHAR(36)    NOT NULL,
  delegate_of CHAR(36)    NULL,
  mode        VARCHAR(20) NOT NULL DEFAULT 'sequential',
  state       VARCHAR(20) NOT NULL DEFAULT 'waiting',
  UNIQUE KEY approval_steps_unique (request_id, step_number, approver_id),
  CONSTRAINT approval_steps_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT approval_steps_request_fk FOREIGN KEY (request_id) REFERENCES approval_requests(id) ON DELETE CASCADE,
  CONSTRAINT approval_steps_approver_fk FOREIGN KEY (approver_id) REFERENCES users(id),
  CONSTRAINT approval_steps_delegate_fk FOREIGN KEY (delegate_of) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT approval_steps_mode_chk CHECK (mode IN ('sequential','parallel')),
  CONSTRAINT approval_steps_state_chk CHECK (state IN ('waiting','active','done','skipped'))
) ENGINE=InnoDB;

-- Decisions are immutable history.
CREATE TABLE approval_decisions (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  request_id  CHAR(36)     NOT NULL,
  step_number INT          NOT NULL,
  approver_id CHAR(36)     NOT NULL,
  decision    VARCHAR(20)  NOT NULL,
  comment     TEXT         NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY approval_decisions_request (request_id, created_at),
  CONSTRAINT approval_decisions_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT approval_decisions_request_fk FOREIGN KEY (request_id) REFERENCES approval_requests(id) ON DELETE CASCADE,
  CONSTRAINT approval_decisions_approver_fk FOREIGN KEY (approver_id) REFERENCES users(id),
  CONSTRAINT approval_decisions_decision_chk CHECK (decision IN ('approved','rejected','returned'))
) ENGINE=InnoDB;

-- =============================================================== announcements
CREATE TABLE announcements (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  author_id    CHAR(36)     NULL,
  title        VARCHAR(300) NOT NULL,
  body         TEXT         NOT NULL,
  priority     VARCHAR(20)  NOT NULL DEFAULT 'normal',
  audience     JSON         NOT NULL,
  requires_ack TINYINT(1)   NOT NULL DEFAULT 0,
  publish_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3)  NULL,
  state        VARCHAR(20)  NOT NULL DEFAULT 'published',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY announcements_company_state (company_id, state, publish_at),
  CONSTRAINT announcements_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT announcements_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT announcements_priority_chk CHECK (priority IN ('normal','important','critical')),
  CONSTRAINT announcements_state_chk CHECK (state IN ('draft','published','withdrawn'))
) ENGINE=InnoDB;

CREATE TABLE announcement_reads (
  announcement_id CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  read_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  acknowledged_at DATETIME(3) NULL,
  PRIMARY KEY (announcement_id, user_id),
  CONSTRAINT announcement_reads_announcement_fk FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  CONSTRAINT announcement_reads_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================== search projection
CREATE TABLE search_documents (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  company_id       CHAR(36)     NOT NULL,
  doc_type         VARCHAR(20)  NOT NULL,
  resource_id      CHAR(36)     NOT NULL,
  title            VARCHAR(500) NOT NULL,
  body             MEDIUMTEXT   NOT NULL,
  classification   VARCHAR(20)  NOT NULL DEFAULT 'internal',
  acl_user_ids     JSON         NOT NULL,
  acl_group_ids    JSON         NOT NULL,
  acl_company_wide TINYINT(1)   NOT NULL DEFAULT 0,
  link             VARCHAR(500) NULL,
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                     ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY search_documents_resource (doc_type, resource_id),
  KEY search_company (company_id),
  -- Multi-valued index so an ACL membership test can use an index rather than a scan.
  KEY search_acl_users ((CAST(acl_user_ids AS CHAR(36) ARRAY))),
  FULLTEXT KEY search_fulltext (title, body)
) ENGINE=InnoDB;
