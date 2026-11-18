#!/usr/bin/env node
/** Deploy Core Worker: UI assets + API on the core env (see wrangler.toml [env.core]). */
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = join(__dirname, "..");
const FRONTEND_DIR = join(DEPLOY_DIR, "..", "..", "frontend");

function run(cmd, cwd = DEPLOY_DIR, env = {}) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
}

run("npm run build:core", FRONTEND_DIR);
// Pages `_redirects` 200 rewrites are rejected by Workers static assets (infinite-loop check).
rmSync(join(FRONTEND_DIR, "dist", "_redirects"), { force: true });
run("npm run d1:migrate:core");
run("npx wrangler deploy --env core");
try {
  run("node scripts/post-deploy-credential-repack.mjs", DEPLOY_DIR, { WRANGLER_ENV: "core" });
} catch (err) {
  console.warn(
    "[deploy-core] credential repack skipped or failed (DNS/workers.dev may not be ready yet).",
    err instanceof Error ? err.message : err
  );
}