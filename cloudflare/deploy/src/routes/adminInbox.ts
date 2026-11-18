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
import { allRows, getRow, runDb } from "../lib/db.cjs";
import { deleteAppKv, orgUsanListSearchFingerprintMapKey } from "../lib/appKv.js";
import { invalidateOrgActiveTicketListCache } from "../lib/ticketListCache.js";
import {
  getSyncSettings,
  putSyncSettings,
  postFullListSync,
  am as usanListSyncAm,
} from "./pacSyncAdmin.js";
import {
  getAppSettings,
  putAppSettings,
  am as appSettingsAm,
} from "./appSettingsAdmin.js";

const feedNote = require("../lib/feedServiceRequestNote.cjs") as {
  ADMIN_INBOX_SR_STATUSES: string[];
};

const adminInbox = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
adminInbox.use("*", jsonBodyMiddleware);
adminInbox.use("*", authMiddleware);
adminInbox.use("*", expressReqResMiddleware);

/**
 * nGen / USAN list sync (registered here so they live under the same Hono as other /api/admin routes).
 * Full URLs: /api/admin/usan-sync-settings, etc. (via app.route("/api/admin", adminInbox) in index).
 */
adminInbox.get("/usan-sync-settings", usanListSyncAm, getSyncSettings);
adminInbox.get("/pac-sync-settings", usanListSyncAm, getSyncSettings);
adminInbox.put("/usan-sync-settings", usanListSyncAm, putSyncSettings);
adminInbox.put("/pac-sync-settings", usanListSyncAm, putSyncSettings);
adminInbox.post("/usan-full-sync", usanListSyncAm, postFullListSync);
adminInbox.post("/pac-full-sync", usanListSyncAm, postFullListSync);

adminInbox.get("/app-settings", appSettingsAm, getAppSettings);
adminInbox.put("/app-settings", appSettingsAm, putAppSettings);

adminInbox.get('/inbox-counts', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const user = req.user;
    const isDev = user.role === 'dev';
    const isGlobalAdmin = user.role === 'admin';
    const hasOrgAdmin =
        (user.adminOrganizationIds && user.adminOrganizationIds.length > 0) || isGlobalAdmin;

    if (!isDev && !hasOrgAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const db = getDatabase();
    let serviceRequestsNew = 0;
    let usanImportQueue = 0;
    let errorIncidents = 0;

    try {
        if (isDev) {
            const srStatuses = feedNote.ADMIN_INBOX_SR_STATUSES;
            const srPh = srStatuses.map(() => '?').join(',');
            const sr = await getRow(
                db,
                `SELECT COUNT(*) AS c FROM service_requests WHERE status IN (${srPh})`,
                srStatuses
            );
            serviceRequestsNew = sr && sr.c != null ? Number(sr.c) : 0;
            const q = await getRow(db, `SELECT COUNT(*) AS c FROM pac_unassigned_import_queue`, []);
            usanImportQueue = q && q.c != null ? Number(q.c) : 0;
            const e = await getRow(
                db,
                `SELECT COUNT(*) AS c FROM application_error_incidents WHERE acknowledged_at IS NULL`,
                []
            );
            errorIncidents = e && e.c != null ? Number(e.c) : 0;
        } else {
            const adminOrgIds = getAdminOrgIds(user);
            if (adminOrgIds.length === 0) {
                return res.json({ total: 0, serviceRequestsNew: 0, usanImportQueue: 0, pacImportQueue: 0, errorIncidents: 0 });
            }
            // Keep SR tab available; SR badge count is dev-only (same as inbox total).
            serviceRequestsNew = 0;
            usanImportQueue = 0;
        }
    } catch (e) {
        if (/no such table/i.test(e.message || '')) {
            return res.json({
                total: 0,
                serviceRequestsNew: 0,
                usanImportQueue: 0,
                pacImportQueue: 0,
                errorIncidents: 0,
            });
        }
        console.error('GET /admin/inbox-counts:', e);
        return res.status(500).json({ error: 'Failed to load counts' });
    }

    const total = usanImportQueue + errorIncidents + serviceRequestsNew;
    // pacImportQueue mirrors usanImportQueue (legacy key for older frontends)
    res.json({ total, serviceRequestsNew, usanImportQueue, pacImportQueue: usanImportQueue, errorIncidents });
});

function requireDev(req, res) {
    if (!req.user || req.user.role !== 'dev') {
        res.status(403).json({ error: 'Developer role required' });
        return false;
    }
    return true;
}

function parseIncidentMeta(raw) {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

const BULK_ERROR_IDS_MAX = 250;

function parseBulkErrorIncidentIds(body) {
    const raw = body && Array.isArray(body.ids) ? body.ids : [];
    const out = [];
    for (const x of raw) {
        const n = parseInt(String(x), 10);
        if (Number.isFinite(n) && n > 0) out.push(n);
        if (out.length >= BULK_ERROR_IDS_MAX) break;
    }
    return [...new Set(out)];
}

adminInbox.get('/errors', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (!requireDev(req, res)) return;
    const db = getDatabase();
    const status = String(req.query.status || 'open').toLowerCase();
    const limitRaw = parseInt(String(req.query.limit || '100'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(250, Math.max(1, limitRaw)) : 100;
    const includeAck = status === 'all' || status === 'acknowledged';
    const where = status === 'acknowledged' ? 'WHERE acknowledged_at IS NOT NULL' : includeAck ? '' : 'WHERE acknowledged_at IS NULL';
    try {
        const rows = await allRows(
            db,
            `SELECT id, error_code, customer_message, internal_message, detail, status, route,
                    request_method, request_path, user_id, organization_id, meta_json,
                    acknowledged_at, acknowledged_by_user_id, created_at
             FROM application_error_incidents
             ${where}
             ORDER BY created_at DESC
             LIMIT ?`,
            [limit]
        );
        res.json(rows.map((row) => ({
            id: row.id,
            errorCode: row.error_code,
            customerMessage: row.customer_message,
            internalMessage: row.internal_message,
            detail: row.detail,
            status: row.status,
            route: row.route,
            requestMethod: row.request_method,
            requestPath: row.request_path,
            userId: row.user_id,
            organizationId: row.organization_id,
            meta: parseIncidentMeta(row.meta_json),
            acknowledgedAt: row.acknowledged_at,
            acknowledgedByUserId: row.acknowledged_by_user_id,
            createdAt: row.created_at,
        })));
    } catch (e) {
        if (/no such table/i.test(e.message || '')) {
            return res.json([]);
        }
        console.error('GET /admin/errors:', e);
        res.status(500).json({ error: 'Failed to load errors' });
    }
});

adminInbox.post('/errors/bulk-acknowledge', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (!requireDev(req, res)) return;
    const ids = parseBulkErrorIncidentIds(req.body);
    if (ids.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty ids array' });
    }
    const db = getDatabase();
    const ph = ids.map(() => '?').join(',');
    try {
        const result = await runDb(
            db,
            `UPDATE application_error_incidents
             SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = ?
             WHERE id IN (${ph})`,
            [req.user.id, ...ids]
        );
        res.json({ ok: true, changed: result.changes || 0 });
    } catch (e) {
        console.error('POST /admin/errors/bulk-acknowledge:', e);
        res.status(500).json({ error: 'Failed to acknowledge errors' });
    }
});

adminInbox.post('/errors/bulk-delete', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (!requireDev(req, res)) return;
    const ids = parseBulkErrorIncidentIds(req.body);
    if (ids.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty ids array' });
    }
    const db = getDatabase();
    const ph = ids.map(() => '?').join(',');
    try {
        const result = await runDb(db, `DELETE FROM application_error_incidents WHERE id IN (${ph})`, ids);
        res.json({ ok: true, deleted: result.changes || 0 });
    } catch (e) {
        console.error('POST /admin/errors/bulk-delete:', e);
        res.status(500).json({ error: 'Failed to delete errors' });
    }
});

adminInbox.patch('/errors/:id/acknowledge', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (!requireDev(req, res)) return;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid error id' });
    try {
        const result = await runDb(
            getDatabase(),
            `UPDATE application_error_incidents
             SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = ?
             WHERE id = ?`,
            [req.user.id, id]
        );
        res.json({ ok: true, changed: result.changes || 0 });
    } catch (e) {
        console.error('PATCH /admin/errors/:id/acknowledge:', e);
        res.status(500).json({ error: 'Failed to acknowledge error' });
    }
});

adminInbox.delete('/errors/:id', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (!requireDev(req, res)) return;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid error id' });
    try {
        const result = await runDb(getDatabase(), `DELETE FROM application_error_incidents WHERE id = ?`, [id]);
        res.json({ ok: true, deleted: result.changes || 0 });
    } catch (e) {
        console.error('DELETE /admin/errors/:id:', e);
        res.status(500).json({ error: 'Failed to delete error' });
    }
});

/**
 * Dev only: delete tickets and related rows (same tables as scripts/wipeAllTickets.js).
 * Body: optional { organizationId } — when set, only that org; otherwise all orgs.
 */
adminInbox.post('/dev/nuke-tickets', async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    if (req.user.role !== 'dev') {
        return res.status(403).json({ error: 'Developer role required' });
    }

    let scopeOrgId = null;
    const raw = req.body && req.body.organizationId;
    if (raw !== undefined && raw !== null && raw !== '') {
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) {
            return res.status(400).json({ error: 'Invalid organizationId' });
        }
        scopeOrgId = n;
    }

    const db = getDatabase();
    const ph = scopeOrgId != null ? ' WHERE organization_id = ?' : '';
    const params = scopeOrgId != null ? [scopeOrgId] : [];

    try {
        // D1 does not support PRAGMA foreign_keys / BEGIN IMMEDIATE / COMMIT as separate statements
        // (see appKv.cjs). Delete in FK-safe order; same tables as backend/scripts/wipeAllTickets.js.
        await runDb(db, `DELETE FROM ticket_view_events${ph}`, params);
        await runDb(db, `DELETE FROM ticket_workflow_acks${ph}`, params);
        await runDb(db, `DELETE FROM ticket_pacweb_enrichment${ph}`, params);

        const geoSql =
            scopeOrgId != null
                ? `DELETE FROM geospatial_data WHERE data_type = 'ticket' AND organization_id = ?`
                : `DELETE FROM geospatial_data WHERE data_type = 'ticket'`;
        await runDb(db, geoSql, params);

        const delTickets = await runDb(db, `DELETE FROM tickets${ph}`, params);

        const orgIdsToClear =
            scopeOrgId != null
                ? [scopeOrgId]
                : (await allRows(db, `SELECT id FROM organizations`)).map((row) => Number(row.id)).filter(Number.isFinite);
        for (const oid of orgIdsToClear) {
            void invalidateOrgActiveTicketListCache(db, oid);
            try {
                await deleteAppKv(db, orgUsanListSearchFingerprintMapKey(oid));
            } catch (kvErr) {
                console.warn('[nuke-tickets] clear list fingerprint map:', oid, (kvErr as Error)?.message || kvErr);
            }
        }

        res.json({
            deletedTickets: delTickets.changes,
            scope: scopeOrgId != null ? 'organization' : 'all',
            organizationId: scopeOrgId,
        });
    } catch (e) {
        if (/no such table/i.test(e.message || '')) {
            return res.status(500).json({ error: 'Database schema missing ticket tables' });
        }
        console.error('POST /admin/dev/nuke-tickets:', e);
        return res.status(500).json({ error: 'Failed to delete tickets' });
    }
});

export { adminInbox };
