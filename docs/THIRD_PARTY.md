# Third-party services

Locus integrates with operator and infrastructure systems. **This repository is not affiliated with, endorsed by, or sponsored by USA North 811, PelicanCorp, or other one-call operators.**

## USA North / nGen / POSR

- API and web endpoints (e.g. `undergroundservicealert.org`) are **third-party services** governed by their terms of use.
- Deployers are responsible for **authorized credentials**, acceptable use, and compliance with operator policies.
- Do not commit live credentials, HAR captures, or production ticket exports to git.

## Other integrations

| Provider | Use in Locus |
|----------|----------------|
| Cloudflare | Workers, D1, R2, KV, Email Sending |
| Mapbox | Optional satellite/streets basemap (`pk.*` public token) |
| OpenStreetMap / Carto / Clark County GIS | Basemaps and reference layers (see `frontend/data/ATTRIBUTION.txt`) |

See [DEPLOYMENT.md](DEPLOYMENT.md) for configuration and [LICENSE](../LICENSE) for this source tree (MIT).