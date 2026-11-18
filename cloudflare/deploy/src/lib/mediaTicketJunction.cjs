const { allRows, getRow, runDb } = require('./db.cjs');
const { ticketBaseFromNumber } = require('./mapPhotoTimeWindow.cjs');
const { findTicketIdsForMediaPoint } = require('./ticketPhotoIntersection.cjs');

const JUNCTION_SOURCES = new Set(['spatial', 'associated_no_gps']);

function isMissingTableError(e) {
    return /no such table/i.test((e && e.message) || String(e || ''));
}

function safeJsonParse(s, fallback) {
    try {
        return s ? JSON.parse(String(s)) : fallback;
    } catch (_) {
        return fallback;
    }
}

function associatedTicketIdFromMediaMeta(rawMeta) {
    const meta = typeof rawMeta === 'string' ? safeJsonParse(rawMeta, {}) : rawMeta;
    if (!meta || typeof meta !== 'object') return null;
    const tid = meta.associatedTicketId != null ? Number(meta.associatedTicketId) : null;
    return Number.isFinite(tid) && tid > 0 ? tid : null;
}

async function ticketBaseForTicketId(db, orgId, ticketId) {
    const row = await getRow(
        db,
        `SELECT ticket_number FROM tickets WHERE id = ? AND organization_id = ?`,
        [ticketId, orgId]
    );
    if (!row || !row.ticket_number) return null;
    return ticketBaseFromNumber(row.ticket_number);
}

async function findTicketBasesForMediaPoint(db, orgId, point) {
    const ids = await findTicketIdsForMediaPoint(db, orgId, point);
    const bases = new Set();
    for (const id of ids) {
        const base = await ticketBaseForTicketId(db, orgId, id);
        if (base) bases.add(base);
    }
    return Array.from(bases);
}

async function removeJunctionForMedia(db, orgId, mediaId) {
    try {
        await runDb(
            db,
            `DELETE FROM media_ticket_intersections WHERE organization_id = ? AND media_id = ?`,
            [orgId, mediaId]
        );
    } catch (e) {
        if (!isMissingTableError(e)) throw e;
    }
}

async function upsertJunctionLink(db, orgId, mediaId, ticketBaseNumber, source) {
    if (!ticketBaseNumber || !JUNCTION_SOURCES.has(source)) return;
    const computedAt = new Date().toISOString();
    try {
        await runDb(
            db,
            `INSERT INTO media_ticket_intersections
               (media_id, ticket_base_number, organization_id, source, computed_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(media_id, ticket_base_number, organization_id) DO UPDATE SET
               source = excluded.source,
               computed_at = excluded.computed_at`,
            [mediaId, ticketBaseNumber, orgId, source, computedAt]
        );
    } catch (e) {
        if (!isMissingTableError(e)) throw e;
    }
}

/**
 * Replace all junction rows for one media item from current GPS + association state.
 */
async function syncJunctionForMedia(db, orgId, mediaId, metaLike, pointLike) {
    const links = [];
    const meta = metaLike && typeof metaLike === 'object' ? metaLike : {};
    const hasGps =
        pointLike &&
        (pointLike.hasGps === true ||
            pointLike.has_gps === 1 ||
            pointLike.hasGPS === true ||
            (Number.isFinite(Number(pointLike.lat)) && Number.isFinite(Number(pointLike.lng))));
    if (hasGps) {
        const lat = Number(pointLike.lat != null ? pointLike.lat : pointLike.latitude);
        const lng = Number(pointLike.lng != null ? pointLike.lng : pointLike.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const bases = await findTicketBasesForMediaPoint(db, orgId, { lat, lng });
            for (const base of bases) {
                links.push({ ticketBaseNumber: base, source: 'spatial' });
            }
        }
    }
    const assocId = associatedTicketIdFromMediaMeta(meta);
    if (assocId) {
        const base = await ticketBaseForTicketId(db, orgId, assocId);
        if (base) {
            links.push({ ticketBaseNumber: base, source: 'associated_no_gps' });
        }
    }
    await removeJunctionForMedia(db, orgId, mediaId);
    for (const link of links) {
        await upsertJunctionLink(db, orgId, mediaId, link.ticketBaseNumber, link.source);
    }
    return links;
}

/**
 * After ticket snapshot recompute: set junction rows for this ticket base from matching media list.
 * @param {Array<{ id: number, associatedNoGps?: boolean }>} matchingMedia
 */
async function syncJunctionForTicketRecompute(db, orgId, ticketRow, matchingMedia) {
    const ticketBase = ticketBaseFromNumber(ticketRow && ticketRow.ticket_number);
    if (!ticketBase) return;
    const desired = new Map();
    for (const m of matchingMedia || []) {
        const id = Number(m.id);
        if (!Number.isFinite(id)) continue;
        const source = m.associatedNoGps ? 'associated_no_gps' : 'spatial';
        desired.set(id, source);
    }
    let existing = [];
    try {
        existing = await allRows(
            db,
            `SELECT media_id, source FROM media_ticket_intersections
             WHERE organization_id = ? AND ticket_base_number = ?`,
            [orgId, ticketBase]
        );
    } catch (e) {
        if (isMissingTableError(e)) return;
        throw e;
    }
    const existingIds = new Set((existing || []).map((r) => Number(r.media_id)));
    for (const [mediaId, source] of desired.entries()) {
        await upsertJunctionLink(db, orgId, mediaId, ticketBase, source);
        existingIds.delete(mediaId);
    }
    for (const staleId of existingIds) {
        if (!desired.has(staleId)) {
            await runDb(
                db,
                `DELETE FROM media_ticket_intersections
                 WHERE organization_id = ? AND ticket_base_number = ? AND media_id = ?`,
                [orgId, ticketBase, staleId]
            );
        }
    }
}

async function resolveAffectedTicketIdsForMediaDelete(db, orgId, mediaRow) {
    const mediaId = mediaRow && mediaRow.id != null ? Number(mediaRow.id) : null;
    const ticketIds = new Set();
    if (Number.isFinite(mediaId)) {
        try {
            const junctionRows = await allRows(
                db,
                `SELECT ticket_base_number FROM media_ticket_intersections
                 WHERE organization_id = ? AND media_id = ?`,
                [orgId, mediaId]
            );
            for (const jr of junctionRows || []) {
                const base = String(jr.ticket_base_number || '').trim();
                if (!base) continue;
                const revRows = await allRows(
                    db,
                    `SELECT id FROM tickets
                     WHERE organization_id = ?
                       AND (ticket_number = ? OR ticket_number LIKE ?)
                     ORDER BY updated_at DESC
                     LIMIT 5`,
                    [orgId, `${base}-000`, `${base}-%`]
                );
                for (const tr of revRows || []) {
                    if (tr.id != null) ticketIds.add(Number(tr.id));
                }
            }
        } catch (e) {
            if (!isMissingTableError(e)) throw e;
        }
    }
    const meta = safeJsonParse(mediaRow && mediaRow.metadata, {});
    const assocId = associatedTicketIdFromMediaMeta(meta);
    if (assocId) ticketIds.add(assocId);
    const lat = mediaRow && mediaRow.latitude != null ? Number(mediaRow.latitude) : NaN;
    const lng = mediaRow && mediaRow.longitude != null ? Number(mediaRow.longitude) : NaN;
    const hasGps = mediaRow && (mediaRow.has_gps === 1 || mediaRow.has_gps === true);
    if (hasGps && Number.isFinite(lat) && Number.isFinite(lng)) {
        const spatialIds = await findTicketIdsForMediaPoint(db, orgId, { lat, lng });
        spatialIds.forEach((id) => ticketIds.add(id));
    }
    return Array.from(ticketIds);
}

module.exports = {
    syncJunctionForMedia,
    syncJunctionForTicketRecompute,
    removeJunctionForMedia,
    resolveAffectedTicketIdsForMediaDelete,
    findTicketBasesForMediaPoint,
    ticketBaseForTicketId,
    associatedTicketIdFromMediaMeta,
};
