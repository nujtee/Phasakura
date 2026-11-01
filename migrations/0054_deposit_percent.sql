-- Migration 0054: deposit of 60 % or 70 % as well as 50 % (houses / VIP tents and camping).
-- Non-destructive: one nullable column on accommodation_units and on camping_settings. payment_mode keeps its two values
-- (FULL / DEPOSIT_50 = "a deposit plan", so the deposit triggers of 0025 / 0026 are unchanged); deposit_percent says how
-- much of the stay is paid when booking. NULL = 50 %, exactly as before; it only means something with DEPOSIT_50.

ALTER TABLE accommodation_units ADD COLUMN deposit_percent INTEGER
  CHECK (deposit_percent IS NULL OR deposit_percent IN (50, 60, 70));

ALTER TABLE camping_settings ADD COLUMN deposit_percent INTEGER
  CHECK (deposit_percent IS NULL OR deposit_percent IN (50, 60, 70));
