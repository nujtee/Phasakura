# Phasakura — Accommodation Booking Website

React + TypeScript frontend and a Cloudflare Worker backend (D1 + R2), deployed as a single Worker.
Full requirements and phase status: [`MASTER_SPEC.md`](./MASTER_SPEC.md).

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars          # local non-secret config, gitignored

# one-time Cloudflare setup
npx wrangler login
npx wrangler d1 create phasakura-db     # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create phasakura-media-public
npx wrangler r2 bucket create phasakura-media-private

# run locally (two terminals)
npm run dev:worker                      # Worker API on :8787 (local D1/R2)
npm run dev                             # Vite on :5173, proxies /api → :8787
```

## First admin account

No default admin or password ships with the app. Create the first SUPER_ADMIN once:

```bash
npm run admin:bootstrap -- --email you@example.com --name "Your Name" --out bootstrap.sql
npx wrangler d1 execute phasakura-db --local --file bootstrap.sql    # or --remote
rm bootstrap.sql
```

The temporary password is printed once; you must change it at first sign-in at `/th/admin/login`.

## Quality gates

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Deploy

```bash
npm run deploy
```

Secrets are never committed. Set them with `npx wrangler secret put <NAME>`.

### LINE notifications (Phase 11)

1. LINE Developers console → create a **Messaging API** channel for your LINE Official Account.
2. Store the channel credentials as Cloudflare Secrets (never in Git / D1):
   ```bash
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN   # Messaging API tab → long-lived channel access token
   npx wrangler secret put LINE_CHANNEL_SECRET         # Basic settings tab → channel secret
   ```
3. Set `APP_BASE_URL` (https) in `wrangler.jsonc` so messages can link back to the site.
4. Admin → Settings → LINE: copy the **Webhook URL** into the channel (Messaging API → Webhook URL, turn on
   "Use webhook"), press **Check connection**, turn notifications on, then add staff chats with a link code.
   For group chats, allow the bot to join groups in LINE Official Account Manager first.
5. The cron trigger (every minute) sends due notifications and the daily check-in / kitchen digests.

### Images and fonts (Phase 12)

- **Compression happens in the admin's browser**: photos are scaled to the purpose's maximum width
  (slides / gallery 2400 px, rooms / history / home sections 2000 px, dishes 1600 px), re-encoded as WebP
  (JPEG where the browser cannot encode WebP; camera metadata such as GPS is dropped), and smaller
  renditions are uploaded with them for `srcset`. The Worker re-checks every file from its bytes
  (type, size, dimensions, same picture as the original). Logos, favicons and QR codes are kept as uploaded.
- **Public bucket, private until published**: `/media/*` serves an image only while the content that uses
  it is published (gallery photo + category, slide inside its schedule, active house, active dish…).
  Drafts are visible to signed-in staff only (`Cache-Control: private, no-store`). Payment slips stay in
  the private bucket and are never served from `/media/*`.
- **Uploaded fonts**: Admin → Settings → Theme → *Uploaded fonts* (WOFF2 / WOFF, 2 MB, one file per weight
  and style). Only faces of the families the published theme uses are sent to visitors. Make sure the font
  licence allows web embedding.
- **Separate media domain** (`PUBLIC_MEDIA_BASE_URL`, e.g. an R2 custom domain): add that origin to
  `font-src` in `public/_headers`, and allow your site origin in the bucket's CORS rules — browsers fetch
  fonts with CORS. With the default (`/media/*` on the same Worker) nothing extra is needed.

### SEO, Search Console and site search (Phase 13)

- The Worker renders every page's `<head>` (title, description, canonical, hreflang TH / EN / ZH-Hans + x-default,
  Open Graph, JSON-LD) and returns real 404s. Texts come from Website → SEO, with automatic defaults.
- `/robots.txt` and `/sitemap.xml` are generated. **Only `APP_ENV=production` is indexable** — any other value
  serves `Disallow: /` and `X-Robots-Tag: noindex` so staging / preview copies never appear in Google.
- Set `APP_BASE_URL` to the public https origin so canonical, hreflang, OG and sitemap URLs use it.
- Google Search Console: add a **Domain** property (verified with a DNS TXT record) — or a URL-prefix property and
  paste the HTML-tag code into Admin → Marketing → GA4 / Search Console — then submit `https://<domain>/sitemap.xml`.
- Site search uses `search_index` (rebuilt by the cron when content changes, or from Website → SEO → Site search).
  It only finds candidates; what a result shows and whether a stay is free are read live from D1.

## Push to GitHub

```bash
git remote add origin git@github.com:<you>/phasakura.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push and PR.
Commit the generated `package-lock.json` after the first `npm install`.
