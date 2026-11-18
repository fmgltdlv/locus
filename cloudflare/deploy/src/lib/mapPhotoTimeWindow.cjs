const { allRows } = require('./db.cjs');
const ticketBuilder = require('./ticketBuilder.cjs');
const {
    ensurePosrRev000HistorySlice,
    findPosrRev000LodgeIso,
    isPosrPublicTicket,
} = require('./photoRequirementCutoff.cjs');

const MAP_LOOKBACK_BASE_DAYS = 90;
const MAP_LOOKBACK_DAYS_PER_REVISION = 28;

function parseRevisionSuffixInt(revisionSuffix) {
    if (revisionSuffix == null || String(revisionSuffix).trim() === '') return 0;
    const n = parseInt(String(revisionSuffix).replace(/^0+/, '') || '0', 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * @param {string} ticketNumber
 * @returns {string}
 */
function ticketBaseFromNumber(ticketNumber) {
    const parts = ticketBuilder.parseTicketNumberParts(ticketNumber);
    return parts.baseNumber || String(ticketNumber || '').split('-')[0] || '';
}

/**
 * Load earliest revision row for a ticket base in org.
 * @returns {Promise<{ lodged_on?: string, ticket_number?: string, revision?: string|null }|null>}
 */
async function loadAnchorRevisionRow(db, orgId, baseNumber) {
    if (!baseNumber) return null;
    const rows = await allRows(
        db,
        `SELECT ticket_number, revision, lodged_on, ticket_expires_at, created_at
         FROM tickets
         WHERE organization_id = ?
           AND (
             ticket_number = ?
             OR ticket_number = ?
             OR ticket_number LIKE ?
           )
         ORDER BY
           CASE WHEN ticket_number LIKE '%-000' THEN 0 ELSE 1 END,
           revision ASC NULLS LAST,
           ticket_number ASC
         LIMIT 20`,
        [orgId, baseNumber, `${baseNumber}-000`, `${baseNumber}-%`]
    );
    if (!rows || !rows.length) return null;
    const exact000 = rows.find((r) => String(r.ticket_number || '').endsWith('-000'));
    return exact000 || rows[0];
}

/**
 * Resolve lookback anchor ISO for map photos.
 * Prefer tickets.lodged_on on the earliest/000 anchor row; else POSR rev-000 lodge proxies
 * (same helpers as photo requirement). Does not use per-revision photoRequirementCutoffIso.
 *
 * @param {object} db
 * @param {number} orgId
 * @param {object} ticketLike
 * @param {{ lodged_on?: string }|null} anchorRow
 * @returns {Promise<{ iso: string|null, source: 'tickets_lodged_on'|'posr_rev_000_lodge'|'posr_unknown'|'pending' }>}
 */
async function resolveMapPhotoAnchorIso(db, orgId, ticketLike, anchorRow) {
    const lodgedRaw = anchorRow && anchorRow.lodged_on != null ? String(anchorRow.lodged_on).trim() : '';
    if (lodgedRaw) {
        const ms = new Date(lodgedRaw).getTime();
        if (Number.isFinite(ms)) {
            return { iso: new Date(ms).toISOString(), source: 'tickets_lodged_on' };
        }
    }

    const ticket = ticketLike && typeof ticketLike === 'object' ? ticketLike : {};
    if (isPosrPublicTicket(ticket)) {
        await ensurePosrRev000HistorySlice(db, ticket);
        const posrIso = findPosrRev000LodgeIso(ticket);
        if (posrIso) {
            return { iso: posrIso, source: 'posr_rev_000_lodge' };
        }
        return { iso: null, source: 'posr_unknown' };
    }

    return { iso: null, source: 'pending' };
}

/**
 * @param {object} db
 * @param {number} orgId
 * @param {{
 *   ticketNumber?: string,
 *   ticket_number?: string,
 *   ticketRevision?: string|null,
 *   revision?: string|null,
 *   ticket_expires_at?: string|null,
 *   id?: number|string,
 *   syncLane?: string,
 *   history?: object[],
 *   startTime?: string,
 *   legalStartDate?: string,
 *   commencementDate?: string,
 * }} ticketLike
 * @returns {Promise<{ fromMs: number|null, toMs: number|null, pending: boolean, anchorSource?: string }>}
 */
async function getMapPhotoTimeWindow(db, orgId, ticketLike) {
    const ticketNumber = (ticketLike && (ticketLike.ticketNumber || ticketLike.ticket_number)) || '';
    const base = ticketBaseFromNumber(ticketNumber);
    if (!base) return { fromMs: null, toMs: null, pending: true, anchorSource: 'pending' };

    const anchorRow = await loadAnchorRevisionRow(db, orgId, base);
    const { iso: anchorIso, source: anchorSource } = await resolveMapPhotoAnchorIso(
        db,
        orgId,
        ticketLike || {},
        anchorRow
    );

    if (anchorSource === 'pending') {
        return { fromMs: null, toMs: null, pending: true, anchorSource };
    }

    const parts = ticketBuilder.parseTicketNumberParts(ticketNumber);
    const revSuffix =
        parts.revisionSuffix != null
            ? parts.revisionSuffix
            : ticketLike.ticketRevision != null
              ? String(ticketLike.ticketRevision)
              : ticketLike.revision != null
                ? String(ticketLike.revision)
                : null;
    const n = parseRevisionSuffixInt(revSuffix);
    const lookbackDays = MAP_LOOKBACK_BASE_DAYS + MAP_LOOKBACK_DAYS_PER_REVISION * n;

    let fromMs = null;
    if (anchorIso) {
        const lodgedMs = new Date(anchorIso).getTime();
        if (!Number.isFinite(lodgedMs)) {
            return { fromMs: null, toMs: null, pending: true, anchorSource: 'pending' };
        }
        fromMs = lodgedMs - lookbackDays * 24 * 60 * 60 * 1000;
    }

    let toMs = Date.now();
    const expiresRaw = ticketLike.ticket_expires_at;
    if (expiresRaw != null && String(expiresRaw).trim() !== '') {
        const exp = new Date(expiresRaw).getTime();
        if (Number.isFinite(exp)) toMs = exp;
    }

    return { fromMs, toMs, pending: false, anchorSource };
}

function photoCreatedMs(createdAt) {
    if (createdAt == null) return null;
    const ms = new Date(createdAt).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function photoInMapWindow(createdAt, window) {
    if (!window || window.pending) return false;
    const ms = photoCreatedMs(createdAt);
    if (ms == null) return false;
    if (window.fromMs != null && ms < window.fromMs) return false;
    if (window.toMs != null && ms > window.toMs) return false;
    return true;
}

module.exports = {
    MAP_LOOKBACK_BASE_DAYS,
    MAP_LOOKBACK_DAYS_PER_REVISION,
    ticketBaseFromNumber,
    loadAnchorRevisionRow,
    resolveMapPhotoAnchorIso,
    getMapPhotoTimeWindow,
    photoInMapWindow,
    photoCreatedMs,
};
