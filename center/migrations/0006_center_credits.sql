-- Credit settings kept once in Center and sent to every site (site migration 0060).
-- center_credit_settings: the one set (no row until the owner saves or takes over a site's settings).
--   The QR picture of where top-ups are paid is kept here (base64, ≤ 2 MB) and sent with the settings.
--   version changes on every save; a site whose version differs has not received the latest set yet.
-- center_credit_sync: the last send to each site (OK / FAILED); FAILED ones are retried by the 5-minute check.
CREATE TABLE center_credit_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  fee_per_unit     INTEGER NOT NULL CHECK (fee_per_unit BETWEEN 1 AND 100000),
  low_threshold    INTEGER NOT NULL CHECK (low_threshold BETWEEN 0 AND 100000000),
  approval_mode    TEXT NOT NULL CHECK (approval_mode IN ('MANUAL', 'EASYSLIP')),
  standard_min     INTEGER CHECK (standard_min IS NULL OR standard_min BETWEEN 1 AND 100000000),
  premium_min      INTEGER CHECK (premium_min IS NULL OR premium_min BETWEEN 1 AND 100000000),
  bank_name        TEXT CHECK (bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 100),
  account_name     TEXT CHECK (account_name IS NULL OR length(account_name) BETWEEN 1 AND 150),
  account_number   TEXT CHECK (account_number IS NULL OR length(account_number) BETWEEN 5 AND 30),
  promptpay_number TEXT CHECK (promptpay_number IS NULL OR length(promptpay_number) IN (10, 13, 15)),
  qr_receiver      TEXT CHECK (qr_receiver IS NULL OR length(qr_receiver) BETWEEN 10 AND 20),
  qr_mime          TEXT CHECK (qr_mime IS NULL OR qr_mime IN ('image/png', 'image/jpeg', 'image/webp')),
  qr_data          TEXT CHECK (qr_data IS NULL OR length(qr_data) <= 2800000),
  qr_sha256        TEXT CHECK (qr_sha256 IS NULL OR length(qr_sha256) = 64),
  notify_email     TEXT CHECK (notify_email IS NULL OR length(notify_email) BETWEEN 3 AND 254),
  alert_time_1     TEXT NOT NULL,
  alert_time_2     TEXT NOT NULL,
  version          TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  updated_by       TEXT REFERENCES center_users (id),
  updated_at       TEXT NOT NULL,
  CHECK ((qr_data IS NULL) = (qr_sha256 IS NULL) AND (qr_data IS NULL) = (qr_mime IS NULL))
) STRICT;

CREATE TABLE center_credit_sync (
  site         TEXT PRIMARY KEY CHECK (length(site) BETWEEN 2 AND 31),
  version      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('OK', 'FAILED')),
  error        TEXT CHECK (error IS NULL OR length(error) <= 300),
  attempts     INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  attempted_at TEXT NOT NULL,
  synced_at    TEXT
) STRICT;
