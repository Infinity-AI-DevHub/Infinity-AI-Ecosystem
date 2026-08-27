-- Removes the in-workspace mail module.
--
-- Employee email now lives in a separate application, so the workspace no longer
-- stores mailboxes, folders or message bodies. Dropping these tables is also a
-- privacy improvement: the workspace stops being a second copy of everyone's mail,
-- which shrinks both the breach blast radius and the retention obligation.
--
-- Outbound transactional email (activation invitations, security notices) is
-- unaffected - it never needed these tables.
--
-- This migration is destructive and irreversible. Export anything still needed from
-- mail_messages and mail_attachments, and delete the underlying objects from the
-- attachment bucket, BEFORE applying it in an environment holding real data.

-- Search projections for mail must go before the source tables.
DELETE FROM search_documents WHERE doc_type = 'mail';

-- Unprocessed mail events would fail forever once their handlers are gone.
UPDATE outbox_events
   SET processed_at = now(),
       last_error = 'mail module removed'
 WHERE processed_at IS NULL
   AND type LIKE 'mail.%';

DROP TABLE IF EXISTS mail_attachments;
DROP TABLE IF EXISTS mail_messages;
DROP TABLE IF EXISTS mail_threads;
DROP TABLE IF EXISTS mail_folders;
DROP TABLE IF EXISTS mail_signatures;
DROP TABLE IF EXISTS mailbox_delegates;
DROP TABLE IF EXISTS mailboxes;

-- Capabilities the workspace can no longer honour. Leaving them in place would let a
-- role claim an authority the system cannot actually enforce.
DELETE FROM role_capabilities
 WHERE capability IN (
   'mail.read', 'mail.send', 'mail.delete',
   'mailbox.delegate', 'shared_mailbox.manage', 'quarantine.manage'
 );

-- Any explicit grant that pointed at a mailbox is now dangling.
DELETE FROM resource_grants WHERE resource_type = 'mailbox';

-- Audit history is deliberately left intact: it records what people did while the
-- module existed, and that record must survive the module itself.
