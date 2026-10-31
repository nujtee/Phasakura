-- Migration 0050: health massage (นวดเพื่อสุขภาพ), chosen by the guest on the booking page ("รายการเพิ่มเติม").
-- Non-destructive: settings (one row, OFF), the owner's menu (treatments, each with its own lengths and prices) and a
-- per-booking snapshot table with guard triggers. No existing row or table changes.
--
-- The money is paid in full at booking, like food: it is counted in bookings.food_subtotal_satang (the "paid now"
-- extras), and booking_massages tells it apart. A massage follows its booking's status (a cancelled booking takes
-- its massages with it) — nothing to update here. The starting menu below is a sample the owner edits (still OFF).

CREATE TABLE massage_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO massage_settings (id) VALUES (1);

-- One treatment of the menu (names per language; TH is required).
CREATE TABLE massage_items (
  id          TEXT PRIMARY KEY,
  name_th     TEXT NOT NULL CHECK (length(trim(name_th)) BETWEEN 1 AND 120),
  name_en     TEXT CHECK (name_en IS NULL OR length(name_en) <= 120),
  name_zh     TEXT CHECK (name_zh IS NULL OR length(name_zh) <= 120),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Its lengths and prices (e.g. 60 min ฿350, 120 min ฿700).
CREATE TABLE massage_options (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES massage_items (id) ON DELETE CASCADE,
  minutes       INTEGER NOT NULL CHECK (minutes BETWEEN 10 AND 480),
  price_satang  INTEGER NOT NULL CHECK (price_satang BETWEEN 0 AND 10000000),
  UNIQUE (item_id, minutes)
) STRICT;

CREATE INDEX ix_massage_options_item ON massage_options (item_id);

-- What a booking took: name, length and price at booking time; never changes afterwards.
CREATE TABLE booking_massages (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings (id),
  option_id     TEXT NOT NULL,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  minutes       INTEGER NOT NULL CHECK (minutes BETWEEN 10 AND 480),
  price_satang  INTEGER NOT NULL CHECK (price_satang >= 0),
  quantity      INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  subtotal_satang INTEGER NOT NULL CHECK (subtotal_satang = quantity * price_satang),
  captured_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX ix_booking_massages_booking ON booking_massages (booking_id);

CREATE TRIGGER trg_booking_massages_frozen BEFORE UPDATE ON booking_massages
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER trg_booking_massages_no_delete BEFORE DELETE ON booking_massages
BEGIN
  SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE');
END;

-- Only while massage is offered and the treatment is on the menu.
CREATE TRIGGER trg_booking_massages_check BEFORE INSERT ON booking_massages
WHEN COALESCE((SELECT is_enabled FROM massage_settings WHERE id = 1), 0) <> 1
  OR NOT EXISTS (SELECT 1 FROM massage_options o JOIN massage_items i ON i.id = o.item_id WHERE o.id = NEW.option_id AND i.is_active = 1)
BEGIN
  SELECT RAISE(ABORT, 'MASSAGE_UNAVAILABLE');
END;

-- Sample menu (the owner changes names, lengths and prices; massage stays OFF until switched on).
INSERT INTO massage_items (id, name_th, name_en, sort_order) VALUES
  ('massage_thai',     'นวดแผนไทย',              'Traditional Thai Massage', 1),
  ('massage_balm',     'นวดไทย+ยาหม่อง',          'Thai Balm Massage',        2),
  ('massage_oil',      'นวดน้ำมัน',               'Oil Massage',              3),
  ('massage_foot',     'นวดเท้า',                 'Foot Massage',             4),
  ('massage_neck',     'นวดคอ บ่า ไหล่',           'Neck, Shoulder Massage',   5),
  ('massage_hotstone', 'นวดหินร้อนออยสมุนไพร',     'Hot Stone Massage',        6),
  ('massage_golden',   'นวดออยทองคำ',             'Golden Oil Massage',       7),
  ('massage_ear',      'ทรีทเม้นท์หู',             'Ear Spa',                  8),
  ('massage_footspa',  'ทรีทเม้นท์เท้า',           'Foot Spa',                 9);

INSERT INTO massage_options (id, item_id, minutes, price_satang) VALUES
  ('massage_thai_60', 'massage_thai', 60, 35000),         ('massage_thai_120', 'massage_thai', 120, 70000),
  ('massage_balm_60', 'massage_balm', 60, 40000),         ('massage_balm_120', 'massage_balm', 120, 80000),
  ('massage_oil_60', 'massage_oil', 60, 45000),           ('massage_oil_120', 'massage_oil', 120, 90000),
  ('massage_foot_60', 'massage_foot', 60, 35000),         ('massage_foot_120', 'massage_foot', 120, 70000),
  ('massage_neck_60', 'massage_neck', 60, 35000),         ('massage_neck_120', 'massage_neck', 120, 70000),
  ('massage_hotstone_60', 'massage_hotstone', 60, 60000), ('massage_hotstone_120', 'massage_hotstone', 120, 119900),
  ('massage_golden_60', 'massage_golden', 60, 70000),     ('massage_golden_120', 'massage_golden', 120, 140000),
  ('massage_ear_60', 'massage_ear', 60, 69900),           ('massage_ear_120', 'massage_ear', 120, 120000),
  ('massage_footspa_60', 'massage_footspa', 60, 39900),   ('massage_footspa_120', 'massage_footspa', 120, 79900);
