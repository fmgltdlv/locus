import { getDatabase } from '../../database.js';
import { canMutateOrganization, canUseDevTicketHub, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { getNgenSearchPacificYmdRangeForPoll, pacificYmdRangeToNgenSearchIso, ymdToPacDashboardFormat } from '../../lib/ngenUsanPollDates.cjs';
import { clampDaysBack, getPacRuntimeSettings } from '../../lib/pacRuntimeSettings.cjs';
import { markPacPollManualSucceeded, tryBeginAutomaticUsanListPollForOrg, tryBeginManualUsanListPollForOrg, markUsanListPollSucceededForOrg, markUsanListPollManualSucceededForOrg, markUsanListPollFailedForOrg, setUsanListLastSyncForOrg, getUsanListSearchFingerprintMap, setUsanListSearchFingerprintMap } from '../../lib/appKv.js';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import { getNgenCredentialsForPoll, validateNgenPollCanRun } from '../../lib/pacPollNgenCredentials.cjs';
import { discoverNgenEnquiriesForPoll } from '../../lib/ngenUsanListDiscovery.cjs';
import { fingerprintNgenSearchListItem } from '../../lib/ngenEnquiryMerge.cjs';
import { allRows } from '../../lib/db.cjs';
import * as ticketBuilder from '../../lib/ticketBuilder.cjs';
import { errorResponseBody, logErrorIncident } from '../../lib/appErrors.cjs';
import { findOrganizationIdsForLodgedByUserName } from '../../lib/pacwebJobOrgResolve.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { registerUsanPollRoutes } from '../ticketRouteRegistrars.js';
import { assertNotTechWrite, attachWorkflowAckToSummaryTicket, loadWorkflowAckContextForOrg } from '../ticketRowHelpers.js';
import { computeWorkflowStatusForTicket } from '../computeWorkflowStatus.js';
import { isPublicCatalogOrgId } from '../../lib/publicShareQuery.cjs';
import type { TicketsApp } from './types.js';
import * as pollHelpers from './pollHelpers.js';
/**
 * nGen discovery for list poll: **SearchCurrentUserEnquiriesAsync** (paged), plus **GetCurrentUserProfileAsync** `recentEnquiries`
 * and recent app **create** submit `newEnquiryId` values (GetCurrentUserEnquiryAsync each), then import per row.
 * Rows are keyed by base request number. Public POSR/map is **not** mixed into this poll path (use explicit nv import when enabled).
 * List auth: {@link getNgenCredentialsForPoll} — org **master** `organization_pacweb_accounts` first; global `USAN_SERVICE_*` only when `APP_ENV` is `development`, `dev`, `test`, or `local` and mode is not `per_organization`. Sub-accounts are identity-only.
 *
 * When `organization_pacweb_accounts` is set, imports always **land in the hub org** (poller); if `lodgedByUserName` matches another org, a **duplicate** import runs there. Unmatched `lodgedBy` (with accounts configured) is queued to `pac_unassigned_import_queue` in addition to the hub import.
 *
 * Optional `progressStream: true` in JSON body: response is **SSE** (`text/event-stream`) with `data: {"percent":0-100}` during nGen/import phases, then `data: {"done":true,"result":{...}}`.
 *
 * @param {import('express').Request} req
 * @param {{ onProgress?: (evt: { percent?: number, phase?: string }) => void }} [opts]
 * @returns {Promise<{ kind: 'ok', result: object } | { kind: 'error', status: number, body: object }>}
 */
export async function runPacwebPollCore(req, opts) {
    const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const syncStartedAt = Date.now();
    const timings: Record<string, number> = {};
    const markTiming = (key, startedAt) => {
        timings[key] = Date.now() - startedAt;
        return Date.now();
    };
    const db = getDatabase();
    const userId = req.user.id;
    let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
    if (!orgId) {
        return { kind: 'error', status: 400, body: { error: ORG_REQUIRED_MESSAGE } };
    }
    if (await isPublicCatalogOrgId(db, orgId)) {
        return {
            kind: 'error',
            status: 400,
            body: { error: 'USAN list sync is not available for the public catalog organization.' },
        };
    }
    if (await canUseDevTicketHub(req.user, orgId)) {
        return {
            kind: 'ok',
            result: {
                skipped: true,
                reason: 'documentation_feed_workspace',
                organizationId: orgId,
                fullRange: false,
                incremental: true,
                ngenSearchRows: 0,
                providerSearchRows: 0,
                sourceJobRows: 0,
                uniqueRequestNumbers: 0,
                importedCount: 0,
                refreshedExistingCount: 0,
                skippedListFingerprintUnchanged: 0,
                imported: [],
                refreshedExisting: [],
                existingRefreshErrors: [],
                errors: [],
            },
        };
    }
    // Tech may trigger org list poll (imports/updates tickets org-wide; UI still filters visibility).
    // Explicit POST /import and other ticket writes stay blocked via assertNotTechWrite.
    if (req.user.role !== 'dev' && !canMutateOrganization(req.user, orgId)) {
        return { kind: 'error', status: 403, body: { error: 'You do not have access to that organization' } };
    }

    const emptySkippedPollResult = (reason: string) => ({
        skipped: true,
        reason,
        organizationId: orgId,
        fullRange: false,
        incremental: true,
        ngenSearchRows: 0,
        providerSearchRows: 0,
        sourceJobRows: 0,
        uniqueRequestNumbers: 0,
        importedCount: 0,
        refreshedExistingCount: 0,
        skippedListFingerprintUnchanged: 0,
        imported: [],
        refreshedExisting: [],
        existingRefreshErrors: [],
        errors: [],
    });

    const credErr = await validateNgenPollCanRun(db, orgId);
    if (credErr) {
        const code = String((credErr as { errorCode?: string; code?: string }).errorCode || (credErr as { code?: string }).code || '');
        // Expected for orgs that have not added a USAN master yet — soft-skip, no incident noise.
        if (code === 'NGEN_MASTER_ACCOUNT_MISSING' || code === 'NGEN_POLL_CREDENTIALS_MISSING') {
            return { kind: 'ok', result: emptySkippedPollResult('no_master_account') };
        }
        await logErrorIncident(db, credErr, {
            req,
            route: 'tickets.runPacwebPollCore.validateCredentials',
            organizationId: orgId,
        });
        return { kind: 'error', status: (credErr as { status?: number }).status || 400, body: errorResponseBody(credErr) };
    }
    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) {
        // Validate passed but load failed — treat like missing master for list poll (no incident).
        return { kind: 'ok', result: emptySkippedPollResult('no_master_account') };
    }

    const isMyJobsView = req.body && req.body.isMyJobsView === true;
    const settings = await getPacRuntimeSettings(db);
    const isDevUser = req.user && req.user.role === 'dev';
    const daysBackOverrideRaw =
        req.body && req.body.daysBackOverride != null ? parseInt(String(req.body.daysBackOverride), 10) : null;
    const daysBackOverride =
        daysBackOverrideRaw != null && Number.isFinite(daysBackOverrideRaw)
            ? clampDaysBack(daysBackOverrideRaw, { dev: isDevUser })
            : null;
    const effectiveDaysBack =
        daysBackOverride != null
            ? daysBackOverride
            : clampDaysBack(settings.daysBack, { dev: isDevUser }) ?? settings.daysBack;

    const fullSync = req.body && req.body.fullSync === true;
    const syncMode = req.body && req.body.syncMode != null ? String(req.body.syncMode).trim().toLowerCase() : '';
    const forceRebuild = req.body && req.body.forceRebuild === true;
    const hubWindowRaw = req.body && req.body.hubWindowDaysBack != null ? req.body.hubWindowDaysBack : null;
    const hubWindowDaysBack =
        hubWindowRaw != null && String(hubWindowRaw).trim() !== '' ? parseInt(String(hubWindowRaw), 10) : null;
    const legacyFullRange = req.body && req.body.fullRange === true;

    function isAdminScopeForPac() {
        return (
            req.user.role === 'dev' ||
            req.user.role === 'admin' ||
            (req.user.adminOrganizationIds && req.user.adminOrganizationIds.length > 0)
        );
    }

    if (fullSync || legacyFullRange) {
        if (!isAdminScopeForPac()) {
            return { kind: 'error', status: 403, body: { error: 'Full nGen sync requires admin access.' } };
        }
    }

    let fullRange = false;
    let reservedAutomatic = false;
    let reservedManual = false;

    if (fullSync || legacyFullRange) {
        fullRange = true;
    } else if (hubWindowDaysBack != null && Number.isFinite(hubWindowDaysBack) && hubWindowDaysBack > 0) {
        fullRange = true;
    } else {
        const manualListPoll = req.body && req.body.manual === true;
        const begin = manualListPoll
            ? await tryBeginManualUsanListPollForOrg(db, orgId)
            : await tryBeginAutomaticUsanListPollForOrg(db, orgId);
        if (!begin.ok) {
            return {
                kind: 'ok',
                result: {
                    skipped: true,
                    reason: begin.reason || 'skipped',
                    fullRange: false,
                    incremental: true,
                    ngenSearchRows: 0,
                    providerSearchRows: 0,
                    sourceJobRows: 0,
                    uniqueRequestNumbers: 0,
                    importedCount: 0,
                    refreshedExistingCount: 0,
                    skippedListFingerprintUnchanged: 0,
                    imported: [],
                    refreshedExisting: [],
                    existingRefreshErrors: [],
                    errors: [],
                },
            };
        }
        if (manualListPoll) reservedManual = true;
        else reservedAutomatic = true;
    }

    const ymdR = await getNgenSearchPacificYmdRangeForPoll(db, {
        fullSync: !!(fullSync || legacyFullRange),
        legacyFullRange: !!legacyFullRange,
        hubWindowDaysBack,
        settingsDaysBack: effectiveDaysBack,
        organizationId: orgId,
        maxWindowCalendarDays: 30,
    });
    const fromDate = ymdToPacDashboardFormat(ymdR.fromYmd);
    const toDate = ymdToPacDashboardFormat(ymdR.toYmd);
    const usedFullRangeFallback = ymdR.usedFullRangeFallback;
    const rangeIso = pacificYmdRangeToNgenSearchIso({ fromYmd: ymdR.fromYmd, toYmd: ymdR.toYmd });
    const pageLength = Math.min(100, Math.max(1, parseInt(String(process.env.NGEN_SEARCH_PAGE_LENGTH || '100'), 10) || 100));
    const maxSearchPagesDefault = Math.min(
        100,
        Math.max(1, parseInt(String(process.env.NGEN_SEARCH_MAX_PAGES || '20'), 10) || 20)
    );
    const maxSearchPages =
        fullRange && effectiveDaysBack > 90
            ? Math.min(100, Math.max(maxSearchPagesDefault, Math.ceil(effectiveDaysBack / 10)))
            : maxSearchPagesDefault;

    const listFpCacheEnabled = process.env.NGEN_USAN_LIST_FP_CACHE !== '0';
    const hubFpMapPromise = listFpCacheEnabled ? getUsanListSearchFingerprintMap(db, orgId) : Promise.resolve({});

    const parallelBatchStart = Date.now();
    const pendingEnquiryIdsPromise = pollHelpers.loadPendingCreateEnquiryIds(db, orgId);
    const pacAccountsPromise = allRows(
        db,
        `SELECT organization_id, pacweb_username FROM organization_pacweb_accounts
         WHERE pacweb_username IS NOT NULL AND TRIM(pacweb_username) != ''
         ORDER BY organization_id, id`
    );
    const discoveredPromise = pendingEnquiryIdsPromise.then((pendingEnquiryIds) =>
        discoverNgenEnquiriesForPoll(fetch, svc, rangeIso, {
            pageLength,
            maxSearchPages,
            pendingEnquiryIds: pendingEnquiryIds as number[],
        })
    );

    let pendingEnquiryIds = [];
    let pacAccounts = [];
    let allEnquiryItems = [];
    let discoveryStats = null;
    let hubFpMapPreload = {};
    try {
        const batch = await Promise.all([
            pendingEnquiryIdsPromise,
            pacAccountsPromise,
            discoveredPromise,
            hubFpMapPromise,
        ]);
        pendingEnquiryIds = batch[0] || [];
        pacAccounts = batch[1] || [];
        allEnquiryItems = (batch[2] && batch[2].items) || [];
        discoveryStats = (batch[2] && batch[2].stats) || null;
        hubFpMapPreload = batch[3] || {};
        timings.parallelBatchMs = Date.now() - parallelBatchStart;
        timings.searchMs =
            discoveryStats && discoveryStats.searchMs != null ? Number(discoveryStats.searchMs) : timings.parallelBatchMs;
        timings.loadAccountsMs = 0;
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[usan-poll] discoverNgenEnquiriesForPoll:', msg);
        if (reservedAutomatic || reservedManual) {
            try {
                await markUsanListPollFailedForOrg(db, orgId);
            } catch (e2) {
                console.warn('[usan-poll] markUsanListPollFailedForOrg:', e2.message || e2);
            }
        }
        return { kind: 'error', status: 502, body: { error: msg } };
    }

    try {
        const hubOrgId = orgId;
        const useHubOrgWhenUnmatched = pacAccounts.length === 0;
        if (useHubOrgWhenUnmatched) {
            console.log(
                '[usan-poll] organization_pacweb_accounts is empty; new imports will use hub organizationId only',
                hubOrgId
            );
        }

        const jobRows = [];
        for (const item of allEnquiryItems) {
            const s = pollHelpers.syntheticPacJobFromNgenSearchItem(item);
            if (s) jobRows.push(s);
        }

        const seenRn = new Set();
        const allUniqueRn = [];
        const requestNumberToJobRow = new Map();
        for (const row of jobRows) {
            const rn = row && row.RequestNumber != null ? String(row.RequestNumber).trim() : '';
            if (!rn || seenRn.has(rn)) continue;
            seenRn.add(rn);
            allUniqueRn.push(rn);
            requestNumberToJobRow.set(rn, row);
        }

        const requestNumberToSearchItem = new Map();
        for (const item of allEnquiryItems) {
            const rowS = pollHelpers.syntheticPacJobFromNgenSearchItem(item);
            if (!rowS) continue;
            const rns = rowS.RequestNumber != null ? String(rowS.RequestNumber).trim() : '';
            if (!rns || requestNumberToSearchItem.has(rns)) continue;
            requestNumberToSearchItem.set(rns, item);
        }

        // USAN cancellations/amendments arrive as a NEW revision of the same base request number (e.g. `-000` -> `-001`).
        // Stored tickets are keyed by base, so importing multiple revisions in one run is "last write wins" — an older
        // sibling (e.g. `-000` "New") could clobber the newer one (e.g. `-001` "Cancelled"). Collapse each base to its
        // highest revision so the latest state (including cancellations) always wins regardless of discovery order.
        const revisionOf = (rn) => {
            const s = String(rn || '');
            const suffix = s.includes('-') ? parseInt(s.split('-').pop(), 10) : 0;
            return Number.isFinite(suffix) ? suffix : 0;
        };
        const latestRnByBase = new Map();
        for (const rn of allUniqueRn) {
            const base = ticketBuilder.normalizeTicketBase(rn) || String(rn).split('-')[0];
            const rev = revisionOf(rn);
            const prev = latestRnByBase.get(base);
            if (!prev || rev > prev.rev) latestRnByBase.set(base, { rn, rev });
        }
        const uniqueRn = [];
        let supersededOlderRevisions = 0;
        for (const rn of allUniqueRn) {
            const base = ticketBuilder.normalizeTicketBase(rn) || String(rn).split('-')[0];
            const keep = latestRnByBase.get(base);
            if (keep && keep.rn === rn) uniqueRn.push(rn);
            else supersededOlderRevisions++;
        }
        if (supersededOlderRevisions > 0) {
            console.log('[usan-poll] collapsed older enquiry revisions to latest per base', {
                orgId,
                allRevisions: allUniqueRn.length,
                latestPerBase: uniqueRn.length,
                supersededOlderRevisions,
            });
        }

        /** Force rebuild recreates D1 rows even when KV fingerprints match prior runs. */
        const fingerprintSkipWritesEnabled = listFpCacheEnabled && !forceRebuild;
        /** @type {Map<number, Record<string, string>>} */
        const orgListFingerprintMaps = new Map();
        if (listFpCacheEnabled && hubFpMapPreload && typeof hubFpMapPreload === 'object') {
            orgListFingerprintMaps.set(Number(orgId), hubFpMapPreload);
        }
        const dirtyListFingerprintOrgIds = new Set();
        /** @type {Map<string, string>} */
        const fingerprintByRequestNumber = new Map();

        async function ensureOrgListFingerprintMapLoaded(oid) {
            if (!listFpCacheEnabled) return;
            const id = Number(oid);
            if (!Number.isFinite(id)) return;
            if (orgListFingerprintMaps.has(id)) return;
            orgListFingerprintMaps.set(id, await getUsanListSearchFingerprintMap(db, id));
        }
        function listWriteSkippedByFingerprint(orgId, rn, fp) {
            if (!listFpCacheEnabled || !fp) return false;
            const id = Number(orgId);
            const m = orgListFingerprintMaps.get(id);
            return Boolean(m && m[rn] === fp);
        }
        async function recordListFingerprintSuccess(orgId, rn, fp) {
            if (!listFpCacheEnabled || !fp) return;
            await ensureOrgListFingerprintMapLoaded(orgId);
            const id = Number(orgId);
            const m = orgListFingerprintMaps.get(id);
            if (!m) return;
            if (m[rn] === fp) return;
            m[rn] = fp;
            dirtyListFingerprintOrgIds.add(id);
        }

        if (listFpCacheEnabled && uniqueRn.length > 0) {
            await Promise.all(
                uniqueRn.map(async (rnv) => {
                    const si = requestNumberToSearchItem.get(rnv);
                    if (!si || !si.enquiryDetails) return;
                    try {
                        const fp = await fingerprintNgenSearchListItem(si);
                        fingerprintByRequestNumber.set(rnv, fp);
                    } catch (e) {
                        console.warn('[usan-poll] list fingerprint:', rnv, e && e.message ? e.message : e);
                    }
                })
            );
        }
        let phaseStartedAt = Date.now();
        phaseStartedAt = markTiming('fingerprintMs', phaseStartedAt);

        if (onProgress) {
            onProgress({
                phase: 'search',
                percent: 10,
                ngenSearchRows: allEnquiryItems.length,
                providerSearchRows: allEnquiryItems.length,
                uniqueRequestNumbers: uniqueRn.length,
                syncMode: syncMode || 'list',
                forceRebuild,
            });
        }

        let shortCircuitedFullPoll = false;
        let shortCircuitedImportLoop = false;

        let skippedNoOrgMatch = 0;
        let queuedForManualAssign = 0;
        let skippedNoAccess = 0;
        let skippedExisting = 0;
        let refreshedExistingCount = 0;
        let skippedExistingNoNotifications = 0;
        let skippedNoNgenJobNumber = 0;
        let skippedNgenLookupFailed = 0;
        let skippedListFingerprintUnchanged = 0;
        const refreshedExisting = [];
        const existingRefreshErrors = [];
        const imported = [];
        const errors = [];
        const orgsToInvalidateLeanList = new Set();

        const importDbPhaseStartMs = Date.now();
        let existenceIdx = null;

        const hubMapForShortCircuit = orgListFingerprintMaps.get(Number(hubOrgId)) || {};
        const allHubFpMatch =
            fingerprintSkipWritesEnabled &&
            pendingEnquiryIds.length === 0 &&
            pollHelpers.allHubFingerprintsMatch(uniqueRn, fingerprintByRequestNumber, hubMapForShortCircuit);

        if (allHubFpMatch && pacAccounts.length === 0) {
            shortCircuitedFullPoll = true;
            skippedListFingerprintUnchanged = uniqueRn.length;
            timings.writeMs = Date.now() - importDbPhaseStartMs;
            timings.existencePreloadMs = 0;
        } else {
            existenceIdx = await pollHelpers.preloadUsanPollTicketExistence(db, uniqueRn);
            phaseStartedAt = markTiming('existencePreloadMs', phaseStartedAt);
            if (onProgress) {
                onProgress({
                    phase: 'check',
                    percent: 15,
                    uniqueRequestNumbers: uniqueRn.length,
                    syncMode: syncMode || 'list',
                    forceRebuild,
                });
            }

            let skipImportLoop = false;
            if (allHubFpMatch && pacAccounts.length > 0) {
                const tierB = await pollHelpers.importLoopWouldSkipAllByFingerprint({
                    uniqueRn,
                    fingerprintByRequestNumber,
                    requestNumberToSearchItem,
                    hubOrgId,
                    pacAccounts,
                    existenceIdx,
                    ensureOrgListFingerprintMapLoaded,
                    listWriteSkippedByFingerprint,
                });
                if (tierB.skipAll) {
                    shortCircuitedImportLoop = true;
                    skippedListFingerprintUnchanged = tierB.skipCount;
                    skipImportLoop = true;
                }
            }

            if (!skipImportLoop) {
        const importPermissionByOrg = new Map();
        async function userCanImportTicketToOrgMemo(tid) {
            const id = Number(tid);
            if (!Number.isFinite(id)) return false;
            if (importPermissionByOrg.has(id)) return importPermissionByOrg.get(id);
            // Tech may write only the polled hub org — not secondary lodged-by / existing-ticket orgs.
            const p = pollHelpers.userCanImportTicketToOrg(req, db, id, { allowTechForOrgId: hubOrgId });
            importPermissionByOrg.set(id, p);
            return p;
        }

        const ngenTotal = uniqueRn.length;
        let pollIdx = 0;
        for (const rn of uniqueRn) {
            pollIdx++;
            const searchItem = requestNumberToSearchItem.get(rn);
            if (!searchItem || !searchItem.enquiryDetails) {
                continue;
            }
            const listFp = fingerprintByRequestNumber.get(rn) || null;
            const jobRow = requestNumberToJobRow.get(rn);
            const ed = searchItem.enquiryDetails;
            const pseudoEnquiryForQueue = {
                enquiryDetails: ed,
                notifications: searchItem.notifications != null ? searchItem.notifications : null,
                callerDetails: searchItem.callerDetails ?? searchItem.CallerDetails ?? undefined,
            };

            if (onProgress && ngenTotal > 0) {
                onProgress({
                    phase: 'import',
                    percent: Math.min(90, 10 + Math.round((80 * pollIdx) / ngenTotal)),
                    current: pollIdx,
                    total: ngenTotal,
                    uniqueRequestNumbers: ngenTotal,
                });
            }

            const jn = ed.jobNumber != null ? Number(ed.jobNumber) : NaN;
            const noJobNumber = !Number.isFinite(jn);

            if (noJobNumber) {
                if (pacAccounts.length > 0) {
                    skippedNoNgenJobNumber++;
                }
                if (!(await userCanImportTicketToOrgMemo(hubOrgId))) {
                    skippedNoAccess++;
                    continue;
                }
                if (existenceIdx.ticketStoredForOrg(hubOrgId, rn)) {
                    await ensureOrgListFingerprintMapLoaded(hubOrgId);
                    if (fingerprintSkipWritesEnabled && listWriteSkippedByFingerprint(hubOrgId, rn, listFp)) {
                        skippedListFingerprintUnchanged++;
                        continue;
                    }
                    skippedExisting++;
                    const rr = await pollHelpers.mergePollSearchMetadataIntoExistingTicketRowLean(db, hubOrgId, userId, rn, searchItem);
                    if (rr.ok) {
                        await recordListFingerprintSuccess(hubOrgId, rn, listFp);
                        refreshedExistingCount++;
                        orgsToInvalidateLeanList.add(Number(hubOrgId));
                        refreshedExisting.push({
                            ticketNumber: rr.ticketNumber || rn,
                            organizationId: hubOrgId,
                            operatorResponseCount: 0,
                        });
                    } else {
                        existingRefreshErrors.push({
                            ticketNumber: rn,
                            organizationId: hubOrgId,
                            error: rr.error || rr.reason || 'merge_failed',
                        });
                    }
                    continue;
                }
                await ensureOrgListFingerprintMapLoaded(hubOrgId);
                if (fingerprintSkipWritesEnabled && listWriteSkippedByFingerprint(hubOrgId, rn, listFp)) {
                    skippedListFingerprintUnchanged++;
                    continue;
                }
                const r0 = await pollHelpers.upsertNgenSearchStubTicket(db, hubOrgId, userId, rn, searchItem);
                if (r0.ok) {
                    await recordListFingerprintSuccess(hubOrgId, rn, listFp);
                    orgsToInvalidateLeanList.add(Number(hubOrgId));
                    imported.push(r0.ticket);
                } else errors.push({ ticketNumber: r0.ticketNumber, error: r0.error });
                continue;
            }

            const lodgedName = ed.lodgedByUserName != null ? String(ed.lodgedByUserName) : '';
            const orgIds = findOrganizationIdsForLodgedByUserName(pacAccounts, lodgedName);
            const existingOrgIds = existenceIdx.organizationIdsForRequestNumber(rn);
            if (pacAccounts.length > 0 && orgIds.length === 0 && existingOrgIds.length === 0) {
                skippedNoOrgMatch++;
                if (!existenceIdx.existsInAnyOrganization(rn)) {
                    const inserted = await pollHelpers.insertPacUnassignedQueueRow(db, {
                        requestNumber: rn,
                        jobRow,
                        enquiry: pseudoEnquiryForQueue,
                        userId,
                    });
                    if (inserted) queuedForManualAssign++;
                }
            }

            const toTry = new Set();
            toTry.add(hubOrgId);
            for (const oid of orgIds) {
                if (oid !== hubOrgId) toTry.add(oid);
            }
            for (const oid of existingOrgIds) {
                if (oid !== hubOrgId) toTry.add(oid);
            }
            for (const tid of toTry) {
                if (!(await userCanImportTicketToOrgMemo(tid))) {
                    skippedNoAccess++;
                    continue;
                }
                if (existenceIdx.ticketStoredForOrg(tid, rn)) {
                    await ensureOrgListFingerprintMapLoaded(tid);
                    if (fingerprintSkipWritesEnabled && listWriteSkippedByFingerprint(tid, rn, listFp)) {
                        skippedListFingerprintUnchanged++;
                        continue;
                    }
                    skippedExisting++;
                    const rr = await pollHelpers.mergePollSearchMetadataIntoExistingTicketRowLean(db, tid, userId, rn, searchItem);
                    if (rr.ok) {
                        await recordListFingerprintSuccess(tid, rn, listFp);
                        refreshedExistingCount++;
                        orgsToInvalidateLeanList.add(Number(tid));
                        refreshedExisting.push({
                            ticketNumber: rr.ticketNumber || rn,
                            organizationId: tid,
                            operatorResponseCount: 0,
                        });
                    } else {
                        existingRefreshErrors.push({
                            ticketNumber: rn,
                            organizationId: tid,
                            error: rr.error || rr.reason || 'merge_failed',
                        });
                    }
                    continue;
                }
                await ensureOrgListFingerprintMapLoaded(tid);
                if (fingerprintSkipWritesEnabled && listWriteSkippedByFingerprint(tid, rn, listFp)) {
                    skippedListFingerprintUnchanged++;
                    continue;
                }
                const r = await pollHelpers.upsertNgenSearchStubTicket(db, tid, userId, rn, searchItem);
                if (r.ok) {
                    await recordListFingerprintSuccess(tid, rn, listFp);
                    orgsToInvalidateLeanList.add(Number(tid));
                    imported.push(r.ticket);
                } else errors.push({ ticketNumber: r.ticketNumber, error: r.error });
            }
        }
            }
        }

        const importDbMs = Date.now() - importDbPhaseStartMs;
        timings.writeMs = importDbMs;
        console.log('[usan-poll] import_db_ms', importDbMs, 'uniqueRn', uniqueRn.length);

        const truncatedOverCap = 0;

        if (onProgress) {
            onProgress({ phase: 'done', percent: 100 });
        }

        if (listFpCacheEnabled && dirtyListFingerprintOrgIds.size > 0) {
            const kvStartedAt = Date.now();
            for (const oid of dirtyListFingerprintOrgIds) {
                const m = orgListFingerprintMaps.get(oid);
                if (m) await setUsanListSearchFingerprintMap(db, oid, m);
            }
            markTiming('fingerprintSaveMs', kvStartedAt);
        }
        timings.totalMs = Date.now() - syncStartedAt;
        console.log('[usan-poll] timings', {
            orgId,
            fullSync,
            syncMode: syncMode || 'list',
            forceRebuild,
            uniqueRn: uniqueRn.length,
            ngenSearchRows: allEnquiryItems.length,
            importedCount: imported.length,
            refreshedExistingCount,
            skippedListFingerprintUnchanged,
            skippedExisting,
            shortCircuitedFullPoll,
            shortCircuitedImportLoop,
            ...timings,
        });

        if (reservedManual) {
            await markUsanListPollManualSucceededForOrg(db, orgId);
        } else if (reservedAutomatic) {
            await markUsanListPollSucceededForOrg(db, orgId);
        } else if (fullRange) {
            await markPacPollManualSucceeded(db);
            await setUsanListLastSyncForOrg(db, orgId);
        }

        if (fullRange) {
            orgsToInvalidateLeanList.add(Number(orgId));
        }
        // Await clears so the poll response is not followed by a stale lean-list cache hit.
        await Promise.all(
            [...orgsToInvalidateLeanList].map((oid) => invalidateOrgActiveTicketListCache(db, oid))
        );

        return {
            kind: 'ok',
            result: {
                skipped: false,
                listSource: 'ngen_search',
                fullRange: fullRange ? true : false,
                incremental: !fullRange,
                usedFullRangeFallback,
                ngenSearchRows: discoveryStats ? discoveryStats.searchRows : allEnquiryItems.length,
                providerSearchRows: discoveryStats ? discoveryStats.searchRows : allEnquiryItems.length,
                sourceJobRows: discoveryStats ? discoveryStats.searchRows : allEnquiryItems.length,
                discovery: discoveryStats,
                uniqueRequestNumbers: uniqueRn.length,
                importedCount: imported.length,
                skippedExisting,
                refreshedExistingCount,
                skippedExistingNoNotifications,
                skippedNoOrgMatch,
                queuedForManualAssign,
                skippedNoAccess,
                skippedNoNgenJobNumber,
                skippedListFingerprintUnchanged,
                skippedNoProviderJobNumber: skippedNoNgenJobNumber,
                skippedNgenLookupFailed,
                skippedProviderLookupFailed: skippedNgenLookupFailed,
                truncatedPending: truncatedOverCap,
                usedHubOrgBecauseNoPacAccounts: useHubOrgWhenUnmatched,
                usedHubOrgBecauseNoSourceAccounts: useHubOrgWhenUnmatched,
                importDbMs,
                isMyJobsView: isMyJobsView ? true : false,
                fromDate,
                toDate,
                imported,
                refreshedExisting,
                existingRefreshErrors,
                errors,
                syncMode: syncMode || 'list',
                forceRebuild,
                shortCircuitedFullPoll,
                shortCircuitedImportLoop,
                timings,
            },
        };
    } catch (handlerErr) {
        console.error('[usan-poll] handler:', handlerErr);
        if (reservedAutomatic || reservedManual) {
            try {
                await markUsanListPollFailedForOrg(db, orgId);
            } catch (e2) {
                console.warn('[usan-poll] markUsanListPollFailedForOrg:', e2.message || e2);
            }
        }
        const msg = handlerErr && handlerErr.message ? handlerErr.message : String(handlerErr);
        return { kind: 'error', status: 500, body: { error: msg } };
    }
}

/**
 * nGen list poll + import: SearchCurrentUserEnquiries (paged), then EnquirySearch / import. Legacy path: POST /pacweb-poll
 */
export const postUsanPoll = async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    const progressStream = req.body && req.body.progressStream === true;
    const sendProgress =
        progressStream &&
        ((evt) => {
            try {
                res.write(`data: ${JSON.stringify(evt)}\n\n`);
            } catch (writeErr) {
                console.warn('[usan-poll] SSE write:', writeErr.message || writeErr);
            }
        });

    if (progressStream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        // Return the Response immediately so the browser can consume progress events as they arrive.
        void (async () => {
            try {
                const out = await runPacwebPollCore(req, { onProgress: sendProgress });
                if (out.kind === 'error') {
                    try {
                        await res.write(`data: ${JSON.stringify({ error: out.body.error || 'Request failed' })}\n\n`);
                    } catch (_) {
                        /* ignore */
                    }
                    res.end();
                    return;
                }
                try {
                    await res.write(`data: ${JSON.stringify({ done: true, result: out.result })}\n\n`);
                } catch (_) {
                    /* ignore */
                }
                res.end();
            } catch (streamErr) {
                const msg = streamErr && streamErr.message ? streamErr.message : String(streamErr);
                try {
                    await res.write(`data: ${JSON.stringify({ error: msg || 'Stream failed' })}\n\n`);
                } catch (_) {
                    /* ignore */
                }
                res.end();
            }
        })();
        return res.getResponse();
    }

    const out = await runPacwebPollCore(req, { onProgress: null });
    if (out.kind === 'error') {
        return res.status(Number(out.status)).json(out.body);
    }
    return res.json(out.result);
};

export function registerTicketsPollRoutes(tickets: TicketsApp) {
  tickets.post('/import', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;
      const ticketNumbers = req.body.ticketNumbers || (req.body.ticketNumber != null ? [req.body.ticketNumber] : null);
      if (!ticketNumbers || !Array.isArray(ticketNumbers) || ticketNumbers.length === 0) {
          return res.status(400).json({ error: 'ticketNumbers (array) or ticketNumber is required' });
      }
      const tickets = [];
      const errors = [];
      const workflowCtx = await loadWorkflowAckContextForOrg(db, orgId);
      const ackMap = workflowCtx.ackMap;
      for (const rawNum of ticketNumbers) {
          const ticketNumber = String(rawNum).trim();
          if (!ticketNumber) continue;
          const r = await pollHelpers.importOneTicketFromNvPublicApis(db, orgId, userId, ticketNumber, null, true);
          if (r.ok && r.ticket) {
              try {
                  (r.ticket as Record<string, unknown>).computedWorkflowStatus = computeWorkflowStatusForTicket(
                      r.ticket,
                      ackMap,
                      'owner',
                      { renewalAckWaivers: workflowCtx.renewalAckWaivers, expiringSoonDays: workflowCtx.expiringSoonDays }
                  );
                  (r.ticket as Record<string, unknown>).expiringSoonDays = workflowCtx.expiringSoonDays;
                  attachWorkflowAckToSummaryTicket(r.ticket, ackMap);
              } catch (attachErr: unknown) {
                  // Ticket is already written; do not fail the import response for workflow enrichment.
                  console.error(
                      '[import] workflow status attach failed (ticket kept):',
                      ticketNumber,
                      attachErr instanceof Error ? attachErr.message : String(attachErr)
                  );
              }
              tickets.push(r.ticket);
          } else if (r.ok) {
              tickets.push(r.ticket);
          } else {
              errors.push({ ticketNumber: r.ticketNumber, error: r.error });
          }
      }
      if (tickets.length > 0) {
          void invalidateOrgActiveTicketListCache(db, orgId);
      }
      res.json({ tickets, errors });
  });

  registerUsanPollRoutes(tickets, postUsanPoll);
}
