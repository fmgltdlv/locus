import { Hono } from 'hono';
import { getDatabase } from '../database.js';
import { jsonBodyMiddleware } from '../expressCompat.js';
import * as r2 from '../r2Worker.js';
import type { Env } from '../types.js';
import {
    resolveShareContext,
    computeBoundsFromTicketRows,
    buildProjectShareTicketSummary,
    buildProjectShareTicketDetail,
    queryAerialMapsForProjectTickets,
    queryProjectSharePhotos,
    isMediaAllowedForShareContext,
} from '../lib/projectShareQuery.cjs';
import { POSR_API_BASE } from './ticketProxyRoutes.js';
import { getRow } from '../lib/db.cjs';
import { fetchNgenMapPolygonForTicketRow } from '../lib/ngenMapPolygon.cjs';

const projectShareRoutes = new Hono<{ Bindings: Env }>() as any;
projectShareRoutes.use('*', jsonBodyMiddleware);

function parseBboxQuery(q) {
    const raw = q != null ? String(q).trim() : '';
    if (!raw) return null;
    const parts = raw.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { minLng: parts[0], minLat: parts[1], maxLng: parts[2], maxLat: parts[3] };
}

async function loadShareContext(c, token) {
    const db = getDatabase();
    const ctx = await resolveShareContext(db, token);
    if (!ctx.ok) {
        return { error: c.json({ error: ctx.error }, ctx.status) };
    }
    return { db, ctx };
}

projectShareRoutes.get('/:token', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { ctx } = loaded;
    const tickets = (ctx.ticketRows || []).map((row) => buildProjectShareTicketSummary(ctx.orgId, row));
    return c.json({
        projectName: ctx.projectName,
        projectStatus: ctx.projectStatus,
        jobNameKey: ctx.jobNameKey,
        ticketCount: tickets.length,
        bounds: computeBoundsFromTicketRows(ctx.ticketRows),
        tickets,
        closed: ctx.projectStatus === 'closed',
    });
});

projectShareRoutes.get('/:token/tickets/:ticketNumber', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const tn = (c.req.param('ticketNumber') || '').trim();
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { db, ctx } = loaded;
    const row = (ctx.ticketRows || []).find(
        (r) => r.ticket_number != null && String(r.ticket_number).trim() === tn
    );
    if (!row) return c.json({ error: 'Ticket not found' }, 404);
    const ticket = await buildProjectShareTicketDetail(db, ctx.orgId, row);
    return c.json({ ticket });
});

/** Viewer-initiated passthrough to NV public POSR JSON (no DB write; NV blocks browser CORS). */
projectShareRoutes.get('/:token/nv-posr/:ticketNumber', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const tn = (c.req.param('ticketNumber') || '').trim();
    if (!tn) return c.json({ error: 'Ticket number required' }, 400);
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { ctx } = loaded;
    const base = tn.split('-')[0];
    const inProject = (ctx.ticketRows || []).some((r) => {
        const stored = r.ticket_number != null ? String(r.ticket_number).trim() : '';
        return stored === tn || stored === base || stored.split('-')[0] === base;
    });
    if (!inProject) return c.json({ error: 'Ticket not found' }, 404);
    try {
        const url = `${POSR_API_BASE}${encodeURIComponent(tn)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
            return c.json({ error: 'Could not load ticket from Nevada 811' }, 502);
        }
        const data = await res.json();
        return c.json(data);
    } catch (e) {
        console.error('[project-share] nv-posr passthrough:', e);
        return c.json({ error: 'Could not load ticket from Nevada 811' }, 502);
    }
});

/** Viewer-initiated passthrough to NV public map page for dig polygon (no DB write). */
projectShareRoutes.get('/:token/map-polygon/:ticketNumber', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const tn = (c.req.param('ticketNumber') || '').trim();
    if (!tn) return c.json({ error: 'Ticket number required' }, 400);
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { ctx } = loaded;
    const base = tn.split('-')[0];
    const inProject = (ctx.ticketRows || []).some((r) => {
        const stored = r.ticket_number != null ? String(r.ticket_number).trim() : '';
        return stored === tn || stored === base || stored.split('-')[0] === base;
    });
    if (!inProject) return c.json({ error: 'Ticket not found' }, 404);
    const row = (ctx.ticketRows || []).find((r) => {
        const stored = r.ticket_number != null ? String(r.ticket_number).trim() : '';
        return stored === tn || stored === base || stored.split('-')[0] === base;
    });
    if (!row) return c.json({ error: 'Ticket not found' }, 404);
    try {
        const { polygon, requestNumber } = await fetchNgenMapPolygonForTicketRow(row);
        return c.json({ polygon, requestNumber });
    } catch (e) {
        console.error('[project-share] map-polygon passthrough:', e);
        return c.json({ error: 'Could not load ticket map from Nevada 811' }, 502);
    }
});

projectShareRoutes.get('/:token/aerial-maps', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { db, ctx } = loaded;
    const maps = await queryAerialMapsForProjectTickets(db, ctx.orgId, ctx.ticketRows);
    return c.json({ maps });
});

projectShareRoutes.get('/:token/photos', async (c) => {
    const token = (c.req.param('token') || '').trim();
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { db, ctx } = loaded;
    const bbox = parseBboxQuery(c.req.query('bbox'));
    const limit = c.req.query('limit');
    const photos = await queryProjectSharePhotos(db, ctx.orgId, ctx.ticketIds, bbox, limit);
    return c.json({ photos });
});

async function serveShareMedia(c, token, mediaId, kind) {
    const loaded = await loadShareContext(c, token);
    if (loaded.error) return loaded.error;
    const { db, ctx } = loaded;
    const mid = parseInt(String(mediaId), 10);
    if (!Number.isFinite(mid)) return c.json({ error: 'Invalid media id' }, 400);
    if (!(await isMediaAllowedForShareContext(db, ctx, mid))) {
        return c.json({ error: 'Access denied' }, 403);
    }
    const mediaRow = await getRow(
        db,
        `SELECT file_path, thumbnail_path, mime_type FROM media_files WHERE id = ? AND organization_id = ?`,
        [mid, ctx.orgId]
    );
    if (!mediaRow) return c.json({ error: 'File not found' }, 404);
    const thumbKey = String(mediaRow.thumbnail_path || '').replace(/\\/g, '/');
    const fileKey = String(mediaRow.file_path || '').replace(/\\/g, '/');
    const key =
        kind === 'thumbnail'
            ? mediaRow.thumbnail_path && r2.isR2ObjectKey(thumbKey)
                ? thumbKey
                : r2.isR2ObjectKey(fileKey)
                  ? fileKey
                  : null
            : r2.isR2ObjectKey(fileKey)
              ? fileKey
              : null;
    if (!key) return c.json({ error: 'File not available' }, 404);
    if (!r2.isR2Configured()) return c.json({ error: 'Object storage is not configured' }, 503);
    try {
        const { body, contentType } = await r2.getObjectStream(key);
        const mimeType =
            kind === 'thumbnail' && key === thumbKey
                ? 'image/jpeg'
                : mediaRow.mime_type || contentType || 'application/octet-stream';
        return new Response(body, {
            headers: {
                'Content-Type': mimeType,
                'Content-Disposition': 'inline',
                'Cache-Control': 'private, max-age=3600',
            },
        });
    } catch (e) {
        console.error('project share media:', e);
        return c.json({ error: 'Failed to load file' }, 500);
    }
}

projectShareRoutes.get('/:token/media/:id/thumbnail', async (c) => {
    return serveShareMedia(c, c.req.param('token'), c.req.param('id'), 'thumbnail');
});

projectShareRoutes.get('/:token/media/:id/file', async (c) => {
    return serveShareMedia(c, c.req.param('token'), c.req.param('id'), 'file');
});

export { projectShareRoutes };
