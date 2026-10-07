-- Migration 0016: LINE Official Account notifications (Phase 11, spec §47)
-- Non-destructive: new tables, one seed row, one trigger, one index. No table rebuild, no data change.
--
-- Secrets (channel access token, channel secret) are NEVER stored here:
-- they are Cloudflare Secrets (LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET).
--
-- notification_logs (0006) is the outbox. Its `recipient` column holds a reference, never a LINE id:
--   'staff:<line_recipients.id>'  — a staff chat (user, group or room) registered below
--   'guest:<bookings.id>'         — the guest who linked their LINE to that booking
-- The LINE id is looked up at send time, so unlinking / deleting a recipient stops delivery
-- and the log never stores the guest's LINE user id.

-- ---------------------------------------------------------------------------
-- Settings (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE line_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  enabled              INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  guest_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (guest_enabled IN (0, 1)),
  public_button        INTEGER NOT NULL DEFAULT 0 CHECK (public_button IN (0, 1)),
  -- "Tomorrow check-in" schedule (spec §47 default: 1 day before, 18:00, property time).
  reminder_days_before INTEGER NOT NULL DEFAULT 1 CHECK (reminder_days_before BETWEEN 0 AND 7),
  reminder_time        TEXT NOT NULL DEFAULT '18:00'
                       CHECK (reminder_time GLOB '[0-2][0-9]:[0-5][0-9]' AND reminder_time <= '23:59'),
  send_when_empty      INTEGER NOT NULL DEFAULT 0 CHECK (send_when_empty IN (0, 1)),
  -- Public facts about the bot, read from the Messaging API ("check connection").
  bot_basic_id         TEXT CHECK (bot_basic_id IS NULL OR (bot_basic_id GLOB '@*' AND length(bot_basic_id) BETWEEN 3 AND 40)),
  bot_display_name     TEXT CHECK (bot_display_name IS NULL OR length(bot_display_name) <= 200),
  bot_checked_at       TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by           TEXT REFERENCES users (id)
) STRICT;

INSERT INTO line_settings (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- Staff chats that receive notifications (a person, a group or a room)
-- ---------------------------------------------------------------------------
CREATE TABLE line_recipients (
  id             TEXT PRIMARY KEY,
  target_id      TEXT NOT NULL UNIQUE
                 CHECK (length(target_id) = 33 AND substr(target_id, 1, 1) IN ('U', 'C', 'R')
                        AND substr(target_id, 2) NOT GLOB '*[^0-9a-f]*'),
  name           TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  notify_checkin INTEGER NOT NULL DEFAULT 1 CHECK (notify_checkin IN (0, 1)),
  notify_food    INTEGER NOT NULL DEFAULT 0 CHECK (notify_food IN (0, 1)),
  notify_payment INTEGER NOT NULL DEFAULT 0 CHECK (notify_payment IN (0, 1)),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  linked_via     TEXT NOT NULL CHECK (linked_via IN ('CODE', 'MANUAL')),
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES users (id),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT REFERENCES users (id),
  CHECK (deleted_at IS NULL OR active = 0)
) STRICT;

-- ---------------------------------------------------------------------------
-- One-time link codes ("LINK ABCD-EFGH" sent to the Official Account).
-- STAFF: created by an admin, registers the chat it is sent from.
-- GUEST: created from the guest's booking page, links their LINE user to that booking.
-- Only the SHA-256 of the code is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE line_link_codes (
  id             TEXT PRIMARY KEY,
  code_hash      TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  purpose        TEXT NOT NULL CHECK (purpose IN ('STAFF', 'GUEST')),
  booking_id     TEXT REFERENCES bookings (id),
  recipient_name TEXT CHECK (recipient_name IS NULL OR length(trim(recipient_name)) BETWEEN 1 AND 80),
  language_code  TEXT NOT NULL REFERENCES languages (code),
  created_by     TEXT REFERENCES users (id),
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  recipient_id   TEXT REFERENCES line_recipients (id),
  created_at     TEXT NOT NULL,
  CHECK ((purpose = 'GUEST') = (booking_id IS NOT NULL)),
  CHECK (purpose = 'GUEST' OR (recipient_name IS NOT NULL AND created_by IS NOT NULL)),
  CHECK (used_at IS NOT NULL OR recipient_id IS NULL)
) STRICT;

CREATE INDEX ix_line_link_codes_booking ON line_link_codes (booking_id, created_at);

-- ---------------------------------------------------------------------------
-- Guest opt-in: the LINE user that receives updates for a booking.
-- Removed when the guest unlinks, blocks the account, or 30 days after check-out.
-- ---------------------------------------------------------------------------
CREATE TABLE booking_line_links (
  booking_id   TEXT PRIMARY KEY REFERENCES bookings (id),
  line_user_id TEXT NOT NULL
               CHECK (length(line_user_id) = 33 AND substr(line_user_id, 1, 1) = 'U'
                      AND substr(line_user_id, 2) NOT GLOB '*[^0-9a-f]*'),
  linked_at    TEXT NOT NULL
) STRICT;

CREATE INDEX ix_booking_line_links_user ON booking_line_links (line_user_id);

-- ---------------------------------------------------------------------------
-- Outbox guarantees: a SENT notification is final (a retry can never send it twice).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_notification_logs_sent_final BEFORE UPDATE OF status ON notification_logs
WHEN OLD.status = 'SENT' AND NEW.status <> 'SENT'
BEGIN
  SELECT RAISE(ABORT, 'NOTIFICATION_SENT_FINAL');
END;

CREATE INDEX ix_notification_logs_created ON notification_logs (created_at);
