/**
 * Job misc compliance date attention rules.
 * Keep in sync with frontend/js/tickets/jobComplianceDates.js
 *
 * Future: holiday-aware business days (not yet implemented).
 * ("Holiday-aware business days (compliance + commencement)").
 */
const { ymdInTimeZone, addWeekdaysFromYmd, USAN_TZ } = require('./ticketCommencementDates.cjs');

const JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS = 3;
const JOB_COMPLIANCE_DATE_NA = 'N/A';

/**
 * @param {string|null|undefined} dateStr
 * @returns {boolean}
 */
function isComplianceDateNa(dateStr) {
    if (dateStr == null) return false;
    return /^n\/a$/i.test(String(dateStr).trim());
}

/**
 * Unset dates require review; explicit N/A counts as set.
 * @param {string|null|undefined} dateStr
 * @returns {boolean}
 */
function isComplianceDateMissing(dateStr) {
    if (dateStr == null) return true;
    return String(dateStr).trim() === '';
}

/**
 * @param {string|null|undefined} display
 * @returns {string|null}
 */
function normalizeJobNameKey(display) {
    if (!display) return null;
    const trimmed = String(display).trim();
    return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Attention when a compliance date is today, overdue, or within the next N business days.
 * @param {string|null|undefined} dateStr
 * @param {Date} [now]
 * @returns {boolean}
 */
function isComplianceDateAttentionRequired(dateStr, now) {
    if (dateStr == null) return false;
    const d = String(dateStr).trim();
    if (isComplianceDateNa(d)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const todayYmd = ymdInTimeZone(ref, USAN_TZ);
    const thresholdYmd = addWeekdaysFromYmd(todayYmd, JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS);
    if (!thresholdYmd) return false;
    return d <= thresholdYmd;
}

/**
 * @param {object|null|undefined} compliance
 * @returns {boolean}
 */
function computeJobComplianceAttentionRequired(compliance) {
    const c = compliance || {};
    const standardFields = [
        c.permitExpiration,
        c.trafficControlPermitExpiration,
        c.thirdPartyInspectionDate,
    ];
    for (const field of standardFields) {
        if (isComplianceDateMissing(field)) return true;
    }
    if (isComplianceDateAttentionRequired(c.permitExpiration)) return true;
    if (isComplianceDateAttentionRequired(c.trafficControlPermitExpiration)) return true;
    if (isComplianceDateAttentionRequired(c.thirdPartyInspectionDate)) return true;
    const items = Array.isArray(c.customItems) ? c.customItems : [];
    for (const item of items) {
        if (!item) continue;
        const label = item.label != null ? String(item.label).trim() : '';
        if (!label) continue;
        if (isComplianceDateMissing(item.date)) return true;
        if (isComplianceDateAttentionRequired(item.date)) return true;
    }
    return false;
}

/**
 * @param {object|null|undefined} row
 * @returns {object|null}
 */
function mapJobComplianceRow(row) {
    if (!row) return null;
    let customItems = [];
    try {
        const parsed = row.custom_items_json ? JSON.parse(String(row.custom_items_json)) : [];
        customItems = Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
        customItems = [];
    }
    return {
        permitExpiration: row.permit_expiration || null,
        trafficControlPermitExpiration: row.traffic_control_permit_expiration || null,
        thirdPartyInspectionDate: row.third_party_inspection_date || null,
        thirdPartyInspectionNotes: row.third_party_inspection_notes || null,
        generalNotes: row.general_notes || null,
        customItems,
        updatedAt: row.updated_at || null,
        updatedByName: row.updated_by_display_name || null,
    };
}

/**
 * @param {Array<object>|null|undefined} complianceRows
 * @returns {Map<string, boolean>}
 */
function buildComplianceAttentionByJobKey(complianceRows) {
    const map = new Map();
    for (const row of complianceRows || []) {
        const key = row && row.job_name_normalized != null ? String(row.job_name_normalized).trim() : '';
        if (!key) continue;
        map.set(key, computeJobComplianceAttentionRequired(mapJobComplianceRow(row)));
    }
    return map;
}

/**
 * @param {string|null|undefined} userReference
 * @param {Map<string, boolean>|null|undefined} attentionByJobKey
 * @returns {boolean}
 */
function complianceAttentionForTicketJobReference(userReference, attentionByJobKey) {
    const key = normalizeJobNameKey(userReference);
    if (!key || !attentionByJobKey) return false;
    return attentionByJobKey.get(key) === true;
}

module.exports = {
    JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS,
    JOB_COMPLIANCE_DATE_NA,
    normalizeJobNameKey,
    isComplianceDateNa,
    isComplianceDateMissing,
    isComplianceDateAttentionRequired,
    computeJobComplianceAttentionRequired,
    mapJobComplianceRow,
    buildComplianceAttentionByJobKey,
    complianceAttentionForTicketJobReference,
};
