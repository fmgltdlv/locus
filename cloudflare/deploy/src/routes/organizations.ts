// Organization management routes (ported from backend/routes/organizations.js)
import { Hono } from "hono";
import { getDatabase } from "../database.js";
import {
    authMiddleware,
    authorizeMiddleware,
    canAccessOrganization,
    canAdminOrganization,
    canViewOrganization,
} from "../auth.js";
import { safeParseJSON } from "../lib/utils.js";
import { sanitizeWorkflowAckComplianceInSettings } from "../lib/workflowAckCompliance.cjs";
import { getSubscriptionTierColumnFromSettings } from "../lib/subscriptionTier.js";
import { invalidateOrgActiveTicketListCache } from "../lib/ticketListCache.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim, respondAfterDb } from "../expressCompat.js";
import type { Env } from "../types.js";
import * as r2 from "../r2Worker.js";
import {
    isPublicEmailDomain,
    normalizeEmailDomain,
    validateOrgDisplayName,
} from "../lib/signupDomain.js";

const { runDb, getRow } = require("../lib/db.cjs");

const MENU_ICON_MAX_BYTES = 200 * 1024;
const MENU_ICON_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const orgs = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
orgs.use("*", jsonBodyMiddleware);
orgs.use("*", authMiddleware);
orgs.use("*", expressReqResMiddleware);

function mapOrganizationRow(row, req) {
    const { webhook_secret_phrase: _w, subscription_tier: _tierCol, ...rest } = row;
    let settings: Record<string, unknown> = safeParseJSON(row.settings, {});
    if (row.subscription_tier != null && String(row.subscription_tier).trim() !== '') {
        const t = String(row.subscription_tier).toLowerCase();
        if (t === 'basic' || t === 'plus' || t === 'max' || t === 'enhanced') {
            // Persist distinct Max; legacy plus still surfaces as enhanced for clients.
            const subscriptionTier =
                t === 'basic' ? 'basic' : t === 'max' ? 'max' : 'enhanced';
            settings = { ...settings, subscriptionTier };
        }
    }
    const out = { ...rest, settings };
    if (row.is_public_catalog != null) out.isPublicCatalog = Number(row.is_public_catalog) === 1;
    if (row.share_to_public != null) out.shareToPublic = Number(row.share_to_public) === 1;
    if (row.public_identity_mode != null) out.publicIdentityMode = row.public_identity_mode || 'named';
    if (row.email_domain != null) out.emailDomain = row.email_domain ? String(row.email_domain) : null;
    if (row.name_normalized != null) out.nameNormalized = row.name_normalized ? String(row.name_normalized) : null;
    if (req && req.user && req.user.role === 'dev' && row.is_dev_ticket_hub != null) {
        out.isDevTicketHub = Number(row.is_dev_ticket_hub) === 1;
    }
    if (settings.menuIconPath) {
        out.menuIconUrl = `/api/organizations/${row.id}/menu-icon`;
    }
    return out;
}

// Get all organizations (dev sees all, admin/user see only their orgs)
orgs.get('/', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const slim =
        req.query.slim === '1' ||
        String(req.query.slim || '').toLowerCase() === 'true';
    if (req.user.role === 'dev') {
        return await respondAfterDb(res, (done) => {
            const sql = slim
                ? `SELECT o.* FROM organizations o ORDER BY o.created_at DESC`
                : `
            SELECT
                o.*,
                COUNT(DISTINCT uo_members.user_id) as user_count,
                COUNT(DISTINCT m.id) as media_count,
                COUNT(DISTINCT g.id) as geospatial_count
            FROM organizations o
            LEFT JOIN user_organizations uo_members ON uo_members.organization_id = o.id
            LEFT JOIN media_files m ON m.organization_id = o.id
            LEFT JOIN geospatial_data g ON g.organization_id = o.id
            GROUP BY o.id
            ORDER BY o.created_at DESC
        `;
            db.all(
                sql,
                (err, rows) => {
                    if (err) {
                        console.error('Error fetching organizations:', err);
                        res.status(500).json({ error: 'Failed to fetch organizations' });
                        done();
                        return;
                    }
                    const organizations = (rows || []).map((row) => mapOrganizationRow(row, req));
                    res.json(organizations);
                    done();
                }
            );
        });
    }
    return await respondAfterDb(res, (done) => {
        const memberSql = slim
            ? `
            SELECT o.*
            FROM organizations o
            JOIN user_organizations uo ON uo.organization_id = o.id
            WHERE uo.user_id = ? AND COALESCE(o.is_dev_ticket_hub, 0) = 0
            ORDER BY o.created_at DESC
        `
            : `
            SELECT
                o.*,
                COUNT(DISTINCT uo_members.user_id) as user_count,
                COUNT(DISTINCT m.id) as media_count,
                COUNT(DISTINCT g.id) as geospatial_count
            FROM organizations o
            JOIN user_organizations uo ON uo.organization_id = o.id
            LEFT JOIN user_organizations uo_members ON uo_members.organization_id = o.id
            LEFT JOIN media_files m ON m.organization_id = o.id
            LEFT JOIN geospatial_data g ON g.organization_id = o.id
            WHERE uo.user_id = ? AND COALESCE(o.is_dev_ticket_hub, 0) = 0
            GROUP BY o.id
            ORDER BY o.created_at DESC
        `;
        db.all(
            memberSql,
            [req.user.id],
            (err, rows) => {
                if (err) {
                    console.error('Error fetching organizations:', err);
                    res.status(500).json({ error: 'Failed to fetch organizations' });
                    done();
                    return;
                }
                const organizations = (rows || []).map((row) => ({
                    ...mapOrganizationRow(row, req),
                    accessMode: 'member',
                }));
                db.get(
                    `SELECT 1 AS ok FROM user_organizations uo
                 INNER JOIN organizations o ON o.id = uo.organization_id
                 WHERE uo.user_id = ? AND o.share_to_public = 1
                 LIMIT 1`,
                    [req.user.id],
                    (e2, elig) => {
                        if (e2 || !elig) {
                            res.json(organizations);
                            done();
                            return;
                        }
                        db.get(
                            slim
                                ? `SELECT o.* FROM organizations o WHERE o.is_public_catalog = 1 LIMIT 1`
                                : `SELECT o.*,
                            COUNT(DISTINCT uo_members.user_id) as user_count,
                            COUNT(DISTINCT m.id) as media_count,
                            COUNT(DISTINCT g.id) as geospatial_count
                         FROM organizations o
                         LEFT JOIN user_organizations uo_members ON uo_members.organization_id = o.id
                         LEFT JOIN media_files m ON m.organization_id = o.id
                         LEFT JOIN geospatial_data g ON g.organization_id = o.id
                         WHERE o.is_public_catalog = 1
                         GROUP BY o.id
                         LIMIT 1`,
                            [],
                            (e3, pub) => {
                                if (e3 || !pub) {
                                    res.json(organizations);
                                    done();
                                    return;
                                }
                                const pubId = Number(pub.id);
                                if (organizations.some((x) => Number(x.id) === pubId)) {
                                    res.json(organizations);
                                    done();
                                    return;
                                }
                                const s: Record<string, unknown> = safeParseJSON(pub.settings, {});
                                const label =
                                    (s.publicCatalogLabel && String(s.publicCatalogLabel).trim()) ||
                                    (s.public_catalog_label && String(s.public_catalog_label).trim()) ||
                                    'Public Data';
                                organizations.push({
                                    ...mapOrganizationRow(pub, req),
                                    accessMode: 'viewer',
                                    publicCatalogDisplayName: label,
                                });
                                res.json(organizations);
                                done();
                            }
                        );
                    }
                );
            }
        );
    });
});

// Organization menu icon (radial wheel thumbnail)
orgs.get('/:id/menu-icon', async (c) => {
    const req = buildExpressReq(c);
    const orgId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(orgId)) {
        return c.json({ error: 'Invalid organization id' }, 400);
    }
    if (!(await canViewOrganization(req.user, orgId))) {
        return c.json({ error: 'Access denied to this organization' }, 403);
    }
    const db = getDatabase();
    const row = await getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [orgId]);
    if (!row) {
        return c.json({ error: 'Organization not found' }, 404);
    }
    const settings: Record<string, unknown> = safeParseJSON(row.settings, {});
    const iconPath = settings.menuIconPath;
    if (!iconPath || !r2.isR2ObjectKey(String(iconPath))) {
        return c.json({ error: 'Menu icon not found' }, 404);
    }
    if (!r2.isR2Configured()) {
        return c.json({ error: 'Object storage is not configured' }, 503);
    }
    try {
        const { body, contentType } = await r2.getObjectStream(String(iconPath));
        return new Response(body, {
            headers: {
                'Content-Type': contentType || 'image/jpeg',
                'Cache-Control': 'private, max-age=3600',
            },
        });
    } catch (e) {
        console.error('GET /organizations/:id/menu-icon:', e);
        return c.json({ error: 'Failed to load menu icon' }, 500);
    }
});

orgs.post('/:id/menu-icon', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    const orgId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    if (!canAdminOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'Only organization admins can upload a menu icon' });
        return await res.getResponse();
    }
    const ct = c.req.header('content-type') || '';
    if (!ct.includes('multipart/form-data')) {
        res.status(400).json({ error: 'Expected multipart/form-data upload' });
        return await res.getResponse();
    }
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
        res.status(400).json({ error: 'No file uploaded' });
        return await res.getResponse();
    }
    const upload = file as File;
    const mime = (upload.type || 'application/octet-stream').toLowerCase();
    if (!MENU_ICON_MIME.has(mime)) {
        res.status(400).json({ error: 'Menu icon must be JPEG, PNG, or WebP' });
        return await res.getResponse();
    }
    const ab = await upload.arrayBuffer();
    if (ab.byteLength > MENU_ICON_MAX_BYTES) {
        res.status(400).json({ error: 'Menu icon must be 200 KB or smaller' });
        return await res.getResponse();
    }
    if (!r2.isR2Configured()) {
        res.status(503).json({ error: 'Object storage is not configured' });
        return await res.getResponse();
    }
    const db = getDatabase();
    const orgRow = await getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [orgId]);
    if (!orgRow) {
        res.status(404).json({ error: 'Organization not found' });
        return await res.getResponse();
    }
    const settings: Record<string, unknown> = safeParseJSON(orgRow.settings, {});
    const iconKey = r2.objectKeyOrgMenuIcon(orgId);
    const prevPath = settings.menuIconPath;
    try {
        await r2.putObjectFromBuffer(iconKey, Buffer.from(ab), mime === 'image/png' ? 'image/jpeg' : mime);
        settings.menuIconPath = iconKey;
        await runDb(db, 'UPDATE organizations SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
            JSON.stringify(settings),
            orgId,
        ]);
        if (prevPath && prevPath !== iconKey && r2.isR2ObjectKey(String(prevPath))) {
            await r2.deleteObjectKey(String(prevPath)).catch(() => {});
        }
        const updated = await getRow(db, 'SELECT * FROM organizations WHERE id = ?', [orgId]);
        res.json({
            message: 'Menu icon uploaded successfully',
            menuIconUrl: `/api/organizations/${orgId}/menu-icon`,
            organization: mapOrganizationRow(updated, req),
        });
    } catch (e) {
        console.error('POST /organizations/:id/menu-icon:', e);
        res.status(500).json({ error: 'Failed to upload menu icon' });
    }
    return await res.getResponse();
});

orgs.delete('/:id/menu-icon', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    const orgId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    if (!canAdminOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'Only organization admins can remove a menu icon' });
        return await res.getResponse();
    }
    const db = getDatabase();
    const orgRow = await getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [orgId]);
    if (!orgRow) {
        res.status(404).json({ error: 'Organization not found' });
        return await res.getResponse();
    }
    const settings: Record<string, unknown> = safeParseJSON(orgRow.settings, {});
    const iconPath = settings.menuIconPath;
    delete settings.menuIconPath;
    try {
        await runDb(db, 'UPDATE organizations SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
            JSON.stringify(settings),
            orgId,
        ]);
        if (iconPath && r2.isR2ObjectKey(String(iconPath))) {
            await r2.deleteObjectKey(String(iconPath)).catch(() => {});
        }
        res.json({ message: 'Menu icon removed successfully' });
    } catch (e) {
        console.error('DELETE /organizations/:id/menu-icon:', e);
        res.status(500).json({ error: 'Failed to remove menu icon' });
    }
    return await res.getResponse();
});

// Get single organization
orgs.get('/:id', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }

    return await respondAfterDb(res, (done) => {
        function loadOneOrg() {
            db.get(
                `
        SELECT
            o.*,
            COUNT(DISTINCT uo_members.user_id) as user_count,
            COUNT(DISTINCT m.id) as media_count,
            COUNT(DISTINCT g.id) as geospatial_count
        FROM organizations o
        LEFT JOIN user_organizations uo_members ON uo_members.organization_id = o.id
        LEFT JOIN media_files m ON m.organization_id = o.id
        LEFT JOIN geospatial_data g ON g.organization_id = o.id
        WHERE o.id = ?
        GROUP BY o.id
    `,
                [orgId],
                (err, organization) => {
                    if (err) {
                        console.error('Error fetching organization:', err);
                        res.status(500).json({ error: 'Failed to fetch organization' });
                        done();
                        return;
                    }
                    if (!organization) {
                        res.status(404).json({ error: 'Organization not found' });
                        done();
                        return;
                    }
                    if (req.user.role !== 'dev' && Number(organization.is_dev_ticket_hub) === 1) {
                        res.status(403).json({ error: 'Access denied to this organization' });
                        done();
                        return;
                    }
                    res.json(mapOrganizationRow(organization, req));
                    done();
                }
            );
        }
        if (canAccessOrganization(req.user, orgId)) {
            loadOneOrg();
            return;
        }
        db.get('SELECT is_public_catalog FROM organizations WHERE id = ?', [orgId], (e1, pubRow) => {
            if (e1 || !pubRow || !pubRow.is_public_catalog) {
                res.status(403).json({ error: 'Access denied to this organization' });
                done();
                return;
            }
            db.get(
                `SELECT 1 AS ok FROM user_organizations uo
             INNER JOIN organizations o ON o.id = uo.organization_id
             WHERE uo.user_id = ? AND o.share_to_public = 1
             LIMIT 1`,
                [req.user.id],
                (e2, elig) => {
                    if (e2 || !elig) {
                        res.status(403).json({ error: 'Access denied to this organization' });
                        done();
                        return;
                    }
                    loadOneOrg();
                }
            );
        });
    });
});

// Update public sharing settings (org admin or dev)
orgs.put('/:id/public-sharing', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    if (!canAdminOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'Only organization admins can change public sharing settings' });
        return await res.getResponse();
    }
    const pubRow = await getRow(db, 'SELECT is_public_catalog FROM organizations WHERE id = ?', [orgId]);
    if (pubRow && Number(pubRow.is_public_catalog) === 1) {
        res.status(400).json({ error: 'The public catalog organization cannot enable contributor sharing' });
        return await res.getResponse();
    }
    const { shareToPublic, publicIdentityMode } = req.body || {};
    const updates = [];
    const values = [];
    if (shareToPublic !== undefined) {
        updates.push('share_to_public = ?');
        values.push(shareToPublic ? 1 : 0);
    }
    if (publicIdentityMode !== undefined) {
        const mode = String(publicIdentityMode).toLowerCase() === 'anonymous' ? 'anonymous' : 'named';
        updates.push('public_identity_mode = ?');
        values.push(mode);
    }
    if (!updates.length) {
        res.status(400).json({ error: 'No valid fields to update' });
        return await res.getResponse();
    }
    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(orgId);
    try {
        await runDb(db, `UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`, values);
        const row = await getRow(db, 'SELECT * FROM organizations WHERE id = ?', [orgId]);
        res.json(mapOrganizationRow(row, req));
    } catch (e) {
        console.error('PUT /organizations/:id/public-sharing:', e);
        res.status(500).json({ error: 'Failed to update public sharing settings' });
    }
    return await res.getResponse();
});

// Create organization (dev only)
orgs.post('/', authorizeMiddleware('dev'), async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const { name, settings, isDevTicketHub } = req.body;
    if (!name) {
        res.status(400).json({ error: 'Organization name is required' });
        return await res.getResponse();
    }
    const nameCheck = validateOrgDisplayName(String(name));
    if (nameCheck.ok === false) {
        res.status(400).json({ error: nameCheck.error });
        return await res.getResponse();
    }
    const tier = settings ? getSubscriptionTierColumnFromSettings(settings) : 'basic';
    return await respondAfterDb(res, (done) => {
        db.run(
            'INSERT INTO organizations (name, name_normalized, settings, subscription_tier, is_dev_ticket_hub) VALUES (?, ?, ?, ?, ?)',
            [nameCheck.name, nameCheck.normalized, settings ? JSON.stringify(settings) : null, tier, isDevTicketHub ? 1 : 0],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        res.status(409).json({ error: 'Organization name already exists' });
                        done();
                        return;
                    }
                    console.error('Error creating organization:', err);
                    res.status(500).json({ error: 'Failed to create organization' });
                    done();
                    return;
                }
                const newId = this.lastID;
                res.status(201).json({
                    id: newId,
                    name: nameCheck.name,
                    nameNormalized: nameCheck.normalized,
                    settings: settings || {},
                    isDevTicketHub: !!isDevTicketHub,
                    storage_used: 0,
                    message: 'Organization created successfully',
                });
                done();
            }
        );
    });
});

// Update organization (dev or admin of that org)
orgs.put('/:id', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    const { name, settings, isPublicCatalog, isDevTicketHub, shareToPublic, publicIdentityMode, emailDomain } = req.body;

    if (req.user.role !== 'dev' && !canAdminOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'Only organization admins can update this organization' });
        return await res.getResponse();
    }

    if (shareToPublic !== undefined || publicIdentityMode !== undefined) {
        const pubRow = await getRow(db, 'SELECT is_public_catalog FROM organizations WHERE id = ?', [orgId]);
        if (pubRow && Number(pubRow.is_public_catalog) === 1) {
            res.status(400).json({ error: 'The public catalog organization cannot enable contributor sharing' });
            return await res.getResponse();
        }
    }

    function runUpdate(done) {
        const updates = [];
        const values = [];
        if (name) {
            const nameCheck = validateOrgDisplayName(String(name));
            if (nameCheck.ok === false) {
                res.status(400).json({ error: nameCheck.error });
                done();
                return;
            }
            updates.push('name = ?');
            values.push(nameCheck.name);
            updates.push('name_normalized = ?');
            values.push(nameCheck.normalized);
        }
        if (emailDomain !== undefined) {
            const raw = emailDomain == null || String(emailDomain).trim() === '' ? null : normalizeEmailDomain(String(emailDomain));
            if (raw && isPublicEmailDomain(raw)) {
                res.status(400).json({ error: 'Public email domains cannot be claimed for auto-join' });
                done();
                return;
            }
            updates.push('email_domain = ?');
            values.push(raw);
        }
        if (settings !== undefined) {
            const settingsToSave = req.user.role === 'dev' ? settings : { ...settings };
            if (req.user.role !== 'dev') {
                delete settingsToSave.subscriptionTier;
                delete settingsToSave.subscription_tier;
            }
            const sanitizedSettings = sanitizeWorkflowAckComplianceInSettings(settingsToSave);
            updates.push('settings = ?');
            values.push(JSON.stringify(sanitizedSettings));
            if (req.user.role === 'dev') {
                updates.push('subscription_tier = ?');
                values.push(getSubscriptionTierColumnFromSettings(sanitizedSettings));
            }
        }
        if (req.user.role === 'dev' && isPublicCatalog !== undefined) {
            updates.push('is_public_catalog = ?');
            values.push(isPublicCatalog ? 1 : 0);
        }
        if (req.user.role === 'dev' && isDevTicketHub !== undefined) {
            updates.push('is_dev_ticket_hub = ?');
            values.push(isDevTicketHub ? 1 : 0);
        }
        if (shareToPublic !== undefined) {
            updates.push('share_to_public = ?');
            values.push(shareToPublic ? 1 : 0);
        }
        if (publicIdentityMode !== undefined) {
            const mode = String(publicIdentityMode).toLowerCase() === 'anonymous' ? 'anonymous' : 'named';
            updates.push('public_identity_mode = ?');
            values.push(mode);
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(orgId);
        if (updates.length === 1) {
            res.status(400).json({ error: 'No valid fields to update' });
            done();
            return;
        }
        db.run(
            `UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`,
            values,
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        const msg = /email_domain/i.test(String(err.message || ''))
                            ? 'That email domain is already claimed by another organization'
                            : 'Organization name already exists';
                        res.status(409).json({ error: msg });
                        done();
                        return;
                    }
                    console.error('Error updating organization:', err);
                    res.status(500).json({ error: 'Failed to update organization' });
                    done();
                    return;
                }
                if (this.changes === 0) {
                    res.status(404).json({ error: 'Organization not found' });
                    done();
                    return;
                }
                if (settings !== undefined) {
                    void invalidateOrgActiveTicketListCache(db, orgId);
                }
                res.json({ message: 'Organization updated successfully' });
                done();
            }
        );
    }

    return await respondAfterDb(res, (done) => {
        runUpdate(done);
    });
});

// Delete organization (dev only)
orgs.delete('/:id', authorizeMiddleware('dev'), async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    return await respondAfterDb(res, (done) => {
        db.get('SELECT is_public_catalog FROM organizations WHERE id = ?', [orgId], (e0, orgRow) => {
            if (e0) {
                console.error('Error checking organization:', e0);
                res.status(500).json({ error: 'Failed to delete organization' });
                done();
                return;
            }
            if (orgRow && orgRow.is_public_catalog) {
                res.status(400).json({ error: 'Cannot delete the public catalog organization' });
                done();
                return;
            }
            db.run('DELETE FROM organizations WHERE id = ?', [orgId], function (err) {
                if (err) {
                    console.error('Error deleting organization:', err);
                    res.status(500).json({ error: 'Failed to delete organization' });
                    done();
                    return;
                }
                if (this.changes === 0) {
                    res.status(404).json({ error: 'Organization not found' });
                    done();
                    return;
                }
                res.json({ message: 'Organization deleted successfully' });
                done();
            });
        });
    });
});

// Get organization storage usage with breakdown by type
orgs.get('/:id/storage', async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = parseInt(req.params.id, 10);
    if (!Number.isFinite(orgId)) {
        res.status(400).json({ error: 'Invalid organization id' });
        return await res.getResponse();
    }
    if (!(await canViewOrganization(req.user, orgId))) {
        res.status(403).json({ error: 'Access denied to this organization' });
        return await res.getResponse();
    }
    return await respondAfterDb(res, (done) => {
        db.all(
            `
        SELECT
            file_type,
            COALESCE(SUM(file_size), 0) as bytes,
            COUNT(*) as count
        FROM media_files
        WHERE organization_id = ?
        GROUP BY file_type
    `,
            [orgId],
            (err, mediaRows) => {
                if (err) {
                    console.error('Error fetching media storage:', err);
                    res.status(500).json({ error: 'Failed to fetch storage information' });
                    done();
                    return;
                }
                const breakdown = {
                    photos: { bytes: 0, count: 0 },
                    documents: { bytes: 0, count: 0 },
                    geospatial: { bytes: 0, count: 0 },
                };
                let totalStorage = 0;
                (mediaRows || []).forEach((row: { file_type?: string; bytes?: number; count?: number }) => {
                    const key =
                        row.file_type === 'photo'
                            ? 'photos'
                            : row.file_type === 'document'
                              ? 'documents'
                              : 'geospatial';
                    if (breakdown[key] !== undefined) {
                        breakdown[key] = { bytes: Number(row.bytes) || 0, count: Number(row.count) || 0 };
                        totalStorage += Number(row.bytes) || 0;
                    }
                });
                db.get(
                    `
            SELECT
                COALESCE(SUM(LENGTH(geometry) + LENGTH(COALESCE(properties, ''))), 0) as bytes,
                COUNT(*) as count
            FROM geospatial_data
            WHERE organization_id = ?
        `,
                    [orgId],
                    (err2, geoResult) => {
                        if (err2) {
                            console.error('Error fetching geospatial storage:', err2);
                            res.status(500).json({ error: 'Failed to fetch storage information' });
                            done();
                            return;
                        }
                        const annotationsBytes = geoResult && geoResult.bytes ? Number(geoResult.bytes) : 0;
                        const annotationsCount = geoResult && geoResult.count ? Number(geoResult.count) : 0;
                        totalStorage += annotationsBytes;
                        res.json({
                            organization_id: orgId,
                            total_storage: totalStorage,
                            file_count:
                                breakdown.photos.count + breakdown.documents.count + breakdown.geospatial.count,
                            breakdown: {
                                photos: breakdown.photos,
                                documents: breakdown.documents,
                                geospatial: breakdown.geospatial,
                                annotations: { bytes: annotationsBytes, count: annotationsCount },
                            },
                        });
                        done();
                    }
                );
            }
        );
    });
});

export { orgs as organizations };

