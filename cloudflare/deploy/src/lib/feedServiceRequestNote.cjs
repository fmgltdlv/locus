/**
 * Encode / parse feed service_request.note JSON (no D1 migration).
 * Supports plan `feed` object and legacy v1 notes from Request Services UI.
 */

/** @typedef {'max_auto'|'manual'} FeedSrSource */
/** @typedef {'site_documentation'|'private_locating'} FeedServiceRequested */

/**
 * @typedef {object} FeedServiceRequestMeta
 * @property {FeedSrSource} source
 * @property {FeedServiceRequested} [serviceRequested]
 * @property {number|null} ticketOrganizationId
 * @property {string} ticketNumber
 * @property {string} [ticketRevision]
 * @property {string|null} [acknowledgeReason]
 * @property {string} [userNote]
 * @property {{ lat: number, lng: number }} [pin]
 */

const FEED_SERVICE_TYPES = new Set(['site_documentation', 'private_locating']);

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function tryParseObject(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return /** @type {Record<string, unknown>} */ (parsed);
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toPositiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toTrimmedString(value) {
    return value != null ? String(value).trim() : '';
}

/**
 * @param {unknown} value
 * @returns {{ lat: number, lng: number }|null}
 */
function normalizePin(value) {
    if (!value || typeof value !== 'object') return null;
    const lat = Number(/** @type {Record<string, unknown>} */ (value).lat);
    const lng = Number(/** @type {Record<string, unknown>} */ (value).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

/**
 * @param {Record<string, unknown>} feed
 * @returns {FeedServiceRequestMeta|null}
 */
function normalizeFeedMeta(feed) {
    if (!feed || typeof feed !== 'object') return null;
    const ticketNumber = toTrimmedString(feed.ticketNumber ?? feed.ticket_number);
    const ticketOrganizationId = toPositiveInt(
        feed.ticketOrganizationId ?? feed.ticket_organization_id
    );
    const sourceRaw = toTrimmedString(feed.source).toLowerCase();
    const source = sourceRaw === 'max_auto' ? 'max_auto' : 'manual';
    const serviceRequestedRaw = toTrimmedString(
        feed.serviceRequested ?? feed.service_requested
    ).toLowerCase();
    /** @type {FeedServiceRequested|undefined} */
    let serviceRequested;
    if (FEED_SERVICE_TYPES.has(serviceRequestedRaw)) {
        serviceRequested = /** @type {FeedServiceRequested} */ (serviceRequestedRaw);
    }
    const ticketRevision = toTrimmedString(feed.ticketRevision ?? feed.ticket_revision);
    const acknowledgeReason =
        feed.acknowledgeReason != null || feed.acknowledge_reason != null
            ? toTrimmedString(feed.acknowledgeReason ?? feed.acknowledge_reason) || null
            : null;
    const userNote = toTrimmedString(feed.userNote ?? feed.user_note);

    if (!ticketNumber && ticketOrganizationId == null && !serviceRequested) {
        return null;
    }

    return {
        source,
        serviceRequested,
        ticketOrganizationId,
        ticketNumber,
        ticketRevision: ticketRevision || undefined,
        acknowledgeReason,
        userNote: userNote || undefined,
    };
}

/**
 * Parse service_requests.note into feed metadata.
 * @param {unknown} note
 * @returns {FeedServiceRequestMeta|null}
 */
function parseFeedServiceRequestNote(note) {
    const obj = tryParseObject(note);
    if (!obj) return null;

    if (obj.feed && typeof obj.feed === 'object') {
        const fromFeed = normalizeFeedMeta(/** @type {Record<string, unknown>} */ (obj.feed));
        if (fromFeed) {
            if (!fromFeed.userNote && obj.userNote != null) {
                fromFeed.userNote = toTrimmedString(obj.userNote) || undefined;
            }
            return fromFeed;
        }
    }

    // Legacy v1 Request Services note
    if (Number(obj.v) === 1) {
        const ticket = obj.ticket && typeof obj.ticket === 'object'
            ? /** @type {Record<string, unknown>} */ (obj.ticket)
            : null;
        const services = Array.isArray(obj.services) ? obj.services : [];
        const firstService = services
            .map((s) => toTrimmedString(s).toLowerCase())
            .find((s) => FEED_SERVICE_TYPES.has(s));
        const ticketNumber = ticket
            ? toTrimmedString(ticket.ticketNumber ?? ticket.requestNumber)
            : '';
        const ticketOrganizationId = ticket
            ? toPositiveInt(ticket.organizationId ?? ticket.organization_id)
            : null;
        const ticketRevision = ticket
            ? toTrimmedString(ticket.ticketRevision ?? ticket.revision)
            : '';
        if (!ticketNumber && !firstService) return null;
        return {
            source: 'manual',
            serviceRequested: firstService
                ? /** @type {FeedServiceRequested} */ (firstService)
                : undefined,
            ticketOrganizationId,
            ticketNumber,
            ticketRevision: ticketRevision || undefined,
            acknowledgeReason: null,
            userNote: toTrimmedString(obj.userNote) || undefined,
        };
    }

    return null;
}

/**
 * @param {FeedServiceRequestMeta & { userNote?: string }} meta
 * @param {Record<string, unknown>|null} [extra]
 * @returns {string}
 */
function buildFeedServiceRequestNote(meta, extra) {
    const serviceRequested = meta.serviceRequested || 'site_documentation';
    const feed = {
        source: meta.source === 'max_auto' ? 'max_auto' : 'manual',
        serviceRequested,
        ticketOrganizationId: meta.ticketOrganizationId != null ? Number(meta.ticketOrganizationId) : null,
        ticketNumber: toTrimmedString(meta.ticketNumber),
        ticketRevision: toTrimmedString(meta.ticketRevision) || null,
        acknowledgeReason:
            meta.acknowledgeReason != null && String(meta.acknowledgeReason).trim() !== ''
                ? String(meta.acknowledgeReason).trim()
                : null,
    };
    /** @type {Record<string, unknown>} */
    const out = {
        feed,
        // Keep legacy v1 fields so Admin UI continues to show ticket + services
        v: 1,
        services: [serviceRequested],
        userNote: meta.userNote != null ? String(meta.userNote) : '',
        ticket: {
            ticketNumber: feed.ticketNumber,
            organizationId: feed.ticketOrganizationId,
            ticketRevision: feed.ticketRevision,
        },
    };
    if (extra && typeof extra === 'object') {
        Object.assign(out, extra);
    }
    const pin = normalizePin(meta.pin);
    if (pin) {
        feed.pin = pin;
    }
    return JSON.stringify(out);
}

/**
 * Read stored ticket pin from service_requests.note feed block.
 * @param {unknown} note
 * @returns {{ lat: number, lng: number }|null}
 */
function getFeedPinFromNote(note) {
    const obj = tryParseObject(note);
    if (!obj || !obj.feed || typeof obj.feed !== 'object') return null;
    return normalizePin(/** @type {Record<string, unknown>} */ (obj.feed).pin);
}

/**
 * Merge acknowledge reason into existing note JSON (or create minimal feed wrapper).
 * @param {unknown} existingNote
 * @param {string|null|undefined} reason
 * @returns {string}
 */
function mergeAcknowledgeReasonIntoNote(existingNote, reason) {
    const obj = tryParseObject(existingNote) || {};
    const feedObj =
        obj.feed && typeof obj.feed === 'object'
            ? { .../** @type {Record<string, unknown>} */ (obj.feed) }
            : {};
    const parsed = parseFeedServiceRequestNote(existingNote);
    if (parsed) {
        feedObj.source = parsed.source;
        feedObj.serviceRequested = parsed.serviceRequested || 'site_documentation';
        feedObj.ticketOrganizationId = parsed.ticketOrganizationId;
        feedObj.ticketNumber = parsed.ticketNumber;
        feedObj.ticketRevision = parsed.ticketRevision || null;
    }
    feedObj.acknowledgeReason =
        reason != null && String(reason).trim() !== '' ? String(reason).trim() : null;
    obj.feed = feedObj;
    if (obj.v == null) obj.v = 1;
    return JSON.stringify(obj);
}

/**
 * Validate manual feed-linked POST body fields.
 * @param {string} serviceType
 * @param {unknown} note
 * @returns {{ ok: true, meta: FeedServiceRequestMeta, noteJson: string } | { ok: false, error: string }}
 */
function validateManualFeedServiceRequest(serviceType, note) {
    const type = toTrimmedString(serviceType).toLowerCase();
    if (!FEED_SERVICE_TYPES.has(type)) {
        return { ok: false, error: 'Invalid service type for feed-linked request' };
    }

    const obj = tryParseObject(note);
    if (!obj) {
        return { ok: false, error: 'Service request note must be JSON with a ticket link' };
    }

    let meta = parseFeedServiceRequestNote(note);
    // Allow clients to send feed block or legacy ticket fields; inject org from body later
    if (!meta || !meta.ticketNumber) {
        return {
            ok: false,
            error: 'Ticket number is required (open a ticket before requesting services)',
        };
    }

    meta = {
        ...meta,
        source: 'manual',
        serviceRequested: /** @type {FeedServiceRequested} */ (type),
    };

    // Prefer explicit feed.ticketOrganizationId; may be filled by route from req.orgId
    const noteJson = buildFeedServiceRequestNote(meta, {
        userNote: meta.userNote || (obj.userNote != null ? String(obj.userNote) : ''),
    });

    return { ok: true, meta, noteJson };
}

/** Active feed queue statuses (includes legacy `new`). */
const FEED_ACTIVE_STATUSES = Object.freeze(['incomplete', 'complete', 'new']);

/** Unresolved SRs counted in admin inbox badges (excludes read/resolved). */
const ADMIN_INBOX_SR_STATUSES = Object.freeze(['new', 'incomplete', 'complete', 'acknowledged']);

function isFeedActiveStatus(status) {
    const s = toTrimmedString(status).toLowerCase();
    return FEED_ACTIVE_STATUSES.includes(s);
}

function isFeedIncompleteLike(status) {
    const s = toTrimmedString(status).toLowerCase();
    return s === 'incomplete' || s === 'new';
}

module.exports = {
    FEED_SERVICE_TYPES,
    FEED_ACTIVE_STATUSES,
    ADMIN_INBOX_SR_STATUSES,
    parseFeedServiceRequestNote,
    buildFeedServiceRequestNote,
    getFeedPinFromNote,
    mergeAcknowledgeReasonIntoNote,
    validateManualFeedServiceRequest,
    isFeedActiveStatus,
    isFeedIncompleteLike,
};
