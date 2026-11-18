# Cloudflare bundle (inside the zip)

This archive contains **`worker/`** (API: Cloudflare Worker + D1 migrations) and **`frontend/`** (static UI for Pages or any static host).

1. **D1** is only used by the Worker. Set `database_id` in `worker/wrangler.toml`.
2. The **browser** calls the Worker over HTTPS (`/api/...`).
3. **Link UI to API:** set `window.API_BASE_URL` in **`frontend/js/config-override.js`** to your production Worker origin and `window.DEV_API_BASE_URL` to your local dev Worker origin (no trailing slash).

**Order:** create D1 → edit `worker/wrangler.toml` → `npm install` in `worker/` → apply migrations → `npm run deploy` → put the production Worker URL in the frontend config → deploy `frontend/` to Cloudflare Pages (or another static host).

For the full deployment guide (Node, Cloudflare, CORS, troubleshooting), see **`docs/DEPLOYMENT.md`** in the project repository.
