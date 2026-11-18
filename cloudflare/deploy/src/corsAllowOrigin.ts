import type { Context } from "hono";
import type { Env } from "./types.js";

/**
 * Origins always merged into the allowlist (in addition to `CORS_ORIGINS`), unless env is `*`.
 * Change here if your production or staging UI host changes.
 */
/** Production UI origins — set `CORS_ORIGINS` in wrangler.toml for your deployment (no hardcoded prod hosts). */
export const BUILTIN_CORS_ORIGINS = [] as const;

/**
 * Merged in when the effective policy is a list (not `*`) so local `wrangler dev` + static servers work
 * without setting `CORS_ORIGINS` (and so `.dev.vars` that omit `CORS_ORIGINS` still allow the UI).
 */
const LOCAL_DEV_UI_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
] as const;

function stripWrappingQuotes(v: string): string {
  const s = v.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function normalizeOrigin(v: string): string {
  const raw = String(v || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** Browser origin is a local static UI server (wrangler dev, Pages preview, etc.). */
export function isLocalDevBrowserOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

export function isProductionAppEnv(appEnv: string | undefined): boolean {
  return String(appEnv || "").trim().toLowerCase() === "production";
}

/**
 * Effective allowlist: built-ins plus comma-separated `CORS_ORIGINS` from Worker env.
 * - Env unset / empty → built-ins only (not `*`).
 * - Env `*` (alone or in list) → wildcard `*` outside production.
 * - Production never expands to wildcard or implicit localhost origins.
 */
export function effectiveCorsOrigins(raw: string | undefined, appEnv?: string): string[] | "*" {
  const isProduction = isProductionAppEnv(appEnv);
  const trimmed = raw != null ? stripWrappingQuotes(String(raw)) : "";
  if (trimmed === "*" && !isProduction) return "*";
  const fromEnv = trimmed
    ? trimmed
        .split(",")
        .map((o) => stripWrappingQuotes(o))
        .map((o) => normalizeOrigin(o))
        .filter(Boolean)
    : [];
  const baseOrigins = isProduction ? [...BUILTIN_CORS_ORIGINS] : [...BUILTIN_CORS_ORIGINS, ...LOCAL_DEV_UI_ORIGINS];
  const merged: string[] = baseOrigins.map(normalizeOrigin);
  if (fromEnv.includes("*") && !isProduction) return "*";
  for (const o of fromEnv) {
    if (o && o !== "*" && !merged.includes(o)) merged.push(o);
  }
  return merged;
}

/** `Origin` for CORS — uses Hono, then a raw header scan (defensive for some runtimes). */
export function requestOriginFromHono(c: Context): string {
  const fromHono = c.req.header("origin");
  if (fromHono) return fromHono;
  for (const [k, v] of c.req.raw.headers) {
    if (k.toLowerCase() === "origin") return v;
  }
  return "";
}

/** hono/cors + ResShim error paths — same rules as `effectiveCorsOrigins`. */
export function accessControlAllowOrigin(c: Context<{ Bindings: Env }>): string | null {
  const eff = effectiveCorsOrigins(c.env.CORS_ORIGINS, c.env.APP_ENV);
  const origin = normalizeOrigin(requestOriginFromHono(c));
  if (eff === "*") return "*";
  if (origin && eff.includes(origin)) return origin;
  // Local UI on localhost/127.0.0.1 — allow even when wrangler.toml still has APP_ENV=production
  // (use .dev.vars with APP_ENV=development for full dev behavior; this only fixes CORS).
  if (origin && isLocalDevBrowserOrigin(origin)) return origin;
  return null;
}
