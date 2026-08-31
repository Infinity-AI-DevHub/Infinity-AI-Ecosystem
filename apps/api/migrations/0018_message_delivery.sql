-- Delivery state for chat messages.
--
-- Modelled as a per-member cursor, mirroring read_cursor, rather than a row per message
-- per recipient. A receipts table would grow with messages times members and would need
-- pruning; a cursor is one integer per membership and answers the same question, because
-- delivery is monotonic - a client that has received message 40 has received 39.
--
-- "Sent" needs no storage at all: the row existing is what sent means.
ALTER TABLE chat_members
  ADD COLUMN delivered_cursor BIGINT NOT NULL DEFAULT 0 AFTER read_cursor;

-- Reading is delivery: a member cannot have read past what they have received, and
-- backfilling this keeps existing conversations from showing every old message as
-- undelivered the moment this ships.
UPDATE chat_members SET delivered_cursor = read_cursor WHERE delivered_cursor < read_cursor;
