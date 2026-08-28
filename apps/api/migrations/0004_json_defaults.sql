-- Gives every NOT NULL JSON column a default.
--
-- MySQL rejects an INSERT that omits a NOT NULL column without a default, where
-- PostgreSQL's `DEFAULT '{}'` made the same insert legal. Rather than requiring every
-- call site to remember to pass an empty array, the default lives with the column.

ALTER TABLE companies        ALTER COLUMN verified_domains SET DEFAULT (JSON_ARRAY());
ALTER TABLE companies        ALTER COLUMN settings         SET DEFAULT (JSON_OBJECT());
ALTER TABLE users            ALTER COLUMN modules          SET DEFAULT (JSON_ARRAY());
ALTER TABLE identities       ALTER COLUMN recovery_codes   SET DEFAULT (JSON_ARRAY());
ALTER TABLE api_tokens       ALTER COLUMN capabilities     SET DEFAULT (JSON_ARRAY());
ALTER TABLE resource_grants  ALTER COLUMN capabilities     SET DEFAULT (JSON_ARRAY());
ALTER TABLE resource_grants  ALTER COLUMN conditions       SET DEFAULT (JSON_OBJECT());
ALTER TABLE audit_events     ALTER COLUMN metadata         SET DEFAULT (JSON_OBJECT());
ALTER TABLE chat_messages    ALTER COLUMN mentions         SET DEFAULT (JSON_ARRAY());
ALTER TABLE tasks            ALTER COLUMN labels           SET DEFAULT (JSON_ARRAY());
ALTER TABLE tasks            ALTER COLUMN checklist        SET DEFAULT (JSON_ARRAY());
ALTER TABLE approval_definitions ALTER COLUMN form_schema  SET DEFAULT (JSON_ARRAY());
ALTER TABLE approval_definitions ALTER COLUMN routing      SET DEFAULT (JSON_ARRAY());
ALTER TABLE approval_requests    ALTER COLUMN data         SET DEFAULT (JSON_OBJECT());
ALTER TABLE announcements    ALTER COLUMN audience         SET DEFAULT (JSON_OBJECT());
ALTER TABLE search_documents ALTER COLUMN acl_user_ids     SET DEFAULT (JSON_ARRAY());
ALTER TABLE search_documents ALTER COLUMN acl_group_ids    SET DEFAULT (JSON_ARRAY());
