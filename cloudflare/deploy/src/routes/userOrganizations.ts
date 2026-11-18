import { Hono } from "hono";
import { getDatabase } from "../database.js";
import {
  authMiddleware,
  authorizeMiddleware,
  hashPassword,
  bumpSessionVersion,
  getAdminOrgIds,
  canAccessOrganization,
  requireOrganizationMiddleware,
  ORG_REQUIRED_MESSAGE,
  EMAIL_PASSWORD_REQUIRED_MESSAGE,
} from "../auth.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim, respondAfterDb } from "../expressCompat.js";
import type { Env } from "../types.js";
import { isValidOrgRole, normalizeOrgRole } from "../lib/roles.js";

const userOrganizations = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
userOrganizations.use("*", jsonBodyMiddleware);
userOrganizations.use("*", authMiddleware);
userOrganizations.use("*", expressReqResMiddleware);

// Get all organizations for a user
userOrganizations.get("/user/:userId", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) {
        res.status(400).json({ error: "Invalid user id" });
        return await res.getResponse();
    }
    const isAdminScope =
        req.user.role === "dev" || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0);
    if (!isAdminScope && Number(req.user.id) !== userId) {
        res.status(403).json({ error: "Access denied" });
        return await res.getResponse();
    }
    return await respondAfterDb(res, (done) => {
        db.all(
            `
        SELECT
            o.id,
            o.name,
            o.created_at,
            CASE WHEN uo.user_id IS NOT NULL THEN 1 ELSE 0 END as is_member,
            CASE WHEN u.default_organization_id = o.id THEN 1 ELSE 0 END as is_default,
            uo.role as org_role
        FROM organizations o
        LEFT JOIN user_organizations uo ON uo.organization_id = o.id AND uo.user_id = ?
        LEFT JOIN users u ON u.id = ?
        ORDER BY is_default DESC, o.name ASC
    `,
            [userId, userId],
            (err, orgs) => {
                if (err) {
                    console.error("Error fetching user organizations:", err);
                    res.status(500).json({ error: "Failed to fetch organizations" });
                    done();
                    return;
                }
                res.json(
                    (orgs || []).map((o) => ({
                        id: o.id,
                        name: o.name,
                        created_at: o.created_at,
                        is_member: o.is_member,
                        is_default: o.is_default,
                        org_role: normalizeOrgRole(o.org_role != null ? String(o.org_role) : "operator"),
                    }))
                );
                done();
            }
        );
    });
});

// Add user to organization (dev or admin)
userOrganizations.post(
    "/user/:userId/organization/:orgId",
    authorizeMiddleware("dev", "admin"),
    async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes") as ResShim;
        const db = getDatabase();
        const userId = parseInt(req.params.userId, 10);
        const orgId = parseInt(req.params.orgId, 10);
        if (!Number.isFinite(userId) || !Number.isFinite(orgId)) {
            res.status(400).json({ error: "Invalid user or organization id" });
            return await res.getResponse();
        }
        const adminOrgIds = getAdminOrgIds(req.user);
        if (req.user.role !== "dev" && !adminOrgIds.includes(orgId)) {
            res
                .status(403)
                .json({ error: "Access denied. Admins can only add users to organizations they manage." });
            return await res.getResponse();
        }
        return await respondAfterDb(res, (done) => {
            db.get(
                "SELECT * FROM user_organizations WHERE user_id = ? AND organization_id = ?",
                [userId, orgId],
                (err, existing) => {
                    if (err) {
                        console.error("Error checking user-org relationship:", err);
                        res.status(500).json({ error: "Failed to check relationship" });
                        done();
                        return;
                    }
                    if (existing) {
                        res.status(409).json({ error: "User is already a member of this organization" });
                        done();
                        return;
                    }
                    db.get("SELECT id, email, role FROM users WHERE id = ?", [userId], (err2, user) => {
                        if (err2) {
                            console.error("Error fetching user:", err2);
                            res.status(500).json({ error: "Failed to verify user" });
                            done();
                            return;
                        }
                        if (!user) {
                            res.status(404).json({ error: "User not found" });
                            done();
                            return;
                        }
                        const preservedRole = user.email === "dev@example.com" ? "dev" : user.role;
                        db.run(
                            "INSERT INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)",
                            [userId, orgId, "operator"],
                            function (err3) {
                                if (err3) {
                                    console.error("Error adding user to organization:", err3);
                                    const msg = err3 instanceof Error ? err3.message : String(err3);
                                    if (/FOREIGN KEY|UNIQUE constraint/i.test(msg)) {
                                        res.status(400).json({
                                            error:
                                                "Cannot add membership (user or organization missing, or user is already a member).",
                                        });
                                    } else {
                                        res.status(500).json({ error: "Failed to add user to organization" });
                                    }
                                    done();
                                    return;
                                }
                                const insertId = Number(this.lastID);
                                function sendAddSuccess() {
                                    res.json({
                                        id: insertId,
                                        message: "User added to organization successfully",
                                    });
                                    done();
                                }
                                db.get("SELECT role FROM users WHERE id = ?", [userId], (roleErr, currentUser) => {
                                    if (roleErr) {
                                        console.error("Error verifying role after add:", roleErr);
                                        sendAddSuccess();
                                        return;
                                    }
                                    if (currentUser && currentUser.role !== preservedRole) {
                                        db.run(
                                            "UPDATE users SET role = ? WHERE id = ?",
                                            [preservedRole, userId],
                                            (updateErr) => {
                                                if (updateErr) {
                                                    console.error("Error preserving user role:", updateErr);
                                                } else {
                                                    console.log(
                                                        `Preserved role '${preservedRole}' for user ${userId} (was '${currentUser.role}')`
                                                    );
                                                }
                                                sendAddSuccess();
                                            }
                                        );
                                        return;
                                    }
                                    sendAddSuccess();
                                });
                            }
                        );
                    });
                }
            );
        });
    }
);

// Set per-organization role for a user (dev only; or admin can set for users in their orgs)
userOrganizations.put(
    "/user/:userId/organization/:orgId/role",
    authorizeMiddleware("dev", "admin"),
    async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes") as ResShim;
        const db = getDatabase();
        const userId = parseInt(req.params.userId, 10);
        const orgId = parseInt(req.params.orgId, 10);
        if (!Number.isFinite(userId) || !Number.isFinite(orgId)) {
            res.status(400).json({ error: "Invalid user or organization id" });
            return await res.getResponse();
        }
        const { role: rawRole } = req.body;
        if (!rawRole || !isValidOrgRole(String(rawRole))) {
            res.status(400).json({ error: 'Invalid role. Must be "operator", "manager", "admin", or "tech".' });
            return await res.getResponse();
        }
        const role = normalizeOrgRole(String(rawRole));
        if (req.user.role !== "dev") {
            const adminOrgIds = getAdminOrgIds(req.user);
            if (!adminOrgIds.includes(orgId)) {
                res.status(403).json({ error: "Access denied" });
                return await res.getResponse();
            }
        }
        return await respondAfterDb(res, (done) => {
            db.get(
                "SELECT * FROM user_organizations WHERE user_id = ? AND organization_id = ?",
                [userId, orgId],
                (err, row) => {
                    if (err) {
                        console.error("Error fetching membership:", err);
                        res.status(500).json({ error: "Failed to update role" });
                        done();
                        return;
                    }
                    if (!row) {
                        res.status(404).json({ error: "User is not a member of this organization" });
                        done();
                        return;
                    }
                    db.run(
                        "UPDATE user_organizations SET role = ? WHERE user_id = ? AND organization_id = ?",
                        [role, userId, orgId],
                        function (err2) {
                            if (err2) {
                                console.error("Error updating org role:", err2);
                                res.status(500).json({ error: "Failed to update role" });
                                done();
                                return;
                            }
                            res.json({ message: "Role updated successfully", role });
                            done();
                        }
                    );
                }
            );
        });
    }
);

// Remove user from organization (dev or admin)
userOrganizations.delete(
    "/user/:userId/organization/:orgId",
    authorizeMiddleware("dev", "admin"),
    async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes") as ResShim;
        const db = getDatabase();
        const userId = parseInt(req.params.userId, 10);
        const orgId = parseInt(req.params.orgId, 10);
        if (!Number.isFinite(userId) || !Number.isFinite(orgId)) {
            res.status(400).json({ error: "Invalid user or organization id" });
            return await res.getResponse();
        }
        const adminOrgIds = getAdminOrgIds(req.user);
        if (req.user.role !== "dev" && !adminOrgIds.includes(orgId)) {
            res.status(403).json({ error: "Access denied" });
            return await res.getResponse();
        }
        return await respondAfterDb(res, (done) => {
            const runMembershipDelete = () => {
                db.run(
                    "DELETE FROM user_organizations WHERE user_id = ? AND organization_id = ?",
                    [userId, orgId],
                    function (err) {
                        if (err) {
                            console.error("Error removing user from organization:", err);
                            res.status(500).json({ error: "Failed to remove user from organization" });
                            done();
                            return;
                        }
                        if (this.changes === 0) {
                            res.status(404).json({ error: "User is not a member of this organization" });
                            done();
                            return;
                        }
                        bumpSessionVersion(db, userId)
                            .then(() => {
                                res.json({ message: "User removed from organization successfully" });
                                done();
                            })
                            .catch((bumpErr) => {
                                console.error("Error invalidating session after org removal:", bumpErr);
                                res.json({ message: "User removed from organization successfully" });
                                done();
                            });
                    }
                );
            };
            db.get("SELECT default_organization_id FROM users WHERE id = ?", [userId], (err, user) => {
                if (err) {
                    console.error("Error fetching user:", err);
                    res.status(500).json({ error: "Failed to fetch user" });
                    done();
                    return;
                }
                const defaultOid =
                    user != null && user.default_organization_id != null
                        ? Number(user.default_organization_id)
                        : null;
                if (user && defaultOid === orgId) {
                    db.get(
                        "SELECT organization_id FROM user_organizations WHERE user_id = ? AND organization_id != ? LIMIT 1",
                        [userId, orgId],
                        (err2, otherOrg) => {
                            if (err2) {
                                console.error("Error finding alternative org:", err2);
                                res.status(500).json({ error: "Failed to prepare organization removal" });
                                done();
                                return;
                            }
                            const newDefault = otherOrg != null ? Number(otherOrg.organization_id) : null;
                            db.run(
                                "UPDATE users SET default_organization_id = ? WHERE id = ?",
                                [newDefault, userId],
                                (err3) => {
                                    if (err3) {
                                        console.error("Error updating default org:", err3);
                                        res.status(500).json({ error: "Failed to update default organization" });
                                        done();
                                        return;
                                    }
                                    runMembershipDelete();
                                }
                            );
                        }
                    );
                    return;
                }
                runMembershipDelete();
            });
        });
    }
);

// Set user's default organization (user can set their own, dev/admin can set for others)
userOrganizations.put(
    "/user/:userId/default-organization/:orgId",
    async (c) => {
        const req = buildExpressReq(c);
        const res = c.get("expressRes") as ResShim;
        const db = getDatabase();
        const userId = parseInt(req.params.userId, 10);
        const orgId = parseInt(req.params.orgId, 10);
        if (!Number.isFinite(userId) || !Number.isFinite(orgId)) {
            res.status(400).json({ error: "Invalid user or organization id" });
            return await res.getResponse();
        }
        const canSetOther = req.user.role === "dev" || getAdminOrgIds(req.user).length > 0;
        if (!canSetOther && Number(req.user.id) !== userId) {
            res.status(403).json({ error: "Access denied" });
            return await res.getResponse();
        }
        return await respondAfterDb(res, (done) => {
            db.get("SELECT id, email, role FROM users WHERE id = ?", [userId], (err, user) => {
                if (err) {
                    console.error("Error fetching user:", err);
                    res.status(500).json({ error: "Failed to verify user" });
                    done();
                    return;
                }
                if (!user) {
                    res.status(404).json({ error: "User not found" });
                    done();
                    return;
                }
                const userRole = user.email === "dev@example.com" ? "dev" : user.role;
                db.get(
                    "SELECT * FROM user_organizations WHERE user_id = ? AND organization_id = ?",
                    [userId, orgId],
                    (err2, membership) => {
                        if (err2) {
                            console.error("Error checking membership:", err2);
                            res.status(500).json({ error: "Failed to check membership" });
                            done();
                            return;
                        }
                        if (!membership) {
                            res.status(400).json({ error: "User is not a member of this organization" });
                            done();
                            return;
                        }
                        const finalRole = user.email === "dev@example.com" ? "dev" : userRole;
                        db.run(
                            "UPDATE users SET default_organization_id = ?, role = ? WHERE id = ?",
                            [orgId, finalRole, userId],
                            function (err3) {
                                if (err3) {
                                    console.error("Error updating default organization:", err3);
                                    res.status(500).json({ error: "Failed to update default organization" });
                                    done();
                                    return;
                                }
                                res.json({ message: "Default organization updated successfully" });
                                done();
                            }
                        );
                    }
                );
            });
        });
    }
);

export { userOrganizations };

