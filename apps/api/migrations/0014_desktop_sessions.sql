-- Infinity Workspace :: desktop sessions.
--
-- The desktop client cannot use the browser's cookie and CSRF pair - there is no
-- cross-site attacker to defend against and no meaningful Origin on a custom scheme - so
-- it authenticates with a bearer token instead. Rather than a parallel session system,
-- the existing sessions table grows the few columns the difference actually needs, which
-- keeps revocation, suspension and the signed-in-devices screen working untouched.

ALTER TABLE sessions
  -- 'web' keeps the cookie behaviour exactly as it was; 'desktop' is bearer-authenticated.
  ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'web' AFTER user_id,
  -- Desktop only. The access token still lives in token_hash; this is what buys a new one.
  ADD COLUMN refresh_token_hash VARCHAR(64) NULL AFTER token_hash,
  -- The hard ceiling. A refresh mints a new access token but never moves this, so a
  -- desktop session ends five days after sign-in however actively it has been used -
  -- which is what "re-authenticate every five days" has to mean to be worth anything.
  ADD COLUMN absolute_expires_at DATETIME(3) NULL AFTER expires_at,
  -- The session this one was rotated from, so a replayed refresh token can be traced back
  -- to its chain and the whole chain revoked.
  ADD COLUMN rotated_from CHAR(36) NULL AFTER absolute_expires_at,
  ADD UNIQUE KEY sessions_refresh (refresh_token_hash),
  ADD KEY sessions_chain (rotated_from);

-- Existing rows are browser sessions and keep their original ceiling.
UPDATE sessions SET absolute_expires_at = expires_at WHERE absolute_expires_at IS NULL;
