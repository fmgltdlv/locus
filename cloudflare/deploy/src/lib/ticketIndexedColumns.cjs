/**
 * Derives SQLite columns + FTS fields from canonical ticket JSON (aligned with ticketBuilder keys).
 */
const { parseInstantForDisplay, pacificEndOfDayUtcIsoFromYmd } = require('./pacificTime.cjs');

/**
 * @param {object|null|undefined} polygon GeoJSON Polygon
 * @returns {{ min_lng: number, min_lat: number, max_lng: number, max_lat: number } | null}
 */
function computePolygonAabb(polygon) {
    if (!polygon || polygon.type !== 'Polygon' || !Array.isArray(polygon.coordinates) || !polygon.coordinates[0]) {
        return null;
    }
    const ring = polygon.coordinates[0];
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const pt of ring) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lng = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }
    if (!Number.isFinite(minLng) || minLng === Infinity) return null;
    return { min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat };
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (value == null) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return null;
}

/**
 * Index ticket_expires_at as an absolute instant so time-based expiry (D1
 * `julianday(...) <= julianday('now')`) and the JS status helpers agree.
 * Offset/Z/naive datetimes → ISO UTC (exact instant preserved, incl. time-of-day);
 * pure date-only YYYY-MM-DD → Pacific end-of-day ISO UTC at ingest; unparseable kept as-is.
 */
function normalizeDateString(value) {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return pacificEndOfDayUtcIsoFromYmd(s);
    const d = parseInstantForDisplay(s);
    if (d == null || Number.isNaN(d.getTime())) return s;
    return d.toISOString();
}

function normalizePolygonJson(polygon) {
    if (!polygon || typeof polygon !== 'object') return null;
    const t = String(polygon.type || '');
    if (t !== 'Polygon' && t !== 'MultiPolygon') return null;
    try {
        return JSON.stringify(polygon);
    } catch (_) {
        return null;
    }
}

function textOrNull(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return null;
    return s === '' ? null : s;
}

function lowerTextOrNull(value) {
    const s = textOrNull(value);
    return s == null ? null : s.toLowerCase();
}

function boolIntOrNull(value) {
    if (value == null || value === '') return null;
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    if (value === false || value === 0 || value === '0' || value === 'false') return 0;
    return null;
}

function intOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseRevisionFromFullTicketNumber(value) {
    const s = textOrNull(value);
    if (!s) return null;
    const m = s.match(/-(\d+)$/);
    return m ? m[1] : null;
}

function firstNonNull(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) return value;
    }
    return null;
}

/**
 * Map-marker point from an AABB / client bbox. Used when pin_lng/pin_lat were never stored.
 * @param {{ minLng?: unknown, minLat?: unknown, maxLng?: unknown, maxLat?: unknown, min_lng?: unknown, min_lat?: unknown, max_lng?: unknown, max_lat?: unknown }|null|undefined} box
 * @returns {{ lng: number, lat: number }|null}
 */
function mapPinFromBbox(box) {
    if (!box || typeof box !== 'object') return null;
    const minLng = Number(box.minLng != null ? box.minLng : box.min_lng);
    const maxLng = Number(box.maxLng != null ? box.maxLng : box.max_lng);
    const minLat = Number(box.minLat != null ? box.minLat : box.min_lat);
    const maxLat = Number(box.maxLat != null ? box.maxLat : box.max_lat);
    if (
        !Number.isFinite(minLng) ||
        !Number.isFinite(maxLng) ||
        !Number.isFinite(minLat) ||
        !Number.isFinite(maxLat)
    ) {
        return null;
    }
    return { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
}

/**
 * Ensure ticket.stubMapPin is set from an existing pin or bbox center (lean list / map markers).
 * @param {object|null|undefined} ticket
 * @returns {object|null|undefined}
 */
function ensureStubMapPinOnTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    if (
        ticket.stubMapPin &&
        Number.isFinite(Number(ticket.stubMapPin.lng)) &&
        Number.isFinite(Number(ticket.stubMapPin.lat))
    ) {
        return ticket;
    }
    const fromBbox = mapPinFromBbox(ticket.bbox);
    if (fromBbox) ticket.stubMapPin = fromBbox;
    return ticket;
}

/**
 * @param {object} ticket canonical ticket object (after stripDerivedTicketUiFields if applicable)
 * @returns {{
 *   min_lng: number|null, min_lat: number|null, max_lng: number|null, max_lat: number|null,
 *   work_description: string|null
 * }}
 */
function indexedValuesFromTicketObject(ticket) {
    const t = ticket && typeof ticket === 'object' ? ticket : {};
    const aabb = computePolygonAabb(t.polygon);
    const stubPin = t.stubMapPin && typeof t.stubMapPin === 'object' ? t.stubMapPin : null;
    let pin_lng =
        stubPin != null && Number.isFinite(Number(stubPin.lng))
            ? Number(stubPin.lng)
            : Number.isFinite(Number(t.pinLng))
              ? Number(t.pinLng)
              : null;
    let pin_lat =
        stubPin != null && Number.isFinite(Number(stubPin.lat))
            ? Number(stubPin.lat)
            : Number.isFinite(Number(t.pinLat))
              ? Number(t.pinLat)
              : null;
    if (pin_lng == null || pin_lat == null) {
        const fromAabb = aabb
            ? mapPinFromBbox({
                  min_lng: aabb.min_lng,
                  min_lat: aabb.min_lat,
                  max_lng: aabb.max_lng,
                  max_lat: aabb.max_lat,
              })
            : mapPinFromBbox(t.bbox);
        if (fromAabb) {
            pin_lng = fromAabb.lng;
            pin_lat = fromAabb.lat;
        }
    }
    const work_description = textOrNull(t.workDescription);
    const ticket_expires_at = normalizeDateString(
        t.ticketExpirationDate || t.endTime || t.dueDate || t.workExpirationDate || null
    );
    const address = firstNonEmptyString(t.address, t.digSiteAddress, t.locationSummary);
    const polygon_json = normalizePolygonJson(t.polygon);
    const ngen_job_number = textOrNull(t.ngenJobNumber);
    const ngen_enquiry_status = textOrNull(t.ngenEnquiryStatus);
    const lodged_by_user_name = lowerTextOrNull(t.lodgedByUserName);
    const revision = textOrNull(t.ticketRevision) || parseRevisionFromFullTicketNumber(t.ticketNumberFull);
    const job_number = textOrNull(t.ngenJobNumber);
    const current_lodged_by_user_name = lowerTextOrNull(t.lodgedByUserName);
    const original_lodged_by_user_name = lowerTextOrNull(firstNonNull(t.originalLodgedByUserName, t.lodgedByUserName));
    const scope_of_work = firstNonEmptyString(t.scopeOfWork, t.ticketScope, t.ngenNotes);
    return {
        schema_version: intOrNull(t.schemaVersion) || 2,
        min_lng: aabb ? aabb.min_lng : null,
        min_lat: aabb ? aabb.min_lat : null,
        max_lng: aabb ? aabb.max_lng : null,
        max_lat: aabb ? aabb.max_lat : null,
        pin_lng,
        pin_lat,
        work_description,
        ticket_expires_at,
        address,
        polygon_json,
        ngen_job_number,
        ngen_enquiry_status,
        lodged_by_user_name,
        revision,
        job_number,
        previous_ticket_number: textOrNull(t.ngenPreviousRequestNumber),
        current_ngen_enquiry_status: ngen_enquiry_status,
        lodged_on: textOrNull(t.ngenLodgedOn),
        ngen_last_updated_time: textOrNull(t.ngenLastUpdatedTime),
        original_lodged_by_user_name,
        current_lodged_by_user_name,
        commencement_date: textOrNull(t.startTime),
        work_legal_start_date: textOrNull(t.legalStartDate),
        full_address: textOrNull(t.fullAddress),
        city: textOrNull(t.city),
        state: textOrNull(t.state),
        county: textOrNull(t.county),
        zipcode: textOrNull(t.zipcode),
        nearest_cross_street: textOrNull(t.nearbyCrossStreet),
        ngen_ticket_type: textOrNull(firstNonEmptyString(t.ngenTicketType, t.portalTicketType)),
        category_of_work: textOrNull(t.categoryOfWork),
        work_activity: textOrNull(t.workActivity),
        excavation_method: textOrNull(t.excavationMethod),
        excavation_depth: textOrNull(t.ngenExcavationDepth),
        working_on_behalf: textOrNull(t.ngenWorkingOnBehalf),
        working_on_behalf_of_auth: textOrNull(t.ngenWorkingOnBehalfOfAuth),
        user_reference: textOrNull(t.ngenUserReference),
        scope_of_work,
        priority: textOrNull(t.ngenPriority),
        principal_contact_name: textOrNull(t.ngenPrincipalContactName),
        principal_contact_phone: textOrNull(t.ngenPrincipalContactPhone),
        required_response_count: intOrNull(t.ngenRequiredResponseCount),
        received_response_count: intOrNull(t.ngenReceivedResponseCount),
        is_boring: boolIntOrNull(t.isBoring),
        is_blasting: boolIntOrNull(t.isBlasting),
        can_be_amended: boolIntOrNull(t.canBeAmended),
        can_be_no_response: boolIntOrNull(t.canBeNoResponse),
        can_be_remark: boolIntOrNull(t.canBeRemark),
        can_be_damage: boolIntOrNull(t.canBeDamage),
        can_be_renewal: boolIntOrNull(t.canBeRenewal),
        can_be_exposed: boolIntOrNull(t.canBeExposed),
        can_be_follow_up: boolIntOrNull(t.canBeFollowUp),
        can_be_disputed: boolIntOrNull(t.canBeDisputed),
        created_by: textOrNull(t.createdBy),
        ngen_full_detail_refreshed_at: textOrNull(t.ngenFullDetailRefreshedAt),
        sync_lane: textOrNull(t.syncLane),
    };
}

function indexedParamTuple(v) {
    return [
        v.min_lng,
        v.min_lat,
        v.max_lng,
        v.max_lat,
        v.pin_lng,
        v.pin_lat,
        v.work_description,
        v.ticket_expires_at,
        v.address,
        v.polygon_json,
        v.ngen_job_number,
        v.ngen_enquiry_status,
        v.lodged_by_user_name,
        v.schema_version,
        v.revision,
        v.job_number,
        v.previous_ticket_number,
        v.current_ngen_enquiry_status,
        v.lodged_on,
        v.ngen_last_updated_time,
        v.original_lodged_by_user_name,
        v.current_lodged_by_user_name,
        v.commencement_date,
        v.work_legal_start_date,
        v.full_address,
        v.city,
        v.state,
        v.county,
        v.zipcode,
        v.nearest_cross_street,
        v.ngen_ticket_type,
        v.category_of_work,
        v.work_activity,
        v.excavation_method,
        v.excavation_depth,
        v.working_on_behalf,
        v.working_on_behalf_of_auth,
        v.user_reference,
        v.scope_of_work,
        v.priority,
        v.principal_contact_name,
        v.principal_contact_phone,
        v.required_response_count,
        v.received_response_count,
        v.is_boring,
        v.is_blasting,
        v.can_be_amended,
        v.can_be_no_response,
        v.can_be_remark,
        v.can_be_damage,
        v.can_be_renewal,
        v.can_be_exposed,
        v.can_be_follow_up,
        v.can_be_disputed,
        v.created_by,
        v.ngen_full_detail_refreshed_at,
        v.sync_lane,
    ];
}

const INDEXED_COLUMNS = [
    'min_lng',
    'min_lat',
    'max_lng',
    'max_lat',
    'pin_lng',
    'pin_lat',
    'work_description',
    'ticket_expires_at',
    'address',
    'polygon_json',
    'ngen_job_number',
    'ngen_enquiry_status',
    'lodged_by_user_name',
    'schema_version',
    'revision',
    'job_number',
    'previous_ticket_number',
    'current_ngen_enquiry_status',
    'lodged_on',
    'ngen_last_updated_time',
    'original_lodged_by_user_name',
    'current_lodged_by_user_name',
    'commencement_date',
    'work_legal_start_date',
    'full_address',
    'city',
    'state',
    'county',
    'zipcode',
    'nearest_cross_street',
    'ngen_ticket_type',
    'category_of_work',
    'work_activity',
    'excavation_method',
    'excavation_depth',
    'working_on_behalf',
    'working_on_behalf_of_auth',
    'user_reference',
    'scope_of_work',
    'priority',
    'principal_contact_name',
    'principal_contact_phone',
    'required_response_count',
    'received_response_count',
    'is_boring',
    'is_blasting',
    'can_be_amended',
    'can_be_no_response',
    'can_be_remark',
    'can_be_damage',
    'can_be_renewal',
    'can_be_exposed',
    'can_be_follow_up',
    'can_be_disputed',
    'created_by',
    'ngen_full_detail_refreshed_at',
    'sync_lane',
];

const INSERT_COLUMNS = ['organization_id', 'user_id', 'ticket_number', ...INDEXED_COLUMNS, 'updated_at'];
const INSERT_VALUES = ['?', '?', '?', ...new Array(INDEXED_COLUMNS.length).fill('?'), 'CURRENT_TIMESTAMP'];
const UPSERT_PRESERVE_EXISTING_COLUMNS = new Set([
    'original_lodged_by_user_name',
    'full_address',
    'city',
    'state',
    'county',
    'zipcode',
    'nearest_cross_street',
    'category_of_work',
    'work_activity',
    'excavation_method',
    'excavation_depth',
    'is_boring',
    'is_blasting',
    'sync_lane',
]);
const UPSERT_SET_SQL = [
    'user_id = excluded.user_id',
    ...INDEXED_COLUMNS.map((col) =>
        UPSERT_PRESERVE_EXISTING_COLUMNS.has(col)
            ? `${col} = COALESCE(tickets.${col}, excluded.${col})`
            : `${col} = excluded.${col}`
    ),
    'updated_at = CURRENT_TIMESTAMP',
].join(', ');

const INSERT_OR_REPLACE_SQL = `INSERT INTO tickets (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_VALUES.join(', ')}) ON CONFLICT(organization_id, ticket_number) DO UPDATE SET ${UPSERT_SET_SQL}`;

const INSERT_NEW_SQL = `INSERT INTO tickets (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_VALUES.join(', ')})`;

/**
 * @param {number} orgId
 * @param {number} userId
 * @param {string} ticketNumber
 * @param {object} ticketDataObjStripped object ready to JSON.stringify (caller runs stripDerivedTicketUiFields)
 */
function buildInsertOrReplaceParams(orgId, userId, ticketNumber, ticketDataObjStripped) {
    const v = indexedValuesFromTicketObject(ticketDataObjStripped);
    return [orgId, userId, ticketNumber, ...indexedParamTuple(v)];
}

function buildInsertNewParams(orgId, userId, ticketNumber, ticketDataObjStripped) {
    return buildInsertOrReplaceParams(orgId, userId, ticketNumber, ticketDataObjStripped);
}

const UPDATE_EXPRESSIONS = {
    original_lodged_by_user_name: 'original_lodged_by_user_name = COALESCE(original_lodged_by_user_name, ?)',
    full_address: 'full_address = COALESCE(full_address, ?)',
    city: 'city = COALESCE(city, ?)',
    state: 'state = COALESCE(state, ?)',
    county: 'county = COALESCE(county, ?)',
    zipcode: 'zipcode = COALESCE(zipcode, ?)',
    nearest_cross_street: 'nearest_cross_street = COALESCE(nearest_cross_street, ?)',
    category_of_work: 'category_of_work = COALESCE(category_of_work, ?)',
    work_activity: 'work_activity = COALESCE(work_activity, ?)',
    excavation_method: 'excavation_method = COALESCE(excavation_method, ?)',
    excavation_depth: 'excavation_depth = COALESCE(excavation_depth, ?)',
    is_boring: 'is_boring = COALESCE(is_boring, ?)',
    is_blasting: 'is_blasting = COALESCE(is_blasting, ?)',
    sync_lane: 'sync_lane = COALESCE(?, sync_lane)',
};

const UPDATE_INDEXED_SET_SQL = INDEXED_COLUMNS.map((col) => UPDATE_EXPRESSIONS[col] || `${col} = ?`).join(', ');

const UPDATE_TICKET_DATA_SQL = `UPDATE tickets SET ${UPDATE_INDEXED_SET_SQL}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

function buildUpdateTicketDataParams(ticketDataObjStripped, rowId) {
    const v = indexedValuesFromTicketObject(ticketDataObjStripped);
    return [...indexedParamTuple(v), rowId];
}

const UPDATE_TICKET_DATA_AND_USER_SQL = `UPDATE tickets SET user_id = ?, ${UPDATE_INDEXED_SET_SQL}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

function buildUpdateTicketDataAndUserParams(ticketDataObjStripped, userId, rowId) {
    const v = indexedValuesFromTicketObject(ticketDataObjStripped);
    return [userId, ...indexedParamTuple(v), rowId];
}

/**
 * Overlay DB columns onto parsed ticket JSON for API responses (supports future JSON key stripping).
 * @param {object} ticketData parsed legacy ticket object
 * @param {object} row DB row (may include indexed columns)
 */
/**
 * When loading existing ticket JSON for merges (e.g. webhooks), fill missing fields from DB columns
 * so stripping those keys from JSON later does not lose data.
 * @param {object|null} ticketObj
 * @param {{ work_description?: string|null }|null} row
 */
function hydrateTicketDataFromDbColumnsIfMissing(ticketObj, row) {
    if (!row || typeof ticketObj !== 'object' || ticketObj === null) return ticketObj;
    const t = { ...ticketObj };
    const hydrate = (column, key) => {
        if (t[key] == null && row[column] != null) t[key] = row[column];
    };
    const hydrateBool = (column, key) => {
        if (t[key] == null && row[column] != null) t[key] = Number(row[column]) === 1;
    };
    if (t.workDescription == null && row.work_description != null) t.workDescription = row.work_description;
    if (t.ticketExpirationDate == null && row.ticket_expires_at != null) t.ticketExpirationDate = row.ticket_expires_at;
    if (t.address == null && row.address != null) t.address = row.address;
    if (t.polygon == null && row.polygon_json != null) {
        try {
            t.polygon = JSON.parse(row.polygon_json);
        } catch (_) {
            /* ignore invalid DB polygon_json */
        }
    }
    if (t.ngenJobNumber == null && row.ngen_job_number != null) t.ngenJobNumber = row.ngen_job_number;
    if (t.ngenEnquiryStatus == null && row.ngen_enquiry_status != null) t.ngenEnquiryStatus = row.ngen_enquiry_status;
    if (t.lodgedByUserName == null && row.lodged_by_user_name != null) t.lodgedByUserName = row.lodged_by_user_name;
    hydrate('revision', 'ticketRevision');
    hydrate('job_number', 'ngenJobNumber');
    hydrate('previous_ticket_number', 'ngenPreviousRequestNumber');
    hydrate('current_ngen_enquiry_status', 'ngenEnquiryStatus');
    hydrate('lodged_on', 'ngenLodgedOn');
    hydrate('ngen_last_updated_time', 'ngenLastUpdatedTime');
    hydrate('original_lodged_by_user_name', 'originalLodgedByUserName');
    hydrate('current_lodged_by_user_name', 'lodgedByUserName');
    hydrate('commencement_date', 'startTime');
    hydrate('work_legal_start_date', 'legalStartDate');
    hydrate('full_address', 'fullAddress');
    hydrate('city', 'city');
    hydrate('state', 'state');
    hydrate('county', 'county');
    hydrate('zipcode', 'zipcode');
    hydrate('nearest_cross_street', 'nearbyCrossStreet');
    hydrate('ngen_ticket_type', 'ngenTicketType');
    hydrate('category_of_work', 'categoryOfWork');
    hydrate('work_activity', 'workActivity');
    hydrate('excavation_method', 'excavationMethod');
    hydrate('excavation_depth', 'ngenExcavationDepth');
    hydrate('working_on_behalf', 'ngenWorkingOnBehalf');
    hydrate('working_on_behalf_of_auth', 'ngenWorkingOnBehalfOfAuth');
    hydrate('user_reference', 'ngenUserReference');
    hydrate('scope_of_work', 'scopeOfWork');
    hydrate('priority', 'ngenPriority');
    hydrate('principal_contact_name', 'ngenPrincipalContactName');
    hydrate('principal_contact_phone', 'ngenPrincipalContactPhone');
    hydrate('created_by', 'createdBy');
    hydrate('required_response_count', 'ngenRequiredResponseCount');
    hydrate('received_response_count', 'ngenReceivedResponseCount');
    hydrateBool('is_boring', 'isBoring');
    hydrateBool('is_blasting', 'isBlasting');
    hydrateBool('can_be_amended', 'canBeAmended');
    hydrateBool('can_be_no_response', 'canBeNoResponse');
    hydrateBool('can_be_remark', 'canBeRemark');
    hydrateBool('can_be_damage', 'canBeDamage');
    hydrateBool('can_be_renewal', 'canBeRenewal');
    hydrateBool('can_be_exposed', 'canBeExposed');
    hydrateBool('can_be_follow_up', 'canBeFollowUp');
    hydrateBool('can_be_disputed', 'canBeDisputed');
    hydrate('ngen_full_detail_refreshed_at', 'ngenFullDetailRefreshedAt');
    hydrate('sync_lane', 'syncLane');
    if (
        (t.stubMapPin == null || typeof t.stubMapPin !== 'object') &&
        row.pin_lng != null &&
        row.pin_lat != null &&
        Number.isFinite(Number(row.pin_lng)) &&
        Number.isFinite(Number(row.pin_lat))
    ) {
        t.stubMapPin = { lng: Number(row.pin_lng), lat: Number(row.pin_lat) };
    }
    if (
        t.bbox == null &&
        row.min_lng != null &&
        row.max_lng != null &&
        row.min_lat != null &&
        row.max_lat != null &&
        Number.isFinite(Number(row.min_lng)) &&
        Number.isFinite(Number(row.max_lng)) &&
        Number.isFinite(Number(row.min_lat)) &&
        Number.isFinite(Number(row.max_lat))
    ) {
        t.bbox = {
            minLng: Number(row.min_lng),
            minLat: Number(row.min_lat),
            maxLng: Number(row.max_lng),
            maxLat: Number(row.max_lat),
        };
    }
    ensureStubMapPinOnTicket(t);
    return t;
}

function applyIndexedColumnsToTicketShape(ticketData, row) {
    if (!row || typeof ticketData !== 'object' || ticketData === null) return ticketData;
    const out = { ...ticketData };
    const applyText = (column, key) => {
        if (row[column] !== undefined && row[column] !== null) out[key] = row[column];
    };
    const applyBool = (column, key) => {
        if (row[column] !== undefined && row[column] !== null) out[key] = Number(row[column]) === 1;
    };
    if (row.work_description !== undefined && row.work_description !== null) {
        out.workDescription = row.work_description;
    }
    if (row.ticket_expires_at !== undefined && row.ticket_expires_at !== null) {
        out.ticketExpirationDate = row.ticket_expires_at;
    }
    if (row.address !== undefined && row.address !== null) {
        out.address = row.address;
    }
    if (row.polygon_json !== undefined && row.polygon_json !== null) {
        try {
            out.polygon = JSON.parse(row.polygon_json);
        } catch (_) {
            /* ignore invalid DB polygon_json */
        }
    }
    if (row.ngen_job_number !== undefined && row.ngen_job_number !== null) {
        out.ngenJobNumber = row.ngen_job_number;
    }
    if (row.ngen_enquiry_status !== undefined && row.ngen_enquiry_status !== null) {
        out.ngenEnquiryStatus = row.ngen_enquiry_status;
    }
    if (row.lodged_by_user_name !== undefined && row.lodged_by_user_name !== null) {
        out.lodgedByUserName = row.lodged_by_user_name;
    }
    applyText('revision', 'ticketRevision');
    applyText('job_number', 'ngenJobNumber');
    applyText('previous_ticket_number', 'ngenPreviousRequestNumber');
    applyText('current_ngen_enquiry_status', 'ngenEnquiryStatus');
    applyText('lodged_on', 'ngenLodgedOn');
    applyText('ngen_last_updated_time', 'ngenLastUpdatedTime');
    applyText('original_lodged_by_user_name', 'originalLodgedByUserName');
    applyText('current_lodged_by_user_name', 'lodgedByUserName');
    applyText('commencement_date', 'startTime');
    applyText('work_legal_start_date', 'legalStartDate');
    applyText('full_address', 'fullAddress');
    applyText('city', 'city');
    applyText('state', 'state');
    applyText('county', 'county');
    applyText('zipcode', 'zipcode');
    applyText('nearest_cross_street', 'nearbyCrossStreet');
    applyText('ngen_ticket_type', 'ngenTicketType');
    applyText('category_of_work', 'categoryOfWork');
    applyText('work_activity', 'workActivity');
    applyText('excavation_method', 'excavationMethod');
    applyText('excavation_depth', 'ngenExcavationDepth');
    applyText('working_on_behalf', 'ngenWorkingOnBehalf');
    applyText('working_on_behalf_of_auth', 'ngenWorkingOnBehalfOfAuth');
    applyText('user_reference', 'ngenUserReference');
    applyText('scope_of_work', 'scopeOfWork');
    applyText('priority', 'ngenPriority');
    applyText('principal_contact_name', 'ngenPrincipalContactName');
    applyText('principal_contact_phone', 'ngenPrincipalContactPhone');
    applyText('created_by', 'createdBy');
    if (row.required_response_count !== undefined && row.required_response_count !== null) {
        out.ngenRequiredResponseCount = Number(row.required_response_count);
    }
    if (row.received_response_count !== undefined && row.received_response_count !== null) {
        out.ngenReceivedResponseCount = Number(row.received_response_count);
    }
    applyBool('is_boring', 'isBoring');
    applyBool('is_blasting', 'isBlasting');
    applyBool('can_be_amended', 'canBeAmended');
    applyBool('can_be_no_response', 'canBeNoResponse');
    applyBool('can_be_remark', 'canBeRemark');
    applyBool('can_be_damage', 'canBeDamage');
    applyBool('can_be_renewal', 'canBeRenewal');
    applyBool('can_be_exposed', 'canBeExposed');
    applyBool('can_be_follow_up', 'canBeFollowUp');
    applyBool('can_be_disputed', 'canBeDisputed');
    applyText('ngen_full_detail_refreshed_at', 'ngenFullDetailRefreshedAt');
    applyText('sync_lane', 'syncLane');
    if (
        row.min_lng != null &&
        row.max_lng != null &&
        row.min_lat != null &&
        row.max_lat != null &&
        Number.isFinite(Number(row.min_lng)) &&
        Number.isFinite(Number(row.max_lng)) &&
        Number.isFinite(Number(row.min_lat)) &&
        Number.isFinite(Number(row.max_lat))
    ) {
        out.bbox = {
            minLng: Number(row.min_lng),
            minLat: Number(row.min_lat),
            maxLng: Number(row.max_lng),
            maxLat: Number(row.max_lat),
        };
    }
    if (
        row.pin_lng != null &&
        row.pin_lat != null &&
        Number.isFinite(Number(row.pin_lng)) &&
        Number.isFinite(Number(row.pin_lat))
    ) {
        out.stubMapPin = { lng: Number(row.pin_lng), lat: Number(row.pin_lat) };
    }
    ensureStubMapPinOnTicket(out);
    return out;
}

module.exports = {
    computePolygonAabb,
    normalizePolygonJson,
    mapPinFromBbox,
    ensureStubMapPinOnTicket,
    indexedValuesFromTicketObject,
    hydrateTicketDataFromDbColumnsIfMissing,
    INSERT_OR_REPLACE_SQL,
    INSERT_NEW_SQL,
    buildInsertOrReplaceParams,
    buildInsertNewParams,
    UPDATE_TICKET_DATA_SQL,
    buildUpdateTicketDataParams,
    UPDATE_TICKET_DATA_AND_USER_SQL,
    buildUpdateTicketDataAndUserParams,
    applyIndexedColumnsToTicketShape,
};
