import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminEn, adminTh, adminZhCN, format } from "../../src/shared/i18n/admin-messages.ts";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
function values(obj: object): string[] {
  return Object.values(obj).flatMap((v) => (typeof v === "object" ? values(v) : [v as string]));
}

describe("admin dictionaries", () => {
  it("TH, EN and ZH-CN have identical keys and no empty strings", () => {
    const ref = keys(adminTh).sort();
    for (const dict of [adminEn, adminZhCN]) {
      assert.deepEqual(keys(dict).sort(), ref);
      assert.ok(values(dict).every((v) => v.trim().length > 0));
    }
  });

  it("every API error code used by auth/user management has a message", () => {
    for (const code of ["INVALID_CREDENTIALS", "ACCOUNT_SUSPENDED", "SUPER_ADMIN_REQUIRED", "CANNOT_DELEGATE",
      "CANNOT_MODIFY_SELF", "LAST_SUPER_ADMIN", "EMAIL_TAKEN", "PASSWORD_TOO_SHORT", "INVALID_OR_EXPIRED"]) {
      assert.ok((adminTh.errors as Record<string, string>)[code], code);
    }
  });

  it("format substitutes placeholders", () => {
    assert.equal(format("Hello, {name} ({n})", { name: "A", n: 3 }), "Hello, A (3)");
  });
});

describe("admin CMS dictionaries (Phase 9)", () => {
  it("TH, EN and ZH-CN have identical keys and no empty strings", async () => {
    const { cmsTh, cmsEn, cmsZhCN } = await import("../../src/shared/i18n/admin-cms-messages.ts");
    const ref = keys(cmsTh).sort();
    for (const dict of [cmsEn, cmsZhCN]) {
      assert.deepEqual(keys(dict).sort(), ref);
      assert.ok(values(dict).every((v) => v.trim().length > 0));
    }
  });

  it("every Phase 9 error code and every CMS field has a label", async () => {
    const { cmsTh } = await import("../../src/shared/i18n/admin-cms-messages.ts");
    const { ENTITIES } = await import("../../src/shared/cms-schema.ts");
    for (const code of ["BOOKING_STATUS_INVALID", "STAY_NOT_STARTED", "CATEGORY_NOT_EMPTY", "SLIDE_ENDED", "WRONG_MEDIA_PURPOSE",
      "CAPACITY_BELOW_USED", "ORDER_CHANGED", "FOOD_ORDER_STATUS_TRANSITION", "BOOKING_NOT_CONFIRMED", "NO_THEME_DRAFT",
      "CAPI_TOKEN_MISSING", "INVALID_COLOR", "RESERVED_PATH", "INVALID_URL", "INVALID_PATH", "TAKEN"]) {
      assert.ok((cmsTh.errors as Record<string, string>)[code], code);
    }
    for (const def of Object.values(ENTITIES)) {
      for (const f of [...def.fields, ...def.translations]) assert.ok((cmsTh.fields as Record<string, string>)[f.key], `${def.name}.${f.key}`);
      for (const f of def.fields) {
        if (f.kind !== "enum") continue;
        for (const v of f.values ?? []) {
          const enums = cmsTh.enums as Record<string, string>;
          assert.ok(enums[`${f.key}:${v}`] ?? enums[String(v)], `${def.name}.${f.key}=${v}`);
        }
      }
    }
  });
});

describe("LINE dictionaries (Phase 11)", () => {
  it("admin LINE texts: TH, EN and ZH-CN have identical keys and no empty strings", async () => {
    const { lineTh, lineEn, lineZhCN } = await import("../../src/shared/i18n/admin-line-messages.ts");
    const ref = keys(lineTh).sort();
    for (const dict of [lineEn, lineZhCN]) {
      assert.deepEqual(keys(dict).sort(), ref);
      assert.ok(values(dict).every((v) => v.trim().length > 0));
    }
  });

  it("every notification type, status and skip reason has a label; every LINE API error has a message", async () => {
    const { lineTh } = await import("../../src/shared/i18n/admin-line-messages.ts");
    const { NOTIFICATION_TYPES, NOTIFICATION_STATUSES } = await import("../../src/shared/line-types.ts");
    for (const t of NOTIFICATION_TYPES) assert.ok(lineTh.log.types[t], t);
    for (const s of NOTIFICATION_STATUSES) assert.ok(lineTh.log.statuses[s], s);
    for (const r of ["EMPTY", "NOT_RELEVANT", "RECIPIENT_INACTIVE", "RECIPIENT_OPTED_OUT", "LINE_DISABLED", "EXPIRED", "NOT_LINKED", "GUEST_DISABLED", "TOKEN_MISSING", "CANCELLED_BY_STAFF", "MAX_ATTEMPTS", "NETWORK", "TIMEOUT"]) {
      assert.ok((lineTh.log.reasons as Record<string, string>)[r], r);
    }
    for (const code of ["LINE_TOKEN_MISSING", "LINE_SECRET_MISSING", "LINE_NOT_CHECKED", "LINE_URL_MISSING", "LINE_DISABLED", "LINE_TOKEN_INVALID", "LINE_UNAVAILABLE", "LINE_RECIPIENT_EXISTS", "NOTIFICATION_NOT_RETRYABLE", "NOTIFICATION_NOT_PENDING"]) {
      assert.ok((lineTh.errors as Record<string, string>)[code], code);
    }
  });
});

describe("Phase 12 dictionaries (images, fonts, content pages)", () => {
  it("public content texts: TH, EN and ZH-CN have identical keys and no empty strings", async () => {
    const { contentTh, contentEn, contentZhCN } = await import("../../src/shared/i18n/content-messages.ts");
    const ref = keys(contentTh).sort();
    for (const dict of [contentEn, contentZhCN]) {
      assert.deepEqual(keys(dict).sort(), ref);
      assert.ok(values(dict).every((v) => v.trim().length > 0));
    }
  });

  it("every image / font error code has a message in every admin language", async () => {
    const { cmsTh } = await import("../../src/shared/i18n/admin-cms-messages.ts");
    for (const code of ["FONT_TOO_LARGE", "UNSUPPORTED_FONT", "FONT_FACE_EXISTS", "FONT_IN_USE", "FONT_NOT_FOUND",
      "NOT_A_RENDITION", "DUPLICATE_WIDTH", "TOO_MANY", "NOT_ALLOWED", "UNSUPPORTED_IMAGE", "IMAGE_TOO_LARGE_DIMENSIONS"]) {
      for (const dict of [adminTh, adminEn, adminZhCN]) assert.ok((dict.errors as Record<string, string>)[code], code);
    }
    assert.ok(cmsTh.theme.fonts.upload);
  });
});

describe("Phase 13 dictionaries (SEO, search, translation coverage)", () => {
  it("SEO descriptions and search texts: TH, EN and ZH-CN have identical keys and no empty strings", async () => {
    const { seoTh, seoEn, seoZhCN } = await import("../../src/shared/i18n/seo-messages.ts");
    const { searchTh, searchEn, searchZhCN } = await import("../../src/shared/i18n/search-messages.ts");
    for (const [ref, others] of [[seoTh, [seoEn, seoZhCN]], [searchTh, [searchEn, searchZhCN]]] as const) {
      for (const dict of others) {
        assert.deepEqual(keys(dict).sort(), keys(ref).sort());
        assert.ok(values(dict).every((v) => v.trim().length > 0));
      }
    }
  });

  it("every search result type and translation-coverage group has a label", async () => {
    const { searchTh } = await import("../../src/shared/i18n/search-messages.ts");
    const { cmsTh, cmsEn, cmsZhCN } = await import("../../src/shared/i18n/admin-cms-messages.ts");
    const { SEARCH_ENTITY_TYPES } = await import("../../src/shared/search-types.ts");
    const { TRANSLATION_KINDS } = await import("../../src/shared/seo-types.ts");
    for (const t of SEARCH_ENTITY_TYPES) assert.ok(searchTh.types[t], t);
    for (const dict of [cmsTh, cmsEn, cmsZhCN]) for (const k of TRANSLATION_KINDS) assert.ok(dict.seo.kinds[k], k);
    assert.equal(searchTh.placeholder, "ค้นหาที่พัก อาหาร หรือกิจกรรม...", "spec §40 wording");
  });
});
