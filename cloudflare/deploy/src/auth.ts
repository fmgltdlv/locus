import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";
import { getDatabase } from "./database.js";
// @ts-ignore — CJS module; wrangler bundles it
import { allRows, getRow, runDb } from "./lib/db.cjs";
import { normalizeLoginIdentifier } from "./lib/loginRateLimit.js";
import { normalizeGlobalRole, normalizeOrgRole } from "./lib/roles.js";
import type { AuthUser, Env } from "./types.js";

const JWT_EXPIRY_DEFAULT = "7d";

/**
 * Resolve JWT access lifetime from env. Accepts jose-style compact durations only
 * (digits + s|m|h|d|w). Empty or invalid values fall back to {@link JWT_EXPIRY_DEFAULT}.
 */
export function resolveJwtExpiry(raw: string | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return JWT_EXPIRY_DEFAULT;
  const normalized = s.replace(/\s+/g, "").toLowerCase();
  if (!/^\d+[smhdw]$/.test(normalized)) return JWT_EXPIRY_DEFAULT;
  return normalized;
}

export const ORG_REQUIRED_MESSAGE = "User must be associated with an organization";
export const EMAIL_PASSWORD_REQUIRED_MESSAGE = "Email and password are required";

export const BCRYPT_PASSWORD_COST = 12;

/** Parse bcrypt cost from `$2a$10$...` / `$2b$12$...` hashes; null when not bcrypt. */
export function getBcryptCostFromHash(hash: string): number | null {
  const m = /^\$2[aby]\$(\d{2})\$/.exec(String(hash ?? ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function passwordHashNeedsRehash(hash: string): boolean {
  const cost = getBcryptCostFromHash(hash);
  return cost == null || cost < BCRYPT_PASSWORD_COST;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_PASSWORD_COST);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function addSessionVersionBumpUpdate(updates: string[], values: unknown[]) {
  updates.push("session_version = COALESCE(session_version, 0) + ?");
  values.push(1);
}

export async function bumpSessionVersion(db: { run: Function }, userId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    db.run(
      `UPDATE users
       SET session_version = COALESCE(session_version, 0) + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [userId],
      function (this: { changes?: number }, err: Error | null) {
        if (err) {
          reject(err);
          return;
        }
        if (!this || this.changes === 0) {
          reject(new Error("User not found"));
          return;
        }
        resolve();
      }
    );
  });
}

type JwtUserPayload = JWTPayload & {
  id?: number;
  username?: string;
  email?: string;
  role?: string;
  organizationId?: number;
  sessionVersion?: number;
};

export async function generateToken(
  user: {
    id: number;
    username: string;
    email: string;
    role: string;
    default_organization_id?: number | null;
    organization_id?: number | null;
    session_version?: number | null;
  },
  secret: string,
  jwtExpiry: string = JWT_EXPIRY_DEFAULT
): Promise<string> {
  const jwtSecret = String(secret || "").trim();
  if (!jwtSecret) {
    throw new Error("Server misconfiguration: JWT_SECRET");
  }
  const key = new TextEncoder().encode(jwtSecret);
  const orgId = user.default_organization_id ?? user.organization_id ?? undefined;
  return new SignJWT({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    organizationId: orgId,
    sessionVersion: Number(user.session_version ?? 0),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(jwtExpiry)
    .sign(key);
}

export async function verifyToken(token: string, secret: string): Promise<JwtUserPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return payload as JwtUserPayload;
  } catch {
    return null;
  }
}

export const ACTIVITY_LOGIN_GAP_MS = 24 * 60 * 60 * 1000;

function clientIpFromHono(c: Context): string | null {
  const raw = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
  const first = String(raw).split(",")[0].trim();
  return first || null;
}

/** Parse D1/SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO timestamps. */
export function parseSqliteUtcMs(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** True when last_login is missing or older than 24 hours. */
export function isActivityLoginDue(lastLoginRaw: unknown, nowMs: number = Date.now()): boolean {
  const t = parseSqliteUtcMs(lastLoginRaw);
  if (t == null) return true;
  return nowMs - t >= ACTIVITY_LOGIN_GAP_MS;
}

/**
 * If last_login is null or older than 24h, bump it and insert login_history.
 * At most one write per user per day; password login still always logs.
 */
export async function maybeRecordActivityLogin(
  db: { run: Function },
  userId: number,
  ip: string | null | undefined,
  lastLoginRaw?: unknown
): Promise<boolean> {
  if (!isActivityLoginDue(lastLoginRaw)) return false;
  const updated = await runDb(
    db,
    `UPDATE users SET last_login = CURRENT_TIMESTAMP
     WHERE id = ? AND (last_login IS NULL OR last_login < datetime('now', '-24 hours'))`,
    [userId]
  );
  if (!updated || !updated.changes) return false;
  await runDb(db, "INSERT INTO login_history (user_id, ip_address) VALUES (?, ?)", [
    userId,
    ip ?? null,
  ]);
  return true;
}

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next) {
  const token =
    c.req.header("Authorization")?.replace(/^Bearer\s+/, "") ||
    "";

  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const secret = String(c.env.JWT_SECRET || "").trim();
  if (!secret) {
    return c.json({ error: "Server misconfiguration: JWT_SECRET" }, 500);
  }

  const decoded = await verifyToken(token, secret);
  if (!decoded || decoded.id == null) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const db = getDatabase();
  const row = await getRow(db, "SELECT role, session_version, last_login FROM users WHERE id = ?", [decoded.id]);
  if (!row) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  let role = normalizeGlobalRole(decoded.role ?? "operator");
  if (row && row.role) role = normalizeGlobalRole(String(row.role));
  const expectedSessionVersion = Number(row.session_version ?? 0);
  const tokenSessionVersion = Number(decoded.sessionVersion ?? 0);
  if (tokenSessionVersion !== expectedSessionVersion) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  try {
    await maybeRecordActivityLogin(db, Number(decoded.id), clientIpFromHono(c), row.last_login);
  } catch (err) {
    console.error("maybeRecordActivityLogin:", err);
  }

  const base: AuthUser = {
    id: Number(decoded.id),
    username: String(decoded.username ?? ""),
    email: String(decoded.email ?? ""),
    role,
    organizationId:
      decoded.organizationId != null ? Number(decoded.organizationId) : undefined,
    adminOrganizationIds: [],
    organizationIds: [],
  };

  if (base.role === "dev") {
    c.set("user", base);
    return await next();
  }

  const uoRows = await allRows(
    db,
    "SELECT organization_id, role FROM user_organizations WHERE user_id = ?",
    [base.id]
  );
  const adminOrganizationIds = uoRows
    .filter((r: Record<string, unknown>) => r.role === "admin")
    .map((r: Record<string, unknown>) => Number(r.organization_id));
  const organizationIds = uoRows.map((r: Record<string, unknown>) => Number(r.organization_id));

  c.set("user", {
    ...base,
    adminOrganizationIds,
    organizationIds,
  });
  return await next();
}

/**
 * Org IDs the user can administer.
 * Uses per-org admin memberships only — never treat mere membership / default org as admin.
 * Legacy exception: global `users.role === "admin"` with a default org and no admin rows.
 */
export function getAdminOrgIds(user: AuthUser): number[] {
  if (user.adminOrganizationIds && user.adminOrganizationIds.length > 0) {
    return user.adminOrganizationIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
  }
  if (user.role === "admin" && user.organizationId != null) {
    const oid = Number(user.organizationId);
    return Number.isFinite(oid) ? [oid] : [];
  }
  return [];
}

/** Org admin for a specific org, or global dev. */
export function canAdminOrganization(user: AuthUser, organizationId: number): boolean {
  if (user.role === "dev") return true;
  const oid = Number(organizationId);
  if (Number.isNaN(oid)) return false;
  return getAdminOrgIds(user).includes(oid);
}

export function canAccessOrganization(user: AuthUser, organizationId: number): boolean {
  if (user.role === "dev") return true;
  const oid = Number(organizationId);
  if (Number.isNaN(oid)) return false;
  if (getAdminOrgIds(user).includes(oid)) return true;
  if (Array.isArray(user.organizationIds) && user.organizationIds.some((x) => Number(x) === oid)) {
    return true;
  }
  return false;
}

/** Mutations (write) — membership / admin / dev only; not public-catalog viewers. */
export function canMutateOrganization(user: AuthUser, organizationId: number): boolean {
  return canAccessOrganization(user, organizationId);
}

/**
 * Read org data: member/admin/dev, or public catalog (user belongs to an org with share_to_public).
 */
export async function canViewOrganization(
  user: AuthUser,
  organizationId: number
): Promise<boolean> {
  if (user.role === "dev" || canAccessOrganization(user, organizationId)) return true;
  const db = getDatabase();
  const row = (await getRow(
    db,
    "SELECT is_public_catalog FROM organizations WHERE id = ?",
    [organizationId]
  )) as { is_public_catalog?: number } | null;
  if (!row || !row.is_public_catalog) return false;
  const elig = await getRow(
    db,
    `SELECT 1 AS ok FROM user_organizations uo
     INNER JOIN organizations o ON o.id = uo.organization_id
     WHERE uo.user_id = ? AND o.share_to_public = 1
     LIMIT 1`,
    [user.id]
  );
  return !!elig;
}

export async function canUseDevTicketHub(
  user: AuthUser,
  organizationId: number
): Promise<boolean> {
  if (!user || user.role !== "dev") return false;
  const oid = Number(organizationId);
  if (Number.isNaN(oid)) return false;
  const db = getDatabase();
  const row = (await getRow(
    db,
    "SELECT is_dev_ticket_hub FROM organizations WHERE id = ?",
    [oid]
  )) as { is_dev_ticket_hub?: number } | null;
  return !!(row && Number(row.is_dev_ticket_hub) === 1);
}

export function authorize(...allowedRoles: string[]) {
  return (user: AuthUser | undefined): boolean => {
    if (!user) return false;
    if (allowedRoles.includes(user.role)) return true;
    if (allowedRoles.includes("admin") && user.adminOrganizationIds && user.adminOrganizationIds.length > 0) {
      return true;
    }
    return false;
  };
}

export function authorizeMiddleware(...allowedRoles: string[]) {
  return async (c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, next: Next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Authentication required" }, 401);
    if (authorize(...allowedRoles)(user)) {
      return await next();
    }
    return c.json({ error: "Insufficient permissions" }, 403);
  };
}

export async function requireOrganizationMiddleware(
  c: Context<{ Bindings: Env; Variables: { user: AuthUser; orgId?: number } }>,
  next: Next
) {
  const user = c.get("user");
  if (!user?.organizationId) {
    return c.json({ error: ORG_REQUIRED_MESSAGE }, 400);
  }
  c.set("orgId", user.organizationId);
  return await next();
}

export async function login(
  emailOrUsername: string,
  password: string,
  ipAddress: string | undefined,
  userAgent: string | undefined,
  secret: string,
  jwtExpiryRaw?: string
): Promise<{
  token: string;
  user: {
    id: number;
    username: string;
    email: string;
    role: string;
    organizationId: number | null;
    defaultOrganizationId: number | null;
    organizationIds: number[];
    adminOrganizationIds: number[];
    organizationMemberships: { organizationId: number; role: string }[];
    fullName: string | null;
    phone: string | null;
    preferredLanguage: string;
  };
}> {
  const identifier = normalizeLoginIdentifier(emailOrUsername);
  if (!identifier) {
    throw new Error("Invalid credentials");
  }
  const db = getDatabase();
  const user = await getRow(
    db,
    "SELECT * FROM users WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(username)) = ?",
    [identifier, identifier]
  );
  if (!user || !user.password_hash) {
    throw new Error("Invalid credentials");
  }
  if (!verifyPassword(password, String(user.password_hash))) {
    throw new Error("Invalid credentials");
  }

  if (passwordHashNeedsRehash(String(user.password_hash))) {
    await new Promise<void>((resolve, reject) => {
      db.run(
        "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [hashPassword(password), user.id],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  await new Promise<void>((resolve, reject) => {
    db.run("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [user.id], (err) =>
      err ? reject(err) : resolve()
    );
  });
  await new Promise<void>((resolve, reject) => {
    db.run(
      "INSERT INTO login_history (user_id, ip_address) VALUES (?, ?)",
      [user.id, ipAddress ?? null],
      (err) => (err ? reject(err) : resolve())
    );
  });

  const userOrgs = await allRows(
    db,
    "SELECT organization_id, role FROM user_organizations WHERE user_id = ?",
    [user.id]
  );
  const organizationIds = userOrgs.map((uo: Record<string, unknown>) => Number(uo.organization_id));
  const adminOrganizationIds = userOrgs
    .filter((uo: Record<string, unknown>) => uo.role === "admin")
    .map((uo: Record<string, unknown>) => Number(uo.organization_id));
  const organizationMemberships = userOrgs.map((uo: Record<string, unknown>) => ({
    organizationId: Number(uo.organization_id),
    role: normalizeOrgRole(uo.role != null ? String(uo.role) : "operator"),
  }));
  const defaultOrgId =
    user.default_organization_id != null
      ? Number(user.default_organization_id)
      : user.organization_id != null
        ? Number(user.organization_id)
        : organizationIds.length > 0
          ? organizationIds[0]
          : null;

  const jwtExpiry = resolveJwtExpiry(jwtExpiryRaw);
  const token = await generateToken(
    {
      id: Number(user.id),
      username: String(user.username),
      email: String(user.email),
      role: String(user.role),
      default_organization_id: user.default_organization_id != null ? Number(user.default_organization_id) : null,
      organization_id: user.organization_id != null ? Number(user.organization_id) : null,
      session_version: user.session_version != null ? Number(user.session_version) : 0,
    },
    secret,
    jwtExpiry
  );

  return {
    token,
    user: {
      id: Number(user.id),
      username: String(user.username),
      email: String(user.email),
      role: String(user.role),
      organizationId: defaultOrgId,
      defaultOrganizationId:
        user.default_organization_id != null ? Number(user.default_organization_id) : null,
      organizationIds,
      adminOrganizationIds,
      organizationMemberships,
      fullName: user.full_name != null ? String(user.full_name) : null,
      phone: user.phone != null ? String(user.phone) : null,
      preferredLanguage: user.preferred_language === "es" ? "es" : "en",
    },
  };
}
