-- Credit top-up requests of every site, decided in Center (central credits, stage 3).
-- center_topup_seen: requests already announced in the LINE group (each one once); kept 60 days.
CREATE TABLE center_topup_seen (
  site      TEXT NOT NULL CHECK (length(site) BETWEEN 2 AND 31),
  topup_id  TEXT NOT NULL CHECK (length(topup_id) BETWEEN 1 AND 64),
  delivery  TEXT NOT NULL CHECK (delivery IN ('SENT', 'FAILED', 'OFF', 'NO_GROUP', 'NO_TOKEN')),
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (site, topup_id)
) STRICT;
CREATE INDEX ix_center_topup_seen_at ON center_topup_seen (seen_at);

-- The new LINE notice ("คำขอเติมเครดิตใหม่") starts switched on.
UPDATE center_settings SET alert_types = json_insert(alert_types, '$[#]', 'topups') WHERE id = 1;
