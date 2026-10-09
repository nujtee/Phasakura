/**
 * Thai QR Payment (EMVCo merchant-presented) payload for PromptPay, with the amount filled in, so the
 * guest's banking app opens with the right receiver and the exact amount (fewer wrong-amount slips).
 *
 * Fields: 00 format "01" · 01 "12" (dynamic, amount set) / "11" (static) · 29 PromptPay (00 AID, then
 * 01 phone "0066…" / 02 national or tax ID / 03 e-wallet) · 58 "TH" · 53 "764" (THB) · 54 amount · 63 CRC.
 */

const PROMPTPAY_AID = "A000000677010111";

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as Thai QR requires; 4 upper-case hex digits. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * PromptPay target: a 10-digit mobile number (becomes 0066 + 9 digits), a 13-digit national / tax ID or a
 * 15-digit e-wallet ID. Returns null for anything else (no QR is shown then).
 */
export function promptpayPayload(target: string, amountSatang: number | null): string | null {
  const digits = target.replace(/\D/g, "");
  let account: string;
  if (/^0\d{9}$/.test(digits)) account = field("01", `0066${digits.slice(1)}`);
  else if (/^\d{13}$/.test(digits)) account = field("02", digits);
  else if (/^\d{15}$/.test(digits)) account = field("03", digits);
  else return null;
  if (amountSatang !== null && (!Number.isInteger(amountSatang) || amountSatang <= 0 || amountSatang > 9_999_999_999)) return null;
  const parts = [
    field("00", "01"),
    field("01", amountSatang === null ? "11" : "12"),
    field("29", field("00", PROMPTPAY_AID) + account),
    field("58", "TH"),
    field("53", "764"),
    ...(amountSatang === null ? [] : [field("54", (amountSatang / 100).toFixed(2))]),
  ];
  const body = `${parts.join("")}6304`;
  return body + crc16(body);
}
