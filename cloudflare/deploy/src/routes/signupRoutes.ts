/**
 * Public self-service signup routes (mounted under /api/auth).
 */
import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { validatePasswordPolicy } from "../lib/passwordPolicy.js";
import { getAppKv, setAppKv } from "../lib/appKv.js";
import { CLOSE_SIGNUPS_KEY } from "./appSettingsAdmin.js";
import { hashPassword } from "../auth.js";
import {
  emailDomain,
  isLikelyEmail,
  isPublicEmailDomain,
  normalizeEmail,
  normalizeEmailDomain,
  parseEmailList,
  validateOrgDisplayName,
} from "../lib/signupDomain.js";
// @ts-ignore CJS
import { allRows, getRow, runDb } from "../lib/db.cjs";
// @ts-ignore CJS
import { encryptPassword } from "../lib/pacwebCredentialsCrypto.cjs";
// @ts-ignore CJS
import { pacwebEstablishSession } from "../lib/pacwebClient.cjs";
import { runPacwebPollCore } from "./tickets/pollRoutes.js";
import type { Env } from "../types.js";
import {
  appFrontendOrigin,
  supportContactPhrase,
  supportEmail,
  transactionalFromEmail,
} from "../lib/appBranding.js";

const r = new Hono<{ Bindings: Env }>() as any;

async function signupsAreClosed(db: unknown): Promise<boolean> {
  try {
    return (await getAppKv(db, CLOSE_SIGNUPS_KEY)) === "1";
  } catch (e) {
    console.warn("[signup] close-signups check:", e);
    return false;
  }
}

function signupClosedJson(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json(
    { error: "New signups are closed.", message: "New signups are closed.", path: "blocked" },
    403
  );
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_MAX = 8;
const PREVIEW_MAX = 30;
const USAN_VALIDATE_MAX = 5;
const RESEND_MAX = 3;
const MAX_SEED_ADMINS = 5;

type AllowlistRow = { organization_id: number; role: string; org_name?: string | null };
type OrgDomainRow = { id: number; name: string };

type VerifyResult =
  | {
      ok: true;
      status: 200;
      body: {
        ok: true;
        message: string;
        organizationId: number | null;
        usanSyncStarted: boolean;
      };
    }
  | { ok: false; status: number; body: { error: string; code?: string } };

function safeHeader(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

async function hashToken(token: string, secret: string): Promise<string> {
  return sha256Hex(`${secret}:${token}`);
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function frontendOrigin(env: Env): string {
  return appFrontendOrigin(env);
}

function workerApiOrigin(env: Env): string {
  return String(env.WORKER_ORIGIN || "").trim().replace(/\/+$/, "");
}

/**
 * Email verify links hit the Worker directly (HTML confirm → POST).
 * Do not rely on the Pages SPA: some mail clients rewrite/open links in a way that
 * drops ?verify= or blocks the cross-origin fetch to stgapi, so the token never runs.
 */
function verifyPageUrl(env: Env, token: string): string {
  const worker = workerApiOrigin(env);
  if (worker) {
    return `${worker}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  }
  return `${frontendOrigin(env)}/signup?verify=${encodeURIComponent(token)}`;
}

function verifiedRedirectUrl(env: Env, usanSyncStarted: boolean): string {
  const q = usanSyncStarted ? "verified=1&usanSync=1" : "verified=1";
  return `${frontendOrigin(env)}/signup?${q}`;
}

function verifyConfirmHtml(token: string): string {
  const safe = escapeHtml(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verify email — Locus</title>
</head>
<body style="font-family:DM Sans,Segoe UI,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#0f172a">
  <h1 style="font-size:1.35rem;margin:0 0 .75rem">Confirm your email</h1>
  <p style="line-height:1.45;color:#334155">Click the button below to finish creating your Locus account.</p>
  <form id="verifyForm" method="POST" action="/api/auth/verify-email">
    <input type="hidden" name="token" value="${safe}">
    <button type="submit" style="margin-top:1rem;padding:.7rem 1rem;border:0;border-radius:8px;background:#073047;color:#fff;font-weight:600;cursor:pointer;width:100%">
      Verify email
    </button>
  </form>
  <script>
    setTimeout(function () {
      var f = document.getElementById("verifyForm");
      if (f) f.submit();
    }, 400);
  </script>
</body>
</html>`;
}

function verifyResultHtml(env: Env, result: VerifyResult): string {
  if (result.ok === true) {
    const href = escapeHtml(verifiedRedirectUrl(env, result.body.usanSyncStarted));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=${href}">
<title>Verified — Locus</title></head>
<body style="font-family:sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem">
  <p>Email verified. <a href="${href}">Continue to sign in</a>.</p>
</body></html>`;
  }
  const signup = escapeHtml(`${frontendOrigin(env)}/signup`);
  const err = escapeHtml(result.body.error || "Verification failed.");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Verification failed — Locus</title></head>
<body style="font-family:sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem">
  <h1 style="font-size:1.2rem">Verification failed</h1>
  <p>${err}</p>
  <p><a href="${signup}">Back to sign up</a></p>
</body></html>`;
}

function wantsHtmlVerifyResponse(c: any): boolean {
  const accept = String(c.req.header("accept") || "").toLowerCase();
  const ct = String(c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    return true;
  }
  if (accept.includes("text/html") && !accept.includes("application/json")) return true;
  return false;
}

async function rateLimitExceeded(
  db: unknown,
  key: string,
  max: number
): Promise<boolean> {
  const now = Date.now();
  let state: { count?: number; resetAt?: number } = {};
  const raw = await getAppKv(db, key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") state = parsed;
    } catch {
      state = {};
    }
  }
  const resetAt = Number(state.resetAt || 0);
  if (!resetAt || now >= resetAt) {
    await setAppKv(db, key, JSON.stringify({ count: 1, resetAt: now + RATE_WINDOW_MS }));
    return false;
  }
  const count = Number(state.count || 0);
  if (count >= max) return true;
  await setAppKv(db, key, JSON.stringify({ count: count + 1, resetAt }));
  return false;
}

async function createEmailMessage(env: Env, to: string, subject: string, lines: string[]): Promise<unknown> {
  const from = transactionalFromEmail(env);
  const safeTo = safeHeader(to);
  const body = lines.join("\r\n");
  const raw = [
    `From: Locus <${from}>`,
    `To: ${safeTo}`,
    `Subject: ${safeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const { EmailMessage } = await import("cloudflare:email");
  return new EmailMessage(from, safeTo, raw);
}

async function sendMail(env: Env, to: string, subject: string, lines: string[]): Promise<void> {
  if (!env.SEND_EMAIL) {
    console.warn("[signup] SEND_EMAIL binding is not configured");
    return;
  }
  try {
    const message = await createEmailMessage(env, to, subject, lines);
    await env.SEND_EMAIL.send(message);
  } catch (e) {
    const appEnv = String(env.APP_ENV || "").trim().toLowerCase();
    const devLike =
      appEnv === "development" || appEnv === "dev" || appEnv === "test" || appEnv === "local";
    if (devLike) {
      console.warn("[signup] Email send failed (dev):", subject, to, e);
    } else {
      console.warn("[signup] Email send failed:", subject, e);
    }
  }
}

async function findAllowlistRows(db: unknown, email: string): Promise<AllowlistRow[]> {
  const rows = (await allRows(
    db,
    `SELECT a.organization_id, a.role, o.name AS org_name
     FROM org_signup_allowlist a
     JOIN organizations o ON o.id = a.organization_id
     WHERE LOWER(TRIM(a.email)) = ?
       AND a.consumed_at IS NULL`,
    [normalizeEmail(email)]
  )) as AllowlistRow[];
  return Array.isArray(rows) ? rows : [];
}

async function findOrgByEmailDomain(db: unknown, domain: string): Promise<OrgDomainRow | null> {
  const d = normalizeEmailDomain(domain);
  if (!d) return null;
  return (await getRow(
    db,
    `SELECT id, name FROM organizations WHERE LOWER(TRIM(email_domain)) = ? LIMIT 1`,
    [d]
  )) as OrgDomainRow | null;
}

async function isRejectedEmail(db: unknown, email: string): Promise<boolean> {
  const row = await getRow(db, `SELECT email FROM signup_rejected_emails WHERE email = ?`, [
    normalizeEmail(email),
  ]);
  return !!row;
}

async function markRejected(db: unknown, email: string, reason: string): Promise<void> {
  await runDb(
    db,
    `INSERT INTO signup_rejected_emails (email, reason) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET reason = excluded.reason`,
    [normalizeEmail(email), reason]
  );
}

async function clearRejectedIfAllowlisted(db: unknown, email: string): Promise<void> {
  const allow = await findAllowlistRows(db, email);
  if (!allow.length) return;
  await runDb(db, `DELETE FROM signup_rejected_emails WHERE email = ?`, [normalizeEmail(email)]);
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
}

type PreviewPath = "create_org" | "join_org" | "rejected" | "blocked";

async function resolvePreview(
  db: unknown,
  email: string
): Promise<{
  path: PreviewPath;
  usanRequired?: boolean;
  domainBlocked?: boolean;
  needsOrgCreate?: boolean;
  message?: string;
}> {
  if (!isLikelyEmail(email)) {
    return { path: "blocked", message: "Enter a valid email address." };
  }
  const domain = emailDomain(email);
  const allow = await findAllowlistRows(db, email);
  if (allow.length) {
    await clearRejectedIfAllowlisted(db, email);
  }
  if ((await isRejectedEmail(db, email)) && !allow.length) {
    return {
      path: "rejected",
      message: `This email cannot complete signup at this time. ${supportContactPhrase()}`,
    };
  }

  const domainOrg = !isPublicEmailDomain(domain) ? await findOrgByEmailDomain(db, domain) : null;

  if (domainOrg || allow.length) {
    return {
      path: "join_org",
      usanRequired: false,
      needsOrgCreate: false,
    };
  }

  if (isPublicEmailDomain(domain)) {
    return {
      path: "create_org",
      needsOrgCreate: true,
      usanRequired: true,
      domainBlocked: false,
    };
  }

  return {
    path: "create_org",
    needsOrgCreate: true,
    usanRequired: false,
  };
}

async function validateUsanCredentials(
  username: string,
  password: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = String(username || "").trim();
  const pass = String(password || "");
  if (!user || !pass) return { ok: false, error: "USAN username and password are required." };
  try {
    await pacwebEstablishSession(globalThis.fetch, { username: user, password: pass });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || "USAN login failed." };
  }
}

async function usanUsernameTaken(db: unknown, username: string): Promise<boolean> {
  const row = await getRow(
    db,
    `SELECT id FROM organization_pacweb_accounts WHERE LOWER(TRIM(pacweb_username)) = LOWER(TRIM(?)) LIMIT 1`,
    [username]
  );
  return !!row;
}

async function orgDisplayNameTaken(
  db: unknown,
  orgName: string,
  orgNormalized: string
): Promise<boolean> {
  const row = await getRow(
    db,
    `SELECT id FROM organizations WHERE name_normalized = ? OR LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
    [orgNormalized, orgName]
  );
  return !!row;
}

r.get("/signup-preview", async (c) => {
  const email = normalizeEmail(String(c.req.query("email") || ""));
  const db = getDatabase();
  if (await signupsAreClosed(db)) return signupClosedJson(c);
  const ip = clientIp(c);
  try {
    if (await rateLimitExceeded(db, `signup_preview_rate:v1:${ip}`, PREVIEW_MAX)) {
      return c.json({ path: "blocked", message: "Too many requests. Try again later." }, 429);
    }
  } catch (e) {
    console.warn("[signup-preview] rate limit failed", e);
  }
  const preview = await resolvePreview(db, email);
  return c.json(preview);
});

r.get("/signup-check-org-name", async (c) => {
  const db = getDatabase();
  if (await signupsAreClosed(db)) return signupClosedJson(c);
  const ip = clientIp(c);
  try {
    if (await rateLimitExceeded(db, `signup_preview_rate:v1:${ip}`, PREVIEW_MAX)) {
      return c.json({ available: false, error: "Too many requests. Try again later." }, 429);
    }
  } catch (e) {
    console.warn("[signup-check-org-name] rate limit failed", e);
  }

  const nameCheck = validateOrgDisplayName(String(c.req.query("name") || ""));
  if (nameCheck.ok === false) {
    return c.json({ available: false, code: "ORG_NAME_INVALID", error: nameCheck.error }, 400);
  }
  return c.json({ available: true, name: nameCheck.name, normalized: nameCheck.normalized });
});

r.post("/signup-validate-usan", async (c) => {
  const db = getDatabase();
  if (await signupsAreClosed(db)) return signupClosedJson(c);
  const ip = clientIp(c);
  let body: { username?: string; password?: string; email?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty */
  }
  const email = normalizeEmail(String(body.email || ""));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  try {
    if (await rateLimitExceeded(db, `signup_usan_rate:v1:${ip}`, USAN_VALIDATE_MAX)) {
      return c.json({ ok: false, error: "Too many attempts. Try again later." }, 429);
    }
    if (email && (await isRejectedEmail(db, email))) {
      const allow = await findAllowlistRows(db, email);
      if (!allow.length) {
        return c.json({ ok: false, error: "This email cannot complete signup at this time." }, 403);
      }
    }
  } catch (e) {
    console.warn("[signup-validate-usan] rate/reject check failed", e);
  }

  if (!username || !password) {
    return c.json({ ok: false, error: "USAN username and password are required." }, 400);
  }

  // Check D1 before hitting USAN — usernames are globally unique across orgs.
  if (await usanUsernameTaken(db, username)) {
    return c.json(
      {
        ok: false,
        code: "USAN_USERNAME_TAKEN",
        error:
          "This USAN username is already linked to another organization. Each provider username can only belong to one organization.",
      },
      409
    );
  }

  const result = await validateUsanCredentials(username, password);
  if (result.ok === false) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true, message: "Provider login verified." });
});

r.post("/signup", async (c) => {
  const db = getDatabase();
  if (await signupsAreClosed(db)) return signupClosedJson(c);
  const ip = clientIp(c);
  let body: {
    email?: string;
    password?: string;
    orgName?: string;
    seedAdmins?: unknown;
    seedUsers?: unknown;
    usanUsername?: string;
    usanPassword?: string;
    usanSkipped?: boolean;
  } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty */
  }

  const email = normalizeEmail(String(body.email || ""));
  const password = String(body.password || "");
  if (!isLikelyEmail(email) || !password) {
    return c.json({ error: "Email and password are required." }, 400);
  }

  try {
    if (await rateLimitExceeded(db, `signup_rate:v1:${ip}`, SIGNUP_MAX)) {
      return c.json({ error: "Too many signup attempts. Try again later." }, 429);
    }
  } catch (e) {
    console.warn("[signup] rate limit failed", e);
  }

  const policy = validatePasswordPolicy(password);
  if (policy.ok === false) {
    return c.json({ error: policy.error }, 400);
  }

  const existingUser = await getRow(
    db,
    `SELECT id FROM users WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(username)) = ? LIMIT 1`,
    [email, email]
  );
  if (existingUser) {
    return c.json(
      {
        error: "An account with this email already exists. Please sign in or reset your password.",
        code: "ALREADY_REGISTERED",
      },
      409
    );
  }

  const preview = await resolvePreview(db, email);
  if (preview.path === "rejected" || preview.path === "blocked") {
    return c.json({ error: preview.message || "Signup is not available for this email." }, 403);
  }

  const domain = emailDomain(email);
  const publicDomain = isPublicEmailDomain(domain);
  const createPath = preview.path === "create_org";
  const usanRequired = !!preview.usanRequired;
  const usanUsername = String(body.usanUsername || "").trim();
  const usanPassword = String(body.usanPassword || "");
  const usanSkipped = !!body.usanSkipped && !usanRequired;

  let orgName: string | null = null;
  let orgNormalized: string | null = null;
  let seedAdmins: string[] = [];
  let seedUsers: string[] = [];

  if (createPath) {
    const nameCheck = validateOrgDisplayName(String(body.orgName || ""));
    if (nameCheck.ok === false) return c.json({ error: nameCheck.error }, 400);
    orgName = nameCheck.name;
    orgNormalized = nameCheck.normalized;
    if (await orgDisplayNameTaken(db, orgName, orgNormalized)) {
      return c.json(
        {
          ok: false,
          code: "ORG_NAME_TAKEN",
          error:
            "That organization name is already taken. Try a different name (uniqueness ignores spaces and capitalization).",
        },
        409
      );
    }
    seedAdmins = parseEmailList(body.seedAdmins, MAX_SEED_ADMINS).filter((e) => e !== email);
    seedUsers = parseEmailList(body.seedUsers).filter(
      (e) => e !== email && !seedAdmins.includes(e)
    );
    if (seedAdmins.length > MAX_SEED_ADMINS) {
      return c.json({ error: `At most ${MAX_SEED_ADMINS} admin emails can be seeded.` }, 400);
    }
  }

  let usanEnc: string | null = null;
  if (createPath && !usanSkipped) {
    if (usanRequired && (!usanUsername || !usanPassword)) {
      // Public create without USAN after client retry → thank-you path
      await markRejected(db, email, "public_domain_no_usan");
      await sendMail(c.env, email, "Locus signup — USAN credentials", [
        "Hi,",
        "",
        "We couldn't validate your USAN credentials, so we couldn't create your account.",
        `Please ${supportContactPhrase(c.env)}`,
        "",
        "— Locus",
      ]);
      return c.json({
        ok: false,
        code: "USAN_VALIDATION_FAILED",
        thankYou: true,
        message: "Thank you for submitting, we will get back to you shortly.",
      });
    }
    if (usanUsername || usanPassword) {
      if (await usanUsernameTaken(db, usanUsername)) {
        return c.json(
          {
            ok: false,
            code: "USAN_USERNAME_TAKEN",
            error:
              "This USAN username is already linked to another organization. Each provider username can only belong to one organization.",
          },
          409
        );
      }
      const usanOk = await validateUsanCredentials(usanUsername, usanPassword);
      if (usanOk.ok === false) {
        if (publicDomain && createPath) {
          await markRejected(db, email, "public_domain_invalid_usan");
          await sendMail(c.env, email, "Locus signup — USAN credentials", [
            "Hi,",
            "",
            "We couldn't validate your USAN credentials, so we couldn't create your account.",
            `Please ${supportContactPhrase(c.env)}`,
            "",
            "— Locus",
          ]);
          return c.json({
            ok: false,
            code: "USAN_VALIDATION_FAILED",
            thankYou: true,
            message: "Thank you for submitting, we will get back to you shortly.",
          });
        }
        return c.json({ error: usanOk.error || "USAN login failed." }, 400);
      }
      usanEnc = await encryptPassword(usanPassword);
    }
  } else if (createPath && usanRequired && usanSkipped) {
    await markRejected(db, email, "public_domain_no_usan");
    await sendMail(c.env, email, "Locus signup — USAN credentials", [
      "Hi,",
      "",
      "We couldn't validate your USAN credentials, so we couldn't create your account.",
      `Please ${supportContactPhrase(c.env)}`,
      "",
            "— Locus",
    ]);
    return c.json({
      ok: false,
      code: "USAN_VALIDATION_FAILED",
      thankYou: true,
      message: "Thank you for submitting, we will get back to you shortly.",
    });
  }

  const resetSecret = String(c.env.PASSWORD_RESET_SECRET || "").trim();
  if (!resetSecret) {
    return c.json({ error: "Server misconfiguration: PASSWORD_RESET_SECRET" }, 500);
  }

  const passwordHash = hashPassword(password);
  const path = createPath ? "create_org" : "join_org";

  await runDb(db, `DELETE FROM pending_signups WHERE email = ?`, [email]);
  const insert = await runDb(
    db,
    `INSERT INTO pending_signups (
      email, password_hash, path, org_name, seed_admins_json, seed_users_json,
      usan_username, usan_password_encrypted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      email,
      passwordHash,
      path,
      orgName,
      seedAdmins.length ? JSON.stringify(seedAdmins) : null,
      seedUsers.length ? JSON.stringify(seedUsers) : null,
      usanUsername || null,
      usanEnc,
    ]
  );
  const pendingId = Number((insert as { lastID?: number })?.lastID || 0);
  if (!pendingId) {
    const row = (await getRow(db, `SELECT id FROM pending_signups WHERE email = ?`, [email])) as {
      id?: number;
    } | null;
    if (!row?.id) return c.json({ error: "Failed to start signup." }, 500);
  }
  const pendingRow = (await getRow(db, `SELECT id FROM pending_signups WHERE email = ?`, [email])) as {
    id: number;
  };

  const token = generateToken();
  const tokenHash = await hashToken(token, resetSecret);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  await runDb(
    db,
    `INSERT INTO email_verification_tokens (pending_signup_id, token_hash, expires_at, requested_ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [pendingRow.id, tokenHash, expiresAt, ip, c.req.header("user-agent") || null]
  );

  const verifyUrl = verifyPageUrl(c.env, token);
  await sendMail(c.env, email, "Verify your Locus email", [
    "Hi,",
    "",
    "Thanks for signing up for Locus.",
    "Confirm your email with this link (expires in 24 hours):",
    verifyUrl,
    "",
    "If you did not request this, you can ignore this email.",
    "",
            "— Locus",
  ]);

  return c.json({
    ok: true,
    message: "Check your email for a verification link.",
    path,
  });
});

r.post("/resend-verification", async (c) => {
  const db = getDatabase();
  if (await signupsAreClosed(db)) return signupClosedJson(c);
  const ip = clientIp(c);
  let body: { email?: string } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty */
  }
  const email = normalizeEmail(String(body.email || ""));
  const generic = { message: "If a pending signup exists for that email, we sent another verification link." };
  if (!isLikelyEmail(email)) return c.json(generic);

  try {
    if (await rateLimitExceeded(db, `signup_resend_rate:v1:${await sha256Hex(email)}`, RESEND_MAX)) {
      return c.json(generic);
    }
    if ((await isRejectedEmail(db, email)) && !(await findAllowlistRows(db, email)).length) {
      return c.json(generic);
    }
  } catch (e) {
    console.warn("[resend-verification] rate failed", e);
  }

  const pending = (await getRow(db, `SELECT id FROM pending_signups WHERE email = ?`, [email])) as {
    id: number;
  } | null;
  if (!pending) return c.json(generic);

  const resetSecret = String(c.env.PASSWORD_RESET_SECRET || "").trim();
  if (!resetSecret) return c.json(generic);

  const token = generateToken();
  const tokenHash = await hashToken(token, resetSecret);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  await runDb(db, `DELETE FROM email_verification_tokens WHERE pending_signup_id = ? AND used_at IS NULL`, [
    pending.id,
  ]);
  await runDb(
    db,
    `INSERT INTO email_verification_tokens (pending_signup_id, token_hash, expires_at, requested_ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
    [pending.id, tokenHash, expiresAt, ip, c.req.header("user-agent") || null]
  );
  await sendMail(c.env, email, "Verify your Locus email", [
    "Hi,",
    "",
    "Here is a new link to confirm your Locus email (expires in 24 hours):",
    verifyPageUrl(c.env, token),
    "",
            "— Locus",
  ]);
  return c.json(generic);
});

async function addMembership(
  db: unknown,
  userId: number,
  orgId: number,
  role: string
): Promise<void> {
  const existing = await getRow(
    db,
    `SELECT id FROM user_organizations WHERE user_id = ? AND organization_id = ?`,
    [userId, orgId]
  );
  if (existing) {
    await runDb(db, `UPDATE user_organizations SET role = ? WHERE user_id = ? AND organization_id = ?`, [
      role,
      userId,
      orgId,
    ]);
    return;
  }
  await runDb(db, `INSERT INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)`, [
    userId,
    orgId,
    role,
  ]);
}

async function consumeAllowlist(db: unknown, orgId: number, email: string): Promise<void> {
  await runDb(
    db,
    `UPDATE org_signup_allowlist SET consumed_at = CURRENT_TIMESTAMP
     WHERE organization_id = ? AND LOWER(TRIM(email)) = ? AND consumed_at IS NULL`,
    [orgId, normalizeEmail(email)]
  );
}

async function writeAllowlistSeeds(
  db: unknown,
  orgId: number,
  admins: string[],
  users: string[]
): Promise<void> {
  for (const e of admins) {
    await runDb(
      db,
      `INSERT INTO org_signup_allowlist (organization_id, email, role) VALUES (?, ?, 'admin')
       ON CONFLICT(organization_id, email) DO UPDATE SET role = 'admin', consumed_at = NULL`,
      [orgId, e]
    );
  }
  for (const e of users) {
    await runDb(
      db,
      `INSERT INTO org_signup_allowlist (organization_id, email, role) VALUES (?, ?, 'operator')
       ON CONFLICT(organization_id, email) DO UPDATE SET role = COALESCE(org_signup_allowlist.role, 'operator')`,
      [orgId, e]
    );
  }
}

async function sendInviteEmails(env: Env, orgName: string, emails: string[]): Promise<void> {
  const signupUrl = `${frontendOrigin(env)}/signup`;
  for (const e of emails) {
    await sendMail(env, e, `You're invited to ${orgName} on Locus`, [
      "Hi,",
      "",
      `You've been invited to join ${orgName} on Locus.`,
      `Create your account here: ${signupUrl}`,
      "",
      "Use this same email address when you sign up.",
      "",
      "— Locus",
    ]);
  }
}

r.get("/verify-email", async (c) => {
  const token = String(c.req.query("token") || "").trim();
  if (!token) {
    return c.html(verifyResultHtml(c.env, { ok: false, status: 400, body: { error: "Verification token is required." } }), 400);
  }
  // GET only shows a confirm page (or auto-submits a POST). Never consume the token on GET —
  // mail scanners often prefetch links and would otherwise burn one-time tokens.
  return c.html(verifyConfirmHtml(token), 200);
});

r.post("/verify-email", async (c) => {
  let token = "";
  const ct = String(c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    let body: { token?: string } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* empty */
    }
    token = String(body.token || "").trim();
  } else {
    try {
      const form = await c.req.parseBody();
      token = String((form as { token?: unknown }).token || "").trim();
    } catch {
      token = String(c.req.query("token") || "").trim();
    }
  }

  const result = await runVerify(c, token);
  if (wantsHtmlVerifyResponse(c)) {
    if (result.ok) {
      return c.redirect(verifiedRedirectUrl(c.env, result.body.usanSyncStarted), 303);
    }
    return c.html(verifyResultHtml(c.env, result), result.status);
  }
  return c.json(result.body, result.status);
});

async function runVerify(c: any, token: string): Promise<VerifyResult> {
  if (!token) return { ok: false, status: 400, body: { error: "Verification token is required." } };
  const resetSecret = String(c.env.PASSWORD_RESET_SECRET || "").trim();
  if (!resetSecret) {
    return { ok: false, status: 500, body: { error: "Server misconfiguration: PASSWORD_RESET_SECRET" } };
  }
  const db = getDatabase();
  const tokenHash = await hashToken(token, resetSecret);
  const row = (await getRow(
    db,
    `SELECT t.id AS token_id, t.expires_at, t.used_at, t.pending_signup_id,
            p.email, p.password_hash, p.path, p.org_name, p.seed_admins_json, p.seed_users_json,
            p.usan_username, p.usan_password_encrypted, p.created_at AS pending_created_at
     FROM email_verification_tokens t
     JOIN pending_signups p ON p.id = t.pending_signup_id
     WHERE t.token_hash = ?`,
    [tokenHash]
  )) as Record<string, unknown> | null;

  if (!row || row.used_at) {
    return { ok: false, status: 400, body: { error: "Invalid or expired verification link." } };
  }
  if (new Date(String(row.expires_at)).getTime() < Date.now()) {
    return {
      ok: false,
      status: 400,
      body: { error: "This verification link has expired. Please sign up again." },
    };
  }
  const pendingCreated = new Date(String(row.pending_created_at || 0)).getTime();
  if (pendingCreated && Date.now() - pendingCreated > PENDING_TTL_MS) {
    return { ok: false, status: 400, body: { error: "This signup has expired. Please sign up again." } };
  }

  const email = normalizeEmail(String(row.email || ""));
  const existingUser = await getRow(db, `SELECT id FROM users WHERE LOWER(TRIM(email)) = ?`, [email]);
  if (existingUser) {
    await runDb(db, `UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      row.token_id,
    ]);
    await runDb(db, `DELETE FROM pending_signups WHERE id = ?`, [row.pending_signup_id]);
    return {
      ok: false,
      status: 409,
      body: {
        error: "An account with this email already exists. Please sign in.",
        code: "ALREADY_REGISTERED",
      },
    };
  }

  // Re-resolve memberships (don't trust pending.path alone for join targets)
  const domain = emailDomain(email);
  const publicDomain = isPublicEmailDomain(domain);
  const allow = await findAllowlistRows(db, email);
  const domainOrg = !publicDomain ? await findOrgByEmailDomain(db, domain) : null;

  let defaultOrgId: number | null = null;
  let createdOrgId: number | null = null;
  let syncUsan = false;
  const username = email.split("@")[0] || email;

  const createRequested = String(row.path || "") === "create_org" && !domainOrg && !allow.length;

  if (createRequested) {
    const nameCheck = validateOrgDisplayName(String(row.org_name || ""));
    if (nameCheck.ok === false) {
      return { ok: false, status: 400, body: { error: nameCheck.error } };
    }
    const emailDomainValue = publicDomain ? null : domain;
    try {
      const orgInsert = await runDb(
        db,
        `INSERT INTO organizations (name, name_normalized, email_domain, settings, subscription_tier)
         VALUES (?, ?, ?, ?, 'basic')`,
        [
          nameCheck.name,
          nameCheck.normalized,
          emailDomainValue,
          JSON.stringify({}),
        ]
      );
      createdOrgId = Number((orgInsert as { lastID?: number })?.lastID || 0);
      if (!createdOrgId) {
        const found = (await getRow(
          db,
          `SELECT id FROM organizations WHERE name_normalized = ?`,
          [nameCheck.normalized]
        )) as { id: number } | null;
        createdOrgId = found?.id != null ? Number(found.id) : null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE/i.test(msg)) {
        // Race: org appeared — fall through to join
        const raced = emailDomainValue
          ? await findOrgByEmailDomain(db, emailDomainValue)
          : ((await getRow(db, `SELECT id, name FROM organizations WHERE name_normalized = ?`, [
              nameCheck.normalized,
            ])) as OrgDomainRow | null);
        if (raced) {
          defaultOrgId = Number(raced.id);
        } else {
          return { ok: false, status: 409, body: { error: "Organization name already exists." } };
        }
      } else {
        console.error("[verify-email] org create failed", e);
        return { ok: false, status: 500, body: { error: "Failed to create organization." } };
      }
    }

    if (createdOrgId) {
      defaultOrgId = createdOrgId;
      let seedAdmins: string[] = [];
      let seedUsers: string[] = [];
      try {
        seedAdmins = JSON.parse(String(row.seed_admins_json || "[]"));
        seedUsers = JSON.parse(String(row.seed_users_json || "[]"));
      } catch {
        seedAdmins = [];
        seedUsers = [];
      }
      if (!Array.isArray(seedAdmins)) seedAdmins = [];
      if (!Array.isArray(seedUsers)) seedUsers = [];
      seedAdmins = seedAdmins.map(normalizeEmail).filter(isLikelyEmail).slice(0, MAX_SEED_ADMINS);
      seedUsers = seedUsers.map(normalizeEmail).filter(isLikelyEmail);
      await writeAllowlistSeeds(db, createdOrgId, seedAdmins, seedUsers);
      await sendInviteEmails(c.env, nameCheck.name, [...seedAdmins, ...seedUsers]);

      const usanUser = String(row.usan_username || "").trim();
      const usanEnc = row.usan_password_encrypted != null ? String(row.usan_password_encrypted) : "";
      if (usanUser && usanEnc) {
        try {
          await runDb(
            db,
            `INSERT INTO organization_pacweb_accounts
              (organization_id, label, pacweb_username, password_encrypted, account_type, updated_at)
             VALUES (?, ?, ?, ?, 'master', CURRENT_TIMESTAMP)`,
            [createdOrgId, `${nameCheck.name}-Master`, usanUser, usanEnc]
          );
          syncUsan = true;
        } catch (e) {
          console.warn("[verify-email] failed to save USAN master account", e);
        }
      }
    }
  }

  // Join domain org + all allowlisted orgs
  const memberships: Array<{ orgId: number; role: string }> = [];
  const freshDomainOrg = !publicDomain ? await findOrgByEmailDomain(db, domain) : domainOrg;
  if (freshDomainOrg) {
    const allowOnDomain = allow.find((a) => Number(a.organization_id) === Number(freshDomainOrg.id));
    memberships.push({
      orgId: Number(freshDomainOrg.id),
      role: allowOnDomain && String(allowOnDomain.role) === "admin" ? "admin" : "operator",
    });
  }
  for (const a of allow) {
    const oid = Number(a.organization_id);
    if (!memberships.some((m) => m.orgId === oid)) {
      memberships.push({
        orgId: oid,
        role: String(a.role) === "admin" ? "admin" : "operator",
      });
    } else {
      const m = memberships.find((x) => x.orgId === oid)!;
      if (String(a.role) === "admin") m.role = "admin";
    }
  }
  if (createdOrgId && !memberships.some((m) => m.orgId === createdOrgId)) {
    memberships.push({ orgId: createdOrgId, role: "admin" });
  }

  if (!memberships.length && !createdOrgId) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          `No organization to join. If you use a company email, ask your admin to claim your domain, or contact ${supportEmail(c.env)}.`,
      },
    };
  }

  if (defaultOrgId == null) {
    defaultOrgId = freshDomainOrg
      ? Number(freshDomainOrg.id)
      : memberships[0]
        ? memberships[0].orgId
        : createdOrgId;
  }

  const userInsert = await runDb(
    db,
    `INSERT INTO users (username, email, password_hash, role, default_organization_id)
     VALUES (?, ?, ?, 'operator', ?)`,
    [username, email, String(row.password_hash), defaultOrgId]
  );
  let userId = Number((userInsert as { lastID?: number })?.lastID || 0);
  if (!userId) {
    const u = (await getRow(db, `SELECT id FROM users WHERE LOWER(TRIM(email)) = ?`, [email])) as {
      id: number;
    } | null;
    userId = u?.id != null ? Number(u.id) : 0;
  }
  if (!userId) {
    return { ok: false, status: 500, body: { error: "Failed to create user." } };
  }

  for (const m of memberships) {
    await addMembership(db, userId, m.orgId, m.role);
    await consumeAllowlist(db, m.orgId, email);
  }
  if (createdOrgId) {
    await addMembership(db, userId, createdOrgId, "admin");
  }

  await runDb(db, `UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    row.token_id,
  ]);
  await runDb(db, `DELETE FROM pending_signups WHERE id = ?`, [row.pending_signup_id]);
  await runDb(db, `DELETE FROM signup_rejected_emails WHERE email = ?`, [email]);

  if (syncUsan && createdOrgId) {
    const orgId = createdOrgId;
    const fakeReq = {
      user: {
        id: userId,
        role: "operator",
        organizationId: orgId,
        adminOrganizationIds: [orgId],
      },
      body: { organizationId: orgId, fullSync: true, daysBackOverride: 45 },
    };
    const p = runPacwebPollCore(fakeReq, {}).catch((e: unknown) => {
      console.warn("[verify-email] initial 45-day USAN sync failed", e);
    });
    if (c.executionCtx && typeof c.executionCtx.waitUntil === "function") {
      c.executionCtx.waitUntil(p);
    }
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      message: "Email verified. You can sign in.",
      organizationId: defaultOrgId,
      usanSyncStarted: syncUsan,
    },
  };
}

export const signupRoutes = r;
