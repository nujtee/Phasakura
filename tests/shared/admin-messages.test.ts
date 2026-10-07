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
