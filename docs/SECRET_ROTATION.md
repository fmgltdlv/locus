# Secret rotation checklist

Run this after any credential may have been exposed (public git leak, shared zip, lost laptop) or before handing off production access.

| Secret | Where to set | Action |
|--------|----------------|--------|
| `JWT_SECRET` | `wrangler secret put JWT_SECRET` (per env) | Rotating invalidates all user sessions. |
| `PASSWORD_RESET_SECRET` | `wrangler secret put PASSWORD_RESET_SECRET` | Invalidates outstanding reset tokens. |
| `NGEN_CREDENTIALS_KEY` | New key + bulk repack | Set new key, optional `NGEN_CREDENTIALS_KEY_OLD`, run `POST /api/internal/credential-repack-masters` or `npm run deploy`. |
| `NGEN_CREDENTIAL_REPACK_SECRET` | `wrangler secret put` + CI/build env | Update deploy script env; old value cannot call repack. |
| `USAN_SERVICE_USERNAME` / `USAN_SERVICE_PASSWORD` | Wrangler secrets (dev/test only unless your model uses globals) | Change at the operator portal if the password was exposed. |
| Mapbox `pk.*` token | Mapbox dashboard | Revoke token; issue new; restrict allowed URLs. |
| Org master nGen passwords | D1 `organization_pacweb_accounts` + Admin UI | Change at nGen if ciphertext key was compromised. |

## Cloudflare (quick commands)

```bash
cd cloudflare/deploy
npx wrangler secret put JWT_SECRET --env staging   # omit --env for default/production
npx wrangler secret put NGEN_CREDENTIALS_KEY
npx wrangler secret put NGEN_CREDENTIAL_REPACK_SECRET
```

Verify deployment env in the dashboard: **Workers & Pages → your Worker → Settings → Variables and secrets**.

## Verify locally before push

```bash
npm run check:public
```