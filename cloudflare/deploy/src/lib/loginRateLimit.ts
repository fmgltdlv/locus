import { deleteAppKv, getAppKv, setAppKv } from "./appKv.js";

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_MAX_PER_IP = 20;
export const LOGIN_RATE_MAX_PER_ACCOUNT = 5;
export const PASSWORD_RESET_RATE_WINDOW_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_MAX_PER_WINDOW = 3;
export const PASSWORD_RESET_IDEMPOTENCY_MS = 60 * 1000;

export type RateLimitState = { count?: number; resetAt?: number; lastAcceptedAt?: number };

export type AuthLimitStatus = {
  limited: boolean;
  count: number;
  max: number;
  resetAt: number | null;
};

export type PasswordResetAttemptDecision =
  | { action: "duplicate" }
  | { action: "limited"; resetAt: number }
  | { action: "accept"; next: RateLimitState };

export type LoginRateLimitBlock = { scope: "ip" | "account"; resetAt: number };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeLoginIdentifier(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeLoginIp(raw: string): string {
  const ip = String(raw ?? "").trim();
  return ip || "unknown";
}

async function loginRateIpKey(ip: string): Promise<string> {
  const ipHash = await sha256Hex(normalizeLoginIp(ip));
  return `login_rate:ip:v1:${ipHash}`;
}

async function loginRateAcctKey(identifier: string): Promise<string> {
  const idHash = await sha256Hex(normalizeLoginIdentifier(identifier));
  return `login_rate:acct:v1:${idHash}`;
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

/** Pure helper — whether the bucket is at or over its limit for the current window. */
export function isRateLimitBucketExceeded(
  state: RateLimitState,
  max: number,
  windowMs: number,
  now = Date.now()
): boolean {
  const resetAt = Number(state.resetAt || 0);
  if (!resetAt || now >= resetAt) return false;
  return Number(state.count || 0) >= max;
}

/** Pure helper — next counter state after one failed attempt. */
export function nextRateLimitStateAfterFailure(
  state: RateLimitState,
  windowMs: number,
  now = Date.now()
): RateLimitState {
  const resetAt = Number(state.resetAt || 0);
  if (!resetAt || now >= resetAt) {
    return { count: 1, resetAt: now + windowMs };
  }
  return { count: Number(state.count || 0) + 1, resetAt };
}

async function readRateLimitState(db: unknown, key: string): Promise<RateLimitState> {
  return parseRateLimitState(await getAppKv(db, key));
}

async function writeRateLimitState(db: unknown, key: string, state: RateLimitState): Promise<void> {
  await setAppKv(db, key, JSON.stringify(state));
}

/** Which login bucket is blocking, if any. IP is checked before the account. */
export async function loginRateLimitBlock(
  db: unknown,
  ip: string,
  identifier: string,
  now = Date.now()
): Promise<LoginRateLimitBlock | null> {
  const [ipKey, acctKey] = await Promise.all([loginRateIpKey(ip), loginRateAcctKey(identifier)]);
  const [ipState, acctState] = await Promise.all([
    readRateLimitState(db, ipKey),
    readRateLimitState(db, acctKey),
  ]);
  if (isRateLimitBucketExceeded(ipState, LOGIN_RATE_MAX_PER_IP, LOGIN_RATE_WINDOW_MS, now)) {
    return { scope: "ip", resetAt: Number(ipState.resetAt) };
  }
  if (isRateLimitBucketExceeded(acctState, LOGIN_RATE_MAX_PER_ACCOUNT, LOGIN_RATE_WINDOW_MS, now)) {
    return { scope: "account", resetAt: Number(acctState.resetAt) };
  }
  return null;
}

/** True when either per-IP or per-account login attempt budget is exhausted. */
export async function isLoginRateLimitExceeded(
  db: unknown,
  ip: string,
  identifier: string
): Promise<boolean> {
  return (await loginRateLimitBlock(db, ip, identifier)) != null;
}

/** Log a block without the email or IP. */
export function logAuthRateLimitBlock(
  kind: "login" | "password_reset",
  scope: "ip" | "account" | "email",
  resetAt: number
): void {
  console.warn("[auth-rate-limit]", { kind, scope, resetAt });
}

/** Whether a password-reset request is a repeat, blocked, or a new counted try. */
export function decidePasswordResetAttempt(
  state: RateLimitState,
  now = Date.now()
): PasswordResetAttemptDecision {
  const resetAt = Number(state.resetAt || 0);
  const count = Number(state.count || 0);
  const lastAcceptedAt = Number(state.lastAcceptedAt || 0);
  const windowActive = resetAt > now;
  if (
    windowActive &&
    lastAcceptedAt > 0 &&
    now - lastAcceptedAt < PASSWORD_RESET_IDEMPOTENCY_MS
  ) {
    return { action: "duplicate" };
  }
  if (windowActive && count >= PASSWORD_RESET_MAX_PER_WINDOW) {
    return { action: "limited", resetAt };
  }
  if (!windowActive) {
    return {
      action: "accept",
      next: { count: 1, resetAt: now + PASSWORD_RESET_RATE_WINDOW_MS, lastAcceptedAt: now },
    };
  }
  return {
    action: "accept",
    next: { count: count + 1, resetAt, lastAcceptedAt: now },
  };
}

/** Public status for one bucket. An expired window reads as not limited. */
export function authLimitStatus(state: RateLimitState, max: number, now = Date.now()): AuthLimitStatus {
  const resetAt = Number(state.resetAt || 0);
  const active = resetAt > now;
  const count = active ? Number(state.count || 0) : 0;
  return {
    limited: active && count >= max,
    count,
    max,
    resetAt: active ? resetAt : null,
  };
}

async function passwordResetRateKey(email: string): Promise<string> {
  const emailHash = await sha256Hex(normalizeLoginIdentifier(email));
  return `password_reset_rate:v1:${emailHash}`;
}

export async function readPasswordResetRateState(db: unknown, email: string): Promise<RateLimitState> {
  return readRateLimitState(db, await passwordResetRateKey(email));
}

export async function writePasswordResetRateState(
  db: unknown,
  email: string,
  state: RateLimitState
): Promise<void> {
  await writeRateLimitState(db, await passwordResetRateKey(email), state);
}

/** Put the password-reset bucket back after a reserved try did not send. */
export async function restorePasswordResetRateState(
  db: unknown,
  email: string,
  previous: RateLimitState
): Promise<void> {
  const key = await passwordResetRateKey(email);
  const empty =
    !Number(previous.resetAt || 0) && !Number(previous.count || 0) && !Number(previous.lastAcceptedAt || 0);
  if (empty) {
    await deleteAppKv(db, key);
    return;
  }
  await writeRateLimitState(db, key, previous);
}

export type UserAuthLimits = {
  passwordReset: AuthLimitStatus;
  loginEmail: AuthLimitStatus;
  loginUsername: AuthLimitStatus;
};

/** Read password-reset and per-account login limits for one user. Does not read IP limits. */
export async function readUserAuthLimits(
  db: unknown,
  email: string,
  username: string,
  now = Date.now()
): Promise<UserAuthLimits> {
  const emailId = normalizeLoginIdentifier(email);
  const usernameId = normalizeLoginIdentifier(username);
  const resetState = emailId ? await readPasswordResetRateState(db, emailId) : {};
  const emailState = emailId ? await readRateLimitState(db, await loginRateAcctKey(emailId)) : {};
  const usernameState =
    usernameId && usernameId !== emailId
      ? await readRateLimitState(db, await loginRateAcctKey(usernameId))
      : usernameId
        ? emailState
        : {};
  return {
    passwordReset: authLimitStatus(resetState, PASSWORD_RESET_MAX_PER_WINDOW, now),
    loginEmail: authLimitStatus(emailState, LOGIN_RATE_MAX_PER_ACCOUNT, now),
    loginUsername: authLimitStatus(usernameState, LOGIN_RATE_MAX_PER_ACCOUNT, now),
  };
}

/** Delete password-reset and per-account login buckets for this user. IP buckets stay. */
export async function clearUserAuthLimits(db: unknown, email: string, username: string): Promise<void> {
  const keys = new Set<string>();
  const emailId = normalizeLoginIdentifier(email);
  const usernameId = normalizeLoginIdentifier(username);
  if (emailId) {
    keys.add(await passwordResetRateKey(emailId));
    keys.add(await loginRateAcctKey(emailId));
  }
  if (usernameId) keys.add(await loginRateAcctKey(usernameId));
  await Promise.all([...keys].map((key) => deleteAppKv(db, key)));
}

/** Increment failed-attempt counters for IP and account identifier. */
export async function recordFailedLoginAttempt(
  db: unknown,
  ip: string,
  identifier: string
): Promise<void> {
  const now = Date.now();
  const [ipKey, acctKey] = await Promise.all([loginRateIpKey(ip), loginRateAcctKey(identifier)]);
  const [ipState, acctState] = await Promise.all([
    readRateLimitState(db, ipKey),
    readRateLimitState(db, acctKey),
  ]);
  await Promise.all([
    writeRateLimitState(
      db,
      ipKey,
      nextRateLimitStateAfterFailure(ipState, LOGIN_RATE_WINDOW_MS, now)
    ),
    writeRateLimitState(
      db,
      acctKey,
      nextRateLimitStateAfterFailure(acctState, LOGIN_RATE_WINDOW_MS, now)
    ),
  ]);
}

/** Clear login rate-limit buckets after a successful authentication. */
export async function clearLoginRateLimits(
  db: unknown,
  ip: string,
  identifier: string
): Promise<void> {
  const [ipKey, acctKey] = await Promise.all([loginRateIpKey(ip), loginRateAcctKey(identifier)]);
  await Promise.all([deleteAppKv(db, ipKey), deleteAppKv(db, acctKey)]);
}
