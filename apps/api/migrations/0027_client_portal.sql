-- The client portal.
--
-- A guest already reaches individual files, tasks and documents through resource_grants.
-- What they could not reach was anything about their own commercial relationship: the
-- invoices and quotations addressed to their organisation. Those are not shared record by
-- record - they are simply theirs - so they are scoped by organisation instead, which is
-- why this needs a capability of its own rather than another grant type.
--
-- Guests only. An employee reads the same documents through Finance, which is company-
-- wide and has the editing side of the story; giving staff this capability as well would
-- create a second read path to keep correct for no gain.
INSERT INTO role_capabilities (role, capability) VALUES
  ('guest', 'portal.read')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
