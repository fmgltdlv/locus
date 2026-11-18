# Deployment

Single guide for **production and local development**. The **supported API** is the **Cloudflare Worker** in `[cloudflare/deploy/](../cloudflare/deploy/)` (Hono + **D1** + **R2** + optional **Workers KV**). The static UI is `[frontend/](../frontend/)` on **Pages**, another static host, or same origin via a reverse proxy.

The legacy **Node `backend/`** tree was **removed from this repository** to avoid drift; keep a private backup if you still need one-off scripts from that tree.

Before publishing this repo publicly, see [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md).

Set **`SUPPORT_EMAIL`**, **`TRANSACTIONAL_FROM_EMAIL`**, **`PASSWORD_RESET_ORIGIN`**, and **`CORS_ORIGINS`** in `wrangler.toml` (see `wrangler.toml.example`). For frontend CSP, pass your API/UI origins when building: `CSP_DEPLOYMENT_ORIGINS=https://api.example.com,https://app.example.com npm run build` in `frontend/`.

## Table of contents

- [Architecture](#architecture)
- [Cloudflare: Worker API](#cloudflare-worker-api)
- [Cloudflare dashboard: Worker (Git / Workers Builds)](#cloudflare-dashboard-worker-git--workers-builds)
- [Cloudflare: Pages (static UI)](#cloudflare-pages-static-ui)
- [Cloudflare dashboard: Pages (Git)](#cloudflare-dashboard-pages-git)
- [Local development](#local-development)
- [Release zip bundle](#release-zip-bundle)
- [Scripts outside the Worker](#scripts-outside-the-worker)

---

## Architecture


| Piece                                                | Location / binding                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API                                             | `[cloudflare/deploy/src/index.ts](../cloudflare/deploy/src/index.ts)` (Hono)                                                                 |
| SQL                                                  | **D1** — `wrangler.toml` → `database_name` (e.g. `locus-db`), `database_id` from the dashboard                                                  |
| Media                                                | **R2** bucket binding `R2`                                                                                                                   |
| Coordination / prefs / operator directory (optional) | **KV** binding `APP_KV` — if unset, several features fall back to D1 or degrade; see Worker logs                                             |
| Frontend                                             | `[frontend/](../frontend/)` — **map-first** static UI; configure API base in `**frontend/js/config-override.js`** |
| User preferences                                     | D1 `users.preferred_language` for English/Spanish map-page language; UI preferences and Ticket Hub state use KV when available, otherwise D1 |
| Ticket notes                                         | D1 `ticket_notes` + `ticket_note_read_state` (migration `0041_ticket_notes.sql`); API in `detailRoutes.ts` |


---

## Cloudflare: Worker API

**Folder:** `[cloudflare/deploy/](../cloudflare/deploy/)`.


| Path                    | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `wrangler.toml`         | Worker name, `main`, D1 + R2 + KV bindings, `[vars]` (**gitignored** — copy from example) |
| `wrangler.toml.example` | Template with placeholders — copy to `wrangler.toml` when starting from scratch |
| `migrations/*.sql`      | D1 schema — applied with Wrangler (see below)                                   |
| `src/`                  | Routes, auth, libs (`.ts` + some `.cjs` helpers)                                |


**Prerequisites:** Node 18+, Cloudflare account, Wrangler (`npm install` in `cloudflare/deploy`).

**One-time setup**

```bash
cd cloudflare/deploy
npm install
npx wrangler login
# If you need a new D1 database:
npx wrangler d1 create locus-db   # use the printed id in wrangler.toml database_id
```

Edit `[wrangler.toml](../cloudflare/deploy/wrangler.toml)`: set `**database_id**` (and keep `database_name` consistent). Create a **KV** namespace for `APP_KV` and paste `**id`** / `**preview_id**`. For a blank project, start from `[wrangler.toml.example](../cloudflare/deploy/wrangler.toml.example)` (copy to `wrangler.toml` and replace every `REPLACE_*` value).

**Migrations (apply all pending SQL files)**

```bash
cd cloudflare/deploy
npm run d1:migrate:local    # local Miniflare D1
npm run d1:migrate:remote   # remote D1 (production) — also runs automatically via npm run deploy
```

This runs `wrangler d1 migrations apply <database_name>` and tracks applied files in the `d1_migrations` table. **`npm run deploy`** applies pending remote migrations before `wrangler deploy` (same pattern as `npm run dev` for local D1). Branch preview uploads (`wrangler versions upload`) do **not** run remote migrations. Apply new migrations locally before relying on schema changes — for example `users.preferred_language`, **`ticket_notes`** / **`ticket_note_read_state`** (`0041_ticket_notes.sql`), or other pending files in `migrations/`.

Application incidents are stored in D1 and surfaced in the developer-only Admin Errors tab. See `[error-codes.md](./error-codes.md)` for the code catalog and support workflow.

Current admin/user data managed through the app includes global account role, per-organization membership role, default organization, password reset, map-page language preference, and **org-scoped ticket notes** on the ticket detail **Notes** tab.

**Develop / deploy**

```bash
npm run dev      # default dev URL often http://127.0.0.1:8787 — see terminal
npm run deploy
```

**Secrets and config**

- Non-secret defaults: `[vars]` in `wrangler.toml` (e.g. `JWT_SECRET` for dev only — override in production).
- Secrets: `npx wrangler secret put JWT_SECRET` (and `USAN_SERVICE_*`, `NGEN_*`, etc. as needed).
- Local overrides: `.dev.vars` in `cloudflare/deploy/` (gitignored), same keys as Worker env.
- `JWT_EXPIRY` defaults to `7d` when unset or invalid. Use compact `jose` durations like `12h`, `24h`, or `7d`.
- `**ENABLE_TICKET_RENEWAL`** — when set to `**1**`, enables USAN ticket actions for **organization admins** (and dev): **Ticket Hub → Renew selected** asks fresh paint vs renew — **No** uses renew preview (`POST /api/tickets/renew/preview` + `submit-jobs` `operation: renew`); **Yes** runs bulk remark (`submit-jobs` `operation: remark`, up to **25** items, shared default note with optional per-ticket overrides). **Map popup → Remark** remains available for a single ticket (`canBeRemark` must be true). Also enables **Create ticket** wizard submit (`POST /api/tickets/create`), and **auto-clone** on renew when neither `**canBeRenewal`** nor `**canBeRemark**` (submitted as a new locate; **one account password per batch** when any selected ticket needs clone). The map app reads the same switch from `**GET /api/public-config`** as `enableTicketRenewal` (no secret). Defaults to off if unset. **Batch cap:** up to **25** tickets per renew or remark job (server constant). **Dry run:** send JSON `**"dryRun": true`** (or `**"1"**`) in POST bodies to build payloads and call computed dates without submitting to nGen — optional safety for first deploys. **After a successful submit**, new enquiries are **not** imported immediately; they appear after the normal **USAN list poll** path. Poll lookback is controlled separately (e.g. `PAC_ENRICHMENT_DAYS_BACK`, `USAN_LIST_MAX_DAYS_BACK`, `pac_enrichment_days_back` in KV); tuning those affects more than renewals—see Worker libs `pacRuntimeSettings` / `ngenUsanPollDates` and ops notes before narrowing windows.

**Cloudflare edge security controls**

Several abuse controls live in the Cloudflare dashboard rather than this repository. Keep this section in sync with the active zone/Worker rules so future deployments do not accidentally weaken protections:

- **Rate limiting / WAF rules:** protect at least `POST /api/auth/login`, `POST /api/auth/forgot-password`, and high-volume API paths under `/api/tickets/*` and `/api/data/*`.
- **Recommended login/reset thresholds:** use Cloudflare per-IP limits at the edge, and keep the app response generic for reset requests so email existence is not exposed. The Worker also throttles forgot-password by normalized email hash at **3 requests per 15 minutes**.
- **Bot / challenge rules:** apply only to public browser-facing routes that can tolerate a challenge. Avoid challenging Worker-to-Worker or scheduled traffic.
- **Allowed browser origins:** Worker CORS is controlled by `CORS_ORIGINS` in wrangler (plus local-dev origins outside production); do not use wildcard origins in production.
- **Third-party hosts used by the UI:** Google Maps, Mapbox (`api.mapbox.com` when `window.MAPBOX_ACCESS_TOKEN` is set), unpkg, jsDelivr, cdnjs, and the configured Worker API host. Mirror these in CSP changes and Cloudflare allow/block rules.
- **Public Mapbox token:** `window.MAPBOX_ACCESS_TOKEN` in [`frontend/js/config-override.js`](../frontend/js/config-override.js) is a **public** browser token (`pk.` prefix). It is expected in client config, but must be restricted in the [Mapbox account dashboard](https://account.mapbox.com/access-tokens/) so it cannot be reused from other sites:
  - **Allowed URLs:** your production UI origin (for example `https://app.example.com/*`), and local dev (`http://localhost:*`, `http://127.0.0.1:*`) if you use Mapbox Hybrid locally.
  - Rotate the token if it was ever committed without URL restrictions.

**PAC/nGen master passwords (D1 `organization_pacweb_accounts.password_encrypted`)**

- `**NGEN_CREDENTIALS_KEY`** — AES-GCM key material for stored USAN/PAC “master” passwords. **Production:** use `wrangler secret put NGEN_CREDENTIALS_KEY` (do not commit real values). **Beta:** the team may keep placeholders or test values in `[vars]` for speed — **before real customers**, switch to Secrets and remove/secrets-rotate anything that touched git.
- `**NGEN_CREDENTIALS_KEY_OLD`** — optional; set to the **previous** primary **only** during key rotation. After running bulk repack (below), remove it from Worker env.
- `**NGEN_CREDENTIAL_REPACK_SECRET`** — protects the internal bulk repack endpoint. Set in `[vars]` or as a secret; must match the request header.
- **Bulk repack after deploy:** `npm run deploy` runs remote D1 migrations, then `wrangler deploy`, then automatically calls `POST /api/internal/credential-repack-masters` via `scripts/post-deploy-credential-repack.mjs`. The endpoint no-ops when the KV fingerprint already matches `NGEN_CREDENTIALS_KEY` (safe every deploy). The script posts to **`CREDENTIAL_REPACK_ORIGIN`** (the `*.workers.dev` host), not **`WORKER_ORIGIN`**. The public custom domain sits behind the zone security rules, which block Workers Builds with an HTML 403 before the Worker runs. Manual curl (same host the script uses):

```bash
curl -sS -X POST "$CREDENTIAL_REPACK_ORIGIN/api/internal/credential-repack-masters" \
  -H "X-Ngen-Credential-Repack-Secret: $NGEN_CREDENTIAL_REPACK_SECRET"
```

- **Deploy / CI env (build machine):** **`CREDENTIAL_REPACK_ORIGIN`** and **`NGEN_CREDENTIAL_REPACK_SECRET`** are read from `wrangler.toml` `[vars]` when they are not already in the environment. **`WORKER_ORIGIN`** stays the public API host (signup verify links) and is only a fallback for the repack POST. You can still set both in Cloudflare Workers Builds **Build variables and secrets**, or export them before `npm run deploy` locally. If the repack secret is unset, the post-deploy step is skipped with a warning. Set **`SKIP_CREDENTIAL_REPACK=1`** to skip (e.g. branch preview uploads that use `wrangler versions upload` only). Use a `*.workers.dev` host from your Cloudflare account for `CREDENTIAL_REPACK_ORIGIN` (see `wrangler.toml.example`).

- **Order of operations (first time / migrating off JWT-derived ciphertext):** set `NGEN_CREDENTIALS_KEY` → deploy → call repack (or use per-account `reencrypt-password` in Admin) → optional `wrangler secret put JWT_SECRET` later (invalidates sessions only).

**Custom domain:** Dashboard → Workers & Pages → your worker → Triggers → Custom Domains.

**Troubleshooting:** Invalid `database_id` · run migrations before relying on tables · missing `APP_KV` (warning in logs; some features use D1 fallback) · bump `compatibility_date` if Wrangler suggests it.

### Cloudflare dashboard: Worker (Git / Workers Builds)

Use these when the repository is connected to a **Cloudflare Worker** (Workers Builds / Git integration). The Worker code lives in a **subfolder**; there is **no** `package.json` at the repository root.


| Setting                                  | Value                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Root directory**                       | `cloudflare/deploy`                                                                                                                                                                                                                                               |
| **Build command (optional)**             | Leave empty. This project has no `npm run build` for the API; **Wrangler bundles** `src/index.ts` at **deploy** time. Optional CI gate: `npm run typecheck`.                                                                                                      |
| **Deploy command**                       | `npm run deploy` (runs remote D1 migrations, then `wrangler deploy` + post-deploy credential repack; or `npx wrangler deploy` alone to skip migrations and repack)                                                                                                                                        |
| **Non-production branch deploy command** | `npx wrangler versions upload` (default) for branch/PR preview uploads                                                                                                                                                                                            |
| **Install step**                         | There is no separate “install command” in the UI. **Dependencies install automatically** in the root directory before the build step. If you set **Root directory** to `cloudflare/deploy`, `npm install` runs there (including `postinstall` / `patch-package`). |
| **API token**                            | Default (auto-generated) is usually enough unless you use a custom token.                                                                                                                                                                                         |
| **Build variables and secrets**          | Optional. Repack reads **`CREDENTIAL_REPACK_ORIGIN`** (`*.workers.dev`) and **`NGEN_CREDENTIAL_REPACK_SECRET`** from `wrangler.toml` when the build environment does not set them. Do not point the repack POST at the public custom domain; zone security blocks Workers Builds. **`WORKER_ORIGIN`** remains the public API host. **Runtime** secrets (`JWT_SECRET`, `USAN_SERVICE_*`, `NGEN_*`, etc.) belong under the Worker’s **Settings → Variables & secrets** (or `wrangler secret` / `[vars]`). |


**Runtime environment (Worker):** D1, R2, and KV are configured in `wrangler.toml` as **bindings**, not as plain “env vars.” Set `**CORS_ORIGINS`** so it includes your **Pages** origin if the UI is on a different host. Use a **strong** `JWT_SECRET` in production (`wrangler secret put JWT_SECRET`); do not ship the dev placeholder. Optional tunables (geocoding, PAC / nGen, timeouts) are read from the Worker environment where needed—see the codebase and the **Secrets and config** list under [Cloudflare: Worker API](#cloudflare-worker-api) above.

**Official reference:** [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

---

## Cloudflare: Pages (static UI)

The UI source lives in `**[frontend/](../frontend/)`**. For **production**, build minified assets (drops `console`/`debugger`, strips legal comment blocks, minifies HTML/CSS/JS) into `**frontend/dist/`**:

```bash
cd frontend
npm install   # once (installs esbuild + html minifier for the build script)
npm run build
```

Host `**frontend/dist/**` on **Cloudflare Pages** or any CDN/static host.

**Local development** can use either:

- `**frontend/dist/`** after `npm run build` (production-like HTML and stable `/im/*` bundle URLs), or  
- The `**frontend/**` source tree after `**npm run dev:bundles**` once (writes `js/app-index.pre-pdf.bundle.js`, `js/app-index.post-pdf.bundle.js`, and the admin/login bundles into `frontend/js/`; these paths are **not** in git). Plain `npm run build` does **not** create those files in `frontend/js/` — only copies under `dist/im/`. Without bundles, the browser will **404** `js/*.bundle.js` when opening source `index.html`.

**Fingerprinted bundles and cache:** Production build writes bundled JS and CSS under **`dist/im/`** using **stable logical filenames** (e.g. `im/styles.css`, `im/app-index-pre-pdf.js`) and rewrites HTML to reference those paths. The build emits **`dist/_headers`** for Cloudflare Pages: **`must-revalidate`** for **`/im/*`** (deploy overwrites files in place; the service worker precache tracks content via Workbox revisions), and **`must-revalidate`** for HTML entries and **`/js/config.js`** / **`/js/config-override.js`**. Do **not** long-cache `/im/*` with `immutable` — that caused stale HTML to request removed hash URLs and edge caches to serve `index.html` as CSS/JS after deploy.

**Point the browser at the API** in `**[frontend/js/config-override.js](../frontend/js/config-override.js)`** (loaded before `config.js`):

```javascript
window.API_BASE_URL = 'https://your-worker-host.example.com';
window.DEV_API_BASE_URL = 'http://127.0.0.1:8787';
```

Use the Worker origin (scheme + host, **no** trailing slash, **no** `/api` suffix). `API_BASE_URL` is used in production; `DEV_API_BASE_URL` is used automatically when the UI is served from `localhost`, `127.0.0.1`, `::1`, or `file://`. For same-origin hosting, use `''`.

**Deploy with Wrangler (optional helper project)**

`npm run deploy` in this folder **runs** `npm run build` in `**../../frontend`**, which writes `**../../frontend/dist**`, then deploys that folder:

```bash
cd cloudflare/frontend-pages
npm install
npx wrangler login
npm run deploy
```

To deploy a folder you already built: `npx wrangler pages deploy ../../frontend/dist --project-name=locus`

See `[frontend/pages-deployment.example.json](../frontend/pages-deployment.example.json)` if present.

**CORS:** If Pages and the API are on different origins, allow the Pages origin via Worker CORS / `CORS_ORIGINS` (see `src/corsAllowOrigin.ts`).

### Cloudflare dashboard: Pages (Git)

Use these when the repository is connected to **Cloudflare Pages** (connect Git). The frontend lives in `**frontend/`**; there is **no** `package.json` at the repository root. If **Root directory** is left blank, `npm run build` fails with **ENOENT** on `package.json` at the repo root.


| Setting                         | Value                                                          |
| ------------------------------- | -------------------------------------------------------------- |
| **Root directory (build root)** | `frontend`                                                     |
| **Build command**               | `npm run build`                                                |
| **Build output directory**      | `dist`                                                         |
| **Framework preset**            | None (static / custom; build is `node build.mjs` with esbuild) |


**Optional:** Set `**NODE_VERSION`** (e.g. `20` or `18`) in **Pages → Settings → Environment variables** so the build uses a current Node. The minified build does **not** read Cloudflare build env for the API URL; set `**window.API_BASE_URL`** and, if needed, `**window.DEV_API_BASE_URL**` in `[frontend/js/config-override.js](../frontend/js/config-override.js)` in source (or extend the build to inject them). Optional **Google Maps:** `window.GOOGLE_MAPS_API_KEY` in the same file—see `frontend/js/config.js`.

**Official reference:** [Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/) (monorepos: [build directory](https://developers.cloudflare.com/pages/configuration/build-configuration/#root-directory)).

---

## Local development

Full first-time steps (Node install, login, and UI hosting options) are in `[SETUP.md](SETUP.md)`. For a **Cloudflare staging** environment (not Miniflare), see `[STAGING.md](STAGING.md)`.

Below is the **day-to-day** flow from the **repository root** (Bash, macOS/Linux Terminal, or **Windows PowerShell** — adjust `cd` paths if your clone lives elsewhere).

**Prerequisites:** Node **18+**, dependencies installed in `cloudflare/deploy` (`npm install` there).

**1. API (Cloudflare Worker / Miniflare)**

```bash
cd cloudflare/deploy
npm install
npm run d1:migrate:local   # once per machine (or after new migrations)
```

Optional — seed a local **dev** org and user (safe to re-run; skips if the email already exists):

```bash
npm run d1:seed:dev
```

Default login after seed: `dev@example.com` / `dev` (username `dev` also works). If you skip the seed, you still need a `users` row (and org) before `/api/auth/login` works; see [SETUP.md](SETUP.md).

```bash
npm run dev
```

Wrangler prints the dev origin (commonly `http://127.0.0.1:8787`). R2, D1, and KV use Miniflare’s local simulation; `preview_*` / local bindings in `[wrangler.toml](../cloudflare/deploy/wrangler.toml)` apply.

**Local env:** Put secrets and overrides in `cloudflare/deploy/.dev.vars` (gitignored); keys align with the Worker and `[vars]` in `wrangler.toml` (see [Cloudflare: Worker API](#cloudflare-worker-api) above).

**2. Frontend (static files)**

From `**frontend/`**, run `**npm install**` once, then either:

- **Production-shaped app:** `npm run build` and serve `**frontend/dist/`** (e.g. `npx --yes serve frontend/dist`), or  
- **Source tree:** `npm run dev:bundles` (writes the large `js/*.bundle.js` entrypoints into `frontend/js/`), then serve `**frontend/`** (e.g. from the repo root `npx --yes serve frontend`).

Serve over **HTTP** so API calls and CORS behave like production; avoid `file://`.

**3. Point the UI at the API**

In `[frontend/js/config-override.js](../frontend/js/config-override.js)`, set `window.DEV_API_BASE_URL` to the **exact** origin Wrangler printed (scheme + host + port, no path, no trailing slash) — the repo default is `http://127.0.0.1:8787`. The app automatically uses that dev value when the UI is served from `localhost`, `127.0.0.1`, `::1`, or `file://`, while production hosts keep using `window.API_BASE_URL`. If the UI runs on a different host/port than the API, ensure the Worker allows that browser origin (see `CORS_ORIGINS` and `corsAllowOrigin` in the Worker; dev `wrangler.toml` often uses `*` for convenience).

**Summary:** two processes — **Worker** (`npm run dev` in `cloudflare/deploy`) and **static server** for `frontend/` — plus `config-override.js` matching the Worker URL. The main map page is **map-first** (Ticket Hub and Data Hub open as overlays); see [README.md](README.md).

---

## Scripts outside the Worker

Browser automation (Playwright), heavy image binaries, PDF utilities, and long CPU jobs **do not** run inside the Worker. Run them in **Node on a machine or CI** against the deployed HTTPS API; they are **not** part of this repo’s `backend/` anymore (restore from your backup if you rely on old `backend/scripts/`).

---

**Last updated:** June 2026