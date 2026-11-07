-- One app fee per booking with several stays (site migration 0064), set in Center.
-- center_multi_stay: the centre-wide switch and amount (no row = off, 20 baht).
-- center_multi_stay_sites: which sites use it. A site uses it when the centre-wide switch AND its own are on;
--   that is sent to the site on every change (the Credits page offers "ส่งอีกครั้ง" when a site reports otherwise).
CREATE TABLE center_multi_stay (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  fee_baht    INTEGER NOT NULL CHECK (fee_baht BETWEEN 1 AND 100000),
  updated_by  TEXT REFERENCES center_users (id),
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE center_multi_stay_sites (
  site        TEXT PRIMARY KEY CHECK (length(site) BETWEEN 2 AND 31),
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by  TEXT REFERENCES center_users (id),
  updated_at  TEXT NOT NULL
) STRICT;
