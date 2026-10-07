# D1 migrations

| File | Contents |
|---|---|
| `0001_languages_auth_rbac.sql` | languages, users, roles, permissions, sessions, reset tokens, security events, audit log, SUPER_ADMIN guard triggers |
| `0002_media_assets.sql` | R2 object metadata (public/private bucket), image alt/title/caption per language |
| `0003_site_branding_theme_seo_marketing.sql` | site settings, branding, theme versions, fonts, marketing IDs, SEO, redirects, floating CTA |
| `0004_accommodation_camping_pricing.sql` | houses / VIP tents, translations, images, amenities, camping settings + nightly tent inventory, pricing rules, price history |
| `0005_bookings.sql` | bookings, items, night-locks (double-booking guard), guests, price snapshots |
| `0006_payments_notifications.sql` | receiving accounts, payment account snapshots, payments, slip verifications, LINE notification log |
| `0007_food.sql` | food categories/options, included meals, daily capacity, kitchen orders, booking food items |
| `0008_content_home_gallery_history.sql` | home sections, hero slides, home versions, gallery, history, timeline |
| `0009_search.sql` | search index (optimization only), search history, daily search analytics |
| `0010_rbac_reference_data.sql` | 6 system roles, permission catalogue, default grants |
| `0011_camping_capacity_override.sql` | `camping_night_inventory.is_override` (ADD COLUMN, non-destructive) |
| `0012_booking_flow.sql` | breakfast service-day offset, booking idempotency key + privacy timestamp, kitchen-order capacity ledger, `booking_settings` (hold time, limits) — ADD COLUMN / new table only |
| `0013_capacity_guards.sql` | triggers: own-tent booking requires camping enabled, unit booking requires ACTIVE unit; index for active own-tent items — no data change |
| `0014_payments.sql` | payments: reference, note, refund_reason (ADD COLUMN); triggers: frozen money fields, refund is final, no payment on cancelled/expired bookings — no data change |
| `0015_admin_dashboard.sql` | triggers: booking lifecycle (`BOOKING_STATUS_TRANSITION`), kitchen orders forward-only, published/archived theme versions frozen; indexes for dashboard, calendar and admin lists — no data change |
| `0016_line_notifications.sql` | LINE settings (singleton), staff recipients, one-time link codes (hashed), guest booking ↔ LINE links; trigger: a SENT notification is final; log index — new tables only, no data change |
| `0017_images_fonts.sql` | `media_assets.parent_asset_id` (responsive variants) and `food_options.image_asset_id` (ADD COLUMN), `custom_fonts`; triggers: variants must match their original, FONT ⇔ font file, font rows point at an active FONT file; indexes for media access checks — no data change |

## Commands

```bash
npm run db:migrate:local     # apply to local D1 (.wrangler/)
npm run db:seed:local        # DEV sample data — local only
npm run db:reset:local       # wipe local D1, migrate, seed
npm run db:migrate:remote    # production — take a backup first (below)
```

## Production rules (spec §53, §65)

- Never edit an applied migration. Every schema change is a **new** numbered file.
- Never change the production database without a migration file here.
- Before any destructive migration (DROP, table rebuild, data rewrite): announce the risk,
  then back up and prepare a rollback:

  ```bash
  npx wrangler d1 export phasakura-db --remote --output backup-$(date +%Y%m%d-%H%M).sql
  # D1 Time Travel can also restore to a point in time:
  npx wrangler d1 time-travel info phasakura-db
  ```
- `seeds/dev.sql` is never applied remotely.
