/**
 * nGen new-ticket submit: clone exhausted enquiry as ticketCreationMethod=New.
 */
const {
    buildRenewalPayload,
    formatDateForSubmit,
    formatTimeForSubmit,
    pickFirstTruthy,
    submitRenewalEnquiry,
    truthyRenewalFlag,
    fetchComputedDateValuesForNew,
    formatNgenComputedDateParamFromYmd,
    formatNgenExpirationEndOfDayFromYmd,
    applyRemarkSubmitDates,
} = require('./ngenRenewal.cjs');
const {
    ymdInTimeZone,
    hmInTimeZone,
    ticketTypeFromPurposeId,
    commencesPayloadToYmdHm,
    USAN_TZ,
} = require('./ticketCommencementDates.cjs');
const { wktToGeoJSON } = require('./ticketBuilder.cjs');
const { pacificOffsetForYmd } = require('./pacificTime.cjs');

function toInt(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function nestedId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    return toInt(obj.id);
}

function normalizePhone(s) {
    if (s == null) return '';
    const digits = String(s).replace(/\D/g, '');
    return digits || String(s).trim();
}

function ynFromBool(v) {
    if (v === true || v === 1 || v === '1') return 'yes';
    if (v === false || v === 0 || v === '0') return 'no';
    return '';
}

function getPermitNames(details) {
    if (Array.isArray(details?.hasPermitFor) && details.hasPermitFor.length > 0) {
        return details.hasPermitFor
            .map((x) => (x && typeof x.value === 'string' ? x.value : null))
            .filter(Boolean);
    }
    return ['No Permit required'];
}

function stateCodeFromDigState(state) {
    if (state == null) return '';
    if (typeof state === 'string') return state.trim();
    if (typeof state === 'object') {
        const c = state.code != null ? String(state.code).trim() : '';
        if (c) return c;
        const v = state.value != null ? String(state.value).trim() : '';
        return v;
    }
    return '';
}

function isoToWizardYmdHm(iso) {
    if (!iso) return { ymd: '', hm: '' };
    const date = formatDateForSubmit(iso);
    const time = formatTimeForSubmit(iso);
    const parsed = commencesPayloadToYmdHm(date, time);
    return parsed ? { ymd: parsed.ymd, hm: parsed.hm } : { ymd: '', hm: '' };
}

/**
 * Clone-new submits: computed commence first; workLegalStartDate stays null (portal Copy/Continue parity).
 */
function applyCloneNewSubmitDates(payload, computedDates, enquiryDetails) {
    if (!payload || typeof payload !== 'object') return payload;
    applyRemarkSubmitDates(payload, computedDates, enquiryDetails);
    payload.workLegalStartDate = null;
    return payload;
}

/**
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {object} enquiryDetails
 */
async function fetchComputedDatesForCloneNewFromEnquiry(fetchImpl, jar, enquiryDetails) {
    const purposeId = nestedId(enquiryDetails?.purpose) ?? 0;
    const now = new Date();
    const ymd = ymdInTimeZone(now, USAN_TZ);
    const hm = hmInTimeZone(now, USAN_TZ) || '17:00';
    const off = pacificOffsetForYmd(ymd);
    const startDateParam = formatNgenComputedDateParamFromYmd(ymd, hm, off);
    const expirationTimeParam = formatNgenExpirationEndOfDayFromYmd(ymd, 45);
    if (!startDateParam || !expirationTimeParam) {
        return { ok: false, status: 400, data: null, text: 'Could not build computed-date query parameters' };
    }
    return fetchComputedDateValuesForNew(fetchImpl, jar, {
        enquiryPurposeId: purposeId,
        startDateParam,
        expirationTimeParam,
    });
}

/**
 * Map live enquiry → create-ticket wizard shared FIELD_KEYS blob.
 * @param {object} sourceEnquiry
 * @param {object|null|undefined} computedDates
 */
function buildSharedWizardFieldsFromEnquiry(sourceEnquiry, computedDates) {
    const details = sourceEnquiry?.enquiryDetails || {};
    const caller = sourceEnquiry?.callerDetails || {};
    const purposeId = nestedId(details.purpose);
    const ticketType = ticketTypeFromPurposeId(purposeId) || 'Normal';
    let startDateYmd = '';
    let startTimeHm = '';
    if (computedDates && typeof computedDates === 'object') {
        const commencementIso = pickFirstTruthy(
            computedDates.enquiryEarliestDate,
            computedDates.legalCommencementDate
        );
        const parts = isoToWizardYmdHm(commencementIso);
        startDateYmd = parts.ymd;
        startTimeHm = parts.hm;
    }
    const permitNames = getPermitNames(details);
    return {
        jobName: details.userReference != null ? String(details.userReference).trim() : '',
        principalName:
            pickFirstTruthy(
                details.principalContactName,
                `${caller?.firstName || ''} ${caller?.lastName || ''}`.trim()
            ) || '',
        principalMobile: normalizePhone(
            pickFirstTruthy(details.principalContactPhone, caller?.mobileNumber, caller?.primaryPhone)
        ),
        ticketType,
        workCategoryId: nestedId(details.category) != null ? String(nestedId(details.category)) : '',
        workActivityId: nestedId(details.activity) != null ? String(nestedId(details.activity)) : '',
        excavationMethod:
            nestedId(details.excavationMethod) != null ? String(nestedId(details.excavationMethod)) : '',
        horizontalBoring: ynFromBool(details.isBoring),
        explosives: ynFromBool(details.isBlasting),
        streetSidewalkParkstrip: ynFromBool(details.isExcavationOnRoadWay),
        permitExcavation: permitNames[0] || '',
        areaPreMarked: details.areaPreMarked != null ? String(details.areaPreMarked).trim() : '',
        startDateYmd,
        startTimeHm,
        projectOwnerTypeId:
            nestedId(details.workingOnBehalf) != null ? String(nestedId(details.workingOnBehalf)) : '',
        projectOwnerAuthId:
            nestedId(details.workingOnBehalfOfAuth) != null ? String(nestedId(details.workingOnBehalfOfAuth)) : '',
    };
}

/**
 * @param {object} sourceEnquiry
 */
function buildDigSiteWizardFieldsFromEnquiry(sourceEnquiry) {
    const details = sourceEnquiry?.enquiryDetails || {};
    const dig = details.digSiteAddress || {};
    const wkt = details.spatialObjectDescription != null ? String(details.spatialObjectDescription).trim() : '';
    const polygonGeoJson = wkt ? wktToGeoJSON(wkt) : null;
    return {
        polygonGeoJson,
        scope: details.notes != null ? String(details.notes).trim() : '',
        nearestCrossStreet:
            details.nearestCrossStreet != null ? String(details.nearestCrossStreet).trim() : '',
        address: {
            street: dig.street != null ? String(dig.street).trim() : '',
            city: dig.suburb != null ? String(dig.suburb).trim() : '',
            state: stateCodeFromDigState(dig.state),
            zip: dig.postcode != null ? String(dig.postcode).trim() : '',
            county: dig.county != null ? String(dig.county).trim() : '',
        },
        reverseGeocodeRow: null,
        geocodeSummary: '',
        geocodeMeta: '',
        geocodeStatusText: '',
        geocodeStatusError: false,
        uiCollapsed: false,
    };
}

function truthyRemarkFlag(v) {
    return truthyRenewalFlag(v);
}

function buildSearchAddressFromEnquiryDetails(details) {
    const x = details?.xLocation != null ? Number(details.xLocation) : NaN;
    const y = details?.yLocation != null ? Number(details.yLocation) : NaN;
    const dig = details?.digSiteAddress || {};
    return {
        isExact: true,
        prefix: '',
        street: dig.street != null ? String(dig.street) : '',
        suburb: dig.suburb != null ? String(dig.suburb) : '',
        county: dig.county != null ? String(dig.county) : '',
        postcode: dig.postcode != null ? dig.postcode : null,
        coordinates:
            Number.isFinite(x) && Number.isFinite(y)
                ? { x, y, projection: 4326 }
                : undefined,
        locationType: 'R',
        searchMethod: 'XY',
        townCity: '',
        intersectionStreetName: '',
        mapReference: '',
    };
}

/**
 * @param {object} sourceEnquiry
 * @param {{ computedDates?: object|null }} [opts]
 */
function buildClonedNewTicketFromEnquiry(sourceEnquiry, opts) {
    const details = sourceEnquiry?.enquiryDetails || {};
    const computedDates = opts && opts.computedDates != null ? opts.computedDates : null;
    const commencementIso = pickFirstTruthy(details.commencementDate, details.workLegalStartDate);
    const base = buildRenewalPayload(sourceEnquiry, computedDates || {}, 0);
    base.ticketCreationMethod = 'New';
    base.clonedFromEnquiryID = 0;
    if (computedDates) {
        applyCloneNewSubmitDates(base, computedDates, details);
    } else {
        base.commencesOnDate = formatDateForSubmit(commencementIso);
        base.commencesOnTime = formatTimeForSubmit(commencementIso);
        base.workLegalStartDate = null;
    }
    base.searchAddress = buildSearchAddressFromEnquiryDetails(details);
    const dig = details.digSiteAddress || {};
    base.enquiryLocation = {
        street: dig.street != null ? String(dig.street) : '',
        suburb: dig.suburb != null ? String(dig.suburb) : '',
        postcode: dig.postcode != null ? String(dig.postcode) : '',
        county: dig.county != null ? String(dig.county) : '',
        state:
            dig.state != null
                ? typeof dig.state === 'object'
                    ? dig.state.code != null
                        ? String(dig.state.code)
                        : String(dig.state.value || '')
                    : String(dig.state)
                : '',
    };
    return base;
}

/**
 * @param {import('node-fetch').default} fetchImpl
 * @param {import('./ngenClient.cjs').CookieJar} jar
 * @param {object} sourceEnquiry
 */
async function submitClonedNewTicketFromEnquiry(fetchImpl, jar, sourceEnquiry) {
    const payload = buildClonedNewTicketFromEnquiry(sourceEnquiry);
    return submitRenewalEnquiry(fetchImpl, jar, payload);
}

const FAILURE_MESSAGE_MAX = 500;

function pushFailureMsg(parts, v) {
    if (v == null) return;
    const s = String(v).trim();
    if (s) parts.push(s);
}

function collectValidationErrors(target, parts) {
    if (!target || typeof target !== 'object') return;
    const ve = target.validationErrors || target.ValidationErrors || target.errors || target.Errors;
    if (!Array.isArray(ve)) return;
    for (const e of ve) {
        if (typeof e === 'string') pushFailureMsg(parts, e);
        else if (e && typeof e === 'object') {
            const prop = e.propertyName || e.PropertyName || e.field || e.Field;
            const msg = e.errorMessage || e.ErrorMessage || e.message || e.Message || e.description;
            if (prop && msg) pushFailureMsg(parts, `${prop}: ${msg}`);
            else pushFailureMsg(parts, msg);
        }
    }
}

function collectLayerMessages(layer, parts) {
    if (!layer || typeof layer !== 'object') return;
    pushFailureMsg(parts, layer.message || layer.Message);
    pushFailureMsg(parts, layer.details || layer.Details);
    pushFailureMsg(parts, layer.errorMessage || layer.ErrorMessage);
    pushFailureMsg(parts, layer.title || layer.Title);
    collectValidationErrors(layer, parts);
}

/**
 * Human-readable USAN rejection text from SubmitCurrentUserEnquiryAsync response.
 * @param {{ ok?: boolean, status?: number, data?: object|null, text?: string }|null|undefined} submitRes
 * @returns {string}
 */
function collectExceptionMessages(body, parts) {
    if (!body || typeof body !== 'object') return;
    const ex = body.exception || body.Exception;
    if (ex && typeof ex === 'object') {
        pushFailureMsg(parts, ex.Message || ex.message);
    }
}

function collectAspNetValidationErrors(body, parts) {
    if (!body || typeof body !== 'object') return;
    const errs = body.errors || body.Errors;
    if (!errs || typeof errs !== 'object' || Array.isArray(errs)) return;
    for (const [field, messages] of Object.entries(errs)) {
        if (Array.isArray(messages)) {
            for (const m of messages) pushFailureMsg(parts, `${field}: ${m}`);
        } else {
            pushFailureMsg(parts, `${field}: ${messages}`);
        }
    }
}

function extractNgenSubmitFailureDetail(submitRes) {
    const parts = [];
    if (!submitRes) return '';
    if (!submitRes.ok) pushFailureMsg(parts, `HTTP ${submitRes.status}`);
    collectAspNetValidationErrors(submitRes.data, parts);
    collectExceptionMessages(submitRes.data, parts);
    collectLayerMessages(submitRes.data, parts);
    if (submitRes.data && submitRes.data.createEnquiryResult) {
        collectLayerMessages(submitRes.data.createEnquiryResult, parts);
    }
    if (submitRes.data && submitRes.data.result) {
        collectLayerMessages(submitRes.data.result, parts);
    }
    const uniq = [...new Set(parts)];
    if (!uniq.length && submitRes.text) {
        const t = String(submitRes.text).trim();
        if (t) {
            try {
                const parsed = JSON.parse(t);
                collectAspNetValidationErrors(parsed, uniq);
                collectExceptionMessages(parsed, uniq);
                collectLayerMessages(parsed, uniq);
            } catch (_) {
                /* not JSON */
            }
            if (!uniq.length) {
                uniq.push(t.length <= 400 ? t : `${t.slice(0, 397)}...`);
            }
        }
    }
    return uniq.join(' — ');
}

/**
 * Compact object for Worker logs / result_json (no secrets).
 * @param {{ ok?: boolean, status?: number, data?: object|null, text?: string }|null|undefined} submitRes
 */
function summarizeNgenSubmitFailureForLog(submitRes) {
    const body = submitRes && submitRes.data;
    const cer = body && body.createEnquiryResult;
    const validationErrors = cer?.validationErrors || cer?.ValidationErrors || body?.validationErrors || body?.ValidationErrors;
    return {
        httpStatus: submitRes?.status ?? null,
        httpOk: submitRes?.ok ?? null,
        outcome: body?.outcome ?? null,
        message: body?.message ?? null,
        details: body?.details ?? null,
        createOutcome: cer?.outcome ?? null,
        createMessage: cer?.message ?? null,
        createDetails: cer?.details ?? null,
        validationErrorCount: Array.isArray(validationErrors) ? validationErrors.length : 0,
        exceptionMessage:
            (body && body.exception && (body.exception.Message || body.exception.message)) ||
            (body && body.Exception && (body.Exception.Message || body.Exception.message)) ||
            null,
        responseTextPreview:
            submitRes && submitRes.text ? String(submitRes.text).slice(0, 300) : null,
    };
}

/**
 * @param {{ ok?: boolean, status?: number, data?: object|null, text?: string }} submitRes
 * @param {{ fallback?: string }} [opts]
 */
function parseSubmitSuccess(submitRes, opts = {}) {
    const fallback = opts.fallback || 'Submit rejected or incomplete response';
    const body = submitRes.data;
    const submitOutcome = Boolean(body && body.outcome);
    const createOutcome = Boolean(body && body.createEnquiryResult && body.createEnquiryResult.outcome);
    const newId =
        body && body.createEnquiryResult && body.createEnquiryResult.enquiryId != null
            ? body.createEnquiryResult.enquiryId
            : null;
    const submitOk = submitRes.ok && submitOutcome && createOutcome && newId != null;
    let failureMessage = null;
    let failureLog = null;
    if (!submitOk) {
        if (submitRes.status === 429) {
            failureMessage = 'USAN rate limit (max 1 submit per 10 seconds)';
        } else {
            const detail = extractNgenSubmitFailureDetail(submitRes);
            failureMessage = detail || fallback;
            if (failureMessage.length > FAILURE_MESSAGE_MAX) {
                failureMessage = `${failureMessage.slice(0, FAILURE_MESSAGE_MAX - 3)}...`;
            }
        }
        failureLog = summarizeNgenSubmitFailureForLog(submitRes);
    }
    return { submitOk, newEnquiryId: newId, failureMessage, failureLog };
}

/**
 * @param {{ ok?: boolean, status?: number, data?: object|null, text?: string }} submitRes
 * @param {string} fallback
 * @returns {{ parsed: ReturnType<typeof parseSubmitSuccess>, rejected: object|null }}
 */
function submitRejectedStepResult(submitRes, fallback) {
    const parsed = parseSubmitSuccess(submitRes, { fallback });
    if (parsed.submitOk) return { parsed, rejected: null };
    console.warn('[ngen-submit] rejected', parsed.failureLog || {});
    return {
        parsed,
        rejected: {
            step: 'submit',
            ok: false,
            message: parsed.failureMessage,
            failureLog: parsed.failureLog,
        },
    };
}

/**
 * @param {{ ok?: boolean, status?: number, data?: object|null, text?: string }} submitRes
 * @param {string} fallback
 */
function submitRejectedHttpResult(submitRes, fallback) {
    const { parsed, rejected } = submitRejectedStepResult(submitRes, fallback);
    if (!rejected) return { parsed, rejected: null };
    const rateLimited =
        submitRes.status === 429 || String(parsed.failureMessage || '').includes('rate limit');
    return {
        parsed,
        rejected: {
            httpStatus: rateLimited ? 429 : 502,
            body: {
                ok: false,
                error: parsed.failureMessage,
                usan: parsed.failureLog,
            },
        },
    };
}

module.exports = {
    truthyRemarkFlag,
    applyCloneNewSubmitDates,
    fetchComputedDatesForCloneNewFromEnquiry,
    buildSharedWizardFieldsFromEnquiry,
    buildDigSiteWizardFieldsFromEnquiry,
    buildClonedNewTicketFromEnquiry,
    submitClonedNewTicketFromEnquiry,
    extractNgenSubmitFailureDetail,
    summarizeNgenSubmitFailureForLog,
    parseSubmitSuccess,
    submitRejectedStepResult,
    submitRejectedHttpResult,
};
