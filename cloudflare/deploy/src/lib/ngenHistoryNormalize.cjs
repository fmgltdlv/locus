/**
 * Map GetNotificationResponseHistoryAsync payloads to a small stable shape for UI (v1).
 * Field names vary by USAN version — we pick common keys. Attachments are intentionally omitted.
 */

/**
 * @param {unknown} value
 * @returns {boolean|null}
 */
function boolOrNull(value) {
    if (value === true || value === 1 || value === '1') return true;
    if (value === false || value === 0 || value === '0') return false;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
    }
    return null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function textOrNull(value) {
    if (value == null) return null;
    const s = String(value).trim();
    return s !== '' ? s : null;
}

/**
 * @param {object} item
 * @param {number} index
 * @returns {object}
 */
function normalizeHistoryItem(item, index) {
    if (item == null || typeof item !== 'object') {
        return {
            index,
            at: null,
            code: null,
            codeDescription: null,
            notesComment: null,
            comment: null,
            requestNumber: null,
            updatedBy: null,
            isDisputed: null,
            disputeLocateCode: null,
            enquiryId: null,
        };
    }
    const at =
        item.dateReceived ||
        item.DateReceived ||
        item.responseDate ||
        item.ResponseDate ||
        item.responseDateTime ||
        item.ResponseDateTime ||
        item.receivedOn ||
        item.ReceivedOn ||
        item.date ||
        item.createdAt ||
        item.updatedAt ||
        item.timestamp ||
        item.time ||
        null;
    const code =
        item.locateCode ||
        item.LocateCode ||
        item.responseCode ||
        item.ResponseCode ||
        item.code ||
        item.statusCode ||
        null;
    /** Primary line for the locate code (USAN: fullDescription). */
    const codeDescription =
        item.fullDescription ||
        item.FullDescription ||
        item.responseDescription ||
        item.ResponseDescription ||
        item.comment ||
        item.Comment ||
        null;
    /** Separate notes field from payload (USAN: notes). */
    let notesComment = null;
    if (item.notes !== undefined && item.notes !== null) {
        notesComment = String(item.notes);
    } else if (item.Notes !== undefined && item.Notes !== null) {
        notesComment = String(item.Notes);
    }
    if (notesComment !== null && notesComment.trim() === '') {
        notesComment = null;
    }
    const requestNumber = textOrNull(item.requestNumber ?? item.RequestNumber);
    const updatedBy = textOrNull(item.updatedBy ?? item.UpdatedBy);
    const isDisputed = boolOrNull(item.isDisputed ?? item.IsDisputed);
    const disputeLocateCode = textOrNull(item.disputeLocateCode ?? item.DisputeLocateCode);
    const enquiryId = textOrNull(item.enquiryId ?? item.EnquiryId);
    return {
        index,
        at: at != null ? String(at) : null,
        code: code != null ? String(code) : null,
        codeDescription: codeDescription != null ? String(codeDescription) : null,
        notesComment,
        /** @deprecated use codeDescription */
        comment: codeDescription != null ? String(codeDescription) : null,
        requestNumber,
        updatedBy,
        isDisputed,
        disputeLocateCode,
        enquiryId,
    };
}

/**
 * @param {Record<string, unknown>} byAuthority
 * @returns {{ utilities: { authorityId: string, error?: string, entries: object[] }[] }}
 */
function normalizeNgenNotificationHistory(byAuthority) {
    const utilities = [];
    const src = byAuthority && typeof byAuthority === 'object' ? byAuthority : {};
    for (const [aid, val] of Object.entries(src)) {
        if (Array.isArray(val)) {
            utilities.push({
                authorityId: aid,
                entries: val.map((item, i) => normalizeHistoryItem(item, i)),
            });
        } else if (val && typeof val === 'object' && val.error) {
            utilities.push({
                authorityId: aid,
                error: String(val.error),
                entries: [],
            });
        } else if (val != null) {
            utilities.push({
                authorityId: aid,
                entries: [normalizeHistoryItem(val, 0)],
            });
        }
    }
    return { utilities };
}

module.exports = {
    normalizeNgenNotificationHistory,
    normalizeHistoryItem,
};
