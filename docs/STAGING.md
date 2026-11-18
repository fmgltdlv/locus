# Staging environment (template)

Cloud-hosted environment on real Workers + D1 + R2 + KV (not Miniflare). Replace placeholders with **your** hosts and resource names.

| Piece | Example |
|-------|---------|
| UI (Pages or Worker assets) | `https://staging.example.com` |
| API (Worker) | `https://staging-api.example.com` |
| D1 | `locus-db-staging` |
| R2 | `photos-staging` |
| KV | staging `APP_KV` namespace |
| Worker name | `your-worker-staging` |

Config: copy `cloudflare/deploy/wrangler.toml.example` → `wrangler.toml`, fill `[env.staging]`, and set `CORS_ORIGINS` to your staging UI origin.

## Deploy

From the repository root:

```bash
npm run deploy:staging:api
npm run deploy:staging:ui
```

Or `npm run deploy:staging` for both.