# D1 migrations (deprecated path)

**Do not add SQL files here.**

All D1 schema migrations live in **[`../deploy/migrations/`](../deploy/migrations/)** and are applied from the Worker project:

```bash
cd cloudflare/deploy
npm run d1:migrate:local    # Miniflare D1
npm run d1:migrate:remote   # production D1 (also runs automatically via npm run deploy)
```

See [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) and [`../deploy/README.md`](../deploy/README.md).
