/**
 * nGen EnquirySearch `notifications` → ticket operatorResponses + global station phone directory.
 */

const { getOperatorDirOne, putOperatorDirRow } = require('./operatorDirectoryKv.js');
const { getOperatorStatus, coerceLegacyPosrOperatorRowToNgenPending } = require('./ticketBuilder.cjs');
const { filterOperatorResponsesForCurrentRevision } = require('./operatorResponseRevision.cjs');

const MS_PER_DAY = 86400000;
const PHONE_REFRESH_DAYS = 7;

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

/**
 * nGen EnquirySearch notifications usually nest station / company under `authority` (camelCase or PascalCase).
 * @param {object|null|undefined} n
 * @returns {object|null}
 */
function authorityFromNotification(n) {
    if (!n || typeof n !== 'object') return null;
    const a = n.authority || n.Authority;
    return a && typeof a === 'object' ? a : null;
}

/**
 * nGen / .NET payloads may use camelCase `id` or PascalCase `Id` on the authority record.
 * @param {object|null|undefined} auth
 * @returns {string|null}
 */
function authorityRecordId(auth) {
    if (!auth || typeof auth !== 'object') return null;
    const raw = auth.id ?? auth.Id ?? auth.ID;
    if (raw == null) return null;
    const s = String(raw).trim();
    return s || null;
}

function stationCodeFromNotification(n) {
    if (!n || typeof n !== 'object') return null;
    const auth = authorityFromNotification(n);
    return (
        firstNonEmpty(
            n.stationCode,
            n.StationCode,
            n.code,
            n.Code,
            n.station_code,
            auth && firstNonEmpty(auth.stationCode, auth.StationCode)
        ) || null
    );
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

/**
 * @param {object|null|undefined} n
 * @returns {string|null}
 */
function authorityIdFromNotificationRow(n) {
    if (!n || typeof n !== 'object') return null;
    const authority = authorityFromNotification(n);
    const fromAuth = authorityRecordId(authority);
    if (fromAuth) return fromAuth;
    if (n.authorityId != null) {
        const s = String(n.authorityId).trim();
        return s || null;
    }
    if (n.AuthorityId != null) {
        const s = String(n.AuthorityId).trim();
        return s || null;
    }
    return null;
}

/**
 * True when top-level `notifications` / `Notifications` has at least one row with a resolvable authority id.
 * Used to decide whether to fall back to SearchCurrentUserEnquiries for richer notification rows.
 * @param {object|null|undefined} enquirySearch
 * @returns {boolean}
 */
function enquiryNotificationRowsHaveResolvableAuthorityIds(enquirySearch) {
    if (!enquirySearch || typeof enquirySearch !== 'object') return false;
    const a = Array.isArray(enquirySearch.notifications) ? enquirySearch.notifications : [];
    const b = Array.isArray(enquirySearch.Notifications) ? enquirySearch.Notifications : [];
    const rows = a.length > 0 ? a : b;
    if (!rows.length) return false;
    for (const row of rows) {
        if (authorityIdFromNotificationRow(row)) return true;
    }
    return false;
}

/**
 * True when object looks like one nGen notification row (authority id + station code).
 * @param {unknown} o
 * @returns {boolean}
 */
function isLikelyNotificationObject(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const aid = authorityIdFromNotificationRow(o);
    if (!aid) return false;
    return !!stationCodeFromNotification(o);
}

/**
 * GetCurrentUserEnquiryAsync often returns `notifications: null` while the same rows exist nested
 * (e.g. under enquiryDetails). Shallow recursive search for arrays of notification-shaped objects.
 * @param {object|null|undefined} enquirySearch
 * @returns {object[]}
 */
function discoverNotificationRowsFromEnquirySearch(enquirySearch) {
    if (!enquirySearch || typeof enquirySearch !== 'object') return [];
    const found = [];
    const seenArrays = new WeakSet();

    function visit(node, depth) {
        if (node == null || depth > 8) return;
        if (typeof node !== 'object') return;
        if (Array.isArray(node)) {
            if (seenArrays.has(node)) return;
            if (node.length > 0 && isLikelyNotificationObject(node[0])) {
                seenArrays.add(node);
                for (const item of node) {
                    if (isLikelyNotificationObject(item)) found.push(item);
                }
            }
            return;
        }
        for (const k of Object.keys(node)) {
            try {
                visit(node[k], depth + 1);
            } catch (_) {
                /* ignore */
            }
        }
    }

    visit(enquirySearch, 0);
    return found;
}

/**
 * @param {object|null|undefined} enquirySearch
 * @returns {object[]}
 */
function collectNotificationRowsForPhoneDirectory(enquirySearch) {
    if (!enquirySearch || typeof enquirySearch !== 'object') return [];
    if (Array.isArray(enquirySearch.notifications) && enquirySearch.notifications.length > 0) {
        return enquirySearch.notifications;
    }
    if (Array.isArray(enquirySearch.Notifications) && enquirySearch.Notifications.length > 0) {
        return enquirySearch.Notifications;
    }
    return discoverNotificationRowsFromEnquirySearch(enquirySearch);
}

/**
 * @param {object} ticket
 * @param {object[]} notificationRows
 */
function mergeAuthorityIdsFromNotificationRowsOntoOperatorResponses(ticket, notificationRows) {
    if (!ticket || !Array.isArray(ticket.operatorResponses) || !Array.isArray(notificationRows)) return;
    const byCode = new Map();
    for (const n of notificationRows) {
        if (!n || typeof n !== 'object') continue;
        const sc = stationCodeFromNotification(n);
        const aid = authorityIdFromNotificationRow(n);
        if (!sc || !aid) continue;
        const key = String(sc).trim().toUpperCase();
        if (key) byCode.set(key, aid);
    }
    for (const r of ticket.operatorResponses) {
        if (!r || typeof r !== 'object') continue;
        const code = String(r.stationCode || r.operatorCode || '')
            .trim()
            .toUpperCase();
        if (!code) continue;
        const aid = byCode.get(code);
        if (aid && (r.authorityId == null || String(r.authorityId).trim() === '')) {
            r.authorityId = aid;
            if (!r.source) r.source = 'ngen_notification_merge';
        }
    }
}

/**
 * Map nGen notifications to operatorResponses-shaped rows (nGen wins over POSR when non-empty).
 * @param {object[]} notifications
 * @param {string|null} ticketRevision
 * @param {string|null} ticketNumberFull
 * @returns {object[]}
 */
function notificationsToOperatorResponses(notifications, ticketRevision, ticketNumberFull) {
    if (!Array.isArray(notifications) || notifications.length === 0) return [];
    const out = [];
    notifications.forEach((n, index) => {
        if (!n || typeof n !== 'object') return;
        const stationCode = stationCodeFromNotification(n);
        const authority = authorityFromNotification(n);
        let authorityId = authorityRecordId(authority);
        if (!authorityId && n.authorityId != null) {
            const s = String(n.authorityId).trim();
            if (s) authorityId = s;
        }
        if (!authorityId && n.AuthorityId != null) {
            const s = String(n.AuthorityId).trim();
            if (s) authorityId = s;
        }
        const name = firstNonEmpty(
            n.name,
            n.Name,
            n.operatorName,
            n.utilityName,
            n.stationName,
            authority && firstNonEmpty(authority.name, authority.Name, authority.shortName, authority.ShortName),
            authority &&
                firstNonEmpty(authority.memberCompanyName, authority.MemberCompanyName)
        );
        const responseDate = firstNonEmpty(
            n.responseDate,
            n.ResponseDate,
            n.respondedAt,
            n.responseReceived,
            n.latestResponseDate,
            n.LatestResponseDate
        );
        const responseCode = firstNonEmpty(
            n.responseCode,
            n.ResponseCode,
            n.latestResponse,
            n.LatestResponse,
            n.code,
            n.Code
        );
        const comment = firstNonEmpty(
            n.notes,
            n.Notes,
            n.andComment,
            n.AndComment,
            n.comment,
            n.Comment,
            n.description,
            n.Description
        );
        out.push({
            id: `ngen-n-${Date.now()}-${index}`,
            stationCode,
            operatorCode: stationCode,
            operatorName: name || stationCode || authorityId,
            authorityId,
            statusCode: responseCode,
            respondedAt: responseDate,
            comment,
            operatorStatus: getOperatorStatus(responseCode),
            source: 'ngen_notification',
            ticketRevisionSnapshot: ticketRevision != null ? String(ticketRevision) : null,
            ticketNumberFullSnapshot: ticketNumberFull != null ? String(ticketNumberFull) : null,
        });
    });
    return out;
}

/**
 * Apply nGen notifications to ticket: replace operatorResponses when list non-empty.
 * @param {object} ticket
 * @param {object} enquirySearch root EnquirySearch JSON
 */
function applyEnquiryNotificationsToTicket(ticket, enquirySearch) {
    if (!ticket || typeof ticket !== 'object') return;
    const rev = ticket.ticketRevision != null ? String(ticket.ticketRevision).trim() : null;
    if (Array.isArray(ticket.operatorResponses) && ticket.operatorResponses.length > 0) {
        ticket.operatorResponses = filterOperatorResponsesForCurrentRevision(ticket, ticket.operatorResponses);
    }
    const full = ticket.ticketNumberFull != null ? String(ticket.ticketNumberFull).trim() : null;
    const hadTopLevelNotifications =
        (enquirySearch && Array.isArray(enquirySearch.notifications) && enquirySearch.notifications.length > 0) ||
        (enquirySearch && Array.isArray(enquirySearch.Notifications) && enquirySearch.Notifications.length > 0);
    let notifications =
        enquirySearch && Array.isArray(enquirySearch.notifications)
            ? enquirySearch.notifications
            : enquirySearch && Array.isArray(enquirySearch.Notifications)
              ? enquirySearch.Notifications
              : [];
    if (notifications.length === 0 && enquirySearch && typeof enquirySearch === 'object') {
        notifications = discoverNotificationRowsFromEnquirySearch(enquirySearch);
    }
    if (notifications.length === 0) {
        if (Array.isArray(ticket.operatorResponses) && ticket.operatorResponses.length > 0) {
            ticket.operatorResponses = ticket.operatorResponses.map((r, i) =>
                coerceLegacyPosrOperatorRowToNgenPending(r, rev, full, i)
            );
            ticket.stationCodes = [
                ...new Set(ticket.operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean)),
            ];
            ticket.stationDetails = ticket.operatorResponses.map((r) => ({
                code: r.stationCode || r.operatorCode,
                name: r.operatorName,
                responseDate: r.respondedAt,
                responseCode: r.statusCode,
                comment: r.comment,
            }));
        }
        return;
    }
    if (hadTopLevelNotifications) {
        ticket.operatorResponses = notificationsToOperatorResponses(notifications, rev, full);
    } else if (Array.isArray(ticket.operatorResponses) && ticket.operatorResponses.length > 0) {
        mergeAuthorityIdsFromNotificationRowsOntoOperatorResponses(ticket, notifications);
    } else {
        ticket.operatorResponses = notificationsToOperatorResponses(notifications, rev, full);
    }
    ticket.operatorResponses = (ticket.operatorResponses || []).map((r, i) =>
        coerceLegacyPosrOperatorRowToNgenPending(r, rev, full, i)
    );
    ticket.stationCodes = [
        ...new Set(ticket.operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean)),
    ];
    ticket.stationDetails = ticket.operatorResponses.map((r) => ({
        code: r.stationCode || r.operatorCode,
        name: r.operatorName,
        responseDate: r.respondedAt,
        responseCode: r.statusCode,
        comment: r.comment,
    }));
}

/**
 * @param {import('sqlite3').Database} db
 * @param {object[]} notifications
 * @returns {Promise<void>}
 */
async function upsertStationOperatorPhonesFromNotifications(db, notifications) {
    if (!db || !Array.isArray(notifications) || notifications.length === 0) {
        return;
    }
    const now = Date.now();
    const staleMs = PHONE_REFRESH_DAYS * MS_PER_DAY;

    for (const n of notifications) {
        if (!n || typeof n !== 'object') continue;
        const stationCode = stationCodeFromNotification(n);
        if (!stationCode) continue;
        const auth = authorityFromNotification(n);
        const nameWithPhones = firstNonEmpty(
            n.nameWithPhoneNumbers,
            n.NameWithPhoneNumbers,
            n.name_with_phone_numbers,
            auth && firstNonEmpty(auth.nameWithPhoneNumbers, auth.NameWithPhoneNumbers)
        );
        let industry = pickDisplayValue(n.industry);
        if (!industry && auth && Array.isArray(auth.industry) && auth.industry.length > 0) {
            industry = pickDisplayValue(auth.industry[0]);
        }
        if (!nameWithPhones && !industry) continue;

        const row = await getOperatorDirOne(db, stationCode);
        const hasPhones = row && row.name_with_phones != null && String(row.name_with_phones).trim() !== '';
        let last = 0;
        if (row && row.last_refreshed_at) {
            const t = new Date(row.last_refreshed_at).getTime();
            if (!Number.isNaN(t)) last = t;
        }
        const allowRefresh = !hasPhones || now - last >= staleMs;
        if (hasPhones && !allowRefresh) continue;

        const nw = nameWithPhones || (row && row.name_with_phones) || '';
        const ind = industry || (row && row.industry) || '';

        await putOperatorDirRow(db, stationCode, nw || null, ind || null);
    }
}

module.exports = {
    applyEnquiryNotificationsToTicket,
    upsertStationOperatorPhonesFromNotifications,
    notificationsToOperatorResponses,
    authorityFromNotification,
    authorityRecordId,
    enquiryNotificationRowsHaveResolvableAuthorityIds,
    collectNotificationRowsForPhoneDirectory,
    PHONE_REFRESH_DAYS,
};
