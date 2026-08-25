-- Infinity Workspace :: baseline schema (blueprint section 07)
-- Rules: stable uuid pk, company_id tenant scope, timestamps, version column
-- wherever concurrent edits are possible, explicit lifecycle states over soft delete.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================== tenancy
CREATE TABLE companies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  verified_domains text[] NOT NULL DEFAULT '{}',
  region           text NOT NULL DEFAULT 'primary',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  parent_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

-- =============================================================== identity
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         text NOT NULL,               -- stored lower-cased
  email_display text NOT NULL,               -- original casing preserved
  display_name  text NOT NULL,
  legal_name    text,
  title         text,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  manager_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  access_level  text NOT NULL DEFAULT 'staff'
                CHECK (access_level IN ('super_admin','admin','manager','staff','auditor','guest','service')),
  status        text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','active','suspended','offboarded')),
  locale        text NOT NULL DEFAULT 'en',
  timezone      text NOT NULL DEFAULT 'UTC',
  phone         text,
  avatar_color  text NOT NULL DEFAULT '#f2c14e',
  modules       text[] NOT NULL DEFAULT '{}',
  version       integer NOT NULL DEFAULT 1,
  suspended_at  timestamptz,
  activated_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_company_email_key ON users (company_id, email);
CREATE INDEX users_company_status_idx ON users (company_id, status);
CREATE INDEX users_department_idx ON users (department_id);

-- credentials are isolated from the profile row
CREATE TABLE identities (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash    text,
  password_algo    text NOT NULL DEFAULT 'scrypt',
  password_set_at  timestamptz,
  provider         text,
  provider_subject text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  mfa_secret_enc   text,
  mfa_confirmed_at timestamptz,
  recovery_codes   text[] NOT NULL DEFAULT '{}',   -- hashed, single use
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_auth_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_user_idx ON invitations (user_id);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_secret   text NOT NULL,
  mfa_satisfied boolean NOT NULL DEFAULT false,
  device        text,
  ip            inet,
  user_agent    text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  capabilities text[] NOT NULL DEFAULT '{}',
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =============================================================== authorization
CREATE TABLE role_capabilities (
  role       text NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY (role, capability)
);

CREATE TABLE groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     text NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
  PRIMARY KEY (group_id, user_id)
);

-- explicit per-resource grants (membership/ownership authorization)
CREATE TABLE resource_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('user','group')),
  subject_id    uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  effect        text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  capabilities  text[] NOT NULL DEFAULT '{}',
  conditions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grants_lookup_idx ON resource_grants (company_id, resource_type, resource_id);
CREATE INDEX grants_subject_idx ON resource_grants (subject_type, subject_id);

-- =============================================================== audit + outbox
CREATE TABLE audit_events (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL,
  actor_id       uuid,
  actor_email    text,
  action         text NOT NULL,
  resource_type  text,
  resource_id    uuid,
  result         text NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','error')),
  ip             inet,
  user_agent     text,
  correlation_id text,
  before_state   jsonb,
  after_state    jsonb,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_company_time_idx ON audit_events (company_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_events (actor_id, created_at DESC);
CREATE INDEX audit_resource_idx ON audit_events (resource_type, resource_id);
-- audit is append-only; UPDATE/DELETE blocked by trigger below.

CREATE OR REPLACE FUNCTION audit_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- transactional outbox: db commit and emitted event cannot diverge
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL,
  type           text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  actor_id       uuid,
  correlation_id text,
  available_at   timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  processed_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at) WHERE processed_at IS NULL;

CREATE TABLE dead_letters (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,
  payload    jsonb NOT NULL,
  error      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key         text NOT NULL,
  company_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  endpoint    text NOT NULL,
  request_fingerprint text NOT NULL,
  status_code integer,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, company_id, endpoint)
);

CREATE TABLE rate_counters (
  bucket     text PRIMARY KEY,
  count      integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);

-- =============================================================== notifications
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL,
  title        text NOT NULL,
  body         text,
  link         text,
  resource_type text,
  resource_id  uuid,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
