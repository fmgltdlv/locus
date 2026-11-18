#!/usr/bin/env node
/**
 * Pre-push guard for public repos: fail if tracked files match known secret/PII patterns
 * or if gitignored deploy files are accidentally staged.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_TRACKED = new Set([
  "cloudflare/deploy/wrangler.toml",
  "cloudflare/deploy/.dev.vars",
]);

const BANNED = [
  /dev-only-bzdfbasdfafion/i,
  /bniuhbag8h8708b807aybsdauyb/i,
  /06272026nj0marag/i,
  /folashade96@gmail/i,
  /pk\.eyJ1IjoiZm9sYXNoYWRlOTYi/i,
  /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];

function gitLines(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

let failed = false;

for (const rel of gitLines("git ls-files")) {
  if (FORBIDDEN_TRACKED.has(rel.replace(/\\/g, "/"))) {
    console.error(`[check:public] TRACKED SECRET FILE: ${rel}`);
    failed = true;
    continue;
  }
  const abs = path.join(ROOT, rel);
  let text;
  try {
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2_000_000) continue;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  for (const re of BANNED) {
    if (re.test(text)) {
      console.error(`[check:public] Pattern ${re} in ${rel}`);
      failed = true;
      break;
    }
  }
}

const staged = gitLines("git diff --cached --name-only");
for (const rel of staged) {
  const norm = rel.replace(/\\/g, "/");
  if (FORBIDDEN_TRACKED.has(norm)) {
    console.error(`[check:public] STAGED SECRET FILE: ${rel}`);
    failed = true;
  }
}

if (failed) {
  console.error("[check:public] FAILED — fix before pushing to a public remote.");
  process.exit(1);
}

console.log("[check:public] OK");