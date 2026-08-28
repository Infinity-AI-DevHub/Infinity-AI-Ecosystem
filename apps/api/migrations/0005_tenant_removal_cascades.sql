-- Lets a company be removed without tripping over its own approval records.
--
-- These three foreign keys were RESTRICT, mirroring the PostgreSQL schema, where the
-- intent was "an approver with outstanding decisions cannot simply vanish". People are
-- never hard-deleted in this system - they are suspended or offboarded - so in practice
-- the only DELETE that reaches these rows is a whole-tenant removal, which RESTRICT
-- blocked entirely. PostgreSQL happened to resolve the cascade order in a way that
-- worked; MySQL does not guarantee that ordering, so the constraint has to say what is
-- actually meant.
--
-- Note for reviewers: MySQL does not fire triggers for cascaded foreign key actions, so
-- the append-only guard on approval_decisions does not see a cascade-driven delete. The
-- guard still blocks every direct UPDATE and DELETE, which is the tampering case it
-- exists for; whole-tenant removal remains a deliberate, audited operation.

ALTER TABLE approval_decisions DROP FOREIGN KEY approval_decisions_approver_fk;
ALTER TABLE approval_decisions
  ADD CONSTRAINT approval_decisions_approver_fk
  FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE approval_steps DROP FOREIGN KEY approval_steps_approver_fk;
ALTER TABLE approval_steps
  ADD CONSTRAINT approval_steps_approver_fk
  FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE approval_requests DROP FOREIGN KEY approval_requests_definition_fk;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_definition_fk
  FOREIGN KEY (definition_id) REFERENCES approval_definitions(id) ON DELETE CASCADE;
