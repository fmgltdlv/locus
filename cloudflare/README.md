# Cloudflare

- **Worker (API):** [`deploy/`](deploy/) — Hono, D1, R2, optional KV. D1 schema: **`deploy/migrations/*.sql`** only (not `cloudflare/migrations/`). Run **`npm install`**, **`npm run d1:migrate:local`**, then **`npm run dev`** (see [`deploy/README.md`](deploy/README.md)).
- **Pages helper:** [`frontend-pages/`](frontend-pages/) — optional Wrangler Pages project for deploying `../frontend/`.
- **Bundle readme template:** [`bundle/README.md`](bundle/README.md) — copied into the release zip by `../scripts/build-cloudflare-bundle.ps1`.

**Deployment** (Worker, D1, R2, Pages, release zip notes) is in **[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)**. Long-running or heavy jobs (Playwright, large image/PDF work) run **outside** the Worker — see the “Scripts outside the Worker” section there. A legacy in-repo **Node** backend is **not** part of this tree anymore.
