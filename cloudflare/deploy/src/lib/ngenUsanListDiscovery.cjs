/**
 * Discover nGen enquiry list rows for USAN poll: paged SearchCurrentUserEnquiries,
 * profile recentEnquiries (GetCurrentUserEnquiry per id), and recent app create submits (newEnquiryId).
 */
const {
    withNgenAuthRetry,
    buildSearchCurrentUserEnquiriesBody,
    postSearchCurrentUserEnquiriesAsync,
    fetchCurrentUserProfile,
    fetchEnquirySearch,
    extractEnquiriesFromSearchResponse,
    enquirySearchToListItem,
    REFERER_NGEN_HISTORY,
} = require('./ngenClient.cjs');

function ngenThrottleMs() {
    const raw = parseInt(String(process.env.USAN_POLL_NGEN_THROTTLE_MS || '10'), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 10;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Map<string, object>} byRequestNumber
 * @param {object} item
 * @returns {boolean} true when newly added
 */
function addDiscoveredListItem(byRequestNumber, item) {
    if (!item || typeof item !== 'object') return false;
    const ed = item.enquiryDetails || item.EnquiryDetails;
    const rn = ed && ed.requestNumber != null ? String(ed.requestNumber).trim() : '';
    if (!rn || byRequestNumber.has(rn)) return false;
    byRequestNumber.set(rn, item);
    return true;
}

function jobNumberAlreadyDiscovered(byRequestNumber, jobNumber) {
    const jn = Number(jobNumber);
    if (!Number.isFinite(jn)) return false;
    for (const item of byRequestNumber.values()) {
        const ed = item && (item.enquiryDetails || item.EnquiryDetails);
        const j = ed && (ed.jobNumber ?? ed.JobNumber);
        if (j != null && Number(j) === jn) return true;
    }
    return false;
}

function profileSkipAllowed() {
    return String(process.env.NGEN_USAN_POLL_SKIP_PROFILE || '1').trim() !== '0';
}

/**
 * @param {import('node-fetch')} fetchImpl
 * @param {{ user: string, pass: string }} svc
 * @param {{ from: string, to: string }} rangeIso
 * @param {{ pageLength?: number, maxSearchPages?: number, pendingEnquiryIds?: number[] }} [opts]
 * @returns {Promise<{ items: object[], stats: object }>}
 */
async function discoverNgenEnquiriesForPoll(fetchImpl, svc, rangeIso, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const pageLength = Math.min(100, Math.max(1, parseInt(String(o.pageLength || '100'), 10) || 100));
    const maxSearchPages = Math.min(100, Math.max(1, parseInt(String(o.maxSearchPages || '20'), 10) || 20));
    const pendingIds = Array.isArray(o.pendingEnquiryIds)
        ? o.pendingEnquiryIds.filter((id) => id != null && Number.isFinite(Number(id))).map((id) => Number(id))
        : [];
    const throttleMs = ngenThrottleMs();
    const searchStartedAt = Date.now();

    /** @type {Map<string, object>} */
    const byRequestNumber = new Map();
    const stats = {
        searchPages: 0,
        searchRows: 0,
        searchOutcome: null,
        searchMessage: null,
        profileRecentCount: 0,
        profileFetchedCount: 0,
        profileSkipped: false,
        submitEnquiryIdCount: 0,
        submitEnquiryFetchedCount: 0,
        mergedTotal: 0,
        searchMs: 0,
        searchTruncated: false,
    };

    await withNgenAuthRetry(fetchImpl, svc.user, svc.pass, null, async ({ jar, refererApp }) => {
        let lastPageRowCount = 0;
        for (let page = 1; page <= maxSearchPages; page++) {
            const body = buildSearchCurrentUserEnquiriesBody(rangeIso, page, pageLength, {});
            const data = await postSearchCurrentUserEnquiriesAsync(fetchImpl, jar, REFERER_NGEN_HISTORY, body);
            if (stats.searchOutcome == null && data && data.outcome != null) {
                stats.searchOutcome = data.outcome;
                stats.searchMessage = data.message != null ? String(data.message) : null;
            }
            if (page === 1 && data && data.outcome === false) {
                const detail =
                    data.result && Array.isArray(data.result)
                        ? data.result
                              .map((r) => (r && r.value != null ? String(r.value) : ''))
                              .filter(Boolean)
                              .join('; ')
                        : stats.searchMessage || 'SearchCurrentUserEnquiriesAsync validation failed';
                throw new Error(detail);
            }
            const list = extractEnquiriesFromSearchResponse(data);
            stats.searchPages = page;
            stats.searchRows += list.length;
            lastPageRowCount = list.length;
            for (const item of list) {
                addDiscoveredListItem(byRequestNumber, item);
            }
            if (list.length < pageLength) break;
            if (page === maxSearchPages) stats.searchTruncated = true;
        }
        stats.searchMs = Date.now() - searchStartedAt;

        const skipProfile =
            profileSkipAllowed() &&
            pendingIds.length === 0 &&
            !stats.searchTruncated &&
            stats.searchRows > 0;

        let profile = null;
        if (!skipProfile) {
            try {
                profile = await fetchCurrentUserProfile(fetchImpl, jar, refererApp);
            } catch (e) {
                console.warn('[ngenUsanListDiscovery] GetCurrentUserProfileAsync:', e && e.message ? e.message : e);
                profile = null;
            }
        } else {
            stats.profileSkipped = true;
        }

        const recent = profile
            ? Array.isArray(profile.recentEnquiries)
                ? profile.recentEnquiries
                : Array.isArray(profile.RecentEnquiries)
                  ? profile.RecentEnquiries
                  : []
            : [];
        stats.profileRecentCount = recent.length;

        const enquiryIdsToFetch = new Set();
        for (const r of recent) {
            if (!r || typeof r !== 'object') continue;
            const jn = r.jobNumber ?? r.JobNumber;
            if (jn == null || !Number.isFinite(Number(jn))) continue;
            const numJn = Number(jn);
            const rn = r.requestNumber ?? r.RequestNumber;
            if (rn != null && byRequestNumber.has(String(rn).trim())) continue;
            if (jobNumberAlreadyDiscovered(byRequestNumber, numJn)) continue;
            enquiryIdsToFetch.add(numJn);
        }

        for (const id of pendingIds) {
            if (!jobNumberAlreadyDiscovered(byRequestNumber, id)) {
                enquiryIdsToFetch.add(id);
            }
        }
        stats.submitEnquiryIdCount = pendingIds.length;

        for (const jn of enquiryIdsToFetch) {
            try {
                const enquiry = await fetchEnquirySearch(fetchImpl, jar, refererApp, jn);
                const item = enquirySearchToListItem(enquiry);
                if (item && addDiscoveredListItem(byRequestNumber, item)) {
                    if (pendingIds.includes(jn)) stats.submitEnquiryFetchedCount++;
                    else stats.profileFetchedCount++;
                }
            } catch (e) {
                console.warn('[ngenUsanListDiscovery] GetCurrentUserEnquiryAsync', jn, e && e.message ? e.message : e);
            }
            if (throttleMs > 0) await sleep(throttleMs);
        }
    });

    stats.mergedTotal = byRequestNumber.size;
    return { items: [...byRequestNumber.values()], stats };
}

module.exports = {
    discoverNgenEnquiriesForPoll,
    addDiscoveredListItem,
    extractEnquiriesFromSearchResponse,
};
