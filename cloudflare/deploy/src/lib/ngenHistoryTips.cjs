/**
 * Enquiry tip fingerprints for smart GetNotificationResponseHistoryAsync skip.
 * Tip = latest operatorResponse fields from GetCurrentUserEnquiryAsync merge
 * (statusCode + respondedAt + comment), keyed by authorityId.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function tipText(value) {
    if (value == null) return '';
    return String(value).trim();
}

/**
 * Stable fingerprint for one operatorResponse tip row.
 * @param {object|null|undefined} row
 * @returns {string}
 */
function buildNgenHistoryTipFingerprint(row) {
    if (!row || typeof row !== 'object') return '';
    return [tipText(row.statusCode), tipText(row.respondedAt), tipText(row.comment)].join('\u001f');
}

/**
 * @param {unknown} operatorResponses
 * @returns {Record<string, string>} authorityId → fingerprint
 */
function tipsByAuthorityFromOperatorResponses(operatorResponses) {
    /** @type {Record<string, string>} */
    const out = {};
    if (!Array.isArray(operatorResponses)) return out;
    for (const row of operatorResponses) {
        if (!row || typeof row !== 'object') continue;
        const aid = tipText(row.authorityId);
        if (!aid) continue;
        out[aid] = buildNgenHistoryTipFingerprint(row);
    }
    return out;
}

/**
 * @param {Record<string, string>|null|undefined} tipByAuthority
 * @returns {string[]}
 */
function authorityIdsFromTips(tipByAuthority) {
    if (!tipByAuthority || typeof tipByAuthority !== 'object') return [];
    return Object.keys(tipByAuthority).filter((k) => tipText(k) !== '');
}

/**
 * Decide which authorityIds need a fresh GetNotificationResponseHistoryAsync call.
 *
 * @param {object} opts
 * @param {Record<string, string>} opts.currentTips — from operatorResponses
 * @param {Record<string, { fingerprint: string, requestNumber?: string|null }>|null|undefined} opts.storedTips
 * @param {Set<string>|string[]|null|undefined} opts.authoritiesWithHistory
 * @param {string|null|undefined} opts.currentRequestNumber
 * @returns {{ fetchAuthorityIds: string[], skippedAuthorityIds: string[], reason?: string }}
 */
function selectAuthoritiesNeedingHistoryFetch(opts) {
    const currentTips = opts && opts.currentTips && typeof opts.currentTips === 'object' ? opts.currentTips : {};
    const currentAids = authorityIdsFromTips(currentTips);
    if (currentAids.length === 0) {
        return { fetchAuthorityIds: [], skippedAuthorityIds: [], reason: 'no_authorities' };
    }

    const currentRequestNumber = tipText(opts && opts.currentRequestNumber) || null;
    const storedTips = opts && opts.storedTips && typeof opts.storedTips === 'object' ? opts.storedTips : {};
    const storedAids = Object.keys(storedTips);
    const historySet = new Set(
        Array.isArray(opts && opts.authoritiesWithHistory)
            ? opts.authoritiesWithHistory.map((a) => tipText(a)).filter(Boolean)
            : opts && opts.authoritiesWithHistory instanceof Set
              ? [...opts.authoritiesWithHistory].map((a) => tipText(a)).filter(Boolean)
              : []
    );

    if (storedAids.length === 0) {
        return {
            fetchAuthorityIds: currentAids.slice(),
            skippedAuthorityIds: [],
            reason: 'no_stored_tips',
        };
    }

    if (currentRequestNumber) {
        for (const aid of storedAids) {
            const stored = storedTips[aid];
            const storedRn = tipText(stored && stored.requestNumber) || null;
            if (storedRn !== currentRequestNumber) {
                return {
                    fetchAuthorityIds: currentAids.slice(),
                    skippedAuthorityIds: [],
                    reason: 'request_number_changed',
                };
            }
        }
    }

    /** @type {string[]} */
    const fetchAuthorityIds = [];
    /** @type {string[]} */
    const skippedAuthorityIds = [];
    for (const aid of currentAids) {
        const stored = storedTips[aid];
        if (!historySet.has(aid)) {
            fetchAuthorityIds.push(aid);
            continue;
        }
        if (!stored || tipText(stored.fingerprint) === '') {
            fetchAuthorityIds.push(aid);
            continue;
        }
        if (tipText(stored.fingerprint) !== tipText(currentTips[aid])) {
            fetchAuthorityIds.push(aid);
            continue;
        }
        skippedAuthorityIds.push(aid);
    }

    return { fetchAuthorityIds, skippedAuthorityIds };
}

/**
 * True when client-side history can be reused without POST.
 * @param {object|null|undefined} history — ngenResponseHistory / providerResponseHistory
 * @param {unknown} operatorResponses
 * @param {string|null|undefined} currentRequestNumber — ticketNumberFull when known
 * @returns {boolean}
 */
function ngenResponseHistoryTipsMatchTicket(history, operatorResponses, currentRequestNumber) {
    if (!history || typeof history !== 'object') return false;
    const tipByAuthority = history.tipByAuthority;
    if (!tipByAuthority || typeof tipByAuthority !== 'object') return false;
    const currentTips = tipsByAuthorityFromOperatorResponses(operatorResponses);
    const currentAids = authorityIdsFromTips(currentTips);
    if (currentAids.length === 0) return false;

    const histRn = tipText(history.requestNumber) || null;
    const curRn = tipText(currentRequestNumber) || null;
    if (histRn && curRn && histRn !== curRn) return false;

    for (const aid of currentAids) {
        if (tipText(tipByAuthority[aid]) !== tipText(currentTips[aid])) return false;
    }
    return true;
}

/**
 * Merge freshly fetched utilities into an existing normalized history object.
 * @param {object|null|undefined} existingHistory
 * @param {object} fetchedHistory — result.history from a partial fetch
 * @param {string[]} fetchedAuthorityIds
 * @returns {object}
 */
function mergeNgenResponseHistoryUtilities(existingHistory, fetchedHistory, fetchedAuthorityIds) {
    const fetchedAt =
        (fetchedHistory && tipText(fetchedHistory.fetchedAt)) ||
        (existingHistory && tipText(existingHistory.fetchedAt)) ||
        new Date().toISOString();
    const requestNumber =
        (fetchedHistory && tipText(fetchedHistory.requestNumber)) ||
        (existingHistory && tipText(existingHistory.requestNumber)) ||
        null;

    /** @type {Map<string, object>} */
    const byAid = new Map();
    const existingUtils =
        existingHistory &&
        existingHistory.normalized &&
        Array.isArray(existingHistory.normalized.utilities)
            ? existingHistory.normalized.utilities
            : [];
    for (const util of existingUtils) {
        if (!util || typeof util !== 'object') continue;
        const aid = tipText(util.authorityId);
        if (!aid) continue;
        byAid.set(aid, util);
    }

    const fetchedUtils =
        fetchedHistory &&
        fetchedHistory.normalized &&
        Array.isArray(fetchedHistory.normalized.utilities)
            ? fetchedHistory.normalized.utilities
            : [];
    const fetchedSet = new Set((fetchedAuthorityIds || []).map((a) => tipText(a)).filter(Boolean));
    for (const util of fetchedUtils) {
        if (!util || typeof util !== 'object') continue;
        const aid = tipText(util.authorityId);
        if (!aid) continue;
        if (fetchedSet.size > 0 && !fetchedSet.has(aid)) continue;
        byAid.set(aid, util);
    }

    const tipByAuthority = {
        ...((existingHistory && existingHistory.tipByAuthority) || {}),
        ...((fetchedHistory && fetchedHistory.tipByAuthority) || {}),
    };

    return {
        normalized: { utilities: Array.from(byAid.values()) },
        fetchedAt,
        requestNumber,
        tipByAuthority,
    };
}

module.exports = {
    tipText,
    buildNgenHistoryTipFingerprint,
    tipsByAuthorityFromOperatorResponses,
    authorityIdsFromTips,
    selectAuthoritiesNeedingHistoryFetch,
    ngenResponseHistoryTipsMatchTicket,
    mergeNgenResponseHistoryUtilities,
};
