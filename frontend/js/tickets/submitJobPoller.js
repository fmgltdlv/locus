/**
 * Poll background submit jobs and trigger post-submit USAN sync.
 */
(function (global) {
    'use strict';

    const OWN_POLL_MS_ACTIVE = 5_000;
    const ORG_POLL_MS = 300_000; // 5 minutes
    const FAILED_POLL_MS = 300_000; // 5 minutes
    const JOB_STALE_MS = 90_000;
    const RESUME_COOLDOWN_MS = 60_000;
    const SESSION_KEY = 'locusSubmitJobIds';
    const POST_SYNC_DEBOUNCE_MS = 60_000;
    const POST_SUBMIT_DELAY_MS = 10_000;
    const FOLLOWUP_SYNC_MS = 20_000;

    let ownJobIds = [];
    let ownPollTimer = null;
    let orgPollTimer = null;
    let failedPollTimer = null;
    let lastOrgActiveCount = 0;
    let lastOrgActiveJobs = [];
    let lastPostSyncAt = 0;
    let followupSyncTimer = null;
    let postSubmitDelayTimer = null;
    let postSubmitSyncInFlight = false;
    let postSubmitLoadingDepth = 0;
    const seenOrgJobIds = new Map();
    const resumeAttemptedAt = new Map();

    function getOrgId() {
        if (typeof global.getCurrentOrganizationId === 'function') {
            const id = global.getCurrentOrganizationId();
            if (id != null && id !== '') return Number(id);
        }
        if (global.authModule && global.authModule.getCurrentOrgId) {
            const id = global.authModule.getCurrentOrgId();
            if (id != null) return Number(id);
        }
        const sel = document.getElementById('orgSelector');
        if (sel && sel.value) return Number(sel.value);
        return null;
    }

    function loadSessionJobs() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            ownJobIds = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        } catch {
            ownJobIds = [];
        }
    }

    function saveSessionJobs() {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(ownJobIds));
        } catch (_) {
            /* ignore */
        }
    }

    function isTerminalStatus(st) {
        return st === 'completed' || st === 'partial' || st === 'failed';
    }

    function isActiveStatus(st) {
        return st === 'queued' || st === 'running';
    }

    /** Job row can stay "running" after every ticket already finished. Don't keep the spinner on for that. */
    function itemsLookSettled(job) {
        const items = job && job.items;
        if (!Array.isArray(items) || !items.length) return false;
        return items.every(function (it) {
            const st = it && it.status;
            return st !== 'pending' && st !== 'running';
        });
    }

    /** Stuck rows closed hours later should not toast or start another list sync. */
    function jobCreatedRecently(job) {
        const created = job && job.createdAt ? Date.parse(job.createdAt) : NaN;
        if (!Number.isFinite(created)) return true;
        return Date.now() - created < 6 * 60 * 60 * 1000;
    }

    function operationToastLabel(op) {
        if (op === 'create') return 'ticket creation';
        if (op === 'clone_new') return 'new ticket';
        if (op === 'renew') return 'ticket renewal';
        if (op === 'remark') return 'remark';
        if (op === 'amendment') return 'amendment';
        if (op === 'exposed') return 'exposed report';
        if (op === 'damage') return 'damage report';
        if (op === 'follow_up') return 'follow up';
        if (op === 'disputed') return 'dispute';
        if (op === 'no_response') return 'no response';
        return 'submission';
    }

    function pollResultTouchedTickets(pollResult) {
        return (
            global.ticketsModule &&
            typeof global.ticketsModule.usanPollResultTouchedTickets === 'function' &&
            global.ticketsModule.usanPollResultTouchedTickets(pollResult)
        );
    }

    function setPostSubmitLoadingUi(busy) {
        if (busy) postSubmitLoadingDepth += 1;
        else postSubmitLoadingDepth = Math.max(0, postSubmitLoadingDepth - 1);
        const show = postSubmitLoadingDepth > 0;
        const overlay = document.getElementById('ticketHubLoadingOverlay');
        if (overlay) {
            const textEl = overlay.querySelector('.ticket-hub-loading-text');
            if (textEl) {
                textEl.textContent = show ? 'Loading new tickets…' : 'Updating ticket list…';
            }
        }
        if (typeof global.setTicketHubLoadingOverlay === 'function') {
            global.setTicketHubLoadingOverlay(show);
        } else if (overlay) {
            overlay.style.display = show ? 'flex' : 'none';
            overlay.setAttribute('aria-busy', show ? 'true' : 'false');
        }
        if (global.ticketsModule && typeof global.ticketsModule.setTicketListUsanSyncing === 'function') {
            global.ticketsModule.setTicketListUsanSyncing(show);
        }
    }

    function updateIndicatorFromJobs() {
        /* USAN activity indicator chrome removed. */
    }

    async function fetchJob(jobId) {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return null;
        try {
            const data = await global.authModule.apiRequest('tickets/submit-jobs/' + encodeURIComponent(jobId), {
                method: 'GET',
            });
            return data && data.job ? data.job : null;
        } catch (e) {
            console.warn('[submitJobPoller] fetchJob', jobId, e.message || e);
            return null;
        }
    }

    async function fetchActiveOrgJobs(orgId) {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return [];
        try {
            const data = await global.authModule.apiRequest(
                'tickets/submit-jobs/active?organizationId=' + encodeURIComponent(String(orgId)),
                { method: 'GET' }
            );
            return data && Array.isArray(data.jobs) ? data.jobs : [];
        } catch (e) {
            console.warn('[submitJobPoller] fetchActiveOrgJobs', e.message || e);
            return [];
        }
    }

    async function reloadTicketsAfterPoll(pollResult, opts) {
        const o = opts || {};
        const touched = pollResultTouchedTickets(pollResult);
        const shouldReload =
            touched ||
            (o.forcePostSubmit && !o.forceFollowup && pollResult && pollResult.skipped !== true);
        if (!shouldReload) return;

        const orgId = getOrgId();
        const orgNum = orgId != null ? Number(orgId) : NaN;
        const pinnedImports = Array.isArray(pollResult && pollResult.imported)
            ? pollResult.imported.filter(function (t) {
                  if (!t) return false;
                  if (t.organizationId == null || t.organizationId === '') return true;
                  if (!Number.isFinite(orgNum)) return true;
                  return Number(t.organizationId) === orgNum;
              })
            : [];
        const preserveOpts =
            pinnedImports.length > 0 ? { preserveImportedTickets: pinnedImports } : undefined;

        try {
            // Prefer hub refresh (single load + hub redraw). Passing preserve avoids a stale
            // lean-list GET wiping tickets the poll just imported.
            if (global.ticketHubModule && typeof global.ticketHubModule.refreshFromServer === 'function') {
                await global.ticketHubModule.refreshFromServer(preserveOpts);
            } else if (typeof global.refreshTicketHubFromServer === 'function') {
                await global.refreshTicketHubFromServer(preserveOpts);
            } else if (global.ticketsModule && typeof global.ticketsModule.loadTicketsForCurrentOrg === 'function') {
                await global.ticketsModule.loadTicketsForCurrentOrg({
                    forceRefresh: true,
                    ...(preserveOpts || {}),
                });
                if (typeof global.renderTickets === 'function') global.renderTickets();
                if (typeof global.renderTicketList === 'function') global.renderTicketList();
            }
        } catch (e2) {
            console.warn('[submitJobPoller] reload after sync', e2);
        }
    }

    async function runPostSubmitUsanListSync(opts) {
        const o = opts || {};
        const orgId = o.organizationId != null ? o.organizationId : getOrgId();
        if (orgId == null || !Number.isFinite(Number(orgId))) return;
        if (
            typeof global.isCurrentOrgPublicCatalogViewer === 'function' &&
            global.isCurrentOrgPublicCatalogViewer()
        ) {
            return;
        }
        if (postSubmitSyncInFlight && (o.forcePostSubmit || o.forceFollowup)) return;
        const now = Date.now();
        if (now - lastPostSyncAt < POST_SYNC_DEBOUNCE_MS && !o.forceFollowup && !o.forcePostSubmit) return;
        lastPostSyncAt = now;

        const useProminentLoading = o.forcePostSubmit === true;
        if (useProminentLoading) {
            postSubmitSyncInFlight = true;
            setPostSubmitLoadingUi(true);
        } else if (global.ticketsModule && typeof global.ticketsModule.setTicketListUsanSyncing === 'function') {
            global.ticketsModule.setTicketListUsanSyncing(true);
        }

        let pollResult = null;
        try {
            if (global.authModule && typeof global.authModule.apiRequest === 'function') {
                pollResult = await global.authModule.apiRequest('tickets/usan-poll', {
                    method: 'POST',
                    body: JSON.stringify({ organizationId: Number(orgId) }),
                });
            }
        } catch (e) {
            console.warn('[submitJobPoller] post-submit sync', e.message || e);
        } finally {
            if (useProminentLoading) {
                setPostSubmitLoadingUi(false);
                postSubmitSyncInFlight = false;
            } else if (global.ticketsModule && typeof global.ticketsModule.setTicketListUsanSyncing === 'function') {
                global.ticketsModule.setTicketListUsanSyncing(false);
            }
        }

        if (pollResult && pollResult.skipped === true && pollResult.reason === 'poll_in_progress' && o.allowRetry !== false) {
            setTimeout(function () {
                void runPostSubmitUsanListSync({
                    organizationId: orgId,
                    allowRetry: false,
                    forceFollowup: true,
                    forcePostSubmit: o.forcePostSubmit,
                    scheduleFollowup: o.scheduleFollowup,
                    hadSuccess: o.hadSuccess,
                });
            }, 15_000);
            return;
        }

        await reloadTicketsAfterPoll(pollResult, {
            forcePostSubmit: o.forcePostSubmit,
            forceFollowup: o.forceFollowup,
        });

        const imported = pollResult && Number(pollResult.importedCount);
        if (Number.isFinite(imported) && imported > 0 && typeof global.showToast === 'function') {
            global.showToast('Synced ' + imported + ' new ticket(s) from USAN', 'success');
        }

        if (o.scheduleFollowup && o.hadSuccess && !pollResultTouchedTickets(pollResult)) {
            if (followupSyncTimer) clearTimeout(followupSyncTimer);
            followupSyncTimer = setTimeout(function () {
                followupSyncTimer = null;
                void runPostSubmitUsanListSync({
                    organizationId: orgId,
                    forceFollowup: true,
                    allowRetry: false,
                    forcePostSubmit: true,
                });
            }, FOLLOWUP_SYNC_MS);
        }
    }

    function schedulePostSubmitUsanSync(orgId, opts) {
        const o = opts || {};
        if (postSubmitSyncInFlight || postSubmitDelayTimer) return;
        postSubmitDelayTimer = setTimeout(function () {
            postSubmitDelayTimer = null;
            void runPostSubmitUsanListSync({
                organizationId: orgId,
                scheduleFollowup: o.scheduleFollowup,
                hadSuccess: o.hadSuccess,
                forcePostSubmit: true,
            });
        }, POST_SUBMIT_DELAY_MS);
    }

    function failedItemLabels(job) {
        if (!job || !Array.isArray(job.items)) return [];
        return job.items
            .filter(function (it) {
                return it && (it.status === 'failed' || it.status === 'skipped');
            })
            .map(function (it) {
                return it.label || it.ticketNumber || 'Item';
            });
    }

    function formatFailedLabelsSuffix(labels) {
        if (!labels.length) return '';
        const shown = labels.slice(0, 3);
        let text = ' — failed: ' + shown.join(', ');
        if (labels.length > 3) text += ' +' + (labels.length - 3) + ' more';
        return text;
    }

    async function fetchFailedItems() {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return [];
        try {
            const data = await global.authModule.apiRequest('tickets/submit-jobs/failed', { method: 'GET' });
            return data && Array.isArray(data.items) ? data.items : [];
        } catch (e) {
            console.warn('[submitJobPoller] fetchFailedItems', e.message || e);
            return [];
        }
    }

    async function refreshFailedFailures() {
        return fetchFailedItems();
    }

    async function maybeResumeStaleOwnJobs(jobs) {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return;
        const now = Date.now();
        for (let i = 0; i < (jobs || []).length; i++) {
            const job = jobs[i];
            if (!job || (job.status !== 'running' && job.status !== 'queued')) continue;
            const settled = itemsLookSettled(job);
            const rem = job.remaining != null ? job.remaining : Math.max(0, (job.total || 0) - (job.completed || 0));
            // Settled jobs still need a resume so the server can mark them finished.
            // Open jobs only resume when work remains and the row is running.
            if (!settled && (job.status !== 'running' || rem <= 0)) continue;
            const updated = job.updatedAt ? Date.parse(job.updatedAt) : NaN;
            if (!Number.isFinite(updated) || now - updated < JOB_STALE_MS) continue;
            const last = resumeAttemptedAt.get(job.jobId) || 0;
            if (now - last < RESUME_COOLDOWN_MS) continue;
            resumeAttemptedAt.set(job.jobId, now);
            try {
                await global.authModule.apiRequest(
                    'tickets/submit-jobs/' + encodeURIComponent(job.jobId) + '/resume',
                    { method: 'POST' }
                );
            } catch (e) {
                console.warn('[submitJobPoller] resume stale job', job.jobId, e.message || e);
            }
        }
    }

    function startFailedPoll() {
        if (!shouldPoll()) return;
        if (failedPollTimer) return;
        void refreshFailedFailures();
        failedPollTimer = setInterval(function () {
            if (!shouldPoll()) {
                stopFailedPollTimer();
                return;
            }
            void refreshFailedFailures();
        }, FAILED_POLL_MS);
    }

    function stopFailedPollTimer() {
        if (failedPollTimer) {
            clearInterval(failedPollTimer);
            failedPollTimer = null;
        }
    }

    function toastJobComplete(job) {
        if (!job || typeof global.showToast !== 'function') return;
        if (job.dryRun) {
            if (job.status === 'completed') {
                global.showToast('Dry run complete — nothing submitted to USAN', 'success');
            } else if (job.status === 'partial') {
                global.showToast(
                    'Dry run finished: ' +
                        (job.succeeded || 0) +
                        ' simulated OK, ' +
                        (job.failed || 0) +
                        ' simulated fail' +
                        formatFailedLabelsSuffix(failedItemLabels(job)),
                    'error'
                );
            } else {
                global.showToast('Dry run finished with errors', 'error');
            }
            return;
        }
        const label = operationToastLabel(job.operation);
        const failedLabels = formatFailedLabelsSuffix(failedItemLabels(job));
        if (job.status === 'completed') {
            global.showToast('Submitted to USAN — syncing tickets now…', 'success');
        } else if (job.status === 'partial') {
            global.showToast(
                label + ' finished: ' + (job.succeeded || 0) + ' succeeded, ' + (job.failed || 0) + ' failed' + failedLabels,
                'error'
            );
        } else {
            global.showToast(label + ' failed' + failedLabels, 'error');
        }
    }

    async function pollOwnJobs() {
        if (!ownJobIds.length) return;
        const ownJobs = [];
        const finished = [];
        const stillActive = [];
        for (let i = 0; i < ownJobIds.length; i++) {
            const job = await fetchJob(ownJobIds[i]);
            if (!job) {
                stillActive.push(ownJobIds[i]);
                continue;
            }
            if (isActiveStatus(job.status)) {
                ownJobs.push(job);
                stillActive.push(job.jobId);
            } else if (isTerminalStatus(job.status)) {
                finished.push(job);
            }
        }
        ownJobIds = stillActive;
        saveSessionJobs();

        const orgId = getOrgId();
        let orgJobs = [];
        if (orgId != null) {
            orgJobs = await fetchActiveOrgJobs(orgId);
        }
        updateIndicatorFromJobs(ownJobs, orgJobs);
        await maybeResumeStaleOwnJobs(ownJobs);
        if (ownJobs.length > 0 || stillActive.length === 0) {
            endEnqueueFeedback();
        }

        if (finished.length) {
            void refreshFailedFailures();
        }

        if (finished.length && !stillActive.length) {
            const last = finished[finished.length - 1];
            if (jobCreatedRecently(last)) {
                toastJobComplete(last);
                if (!last.dryRun) {
                    const hadSuccess = (last.succeeded || 0) > 0;
                    schedulePostSubmitUsanSync(orgId, {
                        scheduleFollowup: hadSuccess,
                        hadSuccess: hadSuccess,
                    });
                }
            }
        }

        if (!stillActive.length) {
            stopOwnPoll();
        }
    }

    async function pollOrgJobs() {
        const orgId = getOrgId();
        if (orgId == null) return;
        const orgJobs = await fetchActiveOrgJobs(orgId);
        const currentUserId =
            global.authModule && typeof global.authModule.getCurrentUser === 'function'
                ? (global.authModule.getCurrentUser() || {}).id
                : null;
        const ownFromOrg = orgJobs.filter(function (j) {
            return j.isOwn || (currentUserId != null && j.submittedByUserId === currentUserId);
        });
        const ownIds = ownFromOrg.map(function (j) {
            return j.jobId;
        });
        ownIds.forEach(function (id) {
            if (ownJobIds.indexOf(id) === -1) ownJobIds.push(id);
        });
        if (ownIds.length) saveSessionJobs();

        const activeCount = orgJobs.length;
        const wasActive = lastOrgActiveCount > 0;
        const nowActive = activeCount > 0;
        const prevOrgJobs = lastOrgActiveJobs;
        lastOrgActiveCount = activeCount;
        lastOrgActiveJobs = orgJobs.slice();

        const ownActive = ownFromOrg.filter(function (j) {
            return isActiveStatus(j.status);
        });
        updateIndicatorFromJobs(ownActive, orgJobs);
        await maybeResumeStaleOwnJobs(ownActive);

        for (const [jobId, meta] of seenOrgJobIds.entries()) {
            const still = orgJobs.find(function (j) {
                return j.jobId === jobId;
            });
            if (!still && meta && !meta.isOwn) {
                if (typeof global.showToast === 'function') {
                    global.showToast(
                        (meta.displayName || 'Someone') +
                            (meta.dryRun ? ' finished dry run (' : ' finished submitting (') +
                            (meta.succeeded || 0) +
                            ' succeeded)',
                        'success'
                    );
                }
                seenOrgJobIds.delete(jobId);
            }
        }
        orgJobs.forEach(function (j) {
            seenOrgJobIds.set(j.jobId, {
                jobId: j.jobId,
                isOwn: j.isOwn,
                dryRun: j.dryRun === true,
                displayName: j.submittedByDisplayName,
                succeeded: j.succeeded,
                failed: j.failed,
            });
        });

        if (wasActive && !nowActive) {
            const hadRealSubmit = prevOrgJobs.some(function (j) {
                return !j.dryRun && jobCreatedRecently(j);
            });
            if (hadRealSubmit) {
                schedulePostSubmitUsanSync(orgId, { scheduleFollowup: true, hadSuccess: true });
            }
        }

        ownJobIds.forEach(function (id) {
            if (
                !orgJobs.find(function (j) {
                    return j.jobId === id;
                })
            ) {
                void fetchJob(id).then(function (job) {
                    if (job && isActiveStatus(job.status) && ownJobIds.indexOf(id) === -1) {
                        ownJobIds.push(id);
                        saveSessionJobs();
                        startOwnPoll();
                    }
                });
            }
        });
    }

    function shouldPoll() {
        return !global.userActivity || global.userActivity.isActive();
    }

    function stopOwnPollTimer() {
        if (ownPollTimer) {
            clearInterval(ownPollTimer);
            ownPollTimer = null;
        }
    }

    function startOwnPoll() {
        if (!ownJobIds.length || !shouldPoll()) return;
        stopOwnPollTimer();
        void pollOwnJobs();
        ownPollTimer = setInterval(function () {
            if (!shouldPoll()) {
                stopOwnPollTimer();
                return;
            }
            void pollOwnJobs();
        }, OWN_POLL_MS_ACTIVE);
    }

    function stopOwnPoll() {
        stopOwnPollTimer();
    }

    function stopOrgPollTimer() {
        if (orgPollTimer) {
            clearInterval(orgPollTimer);
            orgPollTimer = null;
        }
    }

    function startOrgPoll() {
        if (!shouldPoll()) return;
        if (orgPollTimer) return;
        void pollOrgJobs();
        orgPollTimer = setInterval(function () {
            if (!shouldPoll()) {
                stopOrgPollTimer();
                return;
            }
            void pollOrgJobs();
        }, ORG_POLL_MS);
    }

    function stopOrgPoll() {
        stopOrgPollTimer();
        lastOrgActiveCount = 0;
        seenOrgJobIds.clear();
    }

    function resumePollsIfNeeded() {
        // Always restart when returning to the tab. Browsers may keep a throttled
        // interval alive without firing (so !ownPollTimer stays false) — skipping
        // restart leaves the activity indicator stuck until a delayed tick.
        if (ownJobIds.length) {
            startOwnPoll();
        }
        if (getOrgId() != null) {
            stopOrgPollTimer();
            startOrgPoll();
        }
        if (!failedPollTimer) {
            startFailedPoll();
        } else {
            void refreshFailedFailures();
        }
    }

    function beginEnqueueFeedback() {
        /* USAN activity indicator chrome removed. */
    }

    function endEnqueueFeedback() {
        /* USAN activity indicator chrome removed. */
    }

    function registerJob(jobId) {
        if (!jobId) {
            endEnqueueFeedback();
            return;
        }
        if (ownJobIds.indexOf(jobId) === -1) {
            ownJobIds.push(jobId);
            saveSessionJobs();
        }
        startOwnPoll();
        startOrgPoll();
        startFailedPoll();
        void pollOwnJobs();
        void refreshFailedFailures();
    }

    function onOrgChanged() {
        stopOrgPoll();
        seenOrgJobIds.clear();
        lastOrgActiveCount = 0;
        lastOrgActiveJobs = [];
        const orgId = getOrgId();
        if (orgId != null) startOrgPoll();
        global.setTimeout(function () {
            void refreshFailedFailures();
        }, 3500);
    }

    function hasActiveOwnJobs() {
        return ownJobIds.length > 0;
    }

    function init() {
        if (global.userActivity && typeof global.userActivity.onResume === 'function') {
            global.userActivity.onResume(resumePollsIfNeeded);
        }
        loadSessionJobs();
        if (ownJobIds.length) startOwnPoll();
        const orgId = getOrgId();
        if (orgId != null) startOrgPoll();
        startFailedPoll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.submitJobPoller = {
        beginEnqueueFeedback: beginEnqueueFeedback,
        endEnqueueFeedback: endEnqueueFeedback,
        registerJob: registerJob,
        onOrgChanged: onOrgChanged,
        hasActiveOwnJobs: hasActiveOwnJobs,
        pollOwnJobs: pollOwnJobs,
        pollOrgJobs: pollOrgJobs,
        refreshFailedFailures: refreshFailedFailures,
        runPostSubmitUsanListSync: runPostSubmitUsanListSync,
    };
})(typeof window !== 'undefined' ? window : globalThis);
