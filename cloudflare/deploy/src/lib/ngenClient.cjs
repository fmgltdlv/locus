/**
 * Nevada ngen.api only: **GetAccessToken** (Bearer) + documented JSON endpoints. No MVC / ngen.web form login.
 */
const { parseSetCookie } = require('set-cookie-parser');
const {
    getCached,
    setCached,
    invalidateAsync: invalidateNgenAccessTokenCache,
    normalizeCacheKey,
    getCachedDurable,
    setCachedDurable,
    touchCachedDurable,
    tryBeginTokenFetch,
    releaseTokenFetch,
    waitForDurableToken,
} = require('./ngenAccessTokenCache.cjs');

const ORIGIN = 'https://onecallnv.undergroundservicealert.org';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JSON_ACCEPT = 'application/json, text/plain, */*';

const API_PROFILE = `${ORIGIN}/ngen.api/api/UserProfile/GetCurrentUserProfileAsync`;
const API_STATIC_MAP = `${ORIGIN}/ngen.api/api/Document/GetEnquiryStaticMapAsync`;
const API_ENQUIRY = `${ORIGIN}/ngen.api/api/Enquiry/GetCurrentUserEnquiryAsync`;
const API_SEARCH_ENQUIRIES = `${ORIGIN}/ngen.api/api/Enquiry/SearchCurrentUserEnquiriesAsync`;
const REFERER_NGEN_HISTORY = `${ORIGIN}/ngen.web/History`;
const API_NOTIFICATION_RESPONSE_HISTORY = `${ORIGIN}/ngen.api/api/Enquiry/GetNotificationResponseHistoryAsync`;
const API_REVERSE_GEOCODE_CURRENT_USER = `${ORIGIN}/ngen.api/api/Geocode/ReverseGeocodeCurrentUserAsync`;
const API_GEO_SEARCH_BY_STREET = `${ORIGIN}/ngen.api/api/GeoSearch/SearchByStreetAsync`;
const API_CONFIRMATION_PDF = `${ORIGIN}/ngen.api/api/Document/GetEnquiryCallerConfirmationSheetAsync`;
const API_DOWNLOAD_JOB_PACK = `${ORIGIN}/ngen.api/api/Posr/DownloadJobPack`;
/** Swagger: POST ClientCredentials → AccessToken { token } */
const API_GET_ACCESS_TOKEN = `${ORIGIN}/ngen.api/api/Token/GetAccessToken`;

class CookieJar {
    constructor() {
        /** @type {Record<string, string>} */
        this.map = {};
    }
    addFromResponse(response) {
        const cookies = parseSetCookie(response, { decodeValues: false });
        for (const c of cookies) {
            if (c && c.name) this.map[c.name] = c.value;
        }
    }
    header() {
        return Object.entries(this.map)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
}

function ngenApiRequestHeaders(jar, referer) {
    const headers = {
        Accept: JSON_ACCEPT,
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: jar.header(),
        Referer: referer,
        'onecall-service': 'onecallngenweb',
        'g-recaptcha-response-v2': '',
        'g-recaptcha-response-v3': '',
        'User-Agent': USER_AGENT,
        // Match browser CORS preflight / fetch (some gateways behave better with these present)
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    };
    const auth = jar.map['OneCallAuthToken'];
    if (auth) {
        headers.Authorization = `Bearer ${auth}`;
    }
    return headers;
}

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function strOrNullForSearch(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/**
 * @param {Array<Record<string, unknown>>} recent
 * @param {string} raw
 * @returns {number|null}
 */
function resolveJobNumberFromRecent(recent, raw) {
    const s = raw.trim();
    if (!s) return null;
    const row = parseInt(s, 10);
    if (
        String(row) === s &&
        row >= 1 &&
        row <= recent.length &&
        recent[row - 1] &&
        recent[row - 1].jobNumber != null
    ) {
        return Number(recent[row - 1].jobNumber);
    }
    if (/^\d+$/.test(s)) {
        const j = Number(s);
        return Number.isFinite(j) ? j : null;
    }
    const byReq = recent.find((t) => String(t.requestNumber) === s);
    if (byReq && byReq.jobNumber != null) return Number(byReq.jobNumber);
    return null;
}

/**
 * @param {*} profile
 * @param {string} requestNumber
 * @param {number|null|undefined} manualJobNumber
 * @returns {number|null}
 */
function resolveEnquiryIdFromProfile(profile, requestNumber, manualJobNumber) {
    if (manualJobNumber != null && Number.isFinite(Number(manualJobNumber))) {
        return Number(manualJobNumber);
    }
    const recent = Array.isArray(profile.recentEnquiries) ? profile.recentEnquiries : [];
    const j = resolveJobNumberFromRecent(recent, requestNumber);
    return j != null && Number.isFinite(j) ? j : null;
}

/**
 * POST GetAccessToken — JSON credentials → Bearer token (no MVC form).
 * @param {import('node-fetch')} fetch
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ token: string, raw: object }>}
 */
async function fetchAccessToken(fetch, username, password) {
    const u = String(username || '').trim();
    const p = password != null ? String(password) : '';
    if (!u || !p) {
        throw new Error('username and password are required for GetAccessToken');
    }
    const r = await fetch(API_GET_ACCESS_TOKEN, {
        method: 'POST',
        headers: {
            Accept: JSON_ACCEPT,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            'onecall-service': 'onecallngenweb',
        },
        body: JSON.stringify({ username: u, password: p }),
    });
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`GetAccessToken failed: ${r.status} ${text.slice(0, 500)}`);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        throw new Error('GetAccessToken response was not JSON');
    }
    const token = payload && typeof payload.token === 'string' ? payload.token.trim() : '';
    if (!token) {
        throw new Error('GetAccessToken: missing token in response');
    }
    return { token, raw: payload };
}

/**
 * nGen API auth for server/scripts: **Bearer token only** (from GetAccessToken). No MVC / browser session cookies.
 * @param {string} token - JWT from {@link fetchAccessToken}
 * @param {string} [cacheKey] - optional normalized username for debugging (`jar.ngenCacheKey`)
 * @returns {CookieJar}
 */
function createJarWithOneCallBearerToken(token, cacheKey) {
    const jar = new CookieJar();
    const t = String(token == null ? '' : token).trim();
    if (t) {
        jar.map['OneCallAuthToken'] = t;
    }
    if (cacheKey != null && String(cacheKey).trim() !== '') {
        jar.ngenCacheKey = String(cacheKey).trim();
    }
    return jar;
}

/**
 * Referer header expected by ngen.api (matches browser when viewing an enquiry).
 * @param {string|number|null|undefined} jobNumberForReferer - enquiry / job id, or omit for generic ngen.web root
 * @returns {string}
 */
function refererDefaultNgenWeb(jobNumberForReferer) {
    if (jobNumberForReferer != null && String(jobNumberForReferer).trim() !== '') {
        return `${ORIGIN}/ngen.web/?enquiryId=${encodeURIComponent(String(jobNumberForReferer).trim())}`;
    }
    return `${ORIGIN}/ngen.web/`;
}

/**
 * True if an nGen API failure message indicates the Bearer was rejected (retry after forced GetAccessToken).
 * @param {unknown} messageOrError
 * @returns {boolean}
 */
function isNgenUnauthorizedError(messageOrError) {
    const msg =
        messageOrError != null && typeof messageOrError === 'object' && messageOrError.message != null
            ? String(messageOrError.message)
            : String(messageOrError);
    return /\b401\b/.test(msg) || /\b403\b/.test(msg);
}

/**
 * Run `fn` with password auth; on first **401/403** from nGen work, invalidate cached token, force refresh once, retry `fn` once.
 * @param {import('node-fetch')} fetch
 * @param {string} username
 * @param {string} password
 * @param {string|number|null|undefined} jobNumberForReferer
 * @param {(auth: { jar: CookieJar, refererApp: string, token: string }) => Promise<unknown>} fn
 */
async function withNgenAuthRetry(fetch, username, password, jobNumberForReferer, fn) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const auth = await authenticateNgenApiWithPassword(
                fetch,
                username,
                password,
                jobNumberForReferer,
                attempt > 0 ? { forceRefresh: true } : undefined
            );
            return await fn(auth);
        } catch (e) {
            lastErr = e;
            if (attempt === 0 && isNgenUnauthorizedError(e)) {
                await invalidateNgenAccessTokenCache(username);
                continue;
            }
            throw e;
        }
    }
    throw lastErr;
}

/**
 * POST GetAccessToken then attach token to jar — **no** MVC login. Use for all ngen.api GET/POST from Node.
 * L1 in-process + L2 APP_KV (sliding 1h soft TTL, JWT-capped) unless `options.forceRefresh`.
 * @param {import('node-fetch')} fetch
 * @param {string} username
 * @param {string} password
 * @param {string|number|null|undefined} [jobNumberForReferer]
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<{ jar: CookieJar, refererApp: string, token: string }>}
 */
async function authenticateNgenApiWithPassword(fetch, username, password, jobNumberForReferer, options) {
    const forceRefresh = !!(options && options.forceRefresh);
    const u = String(username || '').trim();
    let token = '';

    if (forceRefresh) {
        await invalidateNgenAccessTokenCache(u);
    }

    if (!forceRefresh) {
        const l1 = getCached(u, password);
        if (l1 && l1.token) {
            token = l1.token;
            setCached(u, token, password); // slide L1 soft TTL
            // Non-blocking L2 sliding touch — do not add KV RTT on warm path.
            void touchCachedDurable(u, token, password).catch(() => {});
        }
    }

    if (!token && !forceRefresh) {
        const l2 = await getCachedDurable(u, password);
        if (l2 && l2.token) {
            token = l2.token;
            setCached(u, token, password, l2.expiresAtMs);
            void touchCachedDurable(u, token, password).catch(() => {});
        }
    }

    if (!token) {
        let lease = await tryBeginTokenFetch(u);
        if (!lease.ok) {
            const waited = await waitForDurableToken(u, password);
            if (waited && waited.token) {
                token = waited.token;
                setCached(u, token, password, waited.expiresAtMs);
            }
        }
        if (!token) {
            if (!lease.ok) {
                lease = await tryBeginTokenFetch(u);
            }
            const holdLease = !!lease.ok;
            try {
                const out = await fetchAccessToken(fetch, username, password);
                token = out.token;
                setCached(u, token, password);
                await setCachedDurable(u, token, password);
            } finally {
                if (holdLease) await releaseTokenFetch(u);
            }
        }
    }

    const key = normalizeCacheKey(u);
    const jar = createJarWithOneCallBearerToken(token, key);
    const refererApp = refererDefaultNgenWeb(jobNumberForReferer);
    return { jar, refererApp, token };
}

/**
 * GET GetCurrentUserProfileAsync — recentEnquiries, etc. (Bearer only; same jar as EnquirySearch).
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @returns {Promise<object>}
 */
async function fetchCurrentUserProfile(fetch, jar, refererApp) {
    const r = await fetch(API_PROFILE, {
        headers: ngenApiRequestHeaders(jar, refererApp),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`GetCurrentUserProfileAsync failed: ${r.status} ${text.slice(0, 400)}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('GetCurrentUserProfileAsync response was not JSON');
    }
}

/**
 * GET GetCurrentUserEnquiryAsync — returns EnquirySearch-shaped JSON (Swagger: PelicanCorp.OneCall.Api.Models.EnquirySearch).
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp e.g. `${ORIGIN}/ngen.web/`
 * @param {string|number} jobNumber enquiry / job id (same query param as the nGen web app)
 * @returns {Promise<object>}
 */
/**
 * @param {{ from: string, to: string }} rangeIso - createdDateFrom / createdDateTo (ISO-8601)
 * @param {number} currentPage
 * @param {number} pageLength
 * @param {Record<string, unknown>} [shareFilters]
 * @returns {object}
 */
function buildSearchCurrentUserEnquiriesBody(rangeIso, currentPage, pageLength, shareFilters) {
    const s = shareFilters && typeof shareFilters === 'object' ? shareFilters : {};
    const jobN = s.jobNumber;
    const jobNumberFilter =
        jobN != null && jobN !== '' && String(jobN).trim() !== '' && Number.isFinite(Number(jobN)) ? Number(jobN) : null;
    return {
        jobNumber: jobNumberFilter,
        reference: null,
        suburb: null,
        sharedByUserName: strOrNullForSearch(s.sharedByUserName),
        sharedToUserName: strOrNullForSearch(s.sharedToUserName),
        isActiveSharing: null,
        sharedByUserCompanyName: strOrNullForSearch(s.sharedByUserCompanyName),
        sharedToUserCompanyName: strOrNullForSearch(s.sharedToUserCompanyName),
        postCode: null,
        alternativeIdentifier: null,
        canPromote: null,
        ticketType: null,
        isAutoResubmitOnly: null,
        createdDateFrom: rangeIso.from,
        createdDateTo: rangeIso.to,
        pageLength: Math.min(100, Math.max(1, pageLength)),
        currentPage: Math.max(1, currentPage),
        useMapSearch: false,
        SortType: null,
    };
}

/**
 * POST SearchCurrentUserEnquiriesAsync — paged list (Bearer).
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} referer
 * @param {object} body from {@link buildSearchCurrentUserEnquiriesBody}
 * @returns {Promise<object>}
 */
/**
 * POST ReverseGeocodeCurrentUserAsync — single ReverseGeocodeRequest object (Swagger: /api/Geocode/ReverseGeocodeCurrentUserAsync).
 * @param {import('node-fetch')} fetchImpl
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @param {Record<string, unknown>} requestBody
 * @returns {Promise<unknown>}
 */
async function postReverseGeocodeCurrentUserAsync(fetchImpl, jar, refererApp, requestBody) {
    const r = await fetchImpl(API_REVERSE_GEOCODE_CURRENT_USER, {
        method: 'POST',
        headers: {
            ...ngenApiRequestHeaders(jar, refererApp),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`ReverseGeocodeCurrentUserAsync failed: ${r.status} ${text.slice(0, 500)}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('ReverseGeocodeCurrentUserAsync response was not JSON');
    }
}

/**
 * GET GeoSearch/SearchByStreetAsync — forward address/intersection search for current user context.
 * @param {import('node-fetch')} fetchImpl
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @param {string} streetAddress
 * @returns {Promise<unknown>}
 */
async function getGeoSearchByStreetAsync(fetchImpl, jar, refererApp, streetAddress) {
    const q = new URLSearchParams();
    q.set('streetAddress', String(streetAddress || '').trim());
    const url = `${API_GEO_SEARCH_BY_STREET}?${q.toString()}`;
    const r = await fetchImpl(url, {
        method: 'GET',
        headers: ngenApiRequestHeaders(jar, refererApp),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`SearchByStreetAsync failed: ${r.status} ${text.slice(0, 500)}`);
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('SearchByStreetAsync response was not JSON');
    }
}

async function postSearchCurrentUserEnquiriesAsync(fetch, jar, referer, body) {
    const r = await fetch(API_SEARCH_ENQUIRIES, {
        method: 'POST',
        headers: {
            ...ngenApiRequestHeaders(jar, referer),
            'Content-Type': 'application/json-patch+json',
        },
        body: JSON.stringify(body),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`SearchCurrentUserEnquiriesAsync failed: ${r.status} ${text.slice(0, 500)}`);
    }
    try {
        return normalizeEnquirySearchResponse(JSON.parse(text));
    } catch (e) {
        throw new Error('SearchCurrentUserEnquiriesAsync response was not JSON');
    }
}

/**
 * ASP.NET / legacy clients sometimes wrap EnquirySearch in `{ "d": { ... } }`.
 * @param {unknown} data
 * @returns {object}
 */
function normalizeEnquirySearchResponse(data) {
    if (!data || typeof data !== 'object') return /** @type {object} */ (data || {});
    const wrapped = data.d ?? data.D;
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        return /** @type {object} */ (wrapped);
    }
    return /** @type {object} */ (data);
}

/**
 * Extract `enquiries[]` from SearchCurrentUserEnquiriesAsync (handles casing / wrapper variants).
 * @param {unknown} data normalized or raw search response
 * @returns {object[]}
 */
function extractEnquiriesFromSearchResponse(data) {
    const root = normalizeEnquirySearchResponse(data);
    if (!root || typeof root !== 'object') return [];
    const candidates = [
        root.enquiries,
        root.Enquiries,
        root.enquiryList,
        root.EnquiryList,
        root.items,
        root.Items,
        root.results,
        root.Results,
    ];
    for (let i = 0; i < candidates.length; i++) {
        if (Array.isArray(candidates[i])) return candidates[i];
    }
    return [];
}

/**
 * Normalize GetCurrentUserEnquiryAsync (EnquirySearch) into a SearchCurrentUserEnquiries list row.
 * @param {object} enquiry
 * @returns {object|null}
 */
function enquirySearchToListItem(enquiry) {
    if (!enquiry || typeof enquiry !== 'object') return null;
    const ed = enquiry.enquiryDetails || enquiry.EnquiryDetails;
    if (!ed || typeof ed !== 'object') return null;
    const rn = ed.requestNumber != null ? String(ed.requestNumber).trim() : '';
    if (!rn) return null;
    const item = { enquiryDetails: ed };
    const caller = enquiry.callerDetails ?? enquiry.CallerDetails;
    if (caller && typeof caller === 'object') item.callerDetails = caller;
    const notifs = enquiry.notifications ?? enquiry.Notifications;
    if (notifs != null) item.notifications = notifs;
    return item;
}

async function fetchEnquirySearch(fetch, jar, refererApp, jobNumber) {
    const id = String(jobNumber == null ? '' : jobNumber).trim();
    if (!id) {
        throw new Error('jobNumber is required');
    }
    const url = `${API_ENQUIRY}?jobNumber=${encodeURIComponent(id)}`;
    const r = await fetch(url, {
        headers: ngenApiRequestHeaders(jar, refererApp),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`GetCurrentUserEnquiryAsync failed: ${r.status} ${text.slice(0, 400)}`);
    }
    try {
        const data = normalizeEnquirySearchResponse(JSON.parse(text));
        // Set NGEN_ENQUIRY_DEBUG_LOG=1 to print full GetCurrentUserEnquiryAsync JSON (remove block when done debugging).
        if (String(process.env.NGEN_ENQUIRY_DEBUG_LOG || '').trim() === '1') {
            console.log('[ngen EnquirySearch DEBUG] jobNumber=%s full JSON:', id);
            try {
                console.log(JSON.stringify(data, null, 2));
            } catch (_) {
                console.log(text);
            }
        }
        return data;
    } catch (e) {
        throw new Error('GetCurrentUserEnquiryAsync response was not JSON');
    }
}

/**
 * USAN sometimes returns a bare array and sometimes a wrapper object; treat non-arrays as empty only after probing common keys.
 * @param {unknown} parsed
 * @returns {object[]}
 */
function coerceNotificationResponseHistoryArray(parsed) {
    if (parsed == null) return [];
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== 'object') return [];
    const keys = [
        'd',
        'data',
        'Data',
        'items',
        'Items',
        'results',
        'Results',
        'notifications',
        'Notifications',
        'ticketHistory',
        'TicketHistory',
        'responseHistory',
        'ResponseHistory',
        'notificationResponses',
        'NotificationResponses',
        'responses',
        'Responses',
        'rows',
        'Rows',
        'values',
        'Values',
    ];
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(parsed, k) && Array.isArray(parsed[k])) {
            return parsed[k];
        }
    }
    const arrays = Object.values(parsed).filter((v) => Array.isArray(v));
    const nonEmpty = arrays.filter((a) => a.length > 0);
    if (nonEmpty.length === 1) return nonEmpty[0];
    if (nonEmpty.length > 1) {
        nonEmpty.sort((a, b) => b.length - a.length);
        return nonEmpty[0];
    }
    if (arrays.length === 1) return arrays[0];
    return [];
}

/**
 * GET GetNotificationResponseHistoryAsync — per-utility timeline (plan §3). Call once per authorityId.
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp base referer (e.g. `${ORIGIN}/ngen.web/`)
 * @param {string} requestNumber e.g. enquiryDetails.requestNumber
 * @param {string|number} authorityId utility id from notifications[].authority.id
 * @param {string|number} [jobNumberForReferer] optional enquiry id for Referer `?enquiryId=`
 * @returns {Promise<object[]>}
 */
async function fetchNotificationResponseHistory(fetch, jar, refererApp, requestNumber, authorityId, jobNumberForReferer) {
    const rn = String(requestNumber == null ? '' : requestNumber).trim();
    const aid = authorityId != null && String(authorityId).trim() !== '' ? String(authorityId).trim() : '';
    if (!rn || !aid) {
        throw new Error('requestNumber and authorityId are required');
    }
    const q = new URLSearchParams();
    q.set('requestNumber', rn);
    q.set('authorityId', aid);
    const url = `${API_NOTIFICATION_RESPONSE_HISTORY}?${q.toString()}`;
    const ref =
        jobNumberForReferer != null && String(jobNumberForReferer).trim() !== ''
            ? `${ORIGIN}/ngen.web/?enquiryId=${encodeURIComponent(String(jobNumberForReferer).trim())}`
            : refererApp;
    const r = await fetch(url, {
        headers: ngenApiRequestHeaders(jar, ref),
    });
    jar.addFromResponse(r);
    const text = await r.text();
    if (!r.ok) {
        throw new Error(`GetNotificationResponseHistoryAsync failed: ${r.status} ${text.slice(0, 400)}`);
    }
    try {
        const parsed = JSON.parse(text);
        return coerceNotificationResponseHistoryArray(parsed);
    } catch (e) {
        throw new Error('GetNotificationResponseHistoryAsync response was not JSON');
    }
}

/**
 * @param {string} label
 * @param {Buffer} rawBuf
 * @param {string} ct
 * @returns {Buffer}
 */
function parseNgenPdfResponse(label, rawBuf, ct) {
    const looksRawPdf = rawBuf.slice(0, 5).toString('ascii').startsWith('%PDF');
    if (ct.includes('json') || (!looksRawPdf && rawBuf[0] === 0x7b)) {
        let payload;
        try {
            payload = JSON.parse(rawBuf.toString('utf8'));
        } catch (e) {
            throw new Error(`${label}: expected JSON wrapper`);
        }
        if (payload.message != null && String(payload.message).trim() !== '') {
            throw new Error(`${label} API message: ${payload.message}`);
        }
        if (payload.data == null || typeof payload.data !== 'string') {
            throw new Error(`${label}: PDF JSON missing base64 data`);
        }
        const buf = Buffer.from(payload.data, 'base64');
        if (buf.length < 5 || buf.slice(0, 4).toString('ascii') !== '%PDF') {
            throw new Error(`${label}: decoded data is not a PDF`);
        }
        return buf;
    }
    if (ct.includes('pdf') || looksRawPdf) {
        return rawBuf;
    }
    throw new Error(`${label}: unexpected PDF response content-type: ${ct}`);
}

/**
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @param {string} pdfReqUrl
 * @param {string} label
 * @returns {Promise<Buffer>}
 */
async function fetchNgenPdfUrl(fetch, jar, refererApp, pdfReqUrl, label) {
    const pdfRes = await fetch(pdfReqUrl, {
        headers: {
            ...ngenApiRequestHeaders(jar, refererApp),
            Accept: 'application/pdf,application/json;q=0.9,*/*;q=0.8',
        },
    });
    jar.addFromResponse(pdfRes);

    const ct = pdfRes.headers.get('content-type') || '';
    const rawBuf = Buffer.from(await pdfRes.arrayBuffer());

    if (!pdfRes.ok) {
        throw new Error(`${label} failed: ${pdfRes.status} ${rawBuf.slice(0, 200).toString('utf8')}`);
    }

    return parseNgenPdfResponse(label, rawBuf, ct);
}

/**
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @param {number} enquiryId
 * @returns {Promise<Buffer>}
 */
async function downloadConfirmationPdf(fetch, jar, refererApp, enquiryId) {
    async function ngenApiGet(label, url, referer) {
        const r = await fetch(url, {
            headers: ngenApiRequestHeaders(jar, referer),
        });
        jar.addFromResponse(r);
        const bodyBuf = Buffer.from(await r.arrayBuffer());
        if (!r.ok) {
            throw new Error(`${label} failed: ${r.status} ${bodyBuf.slice(0, 200).toString('utf8')}`);
        }
        return bodyBuf;
    }

    const id = String(enquiryId);
    await ngenApiGet(
        'GetEnquiryStaticMapAsync',
        `${API_STATIC_MAP}?enquiryId=${encodeURIComponent(id)}`,
        refererApp
    );
    await ngenApiGet(
        'GetCurrentUserEnquiryAsync',
        `${API_ENQUIRY}?jobNumber=${encodeURIComponent(id)}`,
        refererApp
    );

    const pdfReqUrl = `${API_CONFIRMATION_PDF}?enquiryId=${encodeURIComponent(id)}`;
    return fetchNgenPdfUrl(fetch, jar, refererApp, pdfReqUrl, 'GetEnquiryCallerConfirmationSheetAsync');
}

/**
 * @param {import('node-fetch')} fetch
 * @param {CookieJar} jar
 * @param {string} refererApp
 * @param {string} requestNumber full ticket number with revision, e.g. 2026051100200-001
 * @param {{ includeFullHistory?: boolean }} [opts]
 * @returns {Promise<Buffer>}
 */
async function downloadJobPackPdf(fetch, jar, refererApp, requestNumber, opts) {
    const rn = String(requestNumber || '').trim();
    if (!rn) {
        throw new Error('DownloadJobPack requires requestNumber');
    }
    const includeFullHistory = opts && opts.includeFullHistory === false ? false : true;
    const q = new URLSearchParams();
    q.set('requestNumber', rn);
    q.set('includeFullHistory', includeFullHistory ? 'true' : 'false');
    const pdfReqUrl = `${API_DOWNLOAD_JOB_PACK}?${q.toString()}`;
    return fetchNgenPdfUrl(fetch, jar, refererApp, pdfReqUrl, 'DownloadJobPack');
}

module.exports = {
    ORIGIN,
    CookieJar,
    resolveJobNumberFromRecent,
    resolveEnquiryIdFromProfile,
    fetchAccessToken,
    createJarWithOneCallBearerToken,
    refererDefaultNgenWeb,
    authenticateNgenApiWithPassword,
    isNgenUnauthorizedError,
    withNgenAuthRetry,
    invalidateNgenAccessTokenCache,
    fetchCurrentUserProfile,
    normalizeEnquirySearchResponse,
    extractEnquiriesFromSearchResponse,
    enquirySearchToListItem,
    buildSearchCurrentUserEnquiriesBody,
    postSearchCurrentUserEnquiriesAsync,
    postReverseGeocodeCurrentUserAsync,
    getGeoSearchByStreetAsync,
    API_GEO_SEARCH_BY_STREET,
    API_SEARCH_ENQUIRIES,
    REFERER_NGEN_HISTORY,
    fetchEnquirySearch,
    fetchNotificationResponseHistory,
    downloadConfirmationPdf,
    downloadJobPackPdf,
    API_DOWNLOAD_JOB_PACK,
    ngenApiRequestHeaders,
};
