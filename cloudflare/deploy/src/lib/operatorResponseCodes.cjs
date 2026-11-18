/**
 * Operator response code → workflow status (see computeWorkflowStatus.ts).
 */

const DEFAULT_NOT_READY_CODES = Object.freeze([
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
]);

const DEFAULT_ACTION_REQUIRED_CODES = Object.freeze([
    '002',
    '011',
    '012',
    '031',
    '034',
    '041',
    '042',
]);

const DEFAULT_ACK_BLOCKING_CODES = Object.freeze([
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
]);

const MAX_OPERATOR_CODES_PER_LIST = 64;
const MAX_OPERATOR_CODE_LENGTH = 8;

function normalizeSingleOperatorCode(value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (!s || s.length > MAX_OPERATOR_CODE_LENGTH) return '';
    return s;
}

/**
 * @param {unknown} raw string, array, or null
 * @returns {string[]|null} null = use platform defaults
 */
function normalizeOperatorCodeList(raw) {
    if (raw == null) return null;
    let items = [];
    if (Array.isArray(raw)) {
        items = raw;
    } else if (typeof raw === 'string') {
        items = raw.split(/[\s,;]+/);
    } else {
        return null;
    }
    const out = [];
    const seen = new Set();
    for (const item of items) {
        const code = normalizeSingleOperatorCode(item);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push(code);
        if (out.length >= MAX_OPERATOR_CODES_PER_LIST) break;
    }
    return out.length ? out : null;
}

function listsEqual(a, b) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function isDefaultNotReadyCodes(list) {
    return list == null || listsEqual(list, DEFAULT_NOT_READY_CODES);
}

function isDefaultActionRequiredCodes(list) {
    return list == null || listsEqual(list, DEFAULT_ACTION_REQUIRED_CODES);
}

function isDefaultAckBlockingCodes(list) {
    return list == null || listsEqual(list, DEFAULT_ACK_BLOCKING_CODES);
}

function isDefaultOperatorCodeLists(policy) {
    if (!policy || typeof policy !== 'object') return true;
    return (
        isDefaultNotReadyCodes(policy.notReadyCodes) &&
        isDefaultActionRequiredCodes(policy.actionRequiredCodes) &&
        isDefaultAckBlockingCodes(policy.ackBlockingCodes)
    );
}

/**
 * @param {{ notReadyCodes?: string[]|null, actionRequiredCodes?: string[]|null, ackBlockingCodes?: string[]|null }|null|undefined} policy
 */
function resolveOperatorCodeLists(policy) {
    const src = policy && typeof policy === 'object' ? policy : {};
    return {
        notReadyCodes:
            src.notReadyCodes != null && Array.isArray(src.notReadyCodes)
                ? src.notReadyCodes
                : DEFAULT_NOT_READY_CODES,
        actionRequiredCodes:
            src.actionRequiredCodes != null && Array.isArray(src.actionRequiredCodes)
                ? src.actionRequiredCodes
                : DEFAULT_ACTION_REQUIRED_CODES,
        ackBlockingCodes:
            src.ackBlockingCodes != null && Array.isArray(src.ackBlockingCodes)
                ? src.ackBlockingCodes
                : DEFAULT_ACK_BLOCKING_CODES,
    };
}

function getOperatorStatusFromCode(responseCode, codeLists) {
    if (!responseCode) return 'READY';
    const code = String(responseCode).trim();
    const lists = resolveOperatorCodeLists(codeLists);
    if (lists.notReadyCodes.includes(code)) return 'NOT_READY';
    if (lists.actionRequiredCodes.includes(code)) return 'ACTION_REQUIRED';
    return 'READY';
}

function ticketHasAckBlockingOperatorCodesWithLists(
    ticket,
    codeLists
) {
    const lists = resolveOperatorCodeLists(codeLists);
    const rows = ticket && Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const code = row.statusCode ?? row.status_code ?? row.responseCode;
        if (code == null || String(code).trim() === '') continue;
        const normalized = String(code).trim();
        if (lists.ackBlockingCodes.includes(normalized)) return true;
    }
    return false;
}

function formatOperatorCodeListForInput(list) {
    const resolved = list != null && Array.isArray(list) ? list : DEFAULT_NOT_READY_CODES;
    return resolved.join(', ');
}

module.exports = {
    DEFAULT_NOT_READY_CODES,
    DEFAULT_ACTION_REQUIRED_CODES,
    DEFAULT_ACK_BLOCKING_CODES,
    MAX_OPERATOR_CODES_PER_LIST,
    normalizeOperatorCodeList,
    isDefaultNotReadyCodes,
    isDefaultActionRequiredCodes,
    isDefaultAckBlockingCodes,
    isDefaultOperatorCodeLists,
    resolveOperatorCodeLists,
    getOperatorStatusFromCode,
    ticketHasAckBlockingOperatorCodesWithLists,
    formatOperatorCodeListForInput,
};
