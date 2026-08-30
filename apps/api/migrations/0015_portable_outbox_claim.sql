-- Infinity Workspace :: portable outbox claiming.
--
-- Claiming a batch used SELECT ... FOR UPDATE SKIP LOCKED, which needs MySQL 8.0 or
-- MariaDB 10.6. Replacing it with a claim token works on any version of either, and
-- fixes a real weakness at the same time: SKIP LOCKED holds its locks only for the life
-- of the transaction, so a worker that died mid-batch left its rows looking free while
-- its own delivery might still have been in flight. A token plus a staleness window
-- makes the claim explicit and reclaimable.

ALTER TABLE outbox_events
  ADD COLUMN lock_token CHAR(36) NULL AFTER locked_at,
  ADD KEY outbox_lock_token (lock_token);
