const { SYNC_LANE_POSR_PUBLIC } = require('./ticketSyncLane.cjs');
const { allRows } = require('./db.cjs');

/** D1 enforces a low cap on bound parameters per statement (~100). */
const D1_SAFE_IN_CHUNK = 99;

const USAN_TZ = 'America/Los_Angeles';

/**
 * USAN-sourced "photo count starts after" for canonical ticket objects (2-photo field workflow).
 * nGen: enquiryDetails.lodgedOn (merged as ngenLodgedOn).
 * POSR (posr_public): relaxed — earliest rev-000 lodge proxy; photos after that count for all revisions.
 * Lean list / open without full history: load a one-row 000 slice from D1 via
 * {@link ensurePosrRev000HistorySlice} / {@link loadEarliestPosr000IsoMap}.
 * Other: POSR map history, first row matching current full request number with response 000.
 */
function normalizeRequestIdForPhotoCutoff(s) {
    if (s == null) return '';
    return String(s).trim();
}

/**
 * @param {string|number|null|undefined} code
 * @returns {boolean}
 */
function isStatusCode000(code) {
    if (code == null) return false;
    return String(code).trim() === '000';
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseIsoOrNull(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const t = new Date(String(raw).trim());
    if (isNaN(t.getTime())) return null;
    return t.toISOString();
}

/**
 * Calendar date YYYY-MM-DD in USAN Pacific for revision photo cutoff comparisons.
 * @param {unknown} dateInput
 * @returns {string|null}
 */
function ymdInUsanTz(dateInput) {
    if (dateInput == null || String(dateInput).trim() === '') return null;
    const d = new Date(String(dateInput).trim());
    if (isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: USAN_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/**
 * True when upload createdAt is on or after the lodged-on calendar day (USAN TZ).
 * @param {unknown} createdAt
 * @param {unknown} cutoffIso
 * @returns {boolean}
 */
function photoCreatedAtMeetsRevisionCutoff(createdAt, cutoffIso) {
    if (cutoffIso == null || String(cutoffIso).trim() === '') return true;
    const photoYmd = ymdInUsanTz(createdAt);
    const cutoffYmd = ymdInUsanTz(cutoffIso);
    if (!photoYmd || !cutoffYmd) return false;
    return photoYmd >= cutoffYmd;
}

/**
 * @param {object} h
 * @returns {string}
 */
function historyRequestNumberFull(h) {
    if (!h || typeof h !== 'object') return '';
    if (h.requestNumberFull != null && String(h.requestNumberFull).trim() !== '') {
        return String(h.requestNumberFull).trim();
    }
    if (h.fullRequestNumber != null && String(h.fullRequestNumber).trim() !== '') {
        return String(h.fullRequestNumber).trim();
    }
    if (h.ticketNumber != null && String(h.ticketNumber).trim() !== '') {
        return String(h.ticketNumber).trim();
    }
    return '';
}

/**
 * @param {object} h
 * @returns {string|null}
 */
function history000RespondedIso(h) {
    if (!h || typeof h !== 'object') return null;
    const statusCode = h.statusCode != null ? h.statusCode : h.responseCode;
    if (!isStatusCode000(statusCode)) return null;
    return parseIsoOrNull(h.respondedAt || h.responseReceived || h.responseDate);
}

/**
 * @param {object[]} history
 * @param {string|null|undefined} requestFull
 * @returns {string|null}
 */
function findEarliest000IsoInHistory(history, requestFull) {
    if (!Array.isArray(history) || history.length === 0) return null;
    const target = requestFull != null ? normalizeRequestIdForPhotoCutoff(requestFull) : '';
    let best = null;
    let bestMs = Infinity;
    for (const h of history) {
        if (target) {
            const req = historyRequestNumberFull(h);
            if (req && normalizeRequestIdForPhotoCutoff(req) !== target) continue;
        }
        const iso = history000RespondedIso(h);
        if (!iso) continue;
        const ms = new Date(iso).getTime();
        if (ms < bestMs) {
            bestMs = ms;
            best = iso;
        }
    }
    return best;
}

/**
 * @param {object[]} history - Newest first when from map (USAN table order)
 * @param {string} currentFullRequest - e.g. 2026…-001
 * @returns {string|null} ISO
 */
function findPosrHistory000CutoffIso(history, currentFullRequest) {
    if (!Array.isArray(history) || !currentFullRequest) return null;
    const target = normalizeRequestIdForPhotoCutoff(currentFullRequest);
    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        if (!h || typeof h !== 'object') continue;
        const req = historyRequestNumberFull(h);
        if (normalizeRequestIdForPhotoCutoff(req) !== target) continue;
        const iso = history000RespondedIso(h);
        if (iso) return iso;
    }
    return null;
}

/**
 * @param {object} ticket
 * @returns {string}
 */
function resolveFullRequestNumber(ticket) {
    if (!ticket) return '';
    if (ticket.ticketNumberFull != null && String(ticket.ticketNumberFull).trim() !== '') {
        return String(ticket.ticketNumberFull).trim();
    }
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    const firstDash = tn.indexOf('-');
    if (firstDash > 0 && !tn.slice(firstDash + 1).includes('-')) {
        return tn;
    }
    const base = firstDash > 0 ? tn.slice(0, firstDash) : tn;
    const rev = ticket.ticketRevision != null ? String(ticket.ticketRevision).trim() : '';
    if (base && rev) return `${base}-${rev}`;
    return tn;
}

/**
 * @param {object} ticket
 * @returns {string}
 */
function resolveTicketBaseNumber(ticket) {
    if (!ticket) return '';
    const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    const firstDash = tn.indexOf('-');
    if (firstDash > 0) return tn.slice(0, firstDash);
    const full = resolveFullRequestNumber(ticket);
    const dash = full.indexOf('-');
    return dash > 0 ? full.slice(0, dash) : full;
}

/**
 * @param {object} ticket
 * @returns {boolean}
 */
function isPosrPublicTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return false;
    // Gate on syncLane only — nGen stubs/merges also use source: 'nv_api'.
    const lane = ticket.syncLane != null ? String(ticket.syncLane).trim() : '';
    return lane === SYNC_LANE_POSR_PUBLIC;
}

/**
 * Relaxed POSR cutoff: when rev 000 was lodged (any photo after counts for later revisions).
 * @param {object} ticket
 * @returns {string|null}
 */
function findPosrRev000LodgeIso(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    const base = resolveTicketBaseNumber(ticket);
    const history = ticket.history || [];
    if (base) {
        const fromRev000 = findEarliest000IsoInHistory(history, `${base}-000`);
        if (fromRev000) return fromRev000;
    }
    const earliest000 = findEarliest000IsoInHistory(history, null);
    if (earliest000) return earliest000;
    for (const key of ['startTime', 'legalStartDate', 'commencementDate']) {
        const iso = parseIsoOrNull(ticket[key]);
        if (iso) return iso;
    }
    return null;
}

/**
 * @param {string|null|undefined} iso
 * @returns {object[]}
 */
function historySliceFromEarliest000Iso(iso) {
    if (!iso) return [];
    return [{ statusCode: '000', respondedAt: iso }];
}

/**
 * Batch: ticket_id → earliest status_code 000 responded_at (ISO).
 * @param {object} db
 * @param {Array<number|string>} ticketIds
 * @returns {Promise<Map<number, string>>}
 */
async function loadEarliestPosr000IsoMap(db, ticketIds) {
    const map = new Map();
    const ids = [
        ...new Set(
            (ticketIds || [])
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];
    if (!db || ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += D1_SAFE_IN_CHUNK) {
        const chunk = ids.slice(i, i + D1_SAFE_IN_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        let rows;
        try {
            rows = await allRows(
                db,
                `SELECT ticket_id, responded_at, response_received
                 FROM ticket_posr_notification_history
                 WHERE ticket_id IN (${placeholders})
                   AND status_code = '000'`,
                chunk
            );
        } catch (e) {
            if (/no such table/i.test((e && e.message) || String(e || ''))) return map;
            throw e;
        }
        for (const r of rows || []) {
            const tid = r.ticket_id != null ? Number(r.ticket_id) : NaN;
            const iso = parseIsoOrNull(r.responded_at) || parseIsoOrNull(r.response_received);
            if (!Number.isFinite(tid) || !iso) continue;
            const prev = map.get(tid);
            if (!prev || new Date(iso).getTime() < new Date(prev).getTime()) {
                map.set(tid, iso);
            }
        }
    }
    return map;
}

/**
 * One-row history slice for POSR photo cutoff when full history is not loaded.
 * @param {object} db
 * @param {number|string} ticketId
 * @returns {Promise<object[]>}
 */
async function loadEarliestPosr000HistorySlice(db, ticketId) {
    const map = await loadEarliestPosr000IsoMap(db, [ticketId]);
    const id = Number(ticketId);
    return historySliceFromEarliest000Iso(Number.isFinite(id) ? map.get(id) || null : null);
}

/**
 * Attach a minimal earliest-000 history slice onto a POSR ticket when history lacks any 000.
 * @param {object} db
 * @param {object} ticket
 * @returns {Promise<object>}
 */
async function ensurePosrRev000HistorySlice(db, ticket) {
    if (!ticket || !isPosrPublicTicket(ticket)) return ticket;
    if (findEarliest000IsoInHistory(ticket.history || [], null)) return ticket;
    const id = ticket.id != null ? Number(ticket.id) : NaN;
    if (!Number.isFinite(id)) return ticket;
    const slice = await loadEarliestPosr000HistorySlice(db, id);
    if (!slice.length) return ticket;
    ticket.history =
        Array.isArray(ticket.history) && ticket.history.length ? [...slice, ...ticket.history] : slice;
    return ticket;
}

/**
 * Sync attach from a preloaded iso map (lean list batch).
 * @param {object} ticket
 * @param {Map<number, string>|null|undefined} isoMap
 * @returns {object}
 */
function attachPosrRev000HistoryFromIsoMap(ticket, isoMap) {
    if (!ticket || !isPosrPublicTicket(ticket) || !isoMap) return ticket;
    if (findEarliest000IsoInHistory(ticket.history || [], null)) return ticket;
    const id = ticket.id != null ? Number(ticket.id) : NaN;
    if (!Number.isFinite(id)) return ticket;
    const slice = historySliceFromEarliest000Iso(isoMap.get(id) || null);
    if (!slice.length) return ticket;
    ticket.history =
        Array.isArray(ticket.history) && ticket.history.length ? [...slice, ...ticket.history] : slice;
    return ticket;
}

/**
 * Ensure POSR earliest-000 slice from D1 when needed, then apply cutoff fields.
 * @param {object} db
 * @param {object} ticket
 * @returns {Promise<object>}
 */
async function applyPhotoRequirementFieldsWithDb(db, ticket) {
    await ensurePosrRev000HistorySlice(db, ticket);
    applyPhotoRequirementFields(ticket);
    return ticket;
}

/**
 * Mutates ticket (canonical ticket object) with photo requirement fields.
 * @param {object} ticket
 */
function applyPhotoRequirementFields(ticket) {
    if (!ticket || typeof ticket !== 'object') return;
    const full = resolveFullRequestNumber(ticket);
    const revFromFull = full && full.indexOf('-') !== -1 ? full.slice(full.indexOf('-') + 1) : null;
    const rev =
        ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== ''
            ? String(ticket.ticketRevision).trim()
            : revFromFull;
    const hasRevision = full.indexOf('-') !== -1 && rev != null && String(rev).trim() !== '';
    ticket.photoRequirementRevision = rev != null && String(rev).trim() !== '' ? String(rev).trim() : null;

    const ngenStr = ticket.ngenLodgedOn;
    if (ngenStr != null && String(ngenStr).trim() !== '') {
        const d = new Date(String(ngenStr).trim());
        if (!isNaN(d.getTime())) {
            ticket.photoRequirementCutoffIso = d.toISOString();
            ticket.photoRequirementCutoffSource = 'ngen_lodged_on';
            ticket.photoRequirementCutoffPending = false;
            return;
        }
    }

    if (isPosrPublicTicket(ticket)) {
        const posrCutoff = findPosrRev000LodgeIso(ticket);
        if (posrCutoff) {
            ticket.photoRequirementCutoffIso = posrCutoff;
            ticket.photoRequirementCutoffSource = 'posr_rev_000_lodge';
            ticket.photoRequirementCutoffPending = false;
            return;
        }
        ticket.photoRequirementCutoffIso = null;
        ticket.photoRequirementCutoffSource = 'posr_unknown';
        ticket.photoRequirementCutoffPending = false;
        return;
    }

    const fromHistory = findPosrHistory000CutoffIso(ticket.history || [], full);
    if (fromHistory) {
        ticket.photoRequirementCutoffIso = fromHistory;
        ticket.photoRequirementCutoffSource = 'posr_history_000';
        ticket.photoRequirementCutoffPending = false;
        return;
    }

    ticket.photoRequirementCutoffIso = null;
    if (hasRevision) {
        ticket.photoRequirementCutoffSource = 'unknown';
        ticket.photoRequirementCutoffPending = true;
    } else {
        ticket.photoRequirementCutoffSource = 'unknown';
        ticket.photoRequirementCutoffPending = false;
    }
}

module.exports = {
    applyPhotoRequirementFields,
    applyPhotoRequirementFieldsWithDb,
    attachPosrRev000HistoryFromIsoMap,
    ensurePosrRev000HistorySlice,
    findEarliest000IsoInHistory,
    findPosrHistory000CutoffIso,
    findPosrRev000LodgeIso,
    historySliceFromEarliest000Iso,
    isPosrPublicTicket,
    loadEarliestPosr000HistorySlice,
    loadEarliestPosr000IsoMap,
    normalizeRequestIdForPhotoCutoff,
    photoCreatedAtMeetsRevisionCutoff,
    resolveFullRequestNumber,
    resolveTicketBaseNumber,
    isStatusCode000,
    ymdInUsanTz,
    USAN_TZ,
};
