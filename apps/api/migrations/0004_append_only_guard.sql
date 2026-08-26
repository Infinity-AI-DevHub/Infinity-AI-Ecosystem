-- Refines the append-only protection on audit_events and approval_decisions.
--
-- The original trigger refused every UPDATE and DELETE. That correctly blocks tampering,
-- but it also blocked legitimate, governed lifecycle operations: removing a company
-- cascades into approval_decisions, and retention policy eventually expires audit rows.
-- A control that blocks lawful operations gets disabled in production, which is worse
-- than one that is precise.
--
-- New rule:
--   * UPDATE is always refused. History is never rewritten, under any circumstance.
--   * DELETE is refused unless the transaction has explicitly opted in by setting
--     `infinity.purge = 'on'`, which only the tenant-removal and retention paths do.
--     The setting is transaction-local (SET LOCAL), so it cannot leak into other work.

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('infinity.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON audit_events;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

DROP TRIGGER IF EXISTS approval_decisions_immutable ON approval_decisions;
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- The previous shared function is no longer referenced by any trigger.
DROP FUNCTION IF EXISTS audit_is_append_only();
