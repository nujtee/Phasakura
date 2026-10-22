import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { getLocale, type LocaleCode } from "../../src/shared/i18n/index.ts";
import { I18nProvider } from "../../src/client/i18n/I18nProvider.tsx";
import { StayPrice } from "../../src/client/accommodation/UnitCard.tsx";

const wrap = (node: ReactNode, code: LocaleCode = "th") => renderToStaticMarkup(<I18nProvider locale={getLocale(code)}>{node}</I18nProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("price on a booking card", () => {
  it("before a search: the base price per night", () => {
    assert.match(text(wrap(<StayPrice base={190000} per="/ คืน" />)), /฿1,900 \/ คืน/);
  });

  it("one night under a time-based rule: that price, marked as the price for the dates", () => {
    const t = text(wrap(<StayPrice base={190000} nightly={[590000]} per="/ คืน" />));
    assert.match(t, /฿5,900 \/ คืน/);
    assert.match(t, /ราคาตามวันที่เลือก/);
    assert.doesNotMatch(t, /1,900/);
  });

  it("several nights: lowest – highest per night and the total", () => {
    const t = text(wrap(<StayPrice base={190000} nightly={[450000, 590000, 590000]} per="/ night" />, "en"));
    assert.match(t, /฿4,500 – ฿5,900 \/ night/);
    assert.match(t, /Total for 3 nights ฿16,300/);
  });

  it("camping: the total is per adult", () => {
    const t = text(wrap(<StayPrice base={25000} nightly={[25000, 25000]} per="/ ผู้ใหญ่ / คืน" totalSuffix="/ ผู้ใหญ่" />));
    assert.match(t, /฿250 \/ ผู้ใหญ่ \/ คืน/);
    assert.match(t, /รวม 2 คืน ฿500 \/ ผู้ใหญ่/);
  });
});
