/**
 * Database-level business rules (spec §15–18, §20–22, §25–27, §32–33, §51, §62).
 * Each test runs against the real migrations in SQLite, using D1-style atomic batches.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { D1PreparedStatementLike } from "../../src/worker/env.ts";
import { SqliteD1 } from "../helpers/sqlite-d1.ts";

let db: SqliteD1;
beforeEach(() => {
  db = SqliteD1.migrated({ seed: true });
});

function stayNights(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  for (let d = new Date(`${checkIn}T00:00:00Z`); d < new Date(`${checkOut}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    nights.push(d.toISOString().slice(0, 10));
  }
  return nights;
}

let seq = 0;
function bookingStatements(opts: {
  unitId?: string;
  itemType?: "HOUSE" | "VIP_TENT" | "OWN_TENT";
  checkIn: string;
  checkOut: string;
  tents?: number;
}): { id: string; statements: D1PreparedStatementLike[] } {
  seq += 1;
  const id = `b${seq}`;
  const itemId = `i${seq}`;
  const nights = stayNights(opts.checkIn, opts.checkOut);
  const code = `BK-${opts.checkIn.replaceAll("-", "")}-${String(seq).padStart(4, "0")}`;
  const statements: D1PreparedStatementLike[] = [
    db
      .prepare(
        `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults,
           customer_name, customer_phone, customer_phone_normalized,
           accommodation_subtotal_satang, subtotal_satang, total_satang)
         VALUES (?1, ?2, 'th', ?3, ?4, ?5, 2, 'Test Guest', '081-000-0000', '0810000000', 100000, 100000, 100000)`,
      )
      .bind(id, code, opts.checkIn, opts.checkOut, nights.length),
    db
      .prepare("INSERT INTO booking_items (id, booking_id, item_type, unit_id, quantity, adults) VALUES (?1, ?2, ?3, ?4, ?5, 2)")
      .bind(itemId, id, opts.itemType ?? "HOUSE", opts.unitId ?? null, opts.tents ?? 1),
  ];
  if (opts.unitId) {
    for (const night of nights) {
      statements.push(
        db
          .prepare("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES (?1, ?2, ?3, ?4)")
          .bind(opts.unitId, night, id, itemId),
      );
    }
  }
  if (opts.itemType === "OWN_TENT") {
    for (const night of nights) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO camping_night_inventory (stay_date, max_tents)
             SELECT ?1, max_tents_per_night FROM camping_settings WHERE id = 1`,
          )
          .bind(night),
        db
          .prepare("UPDATE camping_night_inventory SET tents_used = tents_used + ?2 WHERE stay_date = ?1")
          .bind(night, opts.tents ?? 1),
      );
    }
  }
  return { id, statements };
}

const count = (sql: string, ...p: (string | number)[]) => db.get<{ n: number }>(sql, ...p)!.n;

describe("double booking (§15, §16)", () => {
  it("locks every stay night; check-out day is not a night", async () => {
    const { id, statements } = bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-10", checkOut: "2027-01-13" });
    await db.batch(statements);
    assert.deepEqual(
      db.all<{ stay_date: string }>("SELECT stay_date FROM booking_unit_nights WHERE booking_id = ? ORDER BY 1", id).map((r) => r.stay_date),
      ["2027-01-10", "2027-01-11", "2027-01-12"],
    );
    assert.equal(db.get<{ nights: number }>("SELECT nights FROM bookings WHERE id = ?", id)!.nights, 3);
  });

  it("rejects an overlapping booking and rolls back the whole batch", async () => {
    await db.batch(bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-10", checkOut: "2027-01-13" }).statements);
    const second = bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-12", checkOut: "2027-01-14" });
    await assert.rejects(db.batch(second.statements), /UNIQUE constraint failed: booking_unit_nights/);
    assert.equal(count("SELECT COUNT(*) AS n FROM bookings WHERE id = ?", second.id), 0, "booking row rolled back");
    assert.equal(count("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE stay_date = '2027-01-13'"), 0, "no partial nights");
  });

  it("allows back-to-back stays (check-in on another guest's check-out day)", async () => {
    await db.batch(bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-10", checkOut: "2027-01-13" }).statements);
    await db.batch(bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-13", checkOut: "2027-01-15" }).statements);
    assert.equal(count("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE unit_id = 'dev_house_01'"), 5);
  });

  it("keeps each house / VIP tent as separate inventory", async () => {
    await db.batch(bookingStatements({ unitId: "dev_house_01", checkIn: "2027-01-10", checkOut: "2027-01-11" }).statements);
    await db.batch(bookingStatements({ unitId: "dev_house_02", checkIn: "2027-01-10", checkOut: "2027-01-11" }).statements);
    await db.batch(bookingStatements({ unitId: "dev_vip_01", itemType: "VIP_TENT", checkIn: "2027-01-10", checkOut: "2027-01-11" }).statements);
    assert.equal(count("SELECT COUNT(*) AS n FROM booking_unit_nights WHERE stay_date = '2027-01-10'"), 3);
  });

  it("blocks admin-blocked dates", async () => {
    db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, block_reason) VALUES ('dev_vip_02', '2027-02-01', 'Maintenance')");
    await assert.rejects(
      db.batch(bookingStatements({ unitId: "dev_vip_02", itemType: "VIP_TENT", checkIn: "2027-02-01", checkOut: "2027-02-02" }).statements),
      /UNIQUE/,
    );
  });

  it("rejects night-locks outside the booking's stay", async () => {
    const { id, statements } = bookingStatements({ checkIn: "2027-03-01", checkOut: "2027-03-02", itemType: "OWN_TENT" });
    await db.batch(statements);
    assert.throws(
      () => db.run("INSERT INTO booking_unit_nights (unit_id, stay_date, booking_id, booking_item_id) VALUES ('dev_house_01', '2027-03-02', ?, ?)", id, `i${seq}`),
      /STAY_NIGHT_OUT_OF_RANGE/,
    );
  });

  it("rejects an item whose type does not match the unit", async () => {
    await assert.rejects(
      db.batch(bookingStatements({ unitId: "dev_vip_01", itemType: "HOUSE", checkIn: "2027-01-10", checkOut: "2027-01-11" }).statements),
      /BOOKING_ITEM_UNIT_TYPE_MISMATCH/,
    );
  });
});

describe("booking record integrity (§14, §15, §17)", () => {
  const insert = (overrides: Record<string, string | number>) => {
    const v = {
      id: "bx", code: "BK-20270110-AB12", check_in: "2027-01-10", check_out: "2027-01-13", nights: 3,
      acc: 300000, food: 0, sub: 300000, disc: 0, total: 300000, ...overrides,
    };
    db.run(
      `INSERT INTO bookings (id, booking_code, language_code, check_in, check_out, nights, adults, customer_name,
         customer_phone, customer_phone_normalized, accommodation_subtotal_satang, food_subtotal_satang,
         subtotal_satang, discount_satang, total_satang)
       VALUES (?, ?, 'th', ?, ?, ?, 2, 'Guest', '0810000000', '0810000000', ?, ?, ?, ?, ?)`,
      v.id, v.code, v.check_in, v.check_out, v.nights, v.acc, v.food, v.sub, v.disc, v.total,
    );
  };

  it("accepts a consistent booking", () => {
    insert({});
    assert.equal(count("SELECT COUNT(*) AS n FROM bookings"), 1);
  });

  it("enforces the BK-YYYYMMDD-XXXX format and uniqueness", () => {
    assert.throws(() => insert({ code: "BK-2027-1" }), /CHECK/);
    assert.throws(() => insert({ code: "bk-20270110-ab12" }), /CHECK/);
    insert({});
    assert.throws(() => insert({ id: "by" }), /UNIQUE constraint failed: bookings.booking_code/);
  });

  it("enforces nights = check_out - check_in and check_out > check_in", () => {
    assert.throws(() => insert({ nights: 2 }), /CHECK/);
    assert.throws(() => insert({ check_out: "2027-01-10", nights: 0 }), /CHECK/);
    assert.throws(() => insert({ check_in: "2027-02-30", nights: 3 }), /CHECK/, "invalid calendar date");
  });

  it("enforces money arithmetic (subtotal, discount, total)", () => {
    assert.throws(() => insert({ total: 299999 }), /CHECK/);
    assert.throws(() => insert({ sub: 300001 }), /CHECK/);
    assert.throws(() => insert({ disc: 400000, total: -100000 }), /CHECK/);
    insert({ food: 50000, sub: 350000, disc: 10000, total: 340000 });
  });

  it("forbids deleting bookings", () => {
    insert({});
    assert.throws(() => db.run("DELETE FROM bookings WHERE id = 'bx'"), /BOOKING_DELETE_FORBIDDEN/);
  });
});

describe("camping shared capacity (§12.3, §18)", () => {
  const used = (date: string) =>
    db.get<{ tents_used: number }>("SELECT tents_used FROM camping_night_inventory WHERE stay_date = ?", date)?.tents_used ?? 0;

  it("tracks tents per night: 3 + 5 used → 22 remaining of 30", async () => {
    await db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 3, checkIn: "2027-04-10", checkOut: "2027-04-11" }).statements);
    await db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 5, checkIn: "2027-04-10", checkOut: "2027-04-11" }).statements);
    const row = db.get<{ max_tents: number; tents_used: number }>("SELECT * FROM camping_night_inventory WHERE stay_date = '2027-04-10'")!;
    assert.equal(row.tents_used, 8);
    assert.equal(row.max_tents - row.tents_used, 22);
  });

  it("rejects a request that would exceed capacity, leaving counts unchanged", async () => {
    await db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 28, checkIn: "2027-04-10", checkOut: "2027-04-11" }).statements);
    const over = bookingStatements({ itemType: "OWN_TENT", tents: 3, checkIn: "2027-04-10", checkOut: "2027-04-11" });
    await assert.rejects(db.batch(over.statements), /CHECK constraint failed/);
    assert.equal(used("2027-04-10"), 28);
    assert.equal(count("SELECT COUNT(*) AS n FROM bookings WHERE id = ?", over.id), 0);
  });

  it("checks every night of a multi-night stay (one full night fails the whole booking)", async () => {
    await db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 30, checkIn: "2027-04-12", checkOut: "2027-04-13" }).statements);
    await assert.rejects(
      db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 1, checkIn: "2027-04-11", checkOut: "2027-04-14" }).statements),
      /CHECK constraint failed/,
    );
    assert.equal(used("2027-04-11"), 0, "earlier night not incremented");
    assert.equal(used("2027-04-13"), 0, "later night not incremented");
  });

  it("does not let an admin lower capacity below tents already sold", async () => {
    await db.batch(bookingStatements({ itemType: "OWN_TENT", tents: 10, checkIn: "2027-04-10", checkOut: "2027-04-11" }).statements);
    assert.throws(() => db.run("UPDATE camping_night_inventory SET max_tents = 9 WHERE stay_date = '2027-04-10'"), /CHECK/);
    db.run("UPDATE camping_night_inventory SET max_tents = 10 WHERE stay_date = '2027-04-10'");
  });
});

describe("food capacity (§22)", () => {
  const reserve = (qty: number) =>
    db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO food_daily_capacity (food_category_id, service_date, max_quantity)
           SELECT id, ?2, default_daily_capacity FROM food_categories WHERE id = ?1`,
        )
        .bind("dev_food_dinner", "2027-05-01"),
      db
        .prepare("UPDATE food_daily_capacity SET used_quantity = used_quantity + ?3 WHERE food_category_id = ?1 AND service_date = ?2")
        .bind("dev_food_dinner", "2027-05-01", qty),
    ]);

  it("Dinner max 50, used 48, request 5 → rejected; 2 remaining still bookable", async () => {
    await reserve(48);
    await assert.rejects(reserve(5), /CHECK constraint failed/);
    await reserve(2);
    const row = db.get<{ used_quantity: number }>("SELECT used_quantity FROM food_daily_capacity WHERE food_category_id = 'dev_food_dinner'")!;
    assert.equal(row.used_quantity, 50);
  });
});

describe("snapshots are immutable (§17, §20, §25, §62)", () => {
  async function bookingWithSnapshots() {
    const { id, statements } = bookingStatements({ unitId: "dev_house_01", checkIn: "2027-06-01", checkOut: "2027-06-03" });
    const itemId = `i${seq}`;
    await db.batch(statements);
    db.run(
      `INSERT INTO booking_price_snapshots (id, booking_id, booking_item_id, unit_id, unit_name_snapshot, unit_type,
         price_snapshot_satang, pricing_type, quantity, number_of_nights, adult_count, child_count, subtotal_satang, total_satang)
       VALUES ('ps1', ?, ?, 'dev_house_01', 'House 01 — บ้านซากุระ', 'HOUSE', 350000, 'PER_UNIT_NIGHT', 1, 2, 2, 0, 700000, 700000)`,
      id, itemId,
    );
    db.run(
      `INSERT INTO payment_account_snapshots (booking_id, receiving_account_id, bank_name_snapshot, account_name_snapshot, account_number_snapshot)
       SELECT ?, id, bank_name, account_name, account_number FROM receiving_accounts WHERE id = 'dev_account_01'`,
      id,
    );
    db.run(
      `INSERT INTO booking_included_meals (id, booking_id, booking_item_id, included_meal_id, food_category_id, food_option_id,
         meal_name_snapshot, persons_per_night_snapshot, number_of_nights)
       VALUES ('im1', ?, ?, 'dev_incl_sakura_breakfast', 'dev_food_breakfast', 'dev_food_breakfast_a', 'Breakfast A', 2, 2)`,
      id, itemId,
    );
    return id;
  }

  it("changing a unit price later does not change the booking snapshot", async () => {
    await bookingWithSnapshots();
    db.run("UPDATE accommodation_units SET base_price_satang = 999900 WHERE id = 'dev_house_01'");
    assert.equal(db.get<{ p: number }>("SELECT price_snapshot_satang AS p FROM booking_price_snapshots WHERE id = 'ps1'")!.p, 350000);
  });

  it("rejects UPDATE/DELETE on price, payment-account and included-meal snapshots", async () => {
    const id = await bookingWithSnapshots();
    assert.throws(() => db.run("UPDATE booking_price_snapshots SET price_snapshot_satang = 1 WHERE id = 'ps1'"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => db.run("DELETE FROM booking_price_snapshots WHERE id = 'ps1'"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => db.run("UPDATE payment_account_snapshots SET account_number_snapshot = '1' WHERE booking_id = ?", id), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => db.run("UPDATE booking_included_meals SET persons_per_night_snapshot = 9 WHERE id = 'im1'"), /SNAPSHOT_IMMUTABLE/);
  });

  it("changing the receiving account does not change the booking's snapshot", async () => {
    const id = await bookingWithSnapshots();
    db.run("UPDATE receiving_accounts SET account_number = '999-9-99999-9' WHERE id = 'dev_account_01'");
    assert.equal(
      db.get<{ n: string }>("SELECT account_number_snapshot AS n FROM payment_account_snapshots WHERE booking_id = ?", id)!.n,
      "000-0-00000-0",
    );
  });

  it("booking food items: status can change, prices cannot", async () => {
    const { id, statements } = bookingStatements({ unitId: "dev_house_02", checkIn: "2027-06-01", checkOut: "2027-06-02" });
    await db.batch(statements);
    db.run(
      `INSERT INTO booking_food_items (id, booking_id, food_option_id, service_date, option_name_snapshot, category_code_snapshot,
         pricing_type_snapshot, unit_price_snapshot_satang, child_pricing_snapshot, adults, quantity, included_quantity, subtotal_satang)
       VALUES ('fi1', ?, 'dev_food_dinner_a', '2027-06-01', 'Dinner A', 'DINNER', 'PER_PERSON', 25000, 'FULL', 4, 4, 2, 50000)`,
      id,
    );
    db.run("UPDATE booking_food_items SET status = 'CANCELLED' WHERE id = 'fi1'");
    assert.throws(() => db.run("UPDATE booking_food_items SET unit_price_snapshot_satang = 1 WHERE id = 'fi1'"), /SNAPSHOT_IMMUTABLE/);
    assert.throws(() => db.run("UPDATE booking_food_items SET included_quantity = 0 WHERE id = 'fi1'"), /SNAPSHOT_IMMUTABLE/);
  });
});

describe("payments and slips (§25–27)", () => {
  async function booking() {
    const { id, statements } = bookingStatements({ unitId: "dev_vip_03", itemType: "VIP_TENT", checkIn: "2027-07-01", checkOut: "2027-07-02" });
    await db.batch(statements);
    return id;
  }
  const slipAsset = (id: string, sha: string) =>
    db.run(
      `INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256)
       VALUES (?, 'PRIVATE', ?, 'PAYMENT_SLIP', 'image/jpeg', 1000, ?)`,
      id, `slips/2027/07/${id}.jpg`, sha,
    );
  const sha = (c: string) => c.repeat(64);

  it("allows only one primary receiving account", () => {
    assert.throws(
      () => db.run("INSERT INTO receiving_accounts (id, bank_name, account_name, promptpay_number, is_primary) VALUES ('a2', 'X', 'Y', '0999999999', 1)"),
      /UNIQUE/,
    );
  });

  it("slips must live in the PRIVATE bucket", () => {
    assert.throws(
      () => db.run("INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('m1', 'PUBLIC', 'slips/a.jpg', 'PAYMENT_SLIP', 'image/jpeg', 10, ?)", sha("a")),
      /CHECK/,
    );
  });

  it("a payment cannot reference a public image as its slip", async () => {
    const id = await booking();
    db.run("INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('pub', 'PUBLIC', 'gallery/x.jpg', 'GALLERY', 'image/jpeg', 10, ?)", sha("b"));
    assert.throws(
      () => db.run("INSERT INTO payments (id, booking_id, amount_satang, method, slip_asset_id) VALUES ('p1', ?, 1000, 'PROMPTPAY', 'pub')", id),
      /SLIP_MUST_BE_PRIVATE/,
    );
  });

  it("rejects a duplicate slip image on a live payment, allows re-upload after rejection", async () => {
    const id = await booking();
    slipAsset("s1", sha("c"));
    slipAsset("s2", sha("d"));
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method, slip_asset_id, slip_sha256) VALUES ('p1', ?, 1000, 'PROMPTPAY', 's1', ?)", id, sha("c"));
    assert.throws(
      () => db.run("INSERT INTO payments (id, booking_id, amount_satang, method, slip_asset_id, slip_sha256) VALUES ('p2', ?, 1000, 'PROMPTPAY', 's2', ?)", id, sha("c")),
      /UNIQUE/,
    );
    db.run("UPDATE payments SET status = 'REJECTED', rejected_reason = 'Unreadable' WHERE id = 'p1'");
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method, slip_asset_id, slip_sha256) VALUES ('p2', ?, 1000, 'PROMPTPAY', 's2', ?)", id, sha("c"));
  });

  it("a bank transaction reference can pass verification only once", async () => {
    const id = await booking();
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method) VALUES ('p1', ?, 1000, 'PROMPTPAY')", id);
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method) VALUES ('p2', ?, 1000, 'PROMPTPAY')", id);
    db.run("INSERT INTO slip_verifications (id, payment_id, method, provider, result, transaction_ref) VALUES ('v1', 'p1', 'AUTO', 'svc', 'PASSED', 'TX123')");
    assert.throws(
      () => db.run("INSERT INTO slip_verifications (id, payment_id, method, provider, result, transaction_ref) VALUES ('v2', 'p2', 'AUTO', 'svc', 'PASSED', 'TX123')"),
      /UNIQUE/,
    );
    db.run("INSERT INTO slip_verifications (id, payment_id, method, provider, result, failure_code, transaction_ref) VALUES ('v3', 'p2', 'AUTO', 'svc', 'FAILED', 'DUPLICATE_TRANSACTION', 'TX123')");
  });

  it("payments cannot be deleted and verification records cannot be edited", async () => {
    const id = await booking();
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method) VALUES ('p1', ?, 1000, 'CASH')", id);
    db.run("INSERT INTO slip_verifications (id, payment_id, method, provider, result) VALUES ('v1', 'p1', 'AUTO', 'svc', 'ERROR')");
    assert.throws(() => db.run("DELETE FROM payments WHERE id = 'p1'"), /PAYMENT_DELETE_FORBIDDEN/);
    assert.throws(() => db.run("UPDATE slip_verifications SET result = 'PASSED' WHERE id = 'v1'"), /SLIP_VERIFICATION_IMMUTABLE/);
  });

  it("a rejected payment requires a reason", async () => {
    const id = await booking();
    db.run("INSERT INTO payments (id, booking_id, amount_satang, method) VALUES ('p1', ?, 1000, 'CASH')", id);
    assert.throws(() => db.run("UPDATE payments SET status = 'REJECTED' WHERE id = 'p1'"), /CHECK/);
  });
});

describe("users, soft delete and SUPER_ADMIN rules (§32, §33)", () => {
  const addUser = (id: string, roleCode: string | null) => {
    db.run("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, 'pbkdf2$test')", id, `${id}@example.test`, id);
    if (roleCode) db.run("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE code = ?", id, roleCode);
  };
  const softDelete = (id: string) =>
    db.run("UPDATE users SET status = 'DELETED', deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = NULL WHERE id = ?", id);

  it("forbids hard-deleting users", () => {
    addUser("u1", "VIEWER");
    assert.throws(() => db.run("DELETE FROM users WHERE id = 'u1'"), /USER_HARD_DELETE_FORBIDDEN/);
  });

  it("soft delete requires deleted_at, and restore clears it", () => {
    addUser("u1", "VIEWER");
    assert.throws(() => db.run("UPDATE users SET status = 'DELETED' WHERE id = 'u1'"), /CHECK/);
    softDelete("u1");
    db.run("UPDATE users SET status = 'ACTIVE', deleted_at = NULL WHERE id = 'u1'");
  });

  it("emails are unique case-insensitively", () => {
    addUser("u1", null);
    assert.throws(
      () => db.run("INSERT INTO users (id, email, display_name, password_hash) VALUES ('u2', 'U1@EXAMPLE.TEST', 'x', 'h')"),
      /UNIQUE/,
    );
  });

  it("cannot suspend, delete or demote the last active SUPER_ADMIN", () => {
    addUser("root", "SUPER_ADMIN");
    assert.throws(() => db.run("UPDATE users SET status = 'SUSPENDED' WHERE id = 'root'"), /LAST_SUPER_ADMIN/);
    assert.throws(() => softDelete("root"), /LAST_SUPER_ADMIN/);
    assert.throws(() => db.run("DELETE FROM user_roles WHERE user_id = 'root'"), /LAST_SUPER_ADMIN/);
  });

  it("can remove a SUPER_ADMIN when another active one remains", () => {
    addUser("root", "SUPER_ADMIN");
    addUser("root2", "SUPER_ADMIN");
    db.run("DELETE FROM user_roles WHERE user_id = 'root2'");
    assert.throws(() => db.run("DELETE FROM user_roles WHERE user_id = 'root'"), /LAST_SUPER_ADMIN/);
  });

  it("a suspended SUPER_ADMIN does not count as the remaining one", () => {
    addUser("root", "SUPER_ADMIN");
    addUser("root2", "SUPER_ADMIN");
    db.run("UPDATE users SET status = 'SUSPENDED' WHERE id = 'root2'");
    assert.throws(() => softDelete("root"), /LAST_SUPER_ADMIN/);
  });

  it("soft-deleted users keep their bookings/audit history (no cascades)", () => {
    addUser("root", "SUPER_ADMIN");
    addUser("staff", "BOOKING_ADMIN");
    db.run("INSERT INTO audit_logs (id, user_id, action, module) VALUES ('a1', 'staff', 'UPDATE', 'bookings')");
    softDelete("staff");
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_logs WHERE user_id = 'staff'"), 1);
  });

  it("sessions store only token hashes and require a reason when revoked", () => {
    addUser("u1", "VIEWER");
    assert.throws(
      () => db.run("INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at) VALUES ('s1', 'u1', 'h', '2030-01-01', '2026-01-01')"),
      /CHECK/,
    );
  });
});

describe("audit log is append-only (§51)", () => {
  it("rejects UPDATE and DELETE", () => {
    db.run("INSERT INTO audit_logs (id, action, module, new_value) VALUES ('a1', 'UPDATE', 'pricing', '{\"price\":1}')");
    assert.throws(() => db.run("UPDATE audit_logs SET action = 'X' WHERE id = 'a1'"), /AUDIT_LOG_IMMUTABLE/);
    assert.throws(() => db.run("DELETE FROM audit_logs WHERE id = 'a1'"), /AUDIT_LOG_IMMUTABLE/);
  });

  it("requires JSON for old/new values", () => {
    assert.throws(() => db.run("INSERT INTO audit_logs (id, action, module, new_value) VALUES ('a2', 'U', 'm', 'not json')"), /CHECK/);
  });
});

describe("media, content and settings guards (§36, §43, §55)", () => {
  it("rejects unsafe R2 object keys and non-image MIME types", () => {
    const insert = (key: string, mime = "image/webp") =>
      db.run(
        "INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES (?, 'PUBLIC', ?, 'GALLERY', ?, 10, ?)",
        key, key, mime, "e".repeat(64),
      );
    for (const bad of ["../x.webp", "a/../b.webp", "/abs.webp", "a//b.webp", "a b.webp", "x.webp?y=1"]) {
      assert.throws(() => insert(bad), /CHECK/, bad);
    }
    assert.throws(() => insert("ok/evil.svg", "image/svg+xml"), /CHECK/, "SVG rejected");
    assert.throws(() => insert("ok/evil.html", "text/html"), /CHECK/);
    insert("gallery/2027/01/ok.webp");
  });

  it("cannot enable GA4 / Meta Pixel without an ID; IDs are format-checked", () => {
    assert.throws(() => db.run("UPDATE marketing_settings SET ga4_enabled = 1 WHERE id = 1"), /CHECK/);
    assert.throws(() => db.run("UPDATE marketing_settings SET ga4_measurement_id = '<script>' WHERE id = 1"), /CHECK/);
    db.run("UPDATE marketing_settings SET ga4_enabled = 1, ga4_measurement_id = 'G-ABC123' WHERE id = 1");
    assert.throws(() => db.run("UPDATE marketing_settings SET meta_pixel_id = '12ab' WHERE id = 1"), /CHECK/);
  });

  it("content links must be relative or https (no javascript:, no protocol-relative)", () => {
    for (const bad of ["javascript:alert(1)", "//evil.com", "http://evil.com"]) {
      assert.throws(
        () => db.run("INSERT INTO history_translations (section_id, language_code, button_url) VALUES ('dev_history_intro', 'en', ?)", bad),
        /CHECK/,
        bad,
      );
    }
  });

  it("only one PUBLISHED theme version at a time", () => {
    assert.throws(
      () => db.run("INSERT INTO theme_versions (id, version_number, preset, tokens_json, status) VALUES ('v2', 2, 'DARK', '{}', 'PUBLISHED')"),
      /UNIQUE/,
    );
  });

  it("translations must reference an enabled-language row", () => {
    assert.throws(
      () => db.run("INSERT INTO gallery_category_translations (category_id, language_code, name) VALUES ('dev_gallery_nature', 'fr', 'Nature')"),
      /FOREIGN KEY/,
    );
  });

  it("slide opacity and schedule are validated", () => {
    db.run("INSERT INTO media_assets (id, bucket, object_key, purpose, mime_type, size_bytes, sha256) VALUES ('hs', 'PUBLIC', 'home/s.webp', 'HOME_SLIDE', 'image/webp', 10, ?)", "f".repeat(64));
    assert.throws(() => db.run("INSERT INTO home_slides (id, desktop_asset_id, overlay_opacity) VALUES ('s1', 'hs', 150)"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO home_slides (id, desktop_asset_id, status) VALUES ('s1', 'hs', 'SCHEDULED')"), /CHECK/);
    assert.throws(
      () => db.run("INSERT INTO home_slides (id, desktop_asset_id, start_at, end_at) VALUES ('s1', 'hs', '2027-02-01', '2027-01-01')"),
      /CHECK/,
    );
  });
});
