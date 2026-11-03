-- Migration 0058: guests must give an e-mail address when they book on the website (set in Admin → booking rules).
-- Non-destructive: one column, on by default (staff can switch it off). Bookings already made are not touched; OTA and
-- staff-made bookings do not need one.
ALTER TABLE booking_settings ADD COLUMN require_email INTEGER NOT NULL DEFAULT 1 CHECK (require_email IN (0, 1));
