// Ticket refresh — nGen helpers (split from former monolithic refresh.ts Phase 1)
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import { persistTicketRowAfterDataChange } from '../../lib/ticketPersist.cjs';
import { getNgenCredentialsForPoll } from '../../lib/pacPollNgenCredentials.cjs';
import { isNgenUnauthorizedError, withNgenAuthRetry as withNgenAuthRetryRaw, fetchEnquirySearch, fetchNotificationResponseHistory, buildSearchCurrentUserEnquiriesBody, postSearchCurrentUserEnquiriesAsync, extractEnquiriesFromSearchResponse, REFERER_NGEN_HISTORY } from '../../lib/ngenClient.cjs';
import { mergeEnquirySearchIntoTicket } from '../../lib/ngenEnquiryMerge.cjs';
import { collectNotificationRowsForPhoneDirectory, enquiryNotificationRowsHaveResolvableAuthorityIds, upsertStationOperatorPhonesFromNotifications } from '../../lib/ngenNotificationsMerge.cjs';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { resolveOrganizationIdForEnquirySearch } from '../../lib/pacwebJobOrgResolve.cjs';
import { normalizeNgenNotificationHistory } from '../../lib/ngenHistoryNormalize.cjs';
import {
    tipsByAuthorityFromOperatorResponses,
    selectAuthoritiesNeedingHistoryFetch,
    mergeNgenResponseHistoryUtilities,
} from '../../lib/ngenHistoryTips.cjs';
import { getOperationTimeoutMs } from '../../lib/timeouts.cjs';
import { isOrgUsanListFreshForOrg, markOrgUsanListFreshFromRevisionHunt, releaseTicketDetailRefreshForOrg } from '../../lib/appKv.js';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import { evaluateSkipRevisionFollowForLiteRefresh } from '../../lib/usanRefreshTier.js';
import {
    buildTicketResponseForClient,
    findFullTicketRowForOrg,
    loadTicketNgenNotificationHistoryRows,
    loadTicketNgenHistoryAuthorityTips,
} from '../ticketRowHelpers.js';
import * as pollHelpers from './pollHelpers.js';
import { runPacwebPollCore } from './pollRoutes.js';

/** CJS helper is untyped — keep return as any until ngenClient is typed. */
async function withNgenAuthRetry(...args: any[]): Promise<any> {
    return (withNgenAuthRetryRaw as (...a: any[]) => Promise<any>)(...args);
}

/**
 * Resolve nGen `jobNumber` query from `ticket_pacweb_enrichment`.
 * @param {{ job_number?: unknown }|null|undefined} enr
 * @returns {number|null}
 */
export function resolveJobNumberFromPacwebEnrichmentRow(enr) {
    if (!enr) return null;
    if (enr.job_number != null && Number.isFinite(Number(enr.job_number))) {
        return Number(enr.job_number);
    }
    return null;
}

/** @param {object|null|undefined} row tickets row with job_number / ngen_job_number columns */
export function resolveJobNumberFromTicketDbRow(row) {
    if (!row) return null;
    if (row.job_number != null && String(row.job_number).trim() !== '') {
        const n = Number(String(row.job_number).trim());
        if (Number.isFinite(n)) return n;
    }
    if (row.ngen_job_number != null && String(row.ngen_job_number).trim() !== '') {
        const n = Number(String(row.ngen_job_number).trim());
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Each USAN revision has its own nGen job/enquiry id. Prefer indexed `tickets` columns (list poll / refresh),
 * then hydrated ticket fields, then `ticket_pacweb_enrichment` (may still reference an older revision).
 * @param {import('sqlite3').Database|object} db
 * @param {number} orgId
 * @param {string} storageKey ticket_number or request number hint
 * @param {object|null|undefined} [ticketDataOptional]
 * @returns {Promise<number|null>}
 */
export async function resolveNgenJobNumberForTicket(db, orgId, storageKey, ticketDataOptional = null) {
    const ticketBase = ticketBuilder.normalizeTicketBase(storageKey) || storageKey;
    const row = await findFullTicketRowForOrg(db, orgId, storageKey);
    const fromRow = resolveJobNumberFromTicketDbRow(row);
    if (fromRow != null) return fromRow;
    const fromData = resolveJobNumberFromTicketData(ticketDataOptional);
    if (fromData != null) return fromData;
    const enr = await getRow(
        db,
        `SELECT job_number FROM ticket_pacweb_enrichment WHERE organization_id = ? AND ticket_number = ?`,
        [orgId, ticketBase]
    );
    return resolveJobNumberFromPacwebEnrichmentRow(enr);
}

/**
 * Keep enrichment job id aligned with the current revision after list poll or full nGen merge.
 * @param {import('sqlite3').Database|object} db
 * @param {number} orgId
 * @param {string} ticketBase
 * @param {number|null|undefined} jobNum
 */
export async function upsertPacwebEnrichmentJobNumber(db, orgId, ticketBase, jobNum) {
    if (jobNum == null || !Number.isFinite(Number(jobNum))) return;
    const base = ticketBuilder.normalizeTicketBase(ticketBase) || String(ticketBase || '').trim();
    if (!base) return;
    await runDb(
        db,
        `INSERT INTO ticket_pacweb_enrichment (organization_id, ticket_number, job_number, fetched_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(organization_id, ticket_number) DO UPDATE SET
           job_number = excluded.job_number,
           fetched_at = CURRENT_TIMESTAMP`,
        [orgId, base, Number(jobNum)]
    );
}

/**
 * nGen GetCurrentUserEnquiryAsync query id from a PAC GetEnquiryBySubset row (prefer JobNumber, else EnquiryId).
 * @param {object|null|undefined} pacJobRow
 * @returns {number|null}
 */
export function resolveNgenJobNumberFromPacJobRow(pacJobRow) {
    if (!pacJobRow || typeof pacJobRow !== 'object') return null;
    if (pacJobRow.JobNumber != null && String(pacJobRow.JobNumber).trim() !== '') {
        const n = Number(String(pacJobRow.JobNumber).trim());
        if (Number.isFinite(n)) return n;
    }
    if (pacJobRow.EnquiryId != null && String(pacJobRow.EnquiryId).trim() !== '') {
        const p = parseInt(String(pacJobRow.EnquiryId).trim(), 10);
        if (Number.isFinite(p)) return p;
    }
    return null;
}

/**
 * One nGen EnquirySearch per PAC job row (org routing + import body reuse).
 * @returns {Promise<{ enquiry: object|null, noJobNumber: boolean, fetchFailed: boolean }>}
 */
export async function fetchPacPollEnquirySearch(fetchImpl, svc, jobRow) {
    if (!svc || !svc.user || !svc.pass) {
        return { enquiry: null, noJobNumber: false, fetchFailed: true };
    }
    const jobNum = resolveNgenJobNumberFromPacJobRow(jobRow);
    if (jobNum == null) {
        return { enquiry: null, noJobNumber: true, fetchFailed: false };
    }
    try {
        const { enquiry } = await withNgenAuthRetry(
            fetchImpl,
            svc.user,
            svc.pass,
            jobNum,
            async ({ jar, refererApp }) => {
                const enq = await fetchEnquirySearch(fetchImpl, jar, refererApp, jobNum);
                return { enquiry: enq };
            }
        );
        return { enquiry, noJobNumber: false, fetchFailed: false };
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn('[usan-poll] EnquirySearch failed:', msg);
        return { enquiry: null, noJobNumber: false, fetchFailed: true };
    }
}

/**
 * Find the latest nGen enquiry **revision** that shares `baseRequestNumber`.
 *
 * USAN cancellations (and amendments/renewals) do not mutate the original enquiry — they spawn a
 * NEW enquiry revision with its own `jobNumber` and a bumped request-number suffix (e.g. `-000` -> `-001`,
 * `clonedFromEnquiryId` points back to the original). Refreshing only the stored `jobNumber` therefore
 * never observes the cancellation. This pages the date-window search and picks the highest revision for the base.
 *
 * @param {import('node-fetch')} fetchImpl
 * @param {{ user: string, pass: string }} svc
 * @param {number|string|null|undefined} jobNumForReferer - stored job id (referer only)
 * @param {string} baseRequestNumber
 * @param {string|null|undefined} [lodgedOnHint] - ISO date to anchor the search window start
 * @returns {Promise<{ latest: { jobNumber: number|null, requestNumber: string, revision: number, status: string|null }|null, collectedSearchItems: object[] }>}
 */
export async function findLatestNgenRevisionForBase(fetchImpl, svc, jobNumForReferer, baseRequestNumber, lodgedOnHint) {
    const empty = { latest: null, collectedSearchItems: [] };
    const base = ticketBuilder.normalizeTicketBase(baseRequestNumber) || String(baseRequestNumber || '').trim();
    if (!base || !svc || !svc.user || !svc.pass) return empty;
    const lookbackDays = Math.max(
        1,
        Math.min(3660, parseInt(String(process.env.USAN_REVISION_SEARCH_LOOKBACK_DAYS || '120'), 10) || 120)
    );
    const maxPages = Math.max(1, Math.min(50, parseInt(String(process.env.USAN_REVISION_SEARCH_MAX_PAGES || '10'), 10) || 10));
    let fromMs = Date.now() - lookbackDays * 86400000;
    if (lodgedOnHint != null && String(lodgedOnHint).trim() !== '') {
        const t = Date.parse(String(lodgedOnHint).trim());
        if (Number.isFinite(t)) fromMs = Math.min(fromMs, t - 2 * 86400000);
    }
    const rangeIso = { from: new Date(fromMs).toISOString(), to: new Date(Date.now() + 86400000).toISOString() };
    try {
        const huntResult = await withNgenAuthRetry(fetchImpl, svc.user, svc.pass, jobNumForReferer, async ({ jar }) => {
            const rows = [];
            const collectedByRequestNumber = new Map();
            const pageLength = 100;
            for (let page = 1; page <= maxPages; page++) {
                const body = buildSearchCurrentUserEnquiriesBody(rangeIso, page, pageLength, {});
                const resp = await postSearchCurrentUserEnquiriesAsync(fetchImpl, jar, REFERER_NGEN_HISTORY, body);
                const list = extractEnquiriesFromSearchResponse(resp);
                for (const item of list) {
                    const ed = item && (item.enquiryDetails || item.EnquiryDetails);
                    const rnRaw = ed && (ed.requestNumber ?? ed.RequestNumber);
                    const rn = rnRaw != null ? String(rnRaw).trim() : '';
                    if (rn && !collectedByRequestNumber.has(rn)) {
                        collectedByRequestNumber.set(rn, item);
                    }
                    if (!rn) continue;
                    if ((ticketBuilder.normalizeTicketBase(rn) || rn.split('-')[0]) !== base) continue;
                    const jnRaw = ed.jobNumber ?? ed.JobNumber;
                    const suffix = rn.includes('-') ? parseInt(rn.split('-').pop(), 10) : 0;
                    const stRaw = ed.status ?? ed.Status;
                    rows.push({
                        jobNumber: jnRaw != null && Number.isFinite(Number(jnRaw)) ? Number(jnRaw) : null,
                        requestNumber: rn,
                        revision: Number.isFinite(suffix) ? suffix : 0,
                        status: stRaw != null ? String(stRaw).trim() : null,
                    });
                }
                if (list.length < pageLength) break;
            }
            rows.sort((a, b) => b.revision - a.revision || (b.jobNumber || 0) - (a.jobNumber || 0));
            return {
                latest: rows.length > 0 ? rows[0] : null,
                collectedSearchItems: Array.from(collectedByRequestNumber.values()),
            };
        });
        if (!huntResult || typeof huntResult !== 'object') return empty;
        return {
            latest: huntResult.latest || null,
            collectedSearchItems: Array.isArray(huntResult.collectedSearchItems) ? huntResult.collectedSearchItems : [],
        };
    } catch (e) {
        console.warn('[ticketRefresh] findLatestNgenRevisionForBase failed:', e && e.message ? e.message : e);
        return empty;
    }
}

/**
 * Resolve the nGen API query param `jobNumber` from a hydrated ticket object.
 * @param {object|null|undefined} td
 * @returns {number|null}
 */
export function resolveJobNumberFromTicketData(td) {
    if (!td || td.ngenJobNumber == null) return null;
    const n = Number(String(td.ngenJobNumber).trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Tier B: skip revision hunt when org list sync is fresh (cooperative lock window).
 * @returns {Promise<{ skip: boolean, reason: string|null }>}
 */
export async function canSkipRevisionFollowForLiteRefresh(
    db,
    orgId,
    ticketDataBefore,
    storageKey,
    { isLiteRefresh = true, forceRefresh = false, isDeep = false } = {}
) {
    const orgListFresh = await isOrgUsanListFreshForOrg(db, orgId);
    const jobFromData = resolveJobNumberFromTicketData(ticketDataBefore);
    const jobNum =
        jobFromData != null ? jobFromData : await resolveNgenJobNumberForTicket(db, orgId, storageKey, ticketDataBefore);
    return evaluateSkipRevisionFollowForLiteRefresh({
        isLiteRefresh,
        forceRefresh,
        isDeep,
        orgListFresh,
        hasJobNumber: jobNum != null,
        isSearchStub: !!(ticketDataBefore && ticketDataBefore.ngenSearchStub),
    });
}

/**
 * Phase 2: after ticket refresh responds, merge sibling metadata from hunt pages or run incremental list poll.
 */
export async function runBackgroundOrgSyncAfterTicketRefresh(ctx) {
    const {
        db,
        orgId,
        userId,
        storageKey,
        reqUser,
        revisionFollowRan,
        collectedSearchItems,
    } = ctx;
    const openedBase = ticketBuilder.normalizeTicketBase(storageKey) || String(storageKey || '').split('-')[0];
    const startedAt = Date.now();

    try {
        if (revisionFollowRan && Array.isArray(collectedSearchItems) && collectedSearchItems.length > 0) {
            const out = await pollHelpers.mergeBackgroundSiblingSearchItemsFromHunt(
                db,
                orgId,
                userId,
                openedBase,
                collectedSearchItems
            );
            console.log('[ticketRefresh] background sibling merge from revision hunt', {
                orgId,
                storageKey,
                ...out,
                ms: Date.now() - startedAt,
            });
            return { kind: 'hunt_reuse', ...out };
        }

        if (!revisionFollowRan) {
            const orgListFresh = await isOrgUsanListFreshForOrg(db, orgId);
            if (!orgListFresh) {
                const fakeReq = {
                    user: {
                        id: userId,
                        role: reqUser && reqUser.role ? reqUser.role : 'operator',
                        organizationId: orgId,
                        adminOrganizationIds:
                            reqUser && Array.isArray(reqUser.adminOrganizationIds) ? reqUser.adminOrganizationIds : [],
                    },
                    body: { organizationId: orgId },
                };
                const pollOut = await runPacwebPollCore(fakeReq, { onProgress: null });
                const result = pollOut && pollOut.kind === 'ok' ? pollOut.result : null;
                console.log('[ticketRefresh] background incremental usan-poll after refresh', {
                    orgId,
                    storageKey,
                    skipped: result && result.skipped,
                    reason: result && result.reason,
                    refreshedExistingCount: result && result.refreshedExistingCount,
                    importedCount: result && result.importedCount,
                    ms: Date.now() - startedAt,
                });
                return { kind: 'fallback_poll', poll: result };
            }
        }
    } catch (e) {
        console.warn('[ticketRefresh] background org sync failed (non-fatal):', e && e.message ? e.message : e);
        return { kind: 'error', error: e && e.message ? e.message : String(e) };
    }

    return { kind: 'skipped' };
}

/**
 * Resolve requestNumber used for GetNotificationResponseHistoryAsync.
 * @param {object} td
 * @param {string} rawTicketNumber
 * @param {string} ticketBase
 * @returns {string}
 */
export function resolveNgenHistoryRequestNumber(td, rawTicketNumber, ticketBase) {
    if (td && td.ticketNumberFull && String(td.ticketNumberFull).trim()) {
        return String(td.ticketNumberFull).trim();
    }
    if (rawTicketNumber && String(rawTicketNumber).includes('-')) {
        return String(rawTicketNumber).trim();
    }
    return `${ticketBase}-000`;
}

/**
 * Fetches GetNotificationResponseHistoryAsync per `operatorResponses[].authorityId`
 * (or a subset via `opts.authorityIdsToFetch`).
 * @param {object} td - hydrated ticket object
 * @param {number|null|undefined} jobNum - nGen enquiry id for API calls
 * @param {string} rawTicketNumber - stored ticket number (request number fallback)
 * @param {string} ticketBase - normalized base number
 * @param {object} db
 * @param {number} orgId
 * @param {{ authorityIdsToFetch?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, authorityCount?: number, history?: object }>}
 */
export async function fetchNgenNotificationHistoryForTicket(td, jobNum, rawTicketNumber, ticketBase, db, orgId, opts: any = {}) {
    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) {
        return { ok: false, reason: 'no_credentials' };
    }
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        return { ok: false, reason: 'no_job' };
    }
    const jn = Number(jobNum);
    const authorityIds = new Set();
    const onlyAids = opts && Array.isArray(opts.authorityIdsToFetch) ? opts.authorityIdsToFetch : null;
    if (onlyAids && onlyAids.length > 0) {
        for (const aidRaw of onlyAids) {
            if (aidRaw != null && String(aidRaw).trim() !== '') {
                authorityIds.add(String(aidRaw).trim());
            }
        }
    } else {
        for (const r of td.operatorResponses || []) {
            if (r && r.authorityId != null && String(r.authorityId).trim() !== '') {
                authorityIds.add(String(r.authorityId).trim());
            }
        }
    }
    if (authorityIds.size === 0) {
        return { ok: false, reason: 'no_authorities' };
    }
    const requestNumber = resolveNgenHistoryRequestNumber(td, rawTicketNumber, ticketBase);

    const byAuthority = await withNgenAuthRetry(fetch, svc.user, svc.pass, jn, async ({ jar, refererApp }) => {
        const out = {};
        for (const aidRaw of authorityIds) {
            const aid = String(aidRaw);
            try {
                const hist = await fetchNotificationResponseHistory(fetch, jar, refererApp, requestNumber, aid, jn);
                out[aid] = Array.isArray(hist) ? hist : [];
            } catch (e) {
                if (isNgenUnauthorizedError(e)) throw e;
                out[aid] = { error: e.message || String(e) };
            }
        }
        return out;
    });
    const history = {
        normalized: normalizeNgenNotificationHistory(byAuthority),
        fetchedAt: new Date().toISOString(),
        requestNumber,
    };
    return { ok: true, authorityCount: authorityIds.size, history };
}

/**
 * Smart history load for Ticket History window: skip USAN when enquiry tips are unchanged;
 * otherwise refetch only stale/missing authorityIds.
 *
 * @param {object} td
 * @param {number} jobNum
 * @param {string} rawTicketNumber
 * @param {string} ticketBase
 * @param {object} db
 * @param {number} orgId
 * @param {number|null|undefined} ticketId
 * @param {{ authorityIdsToFetch?: string[] }} [opts]
 * @returns {Promise<object>}
 */
export async function ensureNgenNotificationHistoryForTicket(
    td,
    jobNum,
    rawTicketNumber,
    ticketBase,
    db,
    orgId,
    ticketId,
    opts: any = {}
) {
    const currentTips = tipsByAuthorityFromOperatorResponses(td && td.operatorResponses);
    const requestNumber = resolveNgenHistoryRequestNumber(td, rawTicketNumber, ticketBase);
    const existingHistory =
        ticketId != null ? await loadTicketNgenNotificationHistoryRows(db, ticketId) : null;
    const storedTips = ticketId != null ? await loadTicketNgenHistoryAuthorityTips(db, ticketId) : {};
    const authoritiesWithHistory = new Set(
        ((existingHistory &&
            existingHistory.normalized &&
            Array.isArray(existingHistory.normalized.utilities) &&
            existingHistory.normalized.utilities) ||
            []
        )
            .map((u) => (u && u.authorityId != null ? String(u.authorityId).trim() : ''))
            .filter(Boolean)
    );

    const explicitFetchIds =
        opts && Array.isArray(opts.authorityIdsToFetch) && opts.authorityIdsToFetch.length > 0
            ? opts.authorityIdsToFetch.map((aid: unknown) => String(aid).trim()).filter(Boolean)
            : null;

    let selection;
    if (explicitFetchIds && explicitFetchIds.length > 0) {
        const currentAidSet = new Set(Object.keys(currentTips));
        // Prefer IDs present on the hydrated ticket. When D1 tips are still empty
        // (lite refresh deferred persist), honor explicit client IDs so history can load.
        let fetchAuthorityIds = explicitFetchIds.filter((aid) => currentAidSet.has(aid));
        if (fetchAuthorityIds.length === 0 && currentAidSet.size === 0) {
            fetchAuthorityIds = explicitFetchIds.slice();
        }
        if (fetchAuthorityIds.length === 0) {
            return { ok: false, reason: 'no_authorities' };
        }
        selection = {
            fetchAuthorityIds,
            skippedAuthorityIds: Object.keys(currentTips).filter((aid) => !fetchAuthorityIds.includes(aid)),
            reason: 'explicit_authority_ids',
        };
    } else {
        selection = selectAuthoritiesNeedingHistoryFetch({
            currentTips,
            storedTips,
            authoritiesWithHistory,
            currentRequestNumber: requestNumber,
        });
    }

    if (selection.reason === 'no_authorities') {
        return { ok: false, reason: 'no_authorities' };
    }

    if (selection.fetchAuthorityIds.length === 0) {
        const history = {
            ...(existingHistory && typeof existingHistory === 'object' ? existingHistory : {}),
            normalized:
                existingHistory && existingHistory.normalized
                    ? existingHistory.normalized
                    : { utilities: [] },
            fetchedAt:
                (existingHistory && existingHistory.fetchedAt) || new Date().toISOString(),
            requestNumber: (existingHistory && existingHistory.requestNumber) || requestNumber,
            tipByAuthority: { ...currentTips },
        };
        return {
            ok: true,
            skippedAll: true,
            persistMode: 'none',
            history,
            historyFetch: {
                fetchedAuthorityIds: [],
                skippedAuthorityIds: selection.skippedAuthorityIds,
                reason: 'tips_unchanged',
            },
        };
    }

    const fetchResult = await fetchNgenNotificationHistoryForTicket(
        td,
        jobNum,
        rawTicketNumber,
        ticketBase,
        db,
        orgId,
        { authorityIdsToFetch: selection.fetchAuthorityIds }
    );
    if (!fetchResult.ok) {
        return fetchResult;
    }

    /** @type {Record<string, string>} */
    const fetchedTips: Record<string, string> = {};
    for (const aid of selection.fetchAuthorityIds) {
        if (Object.prototype.hasOwnProperty.call(currentTips, aid)) {
            fetchedTips[aid] = currentTips[aid];
        }
    }
    if (fetchResult.history) {
        (fetchResult.history as any).tipByAuthority = fetchedTips;
    }

    const fetchAllCurrent =
        selection.fetchAuthorityIds.length === Object.keys(currentTips).length &&
        selection.skippedAuthorityIds.length === 0;
    const replaceAll =
        selection.reason === 'request_number_changed' ||
        selection.reason === 'no_stored_tips' ||
        fetchAllCurrent ||
        !existingHistory;

    let history;
    if (replaceAll || !existingHistory) {
        history = {
            ...fetchResult.history,
            tipByAuthority: { ...currentTips },
        };
    } else {
        history = mergeNgenResponseHistoryUtilities(
            existingHistory,
            fetchResult.history,
            selection.fetchAuthorityIds
        );
        history.tipByAuthority = {
            ...((existingHistory && existingHistory.tipByAuthority) || {}),
            ...fetchedTips,
        };
        for (const aid of selection.skippedAuthorityIds) {
            if (Object.prototype.hasOwnProperty.call(currentTips, aid)) {
                history.tipByAuthority[aid] = currentTips[aid];
            }
        }
    }

    return {
        ok: true,
        skippedAll: false,
        persistMode: replaceAll ? 'full' : 'partial',
        history,
        historyFetch: {
            fetchedAuthorityIds: selection.fetchAuthorityIds,
            skippedAuthorityIds: selection.skippedAuthorityIds,
            reason: selection.reason || 'partial',
        },
    };
}

export async function mergeNgenNotificationHistoryIntoTicketData(td, jobNum, rawTicketNumber, ticketBase, db, orgId) {
    const result = await fetchNgenNotificationHistoryForTicket(td, jobNum, rawTicketNumber, ticketBase, db, orgId);
    if (result.ok) {
        const tips = tipsByAuthorityFromOperatorResponses(td && td.operatorResponses);
        td.ngenResponseHistory = {
            ...result.history,
            tipByAuthority: tips,
        };
        result.history = td.ngenResponseHistory;
    }
    return result;
}

/**
 * When we can resolve nGen `jobNumber` (indexed `tickets.job_number` / `ngen_job_number` first, then `ticket_pacweb_enrichment`), pull EnquirySearch from nGen API (GetAccessToken + GetCurrentUserEnquiryAsync).
 * After a successful merge, persists unless `opts.deferPersist` (lite early-return path).
 * Notification history is **not** fetched here — use POST `/tickets/:tn/ngen-notification-history` when the Ticket History window opens.
 * Uses {@link getNgenCredentialsForPoll} (org master first; global env only in dev/test `APP_ENV`).
 * @returns {Promise<{ ok: boolean, merged?: object, row?: object, prev?: object, jobNum?: number, enquiry?: object, ticketBase?: string }>}
 */
export async function runNgenEnquiryRefreshIfConfigured(db, orgId, userId, storageKey, opts: any = {}) {
    const includeSearchFallback = opts.includeSearchFallback !== false;
    const includeRevisionFollow = opts.includeRevisionFollow !== false;
    // History is opt-in only (Ticket History window); refresh never loads it by default.
    const includeHistory = opts.includeHistory === true;
    const deferPersist = opts.deferPersist === true;
    const timings = opts.timings && typeof opts.timings === 'object' ? opts.timings : null;
    const markTiming = (key, startedAt) => {
        if (timings) timings[key] = (timings[key] || 0) + (Date.now() - startedAt);
        return Date.now();
    };
    const ticketBase = ticketBuilder.normalizeTicketBase(storageKey) || storageKey;
    let phaseStartedAt = Date.now();
    let jobNum = await resolveNgenJobNumberForTicket(db, orgId, storageKey);
    phaseStartedAt = markTiming('resolveJobNumberMs', phaseStartedAt);
    if (jobNum == null) {
        console.log('[ticketRefresh] runNgenEnquiryRefreshIfConfigured skip: no job_number / tickets.job_number', {
            orgId,
            ticketBase,
        });
        return { ok: false };
    }

    const svc = await getNgenCredentialsForPoll(db, orgId);
    phaseStartedAt = markTiming('loadCredentialsMs', phaseStartedAt);
    if (!svc || !svc.user || !svc.pass) {
        console.log('[ticketRefresh] runNgenEnquiryRefreshIfConfigured skip: no nGen poll credentials for org', { orgId });
        return { ok: false };
    }

    let enquiry;
    try {
        enquiry = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobNum, async ({ jar, refererApp }) =>
            fetchEnquirySearch(fetch, jar, refererApp, jobNum)
        );
        phaseStartedAt = markTiming('getCurrentUserEnquiryMs', phaseStartedAt);
    } catch (e) {
        console.warn('[ticketRefresh] nGen GetCurrentUserEnquiryAsync failed (continuing):', e.message || e);
        return { ok: false };
    }

    function enquiryHasNotificationsPayload(e) {
        if (!e || typeof e !== 'object') return false;
        if (Array.isArray(e.notifications) && e.notifications.length > 0) return true;
        if (Array.isArray(e.Notifications) && e.Notifications.length > 0) return true;
        return false;
    }

    let searchFallbackItem = null;
    async function fetchSearchFallbackItem() {
        if (searchFallbackItem !== null) return searchFallbackItem;
        searchFallbackItem = false;
        try {
            const statusLookbackDays = Math.max(
                1,
                Math.min(3660, parseInt(String(process.env.USAN_STATUS_SEARCH_LOOKBACK_DAYS || '3660'), 10) || 3660)
            );
            const rangeIso = {
                from: new Date(Date.now() - statusLookbackDays * 86400000).toISOString(),
                to: new Date().toISOString(),
            };
            const body = buildSearchCurrentUserEnquiriesBody(rangeIso, 1, 100, { jobNumber: jobNum });
            const searchData = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobNum, async ({ jar }) =>
                postSearchCurrentUserEnquiriesAsync(fetch, jar, REFERER_NGEN_HISTORY, body)
            );
            const enquiries = extractEnquiriesFromSearchResponse(searchData);
            for (const item of enquiries) {
                const edItem = item && (item.enquiryDetails || item.EnquiryDetails);
                const jnItem = edItem && (edItem.jobNumber ?? edItem.JobNumber);
                if (jnItem == null || Number(jnItem) !== Number(jobNum)) continue;
                searchFallbackItem = item;
                return item;
            }
        } catch (fbErr) {
            console.warn('[ticketRefresh] Search jobNumber fallback failed:', fbErr.message || fbErr);
        }
        return null;
    }

    // USAN cancellations/amendments spawn a new enquiry revision (new jobNumber, bumped `-NNN` suffix) rather than
    // mutating the stored one — so re-querying the stored jobNumber alone reports a stale (e.g. "New") status forever.
    // Follow the base request number to the latest revision and adopt its detail (which carries the real "Cancelled").
    if (includeRevisionFollow && jobNum != null) {
        try {
            const currentEd = enquiry && (enquiry.enquiryDetails || enquiry.EnquiryDetails);
            const currentRnRaw = currentEd && (currentEd.requestNumber ?? currentEd.RequestNumber);
            const baseRn = ticketBuilder.normalizeTicketBase(currentRnRaw || storageKey) || ticketBase;
            const lodgedOnHint = currentEd && (currentEd.lodgedOn ?? currentEd.LodgedOn);
            const revStartedAt = Date.now();
            const huntResult = await findLatestNgenRevisionForBase(fetch, svc, jobNum, baseRn, lodgedOnHint);
            if (opts.refreshArtifacts && typeof opts.refreshArtifacts === 'object') {
                opts.refreshArtifacts.revisionFollowRan = true;
                opts.refreshArtifacts.collectedSearchItems = Array.isArray(huntResult.collectedSearchItems)
                    ? huntResult.collectedSearchItems
                    : [];
            }
            markTiming('revisionFollowSearchMs', revStartedAt);
            const latest = huntResult && huntResult.latest ? huntResult.latest : null;
            if (latest && latest.jobNumber != null && Number(latest.jobNumber) !== Number(jobNum)) {
                console.log('[ticketRefresh] newer nGen revision found; following revision chain', {
                    orgId,
                    storageKey,
                    baseRn,
                    fromJob: jobNum,
                    toJob: latest.jobNumber,
                    fromRevision: currentRnRaw != null ? String(currentRnRaw).trim() : null,
                    toRevision: latest.requestNumber,
                    toStatus: latest.status,
                });
                try {
                    const latestEnquiry = await withNgenAuthRetry(fetch, svc.user, svc.pass, latest.jobNumber, async ({ jar, refererApp }) =>
                        fetchEnquirySearch(fetch, jar, refererApp, latest.jobNumber)
                    );
                    if (latestEnquiry && (latestEnquiry.enquiryDetails || latestEnquiry.EnquiryDetails)) {
                        enquiry = latestEnquiry;
                        jobNum = Number(latest.jobNumber);
                        searchFallbackItem = null;
                    }
                } catch (followErr) {
                    console.warn('[ticketRefresh] follow-revision detail fetch failed (keeping stored revision):', followErr.message || followErr);
                }
            }
        } catch (revErr) {
            console.warn('[ticketRefresh] revision-chain follow failed (continuing):', revErr.message || revErr);
        }
    }

    const needsSearchNotificationFallback =
        jobNum != null &&
        (!enquiryHasNotificationsPayload(enquiry) || !enquiryNotificationRowsHaveResolvableAuthorityIds(enquiry));

    if (needsSearchNotificationFallback && includeSearchFallback) {
        console.log(
            '[ticketRefresh] GetCurrentUserEnquiryAsync missing notifications or resolvable authority ids; trying SearchCurrentUserEnquiries with jobNumber',
            {
                orgId,
                storageKey,
                jobNum,
            }
        );
        try {
            const item = await fetchSearchFallbackItem();
            const enquiries = item ? [item] : [];
            for (const item of enquiries) {
                const edItem = item && (item.enquiryDetails || item.EnquiryDetails);
                const jnItem = edItem && (edItem.jobNumber ?? edItem.JobNumber);
                if (jnItem == null || Number(jnItem) !== Number(jobNum)) continue;
                const notifs = item.notifications ?? item.Notifications;
                if (Array.isArray(notifs) && notifs.length > 0) {
                    if (!enquiryNotificationRowsHaveResolvableAuthorityIds({ notifications: notifs })) {
                        console.log('[ticketRefresh] Search row notifications had no resolvable authority ids', {
                            jobNum,
                            count: notifs.length,
                        });
                        continue;
                    }
                    enquiry = { ...enquiry, notifications: notifs };
                    console.log('[ticketRefresh] merged notifications from Search row', { jobNum, count: notifs.length });
                    break;
                }
            }
            phaseStartedAt = markTiming('searchNotificationFallbackMs', phaseStartedAt);
        } catch (fbErr) {
            console.warn('[ticketRefresh] Search jobNumber notification fallback failed:', fbErr.message || fbErr);
        }
    } else if (needsSearchNotificationFallback && !includeSearchFallback) {
        console.log('[ticketRefresh] lite refresh skipped SearchCurrentUserEnquiries notification fallback', {
            orgId,
            storageKey,
            jobNum,
        });
    }

    const row = await findFullTicketRowForOrg(db, orgId, storageKey);
    phaseStartedAt = markTiming('readTicketRowMs', phaseStartedAt);
    if (!row) {
        return { ok: false };
    }
    let prev: any = {};
    try {
        prev = await buildTicketResponseForClient(db, orgId, row);
    } catch (_) {
        prev = {};
    }
    phaseStartedAt = markTiming('buildPreviousTicketMs', phaseStartedAt);

    let merged = mergeEnquirySearchIntoTicket(prev, enquiry);

    const pacAccounts = await allRows(
        db,
        `SELECT organization_id, pacweb_username FROM organization_pacweb_accounts
         WHERE pacweb_username IS NOT NULL AND TRIM(pacweb_username) != ''
         ORDER BY organization_id, id`
    );
    const ngenResolvedOrgId = resolveOrganizationIdForEnquirySearch(pacAccounts, enquiry);
    if (ngenResolvedOrgId != null) {
        merged.ngenResolvedOrganizationId = ngenResolvedOrgId;
    }

    delete merged.assignedToUsers;
    delete merged.assignedToUserId;
    delete merged.assignedToUserName;
    if (prev.source && prev.source !== 'nv_api') {
        merged.source = prev.source;
    }
    if (Array.isArray(prev.webhookRevisionSuffixes) && prev.webhookRevisionSuffixes.length > 0) {
        merged.webhookRevisionSuffixes = [...prev.webhookRevisionSuffixes];
    }

    if (includeHistory) {
        try {
            const historyStartedAt = Date.now();
            const historyJobNum =
                resolveJobNumberFromTicketData(merged) != null ? resolveJobNumberFromTicketData(merged) : jobNum;
            const histRes = await mergeNgenNotificationHistoryIntoTicketData(
                merged,
                historyJobNum,
                storageKey,
                ticketBase,
                db,
                orgId
            );
            markTiming('notificationHistoryMs', historyStartedAt);
            if (histRes.ok) {
                console.log('[ticketRefresh] nGen notification history merged', {
                    orgId,
                    storageKey,
                    authorities: histRes.authorityCount,
                });
            } else if (histRes.reason === 'no_authorities') {
                console.log('[ticketRefresh] nGen notification history skip: no authority ids on operatorResponses', {
                    orgId,
                    storageKey,
                });
            }
        } catch (e) {
            console.warn('[ticketRefresh] nGen notification history failed (continuing):', e.message || e);
        }
    } else {
        merged.ngenResponseHistoryStatus = 'not_loaded';
    }

    if (!deferPersist) {
        try {
            await upsertStationOperatorPhonesFromNotifications(db, collectNotificationRowsForPhoneDirectory(enquiry));
        } catch (e) {
            console.warn('[ticketRefresh] station_operator_phones upsert:', e.message || e);
        }

        const stripped = ticketBuilder.stripDerivedTicketUiFields(merged);
        const persistStartedAt = Date.now();
        await persistTicketRowAfterDataChange(db, {
            ticketId: row.id,
            orgId,
            ticketNumber: row.ticket_number,
            stripped,
            prev,
            next: merged,
            stampFullDetailRefreshedAt: opts.stampFullDetailRefreshedAt || null,
            userId,
        });
        phaseStartedAt = markTiming('persistMergedTicketMs', persistStartedAt);

        const mergedJobNum = resolveJobNumberFromTicketData(merged);
        const persistedJobNum = mergedJobNum != null ? mergedJobNum : jobNum;
        await upsertPacwebEnrichmentJobNumber(db, orgId, ticketBase, persistedJobNum);
    } else if (timings) {
        timings.persistDeferred = true;
    }

    console.log('[ticketRefresh] runNgenEnquiryRefreshIfConfigured merged EnquirySearch', {
        orgId,
        storageKey,
        jobNum,
        deferPersist,
    });
    return { ok: true, merged, row, prev, jobNum, enquiry, ticketBase };
}

/**
 * Persist merged lite refresh side effects (phones, D1 row, enrichment, list cache).
 * Releases the in-flight refresh lease when `releaseLease` is true.
 */
export async function runBackgroundPersistAfterLiteRefresh(ctx) {
    const {
        db,
        orgId,
        userId,
        storageKey,
        merged,
        row,
        prev,
        jobNum,
        enquiry,
        ticketBase,
        stampFullDetailRefreshedAt,
        releaseLease,
        revisionFollowRan,
    } = ctx;
    const startedAt = Date.now();
    try {
        if (enquiry) {
            try {
                await upsertStationOperatorPhonesFromNotifications(db, collectNotificationRowsForPhoneDirectory(enquiry));
            } catch (e) {
                console.warn('[ticketRefresh] background station_operator_phones upsert:', e.message || e);
            }
        }
        if (merged && row) {
            const stripped = ticketBuilder.stripDerivedTicketUiFields(merged);
            await persistTicketRowAfterDataChange(db, {
                ticketId: row.id,
                orgId,
                ticketNumber: row.ticket_number || storageKey,
                stripped,
                prev: prev || {},
                next: merged,
                stampFullDetailRefreshedAt: stampFullDetailRefreshedAt || null,
                userId,
            });
            const mergedJobNum = resolveJobNumberFromTicketData(merged);
            const persistedJobNum = mergedJobNum != null ? mergedJobNum : jobNum;
            const base = ticketBase || ticketBuilder.normalizeTicketBase(storageKey) || storageKey;
            if (persistedJobNum != null) {
                await upsertPacwebEnrichmentJobNumber(db, orgId, base, persistedJobNum);
            }
        }
        if (revisionFollowRan) {
            try {
                await markOrgUsanListFreshFromRevisionHunt(db, orgId);
            } catch (stampErr) {
                console.warn(
                    '[ticketRefresh] background markOrgUsanListFreshFromRevisionHunt:',
                    stampErr && stampErr.message ? stampErr.message : stampErr
                );
            }
        }
        void invalidateOrgActiveTicketListCache(db, orgId);
        console.log('[ticketRefresh] background lite persist complete', {
            orgId,
            storageKey,
            ms: Date.now() - startedAt,
        });
    } catch (e) {
        console.warn(
            '[ticketRefresh] background lite persist failed (UI already got in-memory merge):',
            e && e.message ? e.message : e
        );
    } finally {
        if (releaseLease) {
            try {
                await releaseTicketDetailRefreshForOrg(db, orgId, storageKey);
            } catch (relErr) {
                console.warn('[ticketRefresh] background lease release:', relErr && relErr.message ? relErr.message : relErr);
            }
        }
    }
}

/**
 * Shape in-memory nGen merge for the client without a post-persist D1 rebuild.
 */
export function finalizeMergedTicketForClient(merged, row, refreshCompletedAt) {
    const out = merged && typeof merged === 'object' ? { ...merged } : {};
    if (row) {
        if (out.id == null) out.id = row.id;
        if (out.organizationId == null && row.organization_id != null) {
            out.organizationId = Number(row.organization_id);
        }
        if (out.ticketNumber == null && row.ticket_number != null) {
            out.ticketNumber = row.ticket_number;
        }
    }
    if (refreshCompletedAt) out.ngenFullDetailRefreshedAt = refreshCompletedAt;
    out.hasFullDetail = true;
    out.listSummary = false;
    if (out.ngenResponseHistoryStatus == null) out.ngenResponseHistoryStatus = 'not_loaded';
    delete out.assignedToUsers;
    delete out.assignedToUserId;
    delete out.assignedToUserName;
    return out;
}

/**
 * nGen EnquirySearch with OPERATION_TIMEOUT_MS (default 15s). On timeout or error returns `{ ok: false }`.
 * When `opts.deferPersist`, timeout covers fetch+merge only (persist runs outside via waitUntil).
 * If the timer wins but merge finishes within a short grace window, the successful merge is still returned
 * so lite early-return can schedule persist (avoids dropping a completed merge).
 */
export async function runNgenEnquiryRefreshIfConfiguredWithTimeout(db, orgId, userId, storageKey, opts: any = {}) {
    const ms = getOperationTimeoutMs();
    const workP = runNgenEnquiryRefreshIfConfigured(db, orgId, userId, storageKey, opts);
    let timeoutId = null;
    const timeoutP = new Promise((_, reject) => {
        timeoutId = setTimeout(
            () =>
                reject(
                    Object.assign(new Error(`nGen EnquirySearch timed out after ${ms}ms`), {
                        code: 'NGEN_TIMEOUT',
                    })
                ),
            ms
        );
    });
    try {
        const result = await Promise.race([workP, timeoutP]);
        if (timeoutId != null) clearTimeout(timeoutId);
        return result;
    } catch (e) {
        if (timeoutId != null) clearTimeout(timeoutId);
        console.warn('[ticketRefresh] nGen EnquirySearch failed or timed out:', e.message || e);
        // Grace: if merge already finished (or finishes within 2s), use it — especially for deferPersist.
        const graceMs = opts.deferPersist === true ? 2000 : 0;
        if (graceMs > 0) {
            try {
                const late: any = await Promise.race([
                    workP,
                    new Promise((resolve) => setTimeout(() => resolve(null), graceMs)),
                ]);
                if (late && late.ok) {
                    console.warn(
                        '[ticketRefresh] nGen merge finished after timeout window; using merge for lite early-return'
                    );
                    return late;
                }
            } catch (_) {
                /* ignore */
            }
        }
        return { ok: false, timedOut: e && e.code === 'NGEN_TIMEOUT' };
    }
}
