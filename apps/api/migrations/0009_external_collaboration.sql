-- Infinity Workspace :: external collaboration.
--
-- Client and vendor work is central to this company, and until now nothing could cross
-- the company boundary at all: the only sharing capability was file.share_internal and
-- every account had to sit on a verified domain. Externals therefore had no
-- representation in the system that holds everything else.
--
-- Two mechanisms, deliberately separate because they answer different questions.
-- A guest account is for an ongoing relationship - a named person from a named
-- organisation who signs in, is audited, and reaches exactly the resources granted to
-- them through resource_grants. A share link is for a one-off handover to someone who
-- should not need an account at all.

-- The organisation is the unit that survives its people. Contacts come and go; the
-- client relationship, and what was shared under it, does not.
CREATE TABLE IF NOT EXISTS external_organizations (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  name         VARCHAR(200) NOT NULL,
  kind         VARCHAR(20)  NOT NULL DEFAULT 'client',
  status       VARCHAR(20)  NOT NULL DEFAULT 'active',
  website      VARCHAR(300) NULL,
  notes        TEXT         NULL,
  created_by   CHAR(36)     NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY external_org_name (company_id, name),
  KEY external_org_status (company_id, status),
  CONSTRAINT external_org_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT external_org_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT external_org_kind_chk CHECK (kind IN ('client','vendor','partner','contractor')),
  CONSTRAINT external_org_status_chk CHECK (status IN ('active','archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A guest belongs to exactly one organisation, and their access carries an end date by
-- default. External access that never expires is how a finished engagement quietly
-- becomes a standing door into the company.
CREATE TABLE IF NOT EXISTS external_memberships (
  user_id         CHAR(36)     NOT NULL PRIMARY KEY,
  organization_id CHAR(36)     NOT NULL,
  company_id      CHAR(36)     NOT NULL,
  role_label      VARCHAR(120) NULL,
  access_expires_at DATETIME(3) NULL,
  invited_by      CHAR(36)     NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY external_members_org (organization_id),
  KEY external_members_expiry (access_expires_at),
  CONSTRAINT external_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT external_members_org_fk FOREIGN KEY (organization_id) REFERENCES external_organizations(id) ON DELETE CASCADE,
  CONSTRAINT external_members_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT external_members_inviter_fk FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A share link is a capability in a URL, so it is stored only as a hash, always expires,
-- and counts its own use. Revocation is a column rather than a delete because who shared
-- what with whom is exactly the question an audit asks after the fact.
CREATE TABLE IF NOT EXISTS share_links (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,
  resource_type VARCHAR(20)  NOT NULL,
  resource_id   CHAR(36)     NOT NULL,
  token_hash    CHAR(64)     NOT NULL,
  -- Optional second factor for the link. Hashed, never stored in the clear.
  password_hash VARCHAR(255) NULL,
  recipient_email VARCHAR(320) NULL,
  allow_download BOOLEAN     NOT NULL DEFAULT TRUE,
  max_uses      INT          NULL,
  use_count     INT          NOT NULL DEFAULT 0,
  expires_at    DATETIME(3)  NOT NULL,
  revoked_at    DATETIME(3)  NULL,
  created_by    CHAR(36)     NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at  DATETIME(3)  NULL,
  UNIQUE KEY share_links_token (token_hash),
  KEY share_links_resource (company_id, resource_type, resource_id),
  KEY share_links_expiry (expires_at),
  CONSTRAINT share_links_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT share_links_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT share_links_type_chk CHECK (resource_type IN ('file','folder'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every access through a link is recorded. The link itself is anonymous by design, so
-- this is the only trace of what left the company and when.
CREATE TABLE IF NOT EXISTS share_link_accesses (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  share_link_id CHAR(36)     NOT NULL,
  ip            VARCHAR(45)  NULL,
  user_agent    VARCHAR(400) NULL,
  action        VARCHAR(20)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY share_access_link (share_link_id, created_at),
  CONSTRAINT share_access_link_fk FOREIGN KEY (share_link_id) REFERENCES share_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Guests start with nothing that works on its own. Every capability here is useless
-- without a matching resource grant, because the decision pipeline checks the capability
-- first and then demands authorization on the specific record. None of these may ever be
-- used with a resourceless check - that would turn a scoped guest into a company-wide
-- one. Notably absent: search, the people directory, announcements and approvals.
INSERT INTO role_capabilities (role, capability) VALUES
  ('guest', 'file.read'),
  ('guest', 'file.create'),
  ('guest', 'file.update'),
  ('guest', 'message.send'),
  ('guest', 'room.join'),
  ('guest', 'meeting.join'),
  ('guest', 'calendar.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);

-- Sharing outside the company is its own capability, separate from internal sharing, so
-- it can be granted to fewer people than day-to-day collaboration.
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'file.share_external'),
  ('admin', 'file.share_external'),
  ('manager', 'file.share_external'),
  ('super_admin', 'guest.manage'),
  ('admin', 'guest.manage'),
  ('manager', 'guest.manage'),
  ('super_admin', 'external_org.manage'),
  ('admin', 'external_org.manage'),
  ('manager', 'external_org.manage'),
  ('super_admin', 'external_org.read'),
  ('admin', 'external_org.read'),
  ('manager', 'external_org.read'),
  ('staff', 'external_org.read'),
  ('auditor', 'external_org.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
