// Organization selector module - single source of truth for "current org" in the UI
let currentOrgId = null;
let userOrgIds = []; // orgs the user is a member of (for permission checks)
let organizations = [];

function escapeOrgSelectorHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setSessionActiveOrganization(orgId) {
    if (window.authModule && typeof window.authModule.setActiveOrganizationId === 'function') {
        window.authModule.setActiveOrganizationId(orgId);
    }
}

// Initialize organization selector
async function initOrgSelector() {
    const selector = document.getElementById('orgSelector');
    if (!selector) return;

    if (!window.authModule || !window.authModule.isAuthenticated()) {
        selector.innerHTML = '<option value="">Not authenticated</option>';
        selector.disabled = true;
        return;
    }

    const user = window.authModule.getCurrentUser();
    currentOrgId = user.organizationId;

    try {
        const userId = user.id;
        
        // Get user's organizations
        const userOrgs = await window.authModule.apiRequest(`${window.authModule.API_BASE}/user-organizations/user/${userId}`);
        userOrgIds = userOrgs.filter(org => org.is_member === 1).map(org => org.id);
        const defaultOrgId = userOrgs.find(org => org.is_default === 1)?.id || (userOrgIds.length > 0 ? userOrgIds[0] : null);
        
        currentOrgId = user.organizationId || defaultOrgId;
        
        if (userOrgIds.length === 0) {
            selector.innerHTML = '<option value="">No Organization</option>';
            selector.disabled = true;
            if (typeof window.updateEditPermissionsVisibility === 'function') {
                window.updateEditPermissionsVisibility();
            }
            return;
        }
        
        // Get full org details
        const orgs = await window.authModule.apiRequest(`${window.authModule.API_BASE}/organizations?slim=1`);
        const userOrgsDetails = orgs.filter(org => userOrgIds.includes(org.id));
        
        if (window.authModule.isDev()) {
            // Dev can see and switch between all orgs (including ones they're not in)
            const allOrgs = await window.authModule.apiRequest(`${window.authModule.API_BASE}/organizations?slim=1`);
            selector.innerHTML = '<option value="">Select Organization...</option>' + 
                allOrgs.map(org => {
                    const isMember = userOrgIds.includes(org.id);
                    const isDefault = org.id === defaultOrgId;
                    return `<option value="${escapeOrgSelectorHtml(org.id)}" ${org.id === currentOrgId ? 'selected' : ''} ${!isMember ? 'style="color: #666;"' : ''}>${escapeOrgSelectorHtml(org.name)}${isDefault ? ' (Default)' : ''}${!isMember ? ' (View Only)' : ''}</option>`;
                }).join('');
            
            organizations = allOrgs;
            selector.disabled = true;
        } else {
            // Member orgs plus Public Data (viewer) when API returns accessMode: 'viewer'
            const viewerOrgs = orgs.filter(
                (o) => o.accessMode === 'viewer' && !userOrgIds.includes(o.id)
            );
            const combined = userOrgsDetails.concat(viewerOrgs);
            organizations = combined;
            const labelFor = (org) => org.publicCatalogDisplayName || org.name;
            selector.innerHTML = combined.map((org) => {
                const isDefault = org.id === defaultOrgId;
                const suffix = org.accessMode === 'viewer' ? ' (view only)' : isDefault ? ' (Default)' : '';
                return `<option value="${escapeOrgSelectorHtml(org.id)}" ${org.id === currentOrgId ? 'selected' : ''}>${escapeOrgSelectorHtml(labelFor(org))}${suffix}</option>`;
            }).join('');
            selector.disabled = true;
        }
        // Refresh edit permissions (e.g. Import Tickets button) after selector is ready
        if (typeof window.updateEditPermissionsVisibility === 'function') {
            window.updateEditPermissionsVisibility();
        }
        applyCurrentOrgTitleBar();
    } catch (error) {
        console.error('Error loading organizations:', error);
        selector.innerHTML = '<option value="">Error loading</option>';
        selector.disabled = true;
        if (typeof window.updateEditPermissionsVisibility === 'function') {
            window.updateEditPermissionsVisibility();
        }
    }
}

// Handle organization change
async function handleOrgChange(event) {
    const newOrgId = parseInt(event.target.value, 10);
    if (!newOrgId || newOrgId === currentOrgId) return;
    await switchOrganization(newOrgId);
}

async function switchOrganization(newOrgId) {
    const parsed = parseInt(newOrgId, 10);
    if (!parsed || parsed === currentOrgId) return false;

    const selector = document.getElementById('orgSelector');
    const user = window.authModule.getCurrentUser();

    try {
        // Prefer cached memberships from init — refetching on every switch trips staging rate
        // limits (browser reports CORS on preflight blocks).
        let memberOrgIds = Array.isArray(userOrgIds) ? userOrgIds.slice() : [];
        if (!memberOrgIds.length && user && user.id != null) {
            try {
                const userOrgs = await window.authModule.apiRequest(
                    `${window.authModule.API_BASE}/user-organizations/user/${user.id}`
                );
                memberOrgIds = userOrgs.filter((org) => org.is_member === 1).map((org) => org.id);
                userOrgIds = memberOrgIds.slice();
            } catch (membershipErr) {
                console.warn(
                    'Membership refresh failed; using selector org list:',
                    membershipErr && membershipErr.message ? membershipErr.message : membershipErr
                );
            }
        }

        const pickedOrg = organizations.find((o) => o.id === parsed);
        const isViewerOnly = pickedOrg && pickedOrg.accessMode === 'viewer';
        // Dev can open any org in the selector even when membership cache is empty/stale.
        const knownInSelector = !!pickedOrg;

        const commitOrgSwitchUi = () => {
            currentOrgId = parsed;
            if (selector) selector.value = String(parsed);
            setSessionActiveOrganization(parsed);
            applyCurrentOrgTitleBar();
            if (typeof window.updateEditPermissionsVisibility === 'function') {
                window.updateEditPermissionsVisibility();
            }
            if (typeof window.closeAllCircleMenus === 'function') window.closeAllCircleMenus();
        };

        if (!memberOrgIds.includes(parsed)) {
            if (isViewerOnly) {
                commitOrgSwitchUi();
                await reloadDataForOrganization({ showSwitchLoading: true });
                return true;
            }
            if (window.authModule.isDev()) {
                if (
                    !(await appConfirm(
                        `You are not a member of this organization. You can view data but cannot add annotations, photos, or documents. Switch anyway?`
                    ))
                ) {
                    if (selector) selector.value = currentOrgId || '';
                    return false;
                }
                commitOrgSwitchUi();
                await reloadDataForOrganization({ showSwitchLoading: true });
                return true;
            }
            // Non-dev: if org is in the selector list, allow switch even if membership
            // cache was empty due to a failed refresh (rate-limit / network).
            if (knownInSelector && memberOrgIds.length === 0) {
                commitOrgSwitchUi();
                await reloadDataForOrganization({ showSwitchLoading: true });
                return true;
            }
            if (typeof window.showToast === 'function') {
                window.showToast('You are not a member of this organization.', 'error');
            } else {
                await appAlert('You are not a member of this organization.');
            }
            if (selector) selector.value = currentOrgId || '';
            return false;
        }

        commitOrgSwitchUi();
        await reloadDataForOrganization({ showSwitchLoading: true });
        if (typeof window.showToast === 'function') {
            window.showToast(
                'Organization switched. Data has been reloaded for the selected organization.',
                'success'
            );
        } else {
            await appAlert('Organization switched. Data has been reloaded for the selected organization.');
        }
        return true;
    } catch (error) {
        console.error('Error switching organization:', error);
        hideOrgSwitchLoadingOverlay();
        if (typeof window.showToast === 'function') {
            window.showToast('Error switching organization: ' + error.message, 'error');
        } else {
            await appAlert(`Error switching organization: ${error.message}`);
        }
        if (selector) selector.value = currentOrgId || '';
        return false;
    }
}

// Apply navbar title from current organization's settings
function applyCurrentOrgTitleBar() {
    const org = organizations.find((o) => o.id === currentOrgId);
    const title = org && org.settings && org.settings.topBarTitle ? org.settings.topBarTitle : 'Locus';
    if (typeof window.applyTopBarTitle === 'function') {
        window.applyTopBarTitle(title);
    }
    if (typeof window.updateOrgMenuButtonLabel === 'function') {
        window.updateOrgMenuButtonLabel();
    }
    // Do not rebuild the full radial menu (and fan out menu-icon fetches) on every switch.
    if (typeof window.renderOrgCircleMenuIfOpen === 'function') {
        window.renderOrgCircleMenuIfOpen();
    } else if (typeof window.renderOrgCircleMenu === 'function') {
        window.renderOrgCircleMenu();
    }
}

/** Full-screen tint + theme loader while org switch waits for ticket list + map redraw. */
function orgSwitchLoaderHtml() {
    return typeof window.getAppLoaderHtml === 'function'
        ? window.getAppLoaderHtml({ decorative: true })
        : '<div class="app-loading-indicator" aria-hidden="true"></div>';
}

function showOrgSwitchLoadingOverlay() {
    let el = document.getElementById('orgSwitchLoadingOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'orgSwitchLoadingOverlay';
        el.setAttribute('aria-busy', 'true');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML =
            '<div class="org-switch-load-inner" role="status">' +
            orgSwitchLoaderHtml() +
            '<div class="org-switch-load-label">Loading…</div>' +
            '</div>';
        document.body.appendChild(el);
    }
    el.style.display = 'flex';
    if (typeof window.refreshAppLoaders === 'function') {
        window.refreshAppLoaders();
    }
}

function hideOrgSwitchLoadingOverlay() {
    const el = document.getElementById('orgSwitchLoadingOverlay');
    if (el) {
        el.style.display = 'none';
        el.setAttribute('aria-busy', 'false');
    }
}

/** Close ticket hub / popup / modals so org switch does not leave stale UI over another org's data. */
function closeTicketPanelsForOrgSwitch() {
    if (typeof window.closeTicketHubWindow === 'function') {
        window.closeTicketHubWindow({ skipPersist: true, force: true });
    }
    if (window.ticketRemarkBulkFlow && typeof window.ticketRemarkBulkFlow.closeForOrgSwitch === 'function') {
        window.ticketRemarkBulkFlow.closeForOrgSwitch();
    }
    if (window.ticketRenewalBulkFlow && typeof window.ticketRenewalBulkFlow.closeForOrgSwitch === 'function') {
        window.ticketRenewalBulkFlow.closeForOrgSwitch();
    }
    if (window.ticketBulkMapReview && typeof window.ticketBulkMapReview.closeForOrgSwitch === 'function') {
        window.ticketBulkMapReview.closeForOrgSwitch();
    }
    if (typeof window.closeTicketPopup === 'function') window.closeTicketPopup();
    if (typeof window.closeTicketAssigneesModal === 'function') window.closeTicketAssigneesModal();
    if (typeof window.closeProjectAssigneesModal === 'function') {
        void window.closeProjectAssigneesModal({ force: true });
    }
    if (typeof window.closeTicketImporter === 'function') window.closeTicketImporter();
    if (typeof window.resetTicketHubFilters === 'function') {
        window.resetTicketHubFilters({ forOrgSwitch: true });
    }
    if (typeof window.resetSidebarTicketListFiltersForOrgSwitch === 'function') {
        window.resetSidebarTicketListFiltersForOrgSwitch();
    }
}

// Reload all data for current organization
async function reloadDataForOrganization(opts) {
    const options = opts || {};
    const showSwitchLoading = options.showSwitchLoading === true;
    if (showSwitchLoading) {
        showOrgSwitchLoadingOverlay();
    }

    if (window.submitJobPoller && typeof window.submitJobPoller.onOrgChanged === 'function') {
        window.submitJobPoller.onOrgChanged();
    }
    if (
        window.dirtReportModule &&
        typeof window.dirtReportModule.invalidateDirtReportTicketLinkCache === 'function'
    ) {
        window.dirtReportModule.invalidateDirtReportTicketLinkCache();
    }
    if (typeof window.updateProfileOrgRoleDisplay === 'function') {
        window.updateProfileOrgRoleDisplay();
    }
    if (typeof window.updateEditPermissionsVisibility === 'function') {
        window.updateEditPermissionsVisibility();
    }
    if (typeof window.clearPublicMapSearchResultsFromMap === 'function') {
        window.clearPublicMapSearchResultsFromMap();
    } else if (typeof window.clearPublicMapSearchResults === 'function') {
        window.clearPublicMapSearchResults();
    }
    if (
        window.CORE_PRODUCT !== true &&
        window.aerialMapPanelModule &&
        typeof window.aerialMapPanelModule.syncTimeWarpModeUiEarly === 'function'
    ) {
        window.aerialMapPanelModule.syncTimeWarpModeUiEarly();
    }
    if (typeof window.clearFeedMapLayer === 'function') {
        window.clearFeedMapLayer();
    }
    closeTicketPanelsForOrgSwitch();
    // Feed workspace: drop previous org's ticket status bar immediately (hub is closed above,
    // so enterFeedHubMode alone would not run until the user reopens Ticket Hub).
    if (typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub()) {
        if (typeof window.parkMapStatusActionBtns === 'function') {
            window.parkMapStatusActionBtns();
        }
        const mapStats = document.getElementById('mapStatusFiltersStats');
        if (mapStats) mapStats.innerHTML = '';
        const mapWrap = document.getElementById('mapStatusFilters');
        if (mapWrap) {
            mapWrap.hidden = true;
            mapWrap.style.display = 'none';
        }
        const hubStats = document.getElementById('ticketHubStats');
        if (hubStats) {
            hubStats.innerHTML = '<div class="ticket-hub-td-muted">Loading feed stats…</div>';
        }
        const fanCards = document.getElementById('mapTopLeftStatFilterCards');
        if (fanCards) fanCards.innerHTML = '';
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
    }
    if (window.photosModule && window.photosModule.invalidateManageDataPhotosSync) {
        window.photosModule.invalidateManageDataPhotosSync();
    }
    if (window.documentsModule && window.documentsModule.invalidateManageDataDocumentsSync) {
        window.documentsModule.invalidateManageDataDocumentsSync();
    }
    if (window.reportedEventsStore && window.reportedEventsStore.invalidate) {
        window.reportedEventsStore.invalidate();
    }
    if (typeof window.applyDataHubDraftBadge === 'function') {
        window.applyDataHubDraftBadge();
    }
    if (typeof window.refreshDataHubDraftBadge === 'function') {
        void window.refreshDataHubDraftBadge();
    }
    if (window.annotationStorageModule && typeof window.annotationStorageModule.resetSavedDataLayersHydrationState === 'function') {
        window.annotationStorageModule.resetSavedDataLayersHydrationState();
    }

    // Clear all org-specific overlay layers from the map first so we get a fresh redraw
    if (window.layerManagerModule && window.layerManagerModule.clearMapOverlaysForOrgSwitch) {
        window.layerManagerModule.clearMapOverlaysForOrgSwitch();
    }
    if (window.photosModule && window.photosModule.clearPhotosFromMap) {
        window.photosModule.clearPhotosFromMap();
    }
    if (window.documentsModule && window.documentsModule.clearDocumentLocationsFromMap) {
        window.documentsModule.clearDocumentLocationsFromMap();
    }
    if (window.aerialMapsModule && window.aerialMapsModule.clearAllAerialMapsFromMap) {
        window.aerialMapsModule.clearAllAerialMapsFromMap();
    }

    let listDisplayReady = false;
    const onListDisplayReady = () => {
        if (listDisplayReady) return;
        listDisplayReady = true;
        if (showSwitchLoading) {
            hideOrgSwitchLoadingOverlay();
        }
    };

    const ticketsReloadPromise = (async () => {
        if (!window.ticketsModule || typeof window.ticketsModule.loadTicketsForCurrentOrg !== 'function') {
            onListDisplayReady();
            return;
        }
        try {
            await window.ticketsModule.loadTicketsForCurrentOrg({
                onListDisplayReady,
            });
        } catch (e) {
            console.error('Error loading tickets after org change:', e);
        } finally {
            onListDisplayReady();
        }
        // Feed workspace has no USAN account — skip poll after org switch.
        // Defer for normal orgs so usan-poll does not compete with the ticket list burst (stg 429 → fake CORS).
        const feedOrg =
            typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub();
        if (
            !feedOrg &&
            typeof window.ticketsModule.runIncrementalUsanListSyncChain === 'function'
        ) {
            const orgAtSchedule =
                typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
            window.setTimeout(() => {
                if (typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub()) {
                    return;
                }
                if (
                    orgAtSchedule != null &&
                    typeof getCurrentOrgId === 'function' &&
                    getCurrentOrgId() !== orgAtSchedule
                ) {
                    return;
                }
                void window.ticketsModule.runIncrementalUsanListSyncChain().catch((e) => {
                    console.warn('USAN list sync after org change:', e && e.message ? e.message : e);
                });
            }, 500);
        }
    })();

    const coreProduct = window.CORE_PRODUCT === true;
    const annotationsReloadPromise =
        !coreProduct && window.annotationStorageModule && window.annotationStorageModule.loadAnnotations
            ? Promise.resolve(window.annotationStorageModule.loadAnnotations()).catch((e) => {
                  console.error('Error loading annotations after org change:', e);
              })
            : Promise.resolve();

    const photosReloadPromise = (async () => {
        if (coreProduct) return;
        if (window.photosModule && window.photosModule.loadSavedPhotos) {
            window.photosModule.loadSavedPhotos();
        }
        if (window.photosModule && typeof window.photosModule.invalidateManageDataPhotosSync === 'function') {
            window.photosModule.invalidateManageDataPhotosSync();
        }
        if (window.photoMapLoaderModule) {
            if (typeof window.photoMapLoaderModule.clearPhotoMapCache === 'function') {
                window.photoMapLoaderModule.clearPhotoMapCache();
            }
            if (typeof window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport === 'function') {
                window.photoMapLoaderModule.scheduleFetchPhotoMapForViewport(true);
            }
        }
    })();

    if (!coreProduct && window.documentsModule && window.documentsModule.loadSavedDocuments) {
        window.documentsModule.loadSavedDocuments();
    }

    if (!coreProduct && window.aerialMapPanelModule && window.aerialMapPanelModule.onOrgChanged) {
        window.aerialMapPanelModule.onOrgChanged();
    }
    if (!coreProduct && window.aerialMapsModule && window.aerialMapsModule.clearSavedAerialMapsCache) {
        window.aerialMapsModule.clearSavedAerialMapsCache();
    }
    if (!coreProduct && window.aerialMapsModule && window.aerialMapsModule.clearAccessibleAerialCatalog) {
        window.aerialMapsModule.clearAccessibleAerialCatalog();
    }

    try {
        await ticketsReloadPromise;
        // Defer secondary map layers so org switch does not burst the API (stg 429 → fake CORS).
        window.setTimeout(function () {
            void annotationsReloadPromise;
            void photosReloadPromise;
        }, 100);
    } finally {
        if (showSwitchLoading) {
            hideOrgSwitchLoadingOverlay();
        }
    }

    if (typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub()) {
        if (typeof window.loadFeedMapMarkers === 'function') {
            void window.loadFeedMapMarkers();
        }
    } else if (typeof window.clearFeedMapLayer === 'function') {
        window.clearFeedMapLayer();
    }

    if (typeof window.ensureDesktopTicketHubOpen === 'function') {
        void window.ensureDesktopTicketHubOpen();
    }

    // Keep Ticket Hub chrome/queue + map status bar in sync after org switch.
    // Hub is usually closed by closeTicketPanelsForOrgSwitch; still refresh stats so the
    // map ticket status bar does not keep the previous contractor org's counts.
    const hubWinEarly = document.getElementById('ticketHubWindow');
    const hubOpen = !!(hubWinEarly && hubWinEarly.classList.contains('show'));
    if (typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub()) {
        if (hubOpen && typeof window.enterFeedHubMode === 'function') {
            void window.enterFeedHubMode();
        } else if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
    } else {
        if (typeof window.exitFeedHubMode === 'function') {
            window.exitFeedHubMode();
        }
        if (hubOpen && typeof window.renderHubTable === 'function') {
            window.renderHubTable();
        }
        if (typeof window.renderHubStats === 'function') {
            window.renderHubStats();
        }
    }

    // Open-count badge: skip immediate fetch on feed org (map-markers refresh covers it);
    // otherwise defer so it does not share the ticket-load rate-limit window.
    if (
        window.feedMapLayerModule &&
        typeof window.feedMapLayerModule.refreshFeedOpenCount === 'function' &&
        !(typeof canUseCurrentDevTicketHub === 'function' && canUseCurrentDevTicketHub())
    ) {
        window.setTimeout(() => {
            void window.feedMapLayerModule.refreshFeedOpenCount();
        }, 1000);
    }

    if (window.CORE_PRODUCT !== true && window.refreshDataWindow) {
        window.refreshDataWindow();
    }
    if (
        hubWinEarly &&
        hubWinEarly.classList.contains('show') &&
        typeof window.syncTicketHubRenewButtonVisibility === 'function'
    ) {
        window.syncTicketHubRenewButtonVisibility();
    }
    if (
        hubWinEarly &&
        hubWinEarly.classList.contains('show') &&
        typeof window.syncTicketHubBulkDeleteVisibility === 'function'
    ) {
        window.syncTicketHubBulkDeleteVisibility();
    }
    if (
        hubWinEarly &&
        hubWinEarly.classList.contains('show') &&
        typeof window.syncTicketHubAnalyticsTabVisibility === 'function'
    ) {
        window.syncTicketHubAnalyticsTabVisibility();
    }
}

// Get current org from selector (single source of truth for "current org")
function getCurrentOrgId() {
    if (currentOrgId != null) return currentOrgId;
    const user = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
    if (user && user.organizationId != null) {
        currentOrgId = user.organizationId;
        return currentOrgId;
    }
    const selector = document.getElementById('orgSelector');
    if (selector && selector.value) {
        const v = parseInt(selector.value, 10);
        if (!isNaN(v)) currentOrgId = v;
    }
    return currentOrgId;
}

// Whether the user can add/edit data in the current org (must be a member)
function canEditCurrentOrg() {
    const orgId = getCurrentOrgId();
    if (!orgId) return false;
    if (isCurrentOrgPublicCatalogViewer()) return false;
    return userOrgIds.includes(orgId);
}

function isCurrentOrgPublicCatalogViewer() {
    const org = getCurrentOrganization();
    if (!org) return false;
    // Non-dev users get accessMode: 'viewer' for the catalog org when they are not members.
    if (org.accessMode === 'viewer') return true;
    // Dev users and anyone assigned to the catalog org select it with accessMode: 'member' (or none).
    return !!org.isPublicCatalog;
}

function getCurrentOrganization() {
    const orgId = getCurrentOrgId();
    if (!orgId) return null;
    return organizations.find(o => Number(o.id) === Number(orgId)) || null;
}

function isCurrentOrgDevTicketHub() {
    const org = getCurrentOrganization();
    return !!(org && org.isDevTicketHub);
}

function canUseCurrentDevTicketHub() {
    if (window.CORE_PRODUCT === true) return false;
    return !!(
        window.authModule &&
        typeof window.authModule.isDev === 'function' &&
        window.authModule.isDev() &&
        isCurrentOrgDevTicketHub()
    );
}

// Export functions
window.initOrgSelector = initOrgSelector;
window.reloadDataForOrganization = reloadDataForOrganization;
window.getCurrentOrgId = getCurrentOrgId;
window.canEditCurrentOrg = canEditCurrentOrg;
window.isCurrentOrgPublicCatalogViewer = isCurrentOrgPublicCatalogViewer;
window.getCurrentOrganization = getCurrentOrganization;
window.isCurrentOrgDevTicketHub = isCurrentOrgDevTicketHub;
window.canUseCurrentDevTicketHub = canUseCurrentDevTicketHub;
function getOrganizations() {
    return organizations;
}

window.getOrganizations = getOrganizations;
window.orgSelectorModule = {
    getCurrentOrgId,
    canEditCurrentOrg,
    reloadDataForOrganization,
    getOrganizations,
    getCurrentOrganization,
    isCurrentOrgDevTicketHub,
    canUseCurrentDevTicketHub,
    switchOrganization,
};

