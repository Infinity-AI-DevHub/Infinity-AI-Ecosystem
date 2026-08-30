-- Infinity Workspace :: documents.
--
-- There has been nowhere in this company to write anything down. Files hold binary blobs
-- and announcements are one-way broadcast; neither is somewhere two people can write and
-- edit the same page. On a platform that is the company's only system, that gap means
-- every policy, runbook, decision record and onboarding note lives in someone's head or
-- outside the product entirely.

-- Spaces are the unit of organisation and of access. Most are company-wide, because a
-- knowledge base nobody can read is not one; restricted spaces exist for the handful of
-- things that genuinely are - board papers, an HR case file.
CREATE TABLE IF NOT EXISTS doc_spaces (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  company_id  CHAR(36)     NOT NULL,
  `key`       VARCHAR(40)  NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  -- 'company' is readable by every employee; 'restricted' is readable only through an
  -- explicit grant in resource_grants, which the authorization engine already evaluates.
  visibility  VARCHAR(20)  NOT NULL DEFAULT 'company',
  colour      VARCHAR(16)  NOT NULL DEFAULT '#6366f1',
  archived_at DATETIME(3)  NULL,
  created_by  CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY doc_spaces_key (company_id, `key`),
  KEY doc_spaces_company (company_id, archived_at),
  CONSTRAINT doc_spaces_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT doc_spaces_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT doc_spaces_visibility_chk CHECK (visibility IN ('company','restricted'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS doc_pages (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  space_id     CHAR(36)     NOT NULL,
  -- Pages nest, because a runbook with six sections is one page with children rather
  -- than six unrelated documents.
  parent_id    CHAR(36)     NULL,
  slug         VARCHAR(160) NOT NULL,
  title        VARCHAR(300) NOT NULL,
  -- Sanitized HTML. The allow-list sanitizer is applied on write, so what is stored is
  -- already safe to render - a page is authored by a colleague, but "authored by someone
  -- with an account" is not the same as trustworthy.
  body         MEDIUMTEXT   NOT NULL,
  excerpt      VARCHAR(500) NULL,
  state        VARCHAR(20)  NOT NULL DEFAULT 'draft',
  -- Optimistic concurrency: two people editing the same page is the normal case, and
  -- silently overwriting one of them is the failure worth preventing.
  version      INT          NOT NULL DEFAULT 1,
  position     INT          NOT NULL DEFAULT 0,
  created_by   CHAR(36)     NULL,
  updated_by   CHAR(36)     NULL,
  published_at DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY doc_pages_slug (space_id, slug),
  KEY doc_pages_space (space_id, parent_id, position),
  KEY doc_pages_company_state (company_id, state),
  FULLTEXT KEY doc_pages_search (title, excerpt),
  CONSTRAINT doc_pages_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT doc_pages_space_fk FOREIGN KEY (space_id) REFERENCES doc_spaces(id) ON DELETE CASCADE,
  CONSTRAINT doc_pages_parent_fk FOREIGN KEY (parent_id) REFERENCES doc_pages(id) ON DELETE SET NULL,
  CONSTRAINT doc_pages_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT doc_pages_updater_fk FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT doc_pages_state_chk CHECK (state IN ('draft','published','archived'))
) ENGINE=InnoDB;

-- Every save keeps the version it replaced. A wiki without history is a wiki nobody
-- trusts enough to edit, because there is no way back from a mistake.
CREATE TABLE IF NOT EXISTS doc_page_versions (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  page_id     CHAR(36)     NOT NULL,
  version     INT          NOT NULL,
  title       VARCHAR(300) NOT NULL,
  body        MEDIUMTEXT   NOT NULL,
  change_note VARCHAR(300) NULL,
  author_id   CHAR(36)     NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY doc_versions_unique (page_id, version),
  KEY doc_versions_page (page_id, created_at),
  CONSTRAINT doc_versions_page_fk FOREIGN KEY (page_id) REFERENCES doc_pages(id) ON DELETE CASCADE,
  CONSTRAINT doc_versions_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'doc.read'), ('admin', 'doc.read'), ('manager', 'doc.read'),
  ('staff', 'doc.read'), ('auditor', 'doc.read'),
  ('super_admin', 'doc.write'), ('admin', 'doc.write'), ('manager', 'doc.write'),
  ('staff', 'doc.write'),
  -- Creating and archiving a space shapes where knowledge lives, so it sits above
  -- day-to-day writing.
  ('super_admin', 'doc.space_manage'), ('admin', 'doc.space_manage'),
  ('manager', 'doc.space_manage'),
  ('super_admin', 'doc.delete'), ('admin', 'doc.delete')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
