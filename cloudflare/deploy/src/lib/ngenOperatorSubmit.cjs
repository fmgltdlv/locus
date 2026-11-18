/**
 * nGen operator-notification submits: Exposed, Damage, FollowUp, Disputed.
 * Mirrors ngenRemark.cjs — extends buildRenewalPayload with operator selection fields.
 */
const {
    buildRenewalPayload,
    applyComputedSubmitDates,
    submitRenewalEnquiryPaced,
    truthyRenewalFlag,
} = require('./ngenRenewal.cjs');
const { ORIGIN, ngenApiRequestHeaders } = require('./ngenClient.cjs');

const API_COMPUTED_DATES = `${ORIGIN}/ngen.api/api/EnquiryValidation/GetCurrentUserEnquiryComputedDateValues`;
const RENEWAL_REFERER_BASE = `${ORIGIN}/ngen.web/`;

/** @type {Record<string, { ticketCreationMethod: string, canBeFlag: string }>} */
const OPERATOR_SUBMIT_CONFIG = {
    exposed: { ticketCreationMethod: 'Exposed', canBeFlag: 'canBeExposed' },
    damage: { ticketCreationMethod: 'Damage', canBeFlag: 'canBeDamage' },
    follow_up: { ticketCreationMethod: 'FollowUp', canBeFlag: 'canBeFollowUp' },
    disputed: { ticketCreationMethod: 'Disputed', canBeFlag: 'canBeDisputed' },
    no_response: { ticketCreationMethod: 'NoResponse', canBeFlag: 'canBeNoResponse' },
};

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

function authorityFromNotification(n) {
    if (!n || typeof n !== 'object') return null;
    const a = n.authority || n.Authority;
    return a && typeof a === 'object' ? a : null;
}

function authorityIdFromNotificationRow(n) {
    if (!n || typeof n !== 'object') return null;
    const authority = authorityFromNotification(n);
    if (authority) {
        const raw = authority.id ?? authority.Id ?? authority.ID;
        if (raw != null) {
            const s = String(raw).trim();
            if (s) return s;
        }
    }
    const direct = n.authorityId ?? n.AuthorityId;
    if (direct != null) {
        const s = String(direct).trim();
        if (s) return s;
    }
    return null;
}

/**
 * @param {number[]} raw
 * @returns {number[]}
 */
function normalizeAuthorityIds(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const v of raw) {
        const n = Number(v);
        if (Number.isFinite(n)) out.push(n);
    }
    return [...new Set(out)];
}

/**
 * @param {object} enquiry
 * @returns {number[]}
 */
function collectAuthorityIdsFromEnquiry(enquiry) {
    const notifications = enquiry?.notifications || enquiry?.Notifications || [];
    if (!Array.isArray(notifications)) return [];
    const ids = [];
    for (const n of notifications) {
        const id = authorityIdFromNotificationRow(n);
        if (id == null) continue;
        const num = Number(id);
        if (Number.isFinite(num)) ids.push(num);
    }
    return [...new Set(ids)];
}

/**
 * @param {number[]} authorityIds
 * @param {object} enquiry
 * @returns {{ ok: boolean, message?: string }}
 */
function validateAuthorityIds(authorityIds, enquiry) {
    const normalized = normalizeAuthorityIds(authorityIds);
    if (!normalized.length) {
        return { ok: false, message: 'At least one operator authorityId is required' };
    }
    const valid = collectAuthorityIdsFromEnquiry(enquiry);
    if (!valid.length) {
        return { ok: false, message: 'No operator authority ids on live enquiry' };
    }
    for (const id of normalized) {
        if (!valid.includes(id)) {
            return { ok: false, message: `authorityId ${id} is not on this ticket` };
        }
    }
    return { ok: true, authorityIds: normalized };
}

/**
 * @param {object} sourceEnquiry
 * @param {object} computedDates
 * @param {string|number} sourceJobNumber
 * @param {{ method?: string, ticketCreationMethod?: string, text?: string, authorityIds?: number[], isOperatorFault?: boolean }} opts
 */
function buildOperatorSubmitPayload(sourceEnquiry, computedDates, sourceJobNumber, opts) {
    const method = opts.method || opts.ticketCreationMethod;
    const payload = buildRenewalPayload(sourceEnquiry, computedDates, sourceJobNumber);
    payload.ticketCreationMethod = method;
    payload.clonedFromEnquiryID = Number(sourceJobNumber);
    payload.ammendReason = String(opts.text || '').trim();
    payload.manuallySelectedUtiliiesFromPreviousTicket = normalizeAuthorityIds(opts.authorityIds || []);
    payload.isOperatorFault = opts.isOperatorFault === true;
    applyComputedSubmitDates(payload, computedDates, sourceEnquiry?.enquiryDetails);
    return payload;
}

/**
 * @param {Function} fetchImpl
 * @param {object} jar
 * @param {object} enquiryDetails
 * @param {string} ticketCreationMethod
 */
async function fetchComputedDateValuesForOperatorSubmit(fetchImpl, jar, enquiryDetails, ticketCreationMethod) {
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
    u.searchParams.set('ticketCreationMethod', String(ticketCreationMethod || ''));
    u.searchParams.set('expirationTime', expirationTime || '');
    u.searchParams.set('prevLegalDate', prevLegalDate || '');
    const r = await fetchImpl(u.toString(), {
        method: 'GET',
        headers: ngenApiRequestHeaders(jar, RENEWAL_REFERER_BASE),
    });
    jar.addFromResponse(r);
    return readJsonResponse(r);
}

async function submitOperatorSubmitEnquiryPaced(fetchImpl, jar, payload, pacing) {
    return submitRenewalEnquiryPaced(fetchImpl, jar, payload, pacing);
}

function truthyOperatorSubmitFlag(v) {
    return truthyRenewalFlag(v);
}

function getOperatorSubmitConfig(operation) {
    return OPERATOR_SUBMIT_CONFIG[operation] || null;
}

function truthyCanBeFlag(details, flagName) {
    if (!details || !flagName) return false;
    return truthyOperatorSubmitFlag(details[flagName]);
}

module.exports = {
    OPERATOR_SUBMIT_CONFIG,
    normalizeAuthorityIds,
    collectAuthorityIdsFromEnquiry,
    validateAuthorityIds,
    buildOperatorSubmitPayload,
    fetchComputedDateValuesForOperatorSubmit,
    submitOperatorSubmitEnquiryPaced,
    truthyOperatorSubmitFlag,
    getOperatorSubmitConfig,
    truthyCanBeFlag,
};
