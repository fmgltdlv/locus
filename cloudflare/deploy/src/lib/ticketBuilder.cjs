/**
 * Ticket builder: single source of truth for canonical ticket shape, status logic,
 * GML→GeoJSON, and build-from-POSR.
 * Portal-only scalars are flattened in {@link parsePosrData} / {@link buildFromPosr} (no separate raw snapshot).
 */

const {
    DEFAULT_NOT_READY_CODES,
    DEFAULT_ACTION_REQUIRED_CODES,
    getOperatorStatusFromCode,
} = require('./operatorResponseCodes.cjs');
const NOT_READY_CODES = DEFAULT_NOT_READY_CODES;
const ACTION_REQUIRED_CODES = DEFAULT_ACTION_REQUIRED_CODES;
/** POSR pending codes for required/received aggregate counts (000/888/999 = no utility response yet). */
const POSR_PENDING_RESPONSE_CODES = new Set(['000', '888', '999']);

const { applyPhotoRequirementFields } = require('./photoRequirementCutoff.cjs');
const { SYNC_LANE_POSR_PUBLIC } = require('./ticketSyncLane.cjs');
const {
    parseInstantForDisplay,
    pacificYmd,
    addDaysToYmd,
    pacificEndOfDayUtcIsoFromYmd,
    pacificCalendarDayDiff,
} = require('./pacificTime.cjs');

// ---------- GML → GeoJSON ----------
/**
 * Extract first polygon from GML string (e.g. from decoded GMLBase64).
 * Looks for gml:posList or posList with space-separated coordinates.
 * @param {string|Buffer} gml - GML XML string or buffer
 * @returns {{ type: 'Polygon', coordinates: number[][][] } | null}
 */
function gmlToGeoJSON(gml) {
    if (!gml) return null;
    const str = Buffer.isBuffer(gml) ? gml.toString('utf8') : String(gml);
    // Match <gml:posList>...</gml:posList> or <posList>...</posList>
    const match = str.match(/<(?:\w+:)?posList[^>]*>([^<]+)</i);
    if (!match) return null;
    const parts = match[1].trim().split(/\s+/).filter(Boolean);
    if (parts.length < 6) return null; // at least 3 points = 6 numbers
    const coords = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const x = parseFloat(parts[i]);
        const y = parseFloat(parts[i + 1]);
        if (isNaN(x) || isNaN(y)) continue;
        coords.push([x, y]);
    }
    if (coords.length < 3) return null;
    // Close ring
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([coords[0][0], coords[0][1]]);
    }
    return { type: 'Polygon', coordinates: [coords] };
}

// ---------- WKT → GeoJSON ----------
/**
 * Parse a WKT POLYGON string into GeoJSON.
 * @param {string} wkt - e.g. "POLYGON((-115.18 36.16, ...))"
 * @returns {{ type: 'Polygon', coordinates: number[][][] } | null}
 */
function wktToGeoJSON(wkt) {
    if (!wkt || typeof wkt !== 'string') return null;
    const match = wkt.match(/POLYGON\s*\(\(([^)]+)\)\)/i);
    if (!match) return null;
    const pairs = match[1].split(',').map((s) => s.trim()).filter(Boolean);
    const coords = [];
    for (const pair of pairs) {
        const parts = pair.split(/\s+/);
        if (parts.length >= 2) {
            const lng = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!isNaN(lng) && !isNaN(lat)) coords.push([lng, lat]);
        }
    }
    if (coords.length < 3) return null;
    // Close ring if needed
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([coords[0][0], coords[0][1]]);
    }
    return { type: 'Polygon', coordinates: [coords] };
}

// ---------- Status logic (no overrides in builder) ----------
function getOperatorStatus(responseCode, codeLists) {
    return getOperatorStatusFromCode(responseCode, codeLists);
}

function operatorResponseStatusCode(response) {
    if (!response || typeof response !== 'object') return null;
    const code = response.statusCode != null ? response.statusCode : response.responseCode;
    if (code == null || String(code).trim() === '') return null;
    return String(code).trim();
}

function isPosrPendingResponseCode(responseCode) {
    if (responseCode == null || String(responseCode).trim() === '') return true;
    return POSR_PENDING_RESPONSE_CODES.has(String(responseCode).trim());
}

/**
 * Derive nGen-shaped response counts from POSR operator rows for map/list summary workflow.
 * required = utilities on ticket; received = rows whose code is not 000/888/999.
 * @returns {{ ngenRequiredResponseCount: number, ngenReceivedResponseCount: number } | null}
 */
function derivePosrResponseCountsFromOperatorRows(operatorResponses, stationCodes) {
    const rows = Array.isArray(operatorResponses) ? operatorResponses : [];
    const codes = Array.isArray(stationCodes) ? stationCodes : [];
    const required = codes.length > 0 ? codes.length : rows.length;
    if (required <= 0) return null;
    let received = 0;
    for (const row of rows) {
        if (!isPosrPendingResponseCode(operatorResponseStatusCode(row))) {
            received += 1;
        }
    }
    return {
        ngenRequiredResponseCount: required,
        ngenReceivedResponseCount: received,
    };
}

function isNvPublicImportTicketSource(source) {
    const s = source != null ? String(source).trim() : '';
    return s === 'nv_api' || s === 'nv_api_cache';
}

function shouldApplyPosrDerivedResponseCounts(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    if (ticket.syncLane === SYNC_LANE_POSR_PUBLIC) return true;
    return isNvPublicImportTicketSource(ticket.source);
}

/**
 * Persist POSR-derived required/received counts on public-import tickets (sync_lane posr_public).
 * @param {object} ticket
 * @returns {object}
 */
function applyPosrDerivedResponseCounts(ticket) {
    if (!shouldApplyPosrDerivedResponseCounts(ticket)) return ticket;
    const derived = derivePosrResponseCountsFromOperatorRows(ticket.operatorResponses, ticket.stationCodes);
    if (!derived) return ticket;
    ticket.ngenRequiredResponseCount = derived.ngenRequiredResponseCount;
    ticket.ngenReceivedResponseCount = derived.ngenReceivedResponseCount;
    return ticket;
}

function isTicketExpired(expirationDate) {
    if (!expirationDate) return false;
    try {
        const inst = parseTicketExpirationInstant(expirationDate);
        if (!inst) return false;
        // Match D1 expired list: expired once the actual expiration instant has passed.
        return inst.getTime() <= Date.now();
    } catch (_) {
        return false;
    }
}

/**
 * Parse a ticket expiration value into an absolute instant (Date), for time-based
 * expiry that matches the D1 `julianday(ticket_expires_at) <= julianday('now')` predicate.
 * A ticket stays valid until this instant passes (matches client ticket-status.js).
 * - Datetime with numeric ±offset or Z: that exact instant
 * - Naive datetime: runtime-local instant
 * - Date-only YYYY-MM-DD: END of that Pacific calendar day (valid through the whole day)
 */
function parseTicketExpirationInstant(expirationDate) {
    if (expirationDate == null || expirationDate === '') return null;
    try {
        if (expirationDate instanceof Date) {
            return isNaN(expirationDate.getTime()) ? null : expirationDate;
        }
        const s = String(expirationDate).trim();
        if (!s) return null;

        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            return new Date(pacificEndOfDayUtcIsoFromYmd(s));
        }

        const d = parseInstantForDisplay(s);
        return d == null || isNaN(d.getTime()) ? null : d;
    } catch (_) {
        return null;
    }
}

function isExpiringSoon(expirationDate, withinDays) {
    if (withinDays == null || withinDays === undefined) withinDays = 5;
    if (!expirationDate || isTicketExpired(expirationDate)) return false;
    const inst = parseTicketExpirationInstant(expirationDate);
    if (!inst) return false;
    const diffDays = pacificCalendarDayDiff(Date.now(), inst.getTime());
    return diffDays >= 0 && diffDays <= withinDays;
}

function calculateTicketStatus(operatorResponses, ticketNumber, expirationDate, ticketPolygon, stationCodes) {
    if (isTicketExpired(expirationDate)) return 'EXPIRED';
    if (isExpiringSoon(expirationDate)) return 'EXPIRING_SOON';

    const responseRows = Array.isArray(operatorResponses) ? operatorResponses : [];
    const actualCount = responseRows.length;
    const effectiveStatuses = responseRows.map((r) => getOperatorStatus(r.statusCode));

    const expectedCount = stationCodes && stationCodes.length > 0 ? stationCodes.length : 0;

    if (expectedCount > 0 && actualCount < expectedCount) {
        return 'NOT_READY';
    }

    const canEvaluateOperators = expectedCount === 0 ? actualCount > 0 : actualCount >= expectedCount;

    if (canEvaluateOperators && effectiveStatuses.includes('NOT_READY')) {
        return 'ACTION_REQUIRED';
    }

    if (canEvaluateOperators && effectiveStatuses.includes('ACTION_REQUIRED')) {
        return 'ACTION_REQUIRED';
    }

    return 'READY';
}

function getOutstandingOperators(operatorResponses, ticketNumber) {
    if (!operatorResponses || operatorResponses.length === 0) return [];
    return operatorResponses
        .filter((r) => {
            const status = getOperatorStatus(r.statusCode);
            return status === 'NOT_READY' || status === 'ACTION_REQUIRED';
        })
        .map((r) => r.operatorName || r.stationCode || 'Unknown Operator')
        .filter((name) => name && name !== 'Unknown Operator');
}

/**
 * Workflow status and outstanding-operator list are derived in the client from responses, expiration, and photos.
 * Do not persist them — avoids stale rows and a second source of truth.
 * @param {object} ticketData
 * @returns {object}
 */
function stripDerivedTicketUiFields(ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return ticketData;
    const out = { ...ticketData };
    delete out.status;
    delete out.outstandingOperators;
    delete out.ticketType;
    delete out.isEmergency;
    delete out.excavatorRemarks;
    delete out.rawData;
    delete out.posrTicket;
    return out;
}

const CANONICAL_KEYS = new Set([
    'ticketNumber', 'ticketRevision', 'ticketNumberFull', 'polygon', 'operatorResponses', 'stationCodes', 'stationDetails',
    'status', 'outstandingOperators',
    'startTime', 'endTime', 'locationSummary', 'workDescription', 'workType', 'workActivity', 'createdBy', 'address',
    'excavationMethod', 'history', 'importedAt', 'source', 'id',
]);

// ---------- POSR path: build from POSR API + map data ----------
function normalizeTicketBase(ticketNumber) {
    return String(ticketNumber || '').split('-')[0];
}

/**
 * USAN ticket numbers use a base (request #) and optional revision suffix after the first dash, e.g. 2026030500318-000.
 * @returns {{ baseNumber: string, revisionSuffix: string | null, displayFull: string }}
 */
function parseTicketNumberParts(ticketNumber) {
    const raw = String(ticketNumber || '').trim();
    if (!raw) {
        return { baseNumber: '', revisionSuffix: null, displayFull: '' };
    }
    const idx = raw.indexOf('-');
    if (idx === -1) {
        return { baseNumber: raw, revisionSuffix: null, displayFull: raw };
    }
    const baseNumber = raw.slice(0, idx);
    const revisionSuffix = raw.slice(idx + 1) || null;
    return { baseNumber, revisionSuffix, displayFull: raw };
}

/**
 * Parse polygon coords from map page format to GeoJSON (same logic as frontend).
 * @param {number[][]} polygonCoords - From map HTML spatialObjectDescription
 */
function mapCoordsToGeoJSON(polygonCoords) {
    if (!polygonCoords || polygonCoords.length < 3) return null;
    const first = polygonCoords[0];
    const x = first[0];
    const y = first[1];
    const isLngLat = Math.abs(x) > Math.abs(y) && x < 0 && y > 0 && Math.abs(x) < 180 && Math.abs(y) < 90;
    const geoJsonCoords = isLngLat
        ? polygonCoords.map((c) => [c[0], c[1]])
        : polygonCoords.map((c) => [c[1], c[0]]);
    geoJsonCoords.push(geoJsonCoords[0]);
    return { type: 'Polygon', coordinates: [geoJsonCoords] };
}

function firstNonEmptyString(...candidates) {
    for (const c of candidates) {
        if (c == null) continue;
        const t = typeof c === 'string' ? c.trim() : String(c).trim();
        if (t !== '') return t;
    }
    return null;
}

/**
 * NV GetJobsListForTable uses `posrTicket.ticketHistory` (not `jobs`). Map into the same shape as legacy
 * `jobs` rows and map-derived history so {@link buildFromPosr} + photo cutoff see consistent fields.
 * Newest-first by `responseDate` (matches map table semantics in {@link findPosrHistory000CutoffIso}).
 * @param {unknown} rows
 * @returns {object[]}
 */
function mapPosrTicketHistoryToCanonicalJobsShape(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const sorted = [...rows].sort((a, b) => {
        const ta = new Date(a?.responseDate || a?.ResponseDate || 0).getTime();
        const tb = new Date(b?.responseDate || b?.ResponseDate || 0).getTime();
        return tb - ta;
    });
    return sorted.map((job) => ({
        id: job.id || job.jobId || null,
        operatorName: job.operatorName || job.OperatorName || job.name || job.Name || null,
        operatorCode: job.operatorCode || job.operator_code || job.code || job.Code || null,
        statusCode: job.statusCode || job.status_code || job.responseCode || job.ResponseCode || null,
        respondedAt: job.respondedAt || job.responded_at || job.responseDate || job.ResponseDate || null,
        comment: firstNonEmptyString(
            job.comment,
            job.Comment,
            job.notes,
            job.responseDescription,
            job.ResponseDescription
        ),
        requestNumberFull:
            job.requestNumber != null
                ? String(job.requestNumber).trim()
                : job.request_number != null
                  ? String(job.request_number).trim()
                  : null,
    }));
}

/**
 * Street / dig-site address for the locate (not excavator mailing address).
 * Prefer explicit dig-site keys before generic `address` / `location`.
 */
function pickDigSiteAddressFromPosrTicket(posrTicket, data) {
    const pt = posrTicket && typeof posrTicket === 'object' ? posrTicket : {};
    const root = data && typeof data === 'object' ? data : {};
    const loc = pt.location ?? pt.Location;
    let locStr = null;
    if (typeof loc === 'string' || typeof loc === 'number') {
        locStr = String(loc).trim() || null;
    } else if (loc && typeof loc === 'object' && typeof loc.address === 'string') {
        locStr = loc.address.trim() || null;
    }
    return firstNonEmptyString(
        pt.digSiteAddress,
        pt.DigSiteAddress,
        pt.DigsiteAddress,
        pt.addressLocation,
        pt.AddressLocation,
        pt.digSiteAddressLine,
        pt.digSiteStreet,
        root.digSiteAddress,
        root.DigSiteAddress,
        root.DigsiteAddress,
        pt.address,
        pt.Address,
        locStr,
        root.address,
        root.Address
    );
}

/**
 * Parse POSR API response into flat structure (same as frontend parsePosrData).
 */
function parsePosrData(data) {
    const workExpirationDate = data?.workExpirationDate || data?.workExpiration_date || data?.work_expiration_date || null;
    const posrTicket = data?.posrTicket || {};
    const stations = posrTicket.stations || [];
    const stationCodes = stations.filter((s) => s && s.code).map((s) => s.code);
    const fromJobs = (posrTicket.jobs || data?.jobs || []).map((job) => ({
        id: job.id || job.jobId || null,
        operatorName: job.operatorName || job.operator_name || null,
        operatorCode: job.operatorCode || job.operator_code || null,
        statusCode: job.statusCode || job.status_code || null,
        respondedAt: job.respondedAt || job.responded_at || job.responseDate || null,
        comment: job.comment || job.notes || null,
        requestNumberFull:
            job.requestNumber != null
                ? String(job.requestNumber).trim()
                : job.request_number != null
                  ? String(job.request_number).trim()
                  : null,
    }));
    const rawTicketHistory = posrTicket.ticketHistory || posrTicket.TicketHistory;
    const fromTicketHistory = mapPosrTicketHistoryToCanonicalJobsShape(rawTicketHistory);
    const history = fromTicketHistory.length > 0 ? fromTicketHistory : fromJobs;
    return {
        ticketNumber: posrTicket.ticketNumber || posrTicket.ticket_number || posrTicket.requestNumber || posrTicket.request_number || null,
        stationCodes,
        stationDetails: stations.map((s) => {
            const authority = s.authority || s.Authority;
            let authorityId = null;
            if (authority && typeof authority === 'object' && authority.id != null && String(authority.id).trim() !== '') {
                authorityId = String(authority.id).trim();
            } else if (s.authorityId != null && String(s.authorityId).trim() !== '') {
                authorityId = String(s.authorityId).trim();
            } else if (s.AuthorityId != null && String(s.AuthorityId).trim() !== '') {
                authorityId = String(s.AuthorityId).trim();
            }
            return {
                code: s.code || s.Code || s.stationCode || s.StationCode || null,
                name: s.name || s.Name || s.operatorName || s.StationCodeName || null,
                responseDate: s.responseDate || s.ResponseDate || s.respondedAt || s.responseReceived || null,
                responseCode: s.responseCode || s.ResponseCode || s.code || null,
                comment: firstNonEmptyString(
                    s.comment,
                    s.Comment,
                    s.notes,
                    s.responseDescription,
                    s.ResponseDescription
                ),
                authorityId,
            };
        }),
        workType: firstNonEmptyString(
            posrTicket.workType,
            posrTicket.WorkType,
            posrTicket.work_type,
            data?.workType,
            data?.WorkType,
            data?.work_type
        ),
        workActivity: posrTicket.workActivity || posrTicket.WorkActivity || posrTicket.work_activity || null,
        createdBy: posrTicket.createdBy || posrTicket.CreatedBy || posrTicket.requester || posrTicket.createdByUserName || null,
        /** Prefer nested ISO `jobStartDate` over root locale string when both exist (GetJobsListForTable). */
        requestDate: firstNonEmptyString(
            posrTicket.requestDate,
            posrTicket.request_date,
            posrTicket.createdDate,
            posrTicket.jobStartDate,
            posrTicket.JobStartDate,
            data?.jobStartDate,
            data?.JobStartDate
        ),
        dueDate: workExpirationDate || posrTicket.dueDate || posrTicket.endDate || posrTicket.workExpirationDate || null,
        workExpirationDate,
        address: pickDigSiteAddressFromPosrTicket(posrTicket, data),
        /** USAN portal labels this "Ticket Scope" (POSR `additionalRemarks` on posrTicket). */
        ticketScope: firstNonEmptyString(
            posrTicket.additionalRemarks,
            posrTicket.AdditionalRemarks,
            posrTicket.additional_remarks,
            data?.additionalRemarks,
            data?.AdditionalRemarks
        ),
        excavationMethod: posrTicket.excavationMethod || posrTicket.ExcavationMethod || null,
        history,
        nearbyCrossStreet: firstNonEmptyString(posrTicket.nearbyCrossStreet, posrTicket.NearestCrossStreet),
        /** USAN portal ticket type (distinct from Pelican `ticketType`); persisted as `portalTicketType`. */
        portalTicketType: firstNonEmptyString(posrTicket.ticketType, posrTicket.TicketType),
        zipcode: (() => {
            const z = posrTicket.zipcode ?? posrTicket.zipCode;
            if (z == null) return null;
            const s = String(z).trim();
            return s === '' ? null : s;
        })(),
        city: firstNonEmptyString(posrTicket.city, posrTicket.CityTownPlace),
        county: posrTicket.county != null && String(posrTicket.county).trim() !== '' ? String(posrTicket.county).trim() : null,
        state: posrTicket.state != null && String(posrTicket.state).trim() !== '' ? String(posrTicket.state).trim() : null,
        customerPhone: firstNonEmptyString(posrTicket.phone),
        customerMobile: firstNonEmptyString(posrTicket.mobile),
        customerEmail: firstNonEmptyString(posrTicket.email),
        locationSummary: firstNonEmptyString(posrTicket.locationSummary),
        streetSidewalkOrParkstrip: (() => {
            const v = posrTicket.streetSidewalkOrParkstrip;
            if (v === true || v === false) return v;
            const r = data?.streetSideWalkOrParkstrip ?? data?.StreetSideWalkOrParkstrip;
            if (r != null && String(r).trim() !== '') return String(r).trim();
            return null;
        })(),
    };
}

/**
 * Parse map page HTML for polygon and optional history.
 */
function parseMapPageHtml(html) {
    if (!html || typeof html !== 'string') return { coords: null, history: [] };
    const pattern = /var spatialObjectDescription = 'POLYGON\((.*?)\)';/;
    const match = html.match(pattern);
    let coords = null;
    if (match) {
        const coordStrings = match[1].replace(/[()]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
        coords = [];
        for (const coordStr of coordStrings) {
            const parts = coordStr.split(/\s+/);
            if (parts.length >= 2) {
                const x = parseFloat(parts[0]);
                const y = parseFloat(parts[1]);
                if (!isNaN(x) && !isNaN(y)) coords.push([x, y]);
            }
        }
        if (coords.length < 3) coords = null;
    }
    const history = [];
    const historyTableMatch = html.match(/<div[^>]*data-role="table-container-history"[^>]*>([\s\S]*?)(?:<\/div>\s*<div[^>]*data-role="standard-view"|$)/);
    if (historyTableMatch) {
        const rowPattern = /<tr[^>]*data-complex-table-identifier="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
        let rowMatch;
        while ((rowMatch = rowPattern.exec(historyTableMatch[1])) !== null) {
            const rowHTML = rowMatch[1];
            if (rowHTML.includes('footer-row') || rowHTML.includes("That's all the results")) continue;
            const cellPattern = /<td[^>]*>[\s\S]*?data-content="([^"]*)"[\s\S]*?<\/td>/g;
            const cells = [];
            let cellMatch;
            while ((cellMatch = cellPattern.exec(rowHTML)) !== null) {
                const c = cellMatch[1].trim();
                if (c) cells.push(c);
            }
            if (cells.length >= 6) {
                const fullFromCell0 = cells[0] != null && String(cells[0]).trim() !== '' ? String(cells[0]).trim() : null;
                history.push({
                    ticketNumber: fullFromCell0,
                    fullRequestNumber: fullFromCell0,
                    stationCode: cells[1] || null,
                    stationCodeName: cells[2] || null,
                    responseReceived: cells[3] || null,
                    responseCode: cells[4] || null,
                    comment: (cells[6] && cells[6].trim()) || null,
                });
            }
        }
    }
    return { coords, history };
}

/**
 * Build full canonical ticket from POSR API response + map page result (import-by-number path).
 * @param {object} posrData - From parsePosrData(apiResponse)
 * @param {{ coords: number[][] | null, history?: object[] }} mapData - From parseMapPageHtml(html) or fetch
 */
function buildFromPosr(posrData, mapData) {
    const rawTicket = String(posrData.ticketNumber || '').trim();
    const tnParts = parseTicketNumberParts(rawTicket);
    const ticketNumber = tnParts.baseNumber || normalizeTicketBase(rawTicket) || 'unknown';
    const ticketRevision = tnParts.revisionSuffix != null ? tnParts.revisionSuffix : null;
    const ticketNumberFull = tnParts.displayFull || rawTicket || ticketNumber;
    const polygonCoords = (mapData && mapData.coords) || null;
    const ticketPolygon = polygonCoords ? mapCoordsToGeoJSON(polygonCoords) : null;
    const expirationScalar =
        posrData.workExpirationDate != null && String(posrData.workExpirationDate).trim() !== ''
            ? String(posrData.workExpirationDate).trim()
            : posrData.dueDate || null;

    const historyFromMap = (mapData && mapData.history) || [];
    const historyFromPosr = posrData.history || [];
    const combinedHistory =
        historyFromMap.length > 0
            ? historyFromMap.map((h) => ({
                  id: `hist-${Date.now()}-${Math.random()}`,
                  requestNumberFull:
                      h.fullRequestNumber != null && String(h.fullRequestNumber).trim() !== ''
                          ? String(h.fullRequestNumber).trim()
                          : h.ticketNumber != null
                            ? String(h.ticketNumber).trim()
                            : null,
                  ticketNumber: normalizeTicketBase(h.ticketNumber) || h.ticketNumber || ticketNumber,
                  operatorCode: h.stationCode || null,
                  operatorName: h.stationCodeName || null,
                  respondedAt: h.responseReceived || null,
                  statusCode: h.responseCode || null,
                  comment: h.comment || null,
              }))
            : historyFromPosr.map((h) => ({
                  ...h,
                  requestNumberFull: h.requestNumberFull || ticketNumberFull,
              }));

    const operatorResponses = (posrData.stationDetails || []).map((station, index) => {
        const responseCode = station.responseCode || null;
        const authorityId =
            station.authorityId != null && String(station.authorityId).trim() !== ''
                ? String(station.authorityId).trim()
                : null;
        const stationCode = station.code || null;
        const codeKey = stationCode != null ? String(stationCode).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase() : `I${index}`;
        return {
            id: `ngen-pend-${codeKey}-${index}`,
            stationCode,
            operatorName: station.name || null,
            operatorCode: station.code || null,
            statusCode: responseCode,
            respondedAt: station.responseDate || null,
            comment: station.comment || null,
            operatorStatus: getOperatorStatus(responseCode),
            authorityId,
            source: 'ngen_pending_sync',
            ticketRevisionSnapshot: ticketRevision != null ? String(ticketRevision).trim() : null,
            ticketNumberFullSnapshot: ticketNumberFull != null ? String(ticketNumberFull).trim() : null,
        };
    });

    const stationCodes = posrData.stationCodes || [];

    const endTimeValue = expirationScalar;
    const jobStartVal = posrData.requestDate || new Date().toISOString();
    const ticket = {
        id: `ticket-${ticketNumber}-${Date.now()}`,
        ticketNumber,
        ticketRevision,
        ticketNumberFull,
        locationSummary: firstNonEmptyString(
            posrData.locationSummary,
            posrData.address,
            stationCodes && stationCodes.length > 0 ? stationCodes.join(', ') : null,
            'Location not specified'
        ),
        workDescription: posrData.workActivity || posrData.workType || 'Work description not available',
        startTime: jobStartVal,
        /** NV API exposes one job start; hub shows it as both job start and legal start. */
        legalStartDate: jobStartVal,
        endTime: endTimeValue,
        /** Explicit copies so clients always see fresh dates after refresh (not only operator responses). */
        workExpirationDate: expirationScalar,
        dueDate: expirationScalar,
        ticketExpirationDate: endTimeValue,
        workType: posrData.workType || null,
        workActivity: posrData.workActivity || posrData.workType || null,
        createdBy: posrData.createdBy || null,
        createdBySource: posrData.createdBy ? 'posr' : null,
        stationCodes,
        stationDetails: posrData.stationDetails || [],
        address: posrData.address || null,
        ticketScope: posrData.ticketScope || null,
        excavationMethod: posrData.excavationMethod || null,
        history: combinedHistory,
        operatorResponses,
        polygon: ticketPolygon,
        importedAt: new Date().toISOString(),
        source: 'nv_api',
        nearbyCrossStreet: posrData.nearbyCrossStreet || null,
        portalTicketType: posrData.portalTicketType || null,
        zipcode: posrData.zipcode || null,
        city: posrData.city || null,
        county: posrData.county || null,
        state: posrData.state || null,
        customerPhone: posrData.customerPhone || null,
        customerMobile: posrData.customerMobile || null,
        customerEmail: posrData.customerEmail || null,
        streetSidewalkOrParkstrip:
            posrData.streetSidewalkOrParkstrip !== undefined && posrData.streetSidewalkOrParkstrip !== null
                ? posrData.streetSidewalkOrParkstrip
                : null,
        syncLane: SYNC_LANE_POSR_PUBLIC,
    };
    applyPhotoRequirementFields(ticket);
    applyPosrDerivedResponseCounts(ticket);
    return ticket;
}

/**
 * Manual import when POSR JSON is unavailable: polygon (+ optional map history) only.
 * @param {string} rawTicketNumber
 * @param {object|null} polygon GeoJSON Polygon
 * @param {{ coords?: number[][]|null, history?: object[] }} [mapData]
 */
function buildFromNgenMapOnly(rawTicketNumber, polygon, mapData) {
    const rawTicket = String(rawTicketNumber || '').trim();
    const tnParts = parseTicketNumberParts(rawTicket);
    const ticketNumber = tnParts.baseNumber || normalizeTicketBase(rawTicket) || 'unknown';
    const ticketRevision = tnParts.revisionSuffix != null ? tnParts.revisionSuffix : null;
    const ticketNumberFull = tnParts.displayFull || rawTicket || ticketNumber;
    const historyFromMap = (mapData && mapData.history) || [];
    const combinedHistory = historyFromMap.map((h) => ({
        id: `hist-${Date.now()}-${Math.random()}`,
        requestNumberFull:
            h.fullRequestNumber != null && String(h.fullRequestNumber).trim() !== ''
                ? String(h.fullRequestNumber).trim()
                : h.ticketNumber != null
                  ? String(h.ticketNumber).trim()
                  : null,
        ticketNumber: normalizeTicketBase(h.ticketNumber) || h.ticketNumber || ticketNumber,
        operatorCode: h.stationCode || null,
        operatorName: h.stationCodeName || null,
        respondedAt: h.responseReceived || null,
        statusCode: h.responseCode || null,
        comment: h.comment || null,
    }));

    const importYmd = pacificYmd(new Date());
    const expireYmd = addDaysToYmd(importYmd, 30);
    const expirationIso = pacificEndOfDayUtcIsoFromYmd(expireYmd);
    const ticket = {
        id: `ticket-${ticketNumber}-${Date.now()}`,
        ticketNumber,
        ticketRevision,
        ticketNumberFull,
        locationSummary: 'Location from USAN map',
        workDescription: 'Open USAN POSR for ticket details',
        startTime: importYmd,
        legalStartDate: importYmd,
        endTime: expirationIso,
        workExpirationDate: expirationIso,
        dueDate: expirationIso,
        ticketExpirationDate: expirationIso,
        operatorResponses: [],
        stationCodes: [],
        stationDetails: [],
        history: combinedHistory,
        polygon: polygon && polygon.type === 'Polygon' ? polygon : null,
        importedAt: new Date().toISOString(),
        source: 'nv_api',
        syncLane: SYNC_LANE_POSR_PUBLIC,
        posrPortalDetailsOnly: true,
        hasFullDetail: true,
    };
    applyPhotoRequirementFields(ticket);
    return ticket;
}

/**
 * Legacy POSR imports used `resp-*` ids. Normalize to the same nGen-first waitlist shape as {@link buildFromPosr}.
 * @param {object|null|undefined} r
 * @param {string|null|undefined} ticketRevision
 * @param {string|null|undefined} ticketNumberFull
 * @param {number} index
 * @returns {object|null|undefined}
 */
function coerceLegacyPosrOperatorRowToNgenPending(r, ticketRevision, ticketNumberFull, index) {
    if (!r || typeof r !== 'object') return r;
    if (typeof r.id !== 'string' || !r.id.startsWith('resp-')) return r;
    const rev = ticketRevision != null ? String(ticketRevision).trim() : null;
    const full = ticketNumberFull != null ? String(ticketNumberFull).trim() : null;
    const code = String(r.stationCode || r.operatorCode || '').trim();
    const codeKey = code ? code.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase() : `I${index}`;
    return {
        ...r,
        id: `ngen-pend-${codeKey}-${index}`,
        source: 'ngen_pending_sync',
        ticketRevisionSnapshot: r.ticketRevisionSnapshot != null ? r.ticketRevisionSnapshot : rev,
        ticketNumberFullSnapshot: r.ticketNumberFullSnapshot != null ? r.ticketNumberFullSnapshot : full,
    };
}

module.exports = {
    gmlToGeoJSON,
    wktToGeoJSON,
    mapCoordsToGeoJSON,
    getOperatorStatus,
    isPosrPendingResponseCode,
    derivePosrResponseCountsFromOperatorRows,
    isNvPublicImportTicketSource,
    shouldApplyPosrDerivedResponseCounts,
    applyPosrDerivedResponseCounts,
    isTicketExpired,
    isExpiringSoon,
    parseTicketExpirationInstant,
    calculateTicketStatus,
    getOutstandingOperators,
    stripDerivedTicketUiFields,
    normalizeTicketBase,
    parseTicketNumberParts,
    parsePosrData,
    parseMapPageHtml,
    buildFromPosr,
    buildFromNgenMapOnly,
    coerceLegacyPosrOperatorRowToNgenPending,
};
