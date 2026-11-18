# Security

## Reporting a vulnerability

If you believe you have found a security issue in this repository or a deployed instance of Locus:

1. **Do not** open a public GitHub issue with exploit details.
2. Email the maintainers at the address listed on your deployment’s support contact (configure `SUPPORT_EMAIL` on the Worker — see `wrangler.toml.example`).
3. Include reproduction steps, impact, and affected routes or versions.

We will acknowledge receipt within a few business days when possible.

## Deployer responsibilities

- Store **`JWT_SECRET`**, **`NGEN_CREDENTIALS_KEY`**, **`NGEN_CREDENTIAL_REPACK_SECRET`**, **`PASSWORD_RESET_SECRET`**, and nGen/USAN service credentials in **Wrangler secrets** or `.dev.vars` — never in git.
- Use a long random **`NGEN_CREDENTIAL_REPACK_SECRET`** and restrict who can call `POST /api/internal/credential-repack-masters` (shared secret header; see `docs/SECURITY_ROUTE_AUDIT.md`).
- Rotate credentials after any accidental commit or public leak (`docs/SECRET_ROTATION.md`).
- Run `npm run check:public` before pushing to a public remote.

## Scope

This file covers the **Locus** open-source tree. Third-party systems (USA North / nGen, Cloudflare, Mapbox) have their own terms and security programs.