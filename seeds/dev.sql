-- ============================================================================
--  DEVELOPMENT SEED DATA ONLY — NEVER RUN AGAINST PRODUCTION (--remote)
--  Run with:  npm run db:seed:local   (after npm run db:migrate:local)
--  All names, prices and the bank account below are FAKE sample values.
--  No user accounts are seeded; create the first admin in Phase 3.
-- ============================================================================

-- Site -------------------------------------------------------------------------
INSERT INTO site_settings (id, default_language, timezone, currency, contact_phone, contact_email)
VALUES (1, 'th', 'Asia/Bangkok', 'THB', '000-000-0000', 'dev@example.invalid');

INSERT INTO site_setting_translations (language_code, site_name, tagline) VALUES
  ('th', 'Phasakura (ข้อมูลตัวอย่าง)', 'ที่พักท่ามกลางธรรมชาติ — ข้อมูลสำหรับพัฒนาเท่านั้น'),
  ('en', 'Phasakura (sample data)', 'A stay close to nature — development data only'),
  ('zh-CN', 'Phasakura（示例数据）', '亲近自然的住宿 — 仅供开发使用');

INSERT INTO branding_settings (id) VALUES (1);

INSERT INTO marketing_settings (id) VALUES (1);   -- everything disabled

INSERT INTO booking_cta_settings (id) VALUES (1);
INSERT INTO booking_cta_translations (language_code, label) VALUES
  ('th', 'จองที่พัก'), ('en', 'Book Now'), ('zh-CN', '立即预订');

INSERT INTO theme_versions (id, version_number, preset, tokens_json, status, note, published_at)
VALUES ('dev_theme_v1', 1, 'NATURE',
        '{"--color-primary":"#2f5d50","--color-secondary":"#6b7f5e","--color-accent":"#c9785b"}',
        'PUBLISHED', 'Dev seed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO theme_settings (id, published_version_id) VALUES (1, 'dev_theme_v1');

-- Accommodation ------------------------------------------------------------------
INSERT INTO accommodation_units
  (id, unit_code, unit_type, slug, base_price_satang, standard_guests, max_guests, status, sort_order) VALUES
  ('dev_house_01', 'HOUSE-01', 'HOUSE',    'house-sakura',    350000, 2, 4, 'ACTIVE', 1),
  ('dev_house_02', 'HOUSE-02', 'HOUSE',    'house-stargazing', 320000, 2, 4, 'ACTIVE', 2),
  ('dev_vip_01',   'VIP-01',   'VIP_TENT', 'vip-01',          180000, 2, 3, 'ACTIVE', 1),
  ('dev_vip_02',   'VIP-02',   'VIP_TENT', 'vip-02',          180000, 2, 3, 'ACTIVE', 2),
  ('dev_vip_03',   'VIP-03',   'VIP_TENT', 'vip-03',          220000, 2, 4, 'ACTIVE', 3);

INSERT INTO accommodation_translations (unit_id, language_code, name, short_description) VALUES
  ('dev_house_01', 'th', 'House 01 — บ้านซากุระ', 'บ้านพักตัวอย่าง'),
  ('dev_house_01', 'en', 'House 01 — Sakura House', 'Sample house'),
  ('dev_house_01', 'zh-CN', '01号屋 — 樱花屋', '示例房屋'),
  ('dev_house_02', 'th', 'House 02 — บ้านชมดาว', 'บ้านพักตัวอย่าง'),
  ('dev_house_02', 'en', 'House 02 — Stargazing House', 'Sample house'),
  ('dev_house_02', 'zh-CN', '02号屋 — 观星屋', '示例房屋'),
  ('dev_vip_01', 'th', 'VIP-01', 'เต็นท์ VIP ตัวอย่าง'),
  ('dev_vip_01', 'en', 'VIP-01', 'Sample VIP tent'),
  ('dev_vip_01', 'zh-CN', 'VIP-01', '示例 VIP 帐篷'),
  ('dev_vip_02', 'th', 'VIP-02', 'เต็นท์ VIP ตัวอย่าง'),
  ('dev_vip_02', 'en', 'VIP-02', 'Sample VIP tent'),
  ('dev_vip_02', 'zh-CN', 'VIP-02', '示例 VIP 帐篷'),
  ('dev_vip_03', 'th', 'VIP-03', 'เต็นท์ VIP ตัวอย่าง'),
  ('dev_vip_03', 'en', 'VIP-03', 'Sample VIP tent'),
  ('dev_vip_03', 'zh-CN', 'VIP-03', '示例 VIP 帐篷');

INSERT INTO amenities (id, code, icon, sort_order) VALUES
  ('dev_amenity_wifi', 'wifi', 'wifi', 1),
  ('dev_amenity_ac', 'air_conditioning', 'snowflake', 2),
  ('dev_amenity_bathroom', 'private_bathroom', 'bath', 3);

INSERT INTO amenity_translations (amenity_id, language_code, name) VALUES
  ('dev_amenity_wifi', 'th', 'Wi-Fi'), ('dev_amenity_wifi', 'en', 'Wi-Fi'), ('dev_amenity_wifi', 'zh-CN', '无线网络'),
  ('dev_amenity_ac', 'th', 'เครื่องปรับอากาศ'), ('dev_amenity_ac', 'en', 'Air conditioning'), ('dev_amenity_ac', 'zh-CN', '空调'),
  ('dev_amenity_bathroom', 'th', 'ห้องน้ำในตัว'), ('dev_amenity_bathroom', 'en', 'Private bathroom'), ('dev_amenity_bathroom', 'zh-CN', '独立卫浴');

INSERT INTO accommodation_amenities (unit_id, amenity_id) VALUES
  ('dev_house_01', 'dev_amenity_wifi'), ('dev_house_01', 'dev_amenity_ac'), ('dev_house_01', 'dev_amenity_bathroom'),
  ('dev_house_02', 'dev_amenity_wifi'), ('dev_house_02', 'dev_amenity_bathroom'),
  ('dev_vip_03', 'dev_amenity_wifi');

-- Camping: 30 tents/night, 250 THB per adult per night, children under 12 free (spec §18)
INSERT INTO camping_settings (id, is_enabled, max_tents_per_night, price_per_adult_night_satang, child_free_under_age)
VALUES (1, 1, 30, 25000, 12);

INSERT INTO camping_setting_translations (language_code, name, description) VALUES
  ('th', 'นำเต็นท์มาเอง', 'ลานกางเต็นท์ตัวอย่าง'),
  ('en', 'Bring your own tent', 'Sample camping ground'),
  ('zh-CN', '自带帐篷', '示例露营地');

-- Food (spec §21 sample prices) -----------------------------------------------------
-- service_day_offset: breakfast is served the morning after each night.
INSERT INTO food_categories (id, code, default_daily_capacity, deadline_type, deadline_days_before, deadline_time, service_time, service_day_offset, sort_order) VALUES
  ('dev_food_breakfast', 'BREAKFAST', 60, 'PREVIOUS_DAY_TIME', NULL, '18:00', '08:00', 1, 1),
  ('dev_food_dinner',    'DINNER',    50, 'DAYS_BEFORE', 1, NULL, '18:30', 0, 2),
  ('dev_food_bbq',       'BBQ',       20, 'DAYS_BEFORE', 1, NULL, '18:30', 0, 3),
  ('dev_food_other',     'OTHER',     NULL, 'NONE', NULL, NULL, NULL, 0, 4);

INSERT INTO food_category_translations (food_category_id, language_code, name) VALUES
  ('dev_food_breakfast', 'th', 'อาหารเช้า'), ('dev_food_breakfast', 'en', 'Breakfast'), ('dev_food_breakfast', 'zh-CN', '早餐'),
  ('dev_food_dinner', 'th', 'อาหารเย็น'), ('dev_food_dinner', 'en', 'Dinner'), ('dev_food_dinner', 'zh-CN', '晚餐'),
  ('dev_food_bbq', 'th', 'บาร์บีคิว'), ('dev_food_bbq', 'en', 'BBQ'), ('dev_food_bbq', 'zh-CN', '烧烤'),
  ('dev_food_other', 'th', 'อื่น ๆ'), ('dev_food_other', 'en', 'Other'), ('dev_food_other', 'zh-CN', '其他');

INSERT INTO food_options (id, food_category_id, code, pricing_type, price_satang, child_pricing, persons_per_set, status, sort_order) VALUES
  ('dev_food_breakfast_a', 'dev_food_breakfast', 'BREAKFAST_A', 'PER_PERSON', 15000, 'HALF', NULL, 'ACTIVE', 1),
  ('dev_food_breakfast_b', 'dev_food_breakfast', 'BREAKFAST_B', 'PER_PERSON', 18000, 'HALF', NULL, 'ACTIVE', 2),
  ('dev_food_dinner_a',    'dev_food_dinner',    'DINNER_A',    'PER_PERSON', 25000, 'FULL', NULL, 'ACTIVE', 1),
  ('dev_food_bbq_set',     'dev_food_bbq',       'BBQ_SET',     'PER_SET',    39900, 'FREE', 2,    'ACTIVE', 1);

INSERT INTO food_option_translations (food_option_id, language_code, name) VALUES
  ('dev_food_breakfast_a', 'th', 'อาหารเช้า A'), ('dev_food_breakfast_a', 'en', 'Breakfast A'), ('dev_food_breakfast_a', 'zh-CN', '早餐 A'),
  ('dev_food_breakfast_b', 'th', 'อาหารเช้า B'), ('dev_food_breakfast_b', 'en', 'Breakfast B'), ('dev_food_breakfast_b', 'zh-CN', '早餐 B'),
  ('dev_food_dinner_a', 'th', 'อาหารเย็น A'), ('dev_food_dinner_a', 'en', 'Dinner A'), ('dev_food_dinner_a', 'zh-CN', '晚餐 A'),
  ('dev_food_bbq_set', 'th', 'ชุดบาร์บีคิว'), ('dev_food_bbq_set', 'en', 'BBQ set'), ('dev_food_bbq_set', 'zh-CN', '烧烤套餐');

-- House Sakura includes breakfast for 2 persons per night (spec §20)
INSERT INTO included_meals (id, target_type, unit_id, food_category_id, food_option_id, persons_per_night)
VALUES ('dev_incl_sakura_breakfast', 'UNIT', 'dev_house_01', 'dev_food_breakfast', 'dev_food_breakfast_a', 2);

-- Payment (FAKE account — for local testing only) ------------------------------------
INSERT INTO receiving_accounts (id, bank_name, account_name, account_number, promptpay_number, status, is_primary)
VALUES ('dev_account_01', 'DEV BANK (ตัวอย่าง)', 'DEV SAMPLE ACCOUNT', '000-0-00000-0', '0000000000', 'ACTIVE', 1);

-- Content ------------------------------------------------------------------------------
INSERT INTO home_sections (id, section_type, sort_order, status) VALUES
  ('dev_home_intro', 'INTRODUCTION', 1, 'PUBLISHED'),
  ('dev_home_contact', 'CONTACT', 2, 'PUBLISHED');

INSERT INTO home_section_translations (section_id, language_code, title, body) VALUES
  ('dev_home_intro', 'th', 'ยินดีต้อนรับ', 'ข้อความแนะนำตัวอย่างสำหรับการพัฒนา'),
  ('dev_home_intro', 'en', 'Welcome', 'Sample introduction text for development.'),
  ('dev_home_intro', 'zh-CN', '欢迎', '开发用示例介绍文字。'),
  ('dev_home_contact', 'th', 'ติดต่อเรา', NULL),
  ('dev_home_contact', 'en', 'Contact us', NULL),
  ('dev_home_contact', 'zh-CN', '联系我们', NULL);

INSERT INTO gallery_categories (id, slug, sort_order, status) VALUES
  ('dev_gallery_nature', 'nature', 1, 'PUBLISHED'),
  ('dev_gallery_rooms', 'rooms', 2, 'PUBLISHED');

INSERT INTO gallery_category_translations (category_id, language_code, name) VALUES
  ('dev_gallery_nature', 'th', 'ธรรมชาติ'), ('dev_gallery_nature', 'en', 'Nature'), ('dev_gallery_nature', 'zh-CN', '自然'),
  ('dev_gallery_rooms', 'th', 'ห้องพัก'), ('dev_gallery_rooms', 'en', 'Rooms'), ('dev_gallery_rooms', 'zh-CN', '客房');

INSERT INTO history_sections (id, section_type, sort_order, status) VALUES
  ('dev_history_intro', 'INTRODUCTION', 1, 'PUBLISHED');

INSERT INTO history_translations (section_id, language_code, title, body) VALUES
  ('dev_history_intro', 'th', 'จุดเริ่มต้น', 'ข้อความประวัติตัวอย่างสำหรับการพัฒนา'),
  ('dev_history_intro', 'en', 'How it began', 'Sample history text for development.'),
  ('dev_history_intro', 'zh-CN', '起源', '开发用示例历史文字。');

INSERT INTO history_timeline (id, year, sort_order, status) VALUES
  ('dev_timeline_1', 2020, 1, 'PUBLISHED'),
  ('dev_timeline_2', 2024, 2, 'PUBLISHED');

INSERT INTO history_timeline_translations (timeline_id, language_code, title) VALUES
  ('dev_timeline_1', 'th', 'เริ่มต้นโครงการ (ตัวอย่าง)'), ('dev_timeline_1', 'en', 'Project started (sample)'), ('dev_timeline_1', 'zh-CN', '项目启动（示例）'),
  ('dev_timeline_2', 'th', 'เปิดให้บริการ (ตัวอย่าง)'), ('dev_timeline_2', 'en', 'Opened to guests (sample)'), ('dev_timeline_2', 'zh-CN', '开始营业（示例）');

INSERT INTO seo_settings (id, page_key, language_code, seo_title, meta_description) VALUES
  ('dev_seo_home_th', 'home', 'th', 'Phasakura (ตัวอย่าง)', 'คำอธิบายตัวอย่าง'),
  ('dev_seo_home_en', 'home', 'en', 'Phasakura (sample)', 'Sample description'),
  ('dev_seo_home_zh', 'home', 'zh-CN', 'Phasakura（示例）', '示例描述');
