import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { validatePasswordPolicy } from "../lib/passwordPolicy.js";
import {
  clearLoginRateLimits,
  decidePasswordResetAttempt,
  logAuthRateLimitBlock,
  loginRateLimitBlock,
  normalizeLoginIdentifier,
  readPasswordResetRateState,
  recordFailedLoginAttempt,
  restorePasswordResetRateState,
  writePasswordResetRateState,
  type PasswordResetAttemptDecision,
  type RateLimitState,
} from "../lib/loginRateLimit.js";
import {
  authMiddleware,
  bumpSessionVersion,
  EMAIL_PASSWORD_REQUIRED_MESSAGE,
  hashPassword,
  login as doLogin,
} from "../auth.js";
import { normalizeOrgRole } from "../lib/roles.js";
// @ts-ignore CJS
import { allRows, getRow, runDb } from "../lib/db.cjs";
import type { AuthUser, Env } from "../types.js";
import { signupRoutes } from "./signupRoutes.js";
import { passwordResetPagePath, transactionalFromEmail } from "../lib/appBranding.js";

const r = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>() as any;
r.route("/", signupRoutes);
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_MESSAGE = "If an account exists for that email, we sent a password reset link.";

type PasswordResetUser = {
  id: number;
  email: string;
  full_name?: string | null;
};

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeHeader(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashResetToken(token: string, secret: string): Promise<string> {
  return sha256Hex(`${secret}:${token}`);
}

function generateResetToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function resetPageUrl(env: Env): string {
  const raw = String(env.PASSWORD_RESET_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!raw) return passwordResetPagePath(env);
  if (/\.html$/i.test(raw)) return raw;
  return `${raw}/reset-password.html`;
}

/**
 * Uses dynamic import so `wrangler dev` / Miniflare can start without the production-only `cloudflare:email` module.
 */
async function createPasswordResetEmailMessage(
  env: Env,
  to: string,
  resetUrl: string,
  displayName?: string | null
): Promise<unknown> {
  const from = transactionalFromEmail(env);
  const safeTo = safeHeader(to);
  const greeting = displayName && String(displayName).trim() ? `Hi ${String(displayName).trim()},` : "Hi,";
  const body = [
    greeting,
    "",
    "We received a request to reset the password for your Locus account.",
    "",
    "Use this link within 15 minutes:",
    resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\r\n");
  const raw = [
    `From: Locus <${from}>`,
    `To: ${safeTo}`,
    "Subject: Reset your Locus password",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const { EmailMessage } = await import("cloudflare:email");
  return new EmailMessage(from, safeTo, raw);
}

/** True when the reset email was sent, or a local runtime logged the link instead. */
async function sendPasswordResetEmail(env: Env, user: PasswordResetUser, resetUrl: string): Promise<boolean> {
  if (!env.SEND_EMAIL) {
    console.error("[password-reset] SEND_EMAIL binding is not configured");
    return false;
  }
  let message: unknown;
  try {
    message = await createPasswordResetEmailMessage(env, user.email, resetUrl, user.full_name);
  } catch (e) {
    const appEnv = String(env.APP_ENV || "").trim().toLowerCase();
    const devLike =
      appEnv === "development" || appEnv === "dev" || appEnv === "test" || appEnv === "local";
    if (devLike) {
      console.warn(
        "[password-reset] Email API unavailable (local/runtime). Reset link for testing:",
        resetUrl,
        e instanceof Error ? e.message : e
      );
      return true;
    }
    console.warn(
      "[password-reset] Email API unavailable; reset email was not sent.",
      e instanceof Error ? e.message : e
    );
    return false;
  }
  await env.SEND_EMAIL.send(message);
  return true;
}

r.post("/login", async (c) => {
  let body: { email?: string; password?: string } = {};
  try {
    body = (await c.req.json()) as { email?: string; password?: string };
  } catch {
    /* empty body */
  }
  const email = normalizeLoginIdentifier(String(body.email || ""));
  const password = String(body.password || "");
  if (!email || !password) {
    return c.json({ error: EMAIL_PASSWORD_REQUIRED_MESSAGE }, 400);
  }
  const ip = c.req.header("cf-connecting-ip") || "";
  const ua = c.req.header("user-agent") || "";
  const jwtSecret = String(c.env.JWT_SECRET || "").trim();
  if (!jwtSecret) {
    return c.json({ error: "Server misconfiguration: JWT_SECRET" }, 500);
  }
  const db = getDatabase();
  try {
    const block = await loginRateLimitBlock(db, ip, email);
    if (block) {
      logAuthRateLimitBlock("login", block.scope, block.resetAt);
      return c.json({ error: "Invalid credentials" }, 401);
    }
  } catch (e) {
    console.warn("[login] rate limit check failed; continuing", e);
  }
  try {
    const result = await doLogin(email, password, ip, ua, jwtSecret, c.env.JWT_EXPIRY);
    try {
      await clearLoginRateLimits(db, ip, email);
    } catch (e) {
      console.warn("[login] clear rate limits failed", e);
    }
    return c.json(result);
  } catch (e) {
    try {
      await recordFailedLoginAttempt(db, ip, email);
    } catch (rateErr) {
      console.warn("[login] record failed attempt failed", rateErr);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg || "Invalid credentials" }, 401);
  }
});

r.post("/logout", authMiddleware, async (c) => {
  const user = c.get("user");
  if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
  const db = getDatabase();
  try {
    await bumpSessionVersion(db, Number(user.id));
    return c.json({ ok: true });
  } catch (e) {
    console.error("[logout] failed to invalidate session", e);
    return c.json({ error: "Failed to log out" }, 500);
  }
});

r.post("/forgot-password", async (c) => {
  let body: { email?: string } = {};
  try {
    body = (await c.req.json()) as { email?: string };
  } catch {
    /* empty body */
  }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !isLikelyEmail(email)) {
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }

  const db = getDatabase();
  let decision: PasswordResetAttemptDecision | null = null;
  let previousRate: RateLimitState | null = null;
  try {
    previousRate = await readPasswordResetRateState(db, email);
    decision = decidePasswordResetAttempt(previousRate);
  } catch (e) {
    console.warn("[password-reset] rate limit check failed; continuing", e);
  }
  if (decision?.action === "duplicate") {
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }
  if (decision?.action === "limited") {
    logAuthRateLimitBlock("password_reset", "email", decision.resetAt);
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }

  const user = (await getRow(
    db,
    "SELECT id, email, full_name FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))",
    [email]
  )) as PasswordResetUser | null;

  if (!user) {
    if (decision?.action === "accept") {
      try {
        await writePasswordResetRateState(db, email, decision.next);
      } catch (e) {
        console.warn("[password-reset] rate limit write failed", e);
      }
    }
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }

  const resetSecret = String(c.env.PASSWORD_RESET_SECRET || "").trim();
  if (!resetSecret) {
    console.error("[password-reset] PASSWORD_RESET_SECRET is not configured");
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }

  let newTokenId: number | null = null;
  let sent = false;
  let reserved = false;
  if (decision?.action === "accept") {
    try {
      await writePasswordResetRateState(db, email, decision.next);
      reserved = true;
    } catch (e) {
      console.warn("[password-reset] rate limit reserve failed; continuing", e);
    }
  }
  try {
    const token = generateResetToken();
    const tokenHash = await hashResetToken(token, resetSecret);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    const resetUrl = `${resetPageUrl(c.env)}?token=${encodeURIComponent(token)}`;

    const inserted = await runDb(
      db,
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [
        user.id,
        tokenHash,
        expiresAt,
        c.req.header("cf-connecting-ip") || null,
        c.req.header("user-agent") || null,
      ]
    );
    newTokenId = Number(inserted.lastID);
    sent = await sendPasswordResetEmail(c.env, user, resetUrl);
    if (!sent) {
      if (newTokenId) {
        await runDb(db, "DELETE FROM password_reset_tokens WHERE id = ?", [newTokenId]);
      }
      if (reserved && previousRate) {
        try {
          await restorePasswordResetRateState(db, email, previousRate);
        } catch (restoreErr) {
          console.warn("[password-reset] failed to restore rate limit after send failure", restoreErr);
        }
      }
      return c.json({ message: PASSWORD_RESET_MESSAGE });
    }
  } catch (e) {
    console.error("[password-reset] failed to send reset email", e);
    if (!sent && newTokenId) {
      try {
        await runDb(db, "DELETE FROM password_reset_tokens WHERE id = ?", [newTokenId]);
      } catch (cleanupErr) {
        console.warn("[password-reset] failed to drop unsent token", cleanupErr);
      }
    }
    if (!sent && reserved && previousRate) {
      try {
        await restorePasswordResetRateState(db, email, previousRate);
      } catch (restoreErr) {
        console.warn("[password-reset] failed to restore rate limit after send failure", restoreErr);
      }
    }
    return c.json({ message: PASSWORD_RESET_MESSAGE });
  }

  try {
    await runDb(
      db,
      "DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL AND id != ?",
      [user.id, newTokenId]
    );
  } catch (e) {
    console.warn("[password-reset] email sent, but old-link cleanup failed", e);
  }

  return c.json({ message: PASSWORD_RESET_MESSAGE });
});

r.post("/reset-password", async (c) => {
  let body: { token?: string; password?: string } = {};
  try {
    body = (await c.req.json()) as { token?: string; password?: string };
  } catch {
    /* empty body */
  }

  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  if (!token || !password) {
    return c.json({ error: "Reset token and new password are required" }, 400);
  }
  const policy = validatePasswordPolicy(password);
  if (policy.ok === false) {
    return c.json({ error: policy.error }, 400);
  }

  const resetSecret = String(c.env.PASSWORD_RESET_SECRET || "").trim();
  if (!resetSecret) {
    return c.json({ error: "Server misconfiguration: PASSWORD_RESET_SECRET" }, 500);
  }

  const db = getDatabase();
  const tokenHash = await hashResetToken(token, resetSecret);
  const row = (await getRow(
    db,
    `SELECT prt.id, prt.user_id, prt.expires_at
     FROM password_reset_tokens prt
     JOIN users u ON u.id = prt.user_id
     WHERE prt.token_hash = ? AND prt.used_at IS NULL`,
    [tokenHash]
  )) as { id: number; user_id: number; expires_at: string } | null;

  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    return c.json({ error: "Invalid or expired reset link" }, 400);
  }

  await runDb(
    db,
    `UPDATE users
     SET password_hash = ?,
         session_version = COALESCE(session_version, 0) + 1,
         password_changed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [hashPassword(password), row.user_id]
  );
  await runDb(db, "UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
  await runDb(db, "DELETE FROM password_reset_tokens WHERE user_id = ? AND id != ?", [row.user_id, row.id]);

  return c.json({ message: "Password reset successfully" });
});

r.get("/me", authMiddleware, async (c) => {
  const u = c.get("user");
  if (!u?.id) return c.json({ error: "Unauthorized" }, 401);
  const db = getDatabase();
  const row = await getRow(
    db,
    `SELECT 
            u.id,
            u.username,
            u.email,
            u.role,
            u.organization_id,
            u.default_organization_id,
            u.full_name,
            u.phone,
            u.preferred_language,
            u.last_login,
            u.created_at,
            o.name as organization_name
        FROM users u
        LEFT JOIN organizations o ON o.id = COALESCE(u.default_organization_id, u.organization_id)
        WHERE u.id = ?`,
    [u.id]
  );
  if (!row) return c.json({ error: "User not found" }, 404);
  const userOrgs = await allRows(db, "SELECT organization_id, role FROM user_organizations WHERE user_id = ?", [
    row.id,
  ]);
  const organizationIds = userOrgs.map((uo: Record<string, unknown>) => Number(uo.organization_id));
  const adminOrganizationIds = userOrgs
    .filter((uo: Record<string, unknown>) => uo.role === "admin")
    .map((uo: Record<string, unknown>) => Number(uo.organization_id));
  const organizationMemberships = userOrgs.map((uo: Record<string, unknown>) => ({
    organizationId: Number(uo.organization_id),
    role: normalizeOrgRole(uo.role != null ? String(uo.role) : "operator"),
  }));
  const defaultOrgId =
    row.default_organization_id != null
      ? Number(row.default_organization_id)
      : row.organization_id != null
        ? Number(row.organization_id)
          : organizationIds.length > 0
          ? organizationIds[0]
          : null;
  return c.json({
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    organizationId: defaultOrgId,
    defaultOrganizationId:
      row.default_organization_id != null ? Number(row.default_organization_id) : null,
    organizationIds,
    adminOrganizationIds,
    organizationMemberships,
    fullName: row.full_name,
    phone: row.phone != null ? String(row.phone) : null,
    preferredLanguage: row.preferred_language === "es" ? "es" : "en",
    last_login: row.last_login,
    created_at: row.created_at,
    organization_name: row.organization_name,
  });
});

export { r as authRoutes };
