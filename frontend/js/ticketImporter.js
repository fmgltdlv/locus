// Ticket Importer module - Fetches tickets from NV ticket APIs

// API endpoints - Using backend API to avoid CORS issues
// Uses API_BASE_URL from config.js (auto-detects based on current hostname)
// Single source of truth: config-override.js -> window.API_BASE_URL
const BACKEND_URL = window.API_BASE_URL || window.location.origin;
const SOURCE_API = `${BACKEND_URL}/api/tickets/{ticket}`;
const MAP_URL = `${BACKEND_URL}/api/tickets/{base}/map`;
const SOURCE_SEARCH_URL = `${BACKEND_URL}/api/tickets/{ticket}/posr`;

/** Workflow status / outstanding list are client-derived; do not persist (server strips too). */
function ticketDataForPersistence(ticket) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    const { status, outstandingOperators, ...rest } = ticket;
    return rest;
}

// Status engine lives in tickets/ticket-status.js (loaded before this file).

// Headers for API requests
const HEADERS = {
    'User-Agent': 'Mozilla/5.0'
};

// Normalize ticket base (remove suffix after first '-')
function normalizeTicketBase(ticketNumber) {
    return String(ticketNumber || '').split('-')[0];
}

/**
 * Same shape as backend parseTicketNumberParts: base request # vs revision suffix (e.g. -000).
 * @returns {{ baseNumber: string, revisionSuffix: string | null, displayFull: string }}
 */
function parseTicketNumberParts(ticket) {
    if (ticket && ticket.ticketBaseNumber != null && String(ticket.ticketBaseNumber).trim() !== '') {
        const rev =
            ticket.ticketRevision != null && ticket.ticketRevision !== ''
                ? String(ticket.ticketRevision)
                : null;
        const displayFull = String(ticket.ticketNumber || '').trim();
        return { baseNumber: String(ticket.ticketBaseNumber), revisionSuffix: rev, displayFull };
    }
    const raw = String((ticket && ticket.ticketNumber) || '').trim();
    if (!raw) return { baseNumber: '', revisionSuffix: null, displayFull: '' };
    const idx = raw.indexOf('-');
    if (idx === -1) {
        const revFromField =
            ticket && ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== ''
                ? String(ticket.ticketRevision).trim()
                : null;
        return {
            baseNumber: raw,
            revisionSuffix: revFromField,
            displayFull: revFromField ? `${raw}-${revFromField}` : raw,
        };
    }
    const baseNumber = raw.slice(0, idx);
    const revisionSuffix = raw.slice(idx + 1) || null;
    return { baseNumber, revisionSuffix, displayFull: raw };
}

function revisionSortKey(revisionSuffix) {
    if (revisionSuffix == null || revisionSuffix === '') return -1;
    const n = parseInt(revisionSuffix, 10);
    return Number.isNaN(n) ? revisionSuffix : n;
}

function compareRevisionKeysDesc(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return b - a;
    if (typeof a === 'number' && typeof b !== 'number') return -1;
    if (typeof a !== 'number' && typeof b === 'number') return 1;
    return String(b).localeCompare(String(a));
}

/** Max revision among stored -XXX suffix strings (same ordering as dedupeTicketsByBase). */
function pickHighestRevisionSuffix(suffixes) {
    const list = [...new Set((suffixes || []).map((s) => String(s).trim()).filter(Boolean))];
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
        const ka = revisionSortKey(a);
        const kb = revisionSortKey(b);
        return compareRevisionKeysDesc(ka, kb);
    })[0];
}

function collectWebhookRevisionSuffixesFromTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return [];
    /** @type {string[]} */
    const out = [];
    const add = (s) => {
        if (s == null || s === '') return;
        const t = String(s).trim();
        if (t) out.push(t);
    };
    if (Array.isArray(ticket.webhookRevisionSuffixes)) {
        ticket.webhookRevisionSuffixes.forEach(add);
    }
    const posr = ticket._posrWebhookNotification;
    if (posr && posr.Notification && posr.Notification.TicketNumber != null) {
        const p = parseTicketNumberParts({ ticketNumber: String(posr.Notification.TicketNumber) });
        if (p.revisionSuffix) add(p.revisionSuffix);
    }
    if (ticket._xmlData && typeof ticket._xmlData === 'object') {
        if (ticket._xmlData.ticketNumber != null) {
            const p = parseTicketNumberParts({ ticketNumber: String(ticket._xmlData.ticketNumber) });
            if (p.revisionSuffix) add(p.revisionSuffix);
        }
        if (ticket._xmlData.ticketRevisionNumber != null && ticket._xmlData.ticketRevisionNumber !== '') {
            add(ticket._xmlData.ticketRevisionNumber);
        }
    }
    return out;
}

/** Revision from source API / stored row (not suffix-list aggregated). */
function nvApiRevisionSuffix(ticket) {
    if (!ticket) return null;
    const p = parseTicketNumberParts(ticket);
    if (p.revisionSuffix != null && String(p.revisionSuffix).trim() !== '') {
        return String(p.revisionSuffix).trim();
    }
    const full = ticket.ticketNumberFull && String(ticket.ticketNumberFull).trim();
    if (full) {
        const pf = parseTicketNumberParts({ ticketNumber: full });
        if (pf.revisionSuffix != null && String(pf.revisionSuffix).trim() !== '') {
            return String(pf.revisionSuffix).trim();
        }
    }
    return null;
}

function getTicketsSameBaseForRevision(ticket) {
    const base = normalizeTicketBase(ticket && ticket.ticketNumber);
    if (!base) return [ticket];
    const list =
        typeof window !== 'undefined' && Array.isArray(window.ORG_TICKETS)
            ? window.ORG_TICKETS.filter((t) => normalizeTicketBase(t.ticketNumber) === base)
            : [];
    return list.length > 0 ? list : [ticket];
}

/**
 * Prefer highest -XXX from stored suffix list; else max NV API revision across sibling rows.
 * @param {object} ticket
 * @returns {string|null}
 */
function resolveRevisionLabelForTicket(ticket) {
    if (!ticket) return null;
    const siblings = getTicketsSameBaseForRevision(ticket);
    const fromWebhooks = [];
    siblings.forEach((t) => {
        fromWebhooks.push(...collectWebhookRevisionSuffixesFromTicket(t));
    });
    const hookPick = pickHighestRevisionSuffix(fromWebhooks);
    if (hookPick != null) return hookPick;

    let bestNv = null;
    let bestKey = null;
    siblings.forEach((t) => {
        const nv = nvApiRevisionSuffix(t);
        if (nv == null) return;
        const k = revisionSortKey(nv);
        if (bestKey === null || compareRevisionKeysDesc(bestKey, k) > 0) {
            bestNv = nv;
            bestKey = k;
        }
    });
    return bestNv;
}

/** One row per base ticket #; keep latest by updatedAt, then highest revision. */
function dedupeTicketsByBase(tickets) {
    const list = Array.isArray(tickets) ? tickets : [];
    const byBase = new Map();
    list.forEach(t => {
        const base = normalizeTicketBase(t && t.ticketNumber);
        if (!base) return;
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(t);
    });
    const out = [];
    byBase.forEach(group => {
        const sorted = group.slice().sort((a, b) => {
            const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
            const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
            if (tb !== ta) return tb - ta;
            const ra = revisionSortKey(parseTicketNumberParts(a).revisionSuffix);
            const rb = revisionSortKey(parseTicketNumberParts(b).revisionSuffix);
            if (rb !== ra) return rb > ra ? 1 : rb < ra ? -1 : 0;
            return String(a.ticketNumber || '').localeCompare(String(b.ticketNumber || ''));
        });
        out.push(sorted[0]);
    });
    return out;
}

// Fetch source details from backend API
async function fetchPosrDetails(ticketNumber) {
    const url = SOURCE_API.replace('{ticket}', ticketNumber);
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            // Try with base ticket if original fails
            const base = normalizeTicketBase(ticketNumber);
            if (base !== ticketNumber) {
                const baseUrl = SOURCE_API.replace('{ticket}', base);
                const baseResponse = await fetch(baseUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!baseResponse.ok) {
                    throw new Error(`Failed to fetch source details: ${baseResponse.status}`);
                }
                
                const baseData = await baseResponse.json();
                return parsePosrData(baseData);
            }
            throw new Error(`Failed to fetch source details: ${response.status}`);
        }
        
        const data = await response.json();
        return parsePosrData(data);
    } catch (error) {
        console.error('Error fetching source details:', error);
        throw error;
    }
}

/** First non-empty trimmed string (treats blank as missing). */
function firstNonEmptyString(...candidates) {
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c == null) continue;
        const t = typeof c === 'string' ? c.trim() : String(c).trim();
        if (t !== '') return t;
    }
    return null;
}

/**
 * Dig-site / street address for the locate (matches source "Dig Site" / Address-Location, not excavator mailing).
 * Prefer explicit dig-site keys before generic `address` / `location`.
 */
function pickDigSiteAddressFromPosrTicket(posrTicket, data) {
    const pt = posrTicket && typeof posrTicket === 'object' ? posrTicket : {};
    const root = data && typeof data === 'object' ? data : {};
    const loc = pt.location != null ? pt.location : pt.Location;
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
 * Extract dig-site address from source search-tool HTML (label "Address/Location" under Dig Site and Ticket Details).
 * Avoids matching the separate Excavator "Address" line when multiple data-role="address" blocks exist.
 */
function parseDigSiteAddressFromPosrSearchHtml(html) {
    if (!html || typeof html !== 'string') return null;
    const direct = html.match(/<label>Address\/Location:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
    if (direct && direct[1].trim()) return direct[1].trim();
    const spaced = html.match(/<label>Address\s*\/\s*Location:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
    if (spaced && spaced[1].trim()) return spaced[1].trim();
    const addressDivs = html.match(/<div[^>]*data-role="address"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (let i = 0; i < addressDivs.length; i++) {
        const div = addressDivs[i];
        const looksLikeTicketDetails =
            /<label>Ticket number:\s*<\/label>/i.test(div) &&
            (/<label>Work Type:\s*<\/label>/i.test(div) || /<label>Expiration Date:\s*<\/label>/i.test(div));
        if (!looksLikeTicketDetails) continue;
        const mLoc = div.match(/<label>Address\/Location:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
        if (mLoc && mLoc[1].trim()) return mLoc[1].trim();
        const mAddr = div.match(/<label>Address:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
        if (mAddr && mAddr[1].trim()) return mAddr[1].trim();
    }
    return null;
}

// Parse source API response
function parsePosrData(data) {
    // Extract workExpirationDate from top level of API response
    // The API returns: {"workExpirationDate": "...", "posrTicket": {...}, ...}
    const workExpirationDate = data?.workExpirationDate || 
                               data?.workExpiration_date ||
                               data?.work_expiration_date ||
                               null;
    
    const posrTicket = data?.posrTicket || {};
    
    // Extract stations
    const stations = posrTicket.stations || [];
    const stationCodes = stations
        .filter(s => s && s.code)
        .map(s => s.code);
    
    // Extract work type (nested + root GetJobsListForTable)
    const workType = posrTicket.workType ||
                     posrTicket.WorkType ||
                     posrTicket.work_type ||
                     data.workType ||
                     data.WorkType ||
                     data.work_type ||
                     null;
    
    // Extract work activity
    const workActivity = posrTicket.workActivity || 
                         posrTicket.WorkActivity || 
                         posrTicket.work_activity || 
                         null;
    
    // Extract created by (try multiple keys)
    const createdBy = posrTicket.createdBy || 
                      posrTicket.CreatedBy || 
                      posrTicket.created_by || 
                      posrTicket.requester || 
                      posrTicket.Requester || 
                      posrTicket.createdByUser || 
                      posrTicket.CreatedByUser || 
                      posrTicket.createdByUserName || 
                      posrTicket.CreatedByUserName || 
                      null;
    
    // Extract additional fields that might be available
    const ticketNumber = posrTicket.ticketNumber || 
                         posrTicket.ticket_number || 
                         posrTicket.requestNumber || 
                         posrTicket.request_number || 
                         null;
    
    const requestDate = posrTicket.requestDate || 
                        posrTicket.request_date || 
                        posrTicket.createdDate || 
                        posrTicket.created_date ||
                        posrTicket.jobStartDate ||
                        posrTicket.JobStartDate ||
                        data.jobStartDate ||
                        data.JobStartDate ||
                        null;
    
    // Use workExpirationDate from top level first, then try posrTicket fields
    const dueDate = workExpirationDate ||
                    posrTicket.dueDate || 
                    posrTicket.due_date || 
                    posrTicket.endDate || 
                    posrTicket.end_date ||
                    posrTicket.expirationDate ||
                    posrTicket.expiration_date ||
                    posrTicket.workExpirationDate ||
                    posrTicket.work_expiration_date ||
                    posrTicket.expires ||
                    posrTicket.expiresAt ||
                    posrTicket.expires_at ||
                    null;
    
    // Extract job list (history/activity) - try multiple possible locations
    let jobs = posrTicket.jobs || 
               posrTicket.Jobs || 
               posrTicket.jobList || 
               posrTicket.JobList || 
               [];
    
    // Also check if jobs are in the root data object
    if (!Array.isArray(jobs) || jobs.length === 0) {
        jobs = data.jobs || data.Jobs || data.jobList || data.JobList || [];
    }

    const rawTicketHistory = posrTicket.ticketHistory || posrTicket.TicketHistory;
    let historyFromTicketHistory = [];
    if (Array.isArray(rawTicketHistory) && rawTicketHistory.length > 0) {
        const sortedTh = [...rawTicketHistory].sort((a, b) => {
            const ta = new Date(a?.responseDate || a?.ResponseDate || 0).getTime();
            const tb = new Date(b?.responseDate || b?.ResponseDate || 0).getTime();
            return tb - ta;
        });
        historyFromTicketHistory = sortedTh.map((job) => ({
            id: job.id || job.ID || job.jobId || job.JobId || null,
            operatorName:
                job.operatorName ||
                job.OperatorName ||
                job.operator_name ||
                job.operator ||
                job.Operator ||
                job.name ||
                job.Name ||
                null,
            operatorCode:
                job.operatorCode ||
                job.OperatorCode ||
                job.operator_code ||
                job.code ||
                job.Code ||
                null,
            statusCode:
                job.statusCode ||
                job.StatusCode ||
                job.status_code ||
                job.status ||
                job.Status ||
                job.responseCode ||
                job.ResponseCode ||
                null,
            respondedAt:
                job.respondedAt ||
                job.RespondedAt ||
                job.responded_at ||
                job.responseDate ||
                job.ResponseDate ||
                job.date ||
                job.Date ||
                null,
            comment:
                firstNonEmptyString(
                    job.comment,
                    job.Comment,
                    job.notes,
                    job.Notes,
                    job.note,
                    job.Note,
                    job.responseDescription,
                    job.ResponseDescription
                ) || null,
            workType: job.workType || job.WorkType || null,
            workActivity: job.workActivity || job.WorkActivity || null,
        }));
    }
    
    // Parse job history (GetJobsListForTable uses ticketHistory; legacy shape uses jobs)
    const historyFromJobs = Array.isArray(jobs)
        ? jobs.map(job => ({
        id: job.id || job.ID || job.jobId || job.JobId || null,
        operatorName: job.operatorName || job.OperatorName || job.operator_name || job.operator || job.Operator || null,
        operatorCode: job.operatorCode || job.OperatorCode || job.operator_code || job.code || job.Code || null,
        statusCode: job.statusCode || job.StatusCode || job.status_code || job.status || job.Status || null,
        respondedAt: job.respondedAt || job.RespondedAt || job.responded_at || job.responseDate || job.ResponseDate || job.date || job.Date || null,
        comment: job.comment || job.Comment || job.notes || job.Notes || job.note || job.Note || null,
        workType: job.workType || job.WorkType || null,
        workActivity: job.workActivity || job.WorkActivity || null
    }))
        : [];
    const history = historyFromTicketHistory.length > 0 ? historyFromTicketHistory : historyFromJobs;
    
    // Extract additional fields that might be in the response
    const address = pickDigSiteAddressFromPosrTicket(posrTicket, data);

    /** Provider portal: "Ticket Scope" is stored as additionalRemarks on posrTicket. */
    const ticketScope = firstNonEmptyString(
        posrTicket.additionalRemarks,
        posrTicket.AdditionalRemarks,
        posrTicket.additional_remarks,
        data?.additionalRemarks,
        data?.AdditionalRemarks
    );

    const excavationMethod = posrTicket.excavationMethod || 
                             posrTicket.ExcavationMethod || 
                             posrTicket.method || 
                             posrTicket.Method || 
                             null;
    
    const nearbyCrossStreet = firstNonEmptyString(
        posrTicket.nearbyCrossStreet,
        posrTicket.NearestCrossStreet
    );
    const portalTicketType = firstNonEmptyString(posrTicket.ticketType, posrTicket.TicketType);
    const zipcode = (() => {
        const z = posrTicket.zipcode != null ? posrTicket.zipcode : posrTicket.zipCode;
        if (z == null) return null;
        const s = String(z).trim();
        return s === '' ? null : s;
    })();
    const city = firstNonEmptyString(posrTicket.city, posrTicket.CityTownPlace);
    const county =
        posrTicket.county != null && String(posrTicket.county).trim() !== ''
            ? String(posrTicket.county).trim()
            : null;
    const state =
        posrTicket.state != null && String(posrTicket.state).trim() !== ''
            ? String(posrTicket.state).trim()
            : null;
    const customerPhone = firstNonEmptyString(posrTicket.phone);
    const customerMobile = firstNonEmptyString(posrTicket.mobile);
    const customerEmail = firstNonEmptyString(posrTicket.email);
    const locationSummary = firstNonEmptyString(posrTicket.locationSummary);
    const streetSidewalkOrParkstrip = (() => {
        const v = posrTicket.streetSidewalkOrParkstrip;
        if (v === true || v === false) return v;
        const r =
            data && (data.streetSideWalkOrParkstrip != null ? data.streetSideWalkOrParkstrip : data.StreetSideWalkOrParkstrip);
        if (r != null && String(r).trim() !== '') return String(r).trim();
        return null;
    })();

    // Extract all station details, not just codes
    const stationDetails = stations.map(s => ({
        code: s.code || s.Code || s.stationCode || s.StationCode || null,
        name: s.name || s.Name || s.operatorName || s.OperatorName || s.stationCodeName || s.StationCodeName || null,
        status: s.status || s.Status || null,
        responseDate: s.responseDate || s.ResponseDate || s.respondedAt || s.RespondedAt || s.responseReceived || s.ResponseReceived || null,
        responseCode: s.responseCode || s.ResponseCode || s.code || s.Code || null,
        comment:
            firstNonEmptyString(
                s.comment,
                s.Comment,
                s.comments,
                s.Comments,
                s.notes,
                s.Notes,
                s.responseDescription,
                s.ResponseDescription
            ) || null
    }));
    
    return {
        ticketNumber,
        stationCodes,
        stationDetails, // Full station information
        workType,
        workActivity,
        createdBy,
        requestDate,
        dueDate: dueDate || workExpirationDate, // Use workExpirationDate if dueDate is null
        workExpirationDate: workExpirationDate, // Store separately for reference
        address,
        ticketScope,
        excavationMethod,
        nearbyCrossStreet,
        portalTicketType,
        zipcode,
        city,
        county,
        state,
        customerPhone,
        customerMobile,
        customerEmail,
        locationSummary,
        streetSidewalkOrParkstrip,
        history,
    };
}

// Fetch source search tool page for expiration date and history
// NOTE: This function is no longer used - expiration date comes from JSON API (workExpirationDate)
// Keeping for potential future use if needed for history parsing
async function fetchPosrSearchPage(ticketNumber) {
    // Disabled - expiration date now comes from JSON API
    return null;
}

// Fetch polygon coordinates and additional ticket data from map page via backend
async function fetchPolygonCoords(ticketNumber) {
    const base = normalizeTicketBase(ticketNumber);
    const url = MAP_URL.replace('{base}', base);
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch map page: ${response.status}`);
        }
        
        const result = await response.json();
        const html = result.html;
        
        // Parse polygon from inline JavaScript
        // Look for: var spatialObjectDescription = 'POLYGON((...))';
        const pattern = /var spatialObjectDescription = 'POLYGON\((.*?)\)';/;
        const match = html.match(pattern);
        
        let coords = null;
        if (match) {
            const polyStr = match[1];
            coords = [];
            
            // Parse coordinates
            const coordStrings = polyStr
                .replace(/[()]/g, '')
                .split(',')
                .map(s => s.trim())
                .filter(s => s);
            
            for (const coordStr of coordStrings) {
                const parts = coordStr.split(/\s+/);
                if (parts.length >= 2) {
                    try {
                        const x = parseFloat(parts[0]);
                        const y = parseFloat(parts[1]);
                        if (!isNaN(x) && !isNaN(y)) {
                            coords.push([x, y]);
                        }
                    } catch (e) {
                        // Skip invalid coordinate
                    }
                }
            }
            
            if (coords.length === 0) {
                coords = null;
            }
        }
        
        // Note: Expiration date is now obtained from JSON API (workExpirationDate), not from HTML parsing
        // Removed HTML parsing code to avoid unnecessary warnings
        
        // Parse history from HTML table
        // The history is in a table with data-role="table-container-history"
        const historyData = parseHistoryFromHTML(html);
        
        return {
            coords: coords,
            expirationDate: null, // Expiration date comes from JSON API, not HTML
            history: historyData
        };
    } catch (error) {
        console.error('Error fetching polygon coordinates:', error);
        throw error;
    }
}

// Parse history data from HTML table
function parseHistoryFromHTML(html) {
    const history = [];
    
    // Find the history table container - it might be hidden (display: none)
    // Look for the table-container-history div and extract its content
    const historyTableMatch = html.match(/<div[^>]*data-role="table-container-history"[^>]*>([\s\S]*?)(?:<\/div>\s*<div[^>]*data-role="standard-view"|$)/);
    if (!historyTableMatch) {
        return history;
    }
    
    const historyTableHTML = historyTableMatch[1];
    
    // Parse table rows - look for <tr data-complex-table-identifier="...">
    const rowPattern = /<tr[^>]*data-complex-table-identifier="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    
    while ((rowMatch = rowPattern.exec(historyTableHTML)) !== null) {
        const rowHTML = rowMatch[1];
        
        // Skip footer rows
        if (rowHTML.includes('footer-row') || rowHTML.includes("That's all the results") || rowHTML.includes('all-results')) {
            continue;
        }
        
        // Extract cells - look for data-content attributes first (most reliable)
        const cells = [];
        const cellPattern = /<td[^>]*>[\s\S]*?data-content="([^"]*)"[\s\S]*?<\/td>/g;
        let cellMatch;
        
        while ((cellMatch = cellPattern.exec(rowHTML)) !== null) {
            const content = cellMatch[1];
            // Skip empty cells or cells with just whitespace
            if (content && content.trim()) {
                cells.push(content.trim());
            }
        }
        
        // If we didn't get enough cells from data-content, try extracting from <span> tags
        if (cells.length < 6) {
            const spanPattern = /<td[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/td>/g;
            let spanMatch;
            const spanCells = [];
            while ((spanMatch = spanPattern.exec(rowHTML)) !== null) {
                const content = spanMatch[1].trim();
                if (content) {
                    spanCells.push(content);
                }
            }
            // Use span cells if we got more from them
            if (spanCells.length > cells.length) {
                cells.length = 0;
                cells.push(...spanCells);
            }
        }
        
        // Expected order: Ticket number, Station Code, Station Code Name, Response Received, Response Code, Response Description, Comments
        if (cells.length >= 6) {
            history.push({
                ticketNumber: cells[0] || null,
                stationCode: cells[1] || null,
                stationCodeName: cells[2] || null,
                responseReceived: cells[3] || null,
                responseCode: cells[4] || null,
                comment: (cells[6] && cells[6].trim()) || null
            });
        }
    }
    
    return history;
}

// Parse expiration date from source search tool page HTML
function parseExpirationDateFromPosrPage(html) {
    if (!html) return null;
    
    // Look for: <div data-role="address"><label>Start Date: </label><span>6/10/2025 05:00</span> <label>Expiration Date: </label><span>7/4/2025 11:59</span></div>
    // The expiration date is in the same div as Start Date
    const addressDivPattern = /<div[^>]*data-role="address"[^>]*>[\s\S]*?<label>Expiration Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i;
    let expirationMatch = html.match(addressDivPattern);
    
    // If not found, try the simpler pattern anywhere in the HTML
    if (!expirationMatch) {
        const expirationPattern = /<label>Expiration Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i;
        expirationMatch = html.match(expirationPattern);
    }
    
    if (expirationMatch) {
        const dateStr = expirationMatch[1].trim();
        return parseDateString(dateStr);
    }
    
    return null;
}

// Parse date string to ISO format (POSR/USAN datetimes are Pacific, not browser-local)
function parseDateString(dateStr) {
    if (!dateStr) return null;
    
    try {
        const dateTimeMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        if (dateTimeMatch) {
            let month = parseInt(dateTimeMatch[1], 10);
            let day = parseInt(dateTimeMatch[2], 10);
            let year = parseInt(dateTimeMatch[3], 10);
            let hour = parseInt(dateTimeMatch[4], 10);
            let minute = parseInt(dateTimeMatch[5], 10);
            const ampm = dateTimeMatch[6];
            
            if (ampm) {
                if (ampm.toUpperCase() === 'PM' && hour !== 12) {
                    hour += 12;
                } else if (ampm.toUpperCase() === 'AM' && hour === 12) {
                    hour = 0;
                }
            }

            const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            if (typeof window.pacificYmdHmToUtcMs === 'function') {
                return new Date(window.pacificYmdHmToUtcMs(ymd, hour, minute, 0)).toISOString();
            }
        }

        if (typeof window.parseInstantForDisplay === 'function') {
            const d = window.parseInstantForDisplay(dateStr);
            if (d && !isNaN(d.getTime())) return d.toISOString();
        }

        let date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            return date.toISOString();
        }
        return dateStr;
    } catch (e) {
        return dateStr;
    }
}

// Process a single ticket (delegates to backend import API)
async function processTicket(ticketNumber, onProgress) {
    const result = await processTickets([ticketNumber], onProgress, 0);
    return result.tickets && result.tickets.length > 0 ? result.tickets[0] : null;
}

// Process multiple tickets via backend POST /api/tickets/import
async function processTickets(ticketNumbers, onProgress, throttleMs = 500) {
    const numbers = ticketNumbers.map((n) => String(n).trim()).filter(Boolean);
    if (numbers.length === 0) {
        return { tickets: [], errors: [] };
    }
    onProgress && onProgress(`Importing ${numbers.length} ticket(s) via server...`);
    const apiBase = (window.authModule && window.authModule.API_BASE) || window.API_BASE;
    if (!apiBase) {
        throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
    }
    const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : (window.authModule && window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
    try {
        const body = { ticketNumbers: numbers };
        if (currentOrgId != null) body.organizationId = currentOrgId;
        const data = window.authModule
            ? await window.authModule.apiRequest(`${apiBase}/tickets/import`, {
                method: 'POST',
                body: JSON.stringify(body),
            })
            : (await (await fetch(`${apiBase}/tickets/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                credentials: 'include',
            })).json());
        const tickets = data.tickets || [];
        const errors = data.errors || [];
        tickets.forEach((_, i) => {
            onProgress && onProgress(`✅ Ticket ${i + 1}/${numbers.length} imported`);
        });
        errors.forEach((e) => {
            onProgress && onProgress(`⚠️ ${e.ticketNumber}: ${e.error}`);
        });
        return { tickets, errors };
    } catch (error) {
        const errMsg = error.message || String(error);
        onProgress && onProgress(`❌ Import failed: ${errMsg}`);
        return {
            tickets: [],
            errors: numbers.map((ticketNumber) => ({ ticketNumber, error: errMsg })),
        };
    }
}

// Add tickets to the map. Options: { alreadySaved: true } when tickets came from POST /api/tickets/import (skip re-saving).
function addTicketsToMap(tickets, options) {
    if (!window.ORG_TICKETS) {
        window.ORG_TICKETS = [];
    }
    const alreadySaved = options && options.alreadySaved === true;
    const existingTicketNumbers = new Set(window.ORG_TICKETS.map(t => t.ticketNumber));
    const ticketsToSave = [];
    tickets.forEach(ticket => {
        if (!existingTicketNumbers.has(ticket.ticketNumber)) {
            window.ORG_TICKETS.push(ticket);
            existingTicketNumbers.add(ticket.ticketNumber);
            if (!alreadySaved) ticketsToSave.push(ticket);
        }
    });
    if (!alreadySaved && ticketsToSave.length > 0 && window.authModule && window.authModule.isAuthenticated()) {
        const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : (window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
        if (currentOrgId) {
            ticketsToSave.forEach(async (ticket) => {
                try {
                    await window.authModule.apiRequest(`${window.authModule.API_BASE}/tickets`, {
                        method: 'POST',
                        body: JSON.stringify({
                            ticketNumber: ticket.ticketNumber,
                            ticketData: ticketDataForPersistence(ticket),
                            organizationId: currentOrgId
                        })
                    });
                } catch (error) {
                    console.error('Error saving ticket to database:', error);
                }
            });
        }
    }
    if (window.ticketsModule && window.ticketsModule.renderTickets) {
        window.ticketsModule.renderTickets();
    }
    if (window.ticketsModule && window.ticketsModule.renderTicketList) {
        window.ticketsModule.renderTicketList();
    }
}

// TEST FUNCTION: Parse source search page and return JSON
async function testParsePosrPage(ticketNumber) {
    try {
        const url = SOURCE_SEARCH_URL.replace('{ticket}', ticketNumber);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            return {
                error: `Failed to fetch: ${response.status}`,
                status: response.status
            };
        }
        
        const result = await response.json();
        const html = result.html;
        
        if (!html) {
            return {
                error: 'No HTML returned',
                result: result
            };
        }
        
        // Parse expiration date
        const expirationDate = parseExpirationDateFromPosrPage(html);
        
        // Parse history
        const history = parseHistoryFromHTML(html);
        
        // Try to find the address div with all the ticket info
        const addressDivs = html.match(/<div[^>]*data-role="address"[^>]*>([\s\S]*?)<\/div>/gi) || [];
        const addressData = {};
        const digFromHtml = parseDigSiteAddressFromPosrSearchHtml(html);
        if (digFromHtml) {
            addressData.address = digFromHtml;
        }

        addressDivs.forEach(div => {
            // Extract ticket number
            const ticketMatch = div.match(/<label>Ticket number:\s*<\/label>([^<]*?)(?:<a|<\/div)/i);
            if (ticketMatch) {
                addressData.ticketNumber = ticketMatch[1].trim();
            }
            
            // Extract address — only from the main ticket / dig-site block (not the Excavator-only block)
            if (!addressData.address) {
                const looksLikeTicketDetails =
                    /<label>Ticket number:\s*<\/label>/i.test(div) &&
                    (/<label>Work Type:\s*<\/label>/i.test(div) || /<label>Expiration Date:\s*<\/label>/i.test(div));
                if (!looksLikeTicketDetails) return;
                const locMatch = div.match(/<label>Address\/Location:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
                const addressMatch = locMatch || div.match(/<label>Address:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
                if (addressMatch) {
                    addressData.address = addressMatch[1].trim();
                }
            }
            
            // Extract start date
            const startDateMatch = div.match(/<label>Start Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
            if (startDateMatch) {
                addressData.startDate = startDateMatch[1].trim();
            }
            
            // Extract expiration date (raw)
            const expDateMatch = div.match(/<label>Expiration Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
            if (expDateMatch) {
                addressData.expirationDateRaw = expDateMatch[1].trim();
            }
            
            // Extract work type
            const workTypeMatch = div.match(/<label>Work Type:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
            if (workTypeMatch) {
                addressData.workType = workTypeMatch[1].trim();
            }
            
            // Extract work activity
            const workActivityMatch = div.match(/<label>Work Actvity:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
            if (workActivityMatch) {
                addressData.workActivity = workActivityMatch[1].trim();
            }
        });
        
        // Extract additional information
        const additionalInfoMatch = html.match(/<div[^>]*data-role="end"[^>]*>[\s\S]*?<label>Additional Information:\s*<\/label>\s*<span>([^<]+)<\/span>/i);
        if (additionalInfoMatch) {
            addressData.additionalInformation = additionalInfoMatch[1].trim();
        }
        
        const parsedData = {
            ticketNumber: ticketNumber,
            htmlLength: html.length,
            expirationDate: {
                raw: addressData.expirationDateRaw || null,
                parsed: expirationDate,
                parseDateStringResult: addressData.expirationDateRaw ? parseDateString(addressData.expirationDateRaw) : null
            },
            addressData: addressData,
            history: {
                count: history.length,
                entries: history.slice(0, 3) // First 3 entries as sample
            },
            regexMatches: {
                addressDivPattern: /<div[^>]*data-role="address"[^>]*>[\s\S]*?<label>Expiration Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i.test(html),
                simplePattern: /<label>Expiration Date:\s*<\/label>\s*<span>([^<]+)<\/span>/i.test(html)
            }
        };
        
        return parsedData;
        
    } catch (error) {
        console.error('Error in testParsePosrPage:', error);
        return {
            error: error.message,
            stack: error.stack
        };
    }
}

// Export for use in other modules
window.ticketImporterModule = {
    processTicket,
    processTickets,
    addTicketsToMap,
    normalizeTicketBase,
    parseTicketNumberParts,
    resolveRevisionLabelForTicket,
    dedupeTicketsByBase,
    fetchPosrDetails,
    parsePosrData,
    fetchPolygonCoords,
    getOperatorStatus,
    getEffectiveOperatorStatus,
    getTicketExpirationDateForStatus,
    getCalendarDaysUntilExpiration,
    getCalendarDaysUntilInstant,
    formatTicketExpiresInDisplay,
    resolveTicketLifecycleStatus,
    isTicketCancelled,
    calculateTicketStatus,
    calculateTicketStatusForPartner,
    calculateTicketStatusForSearchStub,
    inferNgenSearchStubFromTicket,
    getOutstandingOperators,
    countPhotosInTicketPolygon,
    listPhotosInTicketPolygon,
    countPhotoStatsForTicketRequirement,
    listAssociatedNoGpsPhotosForTicket,
    mergeTicketPhotosByFileId,
    getTrustedServerPhotoStats,
    getPhotoCreatedAtMs,
    photoCreatedAtMeetsRevisionCutoff,
    isPosrPublicImportTicket,
    isPosrPortalDetailsOnlyTicket,
    isPosrLaneTicket,
    buildPosrPortalDetailsBlurbHtml,
    getPhotoRequirementScopeLabel,
    testParsePosrPage // Export test function
};

// Make test function globally available
window.testParsePosrPage = testParsePosrPage;


