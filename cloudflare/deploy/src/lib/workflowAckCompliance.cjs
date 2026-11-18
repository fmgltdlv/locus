/**
 * Per-org workflow ack compliance (photos + optional drone map).
 */
const { allRows } = require('./db.cjs');
const {
    normalizeOperatorCodeList,
    isDefaultOperatorCodeLists,
    resolveOperatorCodeLists,
} = require('./operatorResponseCodes.cjs');
const { countPhotosForRequirementInline } = require('./ticketPhotoIntersection.cjs');
const { photoCreatedAtMeetsRevisionCutoff } = require('./photoRequirementCutoff.cjs');
const {
    loadGlobalAerialMaps,
    parseBoundingBox,
    ticketPolygonIntersectsFootprint,
    rowAabbIntersectsBbox,
} = require('./aerialMapQuery.cjs');

const WORKFLOW_ACK_COMPLIANCE_KEY = 'workflowAckCompliance';
const DRONE_MAP_MODES = Object.freeze(['none', 'alternative', 'required']);
const DEFAULT_EXPIRING_SOON_DAYS = 5;
const MIN_EXPIRING_SOON_DAYS = 1;
const MAX_EXPIRING_SOON_DAYS = 15;
const DEFAULT_POLICY = Object.freeze({
    requiredPhotoCount: 0,
    droneMapMode: 'none',
    renewalAckWaivers: false,
    greenResponsesAfterAck: false,
    expiringSoonDays: DEFAULT_EXPIRING_SOON_DAYS,
    notReadyCodes: null,
    actionRequiredCodes: null,
    ackBlockingCodes: null,
});
const MAX_REQUIRED_PHOTO_COUNT = 10;

function safeParseOrgSettings(orgRow) {
    if (!orgRow || orgRow.settings == null || orgRow.settings === '') return {};
    try {
        return typeof orgRow.settings === 'string' ? JSON.parse(orgRow.settings) : orgRow.settings;
    } catch {
        return {};
    }
}

function normalizeDroneMapMode(rawMode, legacyAlternative) {
    if (legacyAlternative === true) return 'alternative';
    const mode = rawMode != null ? String(rawMode).trim().toLowerCase() : 'none';
    return DRONE_MAP_MODES.includes(mode) ? mode : 'none';
}

function normalizeRequiredPhotoCount(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_POLICY.requiredPhotoCount;
    return Math.min(MAX_REQUIRED_PHOTO_COUNT, Math.max(0, Math.round(n)));
}

function normalizeExpiringSoonDays(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_POLICY.expiringSoonDays;
    return Math.min(MAX_EXPIRING_SOON_DAYS, Math.max(MIN_EXPIRING_SOON_DAYS, Math.round(n)));
}

/**
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {{ requiredPhotoCount: number, droneMapMode: 'none'|'alternative'|'required', renewalAckWaivers: boolean, greenResponsesAfterAck: boolean, expiringSoonDays: number, notReadyCodes: string[]|null, actionRequiredCodes: string[]|null, ackBlockingCodes: string[]|null }}
 */
function normalizeWorkflowAckComplianceSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const notReadyCodes = normalizeOperatorCodeList(src.notReadyCodes);
    const actionRequiredCodes = normalizeOperatorCodeList(src.actionRequiredCodes);
    const ackBlockingCodes = normalizeOperatorCodeList(src.ackBlockingCodes);
    return {
        // Photo/drone evidence no longer gates workflow; legacy stored values are ignored.
        requiredPhotoCount: 0,
        droneMapMode: 'none',
        renewalAckWaivers: src.renewalAckWaivers === true,
        greenResponsesAfterAck: src.greenResponsesAfterAck === true,
        expiringSoonDays: normalizeExpiringSoonDays(src.expiringSoonDays),
        notReadyCodes,
        actionRequiredCodes,
        ackBlockingCodes,
    };
}

function isDefaultWorkflowAckCompliancePolicy(normalized) {
    return (
        normalized.requiredPhotoCount === DEFAULT_POLICY.requiredPhotoCount &&
        normalized.droneMapMode === DEFAULT_POLICY.droneMapMode &&
        !normalized.renewalAckWaivers &&
        !normalized.greenResponsesAfterAck &&
        normalized.expiringSoonDays === DEFAULT_POLICY.expiringSoonDays &&
        isDefaultOperatorCodeLists(normalized)
    );
}

/**
 * @param {Record<string, unknown>|null|undefined} orgRow
 */
function getWorkflowAckCompliancePolicy(orgRow) {
    const settings = safeParseOrgSettings(orgRow);
    const raw = settings[WORKFLOW_ACK_COMPLIANCE_KEY];
    return normalizeWorkflowAckComplianceSettings(raw);
}

/** Operator code lists for workflow status + ack gates (org overrides or defaults). */
function getWorkflowOperatorCodeLists(orgRow) {
    return resolveOperatorCodeLists(getWorkflowAckCompliancePolicy(orgRow));
}

/**
 * Sanitize settings.workflowAckCompliance on org save.
 * @param {Record<string, unknown>|null|undefined} settings
 */
function sanitizeWorkflowAckComplianceInSettings(settings) {
    if (!settings || typeof settings !== 'object') return settings;
    const next = { ...settings };
    if (next[WORKFLOW_ACK_COMPLIANCE_KEY] === undefined) return next;
    const normalized = normalizeWorkflowAckComplianceSettings(next[WORKFLOW_ACK_COMPLIANCE_KEY]);
    if (isDefaultWorkflowAckCompliancePolicy(normalized)) {
        delete next[WORKFLOW_ACK_COMPLIANCE_KEY];
    } else {
        const stored = { ...normalized };
        if (stored.notReadyCodes == null) delete stored.notReadyCodes;
        if (stored.actionRequiredCodes == null) delete stored.actionRequiredCodes;
        if (stored.ackBlockingCodes == null) delete stored.ackBlockingCodes;
        next[WORKFLOW_ACK_COMPLIANCE_KEY] = stored;
    }
    return next;
}

function ticketBboxFromRow(row) {
    if (!row) return null;
    const minLng = Number(row.min_lng);
    const minLat = Number(row.min_lat);
    const maxLng = Number(row.max_lng);
    const maxLat = Number(row.max_lat);
    if (![minLng, minLat, maxLng, maxLat].every((n) => Number.isFinite(n))) return null;
    return { minLng, minLat, maxLng, maxLat };
}

function isCutoffPending(ticket) {
    return Boolean(ticket && ticket.photoRequirementCutoffPending);
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {{ minLng: number, minLat: number, maxLng: number, maxLat: number }} bbox
 */
async function loadOrgOwnedAerialMapsInBbox(db, orgId, bbox) {
    const params = [orgId, bbox.maxLng, bbox.minLng, bbox.maxLat, bbox.minLat];
    return allRows(
        db,
        `SELECT a.id, a.name, a.url,
                a.min_lng, a.min_lat, a.max_lng, a.max_lat,
                a.captured_at, a.created_at, a.organization_id,
                a.access_mode, a.hidden_from_users
         FROM aerial_maps a
         WHERE a.organization_id = ?
           AND (
             (a.min_lng IS NOT NULL AND a.min_lng <= ? AND a.max_lng >= ? AND a.min_lat <= ? AND a.max_lat >= ?)
             OR a.min_lng IS NULL
           )`,
        params
    );
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {object} row
 * @param {object} ticket
 */
async function countQualifyingDroneMapsForTicket(db, orgId, row, ticket) {
    const pending = isCutoffPending(ticket);
    if (!ticket || !ticket.polygon) {
        return { qualifyingDroneMaps: 0, pending };
    }
    const bbox = ticketBboxFromRow(row);
    if (!bbox) {
        return { qualifyingDroneMaps: 0, pending };
    }

    const [globalRows, orgRows] = await Promise.all([
        loadGlobalAerialMaps(db, bbox, orgId),
        loadOrgOwnedAerialMapsInBbox(db, orgId, bbox),
    ]);

    const seen = new Set();
    let qualifyingDroneMaps = 0;
    for (const mapRow of [...(globalRows || []), ...(orgRows || [])]) {
        const id = mapRow && mapRow.id != null ? Number(mapRow.id) : NaN;
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id);
        if (!rowAabbIntersectsBbox(mapRow, bbox)) continue;
        const footprint = parseBoundingBox(mapRow);
        if (!footprint || !ticketPolygonIntersectsFootprint(ticket.polygon, footprint)) continue;
        if (pending) continue;
        const capturedAt = mapRow.captured_at || mapRow.created_at;
        if (photoCreatedAtMeetsRevisionCutoff(capturedAt, ticket.photoRequirementCutoffIso)) {
            qualifyingDroneMaps++;
        }
    }
    return { qualifyingDroneMaps, pending };
}

/**
 * @param {{ requiredPhotoCount: number, droneMapMode: string }} policy
 * @param {{ forRequirement: number, pending?: boolean }} photoResult
 * @param {{ qualifyingDroneMaps: number, pending?: boolean }} droneResult
 */
function evaluateComplianceFromCounts(policy, photoResult, droneResult) {
    if (policy.requiredPhotoCount === 0) {
        return { satisfied: true, photosOk: true, droneOk: false, pending: false };
    }

    const photoPending = Boolean(photoResult && photoResult.pending);
    const dronePending =
        policy.droneMapMode !== 'none' && Boolean(droneResult && droneResult.pending);
    if (photoPending || dronePending) {
        return { satisfied: false, photosOk: false, droneOk: false, pending: true };
    }

    const photoCount = photoResult && Number.isFinite(Number(photoResult.forRequirement))
        ? Number(photoResult.forRequirement)
        : 0;
    const droneCount =
        droneResult && Number.isFinite(Number(droneResult.qualifyingDroneMaps))
            ? Number(droneResult.qualifyingDroneMaps)
            : 0;
    const photosOk = photoCount >= policy.requiredPhotoCount;
    const droneOk = droneCount >= 1;

    let satisfied = false;
    if (policy.droneMapMode === 'none') satisfied = photosOk;
    else if (policy.droneMapMode === 'alternative') satisfied = photosOk || droneOk;
    else if (policy.droneMapMode === 'required') satisfied = photosOk && droneOk;

    return { satisfied, photosOk, droneOk, pending: false };
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {Record<string, unknown>|null|undefined} orgRow
 * @param {object} row
 * @param {object} ticket
 */
async function evaluateAckComplianceEvidence(db, orgId, orgRow, row, ticket) {
    const policy = getWorkflowAckCompliancePolicy(orgRow);
    const photoResult = await countPhotosForRequirementInline(db, orgId, row, ticket);
    let droneResult = { qualifyingDroneMaps: 0, pending: false };
    if (policy.droneMapMode !== 'none') {
        droneResult = await countQualifyingDroneMapsForTicket(db, orgId, row, ticket);
    }
    const evalResult = evaluateComplianceFromCounts(policy, photoResult, droneResult);
    return {
        policy,
        photoCount: photoResult.forRequirement,
        qualifyingDroneMaps: droneResult.qualifyingDroneMaps,
        pending: evalResult.pending,
        satisfied: evalResult.satisfied,
        photosOk: evalResult.photosOk,
        droneOk: evalResult.droneOk,
    };
}

/**
 * @param {{ policy: object, photosOk?: boolean, droneOk?: boolean, pending?: boolean }} evidence
 */
function formatAckComplianceError(evidence) {
    if (!evidence || !evidence.policy) {
        return 'Compliance evidence requirements are not met for this ticket';
    }
    if (evidence.pending) {
        return 'Photo requirement cutoff is pending for this ticket; cannot acknowledge yet';
    }
    const { policy, photosOk, droneOk } = evidence;
    if (policy.requiredPhotoCount === 0) return 'Compliance evidence requirements are not met for this ticket';

    const n = policy.requiredPhotoCount;
    const photoPart = `at least ${n} photo${n === 1 ? '' : 's'} in polygon for this revision`;
    const dronePart = '1 drone map overlapping this ticket captured on or after lodge';

    if (policy.droneMapMode === 'none') {
        return `Need ${photoPart} to acknowledge`;
    }
    if (policy.droneMapMode === 'alternative') {
        return `Need ${photoPart}, or ${dronePart}, to acknowledge`;
    }
    const parts = [];
    if (!photosOk) parts.push(photoPart);
    if (!droneOk) parts.push(dronePart);
    if (!parts.length) return 'Compliance evidence requirements are not met for this ticket';
    return `Need ${parts.join(' and ')} to acknowledge`;
}

module.exports = {
    WORKFLOW_ACK_COMPLIANCE_KEY,
    DRONE_MAP_MODES,
    DEFAULT_POLICY,
    MAX_REQUIRED_PHOTO_COUNT,
    DEFAULT_EXPIRING_SOON_DAYS,
    MIN_EXPIRING_SOON_DAYS,
    MAX_EXPIRING_SOON_DAYS,
    getWorkflowAckCompliancePolicy,
    getWorkflowOperatorCodeLists,
    normalizeWorkflowAckComplianceSettings,
    sanitizeWorkflowAckComplianceInSettings,
    countQualifyingDroneMapsForTicket,
    evaluateComplianceFromCounts,
    evaluateAckComplianceEvidence,
    formatAckComplianceError,
};
