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

## Push to GitHub

```bash
git remote add origin git@github.com:<you>/phasakura.git
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests and build on every push and PR.
Commit the generated `package-lock.json` after the first `npm install`.
