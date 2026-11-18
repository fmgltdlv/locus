#!/usr/bin/env node
/**
 * Post-deploy: POST /api/internal/credential-repack-masters (no-op when KV fingerprint matches).
 *
 * Wired into `npm run deploy` after `wrangler deploy`.
 *
 * Environment (build machine / local shell):
 *   CREDENTIAL_REPACK_ORIGIN — workers.dev origin for this POST (preferred; skips zone WAF)
 *   WORKER_ORIGIN — public API origin. Used for this POST only when CREDENTIAL_REPACK_ORIGIN
 *     is unset, except an http:// value in the shell or .dev.vars (local wrangler dev), which wins.
 *   NGEN_CREDENTIAL_REPACK_SECRET — same value as on the Worker (required when repack runs)
 *   SKIP_CREDENTIAL_REPACK=1 — skip entirely (e.g. preview uploads)
 *
 * Local: values can live in `.dev.vars` or `wrangler.toml` `[vars]` (loaded if not already in process.env).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = join(__dirname, "..");

/** @param {string} line */
function parseKeyValueLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return key ? { key, val } : null;
}

function applyKeyValue(key, val) {
  if (key && process.env[key] == null) process.env[key] = val;
}

function loadDevVars() {
  const path = join(DEPLOY_DIR, ".dev.vars");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const kv = parseKeyValueLine(line);
    if (kv) applyKeyValue(kv.key, kv.val);
  }
}

/** Read deploy-related keys from wrangler.toml `[vars]` or `[env.<name>.vars]` when WRANGLER_ENV is set. */
function loadWranglerTomlVars() {
  const path = join(DEPLOY_DIR, "wrangler.toml");
  if (!existsSync(path)) return;
  const wranglerEnv = String(process.env.WRANGLER_ENV || "").trim();
  const targetSection = wranglerEnv ? `[env.${wranglerEnv}.vars]` : "[vars]";
  let inVars = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === targetSection) {
      inVars = true;
      continue;
    }
    if (inVars && trimmed.startsWith("[") && trimmed.endsWith("]")) break;
    if (!inVars) continue;
    const kv = parseKeyValueLine(line);
    if (!kv) continue;
    if (
      kv.key === "CREDENTIAL_REPACK_ORIGIN" ||
      kv.key === "WORKER_ORIGIN" ||
      kv.key === "NGEN_CREDENTIAL_REPACK_SECRET"
    ) {
      applyKeyValue(kv.key, kv.val);
    }
  }
}

function stripOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/** http:// loopback or LAN. Must not treat an https public host as a local override. */
function isLocalHttpOrigin(origin) {
  try {
    return new URL(origin).protocol === "http:";
  } catch {
    return false;
  }
}

function loadLocalDeployConfig() {
  loadDevVars();
  const explicit = {
    repackOrigin: stripOrigin(process.env.CREDENTIAL_REPACK_ORIGIN),
    workerOrigin: stripOrigin(process.env.WORKER_ORIGIN),
  };
  loadWranglerTomlVars();
  return explicit;
}

function resolveRepackOrigin(explicit) {
  if (explicit.repackOrigin) return explicit.repackOrigin;
  if (explicit.workerOrigin && isLocalHttpOrigin(explicit.workerOrigin)) {
    return explicit.workerOrigin;
  }

  const repackOrigin = stripOrigin(process.env.CREDENTIAL_REPACK_ORIGIN);
  if (repackOrigin) return repackOrigin;

  const fromEnv = stripOrigin(process.env.WORKER_ORIGIN);
  if (fromEnv) return fromEnv;

  const deployJsonPath = join(DEPLOY_DIR, "worker-deployment.json");
  if (existsSync(deployJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(deployJsonPath, "utf8"));
      const candidate =
        data.workerOrigin || data.workersDevUrl || data.apiOrigin || data.workerPublicOrigin;
      if (candidate) return String(candidate).trim().replace(/\/+$/, "");
    } catch {
      /* ignore malformed json */
    }
  }

  return "";
}

/** Zone WAF block page. The Worker never sees the request. */
function cloudflareBlockMessage(status, text) {
  if (status !== 403 || typeof text !== "string") return "";
  if (!/sorry, you have been blocked/i.test(text) && !/cf-error-details/i.test(text)) {
    return "";
  }
  const ray = text.match(/Ray ID:\s*(?:<strong[^>]*>)?([0-9a-f]+)/i);
  const rayId = ray ? ray[1] : "unknown";
  return (
    `[credential-repack] Cloudflare blocked the request before it reached the Worker ` +
    `(HTTP 403, Ray ID ${rayId}). Use CREDENTIAL_REPACK_ORIGIN (workers.dev), not the public custom domain.`
  );
}

function shouldSkip() {
  const v = String(process.env.SKIP_CREDENTIAL_REPACK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main() {
  if (shouldSkip()) {
    console.log("[credential-repack] SKIP_CREDENTIAL_REPACK set; skipping.");
    return;
  }

  const explicitOrigins = loadLocalDeployConfig();

  const secret = String(process.env.NGEN_CREDENTIAL_REPACK_SECRET || "").trim();
  if (!secret) {
    console.warn(
      "[credential-repack] NGEN_CREDENTIAL_REPACK_SECRET unset; skipping post-deploy repack."
    );
    return;
  }

  const origin = resolveRepackOrigin(explicitOrigins);
  if (!origin) {
    console.error(
      "[credential-repack] CREDENTIAL_REPACK_ORIGIN or WORKER_ORIGIN is required (set in env, .dev.vars, wrangler.toml [vars], or worker-deployment.json)."
    );
    process.exit(1);
  }

  const url = `${origin}/api/internal/credential-repack-masters`;
  console.log(`[credential-repack] POST ${url}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "X-Ngen-Credential-Repack-Secret": secret },
  });

  const text = await res.text();
  const blocked = cloudflareBlockMessage(res.status, text);
  if (blocked) {
    console.error(blocked);
    process.exit(1);
  }

  /** @type {Record<string, unknown>} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 180);
    body = { raw: snippet };
  }

  if (!res.ok) {
    console.error("[credential-repack] request failed:", res.status, body);
    process.exit(1);
  }

  console.log("[credential-repack] response:", JSON.stringify(body));

  if (body.skipped === true) {
    console.log("[credential-repack] no work needed (fingerprint already matches primary key).");
  } else if (typeof body.rowsUpdated === "number") {
    console.log(
      `[credential-repack] repacked ${body.rowsUpdated} master row(s) in ${body.durationMs ?? "?"}ms.`
    );
  }
}

main().catch((err) => {
  console.error("[credential-repack] unexpected error:", err);
  process.exit(1);
});
