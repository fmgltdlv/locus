/**
 * Ticket Hub analytics queries (Phase 1). Read-only D1 aggregates.
 * Code lists must stay in sync with computeWorkflowStatus.ts.
 */

const { allRows } = require('./db.cjs');
const { pacificYmd, addDaysToYmd, pacificYmdHmToUtcMs } = require('./pacificTime.cjs');

/** @type {readonly string[]} */
const ACK_BLOCKING_OPERATOR_CODES = [
    '000',
    '888',
    '999',
    '014',
    '050',
    '020',
    '021',
    '024',
    '052',
    '054',
    '041',
    '042',
    '555',
];

/** @type {readonly string[]} */
const NOT_READY_CODES = [
    '000',
    '888',
    '999',
    '014',
    '050',
    '020',
    '021',
    '024',
    '052',
    '054',
    '041',
    '042',
    '080',
    '555',
];

const LATE_RESPONSE_CODE = '999';
const ANALYTICS_RANGE_MAX_DAYS = 366;
const ANALYTICS_DEFAULT_RANGE_DAYS = 90;

const TICKET_ANALYTICS_SELECT = `id, organization_id, ticket_number, ticket_expires_at, lodged_on, commencement_date,
    created_at, updated_at, revision, ngen_enquiry_status, current_ngen_enquiry_status,
    required_response_count, received_response_count, sync_lane, user_reference`;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatYmd(date) {
    return pacificYmd(date || new Date());
}

function isValidCalendarDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * @param {string|undefined|null} dateFieldRaw
 * @returns {'lodged_on'|'expires_at'}
 */
function normalizeAnalyticsDateField(dateFieldRaw) {
    const v = String(dateFieldRaw || 'lodged_on').trim().toLowerCase();
    return v === 'expires_at' || v === 'expiration' ? 'expires_at' : 'lodged_on';
}

/**
 * @param {string|undefined|null} fromRaw
 * @param {string|undefined|null} toRaw
 * @param {string|undefined|null} dateFieldRaw
 * @returns {{ ok: true, from: string, to: string, dateField: 'lodged_on'|'expires_at' } | { ok: false, error: string }}
 */
function parseAnalyticsDateRange(fromRaw, toRaw, dateFieldRaw) {
    const dateField = normalizeAnalyticsDateField(dateFieldRaw);
    const now = new Date();
    const defaultTo = formatYmd(now);
    const defaultFrom = addDaysToYmd(defaultTo, -(ANALYTICS_DEFAULT_RANGE_DAYS - 1));

    let from = String(fromRaw || '').trim();
    let to = String(toRaw || '').trim();
    if (!from) from = defaultFrom;
    if (!to) to = defaultTo;

    if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
        return { ok: false, error: 'from and to must be YYYY-MM-DD' };
    }
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
        return { ok: false, error: 'Invalid date range: from must be on or before to' };
    }
    const spanDays = Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > ANALYTICS_RANGE_MAX_DAYS) {
        return { ok: false, error: `Date range cannot exceed ${ANALYTICS_RANGE_MAX_DAYS} days` };
    }
    return { ok: true, from, to, dateField };
}

/**
 * @param {'lodged_on'|'expires_at'} dateField
 */
function analyticsDateColumn(dateField) {
    return dateField === 'expires_at' ? 'ticket_expires_at' : 'lodged_on';
}

/**
 * @param {'lodged_on'|'expires_at'} dateField
 */
function analyticsDateRangeSqlPredicate(dateField) {
    const col = analyticsDateColumn(dateField);
    if (dateField === 'expires_at') {
        return `(${col} IS NOT NULL) AND TRIM(COALESCE(${col}, '')) != '' AND (${col} >= ?) AND (${col} < ?)`;
    }
    const jd = `julianday(TRIM(${col}))`;
    return `(${jd} IS NOT NULL) AND (${jd} >= julianday(?)) AND (${jd} < julianday(?) + 1)`;
}

function analyticsDateRangeBinds(range) {
    if (range.dateField === 'expires_at') {
        return [
            new Date(pacificYmdHmToUtcMs(range.from, 0, 0, 0)).toISOString(),
            new Date(pacificYmdHmToUtcMs(addDaysToYmd(range.to, 1), 0, 0, 0)).toISOString(),
        ];
    }
    return [range.from, range.to];
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{ from: string, to: string, dateField: 'lodged_on'|'expires_at' }} range
 */
async function loadAnalyticsTicketRows(db, orgId, range) {
    const predicate = analyticsDateRangeSqlPredicate(range.dateField);
    const binds = analyticsDateRangeBinds(range);
    return allRows(
        db,
        `SELECT ${TICKET_ANALYTICS_SELECT}
         FROM tickets
         WHERE organization_id = ?
           AND (${predicate})
         ORDER BY updated_at DESC`,
        [orgId, ...binds]
    );
}

function normalizeResponseCount(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : null;
}

function isRenewalEnquiryStatus(row) {
    const raw =
        row.ngen_enquiry_status != null
            ? String(row.ngen_enquiry_status).trim()
            : row.provider_enquiry_status != null
              ? String(row.provider_enquiry_status).trim()
              : row.current_ngen_enquiry_status != null
                ? String(row.current_ngen_enquiry_status).trim()
                : '';
    return raw.toUpperCase() === 'RNEW';
}

function ticketPendingByCountRule(row, renewalAckWaivers = false) {
    if (isRenewalEnquiryStatus(row) && renewalAckWaivers) return false;
    const lane = row.sync_lane != null ? String(row.sync_lane).trim().toLowerCase() : '';
    if (lane === 'posr_public') return false;
    const required = normalizeResponseCount(row.required_response_count);
    const received = normalizeResponseCount(row.received_response_count);
    if (required == null || received == null) return true;
    return received < required;
}

function incrementByCode(map, code) {
    const key = code && String(code).trim() ? String(code).trim() : 'unknown';
    map[key] = (map[key] || 0) + 1;
}

/**
 * @param {Map<number, Array<Record<string, unknown>>>} operatorMap
 * @param {number} ticketId
 */
function operatorRowsForTicket(operatorMap, ticketId) {
    const rows = operatorMap.get(Number(ticketId));
    return Array.isArray(rows) ? rows : [];
}

/**
 * @param {Array<Record<string, unknown>>} opRows
 */
function ticketHasAckBlockerCodes(opRows) {
    for (const row of opRows) {
        const code = row.status_code != null ? String(row.status_code).trim() : '';
        if (ACK_BLOCKING_OPERATOR_CODES.includes(code)) return true;
    }
    return false;
}

/**
 * @param {Array<Record<string, unknown>>} opRows
 */
function pendingUtilityCodesOnTicket(opRows) {
    /** @type {Set<string>} */
    const codes = new Set();
    for (const row of opRows) {
        const code = row.status_code != null ? String(row.status_code).trim() : '';
        if (NOT_READY_CODES.includes(code)) codes.add(code);
    }
    return codes;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{ from: string, to: string, dateField: 'lodged_on'|'expires_at' }} range
 * @param {Record<string, unknown>} ackMap
 * @param {(ticket: Record<string, unknown>, ackMap: Record<string, unknown>) => string} computeStatus
 * @param {{ renewalAckWaivers?: boolean }} [opts]
 */
async function buildAnalyticsSummary(db, orgId, range, ackMap, computeStatus, opts = {}) {
    const renewalAckWaivers = opts.renewalAckWaivers === true;
    const rows = await loadAnalyticsTicketRows(db, orgId, range);
    const ticketIds = (rows || []).map((r) => r.id).filter((id) => id != null);
    const operatorMap = await loadOperatorResponsesForTicketIds(db, ticketIds);

    /** @type {Record<string, number>} */
    const statusBreakdown = {
        READY: 0,
        NOT_READY: 0,
        ACTION_REQUIRED: 0,
        EXPIRING_SOON: 0,
        EXPIRED: 0,
        CANCELLED: 0,
    };

    /** @type {Record<string, number>} */
    const ackBlockerByCode = {};
    /** @type {Record<string, number>} */
    const pendingUtilityByCode = {};
    /** @type {Record<string, number>} */
    const lateByCode = {};

    const ackBlockerTicketIds = new Set();
    const pendingUtilityTicketIds = new Set();
    const lateTicketIds = new Set();

    let activeCount = 0;
    let responseComplete = 0;
    let responsePartial = 0;
    let responseNone = 0;

    for (const row of rows || []) {
        const opRows = operatorRowsForTicket(operatorMap, row.id);
        const ticket = rowToAnalyticsTicket(row, opRows);
        const status = computeStatus(ticket, ackMap);
        if (Object.prototype.hasOwnProperty.call(statusBreakdown, status)) {
            statusBreakdown[status]++;
        }
        if (status !== 'EXPIRED' && status !== 'CANCELLED') {
            activeCount++;
        }

        const required = normalizeResponseCount(row.required_response_count);
        const received = normalizeResponseCount(row.received_response_count);
        if (required != null && received != null) {
            if (received >= required) responseComplete++;
            else if (received > 0) responsePartial++;
            else responseNone++;
        } else if (opRows.length > 0) {
            responseComplete++;
        } else {
            responseNone++;
        }

        let hasAckBlocker = false;
        const waiveAckBlockers = isRenewalEnquiryStatus(row) && renewalAckWaivers;
        for (const op of opRows) {
            const code = op.status_code != null ? String(op.status_code).trim() : '';
            if (ACK_BLOCKING_OPERATOR_CODES.includes(code)) {
                if (!waiveAckBlockers) {
                    hasAckBlocker = true;
                    incrementByCode(ackBlockerByCode, code);
                }
            }
            if (NOT_READY_CODES.includes(code)) {
                incrementByCode(pendingUtilityByCode, code);
            }
            if (code === LATE_RESPONSE_CODE) {
                incrementByCode(lateByCode, code);
                lateTicketIds.add(row.id);
            }
        }
        if (hasAckBlocker) ackBlockerTicketIds.add(row.id);

        const pendingCodes = pendingUtilityCodesOnTicket(opRows);
        const pendingByCount = ticketPendingByCountRule(row, renewalAckWaivers);
        if (pendingCodes.size > 0 || pendingByCount) {
            pendingUtilityTicketIds.add(row.id);
        }
    }

    return {
        range,
        ticketCount: (rows || []).length,
        activeCount,
        statusBreakdown,
        ackBlockers: {
            ticketCount: ackBlockerTicketIds.size,
            byCode: ackBlockerByCode,
        },
        pendingUtility: {
            ticketCount: pendingUtilityTicketIds.size,
            byCode: pendingUtilityByCode,
            byCountRule: [...pendingUtilityTicketIds].filter((id) => {
                const row = (rows || []).find((r) => r.id === id);
                return row ? ticketPendingByCountRule(row, renewalAckWaivers) : false;
            }).length,
        },
        lateResponses: {
            ticketCount: lateTicketIds.size,
            byCode999: lateByCode[LATE_RESPONSE_CODE] || 0,
        },
        responseProgress: {
            complete: responseComplete,
            partial: responsePartial,
            none: responseNone,
        },
        ticketIds,
    };
}

function rowToAnalyticsTicket(row, opRows) {
    return {
        id: row.id,
        ticketNumber: row.ticket_number,
        ticket_number: row.ticket_number,
        revision: row.revision,
        organizationId: row.organization_id,
        ngenEnquiryStatus: row.ngen_enquiry_status,
        currentNgenEnquiryStatus: row.current_ngen_enquiry_status,
        ngenRequiredResponseCount: row.required_response_count,
        ngenReceivedResponseCount: row.received_response_count,
        sync_lane: row.sync_lane,
        syncLane: row.sync_lane,
        operatorResponses: opRows.map((r) => ({
            statusCode: r.status_code,
            status_code: r.status_code,
            stationCode: r.station_code,
            operatorName: r.operator_name,
            respondedAt: r.responded_at,
        })),
        endTime: row.ticket_expires_at,
        ticketExpirationDate: row.ticket_expires_at,
        lodged_on: row.lodged_on,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{ from: string, to: string, dateField: 'lodged_on'|'expires_at' }} range
 * @param {'blockers'|'pending-utility'|'late'} kind
 * @param {number} [limit]
 * @param {{ renewalAckWaivers?: boolean }} [opts]
 */
async function listAnalyticsTicketsByKind(db, orgId, range, kind, limit = 100, opts = {}) {
    const renewalAckWaivers = opts.renewalAckWaivers === true;
    const rows = await loadAnalyticsTicketRows(db, orgId, range);
    const ticketIds = (rows || []).map((r) => r.id).filter((id) => id != null);
    const operatorMap = await loadOperatorResponsesForTicketIds(db, ticketIds);

    /** @type {Array<Record<string, unknown>>} */
    const matches = [];

    for (const row of rows || []) {
        const opRows = operatorRowsForTicket(operatorMap, row.id);
        let include = false;
        /** @type {string[]} */
        const codes = [];

        if (kind === 'blockers') {
            const waiveAckBlockers = isRenewalEnquiryStatus(row) && renewalAckWaivers;
            if (!waiveAckBlockers) {
                for (const op of opRows) {
                    const code = op.status_code != null ? String(op.status_code).trim() : '';
                    if (ACK_BLOCKING_OPERATOR_CODES.includes(code)) {
                        include = true;
                        if (!codes.includes(code)) codes.push(code);
                    }
                }
            }
        } else if (kind === 'pending-utility') {
            for (const op of opRows) {
                const code = op.status_code != null ? String(op.status_code).trim() : '';
                if (NOT_READY_CODES.includes(code)) {
                    include = true;
                    if (!codes.includes(code)) codes.push(code);
                }
            }
            if (ticketPendingByCountRule(row, renewalAckWaivers)) include = true;
        } else if (kind === 'late') {
            for (const op of opRows) {
                const code = op.status_code != null ? String(op.status_code).trim() : '';
                if (code === LATE_RESPONSE_CODE) {
                    include = true;
                    codes.push(code);
                }
            }
        }

        if (!include) continue;
        matches.push({
            ticketId: row.id,
            ticketNumber: row.ticket_number,
            revision: row.revision,
            lodgedOn: row.lodged_on,
            expiresAt: row.ticket_expires_at,
            codes,
            operators: opRows
                .filter((op) => {
                    const code = op.status_code != null ? String(op.status_code).trim() : '';
                    if (kind === 'blockers') return ACK_BLOCKING_OPERATOR_CODES.includes(code);
                    if (kind === 'pending-utility') return NOT_READY_CODES.includes(code);
                    if (kind === 'late') return code === LATE_RESPONSE_CODE;
                    return false;
                })
                .map((op) => ({
                    stationCode: op.station_code,
                    operatorName: op.operator_name,
                    statusCode: op.status_code,
                    respondedAt: op.responded_at,
                })),
        });
        if (matches.length >= limit) break;
    }

    return { tickets: matches, total: matches.length };
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number[]} ticketIds
 */
async function loadOperatorResponsesForTicketIds(db, ticketIds) {
    const map = new Map();
    const ids = (ticketIds || []).filter((id) => id != null && Number.isFinite(Number(id))).map((id) => Number(id));
    if (ids.length === 0) return map;
    const CHUNK = 80;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allRows(
            db,
            `SELECT ticket_id, station_code, operator_name, operator_code, status_code, operator_status, responded_at
             FROM ticket_operator_responses
             WHERE ticket_id IN (${placeholders})
             ORDER BY ticket_id ASC, response_index ASC, id ASC`,
            chunk
        );
        for (const row of rows || []) {
            const tid = Number(row.ticket_id);
            if (!map.has(tid)) map.set(tid, []);
            map.get(tid).push(row);
        }
    }
    return map;
}

/**
 * @param {Record<string, number>} byCode
 */
function rollupOperatorCodes(byCode) {
    return Object.entries(byCode || {})
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function escapeCsvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/**
 * @param {Record<string, unknown>} summary
 */
function summaryToCsv(summary) {
    const lines = ['section,key,value'];
    lines.push(`meta,ticketCount,${summary.ticketCount}`);
    lines.push(`meta,activeCount,${summary.activeCount}`);
    lines.push(`meta,from,${summary.range.from}`);
    lines.push(`meta,to,${summary.range.to}`);
    lines.push(`meta,dateField,${summary.range.dateField}`);
    for (const [status, count] of Object.entries(summary.statusBreakdown || {})) {
        lines.push(`status,${escapeCsvCell(status)},${count}`);
    }
    for (const [code, count] of Object.entries((summary.ackBlockers && summary.ackBlockers.byCode) || {})) {
        lines.push(`ack_blocker,${escapeCsvCell(code)},${count}`);
    }
    for (const [code, count] of Object.entries((summary.pendingUtility && summary.pendingUtility.byCode) || {})) {
        lines.push(`pending_utility,${escapeCsvCell(code)},${count}`);
    }
    lines.push(`late,code_999,${(summary.lateResponses && summary.lateResponses.byCode999) || 0}`);
    return lines.join('\n') + '\n';
}

module.exports = {
    ACK_BLOCKING_OPERATOR_CODES,
    NOT_READY_CODES,
    LATE_RESPONSE_CODE,
    analyticsDateRangeSqlPredicate,
    parseAnalyticsDateRange,
    loadAnalyticsTicketRows,
    loadOperatorResponsesForTicketIds,
    buildAnalyticsSummary,
    listAnalyticsTicketsByKind,
    rollupOperatorCodes,
    summaryToCsv,
};
