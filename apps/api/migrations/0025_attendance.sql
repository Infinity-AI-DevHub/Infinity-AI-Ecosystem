-- Attendance: clocking in and out, with evidence and an approval.
--
-- One row per work session rather than per day: somebody may clock in twice in a day,
-- and a day's total is the sum of its sessions. Storing the day as a derived total would
-- lose when the work actually happened, which is the part a reviewer needs.
--
-- Times are UTC. The "day" a session belongs to is computed from the person's own
-- timezone at read time - a Colombo team on UTC would see its working day split at
-- 05:30, which is not a day anybody recognises.
CREATE TABLE attendance_sessions (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  company_id     CHAR(36)     NOT NULL,
  user_id        CHAR(36)     NOT NULL,
  clocked_in_at  DATETIME(3)  NOT NULL,
  clocked_out_at DATETIME(3)  NULL,

  -- Set when the session closes, so a list does not recompute it per row and a later
  -- change to the minimum-hours policy cannot silently rewrite history.
  worked_minutes INT          NULL,

  /*
   * How it ended.
   *   open      - still running
   *   manual    - the person clocked out
   *   auto      - the app stopped reporting and the server closed it
   *   abandoned - closed by housekeeping with no heartbeat at all
   */
  close_reason   VARCHAR(16)  NOT NULL DEFAULT 'open',

  -- The last time the app said it was still there. Drives auto clock-out: a graceful
  -- close cannot be relied on, because a crash or a lost battery sends nothing.
  last_seen_at   DATETIME(3)  NOT NULL,

  note           TEXT         NULL,

  /*
   * Flagged when the session closed without a note, without evidence, or on its own.
   * A flag is not a judgement - it says a reviewer has to look.
   */
  flagged        TINYINT(1)   NOT NULL DEFAULT 0,
  flag_reason    VARCHAR(200) NULL,

  -- pending | approved | disqualified
  review_state   VARCHAR(16)  NOT NULL DEFAULT 'pending',
  review_note    TEXT         NULL,
  reviewed_by    CHAR(36)     NULL,
  reviewed_at    DATETIME(3)  NULL,

  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_attendance_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_user    FOREIGN KEY (user_id)    REFERENCES users (id)     ON DELETE CASCADE,
  CONSTRAINT fk_attendance_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_attendance_user_day ON attendance_sessions (company_id, user_id, clocked_in_at);
CREATE INDEX idx_attendance_review   ON attendance_sessions (company_id, review_state, clocked_in_at);
CREATE INDEX idx_attendance_flagged  ON attendance_sessions (company_id, flagged, clocked_in_at);

-- Only one session may be open per person. A partial index would express this exactly;
-- MySQL has none, so it is enforced in the domain and this index makes that check cheap.
CREATE INDEX idx_attendance_open ON attendance_sessions (company_id, user_id, close_reason);

-- Evidence is an ordinary workspace file, so it keeps versioning, scanning and the
-- recycle bin, and the reviewer previews it with the same viewer as everything else.
CREATE TABLE attendance_evidence (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  company_id  CHAR(36)    NOT NULL,
  session_id  CHAR(36)    NOT NULL,
  file_id     CHAR(36)    NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_evidence_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_evidence_session FOREIGN KEY (session_id) REFERENCES attendance_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_evidence_file    FOREIGN KEY (file_id)    REFERENCES files (id) ON DELETE CASCADE,
  CONSTRAINT uq_evidence_file UNIQUE (session_id, file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_evidence_session ON attendance_evidence (session_id);

-- Everyone clocks in and out for themselves; reviewing is an administrator's job.
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin','attendance.record'), ('super_admin','attendance.review'),
  ('admin','attendance.record'),       ('admin','attendance.review'),
  ('manager','attendance.record'),
  ('staff','attendance.record'),
  ('auditor','attendance.review')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
