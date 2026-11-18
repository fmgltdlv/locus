const { runDb, allRows } = require('./db.cjs');
const { computePolygonAabb, normalizePolygonJson } = require('./ticketIndexedColumns.cjs');
const { ticketBaseFromNumber } = require('./mapPhotoTimeWindow.cjs');

async function listTicketIdsForBase(db, orgId, ticketBaseNumber) {
    const org = orgId != null ? Number(orgId) : NaN;
    const base = String(ticketBaseNumber || '').trim();
    if (!Number.isFinite(org) || !base) return [];
    const rows = await allRows(
        db,
        `SELECT id FROM tickets
         WHERE organization_id = ?
           AND (ticket_number = ? OR ticket_number LIKE ?)
         ORDER BY id ASC`,
        [org, base, `${base}-%`]
    );
    return (rows || []).map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
}

function hasDisplayablePolygon(polygon) {
    if (!polygon || typeof polygon !== 'object') return false;
    const t = String(polygon.type || '');
    return t === 'Polygon' || t === 'MultiPolygon';
}

/**
 * Write the same dig-site polygon + AABB onto every ticket revision under the base.
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {string} ticketNumberOrBase
 * @param {object|null|undefined} polygon GeoJSON polygon
 */
async function propagateDigSitePolygonToBaseTickets(db, orgId, ticketNumberOrBase, polygon) {
    const org = orgId != null ? Number(orgId) : NaN;
    const base = ticketBaseFromNumber(ticketNumberOrBase) || String(ticketNumberOrBase || '').trim();
    if (!Number.isFinite(org) || !base || !hasDisplayablePolygon(polygon)) return { updated: false, count: 0 };
    const polygon_json = normalizePolygonJson(polygon);
    if (!polygon_json) return { updated: false, count: 0 };
    const aabb = computePolygonAabb(polygon);
    const result = await runDb(
        db,
        `UPDATE tickets
         SET polygon_json = ?,
             min_lng = ?,
             min_lat = ?,
             max_lng = ?,
             max_lat = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = ?
           AND (ticket_number = ? OR ticket_number LIKE ?)`,
        [
            polygon_json,
            aabb ? aabb.min_lng : null,
            aabb ? aabb.min_lat : null,
            aabb ? aabb.max_lng : null,
            aabb ? aabb.max_lat : null,
            org,
            base,
            `${base}-%`,
        ]
    );
    const count = result && result.changes != null ? Number(result.changes) : 0;
    return { updated: count > 0, count, ticketBaseNumber: base };
}

/**
 * Call after ticket row persist when ticket data may include polygon.
 */
async function syncDigSitePolygonAfterPersist(db, orgId, ticketNumber, ticketData) {
    if (!db || !ticketData || typeof ticketData !== 'object') return;
    const polygon = ticketData.polygon;
    if (!hasDisplayablePolygon(polygon)) return;
    const ownerOrgId =
        ticketData.organizationId != null
            ? Number(ticketData.organizationId)
            : orgId != null
              ? Number(orgId)
              : NaN;
    if (!Number.isFinite(ownerOrgId)) return;
    const tn = ticketNumber || ticketData.ticketNumber || ticketData.ticketNumberFull;
    await propagateDigSitePolygonToBaseTickets(db, ownerOrgId, tn, polygon);
}

async function recomputeTicketPhotoStatsForBase(db, orgId, ticketBaseNumber) {
    const { recomputeTicketIds } = require('./ticketPhotoIntersection.cjs');
    const ids = await listTicketIdsForBase(db, orgId, ticketBaseNumber);
    if (!ids.length) return { processed: [], remaining: [] };
    return recomputeTicketIds(db, orgId, ids);
}

module.exports = {
    listTicketIdsForBase,
    propagateDigSitePolygonToBaseTickets,
    syncDigSitePolygonAfterPersist,
    recomputeTicketPhotoStatsForBase,
    hasDisplayablePolygon,
};
