// Annotation Storage module - localStorage + server sync (per organization)

// Annotation state (shared with other modules)
let annotations = [];
let savedDataLayers = [];
let savedDataLayersHydrated = false;
let savedDataLayersLoadPromise = null;

// Helper: resolve current org ID (do not name getCurrentOrgId or we overwrite global and cause recursion)
function resolveCurrentOrgId() {
    if (typeof window.getCurrentOrgId === 'function') {
        return window.getCurrentOrgId() || null;
    }
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        return user.organizationId || user.default_organization_id || null;
    }
    return null;
}

function resetSavedDataLayersHydrationState() {
    savedDataLayersHydrated = false;
    savedDataLayersLoadPromise = null;
}

/**
 * Workspace map data layers (saved layers and file imports) should not reappear on the map after
 * a full page reload — the user loads them explicitly from the Data window.
 */
function stripSavedDataLayerMapPresenceOnLoad() {
    const isMapDl = window.layerManagerModule && typeof window.layerManagerModule.isSavedMapDataLayer === 'function'
        ? window.layerManagerModule.isSavedMapDataLayer
        : function fallbackIsSavedMapDataLayer(layer) {
            if (!layer || layer.id == null || !Array.isArray(layer.annotations)) return false;
            if (layer.source === 'uploaded') return true;
            if (layer.source === 'saved' || layer.source === 'annotations') return true;
            if (layer.source == null || layer.source === '') return true;
            return false;
        };
    savedDataLayers = savedDataLayers.map(layer => {
        if (!isMapDl(layer)) return layer;
        return { ...layer, isVisible: false, listInLayerPanel: false };
    });
}

function triggerPostLoadMapEffects() {
    if (window.annotationRendererModule && window.annotationRendererModule.renderAnnotations) {
        window.annotationRendererModule.renderAnnotations();
    }
    if (window.map) {
        window.map.whenReady(function () {
            if (window.layerManagerModule && window.layerManagerModule.renderDataLayer) {
                const isMapDl = window.layerManagerModule.isSavedMapDataLayer;
                savedDataLayers.forEach(layer => {
                    const ok = typeof isMapDl === 'function' ? isMapDl(layer) : layer.source === 'uploaded' || !layer.source;
                    if (ok && layer.isVisible !== false) {
                        window.layerManagerModule.renderDataLayer(layer);
                    }
                });
                if (window.layerManagerModule.updateLayerControlOverlays) {
                    window.layerManagerModule.updateLayerControlOverlays();
                }
            }
        });
    }
}

function loadFromLocalStorageForOrg(currentOrgId) {
    annotations = [];
    savedDataLayers = [];
    if (
        window.offlineCacheTtl &&
        typeof window.offlineCacheTtl.isMapWorkspaceCacheFresh === 'function' &&
        !window.offlineCacheTtl.isMapWorkspaceCacheFresh(currentOrgId)
    ) {
        return;
    }
    try {
        const stored = localStorage.getItem('mapAnnotations');
        if (stored) {
            const allAnnotations = JSON.parse(stored);
            annotations = allAnnotations.filter(ann => ann.organizationId === currentOrgId);
        }
    } catch (error) {
        console.error('Error loading annotations:', error);
    }
    try {
        const storedLayers = localStorage.getItem('savedDataLayers');
        if (storedLayers) {
            const allLayers = JSON.parse(storedLayers);
            savedDataLayers = allLayers.filter(layer => layer.organizationId === currentOrgId);
        }
    } catch (error) {
        console.error('Error loading saved data layers:', error);
    }
}

function mirrorStateToLocalStorage(currentOrgId) {
    if (currentOrgId == null) return;
    try {
        const stored = localStorage.getItem('mapAnnotations');
        let allAnnotations = stored ? JSON.parse(stored) : [];
        allAnnotations = allAnnotations.filter(ann => ann.organizationId !== currentOrgId);
        const annWithOrg = annotations.map(ann => ({
            ...ann,
            organizationId: currentOrgId
        }));
        allAnnotations = allAnnotations.concat(annWithOrg);
        localStorage.setItem('mapAnnotations', JSON.stringify(allAnnotations));

        const storedLayers = localStorage.getItem('savedDataLayers');
        let allLayers = storedLayers ? JSON.parse(storedLayers) : [];
        allLayers = allLayers.filter(layer => layer.organizationId !== currentOrgId);
        const layersWithOrg = savedDataLayers.map(layer => ({
            ...layer,
            organizationId: currentOrgId
        }));
        allLayers = allLayers.concat(layersWithOrg);
        localStorage.setItem('savedDataLayers', JSON.stringify(allLayers));
        if (window.offlineCacheTtl && typeof window.offlineCacheTtl.touchMapWorkspaceCache === 'function') {
            window.offlineCacheTtl.touchMapWorkspaceCache(currentOrgId);
        }
    } catch (error) {
        console.error('Error mirroring map workspace to localStorage:', error);
    }
}

async function pushMapWorkspaceToServer(scope) {
    const currentOrgId = resolveCurrentOrgId();
    if (!currentOrgId || !window.authModule || !window.authModule.isAuthenticated() || !window.authModule.apiRequest) {
        return;
    }
    if (window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline()) {
        return;
    }
    const writeScope = scope === 'layers' ? 'layers' : scope === 'all' ? 'all' : 'annotations';
    const q = `?organizationId=${encodeURIComponent(String(currentOrgId))}`;
    const body = {};

    if (writeScope === 'annotations' || writeScope === 'all') {
        body.annotations = annotations.map(ann => ({
            ...ann,
            organizationId: ann.organizationId != null ? ann.organizationId : currentOrgId
        }));
    }
    if (writeScope === 'layers' || writeScope === 'all') {
        const layersToSave = savedDataLayers.filter((layer) => !layer.shared);
        body.savedDataLayers = layersToSave.map(layer => ({
            ...layer,
            organizationId: layer.organizationId != null ? layer.organizationId : currentOrgId
        }));
    }

    await window.authModule.apiRequest(`${window.authModule.API_BASE}/data/map-workspace${q}`, {
        method: 'PUT',
        body: JSON.stringify(body)
    });
}

async function fetchSavedDataLayersFromServer(currentOrgId) {
    const q = `?organizationId=${encodeURIComponent(String(currentOrgId))}&include=layers`;
    const data = await window.authModule.apiRequest(`${window.authModule.API_BASE}/data/map-workspace${q}`);
    const serverLayers = Array.isArray(data.savedDataLayers) ? data.savedDataLayers : [];
    savedDataLayers = serverLayers;
    stripSavedDataLayerMapPresenceOnLoad();
    mirrorStateToLocalStorage(currentOrgId);
    savedDataLayersHydrated = true;
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
    return savedDataLayers;
}

async function ensureSavedDataLayersLoaded() {
    const currentOrgId = resolveCurrentOrgId();
    if (savedDataLayersHydrated) {
        return savedDataLayers;
    }
    if (!currentOrgId || !window.authModule || !window.authModule.isAuthenticated() || !window.authModule.apiRequest) {
        savedDataLayersHydrated = true;
        return savedDataLayers;
    }
    if (savedDataLayersLoadPromise) {
        return savedDataLayersLoadPromise;
    }
    savedDataLayersLoadPromise = (async () => {
        try {
            await fetchSavedDataLayersFromServer(currentOrgId);
        } catch (e) {
            console.warn('Saved data layers sync from server failed, using local cache', e);
            loadFromLocalStorageForOrg(currentOrgId);
            stripSavedDataLayerMapPresenceOnLoad();
            savedDataLayersHydrated = true;
        } finally {
            savedDataLayersLoadPromise = null;
        }
        return savedDataLayers;
    })();
    return savedDataLayersLoadPromise;
}

// Load from localStorage and server (server wins when a row exists; migrate local-only data once)
async function loadAnnotations() {
    const currentOrgId = resolveCurrentOrgId();
    resetSavedDataLayersHydrationState();
    savedDataLayers = [];

    if (window.authModule && window.authModule.isAuthenticated() && window.authModule.apiRequest && currentOrgId) {
        try {
            const q = `?organizationId=${encodeURIComponent(String(currentOrgId))}&include=annotations`;
            const data = await window.authModule.apiRequest(`${window.authModule.API_BASE}/data/map-workspace${q}`);
            const serverAnnotations = Array.isArray(data.annotations) ? data.annotations : [];
            const savedDataLayersCount =
                data.savedDataLayersCount != null && Number.isFinite(Number(data.savedDataLayersCount))
                    ? Number(data.savedDataLayersCount)
                    : 0;
            const hasServerRow = data.updatedAt != null;
            const serverLooksEmpty = serverAnnotations.length === 0 && savedDataLayersCount === 0;

            if (!hasServerRow && serverLooksEmpty) {
                loadFromLocalStorageForOrg(currentOrgId);
                stripSavedDataLayerMapPresenceOnLoad();
                const localHasData = annotations.length > 0 || savedDataLayers.length > 0;
                if (localHasData) {
                    mirrorStateToLocalStorage(currentOrgId);
                    savedDataLayersHydrated = savedDataLayers.length > 0;
                    try {
                        await pushMapWorkspaceToServer('all');
                    } catch (migrateErr) {
                        console.warn('Could not migrate map workspace to server:', migrateErr);
                    }
                }
            } else {
                annotations = serverAnnotations;
                stripSavedDataLayerMapPresenceOnLoad();
                mirrorStateToLocalStorage(currentOrgId);
            }

            if (window.offlineCacheTtl && typeof window.offlineCacheTtl.touchMapWorkspaceCache === 'function') {
                window.offlineCacheTtl.touchMapWorkspaceCache(currentOrgId);
            }

            triggerPostLoadMapEffects();
            return;
        } catch (e) {
            console.warn('Map workspace sync from server failed, using local cache', e);
        }
    }

    loadFromLocalStorageForOrg(currentOrgId);
    stripSavedDataLayerMapPresenceOnLoad();
    savedDataLayersHydrated = savedDataLayers.length > 0;
    triggerPostLoadMapEffects();
}

// Save data layers to localStorage (merge with other orgs' data)
function saveDataLayers() {
    try {
        const currentOrgId = resolveCurrentOrgId();
        const storedLayers = localStorage.getItem('savedDataLayers');
        let allLayers = storedLayers ? JSON.parse(storedLayers) : [];

        allLayers = allLayers.filter(layer => layer.organizationId !== currentOrgId);
        const layersWithOrgId = savedDataLayers.map(layer => ({
            ...layer,
            organizationId: currentOrgId
        }));
        allLayers = allLayers.concat(layersWithOrgId);

        localStorage.setItem('savedDataLayers', JSON.stringify(allLayers));
        if (window.offlineCacheTtl && typeof window.offlineCacheTtl.touchMapWorkspaceCache === 'function') {
            window.offlineCacheTtl.touchMapWorkspaceCache(currentOrgId);
        }
    } catch (error) {
        console.error('Error saving data layers:', error);
    }
    pushMapWorkspaceToServer('layers').catch(err => console.warn('Map workspace server sync failed:', err));
}

// Save annotations to localStorage (merge with other orgs' data)
function saveAnnotations() {
    try {
        const currentOrgId = resolveCurrentOrgId();
        const stored = localStorage.getItem('mapAnnotations');
        let allAnnotations = stored ? JSON.parse(stored) : [];

        allAnnotations = allAnnotations.filter(ann => ann.organizationId !== currentOrgId);
        const annotationsWithOrgId = annotations.map(ann => ({
            ...ann,
            organizationId: currentOrgId
        }));
        allAnnotations = allAnnotations.concat(annotationsWithOrgId);

        localStorage.setItem('mapAnnotations', JSON.stringify(allAnnotations));
        if (window.offlineCacheTtl && typeof window.offlineCacheTtl.touchMapWorkspaceCache === 'function') {
            window.offlineCacheTtl.touchMapWorkspaceCache(currentOrgId);
        }
    } catch (error) {
        console.error('Error saving annotations:', error);
    }
    pushMapWorkspaceToServer('annotations').catch(err => console.warn('Map workspace server sync failed:', err));
}

// Internal delete function without confirmation (for bulk operations)
function deleteAnnotationInternal(id) {
    annotations = annotations.filter(a => a.id !== id);
    saveAnnotations();

    if (window.annotationRendererModule && window.annotationRendererModule.renderAnnotations) {
        window.annotationRendererModule.renderAnnotations();
    }

    if (window.layerManagerModule && window.layerManagerModule.updateLayerControlOverlays) {
        window.layerManagerModule.updateLayerControlOverlays();
    }

    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}

function canAdminLayerPublicFlag() {
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    if (!orgId || !window.authModule) return false;
    if (window.authModule.isDev()) return true;
    const user = window.authModule.getCurrentUser();
    return Array.isArray(user && user.adminOrganizationIds) && user.adminOrganizationIds.includes(orgId);
}

async function setLayerPublicFlag(layerId, isPublic) {
    if (!canAdminLayerPublicFlag()) {
        throw new Error('Only organization admins can change public layer sharing.');
    }
    const orgId = window.getCurrentOrgId();
    await window.authModule.apiRequest(
        `${window.authModule.API_BASE}/data/map-workspace/layers/${encodeURIComponent(String(layerId))}/public`,
        {
            method: 'PATCH',
            body: JSON.stringify({ organizationId: orgId, isPublic: !!isPublic }),
        }
    );
    const layer = savedDataLayers.find((l) => String(l.id) === String(layerId));
    if (layer) layer.isPublic = !!isPublic;
}

// Public delete function with confirmation (for single-item deletes)
async function deleteAnnotation(id) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        await appAlert('You do not have permission to delete data in this organization.');
        return;
    }
    if (await appConfirm('Are you sure you want to delete this annotation?')) {
        deleteAnnotationInternal(id);
    }
}

// Export for use in other modules
window.annotationStorageModule = {
    get annotations() { return annotations; },
    set annotations(value) { annotations = value; },
    get savedDataLayers() { return savedDataLayers; },
    set savedDataLayers(value) { savedDataLayers = value; },
    get savedDataLayersHydrated() { return savedDataLayersHydrated; },
    loadAnnotations,
    ensureSavedDataLayersLoaded,
    resetSavedDataLayersHydrationState,
    saveAnnotations,
    saveDataLayers,
    deleteAnnotationInternal,
    deleteAnnotation,
    setLayerPublicFlag,
    canAdminLayerPublicFlag,
};

window.deleteAnnotation = deleteAnnotation;
