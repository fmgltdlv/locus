/**
 * nGen ticket renewal: GetCurrentUserEnquiryComputedDateValues + SubmitCurrentUserEnquiryAsync.
 * Uses the same auth jar/headers as {@link ../lib/ngenClient.cjs} (Bearer + cookies).
 */
const { ORIGIN, ngenApiRequestHeaders } = require('./ngenClient.cjs');
const { pacificOffsetForYmd } = require('./pacificTime.cjs');

const RENEWAL_REFERER_BASE = `${ORIGIN}/ngen.web/`;
const API_COMPUTED_DATES = `${ORIGIN}/ngen.api/api/EnquiryValidation/GetCurrentUserEnquiryComputedDateValues`;
const API_SUBMIT = `${ORIGIN}/ngen.api/api/Enquiry/SubmitCurrentUserEnquiryAsync`;

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * @param {Response} response
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, text: string }>}
 */
async function readJsonResponse(response) {
    const text = await response.text();
    const data = safeJsonParse(text);
    return { ok: response.ok, status: response.status, data, text };
}

function toInt(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function nestedId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return toInt(obj.id);
}

function toIsoDateParts(iso) {
    if (!iso || typeof iso !== 'string') return null;
    const m =
        iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/) || [];
    if (m.length < 6) return null;
    const offset = m[6] && m[6] !== 'Z' ? m[6] : '+00:00';
    return {
        yyyy: m[1],
        mm: m[2],
        dd: m[3],
        hh: m[4],
        min: m[5],
        offset,
    };
}

function formatComputedDateParam(iso) {
    const p = toIsoDateParts(iso);
    if (!p) return null;
    return `${p.yyyy}/${p.mm}/${p.dd} ${p.hh}:${p.min} ${p.offset}`;
}

function formatDateForSubmit(iso) {
    const p = toIsoDateParts(iso);
    if (!p) return null;
    return `${p.dd}/${p.mm}/${p.yyyy}`;
}

function formatTimeForSubmit(iso) {
    const p = toIsoDateParts(iso);
    if (!p) return null;
    return `${p.hh}:${p.min}`;
}

function normalizePhone(s) {
    if (s == null) return '';
    return String(s).replace(/[^\d+]/g, '');
}

function pickFirstTruthy(...values) {
    for (const v of values) {
        if (v != null && String(v).trim() !== '') return v;
    }
    return null;
}

/**
 * Apply USAN computed-dates + enquiry commence/legal fields to a submit payload (portal parity).
 * @param {object} payload
 * @param {object|null|undefined} computedDates
 * @param {object|null|undefined} enquiryDetails
 */
function applyComputedSubmitDates(payload, computedDates, enquiryDetails) {
    if (!payload || typeof payload !== 'object') return payload;
    const details = enquiryDetails || {};
    const computed = computedDates || {};
    const commencementIso = pickFirstTruthy(
        details.commencementDate,
        computed.enquiryEarliestDate,
        details.workLegalStartDate,
        computed.legalCommencementDate
    );
    if (commencementIso) {
        const date = formatDateForSubmit(commencementIso);
        const time = formatTimeForSubmit(commencementIso);
        if (date) payload.commencesOnDate = date;
        if (time) payload.commencesOnTime = time;
    }
    const legal = pickFirstTruthy(
        computed.legalCommencementDate,
        details.workLegalStartDate,
        details.commencementDate
    );
    if (legal) payload.workLegalStartDate = legal;
    return payload;
}

/**
 * Remark submits: USAN recomputes commence from computed dates (RNEW may advance past stale enquiry commence).
 * Operator submits keep enquiry commence first — see applyComputedSubmitDates.
 * @param {object} payload
 * @param {object|null|undefined} computedDates
 * @param {object|null|undefined} enquiryDetails
 */
function applyRemarkSubmitDates(payload, computedDates, enquiryDetails) {
    if (!payload || typeof payload !== 'object') return payload;
    const details = enquiryDetails || {};
    const computed = computedDates || {};
    const commencementIso = pickFirstTruthy(
        computed.enquiryEarliestDate,
        computed.legalCommencementDate,
        details.commencementDate,
        details.workLegalStartDate
    );
    if (commencementIso) {
        const date = formatDateForSubmit(commencementIso);
        const time = formatTimeForSubmit(commencementIso);
        if (date) payload.commencesOnDate = date;
        if (time) payload.commencesOnTime = time;
    }
    const legal = pickFirstTruthy(
        computed.legalCommencementDate,
        details.workLegalStartDate,
        details.commencementDate
    );
    if (legal) payload.workLegalStartDate = legal;
    return payload;
}

function getPermitNames(details) {
    if (Array.isArray(details?.hasPermitFor) && details.hasPermitFor.length > 0) {
        return details.hasPermitFor
            .map((x) => (x && typeof x.value === 'string' ? x.value : null))
            .filter(Boolean);
    }
    return ['No Permit required'];
}

/**
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {object} enquiryDetails - from GetCurrentUserEnquiryAsync
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, text: string }>}
 */
async function fetchComputedDateValuesForRenewal(fetchImpl, jar, enquiryDetails) {
    const purposeId = nestedId(enquiryDetails?.purpose) ?? 0;
    const startDate =
        formatComputedDateParam(enquiryDetails?.workLegalStartDate) ||
        formatComputedDateParam(enquiryDetails?.commencementDate);
    const prevLegalDate =
        formatComputedDateParam(enquiryDetails?.workLegalStartDate) || startDate;
    const expirationTime = formatComputedDateParam(enquiryDetails?.ticketExpiration) || startDate;
    const u = new URL(API_COMPUTED_DATES);
    u.searchParams.set('enquiryPurposeId', String(purposeId));
    u.searchParams.set('startDate', startDate || '');
    u.searchParams.set('ticketCreationMethod', 'Renewal');
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
 * Nevada nGen: GetCurrentUserEnquiryComputedDateValues for ticketCreationMethod=New
 * (query: enquiryPurposeId, startDate, ticketCreationMethod, expirationTime — no prevLegalDate).
 *
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {{ enquiryPurposeId?: number|null, startDateParam: string, expirationTimeParam: string }} args
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, text: string }>}
 */
async function fetchComputedDateValuesForNew(fetchImpl, jar, args) {
    const enquiryPurposeId = toInt(args?.enquiryPurposeId) ?? 0;
    const startDate = args?.startDateParam != null ? String(args.startDateParam) : '';
    const expirationTime = args?.expirationTimeParam != null ? String(args.expirationTimeParam) : '';
    const u = new URL(API_COMPUTED_DATES);
    u.searchParams.set('enquiryPurposeId', String(enquiryPurposeId));
    u.searchParams.set('startDate', startDate);
    u.searchParams.set('ticketCreationMethod', 'New');
    u.searchParams.set('expirationTime', expirationTime);
    const r = await fetchImpl(u.toString(), {
        method: 'GET',
        headers: ngenApiRequestHeaders(jar, RENEWAL_REFERER_BASE),
    });
    jar.addFromResponse(r);
    return readJsonResponse(r);
}

/**
 * @param {string} ymd yyyy-mm-dd
 * @param {string} [hm] HH:mm default 17:00
 * @param {string} [offset] default DST-aware Pacific offset for `ymd`
 */
function formatNgenComputedDateParamFromYmd(ymd, hm, offset) {
    const off = offset && String(offset).trim() !== '' ? String(offset).trim() : pacificOffsetForYmd(ymd);
    const time = hm && String(hm).trim() !== '' ? String(hm).trim() : '17:00';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const [, y, mo, d] = m;
    const tm = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!tm) return null;
    const hh = String(parseInt(tm[1], 10)).padStart(2, '0');
    const min = String(parseInt(tm[2], 10)).padStart(2, '0');
    return `${y}/${mo}/${d} ${hh}:${min} ${off}`;
}

/**
 * @param {string} ymd yyyy-mm-dd
 * @param {number} [deltaDays] default 45
 * @param {string} [offset] default DST-aware Pacific offset for expiry day
 */
function formatNgenExpirationEndOfDayFromYmd(ymd, deltaDays, offset) {
    const days = deltaDays != null && Number.isFinite(Number(deltaDays)) ? Number(deltaDays) : 45;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const t = Date.UTC(y, mo, d + days);
    const u = new Date(t);
    const ys = String(u.getUTCFullYear());
    const ms = String(u.getUTCMonth() + 1).padStart(2, '0');
    const ds = String(u.getUTCDate()).padStart(2, '0');
    const expiryYmd = `${ys}-${ms}-${ds}`;
    const off = offset && String(offset).trim() !== '' ? String(offset).trim() : pacificOffsetForYmd(expiryYmd);
    return `${ys}/${ms}/${ds} 23:59 ${off}`;
}

/**
 * @param {object} sourceEnquiry - full GetCurrentUserEnquiryAsync JSON (normalized)
 * @param {object} computedDates - response body from computed date values
 * @param {string|number} sourceJobNumber
 */
function buildRenewalPayload(sourceEnquiry, computedDates, sourceJobNumber) {
    const details = sourceEnquiry?.enquiryDetails || {};
    const caller = sourceEnquiry?.callerDetails || {};
    const digSiteAddress = details?.digSiteAddress || {};
    const commencementIso = pickFirstTruthy(
        details?.commencementDate,
        computedDates?.enquiryEarliestDate,
        details?.workLegalStartDate,
        computedDates?.legalCommencementDate
    );
    const workLegalStartDate = pickFirstTruthy(
        computedDates?.legalCommencementDate,
        details?.workLegalStartDate,
        details?.commencementDate
    );

    return {
        WorkDurationName: details?.workDuration?.value ?? null,
        enquiryMedium: null,
        ticketCreationMethod: 'Renewal',
        searchRegionId: toInt(details?.geographicRegion?.id),
        activityId: nestedId(details?.activity),
        categoryId: nestedId(details?.category),
        purposeId: nestedId(details?.purpose),
        additionalNotes: details?.notes ?? '',
        assetLocateRequired: details?.assetLocateRequired ?? null,
        commencesOnDate: formatDateForSubmit(commencementIso),
        commencesOnTime: formatTimeForSubmit(commencementIso),
        CompletesOnDate: formatDateForSubmit(details?.completionDate),
        designCompletesOnDate: formatDateForSubmit(details?.designCompletionDate),
        assetLocateOn: formatDateForSubmit(details?.assetLocateDate),
        plansRequired: details?.plansRequired ?? null,
        planPaperSizeId: nestedId(details?.planPaperSize),
        planPaperScale: details?.paperPlanScale ?? null,
        searchLocationString: details?.searchedLocation ?? '',
        spatialObjectNativeDescription: details?.spatialObjectDescription ?? '',
        spatialObjectNativeProjection: 'EPSG:4326',
        IsSpatialObjectCircle: false,
        excavationMethodId: nestedId(details?.excavationMethod),
        excavationDepthId: nestedId(details?.excavationDepth),
        principalContactName:
            pickFirstTruthy(details?.principalContactName, `${caller?.firstName || ''} ${caller?.lastName || ''}`) ||
            '',
        principalContactMobile: normalizePhone(
            pickFirstTruthy(details?.principalContactPhone, caller?.mobileNumber, caller?.primaryPhone)
        ),
        nearestCrossStreet: details?.nearestCrossStreet ?? '',
        lotNoSubdivision: details?.lotNoSubdivision ?? '',
        excavatorDoingWork: details?.excavatorDoingWork ?? null,
        workingOnBehalfOfId: nestedId(details?.workingOnBehalf),
        workingOnBehalfOfAuthId: nestedId(details?.workingOnBehalfOfAuth),
        locationInRoad: details?.locationInRoad ?? null,
        isPrivateLocateRequired: details?.privateLocate ?? null,
        workplaceLocations: Array.isArray(details?.locationOfWorkplaces) ? details.locationOfWorkplaces : [],
        userReference: details?.userReference ?? '',
        isAreaPreMarked: details?.isAreaPreMarked ?? null,
        AreaPreMarked: details?.areaPreMarked ?? 'Other (see Digsite Location Details)',
        clonedFromEnquiryID: toInt(sourceJobNumber),
        enquiryLocation: {
            street: digSiteAddress?.street ?? '',
            suburb: digSiteAddress?.suburb ?? '',
            postcode: digSiteAddress?.postcode ?? '',
            county: digSiteAddress?.county ?? '',
            state: digSiteAddress?.state ?? '',
        },
        createCar: null,
        searchAddress: {},
        isIntersectionSearch: false,
        manuallyAddedAuthorities: [],
        manuallyRemovedAuthortities: [],
        ammendReason: '',
        isOperatorFault: false,
        workLegalStartDate: workLegalStartDate ?? null,
        petOnProperty: details?.petOnProperty ?? null,
        inBodyOfWater: details?.inBodyOfWater ?? null,
        isBoring: details?.isBoring ?? false,
        isBlasting: details?.isBlasting ?? false,
        isExcavationOnRoadWay: details?.isExcavationOnRoadWay ?? false,
        isExcavationOnlyWithinPavement: details?.isExcavationOnlyWithinPavement ?? null,
        isVacuumExcavation: details?.isVacuumExcavation ?? null,
        permitNumber: details?.permitNumber ?? null,
        hasPermitForNames: getPermitNames(details),
        PreviousExternalRequestNumber: details?.previousExternalRequestNumber ?? null,
        sharedByUser: null,
        isUsingSearchedCoordsForConfirmedCoords: false,
        xSearchedCoordinate: details?.xLocation ?? null,
        ySearchedCoordinate: details?.yLocation ?? null,
        manuallySelectedUtiliiesFromPreviousTicket: details?.manuallySelectedUtiliiesFromPreviousTicket ?? [],
        previousTicketTypeCarriedOverByExternalUser: details?.previousTicketTypeCarriedOverByExternalUser ?? false,
        alpOption: details?.alpOption ?? null,
        smsOptIn: details?.smsOptIn ?? null,
    };
}

/**
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, text: string }>}
 */
async function submitRenewalEnquiry(fetchImpl, jar, payload) {
    const r = await fetchImpl(API_SUBMIT, {
        method: 'POST',
        headers: {
            ...ngenApiRequestHeaders(jar, RENEWAL_REFERER_BASE),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    jar.addFromResponse(r);
    return readJsonResponse(r);
}

/** USAN SubmitCurrentUserEnquiryAsync quota: 1 per 10s (HTTP 429 when exceeded). */
const NGEN_SUBMIT_MIN_GAP_MS = 11_000;
const NGEN_SUBMIT_MAX_ATTEMPTS = 3;
/** Shared across sequential POST /api/tickets/create calls (bulk create wizard). */
const sharedNgenSubmitPacing = { lastSubmitAt: 0 };

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{ ok: boolean, status: number, data?: object|null, text?: string }} submitRes
 * @returns {number}
 */
function parseQuotaRetrySeconds(submitRes) {
    const parts = [];
    if (submitRes && submitRes.data) {
        if (submitRes.data.details) parts.push(String(submitRes.data.details));
        if (submitRes.data.message) parts.push(String(submitRes.data.message));
    }
    if (submitRes && submitRes.text) parts.push(String(submitRes.text));
    const text = parts.join(' ');
    const m = text.match(/try again in (\d+)\s*second/i);
    if (m) return Math.max(1, parseInt(m[1], 10));
    return 10;
}

/**
 * Pace and retry submit to respect USAN's 1-per-10s quota on bulk renewal/create flows.
 * @param {{ lastSubmitAt?: number }} [pacing] - mutable; updated after each submit attempt
 */
async function paceBeforeNgenSubmit(pacing) {
    if (!pacing || !pacing.lastSubmitAt) return;
    const elapsed = Date.now() - pacing.lastSubmitAt;
    if (elapsed < NGEN_SUBMIT_MIN_GAP_MS) {
        await sleepMs(NGEN_SUBMIT_MIN_GAP_MS - elapsed);
    }
}

/**
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {object} payload
 * @param {{ lastSubmitAt?: number }} [pacing]
 */
async function submitRenewalEnquiryPaced(fetchImpl, jar, payload, pacing) {
    const state = pacing != null ? pacing : sharedNgenSubmitPacing;
    let lastRes = null;
    for (let attempt = 0; attempt < NGEN_SUBMIT_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            const waitSec = parseQuotaRetrySeconds(lastRes);
            await sleepMs(waitSec * 1000 + 500);
        } else {
            await paceBeforeNgenSubmit(state);
        }
        lastRes = await submitRenewalEnquiry(fetchImpl, jar, payload);
        state.lastSubmitAt = Date.now();
        if (lastRes.status !== 429) return lastRes;
    }
    return lastRes;
}

/**
 * Small snapshot for Feedback audit (avoid unbounded JSON).
 * @param {object|null} data
 */
function summarizeEnquiryForAudit(data) {
    const details = data?.enquiryDetails || {};
    return {
        jobNumber: details?.jobNumber ?? null,
        requestNumber: details?.requestNumber ?? null,
        previousRequestNumber: details?.previousRequestNumber ?? null,
        status: details?.status ?? null,
        canBeRenewal: details?.canBeRenewal ?? null,
        fullAddress: details?.fullAddress ?? null,
        commencementDate: details?.commencementDate ?? null,
        ticketExpiration: details?.ticketExpiration ?? null,
        activity: details?.activity?.value ?? null,
        purpose: details?.purpose?.value ?? null,
    };
}

/** @param {unknown} v */
function truthyRenewalFlag(v) {
    return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
}

module.exports = {
    RENEWAL_REFERER_BASE,
    fetchComputedDateValuesForRenewal,
    fetchComputedDateValuesForNew,
    formatNgenComputedDateParamFromYmd,
    formatNgenExpirationEndOfDayFromYmd,
    formatDateForSubmit,
    formatTimeForSubmit,
    pickFirstTruthy,
    applyComputedSubmitDates,
    applyRemarkSubmitDates,
    buildRenewalPayload,
    submitRenewalEnquiry,
    submitRenewalEnquiryPaced,
    NGEN_SUBMIT_MIN_GAP_MS,
    submitEnquiryAsync: submitRenewalEnquiry,
    summarizeEnquiryForAudit,
    truthyRenewalFlag,
};
