import { getDatabase } from "../database.js";
import { canMutateOrganization } from "../auth.js";
import * as ticketBuilder from "../lib/ticketBuilder.cjs";
import { applyIndexedColumnsToTicketShape, ensureStubMapPinOnTicket } from "../lib/ticketIndexedColumns.cjs";
import { runDb, getRow, allRows } from "../lib/db.cjs";
import { getMembershipRole, isTechMembership } from "../lib/orgMembership.cjs";
import { applyPhotoRequirementFields, applyPhotoRequirementFieldsWithDb, loadEarliestPosr000IsoMap } from "../lib/photoRequirementCutoff.cjs";
import { attachSnapshotToTicket } from "../lib/ticketPhotoIntersection.cjs";
import { evaluateAckComplianceEvidence, getWorkflowAckCompliancePolicy, DEFAULT_EXPIRING_SOON_DAYS } from "../lib/workflowAckCompliance.cjs";
import * as ticketSyncLane from "../lib/ticketSyncLane.cjs";
import {
    buildWorkflowAckMapFromDbRows,
    computeWorkflowStatusForTicket,
    inferNgenSearchStubFromTicket,
} from "./computeWorkflowStatus.js";

const WORKFLOW_ACK_SELECT = `SELECT ticket_number, revision, note, photos_met, acknowledged_at, acknowledged_by_name, acknowledged_by_user_id
                               FROM ticket_workflow_acks WHERE organization_id = ?`;

/** Columns needed for list/detail responses and indexed-field overlay */
export const TICKET_ROW_SELECT = `id, organization_id, ticket_number, min_lng, min_lat, max_lng, max_lat, pin_lng, pin_lat, work_description, ticket_expires_at, address, polygon_json, ngen_job_number, ngen_enquiry_status, lodged_by_user_name, schema_version, revision, job_number, previous_ticket_number, current_ngen_enquiry_status, lodged_on, ngen_last_updated_time, original_lodged_by_user_name, current_lodged_by_user_name, commencement_date, work_legal_start_date, full_address, city, state, county, zipcode, nearest_cross_street, ngen_ticket_type, category_of_work, work_activity, excavation_method, excavation_depth, working_on_behalf, working_on_behalf_of_auth, user_reference, scope_of_work, priority, principal_contact_name, principal_contact_phone, required_response_count, received_response_count, is_boring, is_blasting, can_be_amended, can_be_no_response, can_be_remark, can_be_damage, can_be_renewal, can_be_exposed, can_be_follow_up, can_be_disputed, created_by, ngen_full_detail_refreshed_at, sync_lane, created_at, updated_at`;
/** Same columns with `t.` prefix for JOIN queries */
export const TICKET_ROW_SELECT_T = `t.id, t.organization_id, t.ticket_number, t.min_lng, t.min_lat, t.max_lng, t.max_lat, t.pin_lng, t.pin_lat, t.work_description, t.ticket_expires_at, t.address, t.polygon_json, t.ngen_job_number, t.ngen_enquiry_status, t.lodged_by_user_name, t.schema_version, t.revision, t.job_number, t.previous_ticket_number, t.current_ngen_enquiry_status, t.lodged_on, t.ngen_last_updated_time, t.original_lodged_by_user_name, t.current_lodged_by_user_name, t.commencement_date, t.work_legal_start_date, t.full_address, t.city, t.state, t.county, t.zipcode, t.nearest_cross_street, t.ngen_ticket_type, t.category_of_work, t.work_activity, t.excavation_method, t.excavation_depth, t.working_on_behalf, t.working_on_behalf_of_auth, t.user_reference, t.scope_of_work, t.priority, t.principal_contact_name, t.principal_contact_phone, t.required_response_count, t.received_response_count, t.is_boring, t.is_blasting, t.can_be_amended, t.can_be_no_response, t.can_be_remark, t.can_be_damage, t.can_be_renewal, t.can_be_exposed, t.can_be_follow_up, t.can_be_disputed, t.created_by, t.ngen_full_detail_refreshed_at, t.sync_lane, t.created_at, t.updated_at`;
/** Summary/active list: pins + bbox + indexed fields — no polygon_json (geometry loaded on demand). */
export const TICKET_ROW_SELECT_LEAN = `id, organization_id, ticket_number, min_lng, min_lat, max_lng, max_lat, pin_lng, pin_lat, work_description, ticket_expires_at, address, ngen_job_number, ngen_enquiry_status, lodged_by_user_name, schema_version, revision, job_number, previous_ticket_number, current_ngen_enquiry_status, lodged_on, ngen_last_updated_time, original_lodged_by_user_name, current_lodged_by_user_name, commencement_date, work_legal_start_date, full_address, city, state, county, zipcode, nearest_cross_street, ngen_ticket_type, category_of_work, work_activity, excavation_method, excavation_depth, working_on_behalf, working_on_behalf_of_auth, user_reference, scope_of_work, priority, principal_contact_name, principal_contact_phone, required_response_count, received_response_count, is_boring, is_blasting, can_be_amended, can_be_no_response, can_be_remark, can_be_damage, can_be_renewal, can_be_exposed, can_be_follow_up, can_be_disputed, created_by, ngen_full_detail_refreshed_at, sync_lane, created_at, updated_at`;

/**
 * SQL predicate: ticket row is not expired for list purposes — no date, unparseable date, or expiry after "now".
 * Forgiving on bad/missing values (same spirit as `ticketBuilder.isTicketExpired` false for empty/invalid parse).
 * @param expiresCol Column or alias, e.g. `ticket_expires_at` or `t.ticket_expires_at`.
 */
export function ticketActiveListSqlPredicate(expiresCol = 'ticket_expires_at'): string {
    const c = expiresCol;
    const jd = `julianday(TRIM(${c}))`;
    return `(
        (${c} IS NULL OR TRIM(COALESCE(${c}, '')) = '')
        OR (${jd} IS NULL)
        OR (${jd} > julianday('now'))
        )`;
}

/**
 * SQL predicate: ticket is definitively past expiry (parsable expiry and not after now).
 * Inverse of typical "active" list rows; omits blank/unparseable expiries.
 * @param expiresCol Column or alias, e.g. `ticket_expires_at`.
 */
export function ticketExpiredListSqlPredicate(expiresCol = 'ticket_expires_at'): string {
    const c = expiresCol;
    const jd = `julianday(TRIM(${c}))`;
    return `${c} IS NOT NULL AND TRIM(COALESCE(${c}, '')) != '' AND (${jd} IS NOT NULL) AND (${jd} <= julianday('now'))`;
}

/** SQL predicate: upstream nGen enquiry status is Cancelled (indexed columns). */
export function ticketCancelledListSqlPredicate(): string {
    return `LOWER(TRIM(COALESCE(NULLIF(TRIM(current_ngen_enquiry_status), ''), NULLIF(TRIM(ngen_enquiry_status), ''), ''))) = 'cancelled'`;
}

const HUB_DATE_FIELD_VALUES = new Set(['expiration', 'job_start', 'legal_start']);
const HUB_EXPIRED_RANGE_MAX_DAYS = 366;

/** @returns {'expiration'|'job_start'|'legal_start'} */
export function normalizeHubListDateField(dateField) {
    const v = String(dateField || 'expiration').trim().toLowerCase();
    return HUB_DATE_FIELD_VALUES.has(v) ? v : 'expiration';
}

/** SQL expression for hub timeframe filtering (no table alias). */
export function ticketHubFilterDateSqlExpr(dateField) {
    const f = normalizeHubListDateField(dateField);
    if (f === 'legal_start') return 'work_legal_start_date';
    if (f === 'job_start') return `COALESCE(NULLIF(TRIM(commencement_date), ''), created_at)`;
    return 'ticket_expires_at';
}

/**
 * Inclusive calendar-date range on the hub filter date column.
 * `from`/`to` binds are YYYY-MM-DD. `julianday('YYYY-MM-DD')` is midnight, so the
 * upper bound is the next day exclusive (`< julianday(to) + 1`) rather than
 * `<= julianday(to)`, which would drop same-day datetimes after 00:00
 * (e.g. Nevada 23:59 Pacific stored as `…T06:59:59.000Z`).
 */
export function ticketHubDateRangeSqlPredicate(dateField) {
    const col = ticketHubFilterDateSqlExpr(dateField);
    const jd = `julianday(TRIM(${col}))`;
    return `(${jd} IS NOT NULL) AND (${jd} >= julianday(?)) AND (${jd} < julianday(?) + 1)`;
}

/** @param {string} s */
function isValidHubCalendarDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * Parse `from` / `to` for expired hub list (YYYY-MM-DD). Caps span at {@link HUB_EXPIRED_RANGE_MAX_DAYS}.
 * @returns {{ ok: true, from: string, to: string, dateField: string } | { ok: false, error: string }}
 */
export function parseHubExpiredListDateRange(fromRaw, toRaw, dateFieldRaw) {
    const from = String(fromRaw || '').trim();
    const to = String(toRaw || '').trim();
    const dateField = normalizeHubListDateField(dateFieldRaw);
    if (!isValidHubCalendarDate(from) || !isValidHubCalendarDate(to)) {
        return { ok: false, error: 'from and to are required as YYYY-MM-DD when expiredOnly=1' };
    }
    const fromMs = Date.parse(`${from}T00:00:00`);
    const toMs = Date.parse(`${to}T00:00:00`);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
        return { ok: false, error: 'Invalid date range: from must be on or before to' };
    }
    const spanDays = Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > HUB_EXPIRED_RANGE_MAX_DAYS) {
        return { ok: false, error: `Date range cannot exceed ${HUB_EXPIRED_RANGE_MAX_DAYS} days` };
    }
    return { ok: true, from, to, dateField };
}

/** @param {object} row */
export function hubFilterDateValueFromRow(row, dateField) {
    if (!row) return '';
    const f = normalizeHubListDateField(dateField);
    if (f === 'legal_start') {
        return row.work_legal_start_date != null ? String(row.work_legal_start_date).trim() : '';
    }
    if (f === 'job_start') {
        const comm = row.commencement_date != null ? String(row.commencement_date).trim() : '';
        if (comm) return comm;
        return row.created_at != null ? String(row.created_at).trim() : '';
    }
    return row.ticket_expires_at != null ? String(row.ticket_expires_at).trim() : '';
}

/** D1 enforces a low cap on bound parameters per statement (~100); chunk large `IN (...)` lists. */
const D1_SAFE_IN_CHUNK = 99;

export function getTicketExpirationDateForFilter(ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return null;
    return (
        ticketData.ticketExpirationDate ||
        ticketData.endTime ||
        ticketData.dueDate ||
        ticketData.workExpirationDate ||
        null
    );
}

export function isUserAssignedToTicket(ticketData, userId) {
    // Legacy ticket-level assignees removed — project assignment is authoritative in the UI.
    void ticketData;
    void userId;
    return false;
}

/**
 * Server list/pack no longer filters by per-ticket assignees (full org payload for tech).
 * Partner shared tickets stay hidden from tech.
 */
export function ticketVisibleToTech(ticketData, _userId) {
    if (ticketData && ticketData.shared) return false;
    return true;
}

/**
 * @returns {Promise<boolean>} true if request may proceed; false if 403 already sent
 */
export async function assertNotTechWrite(req, res, orgId) {
    if (req.user.role === 'dev') return true;
    if (!canMutateOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'You do not have permission to modify data in this organization' });
        return false;
    }
    const db = getDatabase();
    const role = await getMembershipRole(db, req.user.id, orgId);
    if (isTechMembership(role)) {
        res.status(403).json({ error: 'Tech users cannot modify tickets or overrides.' });
        return false;
    }
    return true;
}

export async function getWrittenTicketId(db, orgId, ticketNumber) {
    const row = await getRow(db, 'SELECT id FROM tickets WHERE organization_id = ? AND ticket_number = ?', [
        orgId,
        ticketNumber,
    ]);
    return row && row.id != null ? row.id : null;
}

function mapTicketOperatorResponseRow(r) {
    return {
        id: r.response_id,
        stationCode: r.station_code,
        operatorName: r.operator_name,
        operatorCode: r.operator_code,
        statusCode: r.status_code,
        operatorStatus: r.operator_status,
        respondedAt: r.responded_at,
        comment: r.comment,
        authorityId: r.authority_id,
        source: r.source,
        ticketRevisionSnapshot: r.ticket_revision_snapshot,
        ticketNumberFullSnapshot: r.ticket_number_full_snapshot,
    };
}

export async function loadTicketOperatorResponsesFromRows(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT response_id, station_code, operator_name, operator_code, status_code, operator_status,
                responded_at, comment, authority_id, source, ticket_revision_snapshot, ticket_number_full_snapshot
         FROM ticket_operator_responses
         WHERE ticket_id = ?
         ORDER BY response_index ASC, id ASC`,
        [ticketId]
    );
    return (rows || []).map(mapTicketOperatorResponseRow);
}

/** @returns {Promise<Map<number, object>>} */
export async function loadTicketRowMapForTicketIds(db, orgId, ticketIds, select = TICKET_ROW_SELECT) {
    const map = new Map();
    const ids = (ticketIds || []).filter((id) => id != null && Number.isFinite(Number(id))).map((id) => Number(id));
    if (ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ids.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allRows(
            db,
            `SELECT ${select}
             FROM tickets
             WHERE organization_id = ? AND id IN (${placeholders})`,
            [orgId, ...chunk]
        );
        for (const r of rows || []) {
            const tid = r.id != null ? Number(r.id) : NaN;
            if (Number.isFinite(tid)) map.set(tid, r);
        }
    }
    return map;
}

export async function loadOperatorResponsesMapForTicketIds(db, ticketIds) {
    const map = new Map();
    const ids = (ticketIds || []).filter((id) => id != null && Number.isFinite(Number(id))).map((id) => Number(id));
    if (ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ids.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allRows(
            db,
            `SELECT ticket_id, response_id, station_code, operator_name, operator_code, status_code, operator_status,
                    responded_at, comment, authority_id, source, ticket_revision_snapshot, ticket_number_full_snapshot
             FROM ticket_operator_responses
             WHERE ticket_id IN (${placeholders})
             ORDER BY ticket_id ASC, response_index ASC, id ASC`,
            chunk
        );
        for (const r of rows || []) {
            const tid = r.ticket_id != null ? Number(r.ticket_id) : NaN;
            if (!Number.isFinite(tid)) continue;
            if (!map.has(tid)) map.set(tid, []);
            map.get(tid).push(mapTicketOperatorResponseRow(r));
        }
    }
    return map;
}

export function attachOperatorResponsesToTicket(ticket, operatorResponses) {
    if (!ticket || !Array.isArray(operatorResponses) || operatorResponses.length === 0) return ticket;
    ticket.operatorResponses = operatorResponses;
    ticket.stationCodes = [...new Set(operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean))];
    ticket.stationDetails = operatorResponses.map((r) => ({
        code: r.stationCode || r.operatorCode,
        name: r.operatorName,
        responseDate: r.respondedAt,
        responseCode: r.statusCode,
        comment: r.comment,
    }));
    return ticket;
}

function posrResponseCountsMissingOnTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return true;
    const req = ticket.ngenRequiredResponseCount;
    const rec = ticket.ngenReceivedResponseCount;
    const reqMissing = req == null || String(req).trim() === '' || !Number.isFinite(Number(req));
    const recMissing = rec == null || String(rec).trim() === '' || !Number.isFinite(Number(rec));
    return reqMissing || recMissing;
}

function isPosrPublicTicketRow(row, ticket = null) {
    const laneFromRow =
        row && row.sync_lane != null && String(row.sync_lane).trim() !== ''
            ? String(row.sync_lane).trim().toLowerCase()
            : '';
    if (laneFromRow === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) return true;
    const laneFromTicket =
        ticket && ticket.syncLane != null && String(ticket.syncLane).trim() !== ''
            ? String(ticket.syncLane).trim().toLowerCase()
            : '';
    if (laneFromTicket === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) return true;
    return ticketBuilder.isNvPublicImportTicketSource(ticket && ticket.source);
}

/** Derive POSR required/received counts for summary workflow when indexed columns are still null. */
export function applyPosrDerivedCountsForSummaryTicket(ticket, row, operatorResponses) {
    if (!ticket || !row || !Array.isArray(operatorResponses) || operatorResponses.length === 0) return ticket;
    if (!posrResponseCountsMissingOnTicket(ticket)) return ticket;
    if (!isPosrPublicTicketRow(row, ticket)) return ticket;
    attachOperatorResponsesToTicket(ticket, operatorResponses);
    if (!ticket.syncLane) {
        ticket.syncLane = ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
    }
    ticketBuilder.applyPosrDerivedResponseCounts(ticket);
    return ticket;
}

function mapTicketHistoryEventRow(r) {
    return {
        operatorName: r.operator_name,
        operatorCode: r.operator_code,
        statusCode: r.status_code,
        respondedAt: r.responded_at,
        responseReceived: r.response_received,
        comment: r.comment,
    };
}

export async function loadHistoryMapForTicketIds(db, ticketIds) {
    const map = new Map();
    const ids = (ticketIds || []).filter((id) => id != null && Number.isFinite(Number(id))).map((id) => Number(id));
    if (ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ids.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await allRows(
            db,
            `SELECT ticket_id, operator_name, operator_code,
                    status_code, responded_at, response_received, comment
             FROM ticket_posr_notification_history
             WHERE ticket_id IN (${placeholders})
             ORDER BY ticket_id ASC, event_index ASC, id ASC`,
            chunk
        );
        for (const r of rows || []) {
            const tid = r.ticket_id != null ? Number(r.ticket_id) : NaN;
            if (!Number.isFinite(tid)) continue;
            if (!map.has(tid)) map.set(tid, []);
            map.get(tid).push(mapTicketHistoryEventRow(r));
        }
    }
    return map;
}

export async function loadTicketHistoryEventsFromRows(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT operator_name, operator_code,
                status_code, responded_at, response_received, comment
         FROM ticket_posr_notification_history
         WHERE ticket_id = ?
         ORDER BY event_index ASC, id ASC`,
        [ticketId]
    );
    return (rows || []).map((r) => mapTicketHistoryEventRow(r));
}

/** Per-revision nGen enquiry ids + USAN status (for confirmation PDF retrieval). Not for lean list. */
export async function loadTicketRevisionEnquiries(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT revision, job_number, request_number, status, observed_at
         FROM ticket_revision_enquiries
         WHERE ticket_id = ?
         ORDER BY revision ASC`,
        [ticketId]
    );
    return (rows || []).map((r) => ({
        revision: r.revision != null ? String(r.revision) : null,
        jobNumber: r.job_number != null ? String(r.job_number) : null,
        requestNumber: r.request_number != null ? String(r.request_number) : null,
        status: r.status != null ? String(r.status) : null,
        observedAt: r.observed_at,
    }));
}

export async function loadTicketNgenNotificationHistoryRows(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT authority_id, entry_index, responded_at, status_code, code_description,
                notes_comment, error, request_number, updated_by, is_disputed, dispute_locate_code,
                enquiry_id, fetched_at
         FROM ticket_ngen_notification_history
         WHERE ticket_id = ?
         ORDER BY authority_id ASC, entry_index ASC, id ASC`,
        [ticketId]
    );
    if (!rows || rows.length === 0) return null;
    const utilitiesByAuthority = new Map();
    let requestNumber = null;
    let fetchedAt = null;
    for (const row of rows) {
        const authorityId = row.authority_id != null ? String(row.authority_id) : '';
        if (!authorityId) continue;
        if (!requestNumber && row.request_number) requestNumber = row.request_number;
        if (!fetchedAt && row.fetched_at) fetchedAt = row.fetched_at;
        if (!utilitiesByAuthority.has(authorityId)) {
            utilitiesByAuthority.set(authorityId, { authorityId, entries: [] });
        }
        const util = utilitiesByAuthority.get(authorityId);
        if (row.error != null && String(row.error).trim() !== '') {
            util.error = String(row.error);
            continue;
        }
        let isDisputed = null;
        if (row.is_disputed === 1 || row.is_disputed === true) isDisputed = true;
        else if (row.is_disputed === 0 || row.is_disputed === false) isDisputed = false;
        util.entries.push({
            index: row.entry_index != null ? Number(row.entry_index) : util.entries.length,
            at: row.responded_at,
            code: row.status_code,
            codeDescription: row.code_description,
            notesComment: row.notes_comment,
            comment: row.code_description,
            requestNumber: row.request_number != null ? String(row.request_number) : null,
            updatedBy: row.updated_by != null ? String(row.updated_by) : null,
            isDisputed,
            disputeLocateCode: row.dispute_locate_code != null ? String(row.dispute_locate_code) : null,
            enquiryId: row.enquiry_id != null ? String(row.enquiry_id) : null,
        });
    }
    const tipByAuthority = await loadTicketNgenHistoryAuthorityTipMap(db, ticketId);
    return {
        normalized: {
            utilities: Array.from(utilitiesByAuthority.values()),
        },
        fetchedAt,
        requestNumber,
        ...(Object.keys(tipByAuthority).length > 0 ? { tipByAuthority } : {}),
    };
}

/**
 * @returns {Promise<Record<string, { fingerprint: string, requestNumber: string|null, fetchedAt: string|null }>>}
 */
export async function loadTicketNgenHistoryAuthorityTips(db, ticketId) {
    const rows = await allRows(
        db,
        `SELECT authority_id, tip_fingerprint, request_number, fetched_at
         FROM ticket_ngen_history_authority_tips
         WHERE ticket_id = ?`,
        [ticketId]
    );
    /** @type {Record<string, { fingerprint: string, requestNumber: string|null, fetchedAt: string|null }>} */
    const out = {};
    for (const row of rows || []) {
        const aid = row.authority_id != null ? String(row.authority_id).trim() : '';
        if (!aid) continue;
        out[aid] = {
            fingerprint: row.tip_fingerprint != null ? String(row.tip_fingerprint) : '',
            requestNumber: row.request_number != null ? String(row.request_number) : null,
            fetchedAt: row.fetched_at != null ? String(row.fetched_at) : null,
        };
    }
    return out;
}

/** @returns {Promise<Record<string, string>>} */
export async function loadTicketNgenHistoryAuthorityTipMap(db, ticketId) {
    const stored = await loadTicketNgenHistoryAuthorityTips(db, ticketId);
    /** @type {Record<string, string>} */
    const out = {};
    for (const [aid, tip] of Object.entries(stored) as [string, { fingerprint?: string }][]) {
        out[aid] = tip && tip.fingerprint != null ? String(tip.fingerprint) : '';
    }
    return out;
}

export async function loadTicketAssigneesFromRows(_db, _ticketId) {
    return [];
}

export async function applyStructuredRowsToTicket(db, ticket) {
    if (!ticket || ticket.id == null) return ticket;
    const [operatorResponses, history, ngenResponseHistory, revisionEnquiries] = await Promise.all([
        loadTicketOperatorResponsesFromRows(db, ticket.id),
        loadTicketHistoryEventsFromRows(db, ticket.id),
        loadTicketNgenNotificationHistoryRows(db, ticket.id),
        loadTicketRevisionEnquiries(db, ticket.id),
    ]);
    attachOperatorResponsesToTicket(ticket, operatorResponses);
    if (history.length > 0) {
        ticket.history = history;
    }
    ticket.revisionEnquiries = revisionEnquiries;
    if (ngenResponseHistory) {
        ticket.ngenResponseHistory = ngenResponseHistory;
        ticket.providerResponseHistory = ngenResponseHistory;
    }
    delete ticket.assignedToUsers;
    delete ticket.assignedToUserId;
    delete ticket.assignedToUserName;
    return ticket;
}

/** Attach cached D1 provider notification history (no USAN call). */
export async function attachCachedProviderResponseHistory(db, ticket) {
    if (!ticket || ticket.id == null) return ticket;
    const ngenResponseHistory = await loadTicketNgenNotificationHistoryRows(db, ticket.id);
    if (ngenResponseHistory) {
        ticket.ngenResponseHistory = ngenResponseHistory;
        ticket.providerResponseHistory = ngenResponseHistory;
    }
    return ticket;
}

/** Popup / db-detail open: current operator rows only (no map/provider history). */
export async function applyStructuredRowsToTicketForOpen(db, ticket) {
    if (!ticket || ticket.id == null) return ticket;
    const [operatorRows, revisionEnquiries] = await Promise.all([
        loadTicketOperatorResponsesFromRows(db, ticket.id),
        loadTicketRevisionEnquiries(db, ticket.id),
    ]);
    const ticketRevision =
        ticket.ticketRevision != null ? String(ticket.ticketRevision).trim() : null;
    const ticketNumberFull =
        ticket.ticketNumberFull != null && String(ticket.ticketNumberFull).trim() !== ''
            ? String(ticket.ticketNumberFull).trim()
            : null;
    const operatorResponses = (operatorRows || []).map((r, index) =>
        ticketBuilder.coerceLegacyPosrOperatorRowToNgenPending(r, ticketRevision, ticketNumberFull, index)
    );
    attachOperatorResponsesToTicket(ticket, operatorResponses);
    if (!Array.isArray(ticket.operatorResponses)) {
        ticket.operatorResponses = [];
    }
    ticket.revisionEnquiries = revisionEnquiries;
    delete ticket.assignedToUsers;
    delete ticket.assignedToUserId;
    delete ticket.assignedToUserName;
    return ticket;
}

/** Ticket history modal: map/POSR notification rows for Response History (not operator response rows). */
export async function applyStructuredRowsToTicketHistory(db, ticket) {
    if (!ticket || ticket.id == null) return ticket;
    const history = await loadTicketHistoryEventsFromRows(db, ticket.id);
    if (history.length > 0) {
        ticket.history = history;
    } else {
        delete ticket.history;
    }
    return ticket;
}

export async function isUserAssignedToTicketRow(_db, _ticketId, _userId) {
    return false;
}

/**
 * Tech may read any org-owned ticket via API (full org cache model).
 * UI still filters by project assignment client-side.
 * @returns {Promise<boolean>}
 */
export async function ticketDataAccessibleToTechUser(db, orgId, _userId, ticketNumber) {
    const row = await resolveTicketRowForOrg(db, orgId, ticketNumber);
    return Boolean(row);
}

/**
 * Resolve a ticket row the same way as PATCH assignment / hub refresh: exact #, -000 strip,
 * request base only, then latest revision matching BASE-% for this org.
 * @returns {Promise<object | null>} row includes indexed columns when present
 */
export async function resolveTicketRowForOrg(db, orgId, ticketNumber) {
    const tn = String(ticketNumber || '').trim();
    if (!tn) return null;

    const tried = new Set();
    const tryExact = async (key) => {
        if (!key || tried.has(key)) return null;
        tried.add(key);
        return getRow(
            db,
            `SELECT ${TICKET_ROW_SELECT} FROM tickets WHERE organization_id = ? AND ticket_number = ?`,
            [orgId, key]
        );
    };

    let row = await tryExact(tn);
    if (row) return row;

    const strippedZeros = tn.replace(/-0+$/, '');
    if (strippedZeros !== tn) {
        row = await tryExact(strippedZeros);
        if (row) return row;
    }

    const baseOnly = ticketBuilder.normalizeTicketBase(tn);
    if (baseOnly && baseOnly !== tn) {
        row = await tryExact(baseOnly);
        if (row) return row;
    }

    if (baseOnly) {
        const likePattern = `${baseOnly}-%`;
        row = await getRow(
            db,
            `SELECT ${TICKET_ROW_SELECT} FROM tickets
             WHERE organization_id = ? AND ticket_number LIKE ?
             ORDER BY updated_at DESC
             LIMIT 1`,
            [orgId, likePattern]
        );
        if (row) return row;
    }

    return null;
}

export function currentFullRequestNumberFromRow(row) {
    if (!row || row.ticket_number == null) return null;
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    const base = parts.baseNumber || ticketBuilder.normalizeTicketBase(row.ticket_number) || String(row.ticket_number).split('-')[0];
    const revision = row.revision != null ? String(row.revision).trim() : '';
    if (base && revision) return `${base}-${revision}`;
    return parts.displayFull || (base ? `${base}-000` : null);
}

/**
 * Full ticket row for refresh / merge.
 * @returns {Promise<object | null>}
 */
export async function findFullTicketRowForOrg(db, orgId, ticketNumber) {
    return resolveTicketRowForOrg(db, orgId, ticketNumber);
}

/**
 * Rows across orgs that represent the same base request number.
 * @returns {Promise<object[]>}
 */
export async function findTicketSiblingRowsByBase(db, ticketNumber) {
    const tn = String(ticketNumber || '').trim();
    if (!tn) return [];
    const base = ticketBuilder.normalizeTicketBase(tn) || tn.split('-')[0];
    if (!base) return [];
    const rows = await allRows(
        db,
        `SELECT ${TICKET_ROW_SELECT}
         FROM tickets
         WHERE ticket_number = ? OR ticket_number = ? OR ticket_number LIKE ?
         ORDER BY organization_id, updated_at DESC, id DESC`,
        [tn, base, `${base}-%`]
    );
    const seen = new Set();
    return (rows || []).filter((row) => {
        if (!row || row.id == null || seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
    });
}

/** Same shape as GET /tickets list items (indexed columns + structured rows + hub metadata). */
export async function buildTicketResponseForClient(db, orgId, row, opts: any = {}) {
    let ticketData = {};
    ticketData = applyIndexedColumnsToTicketShape(ticketBuilder.stripDerivedTicketUiFields(ticketData), row);
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    const ticket: any = {
        ...ticketData,
        id: row.id,
        ticketNumber: row.ticket_number,
        ticketBaseNumber: parts.baseNumber,
        ticketRevision: row.revision != null ? String(row.revision) : parts.revisionSuffix,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    // ticket_number is usually already BASE-REV (e.g. 2026032900022-001). Do not append row.revision again
    // or requestNumber becomes 2026032900022-001-001 and GetNotificationResponseHistoryAsync returns nothing useful.
    if (!ticket.ticketNumberFull) {
        ticket.ticketNumberFull = currentFullRequestNumberFromRow(row);
    }
    if (opts.includeHistory === true) {
        await applyStructuredRowsToTicketForOpen(db, ticket);
        await applyStructuredRowsToTicketHistory(db, ticket);
        if (opts.includeProviderHistory !== false) {
            await attachCachedProviderResponseHistory(db, ticket);
        }
    } else if (opts.includeFullStructured === true) {
        await applyStructuredRowsToTicket(db, ticket);
    } else {
        await applyStructuredRowsToTicketForOpen(db, ticket);
        if (opts.includeProviderHistory === true) {
            await attachCachedProviderResponseHistory(db, ticket);
        }
        if (opts.posrOperatorBackfill !== false) {
            const ops = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
            try {
                const pollHelpers = await import('./tickets/pollHelpers.js');
                if (ops.length === 0) {
                    const backfilled = await pollHelpers.maybeBackfillPosrOperatorResponsesOnOpen(
                        db,
                        orgId,
                        row,
                        ticket,
                        { userId: opts.userId != null ? opts.userId : null }
                    );
                    if (backfilled) {
                        await applyStructuredRowsToTicketForOpen(db, ticket);
                    }
                } else {
                    await pollHelpers.maybeEnsurePosrResponseCountsPersisted(
                        db,
                        orgId,
                        row,
                        ticket,
                        { userId: opts.userId != null ? opts.userId : null }
                    );
                }
            } catch (e) {
                console.warn('[buildTicketResponseForClient] POSR operator backfill:', e.message || e);
            }
        }
    }
    await applyPhotoRequirementFieldsWithDb(db, ticket);
    await attachSnapshotToTicket(db, ticket.organizationId, row, ticket);
    if (opts.includeWorkflowAckCompliance === true) {
        const orgRow = await getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [orgId]);
        ticket.workflowAckCompliance = await evaluateAckComplianceEvidence(db, orgId, orgRow, row, ticket);
    }
    if (ticket.syncLane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC && (ticket.source == null || String(ticket.source).trim() === "")) {
        ticket.source = "nv_api";
    }
    ticket.hasFullDetail = true;
    ticket.listSummary = false;
    return ticket;
}

/** Like {@link applyStructuredRowsToTicket} but omits nGen notification response history (lean hub expired list). */
export async function applyStructuredRowsToTicketLean(db, ticket) {
    if (!ticket || ticket.id == null) return ticket;
    const [operatorResponses, history] = await Promise.all([
        loadTicketOperatorResponsesFromRows(db, ticket.id),
        loadTicketHistoryEventsFromRows(db, ticket.id),
    ]);
    attachOperatorResponsesToTicket(ticket, operatorResponses);
    if (history.length > 0) {
        ticket.history = history;
    }
    delete ticket.assignedToUsers;
    delete ticket.assignedToUserId;
    delete ticket.assignedToUserName;
    return ticket;
}

/** Summary list: assignee fields removed (project assignment is separate). */
export function attachAssigneeSummaryFromList(ticket, _assignees) {
    ticket.assigneeCount = 0;
    ticket.assigneeUserIds = [];
    delete ticket.assignedToUsers;
    delete ticket.assignedToUserId;
    delete ticket.assignedToUserName;
    return ticket;
}

export async function loadWorkflowAckMapForOrg(db, orgId) {
    const ctx = await loadWorkflowAckContextForOrg(db, orgId);
    return ctx.ackMap;
}

/** Per-org workflow ack map + RNEW waiver / expiring-soon policy for status computation. */
export async function loadWorkflowAckContextForOrg(db, orgId) {
    const id = orgId != null ? Number(orgId) : NaN;
    if (!Number.isFinite(id)) {
        return {
            ackMap: buildWorkflowAckMapFromDbRows([]),
            renewalAckWaivers: false,
            expiringSoonDays: DEFAULT_EXPIRING_SOON_DAYS,
        };
    }
    const [arows, orgRow] = await Promise.all([
        allRows(db, WORKFLOW_ACK_SELECT, [id]),
        getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [id]),
    ]);
    const policy = getWorkflowAckCompliancePolicy(orgRow);
    return {
        ackMap: buildWorkflowAckMapFromDbRows(arows),
        renewalAckWaivers: policy.renewalAckWaivers === true,
        expiringSoonDays: policy.expiringSoonDays,
        notReadyCodes: policy.notReadyCodes,
        actionRequiredCodes: policy.actionRequiredCodes,
        ackBlockingCodes: policy.ackBlockingCodes,
    };
}

export function workflowStatusOptionsFromContext(ctx) {
    if (!ctx || typeof ctx !== 'object') {
        return { renewalAckWaivers: false, expiringSoonDays: DEFAULT_EXPIRING_SOON_DAYS };
    }
    return {
        renewalAckWaivers: ctx.renewalAckWaivers === true,
        expiringSoonDays: ctx.expiringSoonDays,
        notReadyCodes: ctx.notReadyCodes,
        actionRequiredCodes: ctx.actionRequiredCodes,
        ackBlockingCodes: ctx.ackBlockingCodes,
    };
}

/** Attach server workflow status + ack flags for client list/detail parity (not stored on tickets row). */
export async function attachComputedWorkflowStatusForOrgTicket(db, orgId, ticket) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    const ownerOrgId =
        ticket.organizationId != null && Number.isFinite(Number(ticket.organizationId))
            ? Number(ticket.organizationId)
            : orgId;
    const ctx = await loadWorkflowAckContextForOrg(db, ownerOrgId);
    ticket.computedWorkflowStatus = computeWorkflowStatusForTicket(
        ticket,
        ctx.ackMap,
        'owner',
        workflowStatusOptionsFromContext(ctx)
    );
    ticket.expiringSoonDays = ctx.expiringSoonDays;
    attachWorkflowAckToSummaryTicket(ticket, ctx.ackMap);
    return ticket;
}

export function attachWorkflowAckToSummaryTicket(ticket, ackMap) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    const ack = tn && ackMap && typeof ackMap === 'object' ? ackMap[tn] : null;
    if (!ack) {
        ticket.hasWorkflowAck = false;
        delete ticket.workflowAcknowledgedAt;
        delete ticket.workflowAcknowledgedBy;
        delete ticket.workflowAcknowledgedRevision;
        return ticket;
    }
    const rev =
        ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== ''
            ? String(ticket.ticketRevision).trim()
            : ticket.revision != null
              ? String(ticket.revision).trim()
              : '';
    const valid = ack.photosMet && ack.revision === rev;
    ticket.hasWorkflowAck = valid;
    if (valid) {
        ticket.workflowAcknowledgedAt = ack.acknowledgedAt;
        ticket.workflowAcknowledgedBy = ack.acknowledgedBy;
        ticket.workflowAcknowledgedRevision = ack.revision;
    } else {
        delete ticket.workflowAcknowledgedAt;
        delete ticket.workflowAcknowledgedBy;
        delete ticket.workflowAcknowledgedRevision;
    }
    return ticket;
}

export function attachOverrideFlagsToSummaryTicket(ticket, maps) {
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    ticket.hasOperatorOverrides = !!(
        tn &&
        maps &&
        maps.ticketNumbersWithOperatorOverrides &&
        maps.ticketNumbersWithOperatorOverrides.has(tn)
    );
    ticket.hasPhotoOverride = !!(maps && maps.photoRecordByKey && maps.photoRecordByKey[tn]);
    return ticket;
}

/** Strip heavy / deferred fields from GET /tickets?summary=1 rows (polygons load on demand). */
export function stripSlimSummaryTicketForClient(ticket) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    delete ticket.operatorResponses;
    delete ticket.stationCodes;
    delete ticket.stationDetails;
    delete ticket.history;
    delete ticket.workDescription;
    delete ticket.scopeOfWork;
    delete ticket.outstandingOperators;
    delete ticket.ngenResponseHistory;
    delete ticket.providerResponseHistory;
    delete ticket.polygon;
    // Keep ngenUserReference / jobName — hub list shows job names from these short indexed fields.
    const jobRef =
        ticket.ngenUserReference != null && String(ticket.ngenUserReference).trim() !== ''
            ? String(ticket.ngenUserReference).trim()
            : ticket.jobName != null && String(ticket.jobName).trim() !== ''
              ? String(ticket.jobName).trim()
              : '';
    if (jobRef) {
        ticket.ngenUserReference = jobRef;
        ticket.jobName = jobRef;
    }
    // Lean list always carries a map pin (stored pin_lng/pin_lat, else bbox center).
    ensureStubMapPinOnTicket(ticket);
    return ticket;
}

/** Lean list row for GET /tickets?expiredOnly=1 (hub expired browse). */
export async function buildTicketExpiredListItemForClient(db, orgId, row) {
    const ticket = buildTicketListSummaryFromRow(orgId, row, {});
    await applyPhotoRequirementFieldsWithDb(db, ticket);
    await attachSnapshotToTicket(db, ticket.organizationId, row, ticket);
    if (ticket.syncLane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC && (ticket.source == null || String(ticket.source).trim() === "")) {
        ticket.source = "nv_api";
    }
    return ticket;
}

/**
 * Hydrated ticket shape for USAN list-poll merges only: indexed columns + operator responses +
 * history + photo cutoff fields. Omits notification snapshot and photo polygon snapshot
 * (merge reads/writes do not depend on those).
 */
export async function buildTicketShapeForListPollMerge(db, orgId, row) {
    let ticketData = {};
    ticketData = applyIndexedColumnsToTicketShape(ticketBuilder.stripDerivedTicketUiFields(ticketData), row);
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    const ticket: any = {
        ...ticketData,
        id: row.id,
        ticketNumber: row.ticket_number,
        ticketBaseNumber: parts.baseNumber,
        ticketRevision: row.revision != null ? String(row.revision) : parts.revisionSuffix,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (!ticket.ticketNumberFull) {
        ticket.ticketNumberFull = currentFullRequestNumberFromRow(row);
    }
    const [operatorResponses, history] = await Promise.all([
        loadTicketOperatorResponsesFromRows(db, ticket.id),
        loadTicketHistoryEventsFromRows(db, ticket.id),
    ]);
    attachOperatorResponsesToTicket(ticket, operatorResponses);
    if (history.length > 0) {
        ticket.history = history;
    }
    delete ticket.assignedToUsers;
    delete ticket.assignedToUserId;
    delete ticket.assignedToUserName;
    await applyPhotoRequirementFieldsWithDb(db, ticket);
    if (ticket.syncLane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC && (ticket.source == null || String(ticket.source).trim() === "")) {
        ticket.source = "nv_api";
    }
    return ticket;
}

/**
 * Lean list item for GET /tickets?summary=1: indexed columns plus caller-provided batched rows.
 * Photo intersection snapshots are batched in listRoutes (ticket_photo_stats) before workflow status.
 */
export function buildTicketListSummaryFromRow(orgId, row, opts: any = {}) {
    let ticketData = {};
    ticketData = applyIndexedColumnsToTicketShape(ticketBuilder.stripDerivedTicketUiFields(ticketData), row);
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    const ticket: any = {
        ...ticketData,
        id: row.id,
        ticketNumber: row.ticket_number,
        ticketBaseNumber: parts.baseNumber,
        ticketRevision: row.revision != null ? String(row.revision) : parts.revisionSuffix,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        listSummary: true,
    };
    if (!ticket.ticketNumberFull) {
        ticket.ticketNumberFull = currentFullRequestNumberFromRow(row);
    }
    attachOperatorResponsesToTicket(ticket, opts.operatorResponses || []);
    const historyRows = Array.isArray(opts.history) ? opts.history : [];
    if (historyRows.length > 0) {
        ticket.history = historyRows;
    }
    applyPhotoRequirementFields(ticket);
    if (inferNgenSearchStubFromTicket(ticket)) {
        ticket.ngenSearchStub = true;
    }
    if (ticket.syncLane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC && (ticket.source == null || String(ticket.source).trim() === "")) {
        ticket.source = "nv_api";
    }
    return ticket;
}

export async function buildTicketSummaryForClient(db, orgId, row, opts: any = {}) {
    const sourceRow = opts.hydratedRow || row;
    return buildTicketListSummaryFromRow(orgId, sourceRow, opts);
}

export { loadEarliestPosr000IsoMap };

/**
 * Minimal ticket shape for GET /public/map — map, sidebar cards, no PII or operator detail.
 */
export function buildPublicMapTicketForClient(orgId, row, hit) {
    const indexed = applyIndexedColumnsToTicketShape({}, row);
    const parts = ticketBuilder.parseTicketNumberParts(row.ticket_number);
    const ticket = {
        id: row.id,
        ticketNumber: row.ticket_number,
        ticketBaseNumber: parts.baseNumber,
        ticketRevision: row.revision != null ? String(row.revision) : parts.revisionSuffix,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        polygon: indexed.polygon,
        stubMapPin: indexed.stubMapPin,
        bbox: indexed.bbox,
        address: indexed.address || indexed.fullAddress || undefined,
        fullAddress: indexed.fullAddress || undefined,
        startTime: indexed.startTime || indexed.legalStartDate || undefined,
        ticketExpirationDate: indexed.ticketExpirationDate || undefined,
        ngenRequiredResponseCount: indexed.ngenRequiredResponseCount,
        ngenReceivedResponseCount: indexed.ngenReceivedResponseCount,
        listSummary: true,
        shared: true,
        readOnly: true,
        sharedFromOrganizationId: hit && hit.sourceOrgId != null ? hit.sourceOrgId : undefined,
        sharedSourceLabel: hit && hit.displayLabel != null ? hit.displayLabel : undefined,
    };
    return ticket;
}

/** @returns {Promise<Map<number, Array<{ userId: number, userName: string }>>>} */
export async function loadAssigneesMapForTicketIds(_db, _ticketIds) {
    return new Map();
}

/**
 * Keyset cursor for `ORDER BY created_at DESC, id DESC` (GET /tickets summary pagination).
 * @param {{ created_at?: unknown, id?: unknown }} row
 */
export function encodeTicketListCursor(row) {
    if (!row || row.id == null) return '';
    const payload = JSON.stringify({
        ca: row.created_at != null ? String(row.created_at) : '',
        id: Number(row.id),
    });
    try {
        const b64 =
            typeof Buffer !== 'undefined'
                ? Buffer.from(payload, 'utf8').toString('base64')
                : btoa(unescape(encodeURIComponent(payload)));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (_) {
        return '';
    }
}

/**
 * @returns {{ createdAt: string, id: number } | null}
 */
export function decodeTicketListCursor(cursorStr) {
    const s = String(cursorStr || '').trim();
    if (!s) return null;
    try {
        const padded = s + '==='.slice((s.length + 3) % 4);
        const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
        const json =
            typeof Buffer !== 'undefined'
                ? Buffer.from(b64, 'base64').toString('utf8')
                : new TextDecoder().decode(
                      Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
                  );
        const o = JSON.parse(json);
        if (!o || o.id == null || o.ca == null) return null;
        const id = Number(o.id);
        if (!Number.isFinite(id)) return null;
        return { createdAt: String(o.ca), id };
    } catch (_) {
        return null;
    }
}

/**
 * Keyset cursor for expired hub list (`ORDER BY filter date DESC, id DESC`).
 * @param {object} row
 * @param {string} dateField
 */
export function encodeExpiredListCursor(row, dateField) {
    if (!row || row.id == null) return '';
    const fd = hubFilterDateValueFromRow(row, dateField);
    const payload = JSON.stringify({
        fd,
        id: Number(row.id),
    });
    try {
        const b64 =
            typeof Buffer !== 'undefined'
                ? Buffer.from(payload, 'utf8').toString('base64')
                : btoa(unescape(encodeURIComponent(payload)));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (_) {
        return '';
    }
}

/** @returns {{ filterDate: string, id: number } | null} */
export function decodeExpiredListCursor(cursorStr) {
    const s = String(cursorStr || '').trim();
    if (!s) return null;
    try {
        const padded = s + '==='.slice((s.length + 3) % 4);
        const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
        const json =
            typeof Buffer !== 'undefined'
                ? Buffer.from(b64, 'base64').toString('utf8')
                : new TextDecoder().decode(
                      Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
                  );
        const o = JSON.parse(json);
        if (!o || o.id == null || o.fd == null || String(o.fd).trim() === '') return null;
        const id = Number(o.id);
        if (!Number.isFinite(id)) return null;
        return { filterDate: String(o.fd), id };
    } catch (_) {
        return null;
    }
}

/** Per ticket row: keep only this many view events (older rows are deleted). */
export const TICKET_VIEW_LOG_MAX = 500;

/**
 * Delete view events for a ticket so only the newest TICKET_VIEW_LOG_MAX rows remain.
 * @param {object} db
 * @param {number} ticketId - tickets.id
 */
export async function pruneTicketViewEvents(db, ticketId) {
    await runDb(
        db,
        `DELETE FROM ticket_view_events
         WHERE ticket_id = ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM ticket_view_events
             WHERE ticket_id = ?
             ORDER BY datetime(opened_at) DESC, id DESC
             LIMIT ${TICKET_VIEW_LOG_MAX}
           ) AS keep_ids
         )`,
        [ticketId, ticketId]
    );
}
