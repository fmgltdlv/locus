// Mobile map tools: fixed top-right Layers + My Location; bottom-right FAB + bubble menu (≤768px).

const MAP_TOOLS_MOBILE_MQ = window.matchMedia('(max-width: 768px)');

const DESKTOP_LAYER_PANEL_STYLE =
    'background: white; border: 1px solid #ccc; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.3); padding: 8px; min-width: 180px; color: #000;';

let anchorEl = null;
let fabEl = null;
let topRightEl = null;
let layersTopBtnEl = null;
let locationTopBtnEl = null;
let backdropEl = null;
let bubblesEl = null;
let layersModalEl = null;
let layersModalBackdropEl = null;
let layersWrapEl = null;
let finishChipEl = null;
let cancelChipEl = null;
let cameraBtnEl = null;
let measureBarEl = null;
let menuOpen = false;
let layersModalOpen = false;
let mapClickCloseBound = false;
let statePollInterval = null;
let layoutSyncScheduled = false;

function isMapToolsMobileLayout() {
    return MAP_TOOLS_MOBILE_MQ.matches;
}

function isFinishDrawingVisible() {
    return !!(window.drawingModule && window.drawingModule.canFinishCurrentDrawing &&
        window.drawingModule.canFinishCurrentDrawing());
}

function isCreateTicketMapDrawActive() {
    return (
        typeof window.isCreateTicketMapDrawingActive === 'function' &&
        window.isCreateTicketMapDrawingActive()
    );
}

function isCancelChipNeeded() {
    if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
    if (window.documentsModule && window.documentsModule.documentLocationMode) return true;
    if (isCreateTicketMapDrawActive()) return true;
    return false;
}

function isMeasureActive() {
    return !!(window.measureModule && window.measureModule.measureMode);
}

function syncMeasureBar() {
    if (!measureBarEl) return;
    measureBarEl.hidden = !(isMapToolsMobileLayout() && isMeasureActive());
}

function syncMobileActionChipPosition() {
    if (!isMapToolsMobileLayout()) return;
    const cameraBtn = document.getElementById('mapToolsMobileCameraBtn');
    if (!cameraBtn) return;
    const gap = 8;
    const rect = cameraBtn.getBoundingClientRect();
    const bottomPx = Math.max(0, Math.round(window.innerHeight - rect.top + gap));
    const bottom = bottomPx + 'px';
    if (finishChipEl) finishChipEl.style.bottom = bottom;
    if (cancelChipEl) cancelChipEl.style.bottom = bottom;
}

function syncActiveChips() {
    if (!isMapToolsMobileLayout()) {
        if (finishChipEl) finishChipEl.hidden = true;
        if (cancelChipEl) cancelChipEl.hidden = true;
        syncMeasureBar();
        return;
    }

    const showFinish = isFinishDrawingVisible();
    const showCancel = isCancelChipNeeded();

    if (finishChipEl) finishChipEl.hidden = !showFinish;
    if (cancelChipEl) {
        cancelChipEl.hidden = !showCancel;
        cancelChipEl.classList.toggle('cancel-drawing-mobile-chip--solo', showCancel && !showFinish);
    }
    if (showFinish || showCancel) {
        syncMobileActionChipPosition();
    }
    syncMeasureBar();
}

function reparentLayerPanelToMobile() {
    const panel = window.layerControlPanel;
    if (!panel || !layersWrapEl) return;
    if (panel.parentElement === layersWrapEl) return;
    layersWrapEl.appendChild(panel);
    panel.classList.add('map-tools-mobile-layer-panel');
    panel.style.cssText =
        'background: transparent; border: none; box-shadow: none; padding: 0; min-width: 0; width: 100%; color: inherit;';
}

function reparentLayerPanelToDesktop() {
    const panel = window.layerControlPanel;
    const container = window.layerControlPanelContainer;
    if (!panel || !container) return;
    if (panel.parentElement === container) return;
    container.appendChild(panel);
    panel.classList.remove('map-tools-mobile-layer-panel');
    panel.style.cssText = DESKTOP_LAYER_PANEL_STYLE;
}

function syncLayersTopButtonActive() {
    if (layersTopBtnEl) {
        layersTopBtnEl.classList.toggle('map-tools-mobile-top-right-btn--active', layersModalOpen);
        layersTopBtnEl.setAttribute('aria-expanded', layersModalOpen ? 'true' : 'false');
    }
}

function openLayersModal() {
    if (!layersModalEl || !layersModalBackdropEl || !isMapToolsMobileLayout()) return;
    layersModalOpen = true;
    reparentLayerPanelToMobile();
    layersModalEl.classList.add('map-tools-mobile-layers-modal--open');
    layersModalBackdropEl.classList.add('map-tools-mobile-layers-modal-backdrop--visible');
    layersModalEl.setAttribute('aria-hidden', 'false');
    layersModalBackdropEl.setAttribute('aria-hidden', 'false');
    syncLayersTopButtonActive();
}

function closeLayersModal() {
    if (!layersModalEl || !layersModalBackdropEl) return;
    layersModalOpen = false;
    layersModalEl.classList.remove('map-tools-mobile-layers-modal--open');
    layersModalBackdropEl.classList.remove('map-tools-mobile-layers-modal-backdrop--visible');
    layersModalEl.setAttribute('aria-hidden', 'true');
    layersModalBackdropEl.setAttribute('aria-hidden', 'true');
    syncLayersTopButtonActive();
}

function openMapToolsMobileMenu() {
    if (!anchorEl || !backdropEl || !isMapToolsMobileLayout()) return;
    menuOpen = true;
    anchorEl.classList.add('map-tools-mobile-menu--open');
    backdropEl.classList.add('map-tools-mobile-backdrop--visible');
    backdropEl.setAttribute('aria-hidden', 'false');
    if (bubblesEl) bubblesEl.setAttribute('aria-hidden', 'false');
    if (fabEl) fabEl.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(syncMobileActionChipPosition);
}

function closeMapToolsMobileMenu() {
    if (!anchorEl || !backdropEl) return;
    menuOpen = false;
    anchorEl.classList.remove('map-tools-mobile-menu--open');
    backdropEl.classList.remove('map-tools-mobile-backdrop--visible');
    backdropEl.setAttribute('aria-hidden', 'true');
    if (bubblesEl) bubblesEl.setAttribute('aria-hidden', 'true');
    if (fabEl) fabEl.setAttribute('aria-expanded', 'false');
}

function openMapToolsMobileSheet() {
    openMapToolsMobileMenu();
}

function closeMapToolsMobileSheet() {
    closeMapToolsMobileMenu();
}

function handleToolAction(actionId) {
    if (actionId === 'layers' || actionId === 'createTicket') {
        closeMapToolsMobileMenu();
        return;
    }
    const opensFilePicker = actionId === 'importFiles' || actionId === 'importPhotos';
    if (typeof window.runMapToolAction === 'function') {
        window.runMapToolAction(actionId);
    }
    if (opensFilePicker) {
        requestAnimationFrame(function () {
            closeMapToolsMobileMenu();
            syncActiveChips();
        });
    } else {
        closeMapToolsMobileMenu();
        syncActiveChips();
    }
}

function handleCancelChipClick() {
    if (window.drawingModule && window.drawingModule.currentDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    } else if (
        window.documentsModule &&
        window.documentsModule.documentLocationMode &&
        typeof window.documentsModule.cancelDocumentLocationDrawing === 'function'
    ) {
        window.documentsModule.cancelDocumentLocationDrawing();
    } else if (
        isCreateTicketMapDrawActive() &&
        typeof window.createTicketWizardCancelPolygonDrawingIfActive === 'function'
    ) {
        window.createTicketWizardCancelPolygonDrawingIfActive();
    }
    syncActiveChips();
}

function handleFinishChipClick() {
    if (window.drawingModule && window.drawingModule.canFinishCurrentDrawing &&
        window.drawingModule.canFinishCurrentDrawing()) {
        window.drawingModule.finishCurrentDrawing();
    }
    syncActiveChips();
}

function handleStopMeasureClick() {
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    } else if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    syncActiveChips();
}

function mobileMapIcon(name, fallback) {
    const icons = window.mapIcons;
    return icons ? icons.icon(name, 20) : fallback;
}

function bubbleButton(actionId, icon, label, editOnly) {
    const editAttr = editOnly ? ' data-map-tools-edit-only' : '';
    return (
        '<button type="button" class="map-tools-mobile-bubble"' +
        editAttr +
        ' data-map-tool-action="' +
        actionId +
        '" data-action="' +
        actionId +
        '" aria-label="' +
        label +
        '">' +
        '<span class="map-tools-mobile-bubble-label">' +
        label +
        '</span>' +
        '<span class="map-tools-mobile-bubble-icon" aria-hidden="true">' +
        icon +
        '</span>' +
        '</button>'
    );
}

function getMobileFabBubbleActions() {
    const mod = window.mapToolActionsModule;
    if (mod && mod.MAP_TOOL_LAYOUT && mod.MAP_TOOL_LAYOUT.mobileFabBubbles) {
        return mod.MAP_TOOL_LAYOUT.mobileFabBubbles;
    }
    return ['importFiles', 'measure', 'drawPolygon', 'drawLine', 'drawPoint'];
}

function buildMobileFabBubblesHtml() {
    const mod = window.mapToolActionsModule;
    return getMobileFabBubbleActions()
        .map(function (actionId) {
            const def = mod && mod.getMapToolAction ? mod.getMapToolAction(actionId) : null;
            const label = def ? def.fabLabel || def.label : actionId;
            const iconName = def ? def.icon : 'document';
            const editOnly = def ? !!def.editOnly : true;
            return bubbleButton(actionId, mobileMapIcon(iconName, '•'), label, editOnly);
        })
        .join('');
}

function createStandaloneCameraButton() {
    const mod = window.mapToolActionsModule;
    const def = mod && mod.getMapToolAction ? mod.getMapToolAction('openCamera') : null;
    const labelText = def ? def.fabLabel || def.label : 'Open camera';
    const row = document.createElement('div');
    row.className = 'map-tools-mobile-camera-row';
    row.setAttribute('data-map-tools-edit-only', '');
    row.setAttribute('data-map-tool-action', 'openCamera');

    const label = document.createElement('span');
    label.className = 'map-tools-mobile-camera-label map-tools-mobile-bubble-label';
    label.textContent = labelText;
    label.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'mapToolsMobileCameraBtn';
    btn.className = 'map-tools-mobile-camera-btn';
    btn.setAttribute('data-map-tools-edit-only', '');
    btn.setAttribute('aria-label', def ? def.label : 'Take photo');
    btn.setAttribute('title', def ? def.title || def.label : 'Take photo');
    btn.innerHTML = mobileMapIcon('camera', '📷');
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof window.runMapToolAction === 'function') {
            window.runMapToolAction('openCamera');
        }
    });

    row.appendChild(label);
    row.appendChild(btn);
    return row;
}

function bindMapClickClose() {
    const map = window.map;
    if (!map || mapClickCloseBound) return;
    mapClickCloseBound = true;
    map.on('click', function () {
        if (menuOpen) closeMapToolsMobileMenu();
    });
}

function relocateMapMenuFabToTopRight() {
    const fab = document.getElementById('mapTopLeftMenuFab');
    if (!fab) return;
    // Account ☰ is already in the top-right stack; keep this FAB parked.
    fab.hidden = true;
    fab.classList.remove('map-tools-mobile-top-right-btn', 'map-tools-mobile-top-right-btn--active');
}

function ensureMapToolsMobileDom() {
    if (anchorEl) return;

    const mapRoot = document.querySelector('.map-container');
    if (!mapRoot) return;

    backdropEl = document.createElement('div');
    backdropEl.className = 'map-tools-mobile-backdrop';
    backdropEl.setAttribute('aria-hidden', 'true');
    backdropEl.addEventListener('click', closeMapToolsMobileMenu);
    mapRoot.appendChild(backdropEl);

    topRightEl = document.createElement('div');
    topRightEl.id = 'mapToolsMobileTopRight';
    topRightEl.className = 'map-tools-mobile-top-right';
    topRightEl.innerHTML =
        '<button type="button" id="mobileZoomInButton" class="map-tools-mobile-top-right-btn" ' +
        'title="Zoom in" aria-label="Zoom in">+</button>' +
        '<button type="button" id="mobileZoomOutButton" class="map-tools-mobile-top-right-btn" ' +
        'title="Zoom out" aria-label="Zoom out">−</button>' +
        '<button type="button" id="mobileLocationButton" class="map-tools-mobile-top-right-btn mobile-location-button" ' +
        'title="My location" aria-label="My location">' +
        mobileMapIcon('location', '◎') +
        '</button>' +
        '<button type="button" id="mobileMeasureButton" class="map-tools-mobile-top-right-btn map-tools-mobile-measure-top-btn map-tool-action-hidden" ' +
        'title="Measure" aria-label="Measure" aria-hidden="true">' +
        mobileMapIcon('measure', '📏') +
        '</button>';
    mapRoot.appendChild(topRightEl);
    relocateMapMenuFabToTopRight();
    if (typeof window.relocateProfileMenuToToolbar === 'function') {
        window.relocateProfileMenuToToolbar();
    }

    layersTopBtnEl = null;
    locationTopBtnEl = topRightEl.querySelector('#mobileLocationButton');
    const zoomInBtnEl = topRightEl.querySelector('#mobileZoomInButton');
    const zoomOutBtnEl = topRightEl.querySelector('#mobileZoomOutButton');
    const measureTopBtnEl = topRightEl.querySelector('#mobileMeasureButton');

    function zoomMapBy(delta) {
        const m = window.map;
        if (!m) return;
        if (delta > 0 && typeof m.zoomIn === 'function') m.zoomIn();
        else if (delta < 0 && typeof m.zoomOut === 'function') m.zoomOut();
    }
    if (zoomInBtnEl) {
        zoomInBtnEl.addEventListener('click', function (e) {
            e.stopPropagation();
            zoomMapBy(1);
        });
    }
    if (zoomOutBtnEl) {
        zoomOutBtnEl.addEventListener('click', function (e) {
            e.stopPropagation();
            zoomMapBy(-1);
        });
    }

    const LOCATION_LONG_PRESS_MS = 500;
    const LOCATION_LONG_PRESS_MOVE_PX = 12;
    let locationPressState = null;
    let suppressLocationClickUntil = 0;
    let suppressLocationMenuUntil = 0;

    function clearLocationPressState() {
        if (locationPressState && locationPressState.timer) {
            clearTimeout(locationPressState.timer);
        }
        locationPressState = null;
    }

    function openLocationSourceMenuFromGesture() {
        const now = Date.now();
        if (now < suppressLocationMenuUntil) return;
        suppressLocationMenuUntil = now + 800;
        suppressLocationClickUntil = now + 800;
        if (navigator.vibrate) {
            try {
                navigator.vibrate(10);
            } catch (_) {
                /* ignore */
            }
        }
        if (typeof window.showUserLocationSourceMenu === 'function') {
            void window.showUserLocationSourceMenu('mobile');
        }
    }

    locationTopBtnEl.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        clearLocationPressState();
        const startX = e.clientX;
        const startY = e.clientY;
        locationPressState = {
            pointerId: e.pointerId,
            startX: startX,
            startY: startY,
            fired: false,
            timer: setTimeout(function () {
                if (!locationPressState) return;
                locationPressState.fired = true;
                openLocationSourceMenuFromGesture();
            }, LOCATION_LONG_PRESS_MS),
        };
        try {
            locationTopBtnEl.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    });
    locationTopBtnEl.addEventListener('pointermove', function (e) {
        if (!locationPressState || locationPressState.pointerId !== e.pointerId) return;
        const dx = e.clientX - locationPressState.startX;
        const dy = e.clientY - locationPressState.startY;
        if (Math.hypot(dx, dy) > LOCATION_LONG_PRESS_MOVE_PX) {
            clearLocationPressState();
        }
    });
    locationTopBtnEl.addEventListener('pointerup', function (e) {
        if (!locationPressState || locationPressState.pointerId !== e.pointerId) return;
        const fired = locationPressState.fired;
        clearLocationPressState();
        if (fired) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    locationTopBtnEl.addEventListener('pointercancel', function (e) {
        if (!locationPressState || locationPressState.pointerId !== e.pointerId) return;
        clearLocationPressState();
    });
    locationTopBtnEl.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openLocationSourceMenuFromGesture();
    });

    locationTopBtnEl.addEventListener('click', function (e) {
        e.stopPropagation();
        if (Date.now() < suppressLocationClickUntil) {
            e.preventDefault();
            return;
        }
        if (typeof window.isUserLiveLocationActive === 'function' && window.isUserLiveLocationActive()) {
            if (typeof window.stopMobileLiveLocation === 'function') {
                window.stopMobileLiveLocation();
            }
        } else if (typeof window.useCurrentLocationMobile === 'function') {
            window.useCurrentLocationMobile();
        }
    });

    if (measureTopBtnEl) {
        measureTopBtnEl.addEventListener('click', function (e) {
            e.stopPropagation();
            handleToolAction('measure');
        });
    }

    topRightEl.addEventListener('click', function (e) {
        e.stopPropagation();
    });

    anchorEl = document.createElement('div');
    anchorEl.id = 'mapToolsMobileAnchor';
    anchorEl.className = 'map-tools-mobile-anchor';
    anchorEl.innerHTML =
        '<div class="map-tools-mobile-bubbles" aria-hidden="true">' + buildMobileFabBubblesHtml() + '</div>';

    if (window.CORE_PRODUCT !== true) {
        cameraBtnEl = createStandaloneCameraButton();
        anchorEl.appendChild(cameraBtnEl);
    }

    fabEl = document.createElement('button');
    fabEl.type = 'button';
    fabEl.id = 'mapToolsMobileFab';
    fabEl.className = 'map-tools-mobile-fab';
    fabEl.setAttribute('aria-label', 'Map tools');
    fabEl.setAttribute('aria-expanded', 'false');
    fabEl.setAttribute('title', 'Map tools');
    const hammerIcon =
        window.mapIcons && typeof window.mapIcons.hammer === 'function' ? window.mapIcons.hammer(22) : '';
    fabEl.innerHTML =
        '<span class="map-tools-mobile-fab-icon map-tools-mobile-fab-icon--open" aria-hidden="true">' +
        hammerIcon +
        '</span>' +
        '<span class="map-tools-mobile-fab-icon map-tools-mobile-fab-icon--close" aria-hidden="true">&times;</span>';
    anchorEl.appendChild(fabEl);
    mapRoot.appendChild(anchorEl);

    bubblesEl = anchorEl.querySelector('.map-tools-mobile-bubbles');

    fabEl.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menuOpen) closeMapToolsMobileMenu();
        else openMapToolsMobileMenu();
    });

    bubblesEl.querySelectorAll('[data-map-tool-action]').forEach(function (bubble) {
        bubble.addEventListener('click', function (e) {
            e.stopPropagation();
            handleToolAction(bubble.getAttribute('data-map-tool-action'));
        });
    });

    anchorEl.addEventListener('click', function (e) {
        e.stopPropagation();
    });

    measureBarEl = document.createElement('div');
    measureBarEl.className = 'map-tools-mobile-measure-bar';
    measureBarEl.setAttribute('role', 'status');
    measureBarEl.hidden = true;
    measureBarEl.innerHTML =
        '<span class="map-tools-mobile-measure-bar-label">Measuring</span>' +
        '<button type="button" class="map-tools-mobile-measure-bar-stop">Stop measuring</button>';
    measureBarEl.querySelector('.map-tools-mobile-measure-bar-stop').addEventListener('click', function (e) {
        e.stopPropagation();
        handleStopMeasureClick();
    });
    mapRoot.appendChild(measureBarEl);

    finishChipEl = document.createElement('button');
    finishChipEl.type = 'button';
    finishChipEl.className = 'map-tools-mobile-action-chip finish-drawing-mobile-chip';
    finishChipEl.textContent = 'Finish';
    finishChipEl.hidden = true;
    finishChipEl.addEventListener('click', function (e) {
        e.stopPropagation();
        handleFinishChipClick();
    });
    mapRoot.appendChild(finishChipEl);

    cancelChipEl = document.createElement('button');
    cancelChipEl.type = 'button';
    cancelChipEl.className = 'map-tools-mobile-action-chip cancel-drawing-mobile-chip';
    cancelChipEl.textContent = 'Cancel';
    cancelChipEl.hidden = true;
    cancelChipEl.addEventListener('click', function (e) {
        e.stopPropagation();
        handleCancelChipClick();
    });
    mapRoot.appendChild(cancelChipEl);

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (layersModalOpen) closeLayersModal();
            else if (menuOpen) closeMapToolsMobileMenu();
        }
    });
}

function syncMapToolsMobileLayout() {
    const bundle = window.mapToolbarBundleEl;

    if (isMapToolsMobileLayout()) {
        if (bundle) bundle.classList.add('map-toolbar-bundle--mobile-hidden');
        if (anchorEl) anchorEl.classList.add('map-tools-mobile-anchor--visible');
        if (topRightEl) topRightEl.classList.add('map-tools-mobile-top-right--visible');
        reparentLayerPanelToMobile();
    } else {
        if (bundle) bundle.classList.remove('map-toolbar-bundle--mobile-hidden');
        closeMapToolsMobileMenu();
        closeLayersModal();
        if (anchorEl) anchorEl.classList.remove('map-tools-mobile-anchor--visible');
        if (topRightEl) topRightEl.classList.remove('map-tools-mobile-top-right--visible');
        reparentLayerPanelToDesktop();
    }
    syncActiveChips();
    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility();
    }
}

function scheduleLayoutSync() {
    if (layoutSyncScheduled) return;
    layoutSyncScheduled = true;
    requestAnimationFrame(function () {
        layoutSyncScheduled = false;
        syncMapToolsMobileLayout();
    });
}

function updateMapToolsMobileEditVisibility(canEdit) {
    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility(canEdit);
        return;
    }
    document.querySelectorAll('[data-map-tools-edit-only]').forEach(function (el) {
        el.style.display = canEdit ? '' : 'none';
    });
}

function startActiveChipWatchers() {
    if (!statePollInterval) {
        statePollInterval = setInterval(syncActiveChips, 400);
    }
}

function initMapToolsMobile() {
    ensureMapToolsMobileDom();
    bindMapClickClose();
    syncMapToolsMobileLayout();
    startActiveChipWatchers();

    if (typeof MAP_TOOLS_MOBILE_MQ.addEventListener === 'function') {
        MAP_TOOLS_MOBILE_MQ.addEventListener('change', scheduleLayoutSync);
    } else if (typeof MAP_TOOLS_MOBILE_MQ.addListener === 'function') {
        MAP_TOOLS_MOBILE_MQ.addListener(scheduleLayoutSync);
    }
    window.addEventListener('resize', scheduleLayoutSync);
    window.addEventListener('resize', syncMobileActionChipPosition);
    window.addEventListener('orientationchange', syncMobileActionChipPosition);

    if (typeof window.canEditCurrentOrg === 'function') {
        updateMapToolsMobileEditVisibility(window.canEditCurrentOrg());
    }
    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility();
    }
}

window.isMapToolsMobileLayout = isMapToolsMobileLayout;
window.initMapToolsMobile = initMapToolsMobile;
window.updateMapToolsMobileEditVisibility = updateMapToolsMobileEditVisibility;
window.closeMapToolsMobileMenu = closeMapToolsMobileMenu;
window.mapToolsMobileModule = {
    initMapToolsMobile,
    updateMapToolsMobileEditVisibility,
    syncMapToolsMobileLayout,
    syncActiveChips,
    isMapToolsMobileLayout,
    openMapToolsMobileMenu,
    closeMapToolsMobileMenu,
    openLayersModal,
    closeLayersModal,
    openMapToolsMobileSheet,
    closeMapToolsMobileSheet,
};
