#!/usr/bin/env node
/** Deploy staging Worker: pending migrations, deploy, credential repack. */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = join(__dirname, "..");

function run(cmd, env = {}) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, {
    cwd: DEPLOY_DIR,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
}

run("npm run d1:migrate:staging");
run("npx wrangler deploy --env staging");
try {
  run("node scripts/post-deploy-credential-repack.mjs", { WRANGLER_ENV: "staging" });
} catch (err) {
  console.warn(
    "[deploy-staging] credential repack skipped or failed (often DNS not ready for the staging API host).",
    err instanceof Error ? err.message : err
  );
}
