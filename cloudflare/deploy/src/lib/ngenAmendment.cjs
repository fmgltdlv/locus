/**
 * nGen amendment submit: ticketCreationMethod=Amendment, ammendReason on outbound payload only.
 */
const {
    buildRenewalPayload,
    submitRenewalEnquiryPaced,
    truthyRenewalFlag,
} = require('./ngenRenewal.cjs');

const API_COMPUTED_DATES = `${require('./ngenClient.cjs').ORIGIN}/ngen.api/api/EnquiryValidation/GetCurrentUserEnquiryComputedDateValues`;
const { ORIGIN, ngenApiRequestHeaders } = require('./ngenClient.cjs');
const RENEWAL_REFERER_BASE = `${ORIGIN}/ngen.web/`;

/** Payload keys that must stay cloned from the live enquiry (scope + excavation). */
const LOCKED_AMENDMENT_PAYLOAD_KEYS = new Set([
    'additionalNotes',
    'spatialObjectNativeDescription',
    'spatialObjectNativeProjection',
    'IsSpatialObjectCircle',
    'activityId',
    'excavationMethodId',
    'excavationDepthId',
    'commencesOnDate',
    'commencesOnTime',
    'workLegalStartDate',
    'ticketCreationMethod',
    'clonedFromEnquiryID',
]);

function normalizePhone(s) {
    if (s == null) return '';
    return String(s).replace(/\D/g, '');
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function readJsonResponse(response) {
    const text = await response.text();
    const data = safeJsonParse(text);
    return { ok: response.ok, status: response.status, data, text };
}

function formatComputedDateParam(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const m =
        iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/) || [];
    if (m.length < 6) return null;
    const offset = m[6] && m[6] !== 'Z' ? m[6] : '+00:00';
    return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]} ${offset}`;
}

async function fetchComputedDateValuesForAmendment(fetchImpl, jar, enquiryDetails) {
    const purposeId =
        enquiryDetails?.purpose && enquiryDetails.purpose.id != null
            ? Number(enquiryDetails.purpose.id)
            : 0;
    const startDate =
        formatComputedDateParam(enquiryDetails?.workLegalStartDate) ||
        formatComputedDateParam(enquiryDetails?.commencementDate);
    const prevLegalDate =
        formatComputedDateParam(enquiryDetails?.workLegalStartDate) || startDate;
    const expirationTime = formatComputedDateParam(enquiryDetails?.ticketExpiration) || startDate;
    const u = new URL(API_COMPUTED_DATES);
    u.searchParams.set('enquiryPurposeId', String(Number.isFinite(purposeId) ? purposeId : 0));
    u.searchParams.set('startDate', startDate || '');
    u.searchParams.set('ticketCreationMethod', 'Amendment');
    u.searchParams.set('expirationTime', expirationTime || '');
    u.searchParams.set('prevLegalDate', prevLegalDate || '');
    const r = await fetchImpl(u.toString(), {
        method: 'GET',
        headers: ngenApiRequestHeaders(jar, RENEWAL_REFERER_BASE),
    });
    jar.addFromResponse(r);
    return readJsonResponse(r);
}

/**
 * Merge client-editable amendment fields onto a built payload.
 * Only job name and principal contact may be overridden; scope, location, polygon,
 * excavation, and commencement stay cloned from the live enquiry.
 * @param {object} payload
 * @param {object} [overrides]
 */
function applyAmendmentFieldOverrides(payload, overrides) {
    if (!payload || !overrides || typeof overrides !== 'object') return payload;
    if (overrides.userReference != null) payload.userReference = String(overrides.userReference).trim();
    if (overrides.principalContactName != null) {
        payload.principalContactName = String(overrides.principalContactName).trim();
    }
    if (overrides.principalContactMobile != null) {
        payload.principalContactMobile = normalizePhone(overrides.principalContactMobile);
    }
    return payload;
}

/**
 * @param {object} sourceEnquiry
 * @param {object} computedDates
 * @param {string|number} sourceJobNumber
 * @param {string} amendmentText
 * @param {object} [fieldOverrides]
 */
function buildAmendmentPayload(sourceEnquiry, computedDates, sourceJobNumber, amendmentText, fieldOverrides) {
    const payload = buildRenewalPayload(sourceEnquiry, computedDates, sourceJobNumber);
    payload.ticketCreationMethod = 'Amendment';
    payload.clonedFromEnquiryID = Number(sourceJobNumber);
    payload.ammendReason = String(amendmentText || '').trim();
    applyAmendmentFieldOverrides(payload, fieldOverrides);
    return payload;
}

async function submitAmendmentEnquiryPaced(fetchImpl, jar, payload, pacing) {
    return submitRenewalEnquiryPaced(fetchImpl, jar, payload, pacing);
}

function truthyAmendmentFlag(v) {
    return truthyRenewalFlag(v);
}

module.exports = {
    LOCKED_AMENDMENT_PAYLOAD_KEYS,
    fetchComputedDateValuesForAmendment,
    buildAmendmentPayload,
    applyAmendmentFieldOverrides,
    submitAmendmentEnquiryPaced,
    truthyAmendmentFlag,
};
