-- App fee once per booking when one guest books several stays (several houses / VIP tents / tents in one booking):
-- switched on per site by Center (centre-wide switch + per-site choice), with the amount Center sets (20 baht by
-- default). Off = the fee per unit as before. Additive only.
ALTER TABLE credit_settings ADD COLUMN multi_stay_flat INTEGER NOT NULL DEFAULT 0 CHECK (multi_stay_flat IN (0, 1));
ALTER TABLE credit_settings ADD COLUMN multi_stay_fee INTEGER NOT NULL DEFAULT 20 CHECK (multi_stay_fee BETWEEN 1 AND 100000);
