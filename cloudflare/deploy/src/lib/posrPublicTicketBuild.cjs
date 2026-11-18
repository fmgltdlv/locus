/**
 * Helpers for resolving how a ticket row is keyed when orgs store base vs full request numbers.
 * NV public POSR + map fetch/build live on the explicit import route in `routes/tickets.ts` (not PAC/nGen fallbacks).
 */
const { getRow } = require('./db.cjs');

const POSR_API_BASE =
    'https://appsnv.undergroundservicealert.org/posr/searchtool/PositiveResponse/GetJobsListForTable?format=json&ticketNumber=';
const MAP_URL_BASE = 'https://onecallnv.undergroundservicealert.org/ngen.web/map/index?RequestNumber=';

/**
 * @param {import('sqlite3').Database} db
 * @param {number} organizationId
 * @param {string} ticketBase
 * @param {string} [ticketFullRequestNumber]
 * @returns {Promise<string>}
 */
async function resolveTicketStorageKey(db, organizationId, ticketBase, ticketFullRequestNumber) {
    let row = await getRow(db, `SELECT ticket_number FROM tickets WHERE organization_id = ? AND ticket_number = ?`, [
        organizationId,
        ticketBase,
    ]);
    if (row && row.ticket_number) return row.ticket_number;
    const full = ticketFullRequestNumber && String(ticketFullRequestNumber).trim();
    if (full) {
        row = await getRow(db, `SELECT ticket_number FROM tickets WHERE organization_id = ? AND ticket_number = ?`, [
            organizationId,
            full,
        ]);
        if (row && row.ticket_number) return row.ticket_number;
    }
    row = await getRow(
        db,
        `SELECT ticket_number FROM tickets WHERE organization_id = ? AND ticket_number LIKE ? ORDER BY updated_at DESC LIMIT 1`,
        [organizationId, ticketBase + '-%']
    );
    if (row && row.ticket_number) return row.ticket_number;
    return ticketBase;
}

module.exports = {
    POSR_API_BASE,
    MAP_URL_BASE,
    resolveTicketStorageKey,
};
