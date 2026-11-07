-- The booking page's look, chosen in Settings → Theme next to the site layout and versioned with it:
-- CARDS = the page as it was (a grid of cards), LIST = a hotel-search list (one row per stay, filters, sorting).
-- Additive only; nothing changes until an admin publishes LIST.
ALTER TABLE theme_versions ADD COLUMN booking_layout TEXT NOT NULL DEFAULT 'CARDS'
  CHECK (booking_layout IN ('CARDS', 'LIST'));

-- A published or archived version is history: never changed.
CREATE TRIGGER trg_theme_versions_booking_layout_frozen BEFORE UPDATE OF booking_layout ON theme_versions
WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'THEME_VERSION_IMMUTABLE');
END;
