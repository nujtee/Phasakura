-- Migration 0032: lock camping nights from the admin calendar (non-destructive: ADD COLUMN + trigger).
--
-- closed = 1: the night takes no NEW tents. Tents already booked stay (and may be cancelled); the counter may
-- only go down. Unlike setting max_tents = tents_used, a cancellation does not re-open a locked night.
-- closed = 2 is the same lock, held only for the instant the integrity repair resets the counters to the
-- bookings' truth (the repair may raise a counter that drifted low; the guard must not block that).
ALTER TABLE camping_night_inventory
  ADD COLUMN closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1, 2));

-- The message matches the existing tents_used CHECK mapping (CAMPING_FULL / DATES_UNAVAILABLE), and the whole
-- booking batch rolls back, exactly like a full night.
CREATE TRIGGER trg_camping_night_closed BEFORE UPDATE OF tents_used ON camping_night_inventory
WHEN NEW.closed = 1 AND NEW.tents_used > OLD.tents_used
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: camping night closed (tents_used)');
END;
