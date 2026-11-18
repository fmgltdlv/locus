import * as ticketBuilder from '../lib/ticketBuilder.cjs';
import * as ticketSyncLane from '../lib/ticketSyncLane.cjs';
import {
    DEFAULT_ACK_BLOCKING_CODES,
    DEFAULT_ACTION_REQUIRED_CODES,
    DEFAULT_NOT_READY_CODES,
    getOperatorStatusFromCode,
    resolveOperatorCodeLists,
    ticketHasAckBlockingOperatorCodesWithLists,
} from '../lib/operatorResponseCodes.cjs';

/** Mirrors client workflow badge strings */
export type WorkflowStatus = 'READY' | 'NOT_READY' | 'ACTION_REQUIRED' | 'EXPIRED' | 'EXPIRING_SOON' | 'CANCELLED';

/** Operator codes that block workflow acknowledgement (pending). Platform default list. */
export const ACK_BLOCKING_OPERATOR_CODES = [...DEFAULT_ACK_BLOCKING_CODES];

export type WorkflowAckRecord = {
    ticketNumber: string;
    revision: string;
    note: string;
    photosMet: boolean;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    acknowledgedByUserId: number | null;
};

/** ticket_number (base) → latest ack row for org */
export type WorkflowAckMap = Record<string, WorkflowAckRecord>;

export type WorkflowStatusAudience = 'owner' | 'partner';

/** Per-org workflow options (e.g. RNEW acknowledgement waivers, expiring-soon window). */
export type WorkflowStatusOptions = {
    renewalAckWaivers?: boolean;
    expiringSoonDays?: number;
    notReadyCodes?: string[] | null;
    actionRequiredCodes?: string[] | null;
    ackBlockingCodes?: string[] | null;
};

const EMPTY_WORKFLOW_ACK_MAP: WorkflowAckMap = {};

export const NOT_READY_CODES = [...DEFAULT_NOT_READY_CODES];
export const ACTION_REQUIRED_CODES = [...DEFAULT_ACTION_REQUIRED_CODES];

function operatorCodeListsFromOptions(options?: WorkflowStatusOptions) {
    return resolveOperatorCodeLists(options || {});
}

/** Upstream USAN/nGen enquiry status (e.g. NEW, RNEW, REMK, Cancelled). */
export function getNgenEnquiryStatus(ticket: Record<string, unknown> | null | undefined): string {
    if (!ticket || typeof ticket !== 'object') return '';
    const raw =
        ticket.ngenEnquiryStatus ??
        ticket.providerEnquiryStatus ??
        ticket.currentNgenEnquiryStatus ??
        ticket.current_ngen_enquiry_status ??
        ticket.ngen_enquiry_status ??
        ticket.provider_enquiry_status;
    return raw != null ? String(raw).trim() : '';
}

function isTicketCancelled(ticket: Record<string, unknown> | null | undefined): boolean {
    return getNgenEnquiryStatus(ticket).toLowerCase() === 'cancelled';
}

/** USAN renewal notice (RNEW). */
export function isRenewalEnquiryStatus(ticket: Record<string, unknown> | null | undefined): boolean {
    return getNgenEnquiryStatus(ticket).toUpperCase() === 'RNEW';
}

/** When org enables renewalAckWaivers, RNEW may skip utility-count and operator-code ack gates. */
function renewalWaivesResponseCounts(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): boolean {
    return isRenewalEnquiryStatus(ticket) && !!options?.renewalAckWaivers;
}

function normalizeRevision(value: unknown): string {
    if (value == null || String(value).trim() === '') return '';
    return String(value).trim();
}

function ticketRevisionForWorkflow(ticket: Record<string, unknown> | null | undefined): string {
    if (!ticket || typeof ticket !== 'object') return '';
    return normalizeRevision(
        ticket.revision ?? ticket.ticketRevision ?? ticket.ticket_revision
    );
}

export function buildWorkflowAckMapFromDbRows(
    rows: Array<Record<string, unknown>> | null | undefined
): WorkflowAckMap {
    const map: WorkflowAckMap = {};
    for (const row of rows || []) {
        const tn = row && row.ticket_number != null ? String(row.ticket_number).trim() : '';
        if (!tn) continue;
        map[tn] = {
            ticketNumber: tn,
            revision: normalizeRevision(row.revision),
            note: row.note != null ? String(row.note) : '',
            photosMet: row.photos_met === 1 || row.photos_met === true,
            acknowledgedAt:
                row.acknowledged_at != null
                    ? String(row.acknowledged_at)
                    : row.created_at != null
                      ? String(row.created_at)
                      : null,
            acknowledgedBy: row.acknowledged_by_name != null ? String(row.acknowledged_by_name) : null,
            acknowledgedByUserId:
                row.acknowledged_by_user_id != null && Number.isFinite(Number(row.acknowledged_by_user_id))
                    ? Number(row.acknowledged_by_user_id)
                    : null,
        };
    }
    return map;
}

function getOperatorStatusFromCodeWithOptions(
    responseCode: unknown,
    options?: WorkflowStatusOptions
): WorkflowStatus | 'READY' | 'NOT_READY' | 'ACTION_REQUIRED' {
    return getOperatorStatusFromCode(responseCode, operatorCodeListsFromOptions(options));
}

/** Per-operator status for detail tab row coloring (not ticket-level workflow). */
export function getBaseOperatorStatus(
    response: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): WorkflowStatus | 'READY' | 'NOT_READY' | 'ACTION_REQUIRED' {
    if (!response) return 'READY';
    const code = response.statusCode;
    if (code != null && String(code).trim() !== '') {
        return getOperatorStatusFromCodeWithOptions(code, options);
    }
    const os = response.operatorStatus;
    if (os === 'NOT_READY' || os === 'ACTION_REQUIRED' || os === 'READY') {
        return os as WorkflowStatus;
    }
    return 'READY';
}

export function operatorResponseCode(response: Record<string, unknown> | null | undefined): string {
    if (!response) return '';
    const code = response.statusCode ?? response.status_code;
    return code != null ? String(code).trim() : '';
}

/** True when any operator row has an ack-blocking pending code. */
export function ticketHasAckBlockingOperatorCodes(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): boolean {
    return ticketHasAckBlockingOperatorCodesWithLists(ticket, operatorCodeListsFromOptions(options));
}

/** True when pending operator codes should block workflow acknowledgement. */
export function ticketAckBlockedByOperatorCodes(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): boolean {
    if (renewalWaivesResponseCounts(ticket, options)) return false;
    return ticketHasAckBlockingOperatorCodes(ticket, options);
}

/**
 * Prefer indexed `ticketExpirationDate` (D1 `ticket_expires_at`) so list/expired SQL and
 * workflow status agree; fall back to legacy POSR / endTime fields when the index is absent.
 */
function getTicketExpirationDateForStatus(ticket: Record<string, unknown> | null | undefined): unknown {
    if (!ticket || typeof ticket !== 'object') return null;
    return (
        ticket.ticketExpirationDate ||
        ticket.workExpirationDate ||
        ticket.work_expiration_date ||
        ticket.endTime ||
        ticket.dueDate ||
        null
    );
}

function normalizeTicketResponseCount(value: unknown): number | null {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : null;
}

function isPosrTicket(ticket: Record<string, unknown> | null | undefined): boolean {
    if (!ticket || typeof ticket !== 'object') return false;
    const lane =
        ticket.syncLane != null
            ? String(ticket.syncLane).trim().toLowerCase()
            : ticket.sync_lane != null
              ? String(ticket.sync_lane).trim().toLowerCase()
              : '';
    if (lane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) return true;
    const source = ticket.source != null ? String(ticket.source).trim().toLowerCase() : '';
    return source === 'nv_api' || source === 'nv_api_cache';
}

/** nGen-primary: received < required or missing counts on stub. */
export function isNgenCountsNotReady(ticket: Record<string, unknown> | null | undefined): boolean {
    if (!ticket || typeof ticket !== 'object') return true;
    const required = normalizeTicketResponseCount(ticket.ngenRequiredResponseCount);
    const received = normalizeTicketResponseCount(ticket.ngenReceivedResponseCount);
    if (required == null || received == null) return true;
    return received < required;
}

export function isWorkflowAckValid(
    ticket: Record<string, unknown> | null | undefined,
    ackMap: WorkflowAckMap | null | undefined
): boolean {
    if (!ticket || typeof ticket !== 'object' || !ackMap) return false;
    const tn =
        ticket.ticketNumber != null
            ? String(ticket.ticketNumber).trim()
            : ticket.ticket_number != null
              ? String(ticket.ticket_number).trim()
              : '';
    if (!tn) return false;
    const ack = ackMap[tn];
    if (!ack || !ack.photosMet) return false;
    return ack.revision === ticketRevisionForWorkflow(ticket);
}

/** Precedence: EXPIRED > CANCELLED > EXPIRING_SOON (Cancelled only if not yet expired). */
function computeLifecycleStatus(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): WorkflowStatus | null {
    if (!ticket || typeof ticket !== 'object') return null;
    const expirationDate = getTicketExpirationDateForStatus(ticket);
    if (ticketBuilder.isTicketExpired(expirationDate)) return 'EXPIRED';
    if (isTicketCancelled(ticket)) return 'CANCELLED';
    if (ticketBuilder.isExpiringSoon(expirationDate, options?.expiringSoonDays)) return 'EXPIRING_SOON';
    return null;
}

export function getTicketResponseProgress(ticket: Record<string, unknown> | null | undefined): {
    source: string;
    required: number | null;
    received: number | null;
    outstanding: number | null;
    complete: boolean | null;
} {
    const operatorRows = Array.isArray(ticket && ticket.operatorResponses) ? (ticket.operatorResponses as unknown[]).length : 0;
    const outstandingRows = Array.isArray(ticket && ticket.outstandingOperators) ? (ticket.outstandingOperators as unknown[]).length : 0;
    if (!ticket || typeof ticket !== 'object') {
        return {
            source: 'operatorRows',
            required: 0,
            received: 0,
            outstanding: 0,
            complete: true,
        };
    }

    const required = normalizeTicketResponseCount(ticket.ngenRequiredResponseCount);
    const received = normalizeTicketResponseCount(ticket.ngenReceivedResponseCount);
    if (required != null || received != null) {
        const displayReceived = received != null ? received : 0;
        const outstanding =
            required != null && received != null ? Math.max(0, required - received) : null;
        return {
            source: 'ngen',
            required,
            received: displayReceived,
            outstanding,
            complete: required != null && received != null ? displayReceived >= required : null,
        };
    }

    return {
        source: 'operatorRows',
        required: operatorRows,
        received: operatorRows,
        outstanding: outstandingRows,
        complete: outstandingRows === 0,
    };
}

export function areAllOperatorsResponded(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): boolean {
    if (!ticket || typeof ticket !== 'object') return false;
    const progress = getTicketResponseProgress(ticket);
    if (progress.source === 'ngen' && progress.complete != null) return progress.complete;
    const rows = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
    if (rows === 0) return false;
    return !ticketHasAckBlockingOperatorCodes(ticket, options);
}

/**
 * Owner org workflow status: nGen NOT_READY → else ack → ACTION_REQUIRED.
 * See computeWorkflowStatus.ts (this module) and workflowAckCompliance.cjs.
 */
export function computeWorkflowStatusForTicket(
    ticket: Record<string, unknown> | null | undefined,
    ackMap: WorkflowAckMap = EMPTY_WORKFLOW_ACK_MAP,
    audience: WorkflowStatusAudience = 'owner',
    options?: WorkflowStatusOptions
): WorkflowStatus {
    if (!ticket || typeof ticket !== 'object') {
        return 'NOT_READY';
    }

    const lifecycle = computeLifecycleStatus(ticket, options);
    if (lifecycle) return lifecycle;

    const waiveCounts = renewalWaivesResponseCounts(ticket, options);

    if (audience === 'partner') {
        if (!isPosrTicket(ticket) && isNgenCountsNotReady(ticket) && !waiveCounts) {
            return 'NOT_READY';
        }
        return 'ACTION_REQUIRED';
    }

    if (!isPosrTicket(ticket) && isNgenCountsNotReady(ticket) && !waiveCounts) {
        return 'NOT_READY';
    }

    if (isWorkflowAckValid(ticket, ackMap)) {
        return 'READY';
    }

    return 'ACTION_REQUIRED';
}

export function computeWorkflowStatusForPartnerTicket(
    ticket: Record<string, unknown> | null | undefined,
    options?: WorkflowStatusOptions
): WorkflowStatus {
    return computeWorkflowStatusForTicket(ticket, EMPTY_WORKFLOW_ACK_MAP, 'partner', options);
}

/** @deprecated Search stub inference retained for callers; no longer branches workflow logic. */
export function inferNgenSearchStubFromTicket(ticket: Record<string, unknown> | null | undefined): boolean {
    if (!ticket || typeof ticket !== 'object') return false;
    if (ticket.ngenSearchStub === true) return true;
    const refreshed = ticket.ngenFullDetailRefreshedAt;
    if (refreshed != null && String(refreshed).trim() !== '') return false;
    const ops = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
    return ops === 0;
}

export type FeedTicketStatus = 'READY' | 'NOT_READY';

/**
 * Feed workspace ticket status: Ready / Not ready only.
 * Expired/Cancelled → Ready. Active + inadequate nGen counts → Not ready.
 * Ignores photos, workflow ack, and ack-blocking operator codes.
 */
export function computeFeedTicketStatus(
    ticket: Record<string, unknown> | null | undefined
): FeedTicketStatus {
    if (!ticket || typeof ticket !== 'object') {
        return 'NOT_READY';
    }

    const lifecycle = computeLifecycleStatus(ticket);
    if (lifecycle === 'EXPIRED' || lifecycle === 'CANCELLED') {
        return 'READY';
    }

    if (isRenewalEnquiryStatus(ticket)) {
        return 'READY';
    }

    // POSR / public tickets: no nGen count gate in feed (same skip as owner workflow counts).
    if (isPosrTicket(ticket)) {
        return 'READY';
    }

    if (isNgenCountsNotReady(ticket)) {
        return 'NOT_READY';
    }

    return 'READY';
}
