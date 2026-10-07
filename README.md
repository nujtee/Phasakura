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

## Push to GitHub

```bash
git remote add origin git@github.com:<you>/phasakura.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push and PR.
Commit the generated `package-lock.json` after the first `npm install`.
