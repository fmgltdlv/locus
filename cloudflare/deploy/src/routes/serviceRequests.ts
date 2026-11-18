import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { getAppKv } from "../lib/appKv.js";
import { HIDE_SITE_DOCUMENTATION_KEY } from "./appSettingsAdmin.js";
import {
  authMiddleware,
  canAccessOrganization,
  getAdminOrgIds,
  requireOrganizationMiddleware,
} from "../auth.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim } from "../expressCompat.js";
import type { Env } from "../types.js";

const feedNote = require("../lib/feedServiceRequestNote.cjs") as {
  FEED_SERVICE_TYPES: Set<string>;
  parseFeedServiceRequestNote: (note: unknown) => {
    source: string;
    serviceRequested?: string;
    ticketOrganizationId: number | null;
    ticketNumber: string;
    ticketRevision?: string;
    userNote?: string;
  } | null;
  buildFeedServiceRequestNote: (meta: Record<string, unknown>) => string;
  getFeedPinFromNote: (note: unknown) => { lat: number; lng: number } | null;
  validateManualFeedServiceRequest: (
    serviceType: string,
    note: unknown
  ) =>
    | { ok: true; meta: Record<string, unknown>; noteJson: string }
    | { ok: false; error: string };
};

const feedScan = require("../lib/feedScan.cjs") as {
  loadOwnerTicketLean: (
    db: ReturnType<typeof getDatabase>,
    organizationId: number,
    ticketNumber: string
  ) => Promise<Record<string, unknown> | null>;
  leanRowToTicketShape: (row: Record<string, unknown> | null) => Record<string, unknown> | null;
  markerFromLeanTicket: (ticket: Record<string, unknown> | null) => {
    polygon: unknown;
    pin: { lat: number; lng: number } | null;
  };
};

const serviceRequests = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
serviceRequests.use("*", jsonBodyMiddleware);
serviceRequests.use("*", authMiddleware);
serviceRequests.use("*", expressReqResMiddleware);

const FEED_LINKED_TYPES = ["site_documentation", "private_locating"];
const ADMIN_STATUSES = ["new", "read", "resolved", "incomplete", "complete", "acknowledged"];
const BULK_SERVICE_REQUEST_IDS_MAX = 500;

function parseBulkServiceRequestIds(body: { ids?: unknown }) {
    const raw = body && Array.isArray(body.ids) ? body.ids : [];
    const out: number[] = [];
    for (const x of raw) {
        const n = parseInt(String(x), 10);
        if (Number.isFinite(n) && n > 0) out.push(n);
        if (out.length >= BULK_SERVICE_REQUEST_IDS_MAX) break;
    }
    return [...new Set(out)];
}

function adminServiceRequestOrgScope(user: Parameters<typeof getAdminOrgIds>[0], queryPrefix = "") {
    if (user.role === "admin" || (user.adminOrganizationIds && user.adminOrganizationIds.length > 0)) {
        const adminOrgIds = getAdminOrgIds(user);
        if (adminOrgIds.length > 0) {
            return {
                clause: ` AND ${queryPrefix}organization_id IN (${adminOrgIds.map(() => "?").join(",")})`,
                params: adminOrgIds,
            };
        }
    }
    return { clause: "", params: [] as number[] };
}

function parseOptionalOrgId(value: unknown): number | null {
    const n = parseInt(String(value), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Prefer explicit body/ticket org over JWT default (login default org). */
function resolveServiceRequestOrgId(
    user: Parameters<typeof getAdminOrgIds>[0],
    body: { organizationId?: unknown },
    ticketOrgFromNote: number | null
): number | null {
    const candidates: number[] = [];
    const bodyOrg = parseOptionalOrgId(body?.organizationId);
    if (bodyOrg != null) candidates.push(bodyOrg);
    if (ticketOrgFromNote != null) candidates.push(ticketOrgFromNote);
    const userOrg = parseOptionalOrgId(user.organizationId);
    if (userOrg != null) candidates.push(userOrg);

    for (const oid of candidates) {
        if (canAccessOrganization(user, oid)) return oid;
    }
    return null;
}

// Submit service request
serviceRequests.post('/', requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    try {
        const hidden = (await getAppKv(getDatabase(), HIDE_SITE_DOCUMENTATION_KEY)) === "1";
        if (hidden) {
            return c.json({ error: "Site documentation requests are turned off." }, 403);
        }
    } catch (e) {
        console.warn("[service-requests] hide check:", e);
    }
    const { serviceType, note } = req.body || {};
    const userId = req.user.id;

    if (!serviceType || !['site_documentation', 'private_locating', 'technical_support', 'multi'].includes(serviceType)) {
        return c.json({ error: 'Valid service type is required (site_documentation, private_locating, technical_support, or multi)' }, 400);
    }

    const userName = req.user.fullName || req.user.email || 'Unknown';
    const userEmail = req.user.email || '';

    let noteToStore: string | null = note != null ? String(note) : null;
    let status = 'new';
    let ticketOrgFromNote: number | null = null;
    let feedValidated: { ok: true; meta: Record<string, unknown> } | null = null;

    if (FEED_LINKED_TYPES.includes(String(serviceType))) {
        const validated = feedNote.validateManualFeedServiceRequest(String(serviceType), note);
        if (validated.ok === false) {
            return c.json({ error: validated.error }, 400);
        }
        feedValidated = validated;
        ticketOrgFromNote = parseOptionalOrgId(validated.meta.ticketOrganizationId);
        if (!validated.meta.ticketNumber || String(validated.meta.ticketNumber).trim() === '') {
            return c.json({ error: 'Ticket number is required (open a ticket before requesting services)' }, 400);
        }
    }

    const orgId = resolveServiceRequestOrgId(req.user, req.body || {}, ticketOrgFromNote);
    if (orgId == null) {
        return c.json({ error: 'Valid organization is required' }, 400);
    }

    if (feedValidated) {
        const meta: Record<string, unknown> = {
            ...feedValidated.meta,
            source: 'manual',
            serviceRequested: String(serviceType),
            ticketOrganizationId: orgId,
            ticketNumber: feedValidated.meta.ticketNumber,
        };
        const db = getDatabase();
        try {
            const lean = await feedScan.loadOwnerTicketLean(db, orgId, String(meta.ticketNumber));
            const ticket = feedScan.leanRowToTicketShape(lean);
            const geom = feedScan.markerFromLeanTicket(ticket);
            if (geom.pin) {
                meta.pin = geom.pin;
            }
        } catch (pinErr) {
            console.warn('Could not resolve ticket pin for service request:', pinErr);
        }
        noteToStore = feedNote.buildFeedServiceRequestNote(meta);
        status = 'incomplete';
    }

    try {
        const row = await c.env.DB.prepare(`
            INSERT INTO service_requests 
            (organization_id, user_id, user_name, user_email, service_type, note, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `)
            .bind(orgId, userId, userName, userEmail, serviceType, noteToStore, status)
            .first();

        return c.json({
            id: row && row.id != null ? Number(row.id) : null,
            message: 'Service request submitted successfully',
            status,
        });
    } catch (err) {
        console.error('Error saving service request:', err);
        return c.json({ error: 'Failed to save service request' }, 500);
    }
});

// Get service requests (for admins/devs; optional ?organizationId= to filter)
serviceRequests.get('/', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const filterOrgId = req.query.organizationId ? parseInt(req.query.organizationId, 10) : null;

    // Only dev and admin can view service requests
    if (user.role !== 'dev' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Only admins and devs can view service requests.' });
    }

    let query = `
        SELECT sr.*, o.name as organization_name
        FROM service_requests sr
        LEFT JOIN organizations o ON sr.organization_id = o.id
    `;
    const params = [];

    // Admins can only see their org(s) requests; devs see all; optional filter by org
    if (user.role === 'admin' || (user.adminOrganizationIds && user.adminOrganizationIds.length > 0)) {
        const adminOrgIds = getAdminOrgIds(user);
        if (adminOrgIds.length > 0) {
            if (filterOrgId != null && !isNaN(filterOrgId) && adminOrgIds.includes(filterOrgId)) {
                query += ` WHERE sr.organization_id = ?`;
                params.push(filterOrgId);
            } else {
                query += ` WHERE sr.organization_id IN (${adminOrgIds.map(() => '?').join(',')})`;
                params.push(...adminOrgIds);
            }
        }
    } else if (user.role === 'dev' && filterOrgId != null && !isNaN(filterOrgId)) {
        query += ` WHERE sr.organization_id = ?`;
        params.push(filterOrgId);
    }

    query += ` ORDER BY sr.created_at DESC`;

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('Error fetching service requests:', err);
            return res.status(500).json({ error: 'Failed to fetch service requests' });
        }

        const enriched = (rows || []).map((row: Record<string, unknown>) => {
            const feed = feedNote.parseFeedServiceRequestNote(row.note);
            const pin = feedNote.getFeedPinFromNote(row.note);
            return {
                ...row,
                ticketNumber: feed?.ticketNumber || null,
                pin: pin || null,
            };
        });

        res.json(enriched);
    });
});

// Bulk update service request status
serviceRequests.post('/bulk-status', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const { status } = req.body || {};
    const ids = parseBulkServiceRequestIds(req.body);

    if (!status || !ADMIN_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be: new, read, resolved, incomplete, complete, or acknowledged' });
    }

    if (ids.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty ids array' });
    }

    if (user.role !== 'dev' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const scope = adminServiceRequestOrgScope(user);
    let query = `UPDATE service_requests SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})${scope.clause}`;
    const params = [status, ...ids, ...scope.params];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Error bulk updating service request status:', err);
            return res.status(500).json({ error: 'Failed to update service request status' });
        }

        res.json({ message: 'Service request status updated successfully', changed: this.changes || 0 });
    });
});

// Bulk unresolve — step statuses back toward open queue
serviceRequests.post('/bulk-unresolve', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const ids = parseBulkServiceRequestIds(req.body);

    if (ids.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty ids array' });
    }

    if (user.role !== 'dev' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const scope = adminServiceRequestOrgScope(user);
    let query = `UPDATE service_requests SET status = CASE
        WHEN status = 'resolved' THEN 'read'
        WHEN status = 'acknowledged' THEN 'complete'
        WHEN status = 'complete' THEN 'incomplete'
        ELSE status
    END
    WHERE id IN (${ids.map(() => '?').join(',')})${scope.clause}
    AND status IN ('resolved', 'acknowledged', 'complete')`;
    const params = [...ids, ...scope.params];

    db.run(query, params, function(err) {
        if (err) {
            console.error('Error bulk unresolving service requests:', err);
            return res.status(500).json({ error: 'Failed to unresolve service requests' });
        }

        res.json({ message: 'Service requests unresolved successfully', changed: this.changes || 0 });
    });
});

// Bulk delete service requests (Dev only)
serviceRequests.post('/bulk-delete', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const ids = parseBulkServiceRequestIds(req.body);

    if (user.role !== 'dev') {
        return res.status(403).json({ error: 'Access denied. Only devs can delete service requests.' });
    }

    if (ids.length === 0) {
        return res.status(400).json({ error: 'Provide a non-empty ids array' });
    }

    db.run(`DELETE FROM service_requests WHERE id IN (${ids.map(() => '?').join(',')})`, ids, function(err) {
        if (err) {
            console.error('Error bulk deleting service requests:', err);
            return res.status(500).json({ error: 'Failed to delete service requests' });
        }

        res.json({ message: 'Service requests deleted successfully', deleted: this.changes || 0 });
    });
});

// Update service request status (mark as read/resolved / feed statuses)
serviceRequests.put('/:id/status', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const requestId = parseInt(req.params.id);
    const { status } = req.body;

    if (!status || !ADMIN_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be: new, read, resolved, incomplete, complete, or acknowledged' });
    }

    // Only dev and admin can update service request status
    if (user.role !== 'dev' && user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    let query = `UPDATE service_requests SET status = ? WHERE id = ?`;
    const params = [status, requestId];

    // Admins can only update their org(s) requests
    if (user.role === 'admin' || (user.adminOrganizationIds && user.adminOrganizationIds.length > 0)) {
        const adminOrgIds = getAdminOrgIds(user);
        if (adminOrgIds.length > 0) {
            query += ` AND organization_id IN (${adminOrgIds.map(() => '?').join(',')})`;
            params.push(...adminOrgIds);
        }
    }

    db.run(query, params, function(err) {
        if (err) {
            console.error('Error updating service request status:', err);
            return res.status(500).json({ error: 'Failed to update service request status' });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: 'Service request not found or access denied' });
        }

        res.json({ message: 'Service request status updated successfully' });
    });
});

// Delete service request (Dev only)
serviceRequests.delete('/:id', (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    const db = getDatabase();
    const user = req.user;
    const requestId = parseInt(req.params.id);

    // Only dev can delete service requests
    if (user.role !== 'dev') {
        return res.status(403).json({ error: 'Access denied. Only devs can delete service requests.' });
    }

    db.run(`DELETE FROM service_requests WHERE id = ?`, [requestId], function(err) {
        if (err) {
            console.error('Error deleting service request:', err);
            return res.status(500).json({ error: 'Failed to delete service request' });
        }

        if (this.changes === 0) {
            return res.status(404).json({ error: 'Service request not found' });
        }

        res.json({ message: 'Service request deleted successfully' });
    });
});

export { serviceRequests };
