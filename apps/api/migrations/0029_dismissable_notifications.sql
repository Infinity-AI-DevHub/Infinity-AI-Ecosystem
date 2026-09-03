-- Clearing a notification.
--
-- The bell could mark things read, which removes the bold and nothing else: the list only
-- ever shrank when the 30-day retention job caught up with it. So the panel filled with
-- things people had already dealt with and there was no way to tidy it.
--
-- Dismissed rather than deleted, because of the dedupe key. The unique index on
-- (user_id, dedupe_key) is what makes a redelivered event safe to process twice — delete
-- the row and a retry would recreate a notification the person had explicitly cleared.
-- Keeping a dismissed row keeps that promise, and the existing retention job removes it
-- on the usual schedule along with everything else.
ALTER TABLE notifications
  ADD COLUMN dismissed_at DATETIME(3) NULL AFTER read_at;

-- The panel's query is "mine, not dismissed, newest first", so the index it walks should
-- say the same thing.
CREATE INDEX notifications_user_active
  ON notifications (user_id, dismissed_at, created_at);
