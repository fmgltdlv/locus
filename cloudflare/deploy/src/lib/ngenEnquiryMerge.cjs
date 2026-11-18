/**
 * Merge nGen `GetCurrentUserEnquiryAsync` (EnquirySearch) JSON into the app ticket shape.
 * v1 projection — see docs/plan-usan-intake-pull-model.md §5.
 * UI mapping (nGen vs PAC vs public API): docs/ticket-field-sources.md
 */
const ticketBuilder = require('./ticketBuilder.cjs');
const { applyPhotoRequirementFields } = require('./photoRequirementCutoff.cjs');
const { applyEnquiryNotificationsToTicket } = require('./ngenNotificationsMerge.cjs');

function pickDisplayValue(v) {
    if (v == null) return null;
    if (typeof v === 'object' && v && 'value' in v && v.value != null && v.value !== '') {
        return String(v.value).trim();
    }
    if (typeof v === 'string' || typeof v === 'number') {
        const s = String(v).trim();
        return s || null;
    }
    return null;
}

function firstNonEmpty(...vals) {
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v == null) continue;
        const s = String(v).trim();
        if (s !== '') return s;
    }
    return null;
}

function isBlank(value) {
    return value == null || String(value).trim() === '';
}

function setIfBlank(target, key, value) {
    if (!target || !isBlank(target[key])) return;
    const s = value == null ? '' : String(value).trim();
    if (s !== '') target[key] = s;
}

/**
 * Pelican / legacy shape: line1, line2, city, state, zip.
 * Require at least line1 or line2 so we do not treat USAN digSiteAddress (street/suburb only) as legacy
 * and incorrectly emit e.g. only `state` when `city` is absent.
 * @param {object} addr
 * @returns {string|null}
 */
function formatLegacyLineAddress(addr) {
    if (!addr || typeof addr !== 'object') return null;
    const hasLegacyStreet =
        (addr.line1 != null && String(addr.line1).trim() !== '') || (addr.line2 != null && String(addr.line2).trim() !== '');
    if (!hasLegacyStreet) return null;
    const parts = [addr.line1, addr.line2, addr.city, addr.state, addr.zip].filter((p) => p != null && String(p).trim() !== '');
    if (parts.length) return parts.map((p) => String(p).trim()).join(', ');
    return null;
}

/**
 * USAN / Nevada structured dig site: street, suburb, townCity, postcode, state, county (see EnquirySearch samples).
 * @param {object} addr
 * @returns {string|null}
 */
function formatNvStructuredDigSiteAddress(addr) {
    if (!addr || typeof addr !== 'object') return null;
    const legacy = formatLegacyLineAddress(addr);
    if (legacy) return legacy;

    const prefix = addr.prefix != null ? String(addr.prefix).trim() : '';
    const number = addr.number != null ? String(addr.number).trim() : '';
    const streetOnly = addr.street != null ? String(addr.street).trim() : '';
    const streetLine = [prefix, number, streetOnly].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || streetOnly;

    const locality = firstNonEmpty(addr.suburb, addr.townCity, addr.city);
    const post = addr.postcode != null ? String(addr.postcode).trim() : '';
    const st = addr.state != null ? String(addr.state).trim() : '';
    const z = post || (addr.zip != null ? String(addr.zip).trim() : '');

    const cityStateParts = [];
    if (locality) cityStateParts.push(locality);
    if (st && z) cityStateParts.push(`${st} ${z}`);
    else if (st) cityStateParts.push(st);
    else if (z) cityStateParts.push(z);

    const main = [streetLine, cityStateParts.join(', ')].filter(Boolean).join(', ');
    const county = addr.county != null ? String(addr.county).trim() : '';

    if (!main && !county) return null;
    if (county && main && !main.includes(county)) return `${main}, ${county}`;
    return main || county;
}

/**
 * @param {object|null|undefined} addr dig site or address-like object
 * @returns {string|null}
 */
function formatDigSiteAddress(addr) {
    return formatNvStructuredDigSiteAddress(addr) || formatLegacyLineAddress(addr);
}

/**
 * @param {string|object|null|undefined} fullAddress
 * @returns {string|null}
 */
function formatFullAddressField(fullAddress) {
    if (fullAddress == null) return null;
    if (typeof fullAddress === 'string') {
        const t = fullAddress.trim();
        return t || null;
    }
    if (typeof fullAddress === 'object') {
        return formatDigSiteAddress(fullAddress);
    }
    return null;
}

/**
 * Resolve dig-site address line for storage: structured digSiteAddress first, then fullAddress string/object.
 * @param {object} ed enquiryDetails
 * @returns {string|null}
 */
function resolveEnquiryDigSiteAddressLine(ed) {
    if (!ed || typeof ed !== 'object') return null;
    const fromStructured = formatDigSiteAddress(ed.digSiteAddress);
    if (fromStructured) return fromStructured;
    return formatFullAddressField(ed.fullAddress);
}

/**
 * Copy structured dig-site locality onto ticket for search / hub (when only nGen filled them).
 * Canonical single-line site address stays on `fullAddress` / `address`; prefix/street are not persisted.
 * @param {object} out merge output
 * @param {object|null} digAddr enquiryDetails.digSiteAddress
 */
function applyDigSiteAddressComponents(out, digAddr) {
    if (!digAddr || typeof digAddr !== 'object') return;
    const city = firstNonEmpty(digAddr.suburb, digAddr.townCity, digAddr.city);
    if (city) setIfBlank(out, 'city', city);
    if (digAddr.county != null && String(digAddr.county).trim() !== '') {
        setIfBlank(out, 'county', digAddr.county);
    }
    if (digAddr.state != null && String(digAddr.state).trim() !== '') {
        setIfBlank(out, 'state', digAddr.state);
    }
    const z = digAddr.postcode != null ? String(digAddr.postcode).trim() : '';
    if (z) setIfBlank(out, 'zipcode', z);
}

function boolish(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

/** nGen `enquiryDetails` booleans stored on the canonical ticket object for future nGen API eligibility. */
const NGEN_ENQUIRY_CAPABILITY_FLAG_KEYS = [
    'canBeAmended',
    'canBeNoResponse',
    'canBeRemark',
    'canBeDamage',
    'canBeRenewal',
    'canBeExposed',
    'canBeFollowUp',
    'canBeDisputed',
];

/**
 * @param {object} out ticket merge target
 * @param {object} ed enquiryDetails
 */
function applyNgenEnquiryCapabilityFlags(out, ed) {
    if (!out || !ed || typeof ed !== 'object') return;
    for (const k of NGEN_ENQUIRY_CAPABILITY_FLAG_KEYS) {
        if (ed[k] !== undefined && ed[k] !== null) {
            out[k] = boolish(ed[k]);
        }
    }
}

function normalizeNgenResponseCount(value) {
    if (value == null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function applyNgenResponseCounts(out, ed, opts) {
    if (!out || !ed || typeof ed !== 'object') return;
    const clearMissing = opts && opts.clearMissing === true;
    const hasOwn = Object.prototype.hasOwnProperty;
    /** nGen JSON is usually camelCase; some serializers send PascalCase on enquiryDetails only. */
    const reqRaw = ed.requiredResponseCount ?? ed.RequiredResponseCount;
    const recRaw = ed.receivedResponseCount ?? ed.ReceivedResponseCount;
    const hasReq =
        hasOwn.call(ed, 'requiredResponseCount') ||
        hasOwn.call(ed, 'RequiredResponseCount');
    const hasRec =
        hasOwn.call(ed, 'receivedResponseCount') ||
        hasOwn.call(ed, 'ReceivedResponseCount');
    if (clearMissing || hasReq) {
        out.ngenRequiredResponseCount = normalizeNgenResponseCount(reqRaw);
    }
    if (clearMissing || hasRec) {
        out.ngenReceivedResponseCount = normalizeNgenResponseCount(recRaw);
    }
}

/**
 * @param {object|null|undefined} td canonical ticket object
 * @returns {boolean}
 */
function storedTicketHasPolygon(td) {
    if (!td || td.polygon == null) return false;
    const p = td.polygon;
    if (typeof p !== 'object') return true;
    if (Array.isArray(p) && p.length > 0) return true;
    if (Object.keys(p).length === 0) return false;
    if (p.type === 'Polygon' || p.type === 'MultiPolygon') return true;
    if (p.type === 'Feature' && p.geometry) return true;
    if (p.type === 'FeatureCollection' && Array.isArray(p.features) && p.features.length > 0) return true;
    if (p.coordinates != null) return true;
    return true;
}

/**
 * Merge enquiryDetails scalars (shared by GetCurrentUserEnquiry and SearchCurrentUserEnquiries list poll).
 * @param {object} out ticket object (mutated)
 * @param {object} ed enquiryDetails
 * @param {{ listPoll?: boolean, responseCounts?: { clearMissing?: boolean } }} [opts]
 */
function applyEnquiryDetailsScalarsToTicket(out, ed, opts) {
    if (!out || !ed || typeof ed !== 'object') return;
    const listPoll = opts && opts.listPoll === true;
    const countOpts = (opts && opts.responseCounts) || {};

    const wkt = ed.spatialObjectDescription != null ? String(ed.spatialObjectDescription).trim() : '';
    if (!storedTicketHasPolygon(out) && wkt && wkt.length > 3 && !/nan/i.test(wkt)) {
        const poly = ticketBuilder.wktToGeoJSON(wkt);
        if (poly) out.polygon = poly;
    }

    const fullAddress = formatFullAddressField(ed.fullAddress);
    if (fullAddress) setIfBlank(out, 'fullAddress', fullAddress);

    const addr = resolveEnquiryDigSiteAddressLine(ed);
    if (addr) {
        setIfBlank(out, 'address', addr);
        setIfBlank(out, 'locationSummary', addr);
    }
    applyDigSiteAddressComponents(out, ed.digSiteAddress);

    const crossLine = firstNonEmpty(pickDisplayValue(ed.nearestCrossStreet), pickDisplayValue(ed.secondNearestCrossStreet));
    if (crossLine) setIfBlank(out, 'nearbyCrossStreet', crossLine);

    const purpose = firstNonEmpty(pickDisplayValue(ed.purpose), pickDisplayValue(ed.ticketType));
    const category = pickDisplayValue(ed.category);
    const activity = pickDisplayValue(ed.activity);
    if (purpose) out.ngenTicketType = purpose;
    else if (!listPoll) delete out.ngenTicketType;
    if (category) setIfBlank(out, 'categoryOfWork', category);
    if (activity) setIfBlank(out, 'workActivity', activity);
    const em = pickDisplayValue(ed.excavationMethod);
    if (em) setIfBlank(out, 'excavationMethod', em);
    if (!listPoll) delete out.workType;
    const descParts = [out.workActivity || activity, out.categoryOfWork || category, purpose].filter(Boolean);
    if (descParts.length && isBlank(out.workDescription)) out.workDescription = descParts.join(' — ');

    if (out.isBoring == null) {
        if (boolish(ed.isBoring)) out.isBoring = true;
        else if (ed.isBoring === false || ed.isBoring === 'false') out.isBoring = false;
    }
    if (out.isBlasting == null) {
        if (boolish(ed.isBlasting)) out.isBlasting = true;
        else if (ed.isBlasting === false || ed.isBlasting === 'false') out.isBlasting = false;
    }

    const wob = pickDisplayValue(ed.workingOnBehalf);
    if (wob) out.ngenWorkingOnBehalf = wob;
    const woba = pickDisplayValue(ed.workingOnBehalfOfAuth);
    if (woba) out.ngenWorkingOnBehalfOfAuth = woba;
    const exDepth = pickDisplayValue(ed.excavationDepth);
    if (exDepth) setIfBlank(out, 'ngenExcavationDepth', exDepth);

    if (ed.userReference != null && String(ed.userReference).trim() !== '') {
        out.ngenUserReference = String(ed.userReference).trim();
    }
    if (ed.notes != null && String(ed.notes).trim() !== '') {
        const sc = String(ed.notes).trim();
        out.ngenNotes = sc;
        out.scopeOfWork = sc;
        out.ticketScope = sc;
    } else if (!listPoll) {
        out.ngenNotes = null;
        out.scopeOfWork = null;
        out.ticketScope = null;
    }
    if (ed.priority != null && String(ed.priority).trim() !== '') {
        out.ngenPriority = String(ed.priority).trim();
    }

    if (ed.principalContactName != null && String(ed.principalContactName).trim() !== '') {
        out.ngenPrincipalContactName = String(ed.principalContactName).trim();
    }
    if (ed.principalContactPhone != null && String(ed.principalContactPhone).trim() !== '') {
        out.ngenPrincipalContactPhone = String(ed.principalContactPhone).trim();
    }

    const prevLine = firstNonEmpty(
        ed.previousRequestNumber != null ? String(ed.previousRequestNumber).trim() : null,
        ed.previousExternalRequestNumber != null ? String(ed.previousExternalRequestNumber).trim() : null
    );
    if (prevLine) out.ngenPreviousRequestNumber = prevLine;
    if (ed.status != null && String(ed.status).trim() !== '') {
        out.ngenEnquiryStatus = String(ed.status).trim();
    }
    if (ed.lodgedOn != null && String(ed.lodgedOn).trim() !== '') {
        out.ngenLodgedOn = String(ed.lodgedOn).trim();
    }
    if (ed.lastUpdatedTime != null && String(ed.lastUpdatedTime).trim() !== '') {
        out.ngenLastUpdatedTime = String(ed.lastUpdatedTime).trim();
    }

    if (ed.lodgedByUserName != null && String(ed.lodgedByUserName).trim() !== '') {
        const lodgedBy = String(ed.lodgedByUserName).trim().toLowerCase();
        if (isBlank(out.originalLodgedByUserName)) out.originalLodgedByUserName = lodgedBy;
        out.lodgedByUserName = lodgedBy;
    }

    if (ed.commencementDate) out.startTime = String(ed.commencementDate);
    if (ed.ticketExpiration) {
        const exp = String(ed.ticketExpiration);
        out.endTime = exp;
        out.ticketExpirationDate = exp;
    }
    const workLegal = ed.workLegalStartDate || ed.WorkLegalStartDate;
    if (workLegal) out.legalStartDate = String(workLegal);

    if (ed.jobNumber != null) out.ngenJobNumber = ed.jobNumber;

    if (ed.requestNumber != null && String(ed.requestNumber).trim() !== '') {
        const rn = String(ed.requestNumber).trim();
        out.ticketNumberFull = rn;
        const parts = ticketBuilder.parseTicketNumberParts(rn);
        if (parts.revisionSuffix != null && String(parts.revisionSuffix).trim() !== '') {
            out.ticketRevision = parts.revisionSuffix;
        }
    }

    const lngFromSearch = ed.xLocation != null ? parseFloat(String(ed.xLocation)) : NaN;
    const latFromSearch = ed.yLocation != null ? parseFloat(String(ed.yLocation)) : NaN;
    if (!storedTicketHasPolygon(out) && Number.isFinite(latFromSearch) && Number.isFinite(lngFromSearch)) {
        out.stubMapPin = { lat: latFromSearch, lng: lngFromSearch };
    }

    applyNgenEnquiryCapabilityFlags(out, ed);
    applyNgenResponseCounts(out, ed, countOpts);
}

/**
 * nGen `callerDetails` sits on the **root** of GetCurrentUserEnquiryAsync and each SearchCurrentUserEnquiriesAsync row
 * (sibling of `enquiryDetails`). Sets `createdBy` to `firstName` + ` ` + `lastName` only when `createdBy` is still empty
 * (PAC/POSR attribution wins when present).
 * @param {object} out ticket merge target
 * @param {object|null|undefined} enquiryOrSearchItem envelope with optional `callerDetails` / `CallerDetails`
 */
function applyNgenCallerDetailsToTicket(out, enquiryOrSearchItem) {
    if (!out || !enquiryOrSearchItem || typeof enquiryOrSearchItem !== 'object') return;
    const cd = enquiryOrSearchItem.callerDetails ?? enquiryOrSearchItem.CallerDetails;
    if (!cd || typeof cd !== 'object') return;
    const fnRaw = cd.firstName ?? cd.FirstName;
    const lnRaw = cd.lastName ?? cd.LastName;
    const fn = fnRaw != null ? String(fnRaw).trim() : '';
    const ln = lnRaw != null ? String(lnRaw).trim() : '';
    const line = [fn, ln].filter((s) => s !== '').join(' ');
    if (!line) return;
    const cur = out.createdBy != null ? String(out.createdBy).trim() : '';
    if (!cur) out.createdBy = line;
}

/**
 * @param {object} ticket existing canonical ticket
 * @param {object} enquirySearch EnquirySearch-shaped JSON from GetCurrentUserEnquiryAsync
 * @returns {object}
 */
function mergeEnquirySearchIntoTicket(ticket, enquirySearch) {
    const out = { ...(ticket && typeof ticket === 'object' ? ticket : {}) };
    const ed =
        enquirySearch && (enquirySearch.enquiryDetails || enquirySearch.EnquiryDetails)
            ? enquirySearch.enquiryDetails || enquirySearch.EnquiryDetails
            : null;

    if (ed) {
        applyEnquiryDetailsScalarsToTicket(out, ed, { listPoll: false, responseCounts: {} });
        out.ticketDetailsSource = 'ngen_enquiry_search';
        out.ngenEnquirySearchFetchedAt = new Date().toISOString();
    }

    applyEnquiryNotificationsToTicket(out, enquirySearch);

    if (!ed) {
        const raw = enquirySearch && enquirySearch.notifications != null ? enquirySearch.notifications : enquirySearch && enquirySearch.Notifications;
        if (Array.isArray(raw) && raw.length > 0) {
            out.ticketDetailsSource = 'ngen_enquiry_search';
            out.ngenEnquirySearchFetchedAt = new Date().toISOString();
        }
    }

    if (Array.isArray(out.operatorResponses) && out.operatorResponses.length > 0) {
        delete out.ngenSearchStub;
        // Keep stubMapPin — lean list / map markers need a pin even when polygon exists.
    }

    applyNgenCallerDetailsToTicket(out, enquirySearch);
    applyPhotoRequirementFields(out);
    return out;
}

/**
 * Org-specific fields to preserve when re-syncing a search stub over an existing row.
 * @param {object} prev
 * @returns {object}
 */
function pickPersistedOrgFieldsFromTicket(prev) {
    if (!prev || typeof prev !== 'object') return {};
    const o = {};
    if (prev.shared != null) o.shared = prev.shared;
    if (prev.sharedSourceLabel != null) o.sharedSourceLabel = prev.sharedSourceLabel;
    if (prev.sharedSourceOrgId != null) o.sharedSourceOrgId = prev.sharedSourceOrgId;
    if (prev.externalImportedToOrg != null) o.externalImportedToOrg = prev.externalImportedToOrg;
    return o;
}

/**
 * Canonical ticket object for a row created/updated from SearchCurrentUserEnquiriesAsync list items only (lazy sync).
 * Uses list {@link enquiryDetails} and root `callerDetails` (first/last name). Does **not** use list `notifications[]` — USAN list rows omit full notification
 * payloads; `authorityId` and operator/notification detail come from GetCurrentUserEnquiryAsync when the user
 * opens or refreshes the ticket ({@link mergeEnquirySearchIntoTicket} on that response).
 * @param {object} item One element of `enquiries[]` from search response
 * @returns {object|null}
 */
function buildTicketDataFromNgenSearchListItem(item) {
    if (!item || typeof item !== 'object') return null;
    const ed = item.enquiryDetails || item.EnquiryDetails;
    if (!ed || typeof ed !== 'object') return null;
    const rn = ed.requestNumber != null ? String(ed.requestNumber).trim() : '';
    if (!rn) return null;
    const parsed = ticketBuilder.parseTicketNumberParts(rn);
    const base = parsed.baseNumber || ticketBuilder.normalizeTicketBase(rn) || rn.split('-')[0];
    const seed = {
        ticketNumber: base,
        importedAt: new Date().toISOString(),
        source: 'nv_api',
        ngenSearchStub: true,
        operatorResponses: [],
    };
    const pseudoEnquirySearch = { enquiryDetails: ed, notifications: null };
    const rootCaller = item.callerDetails ?? item.CallerDetails;
    if (rootCaller && typeof rootCaller === 'object') {
        pseudoEnquirySearch.callerDetails = rootCaller;
    }
    let out = mergeEnquirySearchIntoTicket(seed, pseudoEnquirySearch);
    applyNgenResponseCounts(out, ed, { clearMissing: true });
    const lng = ed.xLocation != null ? parseFloat(String(ed.xLocation)) : NaN;
    const lat = ed.yLocation != null ? parseFloat(String(ed.yLocation)) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
        out.stubMapPin = { lat, lng };
    }
    return out;
}

/**
 * Merge list-poll metadata from a search row into an existing ticket object (counts, address, pin when no polygon).
 * When the row is still a search stub, replace stub payload but keep assignees / sharing.
 * Does not treat Search as a source of `notifications` / authority ids — only enquiryDetails scalars (and stub
 * rebuild via {@link buildTicketDataFromNgenSearchListItem}, which omits list notifications by design).
 * @param {object} prev prior ticket object
 * @param {object} searchItem one enquiries[] element
 * @returns {object}
 */
function mergePollSearchMetadataIntoTicket(prev, searchItem) {
    if (!prev || typeof prev !== 'object') return prev;
    const ed =
        searchItem && (searchItem.enquiryDetails || searchItem.EnquiryDetails)
            ? searchItem.enquiryDetails || searchItem.EnquiryDetails
            : null;
    if (!ed || typeof ed !== 'object') return prev;

    if (prev.ngenSearchStub === true) {
        const fresh = buildTicketDataFromNgenSearchListItem(searchItem);
        if (fresh) {
            const out = { ...fresh, ...pickPersistedOrgFieldsFromTicket(prev) };
            if (!storedTicketHasPolygon(out) && storedTicketHasPolygon(prev)) {
                out.polygon = prev.polygon;
                if (prev.bbox != null) out.bbox = prev.bbox;
            }
            return out;
        }
        return prev;
    }

    const next = { ...prev };
    applyEnquiryDetailsScalarsToTicket(next, ed, { listPoll: true, responseCounts: { clearMissing: true } });
    applyNgenCallerDetailsToTicket(next, searchItem);
    next.ticketDetailsSource = 'ngen_enquiry_search';
    next.ngenEnquirySearchFetchedAt = new Date().toISOString();
    if (Array.isArray(next.operatorResponses) && next.operatorResponses.length > 0) {
        delete next.ngenSearchStub;
        // Keep stubMapPin — lean list / map markers need a pin even when polygon exists.
    }
    applyPhotoRequirementFields(next);
    return next;
}

/**
 * Deterministic JSON-like stringify for fingerprinting (sorted object keys; arrays keep order).
 * @param {unknown} value
 * @returns {string}
 */
function stableStringifyForFingerprint(value) {
    if (value === null || value === undefined) return 'null';
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return JSON.stringify(value);
    if (t === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) {
        return '[' + value.map((x) => stableStringifyForFingerprint(x)).join(',') + ']';
    }
    if (t === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringifyForFingerprint(value[k])).join(',') + '}';
    }
    return 'null';
}

/**
 * SHA-256 hex digest of list-row fields that drive list-poll merge/stub updates.
 * @param {object} item one enquiries[] element from SearchCurrentUserEnquiriesAsync
 * @returns {Promise<string>}
 */
async function fingerprintNgenSearchListItem(item) {
    if (!item || typeof item !== 'object') {
        const payload = stableStringifyForFingerprint(null);
        const enc = new TextEncoder().encode(payload);
        const digest = await crypto.subtle.digest('SHA-256', enc);
        const bytes = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }
    const ed = item.enquiryDetails || item.EnquiryDetails;
    const caller = item.callerDetails ?? item.CallerDetails;
    const notifs = item.notifications ?? item.Notifications;
    const payload = stableStringifyForFingerprint({ ed, caller, notifs });
    const enc = new TextEncoder().encode(payload);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

module.exports = {
    mergeEnquirySearchIntoTicket,
    buildTicketDataFromNgenSearchListItem,
    mergePollSearchMetadataIntoTicket,
    fingerprintNgenSearchListItem,
    formatDigSiteAddress,
    formatFullAddressField,
    resolveEnquiryDigSiteAddressLine,
    formatNvStructuredDigSiteAddress,
    formatLegacyLineAddress,
};
