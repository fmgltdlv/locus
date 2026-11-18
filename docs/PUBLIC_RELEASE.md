# Public repository checklist

Use this when publishing **locus** (or a fork) to a public git host.

## Before the first public push

1. **Worker config** — Keep real `cloudflare/deploy/wrangler.toml` **local only** (gitignored). Copy from `wrangler.toml.example` on new machines.
2. **Rotate live secrets** if they ever appeared in git history: see [SECRET_ROTATION.md](SECRET_ROTATION.md).
3. **Frontend overrides** — Set `frontend/js/config-override.js` (and staging/core variants) with your API hosts and Mapbox `pk.*` token. For production CSP, set `CSP_DEPLOYMENT_ORIGINS` when running `npm run build` in `frontend/`.
4. **Branding env** — Set `SUPPORT_EMAIL`, `TRANSACTIONAL_FROM_EMAIL`, `PASSWORD_RESET_ORIGIN`, and `CORS_ORIGINS` in `wrangler.toml` / secrets.
5. **Local secrets** — Never commit `.env` or `cloudflare/deploy/.dev.vars`.

## Automated checks

```bash
npm run check:public          # tracked-file secret patterns + staged gitignored paths
git config core.hooksPath .githooks   # optional pre-commit hook (same check)
```

`npm run ci` includes `check:public`.

## GitHub repository settings

- Enable **Secret scanning** and **Push protection** (Settings → Code security).
- Dependabot: `.github/dependabot.yml` (enable in Settings → Code security if needed).
- Add branch protection on `main` (require `ci` / status checks when configured).

## Optional hardening

- Restrict Mapbox public tokens to your deployment URL(s).
- Use `git filter-repo` if additional commits contained credentials after this scrub.

## What is safe to publish

Application source (`frontend/`, `cloudflare/deploy/src/`), SQL migrations, the **public** docs under `docs/` (see `docs/README.md`), and public geodata under `frontend/data/`.

Keep internal runbooks (architecture books, deep nGen API notes, blast-radius plans) in a **private** repo or wiki — they are intentionally omitted from this tree.