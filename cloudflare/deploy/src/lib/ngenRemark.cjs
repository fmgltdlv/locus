/**
 * nGen remark submit: ticketCreationMethod=Remark, ammendReason on outbound payload only.
 * Portal Remark captures also send manuallySelectedUtiliiesFromPreviousTicket (utility
 * authorityIds to retransmit to). Empty list triggers USAN:
 * "When Manually Selection for retransmit is enabled then at least one utility must be selected".
 */
const {
    buildRenewalPayload,
    applyRemarkSubmitDates,
    fetchComputedDateValuesForRenewal,
    submitRenewalEnquiryPaced,
    truthyRenewalFlag,
} = require('./ngenRenewal.cjs');
const { collectAuthorityIdsFromEnquiry } = require('./ngenOperatorSubmit.cjs');

const API_COMPUTED_DATES = `${require('./ngenClient.cjs').ORIGIN}/ngen.api/api/EnquiryValidation/GetCurrentUserEnquiryComputedDateValues`;
const { ORIGIN, ngenApiRequestHeaders } = require('./ngenClient.cjs');
const RENEWAL_REFERER_BASE = `${ORIGIN}/ngen.web/`;

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

/**
 * Remark uses same query shape as Renewal until dry-run confirms otherwise.
 */
async function fetchComputedDateValuesForRemark(fetchImpl, jar, enquiryDetails) {
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
    u.searchParams.set('ticketCreationMethod', 'Remark');
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
 * @param {object} sourceEnquiry
 * @param {object} computedDates
 * @param {string|number} sourceJobNumber
 * @param {string} remarkText
 * @param {{ authorityIds?: number[] }} [opts] — optional subset; default = all utilities on the enquiry
 */
function buildRemarkPayload(sourceEnquiry, computedDates, sourceJobNumber, remarkText, opts) {
    const payload = buildRenewalPayload(sourceEnquiry, computedDates, sourceJobNumber);
    payload.ticketCreationMethod = 'Remark';
    payload.clonedFromEnquiryID = Number(sourceJobNumber);
    payload.ammendReason = String(remarkText || '').trim();
    applyRemarkSubmitDates(payload, computedDates, sourceEnquiry?.enquiryDetails);

    const options = opts && typeof opts === 'object' ? opts : {};
    let authorityIds = Array.isArray(options.authorityIds)
        ? options.authorityIds.map(Number).filter(Number.isFinite)
        : [];
    if (!authorityIds.length) {
        authorityIds = collectAuthorityIdsFromEnquiry(sourceEnquiry);
    }
    payload.manuallySelectedUtiliiesFromPreviousTicket = [...new Set(authorityIds)];
    return payload;
}

async function submitRemarkEnquiry(fetchImpl, jar, payload, pacing) {
    return submitRenewalEnquiryPaced(fetchImpl, jar, payload, pacing);
}

async function submitRemarkEnquiryPaced(fetchImpl, jar, payload, pacing) {
    return submitRenewalEnquiryPaced(fetchImpl, jar, payload, pacing);
}

function truthyRemarkFlag(v) {
    return truthyRenewalFlag(v);
}

module.exports = {
    fetchComputedDateValuesForRemark,
    buildRemarkPayload,
    submitRemarkEnquiry,
    submitRemarkEnquiryPaced,
    truthyRemarkFlag,
};
