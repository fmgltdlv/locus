import { getDatabase } from "../database.js";
import { getAdminOrgIds } from "../auth.js";
import { getRow } from "../lib/db.cjs";
import { clearUserAuthLimits, readUserAuthLimits } from "../lib/loginRateLimit.js";
import type { AuthUser } from "../types.js";

type TargetUser = { id: number; email: string | null; username: string | null };

function isAdminScope(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  return user.role === "dev" || (Array.isArray(user.adminOrganizationIds) && user.adminOrganizationIds.length > 0);
}

async function targetInAdminOrgs(actor: AuthUser, targetUserId: number, db: unknown): Promise<boolean> {
  const adminOrgIds = getAdminOrgIds(actor);
  if (!adminOrgIds.length) return false;
  const row = await getRow(
    db,
    `SELECT 1 AS ok FROM user_organizations WHERE user_id = ? AND organization_id IN (${adminOrgIds.map(() => "?").join(",")})`,
    [targetUserId, ...adminOrgIds]
  );
  return !!row;
}

/**
 * Dev, or an org admin for a user in an org they already admin.
 * Same membership check as GET /api/users/:id/login-history.
 */
async function authorizeAuthLimits(
  actor: AuthUser | null | undefined,
  targetUserId: number,
  db: unknown
): Promise<boolean> {
  if (!isAdminScope(actor) || !actor) return false;
  if (actor.role === "dev") return true;
  return targetInAdminOrgs(actor, targetUserId, db);
}

async function loadTargetUser(db: unknown, userId: number): Promise<TargetUser | null> {
  return (await getRow(
    db,
    "SELECT id, email, username FROM users WHERE id = ?",
    [userId]
  )) as TargetUser | null;
}

export function registerUserAuthLimitRoutes(users: any) {
  users.get("/:id/auth-limits", async (c) => {
    const actor = c.get("user") as AuthUser | undefined;
    const userId = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(userId)) return c.json({ error: "Invalid user id" }, 400);
    const db = getDatabase();
    if (!(await authorizeAuthLimits(actor, userId, db))) {
      return c.json({ error: "Access denied" }, 403);
    }
    const target = await loadTargetUser(db, userId);
    if (!target) return c.json({ error: "User not found" }, 404);
    const limits = await readUserAuthLimits(db, target.email || "", target.username || "");
    return c.json(limits);
  });

  users.post("/:id/auth-limits/clear", async (c) => {
    const actor = c.get("user") as AuthUser | undefined;
    const userId = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(userId)) return c.json({ error: "Invalid user id" }, 400);
    const db = getDatabase();
    if (!(await authorizeAuthLimits(actor, userId, db))) {
      return c.json({ error: "Access denied" }, 403);
    }
    const target = await loadTargetUser(db, userId);
    if (!target) return c.json({ error: "User not found" }, 404);
    await clearUserAuthLimits(db, target.email || "", target.username || "");
    console.info("[auth-rate-limit] cleared", {
      adminUserId: actor?.id ?? null,
      targetUserId: userId,
    });
    const limits = await readUserAuthLimits(db, target.email || "", target.username || "");
    return c.json(limits);
  });
}
