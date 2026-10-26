-- Migration 0038: the PromptPay ID a receiving account's QR pays into (non-destructive: ADD COLUMN).
--
-- A shop QR (K PLUS / K SHOP, another bank's merchant QR) often pays into an e-Wallet / merchant ID — not the
-- account number or PromptPay number typed on the account — so the slip shows that ID as the receiver and the
-- automatic check refused it (RECEIVER_MISMATCH). Read from the QR image in the browser, kept here, and accepted
-- as this account by the slip check. Same rule as credit_settings.qr_receiver (0028).
ALTER TABLE receiving_accounts ADD COLUMN qr_receiver TEXT
  CHECK (qr_receiver IS NULL OR (length(qr_receiver) BETWEEN 10 AND 20 AND qr_receiver NOT GLOB '*[^0-9]*'));
