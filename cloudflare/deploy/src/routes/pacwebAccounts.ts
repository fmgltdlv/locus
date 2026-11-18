import { Hono } from "hono";
import { getDatabase } from "../database.js";
import {
  authMiddleware,
  authorizeMiddleware,
  hashPassword,
  getAdminOrgIds,
  canAccessOrganization,
  requireOrganizationMiddleware,
  ORG_REQUIRED_MESSAGE,
  EMAIL_PASSWORD_REQUIRED_MESSAGE,
} from "../auth.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim } from "../expressCompat.js";
import type { Env } from "../types.js";
import { pacwebEstablishSession } from "../lib/pacwebClient.cjs";
import { getNgenCredentialsForPoll } from "../lib/pacPollNgenCredentials.cjs";
import { decryptPassword, encryptPassword } from "../lib/pacwebCredentialsCrypto.cjs";
import { createAppError, sendAppError } from "../lib/appErrors.cjs";
import { isPublicCatalogOrgId } from "../lib/publicShareQuery.cjs";

const PUBLIC_CATALOG_CREDENTIALS_ERROR =
  "Cannot configure USAN credentials on the public catalog organization.";

const pacwebAccounts = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
pacwebAccounts.use("*", jsonBodyMiddleware);
pacwebAccounts.use("*", authMiddleware);
pacwebAccounts.use("*", expressReqResMiddleware);

/** @returns JSON body for 403 or null if caller may proceed */
function orgAdminForbidden(req, orgId) {
    if (!canAccessOrganization(req.user, orgId)) return { error: "Access denied" };
    if (req.user.role === "dev") return null;
    if ((req.user.adminOrganizationIds || []).includes(orgId)) return null;
    return { error: "Organization admin required" };
}

function requireOrgAdmin(req, res, orgId) {
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) {
        res.status(403).json(forbid);
        return false;
    }
    return true;
}

function d1RowId(v) {
    if (v == null) return undefined;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** USAN provider usernames are global: at most one org per username. */
async function findPacwebUsernameConflict(db: D1Database, pacUser: string, excludeAccountId?: number) {
    const row =
        excludeAccountId == null
            ? await db
                  .prepare(
                      `SELECT id, organization_id FROM organization_pacweb_accounts WHERE pacweb_username = ? LIMIT 1`
                  )
                  .bind(pacUser)
                  .first<{ id: number; organization_id: number }>()
            : await db
                  .prepare(
                      `SELECT id, organization_id FROM organization_pacweb_accounts WHERE pacweb_username = ? AND id != ? LIMIT 1`
                  )
                  .bind(pacUser, excludeAccountId)
                  .first<{ id: number; organization_id: number }>();
    return row || null;
}

let ensurePacwebAccountsSchemaPromise: Promise<void> | null = null;
async function ensurePacwebAccountsSchema(db: D1Database): Promise<void> {
    if (!ensurePacwebAccountsSchemaPromise) {
        ensurePacwebAccountsSchemaPromise = (async () => {
            try {
                await db.prepare(
                    "ALTER TABLE organization_pacweb_accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'sub'"
                ).run();
                console.info("[pacwebAccounts] added missing account_type column");
            } catch (err) {
                const msg = String((err && (err as { message?: unknown }).message) || err || "");
                if (!/duplicate column|already exists/i.test(msg)) {
                    console.warn("[pacwebAccounts] ensure schema:", err);
                }
            }
        })();
    }
    await ensurePacwebAccountsSchemaPromise;
}

pacwebAccounts.get('/', async (c) => { const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    if (!Number.isFinite(orgId)) return c.json({ error: 'Invalid organization' }, 400);
    if (!canAccessOrganization(req.user, orgId)) return c.json({ error: 'Access denied' }, 403);
    if (req.user.role !== 'dev' && !(req.user.adminOrganizationIds || []).includes(orgId)) {
        return c.json({ error: 'Organization admin required' }, 403);
    }
    try {
        await ensurePacwebAccountsSchema(c.env.DB);
        const out = await c.env.DB.prepare(
            `SELECT id, organization_id, label, pacweb_username, pacweb_username AS provider_username, account_type,
                    CASE WHEN password_encrypted IS NOT NULL AND LENGTH(TRIM(COALESCE(password_encrypted,''))) > 0 THEN 1 ELSE 0 END AS has_nGen_password,
                    created_at, updated_at
             FROM organization_pacweb_accounts WHERE organization_id = ? ORDER BY id`
        )
            .bind(orgId)
            .all();
        return c.json((out && out.results) || []);
    } catch (err) {
        console.error('[pacwebAccounts] list:', err);
        return c.json({ error: 'Failed to list accounts' }, 500);
    }
});

pacwebAccounts.post("/", async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    if (!Number.isFinite(orgId)) return c.json({ error: "Invalid organization" }, 400);
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) return c.json(forbid, 403);
    if (await isPublicCatalogOrgId(getDatabase(), orgId)) {
        return c.json({ error: PUBLIC_CATALOG_CREDENTIALS_ERROR }, 400);
    }

    const { pacweb_username, provider_username, ngen_username, label, account_type, password, ngen_password } = req.body || {};
    const userRaw = provider_username != null ? provider_username : pacweb_username != null ? pacweb_username : ngen_username;
    const pacUser =
        userRaw != null && String(userRaw).trim() !== "" ? String(userRaw).trim().toLowerCase() : null;
    if (!pacUser) {
        return c.json({ error: "provider_username is required (organization username for matching)" }, 400);
    }
    const isMaster = String(account_type || "").trim().toLowerCase() === "master";
    const pwRaw = password != null && String(password).trim() !== "" ? password : ngen_password;
    const passEnc =
        isMaster && pwRaw != null && String(pwRaw).trim() !== ""
            ? await encryptPassword(String(pwRaw).trim())
            : null;
    try {
        await ensurePacwebAccountsSchema(c.env.DB);
        const conflict = await findPacwebUsernameConflict(c.env.DB, pacUser);
        if (conflict && conflict.organization_id !== orgId) {
            return c.json(
                {
                    error: "This USAN username is already in use. Each provider username can only belong to one organization.",
                },
                409
            );
        }
        if (conflict && conflict.organization_id === orgId) {
            return c.json(
                { error: "A provider account with this username already exists for this organization." },
                409
            );
        }
        if (isMaster) {
            await c.env.DB.prepare(
                `UPDATE organization_pacweb_accounts SET account_type = 'sub', password_encrypted = NULL, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`
            )
                .bind(orgId)
                .run();
        }
        const result = await c.env.DB.prepare(
            `INSERT INTO organization_pacweb_accounts (organization_id, label, pacweb_username, password_encrypted, account_type, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
            .bind(
                orgId,
                label ?? null,
                pacUser,
                isMaster ? passEnc : null,
                isMaster ? "master" : "sub"
            )
            .run();
        const id = d1RowId(result.meta?.last_row_id);
        return c.json({ id: id ?? null, message: "Created" }, 201);
    } catch (err) {
        console.error("[pacwebAccounts] insert:", err);
        const msg = String((err && (err as { message?: unknown }).message) || err || "");
        if (/FOREIGN KEY|foreign key constraint/i.test(msg)) {
            return c.json(
                {
                    error:
                        "This organization ID is not valid in the database (foreign key). Confirm the org exists or re-select it.",
                },
                400
            );
        }
        if (/UNIQUE|unique constraint/i.test(msg)) {
            return c.json(
                {
                    error:
                        "This USAN username is already in use. Each provider username can only belong to one organization.",
                },
                409
            );
        }
        if (/no such column:\s*account_type/i.test(msg)) {
            return c.json(
                {
                    error:
                        "Database schema is missing account_type on organization_pacweb_accounts. Apply migration 0007_org_pacweb_account_type.sql (or redeploy so schema self-heal runs).",
                },
                500
            );
        }
        return c.json({ error: "Failed to create account" }, 500);
    }
});

pacwebAccounts.put("/:accountId", async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isFinite(orgId) || !Number.isFinite(accountId)) {
        return c.json({ error: "Invalid id" }, 400);
    }
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) return c.json(forbid, 403);
    if (await isPublicCatalogOrgId(getDatabase(), orgId)) {
        return c.json({ error: PUBLIC_CATALOG_CREDENTIALS_ERROR }, 400);
    }

    const { pacweb_username, provider_username, ngen_username, label, account_type, password, ngen_password } = req.body || {};

    const sets = [];
    const vals = [];
    if (label !== undefined) {
        sets.push("label = ?");
        vals.push(label);
    }
    const userField = provider_username !== undefined ? provider_username : pacweb_username !== undefined ? pacweb_username : ngen_username;
    if (userField !== undefined) {
        sets.push("pacweb_username = ?");
        vals.push(
            userField != null && String(userField).trim() !== "" ? String(userField).trim().toLowerCase() : null
        );
    }
    let isMaster = false;
    if (account_type !== undefined) {
        isMaster = String(account_type).trim().toLowerCase() === "master";
        sets.push("account_type = ?");
        vals.push(isMaster ? "master" : "sub");
    }
    const pwIn = password !== undefined ? password : ngen_password;
    if (pwIn !== undefined) {
        const t = String(pwIn).trim();
        if (t) {
            sets.push("password_encrypted = ?");
            vals.push(await encryptPassword(t));
        } else {
            sets.push("password_encrypted = NULL");
        }
    } else if (account_type !== undefined && !isMaster) {
        sets.push("password_encrypted = NULL");
    }
    if (account_type !== undefined && isMaster) {
        await c.env.DB.prepare(
            `UPDATE organization_pacweb_accounts SET account_type = 'sub', password_encrypted = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE organization_id = ? AND id != ?`
        )
            .bind(orgId, accountId)
            .run();
    }
    if (sets.length === 0) {
        return c.json({ error: "No fields to update" }, 400);
    }
    sets.push("updated_at = CURRENT_TIMESTAMP");
    vals.push(accountId, orgId);

    try {
        await ensurePacwebAccountsSchema(c.env.DB);
        if (userField !== undefined) {
            const nextUser =
                userField != null && String(userField).trim() !== ""
                    ? String(userField).trim().toLowerCase()
                    : null;
            if (nextUser != null) {
                const row = await findPacwebUsernameConflict(c.env.DB, nextUser, accountId);
                if (row) {
                    if (row.organization_id !== orgId) {
                        return c.json(
                            {
                                error: "This USAN username is already in use. Each provider username can only belong to one organization.",
                            },
                            409
                        );
                    }
                    return c.json(
                        {
                            error: "Another account in this organization already uses this USAN username.",
                        },
                        409
                    );
                }
            }
        }
        const result = await c.env.DB.prepare(
            `UPDATE organization_pacweb_accounts SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`
        )
            .bind(...vals)
            .run();
        if ((result.meta?.changes ?? 0) === 0) return c.json({ error: "Not found" }, 404);
        return c.json({ message: "Updated" });
    } catch (err) {
        console.error("[pacwebAccounts] update:", err);
        const msg = String((err && (err as { message?: unknown }).message) || err || "");
        if (/UNIQUE|unique constraint/i.test(msg)) {
            return c.json(
                {
                    error:
                        "This USAN username is already in use. Each provider username can only belong to one organization.",
                },
                409
            );
        }
        return c.json({ error: "Failed to update" }, 500);
    }
});

/**
 * One-off migration helper: decrypt then re-encrypt the stored password for a single org account row.
 * - Requires org admin (or dev).
 * - Never returns plaintext password.
 * - Useful to validate `NGEN_CREDENTIALS_KEY` is configured correctly before running a bulk migration.
 */
pacwebAccounts.post("/:accountId/reencrypt-password", async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isFinite(orgId) || !Number.isFinite(accountId)) {
        return c.json({ error: "Invalid id" }, 400);
    }
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) return c.json(forbid, 403);

    const confirmRaw = String((req.query && req.query.confirm) || (req.body && req.body.confirm) || "").trim();
    const confirmed = confirmRaw === "1" || confirmRaw.toLowerCase() === "true" || confirmRaw.toLowerCase() === "yes";
    if (!confirmed) {
        return c.json(
            {
                error: "Confirmation required",
                hint: "Re-run with ?confirm=1 (or JSON body {\"confirm\":true}) to perform the re-encrypt.",
            },
            400
        );
    }

    try {
        await ensurePacwebAccountsSchema(c.env.DB);
        const row = await c.env.DB.prepare(
            `SELECT id, organization_id, account_type, pacweb_username, password_encrypted
             FROM organization_pacweb_accounts
             WHERE organization_id = ? AND id = ?
             LIMIT 1`
        )
            .bind(orgId, accountId)
            .first();
        if (!row) {
            return c.json({ error: "Account not found" }, 404);
        }
        const stored = row.password_encrypted != null ? String(row.password_encrypted) : "";
        if (!String(stored).trim()) {
            return c.json({ ok: true, updated: false, message: "No stored password on this account row." }, 200);
        }

        const plaintext = await decryptPassword(stored);
        if (!String(plaintext || "").trim()) {
            return c.json({ ok: false, error: "Decrypted password was empty; refusing to overwrite." }, 500);
        }

        const reenc = await encryptPassword(String(plaintext));
        if (!String(reenc).trim()) {
            return c.json({ ok: false, error: "Re-encryption failed (empty ciphertext)." }, 500);
        }

        if (reenc === stored) {
            return c.json(
                { ok: true, updated: false, message: "Ciphertext unchanged (already using current primary key)." },
                200
            );
        }

        await c.env.DB.prepare(
            `UPDATE organization_pacweb_accounts
             SET password_encrypted = ?, updated_at = CURRENT_TIMESTAMP
             WHERE organization_id = ? AND id = ?`
        )
            .bind(reenc, orgId, accountId)
            .run();

        return c.json(
            {
                ok: true,
                updated: true,
                id: row.id,
                organization_id: row.organization_id,
                account_type: row.account_type,
                pacweb_username: row.pacweb_username,
            },
            200
        );
    } catch (err) {
        console.error("[pacwebAccounts] reencrypt-password:", err);
        return c.json({ ok: false, error: "Failed to re-encrypt password" }, 500);
    }
});

pacwebAccounts.delete("/:accountId", async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isFinite(orgId) || !Number.isFinite(accountId)) {
        return c.json({ error: "Invalid id" }, 400);
    }
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) return c.json(forbid, 403);

    try {
        const result = await c.env.DB.prepare(
            `DELETE FROM organization_pacweb_accounts WHERE id = ? AND organization_id = ?`
        )
            .bind(accountId, orgId)
            .run();
        if ((result.meta?.changes ?? 0) === 0) return c.json({ error: "Not found" }, 404);
        return c.json({ message: "Deleted" });
    } catch (err) {
        console.error("[pacwebAccounts] delete:", err);
        return c.json({ error: "Failed to delete" }, 500);
    }
});

/** Manual PAC identifiers when auto lookup fails. */
pacwebAccounts.patch("/enrichment/:ticketBase", async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(req.params.orgId, 10);
    const ticketBase = req.params.ticketBase;
    if (!Number.isFinite(orgId) || !ticketBase) {
        return c.json({ error: "Invalid parameters" }, 400);
    }
    const forbid = orgAdminForbidden(req, orgId);
    if (forbid) return c.json(forbid, 403);

    const body = req.body || {};
    const jobRaw =
        body.job_number != null
            ? body.job_number
            : body.ngen_job_number != null
              ? body.ngen_job_number
              : null;
    const jobNum = jobRaw != null ? parseInt(String(jobRaw), 10) : null;

    if (jobNum == null || !Number.isFinite(jobNum)) {
        return c.json(
            {
                error: "job_number (or legacy ngen_job_number) is required",
            },
            400
        );
    }

    try {
        await c.env.DB.prepare(
            `INSERT INTO ticket_pacweb_enrichment (organization_id, ticket_number, job_number, fetched_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(organization_id, ticket_number) DO UPDATE SET
               job_number = excluded.job_number,
               fetched_at = CURRENT_TIMESTAMP`
        )
            .bind(orgId, ticketBase, jobNum)
            .run();
        return c.json({ ok: true, job_number: jobNum });
    } catch (err) {
        console.error("[pacwebAccounts] enrichment patch:", err);
        return c.json({ error: "Failed to save" }, 500);
    }
});

/** Verifies PAC web session using the same credentials as nGen poll ({@link getNgenCredentialsForPoll} for this org). */
pacwebAccounts.post('/:accountId/test-login', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const orgId = parseInt(req.params.orgId, 10);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isFinite(orgId) || !Number.isFinite(accountId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!requireOrgAdmin(req, res, orgId)) return;

    const db = getDatabase();
    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) {
        return sendAppError(res, db, createAppError('NGEN_SERVICE_ACCOUNT_MISSING', {
            internalMessage:
                'No PAC/nGen credentials for this organization (master account with password in production). In local dev, set APP_ENV=development and USAN_SERVICE_* or add a master org password.',
            meta: { orgId, accountId },
        }), {
            req,
            route: 'pacwebAccounts.testLogin.credentials',
            organizationId: orgId,
        });
    }
    try {
        await pacwebEstablishSession(globalThis.fetch, { username: svc.user, password: svc.pass });
        res.json({ ok: true, message: 'Provider login verified.' });
    } catch (e) {
        return sendAppError(res, db, createAppError('PAC_ACCOUNT_LOGIN_FAILED', {
            internalMessage: e.message || String(e),
            cause: e,
            meta: { orgId, accountId },
        }), {
            req,
            route: 'pacwebAccounts.testLogin.establishSession',
            organizationId: orgId,
        });
    }
});

export { pacwebAccounts };
