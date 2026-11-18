/**
 * tickets/ticket-status.js — split from ticketImporter.js (Phase F3).
 * Operator status, expiration, photo gates, calculateTicketStatus*.
 */
// Response code status definitions (defaults; org overrides via workflowAckComplianceModule)
const NOT_READY_CODES =
    window.operatorResponseCodesModule && window.operatorResponseCodesModule.DEFAULT_NOT_READY_CODES
        ? window.operatorResponseCodesModule.DEFAULT_NOT_READY_CODES
        : ['000', '888', '999', '014', '050', '020', '021', '024', '052', '054', '041', '042', '080', '555'];
const ACTION_REQUIRED_CODES =
    window.operatorResponseCodesModule && window.operatorResponseCodesModule.DEFAULT_ACTION_REQUIRED_CODES
        ? window.operatorResponseCodesModule.DEFAULT_ACTION_REQUIRED_CODES
        : ['002', '011', '012', '031', '034', '041', '042'];
// Note: 041 and 042 appear in both lists, but NOT_READY takes precedence

// Determine operator status from response code
function getOperatorStatus(responseCode) {
    const mod = window.workflowAckComplianceModule;
    if (mod && typeof mod.getOperatorStatusFromCode === 'function') {
        return mod.getOperatorStatusFromCode(responseCode);
    }
    if (!responseCode) return 'READY';
    const code = String(responseCode).trim();
    if (NOT_READY_CODES.includes(code)) return 'NOT_READY';
    if (ACTION_REQUIRED_CODES.includes(code)) return 'ACTION_REQUIRED';
    return 'READY';
}

/** Prefer statusCode; if missing, use operatorStatus from API/normalized ticket (avoids false READY). */
function getBaseOperatorStatus(response) {
    if (!response) return 'READY';
    const code = response.statusCode;
    if (code != null && String(code).trim() !== '') {
        return getOperatorStatus(code);
    }
    const os = response.operatorStatus;
    if (os === 'NOT_READY' || os === 'ACTION_REQUIRED' || os === 'READY') {
        return os;
    }
    return 'READY';
}

// Get effective operator status (ack-based workflow; no operator overrides)
function getEffectiveOperatorStatus(response, _ticketNumber, _ticketOrOrgId) {
    return getBaseOperatorStatus(response);
}

/**
 * Parse a ticket expiration value into an absolute instant (Date), for time-based
 * expiry that matches the D1 `julianday(ticket_expires_at) <= julianday('now')` predicate.
 * A ticket stays valid until this instant passes.
 * - Datetime with numeric ±offset (nGen) or Z: that exact instant
 * - Naive datetime "YYYY-MM-DDTHH:MM:SS" / "YYYY-MM-DD HH:MM:SS": runtime-local instant
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
            const iso =
                typeof window.pacificEndOfDayInstantFromYmd === 'function'
                    ? window.pacificEndOfDayInstantFromYmd(s)
                    : null;
            return iso ? new Date(iso) : null;
        }

        const d =
            typeof window.parseInstantForDisplay === 'function'
                ? window.parseInstantForDisplay(s)
                : new Date(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
        return d == null || isNaN(d.getTime()) ? null : d;
    } catch (e) {
        return null;
    }
}

// Expired once the actual expiration instant has passed (matches D1 SQL predicate).
function isTicketExpired(expirationDate) {
    if (!expirationDate) return false;
    const inst = parseTicketExpirationInstant(expirationDate);
    if (!inst) return false;
    return inst.getTime() <= Date.now();
}

/**
 * Single expiration value for status rules. Prefer indexed `ticketExpirationDate`
 * (D1 `ticket_expires_at`) so hub expired lists and workflow status agree; fall back to
 * POSR `workExpirationDate` / `endTime` / `dueDate` when the index is absent.
 */
function getTicketExpirationDateForStatus(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    return (
        ticket.ticketExpirationDate ||
        ticket.workExpirationDate ||
        ticket.work_expiration_date ||
        ticket.endTime ||
        ticket.dueDate ||
        null
    );
}

/**
 * Lifecycle-only status (before operator/ack rules).
 * Precedence: EXPIRED > CANCELLED > EXPIRING_SOON — Cancelled only if not yet expired.
 * Tickets loaded via expiredOnly (`listScope: 'expired'`) are always EXPIRED.
 * @param {object} ticket
 * @returns {'EXPIRED'|'CANCELLED'|'EXPIRING_SOON'|null}
 */
function resolveTicketLifecycleStatus(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    if (ticket.listScope === 'expired' || ticket.hubListScope === 'expired') {
        return 'EXPIRED';
    }
    const expirationDate = getTicketExpirationDateForStatus(ticket);
    if (isTicketExpired(expirationDate)) return 'EXPIRED';
    if (isTicketCancelled(ticket)) return 'CANCELLED';
    if (isExpiringSoon(expirationDate, null, ticket)) return 'EXPIRING_SOON';
    return null;
}

/** Pacific calendar-day difference from today to the expiration instant's calendar day. */
function getCalendarDaysUntilExpiration(expirationDate) {
    if (!expirationDate) return null;
    const inst = parseTicketExpirationInstant(expirationDate);
    if (!inst) return null;
    if (typeof window.pacificCalendarDayDiff === 'function') {
        return window.pacificCalendarDayDiff(Date.now(), inst.getTime());
    }
    return null;
}

function getCalendarDaysUntilInstant(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return null;
    if (typeof window.pacificCalendarDayDiff === 'function') {
        return window.pacificCalendarDayDiff(Date.now(), Number(ms));
    }
    return null;
}

function getExpiringSoonDays(ticket) {
    if (ticket && Number.isFinite(Number(ticket.expiringSoonDays))) {
        return Number(ticket.expiringSoonDays);
    }
    const mod = window.workflowAckComplianceModule;
    if (mod && typeof mod.getCurrentOrgWorkflowAckPolicy === 'function') {
        const n = Number(mod.getCurrentOrgWorkflowAckPolicy().expiringSoonDays);
        if (Number.isFinite(n)) return n;
    }
    return 5;
}

/** True if not yet expired and the expiration instant's local calendar day is within `withinDays` days of today. */
function isExpiringSoon(expirationDate, withinDays, ticket) {
    if (withinDays == null || withinDays === undefined) withinDays = getExpiringSoonDays(ticket);
    if (!expirationDate || isTicketExpired(expirationDate)) return false;
    const diffDays = getCalendarDaysUntilExpiration(expirationDate);
    if (diffDays == null) return false;
    return diffDays >= 0 && diffDays <= withinDays;
}

function formatCountUnit(n, one, many) {
    return n === 1 ? one : many;
}

/**
 * Scan-friendly expiration relative to now. Same-calendar-day uses hours/minutes;
 * other days use calendar-day counts. Tooltip should use the absolute date.
 */
function formatTicketExpiresInDisplay(ticket) {
    const empty = { text: '', title: '', tone: '' };
    const raw = getTicketExpirationDateForStatus(ticket);
    if (!raw) return empty;
    const inst = parseTicketExpirationInstant(raw);
    if (!inst) return empty;
    const abs =
        typeof window.formatRecordedDate === 'function'
            ? window.formatRecordedDate(inst, '')
            : inst.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const expired = isTicketExpired(raw);
    const diffDays = getCalendarDaysUntilExpiration(raw);
    if (diffDays == null) return { text: '', title: abs, tone: '' };

    if (!expired && diffDays >= 2) {
        return {
            text: 'Expires in ' + diffDays + ' days',
            title: abs,
            tone: diffDays <= getExpiringSoonDays(ticket) ? 'soon' : '',
        };
    }
    if (!expired && diffDays === 1) {
        return { text: 'Expires in 1 day', title: abs, tone: 'soon' };
    }
    if (!expired && diffDays === 0) {
        const msLeft = inst.getTime() - Date.now();
        const hours = Math.floor(msLeft / (60 * 60 * 1000));
        if (hours >= 1) {
            return {
                text: 'Expires in ' + hours + ' ' + formatCountUnit(hours, 'hour', 'hours'),
                title: abs,
                tone: 'soon',
            };
        }
        const mins = Math.max(1, Math.round(msLeft / 60000));
        return { text: 'Expires in ' + mins + ' min', title: abs, tone: 'urgent' };
    }
    if (expired && diffDays === 0) {
        const msAgo = Date.now() - inst.getTime();
        const hours = Math.floor(msAgo / (60 * 60 * 1000));
        if (hours >= 1) {
            return {
                text: 'Expired ' + hours + ' ' + formatCountUnit(hours, 'hour', 'hours') + ' ago',
                title: abs,
                tone: 'expired',
            };
        }
        const mins = Math.max(1, Math.round(msAgo / 60000));
        return { text: 'Expired ' + mins + ' min ago', title: abs, tone: 'expired' };
    }
    const ago = Math.abs(diffDays);
    return {
        text: 'Expired ' + ago + ' ' + formatCountUnit(ago, 'day', 'days') + ' ago',
        title: abs,
        tone: 'expired',
    };
}

// Determine overall ticket status from operator responses (expiration / enquiry status)
// List photos within a ticket polygon (same rules as count)
function listPhotosInTicketPolygon(ticketPolygon) {
    if (!ticketPolygon || !ticketPolygon.coordinates || !ticketPolygon.coordinates[0]) {
        return [];
    }
    const photos = window.photosModule?.savedPhotos || [];
    if (photos.length === 0) {
        return [];
    }
    let leafletPolygon = null;
    try {
        const coords = ticketPolygon.coordinates[0].map(c => [c[1], c[0]]);
        leafletPolygon = L.polygon(coords);
    } catch (error) {
        console.error('Error creating Leaflet polygon for photo check:', error);
        return [];
    }
    const isPointInPolygon = window.tableQueriesModule?.isPointInPolygon || function (point, polygon) {
        const latlngs = polygon.getLatLngs()[0];
        let inside = false;
        for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
            const xi = latlngs[i].lng;
            const yi = latlngs[i].lat;
            const xj = latlngs[j].lng;
            const yj = latlngs[j].lat;
            const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
                (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    };
    const inPolygon = [];
    photos.forEach(photo => {
        let photoLat = null;
        let photoLng = null;
        if (photo.exifData && photo.exifData.gpsLat && photo.exifData.gpsLng) {
            photoLat = photo.exifData.gpsLat;
            photoLng = photo.exifData.gpsLng;
        } else if (photo.latlng && photo.latlng.lat && photo.latlng.lng) {
            photoLat = photo.latlng.lat;
            photoLng = photo.latlng.lng;
        } else if (photo.lat !== undefined && photo.lng !== undefined) {
            photoLat = photo.lat;
            photoLng = photo.lng;
        }
        if (photoLat === null || photoLng === null) return;
        const point = L.latLng(photoLat, photoLng);
        const tqm = window.tableQueriesModule;
        const inArea =
            tqm && typeof tqm.isPointInOrNearTicketPolygon === 'function'
                ? tqm.isPointInOrNearTicketPolygon(point, leafletPolygon)
                : leafletPolygon.getBounds().contains(point) && isPointInPolygon(point, leafletPolygon);
        if (inArea) inPolygon.push(photo);
    });
    return inPolygon;
}

function countPhotosInTicketPolygon(ticketPolygon) {
    return listPhotosInTicketPolygon(ticketPolygon).length;
}

function listAssociatedNoGpsPhotosForTicket(ticket) {
    const mod = window.photoTicketAssociationModule;
    if (mod && typeof mod.listAssociatedNoGpsPhotosForTicket === 'function') {
        return mod.listAssociatedNoGpsPhotosForTicket(ticket);
    }
    return [];
}

function mergeTicketPhotosByFileId(geoPhotos, associatedPhotos) {
    const out = [];
    const seen = new Set();
    (geoPhotos || []).forEach((p) => {
        const key = p.fileId != null ? String(p.fileId) : p.id != null ? String(p.id) : '';
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        out.push(p);
    });
    (associatedPhotos || []).forEach((p) => {
        const key = p.fileId != null ? String(p.fileId) : p.id != null ? String(p.id) : '';
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        out.push(p);
    });
    return out;
}

function countAssociatedNoGpsForRequirement(ticket, inAssociated) {
    if (!ticket || !inAssociated || !inAssociated.length) return { after: 0, total: 0 };
    if (ticket.photoRequirementCutoffPending) {
        return { after: 0, total: inAssociated.length };
    }
    const cut = ticket.photoRequirementCutoffIso;
    if (cut == null || String(cut).trim() === '') {
        return { after: inAssociated.length, total: inAssociated.length };
    }
    let after = 0;
    inAssociated.forEach((photo) => {
        if (photoCreatedAtMeetsRevisionCutoff(photo.createdAt, cut)) after += 1;
    });
    return { after, total: inAssociated.length };
}

function getTrustedServerPhotoStats(ticket) {
    const snap = ticket && ticket.ticketPhotoStats;
    if (!snap || typeof snap !== 'object') return null;
    // Incomplete snapshots are mid-compute; stale only means a background refresh is due (e.g. new
    // org media), not that stored counts are invalid — list and detail must share the same rule.
    if (snap.incomplete) return null;
    const stats = snap.stats;
    if (!stats || typeof stats !== 'object') return null;
    return {
        totalInPolygon: Number(stats.totalInPolygon) || 0,
        afterCutoff: Number(stats.afterCutoff) || 0,
        olderInPolygon: Number(stats.olderInPolygon) || 0,
        forRequirement: Number(stats.forRequirement) || 0,
        source: 'server',
    };
}

function hasTrustedPhotoStatsForRequirement(ticket) {
    return getTrustedServerPhotoStats(ticket) != null;
}

/** List-sync / never-refreshed: infer stub when full detail refresh watermark is absent and no operator rows. */
function inferNgenSearchStubFromTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    if (ticket.ngenSearchStub === true) return true;
    const refreshed = ticket.ngenFullDetailRefreshedAt;
    if (refreshed != null && String(refreshed).trim() !== '') return false;
    const ops = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
    return ops === 0;
}

/** Owner photo gate: block READY without compliance evidence per org policy. */
function ownerPhotoRequirementBlocksReady(ticketNumber, fullTicket) {
    const mod = window.workflowAckComplianceModule;
    if (mod && typeof mod.isAckComplianceSatisfied === 'function') {
        const policy = mod.getCurrentOrgWorkflowAckPolicy();
        if (policy.requiredPhotoCount === 0) return false;
        if (fullTicket && fullTicket.workflowAckCompliance) {
            return !mod.isAckComplianceSatisfied(fullTicket, policy);
        }
        if (!hasTrustedPhotoStatsForRequirement(fullTicket)) return true;
        const photoCount = countPhotoStatsForTicketRequirement(fullTicket).forRequirement;
        return !mod.isAckComplianceSatisfied(fullTicket, policy, photoCount);
    }
    return false;
}

function serverSnapMediaIds(_ticket) {
    return new Set();
}

/** Add local explicit no-GPS associations not yet reflected in a trusted server snapshot. */
function mergeLocalAssociatedIntoPhotoStats(ticket, baseStats) {
    const base = baseStats || {
        totalInPolygon: 0,
        afterCutoff: 0,
        olderInPolygon: 0,
        forRequirement: 0,
    };
    if (!localPhotosAvailableForRequirementFallback()) return base;
    const serverIds = serverSnapMediaIds(ticket);
    const associated = listAssociatedNoGpsPhotosForTicket(ticket).filter((p) => {
        const fid = Number(p.fileId);
        return Number.isFinite(fid) && !serverIds.has(fid);
    });
    if (!associated.length) return base;
    const assocCounts = countAssociatedNoGpsForRequirement(ticket, associated);
    return {
        totalInPolygon: base.totalInPolygon + assocCounts.total,
        afterCutoff: base.afterCutoff + assocCounts.after,
        olderInPolygon: base.olderInPolygon + Math.max(0, assocCounts.total - assocCounts.after),
        forRequirement: base.forRequirement + assocCounts.after,
        source: base.source === 'server' ? 'server+local-associated' : base.source,
    };
}

function localPhotosAvailableForRequirementFallback() {
    return !!(window.photosModule && Array.isArray(window.photosModule.savedPhotos) && window.photosModule.savedPhotos.length > 0);
}

function getPhotoCreatedAtMs(photo) {
    if (!photo) return null;
    if (photo.createdAt) {
        const d =
            typeof window.parseInstantForDisplay === 'function'
                ? window.parseInstantForDisplay(photo.createdAt)
                : new Date(photo.createdAt);
        if (d && !isNaN(d.getTime())) return d.getTime();
    }
    return null;
}

const PHOTO_REQUIREMENT_USAN_TZ = 'America/Los_Angeles';

function ymdInUsanTz(dateInput) {
    if (dateInput == null || String(dateInput).trim() === '') return null;
    const d =
        typeof window.parseInstantForDisplay === 'function'
            ? window.parseInstantForDisplay(dateInput)
            : new Date(String(dateInput).trim());
    if (!d || isNaN(d.getTime())) return null;
    if (typeof window.getPacificYmd === 'function') {
        return window.getPacificYmd(d);
    }
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: PHOTO_REQUIREMENT_USAN_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/** Upload createdAt on or after lodged-on calendar day (USAN Pacific). */
function photoCreatedAtMeetsRevisionCutoff(createdAt, cutoffIso) {
    if (cutoffIso == null || String(cutoffIso).trim() === '') return true;
    const photoYmd = ymdInUsanTz(createdAt);
    const cutoffYmd = ymdInUsanTz(cutoffIso);
    if (!photoYmd || !cutoffYmd) return false;
    return photoYmd >= cutoffYmd;
}

function photoMeetsTicketRevisionCutoff(ticket, photo) {
    if (!ticket || ticket.photoRequirementCutoffPending) return false;
    return photoCreatedAtMeetsRevisionCutoff(photo && photo.createdAt, ticket.photoRequirementCutoffIso);
}

function countPhotoStatsForPhotoList(ticket, photos) {
    const total = Array.isArray(photos) ? photos.length : 0;
    if (!ticket || !total) {
        return { totalInPolygon: 0, afterCutoff: 0, olderInPolygon: 0, forRequirement: 0 };
    }
    if (ticket.photoRequirementCutoffPending) {
        return {
            totalInPolygon: total,
            afterCutoff: 0,
            olderInPolygon: total,
            forRequirement: 0,
        };
    }
    const cut = ticket.photoRequirementCutoffIso;
    if (cut == null || String(cut).trim() === '') {
        return {
            totalInPolygon: total,
            afterCutoff: total,
            olderInPolygon: 0,
            forRequirement: total,
        };
    }
    let after = 0;
    let old = 0;
    photos.forEach((photo) => {
        if (photoMeetsTicketRevisionCutoff(ticket, photo)) after += 1;
        else old += 1;
    });
    return { totalInPolygon: total, afterCutoff: after, olderInPolygon: old, forRequirement: after };
}

/**
 * In-polygon photo counts for 2-photo rule: total, after USAN revision cutoff, and older.
 * v1: uses photo.createdAt (upload) only vs photoRequirementCutoffIso (calendar day, USAN Pacific).
 * @param {object} ticket
 * @returns {{ totalInPolygon: number, afterCutoff: number, olderInPolygon: number, forRequirement: number }}
 */
function countPhotoStatsForTicketRequirement(ticket) {
    if (!ticket || !ticket.polygon) {
        return { totalInPolygon: 0, afterCutoff: 0, olderInPolygon: 0, forRequirement: 0 };
    }
    const ticketsMod = window.ticketsModule;
    const linkedPhotos =
        ticketsMod && typeof ticketsMod.resolveTicketLinkedPhotosUnfiltered === 'function'
            ? ticketsMod.resolveTicketLinkedPhotosUnfiltered(ticket)
            : [];
    if (linkedPhotos.length) {
        const fromLinked = countPhotoStatsForPhotoList(ticket, linkedPhotos);
        const serverStats = getTrustedServerPhotoStats(ticket);
        const snap = ticket.ticketPhotoStats;
        const snapStale = !!(snap && snap.stale);
        if (
            !serverStats ||
            snapStale ||
            fromLinked.forRequirement > serverStats.forRequirement ||
            fromLinked.totalInPolygon > serverStats.totalInPolygon
        ) {
            return { ...fromLinked, source: serverStats ? 'linked+fresh' : 'linked' };
        }
        return mergeLocalAssociatedIntoPhotoStats(ticket, serverStats);
    }
    const serverStats = getTrustedServerPhotoStats(ticket);
    if (serverStats) {
        return mergeLocalAssociatedIntoPhotoStats(ticket, serverStats);
    }
    if (!localPhotosAvailableForRequirementFallback()) {
        return { totalInPolygon: 0, afterCutoff: 0, olderInPolygon: 0, forRequirement: 0, source: 'pessimistic' };
    }
    const inPoly = listPhotosInTicketPolygon(ticket.polygon);
    const associated = listAssociatedNoGpsPhotosForTicket(ticket);
    const totalGeo = inPoly.length;
    const total = totalGeo + associated.length;
    if (ticket.photoRequirementCutoffPending) {
        return {
            totalInPolygon: total,
            afterCutoff: 0,
            olderInPolygon: total,
            forRequirement: 0,
        };
    }
    const cut = ticket.photoRequirementCutoffIso;
    if (cut == null || String(cut).trim() === '') {
        return {
            totalInPolygon: total,
            afterCutoff: total,
            olderInPolygon: 0,
            forRequirement: total,
        };
    }
    let after = 0;
    let old = 0;
    inPoly.forEach((photo) => {
        if (photoMeetsTicketRevisionCutoff(ticket, photo)) after += 1;
        else old += 1;
    });
    const assocCounts = countAssociatedNoGpsForRequirement(ticket, associated);
    after += assocCounts.after;
    old += Math.max(0, assocCounts.total - assocCounts.after);
    return { totalInPolygon: total, afterCutoff: after, olderInPolygon: old, forRequirement: after };
}

/** True when nGen required/received counts say utilities still owe responses (e.g. 2/9 received). */
function nGenResponseCountsOutstanding(fullTicket) {
    if (!fullTicket || typeof fullTicket !== 'object') return false;
    const req = fullTicket.ngenRequiredResponseCount;
    if (req == null || String(req).trim() === '' || !Number.isFinite(Number(req))) return false;
    const r = Number(req);
    const rec = fullTicket.ngenReceivedResponseCount;
    const c =
        rec != null && String(rec).trim() !== '' && Number.isFinite(Number(rec)) ? Number(rec) : 0;
    return c < r;
}

/**
 * True when nGen lists both counts and received ≥ required (all utility responses in per aggregate).
 * Used to avoid false NOT_READY when stationCodes length disagrees with POSR row count.
 */
function nGenAggregateUtilitiesComplete(fullTicket) {
    if (!fullTicket || typeof fullTicket !== 'object') return false;
    const req = fullTicket.ngenRequiredResponseCount;
    const rec = fullTicket.ngenReceivedResponseCount;
    if (req == null || String(req).trim() === '' || !Number.isFinite(Number(req))) return false;
    if (rec == null || String(rec).trim() === '' || !Number.isFinite(Number(rec))) return false;
    return Number(rec) >= Number(req);
}

/** True when nGen external enquiry status is Cancelled (hub: External status). */
function isTicketCancelled(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    const raw =
        ticket.ngenEnquiryStatus ??
        ticket.providerEnquiryStatus ??
        ticket.currentNgenEnquiryStatus ??
        ticket.current_ngen_enquiry_status ??
        ticket.ngen_enquiry_status ??
        ticket.provider_enquiry_status;
    return raw != null && String(raw).trim().toLowerCase() === 'cancelled';
}

/** Partner shared tickets: ignore Review Required operator codes and 2-photo rule. */
function normalizeOperatorStatusesForPartner(statuses) {
    return statuses.map((s) => (s === 'ACTION_REQUIRED' ? 'READY' : s));
}

/** Map-only manual import: polygon in Core; details/utilities on USAN POSR portal. */
function isPosrPortalDetailsOnlyTicket(ticket) {
    return !!(ticket && ticket.posrPortalDetailsOnly === true);
}

function buildPosrPortalDetailsBlurbHtml(options) {
    const forHub = options && options.forHub;
    const body =
        typeof window.t === 'function'
            ? window.t(
                  'Ticket details and utility responses are not loaded in Locus for this import. Open USAN POSR to view them.'
              )
            : 'Ticket details and utility responses are not loaded in Locus for this import. Open USAN POSR to view them.';
    const btnLabel = typeof window.t === 'function' ? window.t('Open USAN POSR') : 'Open USAN POSR';
    const btnClass = forHub
        ? 'ticket-posr-portal-btn'
        : 'ticket-posr-portal-btn ticket-hub-action-btn ticket-hub-action-secondary';
    const hubAction = forHub
        ? ' data-hub-action="check-posr"'
        : ' onclick="event.stopPropagation(); if (typeof openPosrSearchAndCopy811Ticket === \'function\') openPosrSearchAndCopy811Ticket();"';
    return `<div class="ticket-posr-portal-blurb" role="note">
        <p class="ticket-posr-portal-blurb-text">${body}</p>
        <button type="button" class="${btnClass}"${hubAction} title="${btnLabel}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${btnLabel}
        </button>
    </div>`;
}

/**
 * POSR-lane UX: portal blurb, hide details/utilities/History.
 * True for `syncLane: posr_public` or `posrPortalDetailsOnly`.
 * Not nGen-primary or a cross-org copy from an nGen ticket.
 */
function isPosrLaneTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    if (ticket.crossOrgCacheFromNgenPrimary === true) return false;
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
    if (lane === 'ngen_primary') return false;
    if (ticket.posrPortalDetailsOnly === true) return true;
    if (lane === 'posr_public') return true;
    if (!lane) {
        const src = ticket.source != null ? String(ticket.source).trim() : '';
        return src === 'nv_api';
    }
    return false;
}

/** NV public POSR/map import (`nv_api`, `nv_api_cache`, or `syncLane: posr_public`). Matches server `isPosrTicket`. */
function isPosrPublicImportTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    const src = ticket.source != null ? String(ticket.source).trim() : '';
    if (src === 'nv_api' || src === 'nv_api_cache') return true;
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
    return lane === 'posr_public';
}

/** UI copy scope for 2-photo requirement (POSR uses in-area wording). */
function getPhotoRequirementScopeLabel(ticket) {
    return isPosrPublicImportTicket(ticket) ? 'in area' : 'this revision';
}

/** POSR owner tickets never use ticket-level NOT_READY (see computeWorkflowStatus). */
function ticketLevelNotReadyOrPosrReviewRequired(fullTicket, audience) {
    if (fullTicket && isPosrPublicImportTicket(fullTicket) && audience !== 'partner') {
        return 'ACTION_REQUIRED';
    }
    return 'NOT_READY';
}

// Precedence: EXPIRED > CANCELLED > EXPIRING_SOON > nGen aggregate outstanding NOT_READY > station shortfall NOT_READY >
// complete coverage + NOT_READY rows → ACTION_REQUIRED (org reviews codes) > …
// fullTicket: optional. When set, 2-photo rule uses USAN photoRequirementCutoff fields on the ticket.
// audience: 'owner' (default) or 'partner' (ticket.shared — relaxed operator/photo rules).
function calculateTicketStatusWithAudience(
    operatorResponses,
    ticketNumber,
    expirationDate,
    ticketPolygon,
    stationCodes,
    fullTicket,
    audience
) {
    if (isTicketExpired(expirationDate)) {
        return 'EXPIRED';
    }
    if (fullTicket && isTicketCancelled(fullTicket)) {
        return 'CANCELLED';
    }

    if (isExpiringSoon(expirationDate, null, fullTicket)) {
        return 'EXPIRING_SOON';
    }

    const responseRows = Array.isArray(operatorResponses) ? operatorResponses : [];
    const actualResponseCount = responseRows.length;
    const effectiveOperatorStatuses = responseRows.map((response) =>
        audience === 'partner'
            ? getBaseOperatorStatus(response)
            : getEffectiveOperatorStatus(response, ticketNumber, fullTicket)
    );
    const workflowOperatorStatuses =
        audience === 'partner'
            ? normalizeOperatorStatusesForPartner(effectiveOperatorStatuses)
            : effectiveOperatorStatuses;
    const allLoadedRowsEffectivelyReady =
        responseRows.length > 0 && workflowOperatorStatuses.every((s) => s === 'READY');

    // nGen often lags or counts "received" differently than POSR rows. If every loaded response is
    // READY, do not block the workflow on received < required alone.
    if (nGenResponseCountsOutstanding(fullTicket) && !allLoadedRowsEffectivelyReady) {
        return ticketLevelNotReadyOrPosrReviewRequired(fullTicket, audience);
    }

    const expectedOperatorCount = stationCodes && stationCodes.length > 0 ? stationCodes.length : 0;
    const ngenUtilitiesComplete = nGenAggregateUtilitiesComplete(fullTicket);

    // Fewer POSR rows than stationCodes — usually still waiting on utilities. When nGen already says
    // received ≥ required, trust the aggregate (station list can be longer than POSR rows).
    if (expectedOperatorCount > 0 && actualResponseCount < expectedOperatorCount && !ngenUtilitiesComplete) {
        return ticketLevelNotReadyOrPosrReviewRequired(fullTicket, audience);
    }

    const rowCoverageComplete =
        expectedOperatorCount === 0
            ? actualResponseCount > 0
            : actualResponseCount >= expectedOperatorCount;

    const canEvaluatePhotosAndOperatorFollowUp = rowCoverageComplete || ngenUtilitiesComplete;

    if (canEvaluatePhotosAndOperatorFollowUp && workflowOperatorStatuses.includes('NOT_READY')) {
        return 'ACTION_REQUIRED';
    }

    if (canEvaluatePhotosAndOperatorFollowUp) {
        if (workflowOperatorStatuses.includes('ACTION_REQUIRED')) {
            return 'ACTION_REQUIRED';
        }
    }

    if (!canEvaluatePhotosAndOperatorFollowUp) {
        return ticketLevelNotReadyOrPosrReviewRequired(fullTicket, audience);
    }

    if (audience !== 'partner') {
        if (ownerPhotoRequirementBlocksReady(ticketNumber, fullTicket)) {
            return 'ACTION_REQUIRED';
        }
    }

    // At this point every loaded operator response is READY and photo requirements are met.
    return 'READY';
}

function calculateTicketStatus(operatorResponses, ticketNumber, expirationDate, ticketPolygon, stationCodes, fullTicket) {
    if (fullTicket && fullTicket.shared) {
        return calculateTicketStatusForPartner(
            operatorResponses,
            ticketNumber,
            expirationDate,
            ticketPolygon,
            stationCodes,
            fullTicket
        );
    }
    return calculateTicketStatusWithAudience(
        operatorResponses,
        ticketNumber,
        expirationDate,
        ticketPolygon,
        stationCodes,
        fullTicket,
        'owner'
    );
}

function calculateTicketStatusForPartner(
    operatorResponses,
    ticketNumber,
    expirationDate,
    ticketPolygon,
    stationCodes,
    fullTicket
) {
    return calculateTicketStatusWithAudience(
        operatorResponses,
        ticketNumber,
        expirationDate,
        ticketPolygon,
        stationCodes,
        fullTicket,
        'partner'
    );
}

/**
 * Pre-hydration status from nGen search list counts only (ngenSearchStub rows).
 * Precedence: EXPIRED → CANCELLED → EXPIRING_SOON → NOT_READY when incomplete counts →
 * ACTION_REQUIRED when counts complete but photo requirement unmet → READY only with trusted photo stats (≥2).
 * @param {object} fullTicket
 * @param {string|null|undefined} expirationDate
 * @returns {string}
 */
function calculateTicketStatusForSearchStub(fullTicket, expirationDate, audience) {
    const aud = audience === 'partner' ? 'partner' : 'owner';
    if (isTicketExpired(expirationDate)) {
        return 'EXPIRED';
    }
    if (fullTicket && isTicketCancelled(fullTicket)) {
        return 'CANCELLED';
    }
    if (isExpiringSoon(expirationDate, null, fullTicket)) {
        return 'EXPIRING_SOON';
    }
    const req = fullTicket && fullTicket.ngenRequiredResponseCount;
    const rec = fullTicket && fullTicket.ngenReceivedResponseCount;
    if (req == null || rec == null || !Number.isFinite(Number(req)) || !Number.isFinite(Number(rec))) {
        return ticketLevelNotReadyOrPosrReviewRequired(fullTicket, aud);
    }
    const r = Number(req);
    const c = Number(rec);
    if (c < r) {
        return ticketLevelNotReadyOrPosrReviewRequired(fullTicket, aud);
    }
    if (aud === 'partner') {
        return 'READY';
    }
    if (ownerPhotoRequirementBlocksReady(fullTicket && fullTicket.ticketNumber, fullTicket)) {
        return 'ACTION_REQUIRED';
    }
    return 'READY';
}

// Get outstanding operators (those with NOT_READY or ACTION_REQUIRED status)
function getOutstandingOperators(operatorResponses, ticketNumber, ticket) {
    if (!operatorResponses || operatorResponses.length === 0) {
        return [];
    }

    const partnerView = ticket && ticket.shared;

    return operatorResponses
        .filter(response => {
            const status = partnerView
                ? getBaseOperatorStatus(response)
                : getEffectiveOperatorStatus(response, ticketNumber, ticket);
            if (partnerView) {
                return status === 'NOT_READY';
            }
            return status === 'NOT_READY' || status === 'ACTION_REQUIRED';
        })
        .map(response => response.operatorName || response.stationCode || 'Unknown Operator')
        .filter(name => name && name !== 'Unknown Operator');
}

// Function expression so a later concat chunk cannot hoist a duplicate name onto `window`.
window.isPosrPortalDetailsOnlyTicket = function (ticket) {
    return !!(ticket && ticket.posrPortalDetailsOnly === true);
};
window.isPosrLaneTicket = function (ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    if (ticket.crossOrgCacheFromNgenPrimary === true) return false;
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : '';
    if (lane === 'ngen_primary') return false;
    if (ticket.posrPortalDetailsOnly === true) return true;
    if (lane === 'posr_public') return true;
    if (!lane) {
        const src = ticket.source != null ? String(ticket.source).trim() : '';
        return src === 'nv_api';
    }
    return false;
};
window.buildPosrPortalDetailsBlurbHtml = buildPosrPortalDetailsBlurbHtml;
