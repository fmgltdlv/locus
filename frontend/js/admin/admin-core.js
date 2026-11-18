
// Check if user has admin access (dev or admin role)
async function checkAdminAccess() {
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        window.location.href = 'login.html';
        return false;
    }

    if (!window.authModule.isDev() && !window.authModule.isAdmin()) {
        await appAlert('Access denied. Admin or dev privileges required.');
        window.location.href = 'index.html';
        return false;
    }

    return true;
}

var adminTabBadgePollTimer = null;
var adminTabBadgePollWanted = false;
var ADMIN_BADGE_POLL_MS = 120000;

function shouldRunAdminBackgroundPolls() {
    return !window.userActivity || window.userActivity.isActive();
}

function stopAdminTabBadgePollTimer() {
    if (adminTabBadgePollTimer) {
        clearInterval(adminTabBadgePollTimer);
        adminTabBadgePollTimer = null;
    }
}

function syncAdminTabBadgePoll() {
    if (!adminTabBadgePollWanted) {
        stopAdminTabBadgePollTimer();
        return;
    }
    if (!shouldRunAdminBackgroundPolls()) {
        stopAdminTabBadgePollTimer();
        return;
    }
    if (adminTabBadgePollTimer) return;
    void refreshAdminTabBadges();
    adminTabBadgePollTimer = setInterval(function () {
        if (!shouldRunAdminBackgroundPolls()) {
            stopAdminTabBadgePollTimer();
            return;
        }
        void refreshAdminTabBadges();
    }, ADMIN_BADGE_POLL_MS);
}

function startAdminTabBadgePoll() {
    adminTabBadgePollWanted = true;
    syncAdminTabBadgePoll();
}

function stopAdminTabBadgePoll() {
    adminTabBadgePollWanted = false;
    stopAdminTabBadgePollTimer();
}

/** Tabs visible only to users with global role `dev` (not org/global admins). */
const ADMIN_DEV_ONLY_TABS = ['serviceRequests', 'errors', 'aerialCatalog', 'appSettings'];

/** Missing or failed load keeps the Public sharing tab visible. */
let showPublicSharingTab = true;
/** Missing or failed load keeps ticket actions available. */
let enableTicketActions = true;
/** Missing or failed load keeps Request Services available. */
let hideSiteDocumentation = false;
/** Missing or failed load keeps the guided tour off. */
let enableGuidedTour = false;
/** Missing or failed load keeps signup open. */
let closeSignups = false;

function syncAppSettingsForm() {
    const showCb = document.getElementById('showPublicSharingTabToggle');
    if (showCb) showCb.checked = isPublicSharingTabVisible();
    const ticketCb = document.getElementById('enableTicketActionsToggle');
    if (ticketCb) ticketCb.checked = enableTicketActions !== false;
    const siteCb = document.getElementById('hideSiteDocumentationToggle');
    if (siteCb) siteCb.checked = hideSiteDocumentation === true;
    const tourCb = document.getElementById('enableGuidedTourToggle');
    if (tourCb) tourCb.checked = enableGuidedTour === true;
    const signupCb = document.getElementById('closeSignupsToggle');
    if (signupCb) signupCb.checked = closeSignups === true;
}

function isPublicSharingTabVisible() {
    if (window.CORE_PRODUCT === true) return false;
    return showPublicSharingTab !== false;
}

function isAdminDevOnlyTab(tabName) {
    return ADMIN_DEV_ONLY_TABS.indexOf(tabName) !== -1;
}

function canAccessAdminDevTab(tabName) {
    if (
        window.CORE_PRODUCT === true &&
        (tabName === 'aerialCatalog' || tabName === 'serviceRequests')
    ) {
        return false;
    }
    return !!(window.authModule && window.authModule.isDev && window.authModule.isDev());
}

function getDefaultAdminTab() {
    return 'users';
}

/** Desktop tab badges + mobile section labels from GET /admin/inbox-counts */
async function refreshAdminTabBadges() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    if (!window.authModule.isDev() && !window.authModule.isAdmin()) return;
    try {
        const data = await window.authModule.apiRequest('admin/inbox-counts');
        const sr = data.serviceRequestsNew != null ? Number(data.serviceRequestsNew) : 0;
        const err = Number(data.errorIncidents != null ? data.errorIncidents : 0) || 0;

        function applyTabBadge(tabKey, count) {
            const btn = document.querySelector('.admin-tab[data-tab="' + tabKey + '"]');
            const badge = btn ? btn.querySelector('.admin-tab-badge') : null;
            if (badge) {
                badge.hidden = false;
                badge.setAttribute('aria-hidden', 'false');
                badge.classList.toggle('admin-tab-badge--clear', count === 0);
                if (count > 0) {
                    badge.textContent = count > 99 ? '99+' : String(count);
                    badge.removeAttribute('title');
                } else {
                    badge.textContent = '';
                    badge.setAttribute('title', 'Nothing to resolve');
                }
            }
            if (btn) {
                const textEl = btn.querySelector('.admin-tab-text');
                const label = textEl ? textEl.textContent.trim() : tabKey;
                if (count > 0) {
                    btn.setAttribute('aria-label', label + ', ' + count + ' to resolve');
                } else {
                    btn.setAttribute('aria-label', label + ', nothing to resolve');
                }
            }
        }
        const badgeCounts = {};
        if (canAccessAdminDevTab('serviceRequests')) {
            applyTabBadge('serviceRequests', sr);
            badgeCounts.serviceRequests = sr;
        }
        if (canAccessAdminDevTab('errors')) {
            applyTabBadge('errors', err);
            badgeCounts.errors = err;
        }
        updateAdminMobileTabSelectBadges(badgeCounts);
    } catch (e) {
        /* ignore */
    }
}

function updateAdminMobileTabSelectBadges(counts) {
    const sel = document.getElementById('adminTabSelect');
    if (!sel) return;
    const baseLabels = {
        serviceRequests: 'Service Requests',
        errors: 'Errors'
    };
    for (let i = 0; i < sel.options.length; i++) {
        const opt = sel.options[i];
        const v = opt.value;
        if (!Object.prototype.hasOwnProperty.call(baseLabels, v)) continue;
        const c = Number(counts[v]) || 0;
        if (c > 0) {
            opt.textContent = baseLabels[v] + ' (' + (c > 99 ? '99+' : c) + ')';
        } else {
            opt.textContent = baseLabels[v] + ' (✓)';
        }
    }
}

// Switch tabs
function switchTab(tabName, clickedElement) {
    if (!tabName || typeof tabName !== 'string') return;
    if (tabName === 'publicSharing' && !isPublicSharingTabVisible()) {
        switchTab(getDefaultAdminTab(), null);
        return;
    }
    if (isAdminDevOnlyTab(tabName) && !canAccessAdminDevTab(tabName)) {
        switchTab(getDefaultAdminTab(), null);
        return;
    }

    document.querySelectorAll('.admin-tab').forEach(tab => {
        const match = tab.getAttribute('data-tab') === tabName;
        tab.classList.toggle('active', match);
        if (match) tab.setAttribute('aria-selected', 'true');
        else tab.setAttribute('aria-selected', 'false');
    });

    const tabSelect = document.getElementById('adminTabSelect');
    if (tabSelect && tabSelect.value !== tabName) {
        tabSelect.value = tabName;
    }

    // Update content panels - safe get so we never throw
    document.querySelectorAll('.admin-content').forEach(content => {
        content.classList.remove('active');
    });
    const contentPanel = document.getElementById(`${tabName}Tab`);
    if (contentPanel && contentPanel.classList) {
        contentPanel.classList.add('active');
    }

    // Load data for active tab
    if (tabName === 'users') {
        loadUsers();
    } else if (tabName === 'serviceRequests') {
        loadServiceRequests();
        requestAnimationFrame(() => {
            if (typeof invalidateAdminServiceRequestsMap === 'function') {
                invalidateAdminServiceRequestsMap();
            }
        });
    } else if (tabName === 'errors') {
        loadAdminErrors();
    } else if (tabName === 'publicSharing') {
        loadPublicSharingSettings();
    } else if (tabName === 'appSettings') {
        if (window.authModule && window.authModule.isDev()) {
            syncAppSettingsForm();
            const status = document.getElementById('appSettingsStatus');
            if (status) status.textContent = '';
            if (typeof loadSharedServiceAccount === 'function') {
                void loadSharedServiceAccount();
            }
            loadUsanSyncSettings();
        }
    } else if (tabName === 'workflow') {
        loadWorkflowSettings();
    } else if (tabName === 'aerialCatalog') {
        if (window.authModule && window.authModule.isDev()) {
            loadAerialCatalog();
        }
    }
}

/** Server-reported caps for external sync days-back (dev may receive USAN lookback max). */
let usanSyncStandardMaxDaysBack = 120;
let usanSyncMaxDaysBack = 120;

function getUsanSyncDaysBackMax() {
    const isDev = !!(window.authModule && window.authModule.isDev && window.authModule.isDev());
    return isDev ? usanSyncMaxDaysBack : usanSyncStandardMaxDaysBack;
}

function clampUsanSyncDaysBack(raw) {
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n)) return null;
    const max = getUsanSyncDaysBackMax();
    return Math.min(max, Math.max(1, n));
}

function applyUsanSyncDaysBackInputLimits() {
    const daysEl = document.getElementById('usanSyncDaysBack');
    const devHint = document.getElementById('usanSyncDevDaysHint');
    const isDev = !!(window.authModule && window.authModule.isDev && window.authModule.isDev());
    const max = getUsanSyncDaysBackMax();
    if (daysEl) {
        daysEl.min = '1';
        daysEl.max = String(max);
    }
    if (devHint) {
        devHint.style.display = isDev ? 'block' : 'none';
        devHint.textContent = isDev
            ? 'Dev: you can save and run full sync up to ' + max + ' days back (USAN lookback max).'
            : '';
    }
}

async function loadUsanSyncSettings() {
    const statusEl = document.getElementById('usanSyncStatus');
    if (statusEl) statusEl.textContent = '';
    try {
        let s;
        try {
            s = await window.authModule.apiRequest('admin/usan-sync-settings');
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e || '');
            if (!/^HTTP 404\b/.test(msg)) throw e;
            // Backward compatibility while older workers are still running.
            s = await window.authModule.apiRequest('admin/pac-sync-settings');
        }
        if (s.standardMaxDaysBack != null && Number.isFinite(Number(s.standardMaxDaysBack))) {
            usanSyncStandardMaxDaysBack = Number(s.standardMaxDaysBack);
        }
        if (s.maxDaysBack != null && Number.isFinite(Number(s.maxDaysBack))) {
            usanSyncMaxDaysBack = Number(s.maxDaysBack);
        }
        applyUsanSyncDaysBackInputLimits();
        const daysEl = document.getElementById('usanSyncDaysBack');
        if (daysEl) {
            daysEl.value = String(s.daysBack != null ? s.daysBack : usanSyncStandardMaxDaysBack);
        }
    } catch (e) {
        const msg = getAdminErrorMessage(e);
        if (statusEl) statusEl.textContent = 'Unable to load sync settings. ' + msg;
    }
}

function syncUsanSettingsAccessUi() {
    const saveBtn = document.getElementById('usanSyncSaveBtn');
    const hint = document.getElementById('usanSyncSaveHint');
    const isDev = !!(window.authModule && window.authModule.isDev && window.authModule.isDev());
    if (saveBtn) {
        saveBtn.style.display = isDev ? '' : 'none';
    }
    if (hint) {
        hint.style.display = isDev ? 'none' : 'block';
    }
    applyUsanSyncDaysBackInputLimits();
}

async function saveUsanSyncSettings() {
    const statusEl = document.getElementById('usanSyncStatus');
    if (statusEl) statusEl.textContent = '';
    try {
        const daysBack = document.getElementById('usanSyncDaysBack');
        const clampedDaysBack = daysBack ? clampUsanSyncDaysBack(daysBack.value) : usanSyncStandardMaxDaysBack;
        const payload = {
            daysBack: clampedDaysBack != null ? clampedDaysBack : usanSyncStandardMaxDaysBack,
        };
        try {
            await window.authModule.apiRequest('admin/usan-sync-settings', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e || '');
            if (!/^HTTP 404\b/.test(msg)) throw e;
            // Backward compatibility while older workers are still running.
            await window.authModule.apiRequest('admin/pac-sync-settings', {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        }
        if (typeof window.appAlert === 'function') await window.appAlert('Sync settings saved.');
        await loadUsanSyncSettings();
    } catch (e) {
        const msg = getAdminErrorMessage(e);
        if (statusEl) statusEl.textContent = 'Unable to save sync settings. ' + msg;
    }
}

/** Reload Ticket Hub list/map in the open tab after admin sync or nuke (best-effort). */
async function refreshTicketHubAfterAdminDataChange() {
    try {
        const tm = window.ticketsModule;
        if (!tm) return;
        if (typeof tm.loadTicketsForCurrentOrg === 'function') {
            await tm.loadTicketsForCurrentOrg({ forceRefresh: true });
        }
        if (typeof tm.loadHubTicketSliceForCurrentFilters === 'function') {
            await tm.loadHubTicketSliceForCurrentFilters({ pageDirection: 'first', forceRefresh: true });
        } else if (typeof tm.loadExpiredTicketsForHub === 'function') {
            await tm.loadExpiredTicketsForHub({ pageDirection: 'first', forceRefresh: true });
        }
    } catch (e) {
        console.warn('[admin] ticket hub refresh after data change:', e && e.message ? e.message : e);
    }
}

async function runAdminUsanFullSync() {
    const orgId = getCurrentAdminOrgId();
    if (!orgId) {
        if (typeof window.appAlert === 'function') {
            await window.appAlert('Full list sync needs a current organization on your account.');
        }
        return;
    }
    try {
        const org = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations/${orgId}`);
        if (org && org.isPublicCatalog) {
            if (typeof window.appAlert === 'function') {
                await window.appAlert('USAN list sync is not available for the public catalog organization.');
            }
            return;
        }
    } catch (_) {
        /* fall through; server will reject if catalog */
    }
    const btn = document.getElementById('usanSyncFullRunBtn');
    const runStatusEl = document.getElementById('usanSyncRunStatus');
    const daysBack = document.getElementById('usanSyncDaysBack');
    const forceRebuildEl = document.getElementById('usanSyncForceRebuild');
    const forceRebuild = !!(forceRebuildEl && forceRebuildEl.checked);
    const rawDaysBack =
        daysBack && String(daysBack.value || '').trim() !== '' ? parseInt(String(daysBack.value), 10) : null;
    const daysBackOverride = rawDaysBack != null && Number.isFinite(rawDaysBack) ? clampUsanSyncDaysBack(rawDaysBack) : null;
    if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    }
    if (forceRebuildEl) forceRebuildEl.disabled = true;
    if (runStatusEl) {
        runStatusEl.style.display = 'block';
        runStatusEl.style.color = '#e5e5e5';
        runStatusEl.textContent = forceRebuild ? 'Running force rebuild...' : 'Checking changed tickets...';
    }
    try {
        let data;
        let foundUniqueTotal = null;
        let foundSearchRows = null;
        if (window.authModule && typeof window.authModule.usanPollStream === 'function') {
            data = await window.authModule.usanPollStream(
                'tickets/usan-poll',
                { organizationId: orgId, fullSync: true, syncMode: 'list', forceRebuild, daysBackOverride },
                function (evt) {
                    if (!runStatusEl) return;
                    const pct = evt && evt.percent != null ? Number(evt.percent) : null;
                    const phase = evt && evt.phase ? String(evt.phase) : '';
                    if (evt && evt.uniqueRequestNumbers != null) {
                        const n = Number(evt.uniqueRequestNumbers);
                        if (Number.isFinite(n)) foundUniqueTotal = n;
                    }
                    if (evt && evt.providerSearchRows != null) {
                        const n = Number(evt.providerSearchRows);
                        if (Number.isFinite(n)) foundSearchRows = n;
                    }
                    const foundPrefix =
                        foundUniqueTotal != null
                            ? `Found ${foundUniqueTotal} request(s). `
                            : foundSearchRows != null
                              ? `Found ${foundSearchRows} search row(s). `
                              : '';
                    if (phase === 'search') {
                        const total =
                            evt && evt.uniqueRequestNumbers != null ? Number(evt.uniqueRequestNumbers) : null;
                        const rows = evt && evt.providerSearchRows != null ? Number(evt.providerSearchRows) : null;
                        const foundLine =
                            total != null && Number.isFinite(total)
                                ? `Found ${total} unique request number(s)`
                                : rows != null && Number.isFinite(rows)
                                  ? `Found ${rows} search row(s)`
                                  : 'Search complete';
                        runStatusEl.style.color = '#e5e5e5';
                        runStatusEl.textContent = foundLine + '.';
                        return;
                    }
                    if (phase === 'check') {
                        runStatusEl.style.color = '#e5e5e5';
                        runStatusEl.textContent = `${foundPrefix}Checking changed tickets...`;
                        return;
                    }
                    const current = evt && evt.current != null ? Number(evt.current) : null;
                    const total = evt && evt.total != null ? Number(evt.total) : null;
                    const phaseLabel =
                        phase === 'provider'
                            ? 'Resolving external details'
                            : phase === 'import'
                              ? forceRebuild
                                  ? 'Rebuilding ticket rows'
                                  : 'Writing changed tickets'
                              : forceRebuild
                                ? 'Running force rebuild'
                                : 'Running list sync';
                    const countText =
                        current != null && Number.isFinite(current) && total != null && Number.isFinite(total)
                            ? ` (${current}/${total})`
                            : '';
                    if (pct != null && Number.isFinite(pct)) {
                        runStatusEl.style.color = '#e5e5e5';
                        runStatusEl.textContent = `${foundPrefix}${phaseLabel}${countText}… ${Math.max(0, Math.min(100, Math.round(pct)))}%`;
                    } else {
                        runStatusEl.style.color = '#e5e5e5';
                        runStatusEl.textContent = `${foundPrefix}${phaseLabel}${countText}…`;
                    }
                }
            );
        } else {
            try {
                data = await window.authModule.apiRequest('admin/usan-full-sync', {
                    method: 'POST',
                    body: JSON.stringify({ organizationId: orgId, syncMode: 'list', forceRebuild, daysBackOverride }),
                });
            } catch (e) {
                const msg = e && e.message ? String(e.message) : String(e || '');
                if (!/^HTTP 404\b/.test(msg)) throw e;
                // Backward compatibility while older workers are still running.
                data = await window.authModule.apiRequest('admin/pac-full-sync', {
                    method: 'POST',
                    body: JSON.stringify({ organizationId: orgId, syncMode: 'list', forceRebuild, daysBackOverride }),
                });
            }
        }
        if (runStatusEl) {
            if (data && data.skipped === true) {
                runStatusEl.style.color = data.reason === 'no_master_account' ? '#fbbf24' : '#e5e5e5';
                runStatusEl.textContent =
                    data.reason === 'no_master_account'
                        ? 'Add a USAN master account in Provider Accounts to sync tickets.'
                        : `Sync skipped (${data.reason || 'unknown'}).`;
            } else {
            const imported = data && data.importedCount != null ? Number(data.importedCount) : 0;
            const refreshed = data && data.refreshedExistingCount != null ? Number(data.refreshedExistingCount) : 0;
            const unique = data && data.uniqueRequestNumbers != null ? Number(data.uniqueRequestNumbers) : null;
            const queued = data && data.queuedForManualAssign != null ? Number(data.queuedForManualAssign) : 0;
            const skipped = data && data.skippedExisting != null ? Number(data.skippedExisting) : 0;
            const unchanged = data && data.skippedListFingerprintUnchanged != null ? Number(data.skippedListFingerprintUnchanged) : 0;
            const fromDate = data && data.fromDate ? String(data.fromDate) : '';
            const toDate = data && data.toDate ? String(data.toDate) : '';
            const rangeText = fromDate && toDate ? ` Window: ${fromDate} to ${toDate}.` : '';
            runStatusEl.style.color = '#4ade80';
            runStatusEl.textContent =
                `Completed.${rangeText} Found ${unique != null && Number.isFinite(unique) ? unique : '?'} request(s); imported ${imported}, refreshed ${refreshed}` +
                (queued > 0 ? `, queued ${queued}` : '') +
                (skipped > 0 ? `, skipped ${skipped} existing` : '') +
                (unchanged > 0 ? `, unchanged ${unchanged}` : '') +
                '. Expired tickets appear in Ticket Hub with the Expired filter (timeframe up to 365 days).';
            }
        }
        if (typeof window.appAlert === 'function') {
            if (data && data.skipped === true && data.reason === 'no_master_account') {
                await window.appAlert('Add a USAN master account in Provider Accounts to sync tickets.');
            } else if (!(data && data.skipped === true)) {
            const n = data && data.importedCount != null ? data.importedCount : 0;
            const unique = data && data.uniqueRequestNumbers != null ? Number(data.uniqueRequestNumbers) : null;
            const fromDate = data && data.fromDate ? String(data.fromDate) : '';
            const toDate = data && data.toDate ? String(data.toDate) : '';
            const rangeText = fromDate && toDate ? `\nSearch window: ${fromDate} to ${toDate}.` : '';
            const foundText =
                unique != null && Number.isFinite(unique) ? `\nFound ${unique} request number(s) from nGen.` : '';
            await window.appAlert(
                `Full list sync finished. Imported ${n} new ticket(s).${rangeText}${foundText}\n\nExpired tickets are not on the map list by default. In Ticket Hub, choose the Expired status filter and Last 365 days (or Custom dates).`
            );
            }
        }
        if (!(data && data.skipped === true)) {
            await refreshTicketHubAfterAdminDataChange();
        }
    } catch (e) {
        const msg = getAdminErrorMessage(e);
        if (runStatusEl) {
            runStatusEl.style.display = 'block';
            runStatusEl.style.color = '#fca5a5';
            runStatusEl.textContent = msg;
        }
        if (typeof window.appAlert === 'function') await window.appAlert(msg);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
        }
        if (forceRebuildEl) forceRebuildEl.disabled = false;
    }
}

function applyPublicSharingTabVisibility(show) {
    showPublicSharingTab = show !== false;
    const btn = document.getElementById('adminTabPublicSharing');
    if (btn) {
        btn.classList.toggle('admin-tab-feature-hidden', !showPublicSharingTab);
        if (showPublicSharingTab) btn.removeAttribute('aria-hidden');
        else btn.setAttribute('aria-hidden', 'true');
    }
    const sel = document.getElementById('adminTabSelect');
    const selectWasSharing = !!(sel && sel.value === 'publicSharing');
    if (sel) {
        if (showPublicSharingTab) {
            let existing = null;
            for (let i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === 'publicSharing') existing = sel.options[i];
            }
            if (!existing) {
                const opt = document.createElement('option');
                opt.value = 'publicSharing';
                opt.textContent = 'Public sharing';
                let insertBefore = null;
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === 'workflow') {
                        insertBefore = sel.options[i];
                        break;
                    }
                }
                if (insertBefore) sel.insertBefore(opt, insertBefore);
                else sel.appendChild(opt);
            }
        } else {
            for (let i = sel.options.length - 1; i >= 0; i--) {
                if (sel.options[i].value === 'publicSharing') sel.remove(i);
            }
        }
    }
    if (!showPublicSharingTab) {
        const active = document.querySelector('.admin-tab.active');
        const activeName = active ? active.getAttribute('data-tab') : '';
        if (activeName === 'publicSharing' || selectWasSharing) {
            switchTab(getDefaultAdminTab(), null);
        }
    }
}

async function loadAppSettings() {
    const status = document.getElementById('appSettingsStatus');
    if (status) status.textContent = '';
    try {
        const data = await window.authModule.apiRequest('admin/app-settings');
        const show = !data || data.showPublicSharingTab !== false;
        applyPublicSharingTabVisibility(show);
        enableTicketActions = !data || data.enableTicketActions !== false;
        hideSiteDocumentation = !!(data && data.hideSiteDocumentation === true);
        enableGuidedTour = !!(data && data.enableGuidedTour === true);
        closeSignups = !!(data && data.closeSignups === true);
        syncAppSettingsForm();
    } catch (e) {
        applyPublicSharingTabVisibility(true);
        enableTicketActions = true;
        hideSiteDocumentation = false;
        enableGuidedTour = false;
        closeSignups = false;
        syncAppSettingsForm();
        if (status) {
            status.textContent = (e && e.message) || 'Could not load app settings. Public sharing stays visible.';
        }
    }
}

async function saveAppSettings() {
    const status = document.getElementById('appSettingsStatus');
    const cb = document.getElementById('showPublicSharingTabToggle');
    const ticketCb = document.getElementById('enableTicketActionsToggle');
    const siteCb = document.getElementById('hideSiteDocumentationToggle');
    const tourCb = document.getElementById('enableGuidedTourToggle');
    const signupCb = document.getElementById('closeSignupsToggle');
    const show = !!(cb && cb.checked);
    const ticketActions = !!(ticketCb && ticketCb.checked);
    const hideSite = !!(siteCb && siteCb.checked);
    const tourOn = !!(tourCb && tourCb.checked);
    const signupsClosed = !!(signupCb && signupCb.checked);
    if (status) status.textContent = '';
    try {
        await window.authModule.apiRequest('admin/app-settings', {
            method: 'PUT',
            body: JSON.stringify({
                showPublicSharingTab: show,
                enableTicketActions: ticketActions,
                hideSiteDocumentation: hideSite,
                enableGuidedTour: tourOn,
                closeSignups: signupsClosed,
            }),
        });
        applyPublicSharingTabVisibility(show);
        enableTicketActions = ticketActions;
        hideSiteDocumentation = hideSite;
        enableGuidedTour = tourOn;
        closeSignups = signupsClosed;
        if (typeof window.appAlert === 'function') await window.appAlert('App settings saved.');
    } catch (e) {
        const msg = (e && e.message) || 'Could not save app settings.';
        if (status) status.textContent = msg;
        if (typeof window.appAlert === 'function') await window.appAlert(msg);
    }
}

function canAdminCurrentOrgForSharing() {
    const orgId = getCurrentAdminOrgId();
    if (!orgId || !window.authModule) return false;
    if (window.authModule.isDev()) return true;
    const user = window.authModule.getCurrentUser();
    const adminIds = user && user.adminOrganizationIds;
    return Array.isArray(adminIds) && adminIds.includes(orgId);
}

async function loadPublicSharingSettings() {
    const orgId = getCurrentAdminOrgId();
    const panel = document.getElementById('publicSharingPanel');
    if (!panel) return;
    if (!orgId) {
        panel.innerHTML =
            '<p style="color:#666;">Public sharing uses your current organization.</p>';
        return;
    }
    if (!canAdminCurrentOrgForSharing()) {
        panel.innerHTML =
            '<p style="color:#666;">Only organization admins can change public sharing settings.</p>';
        return;
    }
    try {
        const org = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations/${orgId}`);
        if (org && org.isPublicCatalog) {
            panel.innerHTML =
                '<p style="color:#666;">This is the Public Data catalog organization. Contributor sharing is configured on customer organizations, not here.</p>';
            return;
        }
        const shareChecked = org && org.shareToPublic ? 'checked' : '';
        const namedChecked = !org || org.publicIdentityMode !== 'anonymous' ? 'checked' : '';
        const anonChecked = org && org.publicIdentityMode === 'anonymous' ? 'checked' : '';
        panel.innerHTML =
            '<p style="font-size:0.85rem;color:#666;margin:0 0 1rem;">When enabled, all tickets from this organization are shared to the Public Data org. Photos and saved layers are shared per item (Make public). You must share to view public data from other organizations.</p>' +
            '<div class="admin-form-group"><label class="admin-form-label" style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">' +
            `<input type="checkbox" id="publicShareToPublicToggle" ${shareChecked} />` +
            '<span>Share to public (includes all tickets)</span></label></div>' +
            '<div class="admin-form-group"><span class="admin-form-label">Public attribution</span>' +
            `<label style="margin-right:1rem;"><input type="radio" name="publicIdentityMode" value="named" ${namedChecked} /> Named</label>` +
            `<label><input type="radio" name="publicIdentityMode" value="anonymous" ${anonChecked} /> Anonymous</label></div>` +
            '<button type="button" class="admin-button admin-button-primary" onclick="savePublicSharingSettings()">Save</button>';
    } catch (e) {
        panel.innerHTML = `<p style="color:var(--app-danger);">${escapeAdminHtml(e.message || 'Failed to load settings')}</p>`;
    }
}

async function savePublicSharingSettings() {
    const orgId = getCurrentAdminOrgId();
    if (!orgId) return;
    const shareEl = document.getElementById('publicShareToPublicToggle');
    const modeEl = document.querySelector('input[name="publicIdentityMode"]:checked');
    const payload = {
        shareToPublic: !!(shareEl && shareEl.checked),
        publicIdentityMode: modeEl ? modeEl.value : 'named',
    };
    const orgUrl = `${getAdminApiBase()}/organizations/${orgId}`;
    try {
        try {
            await window.authModule.apiRequest(`${orgUrl}/public-sharing`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
        } catch (e) {
            const msg = String(e && e.message || '');
            if (msg.includes('HTTP 404') || msg.toLowerCase().includes('not found')) {
                await window.authModule.apiRequest(orgUrl, {
                    method: 'PUT',
                    body: JSON.stringify(payload),
                });
            } else {
                throw e;
            }
        }
        await appAlert('Public sharing settings saved.');
        await loadPublicSharingSettings();
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

window.loadPublicSharingSettings = loadPublicSharingSettings;
window.loadAppSettings = loadAppSettings;
window.saveAppSettings = saveAppSettings;
window.savePublicSharingSettings = savePublicSharingSettings;

function parseWorkflowOperatorCodeField(id) {
    const codeMod = window.operatorResponseCodesModule;
    const normalize =
        codeMod && typeof codeMod.normalizeOperatorCodeList === 'function'
            ? codeMod.normalizeOperatorCodeList
            : (raw) => (raw && String(raw).trim() ? String(raw).trim().split(/[\s,;]+/) : null);
    const el = document.getElementById(id);
    return normalize(el ? el.value : '');
}

function normalizeWorkflowAckComplianceFromForm() {
    const renewalWaiversEl = document.getElementById('workflowRenewalAckWaivers');
    const expiringSoonEl = document.getElementById('workflowExpiringSoonDays');
    const renewalAckWaivers = renewalWaiversEl ? !!renewalWaiversEl.checked : false;
    const greenResponsesEl = document.getElementById('workflowGreenResponsesAfterAck');
    const greenResponsesAfterAck = greenResponsesEl ? !!greenResponsesEl.checked : false;
    let expiringSoonDays = expiringSoonEl ? parseInt(String(expiringSoonEl.value), 10) : 5;
    if (!Number.isFinite(expiringSoonDays)) expiringSoonDays = 5;
    expiringSoonDays = Math.min(15, Math.max(1, expiringSoonDays));
    const notReadyCodes = parseWorkflowOperatorCodeField('workflowNotReadyCodes');
    const actionRequiredCodes = parseWorkflowOperatorCodeField('workflowActionRequiredCodes');
    const ackBlockingCodes = parseWorkflowOperatorCodeField('workflowAckBlockingCodes');
    return {
        requiredPhotoCount: 0,
        droneMapMode: 'none',
        renewalAckWaivers,
        greenResponsesAfterAck,
        expiringSoonDays,
        notReadyCodes,
        actionRequiredCodes,
        ackBlockingCodes,
    };
}

function isDefaultWorkflowAckCompliance(compliance) {
    const codeMod = window.operatorResponseCodesModule;
    const codeListsDefault =
        codeMod && typeof codeMod.isDefaultOperatorCodeLists === 'function'
            ? codeMod.isDefaultOperatorCodeLists(compliance)
            : true;
    return (
        compliance.requiredPhotoCount === 0 &&
        compliance.droneMapMode === 'none' &&
        !compliance.renewalAckWaivers &&
        !compliance.greenResponsesAfterAck &&
        compliance.expiringSoonDays === 5 &&
        codeListsDefault
    );
}

function workflowCodeListInputValue(stored, fallback) {
    const codeMod = window.operatorResponseCodesModule;
    if (codeMod && typeof codeMod.formatOperatorCodeListForInput === 'function') {
        return codeMod.formatOperatorCodeListForInput(stored, fallback);
    }
    return (stored != null && Array.isArray(stored) ? stored : fallback).join(', ');
}

async function loadWorkflowSettings() {
    const orgId = getCurrentAdminOrgId();
    const panel = document.getElementById('workflowPanel');
    if (!panel) return;
    if (!orgId) {
        panel.innerHTML =
            '<p style="color:#666;">Workflow settings use your current organization.</p>';
        return;
    }
    if (!canAdminCurrentOrgForSharing()) {
        panel.innerHTML =
            '<p style="color:#666;">Only organization admins can change workflow acknowledgement settings.</p>';
        return;
    }
    try {
        const org = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations/${orgId}`);
        const cfg =
            org && org.settings && org.settings.workflowAckCompliance
                ? org.settings.workflowAckCompliance
                : {};
        const codeMod = window.operatorResponseCodesModule;
        const norm =
            window.workflowAckComplianceModule &&
            typeof window.workflowAckComplianceModule.normalizeWorkflowAckComplianceSettings === 'function'
                ? window.workflowAckComplianceModule.normalizeWorkflowAckComplianceSettings(cfg)
                : cfg;
        const renewalAckWaivers = norm.renewalAckWaivers === true;
        const renewalWaiversChecked = renewalAckWaivers ? 'checked' : '';
        const greenResponsesAfterAck = norm.greenResponsesAfterAck === true;
        const greenResponsesChecked = greenResponsesAfterAck ? 'checked' : '';
        const expiringSoonDays =
            norm.expiringSoonDays != null && Number.isFinite(Number(norm.expiringSoonDays))
                ? Math.min(15, Math.max(1, Math.round(Number(norm.expiringSoonDays))))
                : 5;
        const defaultNotReady = codeMod ? codeMod.DEFAULT_NOT_READY_CODES : [];
        const defaultActionRequired = codeMod ? codeMod.DEFAULT_ACTION_REQUIRED_CODES : [];
        const defaultAckBlocking = codeMod ? codeMod.DEFAULT_ACK_BLOCKING_CODES : [];
        const notReadyVal = escapeAdminHtml(workflowCodeListInputValue(norm.notReadyCodes, defaultNotReady));
        const actionRequiredVal = escapeAdminHtml(
            workflowCodeListInputValue(norm.actionRequiredCodes, defaultActionRequired)
        );
        const ackBlockingVal = escapeAdminHtml(workflowCodeListInputValue(norm.ackBlockingCodes, defaultAckBlocking));
        panel.innerHTML =
            '<p style="font-size:0.85rem;color:#666;margin:0 0 1rem;">Configure workflow behaviour for this organization. Response code lists are comma-separated. Codes in <strong>Not ready</strong> take precedence over <strong>Review required</strong>; anything else is treated as good (Ready).</p>' +
            '<div class="admin-form-group"><label class="admin-form-label" for="workflowNotReadyCodes">Not ready codes (utilities pending)</label>' +
            `<textarea id="workflowNotReadyCodes" class="admin-form-input" rows="2" style="width:100%;max-width:36rem;font-family:monospace;">${notReadyVal}</textarea>` +
            '<p style="font-size:0.75rem;color:#666;margin:0.35rem 0 0;">Operator responses with these codes show as Not ready.</p></div>' +
            '<div class="admin-form-group"><label class="admin-form-label" for="workflowActionRequiredCodes">Review required codes</label>' +
            `<textarea id="workflowActionRequiredCodes" class="admin-form-input" rows="2" style="width:100%;max-width:36rem;font-family:monospace;">${actionRequiredVal}</textarea>` +
            '<p style="font-size:0.75rem;color:#666;margin:0.35rem 0 0;">Crew follow-up when utilities have responded but these codes are present.</p></div>' +
            '<div class="admin-form-group"><label class="admin-form-label" for="workflowAckBlockingCodes">Codes that block marking Ready</label>' +
            `<textarea id="workflowAckBlockingCodes" class="admin-form-input" rows="2" style="width:100%;max-width:36rem;font-family:monospace;">${ackBlockingVal}</textarea>` +
            '<p style="font-size:0.75rem;color:#666;margin:0.35rem 0 0;">Acknowledgement is blocked while any operator row on the current revision has one of these codes (unless RNEW waivers apply).</p></div>' +
            '<div class="admin-form-group"><label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer;">' +
            `<input type="checkbox" id="workflowRenewalAckWaivers" ${renewalWaiversChecked} style="margin-top:0.2rem;" />` +
            '<span><span class="admin-form-label" style="display:inline;margin:0;">Allow acknowledgement waivers for USAN renewals (RNEW)</span>' +
            '<span style="display:block;font-size:0.75rem;color:#666;margin-top:0.25rem;">When checked, crews may mark Ready on a renewal even when utilities or operator responses are incomplete.</span></span></label></div>' +
            '<div class="admin-form-group"><label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer;">' +
            `<input type="checkbox" id="workflowGreenResponsesAfterAck" ${greenResponsesChecked} style="margin-top:0.2rem;" />` +
            '<span><span class="admin-form-label" style="display:inline;margin:0;">Show utility responses as green after acknowledgement</span>' +
            '<span style="display:block;font-size:0.75rem;color:#666;margin-top:0.25rem;">When checked, each operator response card turns green once the ticket is acknowledged. Utility codes stay as they are.</span></span></label></div>' +
            '<div class="admin-form-group"><label class="admin-form-label" for="workflowExpiringSoonDays">Expiring soon window (days)</label>' +
            `<input type="number" id="workflowExpiringSoonDays" class="admin-form-input" min="1" max="15" step="1" value="${expiringSoonDays}" style="max-width:8rem;" />` +
            '<p style="font-size:0.75rem;color:#666;margin:0.35rem 0 0;">Tickets whose expiration date falls within this many calendar days are marked Expiring soon. Default is 5. Allowed range is 1–15.</p></div>' +
            '<button type="button" class="admin-button admin-button-primary" onclick="saveWorkflowSettings()">Save</button>';
    } catch (e) {
        panel.innerHTML = `<p style="color:var(--app-danger);">${escapeAdminHtml(e.message || 'Failed to load settings')}</p>`;
    }
}

async function saveWorkflowSettings() {
    const orgId = getCurrentAdminOrgId();
    if (!orgId) return;
    const orgUrl = `${getAdminApiBase()}/organizations/${orgId}`;
    try {
        const org = await window.authModule.apiRequest(orgUrl);
        const settings = org && org.settings ? { ...org.settings } : {};
        const compliance = normalizeWorkflowAckComplianceFromForm();
        if (isDefaultWorkflowAckCompliance(compliance)) {
            delete settings.workflowAckCompliance;
        } else {
            const stored = { ...compliance };
            if (stored.notReadyCodes == null) delete stored.notReadyCodes;
            if (stored.actionRequiredCodes == null) delete stored.actionRequiredCodes;
            if (stored.ackBlockingCodes == null) delete stored.ackBlockingCodes;
            settings.workflowAckCompliance = stored;
        }
        await window.authModule.apiRequest(orgUrl, {
            method: 'PUT',
            body: JSON.stringify({ settings }),
        });
        if (window.orgSelectorModule && typeof window.orgSelectorModule.refreshOrganizations === 'function') {
            await window.orgSelectorModule.refreshOrganizations();
        }
        await appAlert('Workflow acknowledgement settings saved.');
        await loadWorkflowSettings();
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

window.loadWorkflowSettings = loadWorkflowSettings;
window.saveWorkflowSettings = saveWorkflowSettings;

