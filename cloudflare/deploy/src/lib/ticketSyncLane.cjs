/**
 * Persisted sync lane for sibling refresh fanout (see tickets.sync_lane).
 */
const SYNC_LANE_POSR_PUBLIC = 'posr_public';
const SYNC_LANE_NGEN_PRIMARY = 'ngen_primary';

/**
 * @param {object|null|undefined} row
 * @returns {string}
 */
function syncLaneFromTicketRow(row) {
    if (!row || row.sync_lane == null || String(row.sync_lane).trim() === '') {
        return SYNC_LANE_NGEN_PRIMARY;
    }
    return String(row.sync_lane).trim();
}

module.exports = {
    SYNC_LANE_POSR_PUBLIC,
    SYNC_LANE_NGEN_PRIMARY,
    syncLaneFromTicketRow,
};
