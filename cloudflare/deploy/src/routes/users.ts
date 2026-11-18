import { Hono } from "hono";
import { getDatabase } from "../database.js";
import {
  addSessionVersionBumpUpdate,
  authMiddleware,
  authorizeMiddleware,
  generateToken,
  hashPassword,
  getAdminOrgIds,
  canAccessOrganization,
  canViewOrganization,
  requireOrganizationMiddleware,
  resolveJwtExpiry,
  ORG_REQUIRED_MESSAGE,
  EMAIL_PASSWORD_REQUIRED_MESSAGE,
} from "../auth.js";
import { getWorkerKv } from "../envContext.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim, respondAfterDb } from "../expressCompat.js";
import type { Env } from "../types.js";
import { getRow, runDb } from "../lib/db.cjs";
import { isValidGlobalRole, normalizeGlobalRole } from "../lib/roles.js";
import { validatePasswordPolicy } from "../lib/passwordPolicy.js";
import { registerUserAuthLimitRoutes } from "./userAuthLimitsRoutes.js";

const users = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
users.use("*", jsonBodyMiddleware);
users.use("*", authMiddleware);
users.use("*", expressReqResMiddleware);

const MAX_UI_PREFERENCES_BYTES = 2 * 1024 * 1024;
const MAX_TICKET_HUB_STATE_BYTES = 256 * 1024;

const uiPrefKvKey = (userId) => `uipref:v1:u/${userId}`;
const ticketHubKvKey = (userId, orgId) => `tickethub:v1:u/${userId}/o/${orgId}`;

function normalizePreferredLanguage(value) {
    return value === "es" ? "es" : "en";
}

/** @returns {string|null} 10-digit US mobile, or null when empty. */
function normalizeUserPhone(value) {
    if (value == null) return null;
    const digits = String(value).replace(/\D/g, "");
    if (!digits) return null;
    if (!/^\d{10}$/.test(digits)) return null;
    return digits;
}

function phoneValidationError(value) {
    if (value == null || String(value).trim() === "") return null;
    const digits = String(value).replace(/\D/g, "");
    if (!digits) return null;
    if (!/^\d{10}$/.test(digits)) {
        return "Phone number must be exactly 10 digits";
    }
    return null;
}

/**
 * GET/PUT /api/users/me/ui-preferences — must be registered before /:id routes.
 * Body: { preferences: { userProfile?: object, ticketPopupDimensions?: object } }
 * Storage: Workers KV when APP_KV is bound; else D1 `user_ui_preferences`.
 */
users.get("/me/ui-preferences", async (c) => {
    const u = c.get("user");
    const id = u && u.id;
    if (id == null) return c.json({ error: "Authentication required" }, 401);
    const kv = getWorkerKv();
    if (kv) {
        const raw = await kv.get(uiPrefKvKey(id), "text");
        if (raw) {
            try {
                return c.json({ preferences: JSON.parse(raw), updatedAt: null, storage: "kv" });
            } catch {
                return c.json({ preferences: {}, updatedAt: null, storage: "kv" });
            }
        }
        const db = getDatabase();
        const row = await getRow(
            db,
            "SELECT preferences_json, updated_at FROM user_ui_preferences WHERE user_id = ?",
            [id]
        );
        if (row && row.preferences_json) {
            const migrated = String(row.preferences_json);
            await kv.put(uiPrefKvKey(id), migrated);
            let prefs;
            try {
                prefs = JSON.parse(migrated);
            } catch {
                prefs = {};
            }
            return c.json({ preferences: prefs, updatedAt: row.updated_at || null, storage: "kv" });
        }
        return c.json({ preferences: null, updatedAt: null, storage: "kv" });
    }
    const db = getDatabase();
    const row = (await getRow(
        db,
        "SELECT preferences_json, updated_at FROM user_ui_preferences WHERE user_id = ?",
        [id]
    )) as { preferences_json?: string; updated_at?: string | null } | undefined;
    if (!row) {
        return c.json({ preferences: null, updatedAt: null, storage: "d1" });
    }
    let prefs: unknown = null;
    try {
        prefs = JSON.parse(String(row.preferences_json || "{}"));
    } catch {
        prefs = {};
    }
    return c.json({ preferences: prefs, updatedAt: row.updated_at || null, storage: "d1" });
});

users.put("/me/ui-preferences", async (c) => {
    const u = c.get("user");
    const id = u && u.id;
    if (id == null) return c.json({ error: "Authentication required" }, 401);
    const req = buildExpressReq(c);
    const body = req.body || {};
    const prefs = body.preferences != null ? body.preferences : body;
    if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
        return c.json({ error: "preferences must be a JSON object" }, 400);
    }
    let jsonStr;
    try {
        jsonStr = JSON.stringify(prefs);
    } catch (e) {
        return c.json({ error: "Invalid preferences payload" }, 400);
    }
    if (new TextEncoder().encode(jsonStr).length > MAX_UI_PREFERENCES_BYTES) {
        return c.json({ error: "Preferences too large" }, 413);
    }
    const kv = getWorkerKv();
    if (kv) {
        await kv.put(uiPrefKvKey(id), jsonStr);
        return c.json({ ok: true, storage: "kv" });
    }
    const db = getDatabase();
    try {
        await runDb(
            db,
            `INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`,
            [id, jsonStr]
        );
        return c.json({ ok: true, storage: "d1" });
    } catch (e) {
        console.error("Error saving ui preferences:", e);
        return c.json({ error: "Failed to save preferences" }, 500);
    }
});

/**
 * Per-user+org ticket hub "recent" query/filter state in KV.
 */
users.get("/me/ticket-hub-state", async (c) => {
    const u = c.get("user");
    if (!u) return c.json({ error: "Authentication required" }, 401);
    const q = c.req.query("organizationId");
    const orgId = q != null && q !== "" ? parseInt(String(q), 10) : NaN;
    if (!Number.isFinite(orgId)) {
        return c.json({ error: "organizationId is required" }, 400);
    }
    if (!(await canViewOrganization(u, orgId))) {
        return c.json({ error: "You do not have access to that organization" }, 403);
    }
    const kv = getWorkerKv();
    if (!kv) {
        return c.json({ state: null, error: "KV not configured" }, 503);
    }
    const raw = await kv.get(ticketHubKvKey(u.id, orgId), "text");
    if (!raw) return c.json({ state: null });
    try {
        return c.json({ state: JSON.parse(raw) });
    } catch {
        return c.json({ state: null });
    }
});

users.put("/me/ticket-hub-state", async (c) => {
    const u = c.get("user");
    if (!u) return c.json({ error: "Authentication required" }, 401);
    const req = buildExpressReq(c);
    const orgId = req.body && req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : NaN;
    if (!Number.isFinite(orgId)) {
        return c.json({ error: "organizationId is required" }, 400);
    }
    if (!canAccessOrganization(u, orgId)) {
        return c.json(
            { error: "You must be a member to persist hub state for this organization" },
            403
        );
    }
    const st = req.body && req.body.state;
    if (st !== undefined && st !== null && typeof st !== "object") {
        return c.json({ error: "state must be a JSON object or null" }, 400);
    }
    const kv = getWorkerKv();
    if (!kv) {
        return c.json({ error: "KV not configured" }, 503);
    }
    if (st == null) {
        await kv.delete(ticketHubKvKey(u.id, orgId));
        return c.json({ ok: true });
    }
    let jsonStr;
    try {
        jsonStr = JSON.stringify(st);
    } catch (e) {
        return c.json({ error: "Invalid state" }, 400);
    }
    if (new TextEncoder().encode(jsonStr).length > MAX_TICKET_HUB_STATE_BYTES) {
        return c.json({ error: "State too large" }, 413);
    }
    await kv.put(ticketHubKvKey(u.id, orgId), jsonStr);
    return c.json({ ok: true });
});

// Get users. Dev: all (optional org filter). Admin: their orgs. Org members with ?organizationId=:
// members of that org (needed for project assignee pickers). Otherwise: self only.
users.get('/', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes");
    const db = getDatabase();
    const filterOrgId = req.query.organizationId ? parseInt(String(req.query.organizationId), 10) : null;

    const orgRoleSelect = (filterOrgId != null && !isNaN(filterOrgId)) ? ', MAX(uo.role) as organization_role' : '';
    let query = `
        SELECT 
            u.id,
            u.username,
            u.email,
            u.role,
            u.default_organization_id,
            u.full_name,
            u.phone,
            u.preferred_language,
            u.last_login,
            u.created_at,
            o.name as default_organization_name,
            GROUP_CONCAT(DISTINCT o2.name) as organization_names,
            GROUP_CONCAT(DISTINCT uo.organization_id) as organization_ids${orgRoleSelect}
        FROM users u
        LEFT JOIN organizations o ON o.id = u.default_organization_id
        LEFT JOIN user_organizations uo ON uo.user_id = u.id
        LEFT JOIN organizations o2 ON o2.id = uo.organization_id
    `;
    const params = [];

    if (req.user.role === 'dev') {
        if (filterOrgId != null && !isNaN(filterOrgId)) {
            query += ' WHERE uo.organization_id = ? GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), \'\'), NULLIF(TRIM(u.username), \'\'), NULLIF(TRIM(u.email), \'\'))) ASC, u.id ASC';
            params.push(filterOrgId);
        } else {
            query += ' GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), \'\'), NULLIF(TRIM(u.username), \'\'), NULLIF(TRIM(u.email), \'\'))) ASC, u.id ASC';
        }
    } else if (req.user.role === 'admin' || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0)) {
        const adminOrgIds = getAdminOrgIds(req.user);
        if (adminOrgIds.length === 0) {
            return res.json([]);
        }
        if (filterOrgId != null && !isNaN(filterOrgId) && adminOrgIds.includes(filterOrgId)) {
            query += ' WHERE uo.organization_id = ? GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), \'\'), NULLIF(TRIM(u.username), \'\'), NULLIF(TRIM(u.email), \'\'))) ASC, u.id ASC';
            params.push(filterOrgId);
        } else if (filterOrgId != null && !isNaN(filterOrgId) && canAccessOrganization(req.user, filterOrgId)) {
            // Org admin of other orgs who is only a member of filterOrgId (or user membership)
            query += ' WHERE uo.organization_id = ? GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), \'\'), NULLIF(TRIM(u.username), \'\'), NULLIF(TRIM(u.email), \'\'))) ASC, u.id ASC';
            params.push(filterOrgId);
        } else {
            const placeholders = adminOrgIds.map(() => '?').join(',');
            query += ` WHERE uo.organization_id IN (${placeholders}) GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.email), ''))) ASC, u.id ASC`;
            params.push(...adminOrgIds);
        }
    } else if (filterOrgId != null && !isNaN(filterOrgId) && canAccessOrganization(req.user, filterOrgId)) {
        // Org role user/tech: roster for project assignee UI when scoped to their org
        query += ' WHERE uo.organization_id = ? GROUP BY u.id ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), \'\'), NULLIF(TRIM(u.username), \'\'), NULLIF(TRIM(u.email), \'\'))) ASC, u.id ASC';
        params.push(filterOrgId);
    } else {
        query += ' WHERE u.id = ? GROUP BY u.id';
        params.push(req.user.id);
    }

    db.all(query, params, (err, users) => {
        if (err) {
            console.error('Error fetching users:', err);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        const adminOrgIds = getAdminOrgIds(req.user);
        const wantsFullDirectory =
            req.user.role === 'dev' ||
            (filterOrgId != null && !isNaN(filterOrgId) && adminOrgIds.includes(filterOrgId)) ||
            (filterOrgId == null && adminOrgIds.length > 0);

        const safeUsers = users.map((u: Record<string, unknown>) => {
            if (!wantsFullDirectory && Number(u.id) !== Number(req.user.id)) {
                return {
                    id: u.id,
                    username: u.username,
                    full_name: u.full_name,
                };
            }
            const { password_hash, ...safeUser } = u;
            safeUser.organizationIds = u.organization_ids ? String(u.organization_ids).split(',').map((id) => parseInt(id, 10)) : [];
            safeUser.organizationNames = u.organization_names ? String(u.organization_names).split(',') : [];
            if (u.organization_role != null) safeUser.organizationRole = u.organization_role;
            return safeUser;
        });

        res.json(safeUsers);
    });
});

// Get single user
users.get('/:id', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }

    // Users can only view themselves unless they're dev or admin-scope
    const isAdminScope = req.user.role === 'dev' || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0);
    if (!isAdminScope && Number(req.user.id) !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    db.get(`
        SELECT 
            u.id,
            u.username,
            u.email,
            u.role,
            u.default_organization_id,
            u.full_name,
            u.phone,
            u.preferred_language,
            u.last_login,
            u.created_at,
            o.name as default_organization_name,
            GROUP_CONCAT(DISTINCT o2.name) as organization_names,
            GROUP_CONCAT(DISTINCT uo.organization_id) as organization_ids
        FROM users u
        LEFT JOIN organizations o ON o.id = u.default_organization_id
        LEFT JOIN user_organizations uo ON uo.user_id = u.id
        LEFT JOIN organizations o2 ON o2.id = uo.organization_id
        WHERE u.id = ?
        GROUP BY u.id
    `, [userId], (err, user) => {
        if (err) {
            console.error('Error fetching user:', err);
            return res.status(500).json({ error: 'Failed to fetch user' });
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Admin can only see users in their org(s) - user must be in at least one of admin's orgs
        if (isAdminScope && req.user.role !== 'dev') {
            const userOrgIds = user.organization_ids ? String(user.organization_ids).split(',').map((id) => parseInt(id, 10)) : [];
            const adminOrgIds = getAdminOrgIds(req.user);
            const hasAccess = userOrgIds.some(oid => adminOrgIds.includes(oid));
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }

        const allIds = user.organization_ids ? String(user.organization_ids).split(',').map((id) => parseInt(id, 10)) : [];
        const allNames = user.organization_names ? String(user.organization_names).split(',') : [];
        let organizationIds = allIds;
        let organizationNames = allNames;
        if (isAdminScope && req.user.role !== 'dev' && Number(req.user.id) !== userId) {
            const adminOrgIds = getAdminOrgIds(req.user);
            if (allNames.length === allIds.length) {
                organizationNames = allIds
                    .map((oid, i) => (adminOrgIds.includes(oid) ? allNames[i] : null))
                    .filter((n) => n != null);
            } else {
                organizationNames = [];
            }
            organizationIds = allIds.filter((oid) => adminOrgIds.includes(oid));
        }

        const formattedUser: Record<string, unknown> = {
            ...user,
            organizationIds,
            organizationNames,
        };
        delete formattedUser.organization_ids;
        delete formattedUser.organization_names;

        res.json(formattedUser);
    });
});

// Create user (dev or admin)
users.post("/", authorizeMiddleware("dev", "admin"), async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const { username, email, password, role, organizationId, fullName, phone, preferredLanguage } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: EMAIL_PASSWORD_REQUIRED_MESSAGE });
        return await res.getResponse();
    }
    if (phone !== undefined) {
        const phoneErr = phoneValidationError(phone);
        if (phoneErr) {
            res.status(400).json({ error: phoneErr });
            return await res.getResponse();
        }
    }
    const createPolicy = validatePasswordPolicy(password);
    if (createPolicy.ok === false) {
        res.status(400).json({ error: createPolicy.error });
        return await res.getResponse();
    }
    const autoUsername = username || email.split("@")[0];
    const validRoles = req.user.role === "dev" ? ["operator", "admin", "dev", "user"] : ["operator", "admin", "user"];
    if (role && !validRoles.includes(role)) {
        res.status(400).json({ error: "Invalid role" });
        return await res.getResponse();
    }
    let targetOrgId;
    if (req.user.role === "dev") {
        targetOrgId = organizationId ? parseInt(organizationId, 10) : null;
    } else {
        const adminOrgIds = getAdminOrgIds(req.user);
        const requestedOrg = organizationId ? parseInt(organizationId, 10) : null;
        targetOrgId = requestedOrg && adminOrgIds.includes(requestedOrg) ? requestedOrg : adminOrgIds[0] || null;
    }
    const targetRole = normalizeGlobalRole(role || "operator");
    if (targetRole === "admin" && req.user.role !== "dev") {
        res.status(403).json({ error: "Only dev can create admin users" });
        return await res.getResponse();
    }
    if (targetRole === "dev" && req.user.role !== "dev") {
        res.status(403).json({ error: "Only dev can create dev users" });
        return await res.getResponse();
    }
    const passwordHash = hashPassword(password);
    return await respondAfterDb(res, (done) => {
        const sendCreated = (userId) => {
            res.status(201).json({
                id: userId,
                username: autoUsername,
                email,
                role: targetRole,
                defaultOrganizationId: targetOrgId,
                fullName: fullName || null,
                phone: normalizeUserPhone(phone),
                preferredLanguage: normalizePreferredLanguage(preferredLanguage),
                message: "User created successfully",
            });
            done();
        };
        db.run(
            "INSERT INTO users (username, email, password_hash, role, default_organization_id, full_name, phone, preferred_language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [autoUsername, email, passwordHash, targetRole, targetOrgId, fullName || null, normalizeUserPhone(phone), normalizePreferredLanguage(preferredLanguage)],
            function (err) {
                if (err) {
                    if (err.message.includes("UNIQUE constraint")) {
                        const field = err.message.includes("username") ? "username" : "email";
                        res.status(409).json({ error: `${field} already exists` });
                    } else {
                        console.error("Error creating user:", err);
                        res.status(500).json({ error: "Failed to create user" });
                    }
                    done();
                    return;
                }
                const userId = Number(this.lastID);
                if (targetOrgId) {
                    const orgRole = targetRole === "admin" ? "admin" : "operator";
                    db.run(
                        "INSERT OR IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)",
                        [userId, targetOrgId, orgRole],
                        (memErr) => {
                            if (memErr) {
                                console.error("Error adding user to organization:", memErr);
                                db.run("DELETE FROM users WHERE id = ?", [userId], (delErr) => {
                                    if (delErr) console.error("Error rolling back user after membership failure:", delErr);
                                    res.status(500).json({ error: "Failed to add user to organization" });
                                    done();
                                });
                                return;
                            }
                            sendCreated(userId);
                        }
                    );
                    return;
                }
                sendCreated(userId);
            }
        );
    });
});

// Update user (dev, admin, or self)
users.put('/:id', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    const { email, password, role, organizationId, fullName, phone, username, preferredLanguage } = req.body;

    if (phone !== undefined) {
        const phoneErr = phoneValidationError(phone);
        if (phoneErr) {
            return res.status(400).json({ error: phoneErr });
        }
    }

    if (password) {
        const updatePolicy = validatePasswordPolicy(password);
        if (updatePolicy.ok === false) {
            return res.status(400).json({ error: updatePolicy.error });
        }
    }

    // Users can only update themselves unless they're dev or admin-scope
    const isAdminScope = req.user.role === 'dev' || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0);
    if (!isAdminScope && Number(req.user.id) !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Admin can only update users in their org(s)
    if (isAdminScope && req.user.role !== 'dev') {
        const adminOrgIds = getAdminOrgIds(req.user);
        db.get('SELECT 1 FROM user_organizations WHERE user_id = ? AND organization_id IN (' + adminOrgIds.map(() => '?').join(',') + ')', [userId, ...adminOrgIds], (err, row) => {
            if (err) {
                console.error('Error checking user organizations:', err);
                return res.status(500).json({ error: 'Failed to verify access' });
            }
            if (!row) {
                return res.status(403).json({ error: 'Access denied' });
            }
            fetchUserAndUpdate();
        });
        return;
    }

    fetchUserAndUpdate();

    function fetchUserAndUpdate() {
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, currentUser) => {
        if (err) {
            console.error('Error fetching user:', err);
            return res.status(500).json({ error: 'Failed to fetch user' });
        }

        if (!currentUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Helper function to perform the update
        function performUpdate(updates, values) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(userId);

            if (updates.length === 1) { // Only updated_at
                return res.status(400).json({ error: 'No valid fields to update' });
            }

            // Safeguard: If role is being updated and the user is dev@example.com, ensure it stays 'dev'
            const roleUpdateIndex = updates.findIndex(u => u.startsWith('role ='));
            if (roleUpdateIndex >= 0 && currentUser.email === 'dev@example.com') {
                // Force dev@example.com to always be 'dev'
                values[roleUpdateIndex] = 'dev';
                console.log('Protected dev@example.com role from being changed to dev');
            }

            db.run(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                values,
                function(err) {
                    if (err) {
                        if (err.message.includes('UNIQUE constraint')) {
                            const field = err.message.includes('username') ? 'username' : 'email';
                            return res.status(409).json({ error: field === 'username' ? 'Username already exists' : 'Email already exists' });
                        }
                        console.error('Error updating user:', err);
                        return res.status(500).json({ error: 'Failed to update user' });
                    }

                    if (this.changes === 0) {
                        return res.status(404).json({ error: 'User not found' });
                    }

                    function finishOk() {
                        const isSelfPasswordChange = password && Number(req.user.id) === userId;
                        if (!isSelfPasswordChange) {
                            res.json({ message: 'User updated successfully' });
                            return;
                        }
                        db.get(
                            'SELECT id, username, email, role, default_organization_id, organization_id, session_version FROM users WHERE id = ?',
                            [userId],
                            async (fetchErr, updatedUser) => {
                                if (fetchErr || !updatedUser) {
                                    console.error('Error fetching user after password change:', fetchErr);
                                    res.json({ message: 'User updated successfully' });
                                    return;
                                }
                                try {
                                    const secret = String(c.env.JWT_SECRET || '').trim();
                                    if (!secret) {
                                        res.json({ message: 'User updated successfully' });
                                        return;
                                    }
                                    const token = await generateToken(
                                        updatedUser as {
                                            id: number;
                                            username: string;
                                            email: string;
                                            role: string;
                                            default_organization_id?: number;
                                            organization_id?: number;
                                            session_version?: number;
                                        },
                                        secret,
                                        resolveJwtExpiry(c.env.JWT_EXPIRY)
                                    );
                                    res.json({ message: 'User updated successfully', token });
                                } catch (tokenErr) {
                                    console.error('Error issuing token after password change:', tokenErr);
                                    res.json({ message: 'User updated successfully' });
                                }
                            }
                        );
                    }

                    if (currentUser.email === 'dev@example.com') {
                        db.run(
                            'UPDATE users SET role = ? WHERE id = ? AND email = ?',
                            ['dev', userId, 'dev@example.com'],
                            (safeguardErr) => {
                                if (safeguardErr) {
                                    console.error('Error applying dev@example.com safeguard:', safeguardErr);
                                }
                                finishOk();
                            }
                        );
                    } else {
                        finishOk();
                    }
                }
            );
        }

        const updates = [];
        const values = [];

        // Username: only update if provided and changed (dev/admin only can change)
        const usernameTrimmed = typeof username === 'string' ? username.trim() : '';
        const usernameChanged = usernameTrimmed && usernameTrimmed !== String(currentUser.username || '').trim();
        if (usernameChanged) {
            if (req.user.role !== 'dev' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Only administrators can change usernames' });
            }
            if (usernameTrimmed.length === 0) {
                return res.status(400).json({ error: 'Username cannot be empty' });
            }
            db.get('SELECT id FROM users WHERE username = ? AND id != ?', [usernameTrimmed, userId], (err, existing) => {
                if (err) {
                    console.error('Error checking username uniqueness:', err);
                    return res.status(500).json({ error: 'Failed to validate username' });
                }
                if (existing) {
                    return res.status(409).json({ error: 'Username already exists' });
                }
                updates.push('username = ?');
                values.push(usernameTrimmed);
                continueWithUpdate();
            });
        } else {
            continueWithUpdate();
        }

        function continueWithUpdate() {

        // Only validate and update email if it's actually changing (same email must not trigger "already exists")
        const emailChanged = email && (String(email).trim().toLowerCase() !== String(currentUser.email || '').trim().toLowerCase());

        if (emailChanged) {
            // Only admins and devs can change email addresses
            if (req.user.role !== 'dev' && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Only administrators can change email addresses' });
            }
            
            // Check if email already exists for a different user
            db.get('SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) AND id != ?', [email, userId], (err, existingUser) => {
                if (err) {
                    console.error('Error checking email uniqueness:', err);
                    return res.status(500).json({ error: 'Failed to validate email' });
                }
                
                if (existingUser) {
                    return res.status(409).json({ error: 'Email already exists' });
                }
                
                // Email is available, proceed with update
                updates.push('email = ?');
                values.push(String(email).trim());
                
                // Continue with other updates
                if (password) {
                    updates.push('password_hash = ?');
                    values.push(hashPassword(password));
                    addSessionVersionBumpUpdate(updates, values);
                    updates.push('password_changed_at = ?');
                    values.push(new Date().toISOString());
                }

                if (fullName !== undefined) {
                    updates.push('full_name = ?');
                    values.push(fullName || null);
                }

                if (phone !== undefined) {
                    updates.push('phone = ?');
                    values.push(normalizeUserPhone(phone));
                }

                if (preferredLanguage !== undefined) {
                    updates.push('preferred_language = ?');
                    values.push(normalizePreferredLanguage(preferredLanguage));
                }

                // Role and organization changes
                if (role !== undefined) {
                    // Only dev can change roles
                    if (req.user.role !== 'dev') {
                        return res.status(403).json({ error: 'Only dev can change user roles' });
                    }
                    updates.push('role = ?');
                    values.push(role);
                }

                if (organizationId !== undefined) {
                    // Only dev can change default organization directly
                    if (req.user.role !== 'dev') {
                        return res.status(403).json({ error: 'Only dev can change default organization directly. Use user-organizations endpoint to manage memberships.' });
                    }
                    updates.push('default_organization_id = ?');
                    values.push(organizationId || null);
                }

                performUpdate(updates, values);
            });
        } else {
            // No email update, proceed directly
            if (password) {
                updates.push('password_hash = ?');
                values.push(hashPassword(password));
                addSessionVersionBumpUpdate(updates, values);
                updates.push('password_changed_at = ?');
                values.push(new Date().toISOString());
            }

            if (fullName !== undefined) {
                updates.push('full_name = ?');
                values.push(fullName || null);
            }

            if (phone !== undefined) {
                updates.push('phone = ?');
                values.push(normalizeUserPhone(phone));
            }

            if (preferredLanguage !== undefined) {
                updates.push('preferred_language = ?');
                values.push(normalizePreferredLanguage(preferredLanguage));
            }

            // Role and organization changes
            if (role !== undefined) {
                // Only dev can change roles
                if (req.user.role !== 'dev') {
                    return res.status(403).json({ error: 'Only dev can change user roles' });
                }
                updates.push('role = ?');
                values.push(role);
            }

            if (organizationId !== undefined) {
                // Only dev can change default organization directly
                if (req.user.role !== 'dev') {
                    return res.status(403).json({ error: 'Only dev can change default organization directly. Use user-organizations endpoint to manage memberships.' });
                }
                updates.push('default_organization_id = ?');
                values.push(organizationId || null);
            }

            performUpdate(updates, values);
        }
        }

    });
    }
});

// Delete user (dev or admin)
users.delete("/:id", authorizeMiddleware("dev", "admin"), async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
        res.status(400).json({ error: "Invalid user id" });
        return await res.getResponse();
    }
    const isAdminScope =
        req.user.role === "dev" || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0);

    async function purgeUserKvForDelete(uid) {
        const kv = getWorkerKv();
        if (!kv) return;
        try {
            await kv.delete(uiPrefKvKey(uid));
            const prefix = `tickethub:v1:u/${uid}/`;
            let cursor;
            do {
                const l = await kv.list({ prefix, cursor, limit: 100 });
                for (const k of l.keys) {
                    await kv.delete(k.name);
                }
                cursor = l.list_complete ? undefined : (l as { cursor?: string }).cursor;
            } while (cursor);
        } catch (e) {
            console.warn("purgeUserKvForDelete", e);
        }
    }

    return await respondAfterDb(res, (done) => {
        const runDelete = () => {
            void (async () => {
                try {
                    await purgeUserKvForDelete(userId);
                } catch (e) {
                    console.warn("purgeUserKvForDelete", e);
                }
                db.run("DELETE FROM users WHERE id = ?", [userId], function (err) {
                    if (err) {
                        console.error("Error deleting user:", err);
                        res.status(500).json({ error: "Failed to delete user" });
                        done();
                        return;
                    }
                    if (this.changes === 0) {
                        res.status(404).json({ error: "User not found" });
                        done();
                        return;
                    }
                    res.json({ message: "User deleted successfully" });
                    done();
                });
            })();
        };
        if (isAdminScope && req.user.role !== "dev") {
            const adminOrgIds = getAdminOrgIds(req.user);
            db.get(
                "SELECT 1 FROM user_organizations WHERE user_id = ? AND organization_id IN (" +
                    adminOrgIds.map(() => "?").join(",") +
                    ")",
                [userId, ...adminOrgIds],
                (err, row) => {
                    if (err) {
                        console.error("Error checking user organizations:", err);
                        res.status(500).json({ error: "Failed to verify access" });
                        done();
                        return;
                    }
                    if (!row) {
                        res.status(403).json({ error: "Access denied" });
                        done();
                        return;
                    }
                    runDelete();
                }
            );
        } else {
            runDelete();
        }
    });
});

// Get user login history (dev or admin)
users.get('/:id/login-history', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }

    const isAdminScope = req.user.role === 'dev' || (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0);
    if (!isAdminScope && Number(req.user.id) !== userId) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (isAdminScope && req.user.role !== 'dev') {
        const adminOrgIds = getAdminOrgIds(req.user);
        db.get('SELECT 1 FROM user_organizations WHERE user_id = ? AND organization_id IN (' + adminOrgIds.map(() => '?').join(',') + ')', [userId, ...adminOrgIds], (err, row) => {
            if (err) {
                console.error('Error checking user organizations:', err);
                return res.status(500).json({ error: 'Failed to verify access' });
            }
            if (!row) {
                return res.status(403).json({ error: 'Access denied' });
            }
            fetchLoginHistory();
        });
    } else {
        fetchLoginHistory();
    }

    function fetchLoginHistory() {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        db.all(`
            SELECT 
                login_time,
                ip_address,
                user_agent
            FROM login_history
            WHERE user_id = ?
            ORDER BY login_time DESC
            LIMIT ? OFFSET ?
        `, [userId, limit, offset], (err, history) => {
            if (err) {
                console.error('Error fetching login history:', err);
                return res.status(500).json({ error: 'Failed to fetch login history' });
            }

            res.json(history);
        });
    }
});

registerUserAuthLimitRoutes(users);

export { users };

