# Excavator API (Cloudflare Worker)

Hono + **D1** + **R2** + optional **KV** (`APP_KV` when set in `wrangler.toml`).

The Worker is the supported API for auth, users/orgs, Ticket Hub, media/data routes, external ticket sync, UI preferences, and application incident logging. User-facing language preference is stored in D1 as `users.preferred_language`.

## Prerequisites

- Node 18+
- A Cloudflare account and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) (installed via `npm install` in this folder)

## Config

- **`wrangler.toml`** — your real bindings and `[vars]` (gitignored; copy from the example).
- **`wrangler.toml.example`** — template with `REPLACE_*` placeholders. Copy to `wrangler.toml` when bootstrapping a new clone or environment, then fill in D1, R2, KV, and vars.

## One-time: login and D1

```bash
npm install
npx wrangler login
```

Set **`database_id`** (and keep **`database_name`** accurate) in `wrangler.toml`. Create D1 in the dashboard or `npx wrangler d1 create locus-db` and paste the id. The `d1:*` npm scripts must use that same name.

## Migrations (apply all pending SQL files)

```bash
npm run d1:migrate:local
# production D1:
npm run d1:migrate:remote
```

This runs `wrangler d1 migrations apply <database_name>` and records applied files in the `d1_migrations` table. Keep local and remote D1 current before testing features that depend on new columns.

## Local dev login (optional)

After local migrations, seed a **`dev` / `dev@example.com`** user (password **`dev`**, role **`dev`**):

```bash
npm run d1:seed:dev
```

See `seeds/dev_user.sql`. Do not run this against production (`--local` only).

## Develop and deploy

```bash
npm run dev    # local Worker; URL in terminal (often port 8787)
npm run deploy # remote D1 migrations + wrangler deploy + credential repack (no-op when KV fingerprint matches)
```

Post-deploy repack posts to **`CREDENTIAL_REPACK_ORIGIN`** (`*.workers.dev`) with **`NGEN_CREDENTIAL_REPACK_SECRET`**. Both are read from `wrangler.toml` when the shell does not set them. **`WORKER_ORIGIN`** stays the public API host and is only a fallback. See **[../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)**.

## Secrets and vars

- Non-secret values: optional `[vars]` in `wrangler.toml` (including **`NGEN_CREDENTIALS_KEY`** / **`NGEN_CREDENTIAL_REPACK_SECRET`** during beta — see **[../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)** before GA).
- Secrets: `npx wrangler secret put JWT_SECRET` (and `USAN_SERVICE_*`, `NGEN_*`, etc. as your deployment needs).
- Local overrides: `.dev.vars` in this directory (gitignored), same key names the Worker reads.

## Frontend

The UI is the static site in `../../frontend/`. Set `window.API_BASE_URL` in `../../frontend/js/config-override.js` to the production Worker origin and `window.DEV_API_BASE_URL` to the local dev origin (scheme + host, no trailing slash).

## Full production guide

See **[../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)** and **[../../docs/SETUP.md](../../docs/SETUP.md)**.

**Last updated:** April 2026
