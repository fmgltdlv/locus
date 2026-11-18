/**
 * Job project open/closed lifecycle helpers.
 */
const { runDb } = require('./db.cjs');
const { normalizeJobNameKey } = require('./jobComplianceDates.cjs');

const JOB_PROJECT_STATUS_OPEN = 'open';
const JOB_PROJECT_STATUS_CLOSED = 'closed';
const CLOSED_PROJECT_RANGE_MAX_DAYS = 366;

function isValidCalendarDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * Parse `from` / `to` for closed project archive (YYYY-MM-DD).
 * @returns {{ ok: true, from: string, to: string } | { ok: false, error: string }}
 */
function parseClosedProjectDateRange(fromRaw, toRaw) {
    const from = String(fromRaw || '').trim();
    const to = String(toRaw || '').trim();
    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
        return { ok: false, error: 'from and to are required as YYYY-MM-DD when status=closed' };
    }
    const fromMs = Date.parse(`${from}T00:00:00`);
    const toMs = Date.parse(`${to}T23:59:59.999`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
        return { ok: false, error: 'Invalid date range: from must be on or before to' };
    }
    const spanDays = Math.ceil((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > CLOSED_PROJECT_RANGE_MAX_DAYS) {
        return {
            ok: false,
            error: `Date range cannot exceed ${CLOSED_PROJECT_RANGE_MAX_DAYS} days`,
        };
    }
    return { ok: true, from, to };
}

function closedAtRangeSqlPredicate() {
    const jd = 'julianday(TRIM(closed_at))';
    return `(${jd} IS NOT NULL) AND (${jd} >= julianday(?)) AND (${jd} < julianday(?) + 1)`;
}

function mapProjectStatusFields(row) {
    if (!row) {
        return {
            status: JOB_PROJECT_STATUS_OPEN,
            closedAt: null,
            closedByDisplayName: null,
        };
    }
    const statusRaw = row.status != null ? String(row.status).trim().toLowerCase() : JOB_PROJECT_STATUS_OPEN;
    const status = statusRaw === JOB_PROJECT_STATUS_CLOSED ? JOB_PROJECT_STATUS_CLOSED : JOB_PROJECT_STATUS_OPEN;
    return {
        status,
        closedAt: row.closed_at || null,
        closedByDisplayName: row.closed_by_display_name || null,
    };
}

/**
 * Reopen a closed project when a ticket with matching user_reference is persisted.
 * @param {object} db
 * @param {number} orgId
 * @param {string|null|undefined} userReference
 */
async function maybeReopenJobProjectForUserReference(db, orgId, userReference) {
    const key = normalizeJobNameKey(userReference);
    if (!key || orgId == null) return;
    await runDb(
        db,
        `UPDATE job_misc_compliance
         SET status = ?,
             closed_at = NULL,
             closed_by_user_id = NULL,
             closed_by_display_name = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = ?
           AND job_name_normalized = ?
           AND status = ?`,
        [JOB_PROJECT_STATUS_OPEN, orgId, key, JOB_PROJECT_STATUS_CLOSED]
    );
}

/**
 * Call after any ticket persist that may set user_reference / ngenUserReference.
 * @param {object} db
 * @param {number} orgId
 * @param {object|null|undefined} ticketData
 */
async function afterTicketPersistMaybeReopenProject(db, orgId, ticketData) {
    if (!ticketData || typeof ticketData !== 'object' || orgId == null) return;
    const ref =
        ticketData.user_reference != null
            ? ticketData.user_reference
            : ticketData.ngenUserReference != null
              ? ticketData.ngenUserReference
              : null;
    if (ref == null || String(ref).trim() === '') return;
    await maybeReopenJobProjectForUserReference(db, orgId, ref);
}

/** @param {string|null|undefined} dateStr @param {string} fromYmd @param {string} toYmd */
function calendarDateInInclusiveRange(dateStr, fromYmd, toYmd) {
    if (!dateStr || !fromYmd || !toYmd) return false;
    const raw = String(dateStr).trim();
    let ymd = '';
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        ymd = raw.slice(0, 10);
    } else {
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) return false;
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        ymd = `${y}-${m}-${day}`;
    }
    return ymd >= fromYmd && ymd <= toYmd;
}

/** @param {...(string|null|undefined)} candidates */
function maxActivityTimestamp(...candidates) {
    let best = null;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const c of candidates) {
        if (c == null || String(c).trim() === '') continue;
        const ms = Date.parse(String(c));
        if (!Number.isNaN(ms) && ms > bestMs) {
            bestMs = ms;
            best = String(c);
        }
    }
    return best;
}

module.exports = {
    JOB_PROJECT_STATUS_OPEN,
    JOB_PROJECT_STATUS_CLOSED,
    CLOSED_PROJECT_RANGE_MAX_DAYS,
    parseClosedProjectDateRange,
    closedAtRangeSqlPredicate,
    mapProjectStatusFields,
    calendarDateInInclusiveRange,
    maxActivityTimestamp,
    maybeReopenJobProjectForUserReference,
    afterTicketPersistMaybeReopenProject,
};
