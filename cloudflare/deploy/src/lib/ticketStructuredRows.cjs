const { runDb } = require('./db.cjs');

function textOrNull(value) {
    if (value == null) return null;
    const s = String(value);
    const trimmed = s.trim();
    if (trimmed === '') return null;
    if (trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return null;
    return trimmed;
}

function numberOrNull(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function uniqueTextArray(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((v) => textOrNull(v)).filter(Boolean))];
}

function revisionFromTicketData(ticketData) {
    const explicit = textOrNull(ticketData && ticketData.ticketRevision);
    if (explicit) return explicit;
    const full = textOrNull(ticketData && ticketData.ticketNumberFull);
    if (!full) return null;
    const m = full.match(/-(\d+)$/);
    return m ? m[1] : null;
}

function baseFromTicketData(ticketData) {
    const own = textOrNull(ticketData && ticketData.ticketNumber);
    if (own) return own;
    const full = textOrNull(ticketData && ticketData.ticketNumberFull);
    if (!full) return null;
    const m = full.match(/^(.+)-\d+$/);
    return m ? m[1] : full;
}

function splitPreviousTicketNumber(previousTicketNumber) {
    const prev = textOrNull(previousTicketNumber);
    if (!prev) return { previousBaseNumber: null, previousRevision: null };
    const m = prev.match(/^(.+)-(\d+)$/);
    if (!m) return { previousBaseNumber: prev, previousRevision: null };
    return { previousBaseNumber: m[1], previousRevision: m[2] };
}

const OPERATOR_RESPONSE_BATCH_ROWS = 6;

async function syncTicketOperatorResponses(db, ticketId, operatorResponses) {
    await runDb(db, `DELETE FROM ticket_operator_responses WHERE ticket_id = ?`, [ticketId]);
    if (!Array.isArray(operatorResponses)) return;

    const rows = [];
    for (let i = 0; i < operatorResponses.length; i += 1) {
        const r = operatorResponses[i];
        if (!r || typeof r !== 'object') continue;
        rows.push({
            params: [
                ticketId,
                i,
                textOrNull(r.id),
                textOrNull(r.stationCode),
                textOrNull(r.operatorName),
                textOrNull(r.operatorCode),
                textOrNull(r.statusCode),
                textOrNull(r.operatorStatus),
                textOrNull(r.respondedAt),
                textOrNull(r.comment),
                textOrNull(r.authorityId),
                textOrNull(r.source),
                textOrNull(r.ticketRevisionSnapshot),
                textOrNull(r.ticketNumberFullSnapshot),
            ],
        });
    }
    if (rows.length === 0) return;

    const insertPrefix = `INSERT INTO ticket_operator_responses
             (ticket_id, response_index, response_id, station_code, operator_name, operator_code,
              status_code, operator_status, responded_at, comment, authority_id, source,
              ticket_revision_snapshot, ticket_number_full_snapshot)
             VALUES `;

    for (let start = 0; start < rows.length; start += OPERATOR_RESPONSE_BATCH_ROWS) {
        const chunk = rows.slice(start, start + OPERATOR_RESPONSE_BATCH_ROWS);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const params = chunk.flatMap((row) => row.params);
        await runDb(db, `${insertPrefix}${placeholders}`, params);
    }
}

async function syncTicketHistoryEvents(db, ticketId, history) {
    await runDb(db, `DELETE FROM ticket_posr_notification_history WHERE ticket_id = ?`, [ticketId]);
    if (!Array.isArray(history)) return;
    for (let i = 0; i < history.length; i += 1) {
        const h = history[i];
        if (!h || typeof h !== 'object') continue;
        await runDb(
            db,
            `INSERT INTO ticket_posr_notification_history
             (ticket_id, event_index, operator_name, operator_code, status_code, responded_at, response_received, comment)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                ticketId,
                i,
                textOrNull(h.operatorName),
                textOrNull(h.operatorCode),
                textOrNull(h.statusCode),
                textOrNull(h.respondedAt),
                textOrNull(h.responseReceived),
                textOrNull(h.comment),
            ]
        );
    }
}

/**
 * Upsert one row per revision: enquiry/job id + USAN status (NEW/RNEW/REMK/CNCL/…).
 * Used for confirmation PDF retrieval for older revisions; does not store PDF bytes.
 */
async function syncTicketRevisionEnquiries(db, ticketId, ticketData) {
    const revision = revisionFromTicketData(ticketData);
    const jobNumber =
        textOrNull(ticketData && ticketData.ngenJobNumber) ||
        textOrNull(ticketData && ticketData.jobNumber);
    if (!revision || !jobNumber) return;
    const requestNumber =
        textOrNull(ticketData && ticketData.ticketNumberFull) ||
        textOrNull(ticketData && ticketData.requestNumberFull) ||
        (() => {
            const base = baseFromTicketData(ticketData);
            return base ? `${base}-${revision}` : null;
        })();
    const status = textOrNull(ticketData && ticketData.ngenEnquiryStatus);
    await runDb(
        db,
        `INSERT INTO ticket_revision_enquiries
           (ticket_id, revision, job_number, request_number, status, observed_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ticket_id, revision) DO UPDATE SET
           job_number = excluded.job_number,
           request_number = COALESCE(excluded.request_number, ticket_revision_enquiries.request_number),
           status = COALESCE(excluded.status, ticket_revision_enquiries.status),
           observed_at = CURRENT_TIMESTAMP`,
        [ticketId, revision, jobNumber, requestNumber, status]
    );
}

async function syncTicketLineageEvents(db, ticketId, ticketData) {
    const previous = textOrNull(ticketData && ticketData.ngenPreviousRequestNumber);
    if (!previous) return;
    await runDb(
        db,
        `INSERT OR IGNORE INTO ticket_lineage_events (ticket_id, previous_ticket_number)
         VALUES (?, ?)`,
        [ticketId, previous]
    );
}

async function syncTicketImportedOrgs(db, ticketId, ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return;
    const raw = Array.isArray(ticketData.importedByOrgs)
        ? ticketData.importedByOrgs
        : Array.isArray(ticketData.imported_by_orgs)
          ? ticketData.imported_by_orgs
          : null;
    if (!raw) return;
    await runDb(db, `DELETE FROM ticket_imported_orgs WHERE ticket_id = ?`, [ticketId]);
    for (const orgIdText of uniqueTextArray(raw)) {
        const orgId = numberOrNull(orgIdText);
        if (orgId == null) continue;
        await runDb(
            db,
            `INSERT OR IGNORE INTO ticket_imported_orgs (ticket_id, organization_id, source)
             VALUES (?, ?, ?)`,
            [ticketId, orgId, 'ticket_import']
        );
    }
}

function normalizeAssignees(ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return [];
    if (Array.isArray(ticketData.assignedToUsers)) {
        return ticketData.assignedToUsers
            .map((entry) => {
                const userId = numberOrNull(entry && entry.userId);
                if (userId == null) return null;
                return {
                    userId,
                    userName: textOrNull(entry && entry.userName),
                };
            })
            .filter(Boolean);
    }
    const userId = numberOrNull(ticketData.assignedToUserId);
    if (userId == null) return [];
    return [{ userId, userName: textOrNull(ticketData.assignedToUserName) }];
}

function boolToIntOrNull(value) {
    if (value === true || value === 1) return 1;
    if (value === false || value === 0) return 0;
    return null;
}

/**
 * Insert one authority's normalized utility rows (caller deletes first when needed).
 * @param {object} db
 * @param {number} ticketId
 * @param {object} util
 * @param {string|null} fallbackRequestNumber
 * @param {string|null} fetchedAt
 */
async function insertNgenNotificationHistoryUtility(db, ticketId, util, fallbackRequestNumber, fetchedAt) {
    if (!util || typeof util !== 'object') return;
    const authorityId = textOrNull(util.authorityId);
    if (!authorityId) return;
    if (util.error != null) {
        await runDb(
            db,
            `INSERT OR IGNORE INTO ticket_ngen_notification_history
             (ticket_id, authority_id, entry_index, error, request_number, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [ticketId, authorityId, -1, textOrNull(util.error), fallbackRequestNumber, fetchedAt]
        );
        return;
    }
    const entries = Array.isArray(util.entries) ? util.entries : [];
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') continue;
        await runDb(
            db,
            `INSERT OR IGNORE INTO ticket_ngen_notification_history
             (ticket_id, authority_id, entry_index, responded_at, status_code, code_description,
              notes_comment, request_number, updated_by, is_disputed, dispute_locate_code, enquiry_id, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                ticketId,
                authorityId,
                // Always use loop position: API duplicate `index` values caused INSERT OR IGNORE to drop rows (UNIQUE ticket_id, authority_id, entry_index).
                i,
                textOrNull(entry.at),
                textOrNull(entry.code),
                textOrNull(entry.codeDescription),
                textOrNull(entry.notesComment),
                textOrNull(entry.requestNumber) || fallbackRequestNumber,
                textOrNull(entry.updatedBy),
                boolToIntOrNull(entry.isDisputed),
                textOrNull(entry.disputeLocateCode),
                textOrNull(entry.enquiryId),
                fetchedAt,
            ]
        );
    }
}

async function syncTicketNgenNotificationHistory(db, ticketId, ticketData) {
    const history = ticketData && typeof ticketData === 'object' ? ticketData.ngenResponseHistory : null;
    if (!history || typeof history !== 'object') return;
    const utilities =
        history.normalized && Array.isArray(history.normalized.utilities) ? history.normalized.utilities : [];
    await runDb(db, `DELETE FROM ticket_ngen_notification_history WHERE ticket_id = ?`, [ticketId]);
    const fallbackRequestNumber = textOrNull(history.requestNumber);
    const fetchedAt = textOrNull(history.fetchedAt);
    for (const util of utilities) {
        await insertNgenNotificationHistoryUtility(db, ticketId, util, fallbackRequestNumber, fetchedAt);
    }
}

/**
 * Replace history rows only for the given authority ids (partial USAN refetch).
 * @param {object} db
 * @param {number} ticketId
 * @param {object} ticketData — must include ngenResponseHistory with utilities for those aids
 * @param {string[]} authorityIds
 */
async function syncTicketNgenNotificationHistoryForAuthorities(db, ticketId, ticketData, authorityIds) {
    const history = ticketData && typeof ticketData === 'object' ? ticketData.ngenResponseHistory : null;
    if (!history || typeof history !== 'object') return;
    const aids = [...new Set((authorityIds || []).map((a) => textOrNull(a)).filter(Boolean))];
    if (aids.length === 0) return;
    const placeholders = aids.map(() => '?').join(', ');
    await runDb(
        db,
        `DELETE FROM ticket_ngen_notification_history WHERE ticket_id = ? AND authority_id IN (${placeholders})`,
        [ticketId, ...aids]
    );
    const fallbackRequestNumber = textOrNull(history.requestNumber);
    const fetchedAt = textOrNull(history.fetchedAt);
    const aidSet = new Set(aids);
    const utilities =
        history.normalized && Array.isArray(history.normalized.utilities) ? history.normalized.utilities : [];
    for (const util of utilities) {
        const authorityId = util && textOrNull(util.authorityId);
        if (!authorityId || !aidSet.has(authorityId)) continue;
        await insertNgenNotificationHistoryUtility(db, ticketId, util, fallbackRequestNumber, fetchedAt);
    }
}

/**
 * Upsert enquiry tip fingerprints used to skip unchanged GetNotificationResponseHistoryAsync calls.
 * @param {object} db
 * @param {number} ticketId
 * @param {Record<string, string>|null|undefined} tipByAuthority
 * @param {string|null|undefined} requestNumber
 * @param {string|null|undefined} fetchedAt
 * @param {{ replaceAll?: boolean, authorityIds?: string[] }} [opts]
 */
async function syncTicketNgenHistoryAuthorityTips(db, ticketId, tipByAuthority, requestNumber, fetchedAt, opts) {
    const id = numberOrNull(ticketId);
    if (id == null) return;
    const tips = tipByAuthority && typeof tipByAuthority === 'object' ? tipByAuthority : {};
    const replaceAll = opts && opts.replaceAll === true;
    const onlyAids = opts && Array.isArray(opts.authorityIds)
        ? new Set(opts.authorityIds.map((a) => textOrNull(a)).filter(Boolean))
        : null;
    if (replaceAll) {
        await runDb(db, `DELETE FROM ticket_ngen_history_authority_tips WHERE ticket_id = ?`, [id]);
    }
    const rn = textOrNull(requestNumber);
    const fa = textOrNull(fetchedAt);
    for (const [aidRaw, fpRaw] of Object.entries(tips)) {
        const authorityId = textOrNull(aidRaw);
        const tipFingerprint = textOrNull(fpRaw);
        if (!authorityId || tipFingerprint == null) continue;
        if (onlyAids && !onlyAids.has(authorityId)) continue;
        if (!replaceAll) {
            await runDb(
                db,
                `DELETE FROM ticket_ngen_history_authority_tips WHERE ticket_id = ? AND authority_id = ?`,
                [id, authorityId]
            );
        }
        await runDb(
            db,
            `INSERT INTO ticket_ngen_history_authority_tips
             (ticket_id, authority_id, tip_fingerprint, request_number, fetched_at)
             VALUES (?, ?, ?, ?, ?)`,
            [id, authorityId, tipFingerprint, rn, fa]
        );
    }
}

async function syncTicketAssignees(_db, _ticketId, _ticketData) {
    // ticket_assignees table dropped — project assignees are managed separately.
}

async function syncTicketStructuredRows(db, ticketId, ticketData) {
    const id = numberOrNull(ticketId);
    if (id == null || !ticketData || typeof ticketData !== 'object') return;
    await syncTicketOperatorResponses(db, id, ticketData.operatorResponses);
    await syncTicketHistoryEvents(db, id, ticketData.history);
    await syncTicketRevisionEnquiries(db, id, ticketData);
    await syncTicketLineageEvents(db, id, ticketData);
    await syncTicketImportedOrgs(db, id, ticketData);
    await syncTicketNgenNotificationHistory(db, id, ticketData);
    const history = ticketData.ngenResponseHistory;
    if (history && typeof history === 'object' && history.tipByAuthority) {
        await syncTicketNgenHistoryAuthorityTips(
            db,
            id,
            history.tipByAuthority,
            history.requestNumber,
            history.fetchedAt,
            { replaceAll: true }
        );
    }
}

function pollMergeStructuredSnapshot(ticketData) {
    if (!ticketData || typeof ticketData !== 'object') return '';
    try {
        return JSON.stringify({
            operatorResponses: ticketData.operatorResponses,
            history: ticketData.history,
            ngenResponseHistory: ticketData.ngenResponseHistory,
            ngenPreviousRequestNumber: ticketData.ngenPreviousRequestNumber ?? null,
            importedByOrgs: ticketData.importedByOrgs ?? null,
        });
    } catch (_) {
        return '';
    }
}

/**
 * After list-poll scalar merge: skip DELETE-heavy child-table sync when structured payloads are unchanged.
 * Always applies revision-enquiry upsert so enquiry revisions are recorded.
 */
async function syncTicketStructuredRowsAfterPollMerge(db, ticketId, ticketBeforeMerge, ticketAfterMerge, strippedTicketData) {
    const id = numberOrNull(ticketId);
    if (id == null || !strippedTicketData || typeof strippedTicketData !== 'object') return;
    if (pollMergeStructuredSnapshot(ticketBeforeMerge) === pollMergeStructuredSnapshot(ticketAfterMerge)) {
        await syncTicketRevisionEnquiries(db, id, strippedTicketData);
    } else {
        await syncTicketStructuredRows(db, id, strippedTicketData);
    }
}

module.exports = {
    syncTicketStructuredRows,
    syncTicketStructuredRowsAfterPollMerge,
    syncTicketNgenNotificationHistory,
    syncTicketNgenNotificationHistoryForAuthorities,
    syncTicketNgenHistoryAuthorityTips,
    syncTicketRevisionEnquiries,
    pollMergeStructuredSnapshot,
    splitPreviousTicketNumber,
    normalizeAssignees,
};
