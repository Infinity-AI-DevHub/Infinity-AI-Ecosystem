-- Sharing work with clients and guests, and the manual message log.
--
-- The grant machinery in resource_grants already does the hard part: a subject, a
-- resource, and the capabilities that subject holds on it. What was missing was the
-- capabilities a guest needs to hold, and a route to the pages that use them.

-- A guest may hold these on a specific record, never company-wide: the grant names the
-- resource, and every read still authorizes against it.
INSERT INTO role_capabilities (role, capability) VALUES
  ('guest', 'task.read'),
  ('guest', 'doc.read'),
  -- Upload and edit inside a shared folder. A guest holds these only where a grant says
  -- so, which is what makes "view only" and "view and upload" different shares of the
  -- same machinery rather than two features.
  ('guest', 'file.create'),
  ('guest', 'file.update')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);

-- task.read did not exist as a capability at all: reading a task was gated on
-- task.update, which is why a viewer had to be given permission to change it.
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin','task.read'), ('admin','task.read'),
  ('manager','task.read'), ('staff','task.read'), ('auditor','task.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);

-- ---------------------------------------------------------------------------
-- Messages sent by hand from the platform.
--
-- Recorded rather than fired and forgotten: "did anyone tell the client" is a question
-- that gets asked, and an email nobody can find the trace of is indistinguishable from
-- one that was never sent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_messages (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  company_id   CHAR(36)     NOT NULL,
  subject      VARCHAR(300) NOT NULL,
  body         TEXT         NOT NULL,
  -- Who it went to, resolved at send time and stored, so the record survives somebody
  -- later leaving a group or being offboarded.
  recipients   JSON         NOT NULL,
  recipient_count INT       NOT NULL DEFAULT 0,
  audience     VARCHAR(40)  NOT NULL DEFAULT 'people',
  sent_by      CHAR(36)     NULL,
  sent_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY outbound_messages_company (company_id, sent_at),
  CONSTRAINT outbound_messages_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT outbound_messages_sender_fk FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin','message.broadcast'), ('admin','message.broadcast'), ('manager','message.broadcast')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
