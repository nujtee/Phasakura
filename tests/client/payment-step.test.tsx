import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { PublicBookingDto } from "../../src/shared/booking-types.ts";
import type { PaymentInstructionsDto } from "../../src/shared/payment-types.ts";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { promptpayPayload } from "../../src/shared/promptpay.ts";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { PaymentInstructions } from "../../src/client/booking/PaymentInstructions.tsx";
import { SlipStatus } from "../../src/client/booking/SlipUpload.tsx";

const wrap = (node: ReactNode, code: LocaleCode = "th") => renderToStaticMarkup(<I18nProvider locale={getLocale(code)}>{node}</I18nProvider>);

const payment: PaymentInstructionsDto = {
  bankName: "กสิกรไทย", accountName: "PHASAKURA", accountNumber: "123-4-56789-0", promptpayNumber: "0812345678", qrUrl: "/media/qr.png",
  amountDueSatang: 700000, channels: ["PROMPTPAY", "BANK_TRANSFER", "QR_CODE", "PAYPAL"], promptpayPayload: promptpayPayload("0812345678", 700000),
};
const render = (p: PaymentInstructionsDto, code: LocaleCode = "th") =>
  wrap(<PaymentInstructions payment={p} expiresAt="2027-01-10T04:00:00.000Z" bookingCode="BK-20270110-AB12" phone="0812345678"
    slip={(channel) => <p data-slip={channel}>slip form</p>} />, code);

describe("payment step (guest)", () => {
  it("offers the channels as a radio group; PromptPay first, with a QR that carries the amount", () => {
    const html = render(payment);
    assert.match(html, /<legend[^>]*>เลือกช่องทางชำระเงิน<\/legend>/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 4);
    for (const label of ["พร้อมเพย์", "โอนเข้าบัญชี", "สแกน QR Code", "PayPal"]) assert.match(html, new RegExp(label));
    assert.match(html, /<svg class="qr" role="img" aria-label="PromptPay QR สำหรับชำระ ฿7,000"/);
    assert.match(html, /ยอด ฿7,000 จะใส่ให้อัตโนมัติ/);
    assert.match(html, /data-slip="PROMPTPAY"/, "slip form for the chosen channel");
    assert.match(html, /ชำระภายใน/);
  });

  it("one channel only: no picker; PayPal alone shows the PayPal button and no slip form", () => {
    const bank = render({ ...payment, channels: ["BANK_TRANSFER"] });
    assert.doesNotMatch(bank, /type="radio"/);
    assert.match(bank, /123-4-56789-0/);
    assert.match(bank, /data-slip="BANK_TRANSFER"/);
    const paypal = render({ ...payment, channels: ["PAYPAL"] }, "en");
    assert.match(paypal, /<button type="button" class="button button--primary pay-paypal__button"[^>]*>Pay with PayPal · ฿7,000<\/button>/);
    assert.doesNotMatch(paypal, /data-slip/);
  });

  it("tells the guest why a payment was declined or the booking cancelled", () => {
    const base = { status: "PENDING", paymentStatus: "REJECTED", paymentRejectedReason: "ยอดไม่ครบ", cancelReason: null } as unknown as PublicBookingDto;
    assert.match(wrap(<SlipStatus booking={base} />), /การชำระเงินก่อนหน้ายังไม่ผ่านการตรวจสอบ — ยอดไม่ครบ/);
    const cancelled = { ...base, status: "CANCELLED", cancelReason: "ที่พักปิดปรับปรุง" } as PublicBookingDto;
    assert.match(wrap(<SlipStatus booking={cancelled} />, "en"), /This booking was cancelled — ที่พักปิดปรับปรุง/);
  });
});
