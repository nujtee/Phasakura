-- Migration 0049: pay-now percentage per price rule (ยอดชำระตอนจอง 10–100 %).
-- Non-destructive: one nullable column on pricing_settings. NULL = the house / VIP tent / camping's own plan
-- (FULL = 100 %, DEPOSIT_50 = 50 %), exactly as before. For each night a rule wins, its percentage decides how much
-- of that night is paid online; the rest is paid at check-in. Bookings already made keep their amounts.

ALTER TABLE pricing_settings ADD COLUMN pay_now_percent INTEGER
  CHECK (pay_now_percent IS NULL OR pay_now_percent IN (10, 20, 30, 40, 50, 60, 70, 80, 90, 100));
