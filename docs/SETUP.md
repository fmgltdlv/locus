# First-time setup

The **API in this repository** is the **Cloudflare Worker** in [`../cloudflare/deploy/`](../cloudflare/deploy/). The browser UI is static files in [`../frontend/`](../frontend/).

**Optional — from the repository root** after `npm install` in `cloudflare/deploy` and `frontend/`:

```bash
npm run dev:api    # Worker (Wrangler dev)
npm run dev:ui     # Static UI on http://localhost:3000
npm run typecheck  # Worker TypeScript check
npm run build:ui   # Production frontend build → frontend/dist/
npm run check:migrations  # ensure D1 SQL only under cloudflare/deploy/migrations/
```

1. **Install Node.js** (18+ LTS) from [nodejs.org](https://nodejs.org/).

2. **Get the project** — clone or extract the repo to a folder on your machine.

3. **Install Worker dependencies and Wrangler**

   ```bash
   cd cloudflare/deploy
   npm install
   ```

   Copy `wrangler.toml.example` → `wrangler.toml` if you do not already have a local file (real `wrangler.toml` is gitignored). See [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md). The D1 `database_name` in that file must match the names in `cloudflare/deploy/package.json` `d1:*` scripts (example: `locus-db`). If you already have a Cloudflare D1 under another name, keep that name in **both** places.

4. **Log in to Cloudflare (for remote deploys / remote D1)**

   ```bash
   npx wrangler login
   ```

5. **Apply D1 migrations** (creates schema, including current user language/profile fields)

   ```bash
   cd cloudflare/deploy
   npm run d1:migrate:local
   ```

   For production database: `npm run d1:migrate:remote` (after `database_id` is set in `wrangler.toml`), or rely on `npm run deploy` which applies pending remote migrations automatically.

   Recent migrations include **`0041_ticket_notes.sql`** (org-scoped ticket notes and read watermarks). Apply migrations before using Notes on ticket detail tabs.

6. **First user in D1** — Migrations do not insert a default login. You need at least one `users` row (and usually an organization) before `/api/auth/login` succeeds. For local development, `npm run d1:seed:dev` creates a dev org/user in Miniflare D1. For shared or production databases, use a **private** SQL export your team provides, a **minimal INSERT** you maintain locally, or restore from a backup.

7. **Start the API locally**

   ```bash
   cd cloudflare/deploy
   npm run dev
   ```

   Or from the repository root: `npm run dev:api`.

   Wrangler prints a URL (often `http://127.0.0.1:8787`). Use that as the API base.

8. **Secrets and non-secret config** — See [DEPLOYMENT.md](DEPLOYMENT.md). For local dev, add a **`.dev.vars`** file in `cloudflare/deploy/` (gitignored) with keys like `JWT_SECRET`, `NGEN_CREDENTIALS_KEY`, `NGEN_CREDENTIAL_REPACK_SECRET`, `USAN_SERVICE_USERNAME`, `USAN_SERVICE_PASSWORD` (match variable names in `wrangler.toml` and the Worker). Production uses `wrangler secret put …`. To test **renew / remark / create ticket** locally, also set `ENABLE_TICKET_RENEWAL=1` (see [DEPLOYMENT.md](DEPLOYMENT.md)).

9. **Serve the frontend** — From the repo root, `npm run dev:ui` (or `npx --yes serve frontend`), or use Live Server in an editor. Prefer HTTP over `file://` so fetch/CORS behavior matches production. For production asset testing, run `npm run build:ui` from the root (or `npm run build` in `frontend/`), then serve `frontend/dist/`.

10. **Point the UI at the API** — In [`../frontend/js/config-override.js`](../frontend/js/config-override.js), set:

    ```javascript
    window.API_BASE_URL = 'https://your-production-worker.example.com';
    window.DEV_API_BASE_URL = 'http://127.0.0.1:8787';
    ```

    Use the exact origin Wrangler shows for `DEV_API_BASE_URL`. The app automatically uses the dev value on localhost, `127.0.0.1`, `::1`, and `file://`; production hosts use `API_BASE_URL`.

11. **Smoke-test the UI** — Log in and confirm the **map-first** main view loads (radial org menu, Ticket Hub / Data Hub buttons). Open a ticket popup or Ticket Hub detail and check the **Details / Responses / Photos & Events / Notes** tabs. See [README.md](README.md).

12. **Production** — [DEPLOYMENT.md](DEPLOYMENT.md) (Worker + D1 + R2 + optional KV + static `frontend/` on Pages or another host).

---

**See also:** [README.md](README.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [../cloudflare/deploy/README.md](../cloudflare/deploy/README.md)

**Last updated:** June 2026
