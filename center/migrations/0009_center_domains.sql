-- Domain expiry of every site (read from RDAP once a day) and the reminders sent: 15 days before (once), 7 days
-- before (twice), 3 days before (morning, noon, evening) — to the Center LINE group ("domains" notice) and, through
-- the site, to its Super Admins / Managers (e-mail, LINE) and the Center users' e-mail.
CREATE TABLE center_domains (
  domain      TEXT PRIMARY KEY CHECK (length(domain) BETWEEN 3 AND 253),
  expires_at  TEXT CHECK (expires_at IS NULL OR expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  registrar   TEXT CHECK (registrar IS NULL OR length(registrar) <= 200),
  error       TEXT CHECK (error IS NULL OR length(error) <= 300),
  checked_at  TEXT NOT NULL
) STRICT;

CREATE TABLE center_domain_notices (
  domain      TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 253),
  expires_at  TEXT NOT NULL,
  slot        TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 40),
  delivery    TEXT NOT NULL CHECK (length(delivery) <= 300),
  sent_at     TEXT NOT NULL,
  PRIMARY KEY (domain, expires_at, slot)
) STRICT;

UPDATE center_settings SET alert_types = json_insert(alert_types, '$[#]', 'domains') WHERE id = 1;
