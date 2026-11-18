const { runDb } = require('./db.cjs');
const {
    UPDATE_TICKET_DATA_AND_USER_SQL,
    buildUpdateTicketDataAndUserParams,
    UPDATE_TICKET_DATA_SQL,
    buildUpdateTicketDataParams,
} = require('./ticketIndexedColumns.cjs');
const { applyPosrDerivedResponseCounts } = require('./ticketBuilder.cjs');
const { syncTicketStructuredRows, syncTicketStructuredRowsAfterPollMerge } = require('./ticketStructuredRows.cjs');
const { afterTicketPersistMaybeReopenProject } = require('./jobProjectLifecycle.cjs');
const { syncDigSitePolygonAfterPersist, hasDisplayablePolygon } = require('./ticketBaseGeometry.cjs');

function polygonFingerprint(ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return '';
    try {
        return JSON.stringify(ticketData.polygon ?? null);
    } catch (_) {
        return '';
    }
}

function shouldSyncGeometry(prev, next) {
    if (!next || !hasDisplayablePolygon(next.polygon)) return false;
    if (!prev) return true;
    return polygonFingerprint(prev) !== polygonFingerprint(next);
}

/**
 * Single ticket row persist: UPDATE indexed columns + conditional structured child sync + optional geometry.
 * When prev/next are provided, skips DELETE-heavy child sync when structured payloads are unchanged.
 */
async function persistTicketRowAfterDataChange(db, opts) {
    const {
        ticketId,
        orgId = null,
        ticketNumber = null,
        stripped,
        prev = null,
        next = null,
        stampFullDetailRefreshedAt = null,
        skipGeometry = false,
        skipRowUpdate = false,
        userId = null,
    } = opts;

    const id = Number(ticketId);
    if (!Number.isFinite(id) || !stripped || typeof stripped !== 'object') {
        throw new Error('persistTicketRowAfterDataChange: invalid ticketId or stripped');
    }

    const toStore = { ...stripped };
    applyPosrDerivedResponseCounts(toStore);
    if (stampFullDetailRefreshedAt) {
        toStore.ngenFullDetailRefreshedAt = stampFullDetailRefreshedAt;
    }

    if (!skipRowUpdate) {
        if (userId != null) {
            await runDb(db, UPDATE_TICKET_DATA_AND_USER_SQL, buildUpdateTicketDataAndUserParams(toStore, userId, id));
        } else {
            await runDb(db, UPDATE_TICKET_DATA_SQL, buildUpdateTicketDataParams(toStore, id));
        }
    }

    const mergeNext = next != null ? next : toStore;
    if (prev != null && mergeNext != null) {
        await syncTicketStructuredRowsAfterPollMerge(db, id, prev, mergeNext, toStore);
    } else {
        await syncTicketStructuredRows(db, id, toStore);
    }

    if (orgId != null) {
        await afterTicketPersistMaybeReopenProject(db, orgId, toStore);
        try {
            const { syncMaxTierServiceRequest } = require('./syncMaxTierServiceRequest.cjs');
            await syncMaxTierServiceRequest(db, {
                orgId,
                ticket: toStore,
                prev,
            });
        } catch (err) {
            console.error('syncMaxTierServiceRequest after persist failed:', err);
        }
    }

    if (!skipGeometry && shouldSyncGeometry(prev, toStore)) {
        await syncDigSitePolygonAfterPersist(db, orgId, ticketNumber, toStore);
    }

    return toStore;
}

module.exports = {
    persistTicketRowAfterDataChange,
    shouldSyncGeometry,
    polygonFingerprint,
};
