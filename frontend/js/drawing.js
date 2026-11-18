// Drawing module - Drawing mode management and handlers

// Drawing state
let currentDrawingMode = null; // 'point', 'line', 'polygon', or null
let currentDrawingPoints = [];
let tempDrawingLayer = null;
/** True while drawing a line/polygon seeded from the live location marker (map taps locked out). */
let locationAnnotateActive = false;

// Drawing controls container
let drawingControlsContainer = null;

// Setup drawing handlers
let mapClickHandler = null;
let mapKeyHandler = null;
// Defer attaching map click until after the toolbar click finishes.
// Activating a tool replaces button innerHTML (SVG target detaches), which breaks
// Leaflet's disableClickPropagation guard so the same click can fire as a map click.
let drawingHandlersSetupTimer = null;

// Reference to finishAnnotation function (will be set by annotations module)
let finishAnnotationCallback = null;

function syncTicketLayersAfterToolChange() {
    if (window.ticketsModule && window.ticketsModule.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
}

function clearPendingDrawingHandlersSetup() {
    if (drawingHandlersSetupTimer != null) {
        clearTimeout(drawingHandlersSetupTimer);
        drawingHandlersSetupTimer = null;
    }
}

function scheduleDrawingHandlers() {
    clearPendingDrawingHandlersSetup();
    const mode = currentDrawingMode;
    drawingHandlersSetupTimer = setTimeout(function () {
        drawingHandlersSetupTimer = null;
        if (currentDrawingMode === mode && mode) {
            setupDrawingHandlers();
        }
    }, 0);
}

function annotationDrawingBlocked() {
    return typeof window.shouldSuppressAnnotationMapTools === 'function' && window.shouldSuppressAnnotationMapTools();
}

// Activate a draw tool without toggle-off (used by keep-annotating mode)
function startDrawingMode(mode) {
    if (!mode) return;
    if (annotationDrawingBlocked()) return;
    if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Drawing requires an internet connection.')) {
        return;
    }
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    }
    clearDrawingSketch();
    currentDrawingMode = mode;
    currentDrawingPoints = [];
    locationAnnotateActive = false;
    updateDrawingButtons();
    scheduleDrawingHandlers();
    syncTicketLayersAfterToolChange();
    if (typeof window.hideLocationAddPointButton === 'function') {
        window.hideLocationAddPointButton();
    }
}

function redrawTempDrawingLayer() {
    const map = window.map;
    if (!map || !currentDrawingMode || currentDrawingMode === 'point') return;

    if (!tempDrawingLayer) {
        tempDrawingLayer = L.layerGroup().addTo(map);
    }
    tempDrawingLayer.clearLayers();

    currentDrawingPoints.forEach(function (point, index) {
        const isLastPoint = index === currentDrawingPoints.length - 1;
        const showCheckmark = isLastPoint &&
            ((currentDrawingMode === 'line' && currentDrawingPoints.length >= 2) ||
                (currentDrawingMode === 'polygon' && currentDrawingPoints.length >= 3));

        let markerHtml;
        if (showCheckmark) {
            markerHtml =
                '<div style="width: 24px; height: 24px; border-radius: 50%; background: var(--app-success); border: 2px solid var(--app-text-inverse); color: var(--app-text-inverse); font-size: 16px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; line-height: 1;">' +
                '✓' +
                '</div>';
        } else {
            markerHtml = '<div style="background-color: var(--app-accent); width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 50%, transparent);"></div>';
        }

        const marker = L.marker(point, {
            icon: L.divIcon({
                className: 'drawing-marker',
                html: markerHtml,
                iconSize: showCheckmark ? [24, 24] : [12, 12],
                iconAnchor: showCheckmark ? [12, 12] : [6, 6],
            }),
        });

        if (showCheckmark) {
            marker.on('click', function (e) {
                L.DomEvent.stopPropagation(e);
                finishCurrentDrawing();
            });
        }

        tempDrawingLayer.addLayer(marker);
    });

    if (currentDrawingMode === 'line' && currentDrawingPoints.length >= 2) {
        const line = L.polyline(currentDrawingPoints.map(function (p) { return [p.lat, p.lng]; }), {
            color: appCssVar('--app-accent', 'var(--app-accent)'),
            weight: 3,
            dashArray: '5, 5',
        });
        tempDrawingLayer.addLayer(line);
    } else if (currentDrawingMode === 'polygon' && currentDrawingPoints.length >= 2) {
        const polygon = L.polygon(currentDrawingPoints.map(function (p) { return [p.lat, p.lng]; }), {
            color: appCssVar('--app-accent', 'var(--app-accent)'),
            weight: 3,
            fillColor: appCssVar('--app-accent', 'var(--app-accent)'),
            fillOpacity: 0.2,
            dashArray: '5, 5',
        });
        tempDrawingLayer.addLayer(polygon);
    }
}

/** Start line/polygon drawing with the first vertex at the given location. */
function startDrawingAtLatLng(mode, latlng) {
    if (!mode || !latlng || (mode !== 'line' && mode !== 'polygon')) return;
    if (annotationDrawingBlocked()) return;
    if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Drawing requires an internet connection.')) {
        return;
    }
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    }
    // Clear any active sketch/handlers without tearing down a keep-annotating session.
    removeDrawingHandlers();
    clearDrawingSketch();
    currentDrawingMode = mode;
    currentDrawingPoints = [latlng];
    locationAnnotateActive = true;
    updateDrawingButtons();
    redrawTempDrawingLayer();
    scheduleDrawingHandlers();
    syncTicketLayersAfterToolChange();
    if (typeof window.showLocationAddPointButton === 'function') {
        window.showLocationAddPointButton();
    }
}

/** Append a vertex at the given latlng while line/polygon drawing is active. */
function appendDrawingPoint(latlng) {
    if (!latlng || !currentDrawingMode || currentDrawingMode === 'point') return false;
    currentDrawingPoints.push(latlng);
    redrawTempDrawingLayer();
    return true;
}

function clearDrawingSketch() {
    currentDrawingPoints = [];
    const map = window.map;
    if (tempDrawingLayer && map) {
        map.removeLayer(tempDrawingLayer);
        tempDrawingLayer = null;
    }
}

// Toggle drawing mode
function toggleDrawingMode(mode) {
    if (annotationDrawingBlocked()) return;
    if (currentDrawingMode === mode) {
        cancelDrawingMode();
    } else {
        cancelDrawingMode();
        if (window.cancelMeasureMode) {
            window.cancelMeasureMode();
        }
        currentDrawingMode = mode;
        currentDrawingPoints = [];
        locationAnnotateActive = false;
        updateDrawingButtons();
        scheduleDrawingHandlers();
        syncTicketLayersAfterToolChange();
        if (typeof window.hideLocationAddPointButton === 'function') {
            window.hideLocationAddPointButton();
        }
    }
}

/**
 * @param {{ keepMultiDraw?: boolean, skipStopMultiDraw?: boolean }} [options]
 * keepMultiDraw: clear sketch only (finishAnnotation mid keep-annotating session)
 * skipStopMultiDraw: internal — avoid recursion from stopMultiDraw()
 */
function cancelDrawingMode(options) {
    const opts = options || {};
    if (!opts.keepMultiDraw && !opts.skipStopMultiDraw && window.annotationsModule?.stopMultiDraw) {
        // stopMultiDraw re-enters with skipStopMultiDraw; hide here too so the Add point
        // chip cannot linger if that path is interrupted.
        if (typeof window.hideLocationAddPointButton === 'function') {
            window.hideLocationAddPointButton();
        }
        window.annotationsModule.stopMultiDraw({ internal: true });
        return;
    }

    currentDrawingMode = null;
    locationAnnotateActive = false;
    clearDrawingSketch();
    const map = window.map;
    if (window.photoUploadMode && window.cancelPhotoUpload) {
        window.cancelPhotoUpload();
    }
    updateDrawingButtons();
    removeDrawingHandlers();
    syncTicketLayersAfterToolChange();
    if (typeof window.hideLocationAddPointButton === 'function') {
        window.hideLocationAddPointButton();
    }
}

function appCssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

// Drawing tools: append into bundled map toolbar from map.js (same column as basemap / Data)
function initDrawingControls() {
    const map = window.map;
    const bundle = window.mapToolbarBundleEl;
    if (!map) {
        console.error('Cannot initialize drawing controls: map not available');
        return;
    }
    if (!bundle) {
        console.error('mapToolbarBundleEl missing — initMap must create the toolbar bundle first');
        return;
    }

    const existing = bundle.querySelector('.drawing-controls');
    if (existing) {
        existing.remove();
    }

    const icons = window.mapIcons;
    const toolSvg = icons
        ? function (name) {
              return icons.toolbar(name);
          }
        : null;

    const div = L.DomUtil.create('div', 'drawing-controls');
    const coreProduct = window.CORE_PRODUCT === true;
    div.innerHTML =
        '<button id="mapLocationTool" class="map-toolbar-btn" title="My location" aria-label="My location" data-map-tool-label="Location">' +
        (toolSvg ? toolSvg('location') : '◎') +
        '</button>' +
        (coreProduct
            ? ''
            : '<button id="drawPoint" class="draw-btn map-toolbar-btn" title="Add point" data-map-tool-action="drawPoint" data-map-tool-label="Point">' +
              (toolSvg ? toolSvg('mapPoint') : '📍') +
              '</button>' +
              '<button id="drawLine" class="draw-btn map-toolbar-btn" title="Add line" data-map-tool-action="drawLine" data-map-tool-label="Line">' +
              (toolSvg ? toolSvg('mapLine') : '━') +
              '</button>' +
              '<button id="drawPolygon" class="draw-btn map-toolbar-btn" title="Add polygon" data-map-tool-action="drawPolygon" data-map-tool-label="Polygon">' +
              (toolSvg ? toolSvg('mapPolygon') : '⬟') +
              '</button>');

    drawingControlsContainer = div;

    const locationBtn = div.querySelector('#mapLocationTool');
    if (locationBtn) {
        locationBtn.onclick = function () {
            if (typeof window.toggleUserLocationTracking === 'function') {
                window.toggleUserLocationTracking();
            }
        };
        locationBtn.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (typeof window.showUserLocationSourceMenu === 'function') {
                void window.showUserLocationSourceMenu('desktop');
            }
        });
    }

    // Stop the activating click so it cannot reach the map after the icon swap
    // orphans Leaflet's _leaflet_disable_click ancestor walk (see scheduleDrawingHandlers).
    function bindDrawToolButton(btn, mode) {
        if (!btn) return;
        L.DomEvent.on(btn, 'click', function (e) {
            L.DomEvent.stop(e);
            toggleDrawingMode(mode);
        });
    }
    bindDrawToolButton(div.querySelector('#drawPoint'), 'point');
    bindDrawToolButton(div.querySelector('#drawLine'), 'line');
    bindDrawToolButton(div.querySelector('#drawPolygon'), 'polygon');

    bundle.appendChild(div);
    L.DomEvent.disableClickPropagation(div);
}

// Finish current drawing
function finishCurrentDrawing() {
    if (!finishAnnotationCallback) {
        console.error('finishAnnotation callback not set');
        return;
    }
    
    if (currentDrawingMode === 'line' && currentDrawingPoints.length >= 2) {
        finishAnnotationCallback({
            type: 'LineString',
            coordinates: currentDrawingPoints.map(p => [p.lng, p.lat])
        });
    } else if (currentDrawingMode === 'polygon' && currentDrawingPoints.length >= 3) {
        finishAnnotationCallback({
            type: 'Polygon',
            coordinates: [[...currentDrawingPoints.map(p => [p.lng, p.lat]), [currentDrawingPoints[0].lng, currentDrawingPoints[0].lat]]]
        });
    }
}

function canFinishCurrentDrawing() {
    return (
        (currentDrawingMode === 'line' && currentDrawingPoints.length >= 2) ||
        (currentDrawingMode === 'polygon' && currentDrawingPoints.length >= 3)
    );
}

function setDrawBtnIcon(btn, active, iconName, fallback) {
    if (!btn) return;
    const icons = window.mapIcons;
    const size = icons ? icons.TOOLBAR_SIZE : 20;
    if (active && icons) {
        btn.innerHTML = icons.close(size);
    } else if (icons) {
        btn.innerHTML = icons.icon(iconName, size);
    } else {
        btn.textContent = active ? '✕' : fallback;
    }
}

// Update drawing button states
function updateDrawingButtons() {
    const pointBtn = document.getElementById('drawPoint');
    const lineBtn = document.getElementById('drawLine');
    const polygonBtn = document.getElementById('drawPolygon');

    if (pointBtn) {
        const active = currentDrawingMode === 'point';
        pointBtn.classList.toggle('map-toolbar-btn--active', active);
        setDrawBtnIcon(pointBtn, active, 'mapPoint', '📍');
    }
    if (lineBtn) {
        const active = currentDrawingMode === 'line';
        lineBtn.classList.toggle('map-toolbar-btn--active', active);
        setDrawBtnIcon(lineBtn, active, 'mapLine', '━');
    }
    if (polygonBtn) {
        const active = currentDrawingMode === 'polygon';
        polygonBtn.classList.toggle('map-toolbar-btn--active', active);
        setDrawBtnIcon(polygonBtn, active, 'mapPolygon', '⬟');
    }
}

function setupDrawingHandlers() {
    const map = window.map;
    if (!map) return;

    // Replace any previous listeners so re-entering draw mode cannot stack clicks.
    removeDrawingHandlers();

    // Click handler
    mapClickHandler = function(e) {
        if (!currentDrawingMode || window.photoUploadMode) return;

        L.DomEvent.stopPropagation(e);

        // Location-seeded line/polygon: vertices come from the Add point control only.
        if (locationAnnotateActive) {
            return;
        }

        if (currentDrawingMode === 'point') {
            // Finish point immediately
            if (finishAnnotationCallback) {
                finishAnnotationCallback({
                    type: 'Point',
                    coordinates: [e.latlng.lng, e.latlng.lat]
                });
            }
            return;
        }

        // Add point for line or polygon
        currentDrawingPoints.push(e.latlng);
        redrawTempDrawingLayer();
    };
    
    if (map) {
        map.on('click', mapClickHandler);
    }
    
    // Keyboard handler
    mapKeyHandler = function(e) {
        if (!currentDrawingMode) return;
        
        if (e.key === 'Escape') {
            cancelDrawingMode();
        } else if (e.key === 'Enter') {
            if (currentDrawingMode === 'line' && currentDrawingPoints.length >= 2) {
                if (finishAnnotationCallback) {
                    finishAnnotationCallback({
                        type: 'LineString',
                        coordinates: currentDrawingPoints.map(p => [p.lng, p.lat])
                    });
                }
            } else if (currentDrawingMode === 'polygon' && currentDrawingPoints.length >= 3) {
                if (finishAnnotationCallback) {
                    finishAnnotationCallback({
                        type: 'Polygon',
                        coordinates: [[...currentDrawingPoints.map(p => [p.lng, p.lat]), [currentDrawingPoints[0].lng, currentDrawingPoints[0].lat]]]
                    });
                }
            }
        }
    };
    
    window.addEventListener('keydown', mapKeyHandler);
}

// Remove drawing handlers
function removeDrawingHandlers() {
    clearPendingDrawingHandlersSetup();
    const map = window.map;
    if (map && mapClickHandler) {
        map.off('click', mapClickHandler);
        mapClickHandler = null;
    }
    if (mapKeyHandler) {
        window.removeEventListener('keydown', mapKeyHandler);
        mapKeyHandler = null;
    }
}

// Export for use in other modules
window.drawingModule = {
    get currentDrawingMode() { return currentDrawingMode; },
    set currentDrawingMode(value) { currentDrawingMode = value; },
    get locationAnnotateActive() { return locationAnnotateActive; },
    toggleDrawingMode,
    startDrawingMode,
    startDrawingAtLatLng,
    appendDrawingPoint,
    cancelDrawingMode,
    initDrawingControls,
    updateDrawingButtons,
    finishCurrentDrawing,
    canFinishCurrentDrawing,
    setFinishAnnotationCallback(callback) {
        finishAnnotationCallback = callback;
    }
};

// Measure, photo, file upload: same bundled toolbar as map + drawing tools
function initSeparateControls() {
    const bundle = window.mapToolbarBundleEl;
    if (!bundle) {
        console.error('mapToolbarBundleEl missing — cannot add toolbar tools');
        return;
    }

    const prev = bundle.querySelector('.map-toolbar-separate-tools');
    if (prev) {
        prev.remove();
    }

    const wrap = L.DomUtil.create('div', 'map-toolbar-separate-tools');
    const mod = window.mapToolActionsModule;
    const layout = mod && mod.MAP_TOOL_LAYOUT ? mod.MAP_TOOL_LAYOUT.desktopSeparateTools : ['measure', 'openCamera', 'importFiles'];
    const icons = window.mapIcons;
    const tb = icons ? icons.toolbar.bind(icons) : null;

    layout.forEach(function (actionId) {
        const def = mod && mod.getMapToolAction ? mod.getMapToolAction(actionId) : null;
        if (!def) return;
        const btn = L.DomUtil.create('button', actionId + '-btn map-toolbar-btn', wrap);
        if (actionId === 'createTicket') {
            btn.id = 'createTicketTool';
            btn.classList.add('create-ticket-btn');
        } else if (actionId === 'openCamera') {
            btn.id = 'mapOpenCamera';
            btn.classList.add('photo-btn');
        } else if (actionId === 'importFiles') {
            btn.id = 'uploadData';
            btn.classList.add('data-btn');
        } else if (actionId === 'measure') {
            btn.id = 'measureTool';
            btn.classList.add('measure-btn');
        }
        const iconKey = def.toolbarIcon || def.icon;
        btn.innerHTML = tb ? tb(iconKey) : def.icon === 'camera' ? '📷' : def.icon === 'upload' ? '⬆️' : def.icon === 'document' ? '📁' : '📏';
        if (mod && mod.bindDesktopToolbarButton) {
            mod.bindDesktopToolbarButton(btn, actionId);
        }
    });

    const measureBtn = wrap.querySelector('#measureTool');
    function updateMeasureButtonState() {
        if (window.measureModule && measureBtn) {
            const isActive = window.measureModule.measureMode || false;
            measureBtn.classList.toggle('map-toolbar-btn--success', isActive);
        }
    }
    if (measureBtn) {
        setInterval(updateMeasureButtonState, 500);
    }

    bundle.appendChild(wrap);
    L.DomEvent.disableClickPropagation(wrap);

    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility();
    }
}

// Export initSeparateControls
window.drawingModule = window.drawingModule || {};
window.drawingModule.initSeparateControls = initSeparateControls;

