-- Theme for this site whatever its plan (set by Center): while on, the STANDARD plan no longer removes the Theme menu
-- (settings.theme) from staff; Reports / Marketing stay PREMIUM. Off = follow the plan as before. Additive only.
ALTER TABLE credit_settings ADD COLUMN theme_unlocked INTEGER NOT NULL DEFAULT 0 CHECK (theme_unlocked IN (0, 1));
