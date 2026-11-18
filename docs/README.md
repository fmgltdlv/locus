# Locus documentation (public)

Deployable guide set for this repository. Internal architecture plans and deep nGen API write-ups are not published here.

## Start here

| Doc | Purpose |
|-----|---------|
| [SETUP.md](SETUP.md) | First install — Node, Worker, D1, local UI |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production/staging deploy, Cloudflare, secrets, UI build |
| [STAGING.md](STAGING.md) | Optional cloud staging environment (template) |
| [THIRD_PARTY.md](THIRD_PARTY.md) | USA North / nGen / external services (not affiliated) |

## Security & public hosting

| Doc | Purpose |
|-----|---------|
| [PUBLIC_RELEASE.md](PUBLIC_RELEASE.md) | Checklist before pushing a public remote |
| [SECRET_ROTATION.md](SECRET_ROTATION.md) | Rotate credentials after a leak or handoff |
| [SECURITY_ROUTE_AUDIT.md](SECURITY_ROUTE_AUDIT.md) | Route auth matrix (deployers) |
| [error-codes.md](error-codes.md) | Application error codes (Admin → Errors) |

Repository root: [LICENSE](../LICENSE) · [SECURITY.md](../SECURITY.md).

## What the app does (overview)

Locus is a **map-first** excavation ticket workspace: import and refresh tickets from USAN-facing sources (PAC, nGen, public POSR), cluster them on a Leaflet map, and use **Ticket Hub** / **Data Hub** for search, compliance, photos, and optional USAN write actions when `ENABLE_TICKET_RENEWAL=1`.

The **Worker** lives in [`cloudflare/deploy/`](../cloudflare/deploy/). The static UI is [`frontend/`](../frontend/). Configure the API with [`frontend/js/config-override.js`](../frontend/js/config-override.js) (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## Quick start (already configured)

```bash
cd cloudflare/deploy && npm run dev
```

Serve `frontend/` and match `config-override.js` to the Worker origin (often `http://127.0.0.1:8787`). You need at least one user in D1 before login — see [SETUP.md](SETUP.md).

## Configuration highlights

- **API URL** — `window.API_BASE_URL` / `window.DEV_API_BASE_URL` in `config-override.js`
- **Worker secrets** — `wrangler secret put` and `.dev.vars` (gitignored); see [DEPLOYMENT.md](DEPLOYMENT.md)
- **CORS** — `CORS_ORIGINS` and `PASSWORD_RESET_ORIGIN` in `wrangler.toml`
- **Ticket renewal / remark / create** — `ENABLE_TICKET_RENEWAL=1` on the Worker

## Troubleshooting

- **Worker logs** — Wrangler terminal and Cloudflare dashboard
- **Browser** — DevTools console and network tab
- **Incidents** — error codes in [error-codes.md](error-codes.md)

## Code layout

- [`cloudflare/README.md`](../cloudflare/README.md) — Cloudflare folder overview
- [`cloudflare/deploy/README.md`](../cloudflare/deploy/README.md) — Worker package