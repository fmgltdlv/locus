import type { Env } from "../types.js";

/** Keep defaults/bounds in sync with `lib/timeouts.cjs`. */
const DEFAULT_COOPERATIVE_LOCK_MS = 30 * 60 * 1000;
const DEFAULT_TICKET_DETAIL_COOP_LOCK_MS = 2 * 60 * 1000;
const COOPERATIVE_LOCK_MIN_MS = 1000;
const COOPERATIVE_LOCK_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function parseBoundedLockMs(raw: unknown, defaultMs: number): number {
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n >= COOPERATIVE_LOCK_MIN_MS && n <= COOPERATIVE_LOCK_MAX_MS) {
      return n;
    }
  }
  return defaultMs;
}

/**
 * USAN org list / PAC poll lock (wrangler `COOPERATIVE_LOCK_MS`).
 */
export function resolveCooperativeLockMs(env: Env): number {
  return parseBoundedLockMs(env.COOPERATIVE_LOCK_MS, DEFAULT_COOPERATIVE_LOCK_MS);
}

/**
 * Per-ticket nGen full-detail refresh skip (wrangler `TICKET_DETAIL_COOP_LOCK_MS`).
 * Used for GET /api/public-config without importing CJS into TS entrypoints.
 */
export function resolveTicketDetailCoopLockMs(env: Env): number {
  return parseBoundedLockMs(env.TICKET_DETAIL_COOP_LOCK_MS, DEFAULT_TICKET_DETAIL_COOP_LOCK_MS);
}

/** Ticket Hub bulk renewal (POST /api/tickets/renew). Vars/secrets use string `"1"` to enable. */
export function resolveEnableTicketRenewal(env: Env): boolean {
  const v = env.ENABLE_TICKET_RENEWAL as unknown;
  if (v === true || v === 1) return true;
  return String(v ?? "").trim() === "1";
}
