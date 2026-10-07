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
