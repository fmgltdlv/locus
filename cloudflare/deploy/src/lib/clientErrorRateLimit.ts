import { getAppKv, setAppKv } from "./appKv.js";
import {
  isRateLimitBucketExceeded,
  nextRateLimitStateAfterFailure,
  type RateLimitState,
} from "./loginRateLimit.js";

/** Sliding window for client error reports (per user or per IP). */
export const CLIENT_ERROR_RATE_WINDOW_MS = 60 * 1000;
export const CLIENT_ERROR_RATE_MAX = 30;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseRateLimitState(raw: string | null): RateLimitState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as RateLimitState;
  } catch {
    /* ignore */
  }
  return {};
}

async function readRateLimitState(db: unknown, key: string): Promise<RateLimitState> {
  return parseRateLimitState(await getAppKv(db, key));
}

async function writeRateLimitState(db: unknown, key: string, state: RateLimitState): Promise<void> {
  await setAppKv(db, key, JSON.stringify(state));
}

/** KV bucket key: authenticated users are keyed by user id; anonymous by hashed IP. */
export async function clientErrorRateBucketKey(
  userId: number | null | undefined,
  ip: string
): Promise<string> {
  const id = userId != null ? Number(userId) : NaN;
  if (Number.isFinite(id) && id > 0) {
    return `client_error_rate:user:v1:${id}`;
  }
  const ipNorm = String(ip || "").trim() || "unknown";
  const ipHash = await sha256Hex(ipNorm);
  return `client_error_rate:ip:v1:${ipHash}`;
}

export async function isClientErrorRateLimitExceeded(db: unknown, bucketKey: string): Promise<boolean> {
  const state = await readRateLimitState(db, bucketKey);
  return isRateLimitBucketExceeded(state, CLIENT_ERROR_RATE_MAX, CLIENT_ERROR_RATE_WINDOW_MS);
}

/** Record one client error report against the rate-limit bucket. */
export async function recordClientErrorReport(db: unknown, bucketKey: string): Promise<void> {
  const state = await readRateLimitState(db, bucketKey);
  const next = nextRateLimitStateAfterFailure(state, CLIENT_ERROR_RATE_WINDOW_MS);
  await writeRateLimitState(db, bucketKey, next);
}
