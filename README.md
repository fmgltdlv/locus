# Locus

Ticket-focused map product (`CORE_PRODUCT` optional build). Docs: [docs/README.md](docs/README.md) · [docs/SETUP.md](docs/SETUP.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

This repository is a squashed snapshot from the Core branch of a larger platform (no shared git history).

## License

[MIT](LICENSE) — see [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Third-party integrations

Locus talks to USA North / nGen and other external services. **Not affiliated with any one-call operator.** Deployers must supply their own authorized credentials. See [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md).

## Before publishing or pushing publicly

1. Copy `cloudflare/deploy/wrangler.toml.example` → `wrangler.toml` (never commit the real file).
2. Run `npm run check:public`.
3. Follow [docs/PUBLIC_RELEASE.md](docs/PUBLIC_RELEASE.md) and [docs/SECRET_ROTATION.md](docs/SECRET_ROTATION.md).
4. Optional: enable git hooks — `git config core.hooksPath .githooks` (runs `check:public` on commit).

On GitHub: enable **secret scanning** and **Dependabot** (`.github/dependabot.yml` included).

## Quick start

```bash
cd cloudflare/deploy && npm install && cp wrangler.toml.example wrangler.toml
cd ../../frontend && npm install
# See docs/SETUP.md
```