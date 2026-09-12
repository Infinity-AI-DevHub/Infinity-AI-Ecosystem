-- Reminders: things that have to happen on a day, and the nagging that gets them done.
--
-- The workspace could already remind you about a meeting starting or an invoice going
-- unpaid, because those are things it knows about. It had nowhere to put the rest: the
-- subscription that renews on the 4th, the domain that expires in March, the job you
-- promised to do on Friday and want prodding about from Tuesday.
--
-- Two things make this more than a to-do list:
--
--   * `lead_days` — when the nagging starts, which is not the same as when the thing is
--     due. A domain expiring in a year is useless news today and urgent in three weeks.
--   * `repeat_every` — a monthly subscription is one reminder that keeps coming back,
--     not twelve rows somebody has to remember to create.
CREATE TABLE reminders (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  company_id    CHAR(36)     NOT NULL,

  title         VARCHAR(300) NOT NULL,
  notes         TEXT         NULL,

  -- A label, for filtering and for the wording of the notification. Not a behaviour.
  kind          VARCHAR(24)  NOT NULL DEFAULT 'task',

  -- The day the thing must happen. For a repeating reminder this is the *next* one.
  due_on        DATE         NOT NULL,

  -- How many days before `due_on` the reminders start. 0 means on the day itself.
  lead_days     INT          NOT NULL DEFAULT 0,

  -- none | daily | weekly | monthly | yearly, times the interval. Completing a repeating
  -- reminder moves due_on forward rather than closing it.
  repeat_every  VARCHAR(12)  NOT NULL DEFAULT 'none',
  repeat_interval INT        NOT NULL DEFAULT 1,

  -- What it costs, when that is part of the point (a subscription, a renewal fee).
  amount        DECIMAL(14,2) NULL,
  currency      CHAR(3)      NULL,

  -- active | done | cancelled. A repeating reminder is only ever 'done' once it is
  -- deliberately stopped; an occurrence completing just advances the date.
  status        VARCHAR(12)  NOT NULL DEFAULT 'active',

  -- Quietened until this day, for "yes, I know, tell me next week".
  snoozed_until DATE         NULL,

  -- The last day anyone was told. Stops one reminder producing a notification every
  -- time the scheduler ticks; at most one a day.
  last_notified_on DATE      NULL,

  owner_id      CHAR(36)     NOT NULL,
  created_by    CHAR(36)     NOT NULL,
  completed_at  DATETIME(3)  NULL,
  completed_by  CHAR(36)     NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_reminder_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_reminder_owner   FOREIGN KEY (owner_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_reminder_author  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_reminder_repeat CHECK (repeat_every IN ('none','daily','weekly','monthly','yearly')),
  CONSTRAINT chk_reminder_status CHECK (status IN ('active','done','cancelled')),
  CONSTRAINT chk_reminder_lead   CHECK (lead_days >= 0 AND lead_days <= 3650),
  CONSTRAINT chk_reminder_every  CHECK (repeat_interval >= 1 AND repeat_interval <= 99)
) ENGINE=InnoDB;

-- The scheduler's query is "active, not snoozed, due window has opened, not told today".
CREATE INDEX idx_reminders_due ON reminders (company_id, status, due_on);

-- Who else hears about it. A subscription renewal is nobody's private business: the
-- person who owns it and whoever pays the card both need telling.
CREATE TABLE reminder_watchers (
  reminder_id CHAR(36) NOT NULL,
  user_id     CHAR(36) NOT NULL,
  PRIMARY KEY (reminder_id, user_id),
  CONSTRAINT fk_reminder_watcher_reminder FOREIGN KEY (reminder_id) REFERENCES reminders (id) ON DELETE CASCADE,
  CONSTRAINT fk_reminder_watcher_user     FOREIGN KEY (user_id)     REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Everybody internal keeps their own reminders; guests do not, because the portal has
-- no place for them and a client should not be handed the company's renewal calendar.
INSERT INTO role_capabilities (role, capability) VALUES
  ('super_admin', 'reminder.manage'),
  ('admin',       'reminder.manage'),
  ('manager',     'reminder.manage'),
  ('staff',       'reminder.manage'),
  ('auditor',     'reminder.manage')
ON DUPLICATE KEY UPDATE capability = VALUES(capability);
