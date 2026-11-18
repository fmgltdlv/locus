// Map polygon drawing + reverse geocode for the create-ticket wizard (bulk flow).
// Local dev: run `npm run dev:bundles` from frontend/ after edits.

(function () {
    let createTicketPolygonGeo = null;
    let createTicketWizardMapGroup = null;
    let createTicketPolygonDrawingCleanup = null;
    let createTicketPolygonDrawingFinish = null;
    let ctwHubWasOpenForMapDraw = false;
    let createTicketMapDrawStripLabel = '';

    /** @type {{ type: 'bulk', siteIndex: number, handlers: object } | null} */
    let activePolygonDrawContext = null;

    const BULK_POLYGON_COLORS = [
        '#0d9488',
        '#2563eb',
        '#7c3aed',
        '#db2777',
        '#ea580c',
        '#ca8a04',
        '#16a34a',
        '#0891b2',
        '#4f46e5',
        '#be123c',
    ];

    function resolveCreateTicketOrgId() {
        if (typeof window.getCurrentOrgId === 'function') {
            const id = window.getCurrentOrgId();
            if (id != null && String(id).trim() !== '') {
                const n = parseInt(String(id), 10);
                if (Number.isFinite(n)) return n;
            }
        }
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            const id = window.orgSelectorModule.getCurrentOrgId();
            if (id != null && String(id).trim() !== '') {
                const n = parseInt(String(id), 10);
                if (Number.isFinite(n)) return n;
            }
        }
        if (window.authModule && typeof window.authModule.getCurrentUser === 'function') {
            const u = window.authModule.getCurrentUser();
            if (u && u.organizationId != null) {
                const n = parseInt(String(u.organizationId), 10);
                if (Number.isFinite(n)) return n;
            }
        }
        return null;
    }

    function canUseCreateTicketWizard() {
        const canEdit = typeof window.canEditCurrentOrg === 'function' && window.canEditCurrentOrg();
        if (!canEdit) return false;
        if (window.authModule && window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
            return false;
        }
        if (!window.authModule) return false;
        if (window.LOCUS_ENABLE_TICKET_RENEWAL !== true) return false;
        if (typeof window.authModule.isDev === 'function' && window.authModule.isDev()) {
            return true;
        }
        if (
            typeof window.isTicketRenewalHubEnabled === 'function' &&
            window.isTicketRenewalHubEnabled()
        ) {
            return true;
        }
        return false;
    }

    function suspendTicketHubForCreateTicketMapDraw() {
        ctwHubWasOpenForMapDraw = false;
        const hubWin = document.getElementById('ticketHubWindow');
        if (hubWin && hubWin.classList.contains('show')) {
            ctwHubWasOpenForMapDraw = true;
            if (typeof window.closeTicketHubWindow === 'function') {
                window.closeTicketHubWindow();
            }
        }
    }

    function getOrCreateWizardMapGroup() {
        const map = window.map;
        if (!map) return null;
        if (!createTicketWizardMapGroup || !map.hasLayer(createTicketWizardMapGroup)) {
            createTicketWizardMapGroup = L.layerGroup().addTo(map);
        }
        return createTicketWizardMapGroup;
    }

    function geoJsonPolygonToWkt(geo) {
        if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || !geo.coordinates[0]) {
            throw new Error('Invalid GeoJSON polygon');
        }
        const ring = geo.coordinates[0];
        const parts = ring.map(function (pt) {
            if (!Array.isArray(pt) || pt.length < 2) throw new Error('Invalid ring coordinate');
            return String(pt[0]) + ' ' + String(pt[1]);
        });
        return 'POLYGON((' + parts.join(',') + '))';
    }

    function stateCodeFromGeocode(stateVal) {
        if (stateVal == null) return '';
        if (typeof stateVal === 'string') return stateVal.trim();
        if (typeof stateVal === 'object') {
            const c = stateVal.code != null ? String(stateVal.code).trim() : '';
            if (c) return c;
            const v = stateVal.value != null ? String(stateVal.value).trim() : '';
            return v;
        }
        return '';
    }

    function summaryLineFromGeocodeAddr(addr) {
        if (!addr || typeof addr !== 'object') return '';
        const street = addr.street != null ? String(addr.street).trim() : '';
        const suburb = addr.suburb != null ? String(addr.suburb).trim() : '';
        const state = stateCodeFromGeocode(addr.state);
        const postcode = addr.postcode != null ? String(addr.postcode).trim() : '';
        const bits = [street, suburb, state, postcode].filter(Boolean);
        return bits.length ? bits.join(', ') : '';
    }

    function metaLineFromGeocodeRow(row) {
        if (!row || typeof row !== 'object') return '';
        const valid = row.isWktValid === true;
        const bits = [];
        bits.push(valid ? 'Polygon accepted by USAN' : 'Polygon not accepted by USAN');
        if (Array.isArray(row.wktMeasureList) && row.wktMeasureList.length) {
            const ft = row.wktMeasureList[0];
            if (typeof ft === 'number' && Number.isFinite(ft)) {
                bits.push('Approx. area ' + Math.round(ft) + ' sq ft');
            }
        }
        return bits.join(' · ');
    }

    async function reverseGeocodePolygonGeoJson(geo, activityId) {
        const empty = {
            row: null,
            summaryLine: '',
            meta: '',
            statusText: '',
            statusError: false,
            nearestCrossStreet: '',
        };
        if (!geo || geo.type !== 'Polygon') return empty;

        let wkt;
        try {
            wkt = geoJsonPolygonToWkt(geo);
        } catch (e) {
            return Object.assign({}, empty, {
                statusText: 'Could not build map geometry for lookup.',
                statusError: true,
            });
        }

        const orgId = resolveCreateTicketOrgId();
        if (!orgId) {
            return Object.assign({}, empty, {
                statusText: 'Select an organization before address lookup.',
                statusError: true,
            });
        }

        if (!window.authModule || typeof window.authModule.apiRequest !== 'function') {
            return Object.assign({}, empty, {
                statusText: 'Sign in to look up the address from your polygon.',
                statusError: true,
            });
        }

        const actId =
            Number.isFinite(Number(activityId)) && Number(activityId) > 0 ? Number(activityId) : 1;

        try {
            const res = await window.authModule.apiRequest('tickets/reverse-geocode', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: orgId,
                    wkt: wkt,
                    activityId: actId,
                    purposeName: '0',
                    searchRegionId: null,
                }),
            });
            const payload = res && res.data !== undefined ? res.data : res;
            const row = Array.isArray(payload) ? payload[0] : payload;
            if (!row || typeof row !== 'object') {
                return Object.assign({}, empty, {
                    statusText: 'Unexpected response from address lookup.',
                    statusError: true,
                });
            }
            let rowCopy = row;
            try {
                rowCopy = JSON.parse(JSON.stringify(row));
            } catch (copyErr) {
                /* use row */
            }
            const addr = row.geocodedAddress;
            const summaryLine =
                addr && typeof addr === 'object'
                    ? summaryLineFromGeocodeAddr(addr)
                    : 'No address returned for this polygon.';
            const valid = row.isWktValid === true;
            return {
                row: rowCopy,
                summaryLine: summaryLine,
                meta: metaLineFromGeocodeRow(row),
                statusText: valid ? 'Address updated from map.' : 'Address filled, but polygon will not be accepted by USAN.',
                statusError: !valid,
                nearestCrossStreet: ''
            };
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            return Object.assign({}, empty, {
                statusText: msg,
                statusError: true,
            });
        }
    }

    function syncBulkCreatePolygonsOnMap(sites) {
        const g = getOrCreateWizardMapGroup();
        const map = window.map;
        if (!g || !map) return;
        g.clearLayers();
        const list = Array.isArray(sites) ? sites : [];
        list.forEach(function (site, index) {
            const geo = site && site.polygonGeoJson;
            if (!geo || geo.type !== 'Polygon') return;
            const color = BULK_POLYGON_COLORS[index % BULK_POLYGON_COLORS.length];
            const lay = L.geoJSON(geo, {
                style: {
                    color: color,
                    weight: 3,
                    fillColor: color,
                    fillOpacity: 0.2,
                },
            });
            g.addLayer(lay);
        });
        if (g.getLayers().length) {
            try {
                const bounds = g.getBounds();
                if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 18 });
            } catch (e) {
                /* ignore */
            }
        }
    }

    function setLeafletElementInteractive(el, interactive) {
        if (!el) return;
        if (interactive) {
            if (typeof L !== 'undefined' && L.DomUtil) L.DomUtil.addClass(el, 'leaflet-interactive');
            el.style.pointerEvents = '';
        } else {
            if (typeof L !== 'undefined' && L.DomUtil) L.DomUtil.removeClass(el, 'leaflet-interactive');
            el.style.pointerEvents = 'none';
        }
    }

    function applyFeatureLayerInteraction(layer, interactive) {
        if (!layer) return;

        if (typeof layer.eachLayer === 'function') {
            layer.eachLayer(function (sub) {
                applyFeatureLayerInteraction(sub, interactive);
            });
        }

        if (!interactive) {
            if (!layer._createTicketWizardInteractionSuppressed) {
                layer._createTicketWizardWasInteractive = !(layer.options && layer.options.interactive === false);
                layer._createTicketWizardSuppressedPopup =
                    typeof layer.getPopup === 'function' ? layer.getPopup() : null;
            }
            layer._createTicketWizardInteractionSuppressed = true;
            if (layer.options) layer.options.interactive = false;
            if (typeof layer.unbindPopup === 'function' && layer._createTicketWizardSuppressedPopup) {
                layer.unbindPopup();
            }
            setLeafletElementInteractive(layer._path, false);
            setLeafletElementInteractive(layer._icon, false);
            setLeafletElementInteractive(layer._shadow, false);
            return;
        }

        if (!layer._createTicketWizardInteractionSuppressed) return;

        const restoreInteractive = layer._createTicketWizardWasInteractive !== false;
        if (layer.options) layer.options.interactive = restoreInteractive;
        setLeafletElementInteractive(layer._path, restoreInteractive);
        setLeafletElementInteractive(layer._icon, restoreInteractive);
        setLeafletElementInteractive(layer._shadow, restoreInteractive);
        if (
            restoreInteractive &&
            layer._createTicketWizardSuppressedPopup &&
            typeof layer.bindPopup === 'function' &&
            typeof layer.getPopup === 'function' &&
            !layer.getPopup()
        ) {
            layer.bindPopup(layer._createTicketWizardSuppressedPopup);
        }
        delete layer._createTicketWizardInteractionSuppressed;
        delete layer._createTicketWizardWasInteractive;
        delete layer._createTicketWizardSuppressedPopup;
    }

    let syncingTicketDrawOverlays = false;
    let ticketDrawOverlaySyncQueued = false;

    function ticketDrawOverlayMode() {
        if (typeof window.getTicketDrawOverlayMode === 'function') {
            return window.getTicketDrawOverlayMode() === 'hide' ? 'hide' : 'passthrough';
        }
        return 'passthrough';
    }

    function syncRenderedFeatureInteractionForPolygonDraw() {
        runTicketDrawOverlaySync(0);
    }

    function runTicketDrawOverlaySync(depth) {
        if (syncingTicketDrawOverlays) {
            ticketDrawOverlaySyncQueued = true;
            return;
        }
        syncingTicketDrawOverlays = true;
        try {
            let passes = 0;
            do {
                ticketDrawOverlaySyncQueued = false;
                passes += 1;
                const drawing = !!window.mapQueryPolygonDrawing;
                window.createTicketOverlayDrawActive = drawing;
                if (drawing && window.map && typeof window.map.closePopup === 'function') {
                    window.map.closePopup();
                }
                const hideOverlays = drawing && ticketDrawOverlayMode() === 'hide';
                if (window.photosModule && typeof window.photosModule.setPhotosHiddenForTicketDraw === 'function') {
                    window.photosModule.setPhotosHiddenForTicketDraw(hideOverlays);
                }
                if (
                    window.layerManagerModule &&
                    typeof window.layerManagerModule.setAnnotationOverlaysHiddenForTicketDraw === 'function'
                ) {
                    window.layerManagerModule.setAnnotationOverlaysHiddenForTicketDraw(hideOverlays);
                }

                const interactive = !drawing;
                const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

                function visit(layer) {
                    if (!layer) return;
                    if (seen) {
                        if (seen.has(layer)) return;
                        seen.add(layer);
                    }
                    applyFeatureLayerInteraction(layer, interactive);
                }

                const renderer = window.annotationRendererModule;
                if (renderer && Array.isArray(renderer.annotationLayers)) {
                    renderer.annotationLayers.forEach(visit);
                }

                const layerManager = window.layerManagerModule;
                if (layerManager) {
                    visit(layerManager.annotationsLayerGroup);
                    const groups = layerManager.dataLayerGroups;
                    if (groups && typeof groups.forEach === 'function') {
                        groups.forEach(function (group) {
                            visit(group);
                        });
                    }
                }

                if (window.photosModule && typeof window.photosModule.forEachTicketDrawPhotoLayer === 'function') {
                    window.photosModule.forEachTicketDrawPhotoLayer(visit);
                }

                if (window.ticketsModule && typeof window.ticketsModule.syncTicketLayerPointerInteraction === 'function') {
                    window.ticketsModule.syncTicketLayerPointerInteraction();
                }
            } while (ticketDrawOverlaySyncQueued && passes < 4);
        } finally {
            syncingTicketDrawOverlays = false;
        }
        if (ticketDrawOverlaySyncQueued && depth < 2) {
            runTicketDrawOverlaySync(depth + 1);
        }
    }

    function isCreateTicketMapDrawingActive() {
        return typeof createTicketPolygonDrawingCleanup === 'function';
    }

    function setCreateTicketMapDrawStripLabel(text) {
        createTicketMapDrawStripLabel = text ? String(text) : '';
        if (typeof window.syncMapContextualDrawStrip === 'function') {
            window.syncMapContextualDrawStrip();
        }
    }

    function getCreateTicketMapDrawStripLabel() {
        return createTicketMapDrawStripLabel;
    }

    function clearCreateTicketPolygonDrawingFns() {
        createTicketPolygonDrawingCleanup = null;
        createTicketPolygonDrawingFinish = null;
        setCreateTicketMapDrawStripLabel('');
    }

    function finishCreateTicketMapDrawingIfActive() {
        if (typeof createTicketPolygonDrawingFinish !== 'function') return;
        const fn = createTicketPolygonDrawingFinish;
        void Promise.resolve()
            .then(function () {
                return fn();
            })
            .catch(function (err) {
                console.error('[createTicketMapPolygon] finish from strip', err);
            });
    }

    function cancelCreateTicketPolygonDrawingIfActive() {
        if (typeof createTicketPolygonDrawingCleanup !== 'function') return;
        const fn = createTicketPolygonDrawingCleanup;
        clearCreateTicketPolygonDrawingFns();
        try {
            fn({ reopenWizard: true });
        } catch (e) {
            /* ignore */
        }
    }

    function resumeAfterPolygonDraw(reopen) {
        if (activePolygonDrawContext && activePolygonDrawContext.type === 'bulk') {
            const handlers = activePolygonDrawContext.handlers;
            if (reopen && typeof handlers.resumeOverlay === 'function') {
                void handlers.resumeOverlay();
            }
            return;
        }
        ctwHubWasOpenForMapDraw = false;
    }

    function startBulkCreatePolygonDrawing(siteIndex, handlers) {
        const map = window.map;
        if (!map) {
            if (typeof window.appAlert === 'function') window.appAlert('Map is not ready yet.');
            return;
        }
        if (!handlers || typeof handlers.onComplete !== 'function') return;
        cancelCreateTicketPolygonDrawingIfActive();
        activePolygonDrawContext = {
            type: 'bulk',
            siteIndex: siteIndex,
            handlers: handlers,
        };
        createTicketPolygonGeo =
            handlers.existingPolygon && handlers.existingPolygon.type === 'Polygon'
                ? handlers.existingPolygon
                : null;
        suspendTicketHubForCreateTicketMapDraw();
        if (typeof handlers.beforeDraw === 'function') handlers.beforeDraw();
        runCreateTicketPolygonMapDrawSession();
    }

    function runCreateTicketPolygonMapDrawSession() {
        const map = window.map;
        if (!map) return;
        prepareCreateTicketDrawSessionHygiene();

        let queryPoints = [];
        const queryLayer = L.layerGroup().addTo(map);
        window.mapQueryPolygonDrawing = true;
        syncRenderedFeatureInteractionForPolygonDraw();
        notifyCreateTicketMapDrawMobileChips();
        map.getContainer().style.cursor = 'crosshair';

        let cancelHandler = null;

        function destroyDrawingSession(opts) {
            opts = opts || {};
            const reopen = opts.reopenWizard === true;
            map.off('click', queryClickHandler);
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            try {
                map.removeLayer(queryLayer);
            } catch (e) {
                /* ignore */
            }
            map.getContainer().style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            syncRenderedFeatureInteractionForPolygonDraw();
            notifyCreateTicketMapDrawMobileChips();
            if (!reopen && activePolygonDrawContext && activePolygonDrawContext.type === 'bulk') {
                activePolygonDrawContext = null;
            }
            resumeAfterPolygonDraw(reopen);
        }

        async function finishCreateTicketPolygon() {
            if (finishCreateTicketPolygon._busy) return;
            if (queryPoints.length < 3) {
                if (typeof window.appAlert === 'function') window.appAlert('A polygon needs at least 3 points.');
                return;
            }
            const coordsPreview = queryPoints.map(function (p) {
                return [p.lng, p.lat];
            });
            coordsPreview.push(coordsPreview[0]);
            const geoPreview = {
                type: 'Polygon',
                coordinates: [coordsPreview],
            };
            const limPreview = digLimits();
            if (limPreview && window.map && limPreview.exceedsMaxAreaSqFeet(window.map, geoPreview)) {
                if (typeof window.appAlert === 'function') {
                    window.appAlert(
                        'Dig area exceeds USAN maximum (' +
                            limPreview.formatAreaSqFt(limPreview.MAX_AREA_SQ_FT) +
                            '). Adjust the polygon on the map.'
                    );
                }
                return;
            }
            finishCreateTicketPolygon._busy = true;
            clearCreateTicketPolygonDrawingFns();
            const coords = coordsPreview;
            const geo = geoPreview;
            createTicketPolygonGeo = geo;

            map.off('click', queryClickHandler);
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            try {
                map.removeLayer(queryLayer);
            } catch (e) {
                /* ignore */
            }
            map.getContainer().style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            syncRenderedFeatureInteractionForPolygonDraw();
            notifyCreateTicketMapDrawMobileChips();
            clearCreateTicketPolygonDrawingFns();

            const bulkCtx =
                activePolygonDrawContext && activePolygonDrawContext.type === 'bulk'
                    ? activePolygonDrawContext
                    : null;
            if (!bulkCtx) return;

            const handlers = bulkCtx.handlers;
            const siteIndex = bulkCtx.siteIndex;
            activePolygonDrawContext = null;
            ctwHubWasOpenForMapDraw = false;

            let geocode = null;
            try {
                const actId =
                    typeof handlers.getActivityId === 'function' ? handlers.getActivityId() : 1;
                geocode = await reverseGeocodePolygonGeoJson(geo, actId);
            } catch (err) {
                console.error('[createTicketMapPolygon] reverse geocode', err);
            }
            if (typeof handlers.onComplete === 'function') {
                await handlers.onComplete(siteIndex, geo, geocode);
            }
            if (typeof handlers.resumeOverlay === 'function') {
                await handlers.resumeOverlay();
            }
        }

        const queryClickHandler = function (e) {
            L.DomEvent.stopPropagation(e);
            queryPoints.push(e.latlng);
            queryLayer.clearLayers();
            queryPoints.forEach(function (point, index) {
                const isLast = index === queryPoints.length - 1;
                const marker = L.marker(point, {
                    icon: L.divIcon({
                        className: 'create-ticket-wizard-draw-marker',
                        html:
                            '<div style="background-color: ' +
                            (isLast ? 'var(--app-success)' : '#0d9488') +
                            '; width: ' +
                            (isLast ? '20' : '12') +
                            'px; height: ' +
                            (isLast ? '20' : '12') +
                            'px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ' +
                            (isLast ? '12' : '0') +
                            'px; font-weight: bold; cursor: ' +
                            (isLast ? 'pointer' : 'default') +
                            ';">' +
                            (isLast ? '✓' : '') +
                            '</div>',
                        iconSize: [isLast ? 20 : 12, isLast ? 20 : 12],
                        iconAnchor: [isLast ? 10 : 6, isLast ? 10 : 6],
                    }),
                });
                if (isLast) {
                    marker.on('click', function () {
                        finishCreateTicketPolygon().catch(function (err) {
                            console.error('[createTicketMapPolygon] finish polygon', err);
                        });
                    });
                }
                queryLayer.addLayer(marker);
            });
            if (queryPoints.length >= 2) {
                const poly = L.polygon(
                    queryPoints.map(function (p) {
                        return [p.lat, p.lng];
                    }),
                    {
                        color: '#14b8a6',
                        weight: 3,
                        fillColor: '#14b8a6',
                        fillOpacity: 0.15,
                        dashArray: '5, 5',
                    }
                );
                queryLayer.addLayer(poly);
            }
            syncPolygonDrawMeasureHint(queryLayer, map, queryPoints);
        };

        cancelHandler = function (e) {
            if (e.key === 'Escape' && typeof createTicketPolygonDrawingCleanup === 'function') {
                const c = createTicketPolygonDrawingCleanup;
                clearCreateTicketPolygonDrawingFns();
                c({ reopenWizard: true });
            }
        };

        createTicketPolygonDrawingCleanup = destroyDrawingSession;
        createTicketPolygonDrawingFinish = finishCreateTicketPolygon;
        map.on('click', queryClickHandler);
        window.addEventListener('keydown', cancelHandler);
    }

    const CIRCLE_DRAW_MIN_RADIUS_M = 1;
    const CIRCLE_DRAW_RING_STEPS = 64;
    /** Pixel radius for the center pin only (not dig-site meters). */
    const CIRCLE_DRAW_CENTER_MARKER_PX = 5;
    /** Ignore press-release under this screen-pixel drag (tap), keep session open. */
    const CIRCLE_DRAW_MIN_DRAG_PX = 10;

    /** Destination point at distanceMeters along bearingDegrees from latlng (WGS84). */
    function destinationLatLng(latlng, distanceMeters, bearingDegrees) {
        const R = 6371000;
        const delta = distanceMeters / R;
        const theta = (bearingDegrees * Math.PI) / 180;
        const phi1 = (latlng.lat * Math.PI) / 180;
        const lambda1 = (latlng.lng * Math.PI) / 180;
        const sinPhi1 = Math.sin(phi1);
        const cosPhi1 = Math.cos(phi1);
        const sinDelta = Math.sin(delta);
        const cosDelta = Math.cos(delta);
        const phi2 = Math.asin(sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta));
        const lambda2 =
            lambda1 +
            Math.atan2(Math.sin(theta) * sinDelta * cosPhi1, cosDelta - sinPhi1 * Math.sin(phi2));
        return L.latLng((phi2 * 180) / Math.PI, ((((lambda2 * 180) / Math.PI) + 540) % 360) - 180);
    }

    function circleToGeoJsonPolygon(centerLatLng, radiusMeters, steps) {
        const n = steps && steps > 3 ? steps : CIRCLE_DRAW_RING_STEPS;
        const ring = [];
        for (let i = 0; i < n; i++) {
            const bearing = (i * 360) / n;
            const pt = destinationLatLng(centerLatLng, radiusMeters, bearing);
            ring.push([pt.lng, pt.lat]);
        }
        ring.push(ring[0]);
        return {
            type: 'Polygon',
            coordinates: [ring],
        };
    }

    const LINE_DRAW_MIN_RADIUS_M = 1;
    const LINE_DRAW_MAX_WIDTH_FT = 250;
    const LINE_DRAW_FT_PER_M = 3.28084;
    const LINE_DRAW_MAX_RADIUS_M = LINE_DRAW_MAX_WIDTH_FT / LINE_DRAW_FT_PER_M;
    const LINE_DRAW_MIN_DRAG_PX = 10;
    const LINE_DRAW_MITER_LIMIT = 4;
    const LINE_DRAW_METERS_PER_DEG_LAT = 111320;

    function bearingDegrees(from, to) {
        const phi1 = (from.lat * Math.PI) / 180;
        const phi2 = (to.lat * Math.PI) / 180;
        const dLambda = ((to.lng - from.lng) * Math.PI) / 180;
        const y = Math.sin(dLambda) * Math.cos(phi2);
        const x =
            Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
        return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }

    function toLocalXY(latlng, origin) {
        const lat0 = (origin.lat * Math.PI) / 180;
        const cosLat = Math.cos(lat0);
        return {
            x: (latlng.lng - origin.lng) * LINE_DRAW_METERS_PER_DEG_LAT * (Math.abs(cosLat) > 1e-6 ? cosLat : 1e-6),
            y: (latlng.lat - origin.lat) * LINE_DRAW_METERS_PER_DEG_LAT,
        };
    }

    function fromLocalXY(xy, origin) {
        const lat0 = (origin.lat * Math.PI) / 180;
        const cosLat = Math.cos(lat0);
        return L.latLng(
            origin.lat + xy.y / LINE_DRAW_METERS_PER_DEG_LAT,
            origin.lng + xy.x / (LINE_DRAW_METERS_PER_DEG_LAT * (Math.abs(cosLat) > 1e-6 ? cosLat : 1e-6))
        );
    }

    function lineIntersectionXY(a1, a2, b1, b2) {
        const dax = a2.x - a1.x;
        const day = a2.y - a1.y;
        const dbx = b2.x - b1.x;
        const dby = b2.y - b1.y;
        const den = dax * dby - day * dbx;
        if (Math.abs(den) < 1e-9) return null;
        const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den;
        return { x: a1.x + t * dax, y: a1.y + t * day };
    }

    function offsetLatLng(latlng, bearing, radiusMeters, side) {
        return destinationLatLng(latlng, radiusMeters, bearing + side * 90);
    }

    function miterOffsetLatLng(latlngs, index, radiusMeters, side, bearings) {
        const vertex = latlngs[index];
        const bIn = bearings[index - 1];
        const bOut = bearings[index];
        const a1 = offsetLatLng(latlngs[index - 1], bIn, radiusMeters, side);
        const a2 = offsetLatLng(vertex, bIn, radiusMeters, side);
        const b1 = offsetLatLng(vertex, bOut, radiusMeters, side);
        const b2 = offsetLatLng(latlngs[index + 1], bOut, radiusMeters, side);
        const hit = lineIntersectionXY(
            toLocalXY(a1, vertex),
            toLocalXY(a2, vertex),
            toLocalXY(b1, vertex),
            toLocalXY(b2, vertex)
        );
        if (!hit) {
            return L.latLng((a2.lat + b1.lat) / 2, (a2.lng + b1.lng) / 2);
        }
        if (Math.hypot(hit.x, hit.y) > radiusMeters * LINE_DRAW_MITER_LIMIT) {
            return L.latLng((a2.lat + b1.lat) / 2, (a2.lng + b1.lng) / 2);
        }
        return fromLocalXY(hit, vertex);
    }

    function bufferPolylineToGeoJsonPolygon(latlngs, radiusMeters) {
        if (!Array.isArray(latlngs) || latlngs.length < 2) return null;
        const R = Math.max(radiusMeters, LINE_DRAW_MIN_RADIUS_M);
        const n = latlngs.length;
        const bearings = [];
        for (let i = 0; i < n - 1; i++) {
            bearings.push(bearingDegrees(latlngs[i], latlngs[i + 1]));
        }
        const left = [];
        const right = [];
        left.push(offsetLatLng(latlngs[0], bearings[0], R, -1));
        right.push(offsetLatLng(latlngs[0], bearings[0], R, 1));
        for (let i = 1; i < n - 1; i++) {
            left.push(miterOffsetLatLng(latlngs, i, R, -1, bearings));
            right.push(miterOffsetLatLng(latlngs, i, R, 1, bearings));
        }
        left.push(offsetLatLng(latlngs[n - 1], bearings[n - 2], R, -1));
        right.push(offsetLatLng(latlngs[n - 1], bearings[n - 2], R, 1));
        const ring = [];
        left.forEach(function (p) {
            ring.push([p.lng, p.lat]);
        });
        for (let i = right.length - 1; i >= 0; i--) {
            ring.push([right[i].lng, right[i].lat]);
        }
        ring.push(ring[0]);
        return {
            type: 'Polygon',
            coordinates: [ring],
        };
    }

    function closestPointOnSegment(point, a, b) {
        const P = toLocalXY(point, a);
        const B = toLocalXY(b, a);
        const len2 = B.x * B.x + B.y * B.y;
        if (len2 < 1e-12) return a;
        let t = (P.x * B.x + P.y * B.y) / len2;
        t = Math.max(0, Math.min(1, t));
        return fromLocalXY({ x: B.x * t, y: B.y * t }, a);
    }

    function distancePointToPolylineMeters(map, point, latlngs) {
        let min = Infinity;
        for (let i = 0; i < latlngs.length - 1; i++) {
            const closest = closestPointOnSegment(point, latlngs[i], latlngs[i + 1]);
            const d = map.distance(point, closest);
            if (d < min) min = d;
        }
        return Number.isFinite(min) ? min : 0;
    }

    function midpointOfPolyline(latlngs) {
        if (!latlngs.length) return null;
        if (latlngs.length === 1) return latlngs[0];
        const mid = Math.floor((latlngs.length - 1) / 2);
        const a = latlngs[mid];
        const b = latlngs[mid + 1] || a;
        return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    }

    function clampLineBufferRadiusMeters(radiusMeters) {
        if (!Number.isFinite(radiusMeters) || radiusMeters < LINE_DRAW_MIN_RADIUS_M) {
            return LINE_DRAW_MIN_RADIUS_M;
        }
        return Math.min(radiusMeters, LINE_DRAW_MAX_RADIUS_M);
    }

    function formatLineWidthFeet(radiusMeters) {
        const ft = Math.round(radiusMeters * LINE_DRAW_FT_PER_M);
        return String(Math.min(LINE_DRAW_MAX_WIDTH_FT, Math.max(1, ft))) + ' ft';
    }

    function digLimits() {
        return window.digSiteLimitsModule || null;
    }

    function formatDigLimitArea(map, geo) {
        const lim = digLimits();
        if (!lim || !map || !geo) return '';
        const sqFt = lim.geoJsonPolygonAreaSqFeet(map, geo);
        if (!Number.isFinite(sqFt) || sqFt <= 0) return '';
        let text = lim.formatAreaSqFt(sqFt);
        if (sqFt > lim.MAX_AREA_SQ_FT) {
            text += ' · over USAN max';
        }
        return text;
    }

    function syncPolygonDrawMeasureHint(queryLayer, map, latlngs) {
        if (!map || !Array.isArray(latlngs) || latlngs.length < 3) return;
        const lim = digLimits();
        if (!lim) return;
        const ring = latlngs.map(function (p) {
            return [p.lng, p.lat];
        });
        ring.push(ring[0]);
        const geo = { type: 'Polygon', coordinates: [ring] };
        const hint = formatDigLimitArea(map, geo);
        if (!hint) return;
        const anchor = latlngs[Math.floor(latlngs.length / 2)];
        queryLayer.eachLayer(function (layer) {
            if (layer && layer._createTicketMeasureHint) {
                queryLayer.removeLayer(layer);
            }
        });
        const marker = L.marker(anchor, {
            icon: lineHintDivIcon(hint),
            interactive: false,
        });
        marker._createTicketMeasureHint = true;
        queryLayer.addLayer(marker);
    }

    function syncCircleDrawMeasureHint(queryLayer, centerLatLng, radiusM) {
        if (!centerLatLng) return;
        const lim = digLimits();
        if (!lim) return;
        const rFt = Math.round(radiusM * LINE_DRAW_FT_PER_M);
        const maxFt = lim.MAX_CIRCLE_RADIUS_FT;
        let hint =
            lim.formatLengthFeet(rFt) +
            ' radius · ' +
            lim.formatAreaSqFt(lim.circleAreaSqFeet(radiusM));
        if (rFt >= maxFt) hint += ' · ' + maxFt + ' ft max';
        queryLayer.eachLayer(function (layer) {
            if (layer && layer._createTicketMeasureHint) {
                queryLayer.removeLayer(layer);
            }
        });
        const marker = L.marker(centerLatLng, {
            icon: lineHintDivIcon(hint),
            interactive: false,
        });
        marker._createTicketMeasureHint = true;
        queryLayer.addLayer(marker);
    }

    function lineHintDivIcon(text) {
        return L.divIcon({
            className: 'create-ticket-wizard-line-hint',
            html:
                '<div style="background: var(--app-surface, #111); color: var(--app-text-inverse, #fff); padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.2);">' +
                text +
                '</div>',
            iconSize: [140, 24],
            iconAnchor: [70, 32],
        });
    }

    function notifyCreateTicketMapDrawMobileChips() {
        if (typeof window.syncMapToolActionVisibility === 'function') {
            window.syncMapToolActionVisibility();
        }
        if (
            window.mapToolsMobileModule &&
            typeof window.mapToolsMobileModule.syncActiveChips === 'function'
        ) {
            window.mapToolsMobileModule.syncActiveChips();
        }
    }

    function prepareCreateTicketDrawSessionHygiene() {
        if (window.ticketHubModule && typeof window.ticketHubModule.cancelPolygonDrawingIfActive === 'function') {
            window.ticketHubModule.cancelPolygonDrawingIfActive();
        }
        if (window.measureModule && window.measureModule.cancelMeasureMode) {
            window.measureModule.cancelMeasureMode();
        }
        if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
            window.drawingModule.cancelDrawingMode();
        }
        if (window.photosModule && window.photosModule.cancelPhotoUpload) {
            window.photosModule.cancelPhotoUpload();
        }
        notifyCreateTicketMapDrawMobileChips();
    }

    function startBulkCreateCircleDrawing(siteIndex, handlers) {
        const map = window.map;
        if (!map) {
            if (typeof window.appAlert === 'function') window.appAlert('Map is not ready yet.');
            return;
        }
        if (!handlers || typeof handlers.onComplete !== 'function') return;
        cancelCreateTicketPolygonDrawingIfActive();
        activePolygonDrawContext = {
            type: 'bulk',
            siteIndex: siteIndex,
            handlers: handlers,
        };
        createTicketPolygonGeo =
            handlers.existingPolygon && handlers.existingPolygon.type === 'Polygon'
                ? handlers.existingPolygon
                : null;
        suspendTicketHubForCreateTicketMapDraw();
        if (typeof handlers.beforeDraw === 'function') handlers.beforeDraw();
        runCreateTicketCircleMapDrawSession();
    }

    function runCreateTicketCircleMapDrawSession() {
        const map = window.map;
        if (!map) return;
        prepareCreateTicketDrawSessionHygiene();

        const queryLayer = L.layerGroup().addTo(map);
        const container = map.getContainer();
        const supportsPointer = typeof window.PointerEvent === 'function';
        const docListenerOpts = { capture: true, passive: false };
        const prevTouchAction = container.style.touchAction;

        window.mapQueryPolygonDrawing = true;
        syncRenderedFeatureInteractionForPolygonDraw();
        notifyCreateTicketMapDrawMobileChips();
        container.style.cursor = 'crosshair';
        container.style.touchAction = 'none';

        const mapDraggingWasEnabled = map.dragging && map.dragging.enabled();
        const mapTouchZoomWasEnabled = map.touchZoom && map.touchZoom.enabled();
        const mapDoubleClickZoomWasEnabled = map.doubleClickZoom && map.doubleClickZoom.enabled();
        if (map.dragging) map.dragging.disable();
        if (map.touchZoom) map.touchZoom.disable();
        if (map.doubleClickZoom) map.doubleClickZoom.disable();

        let cancelHandler = null;
        let centerLatLng = null;
        let centerClientX = 0;
        let centerClientY = 0;
        let currentRadiusM = 0;
        let peakDragPx = 0;
        let drawingActive = false;
        let finishing = false;
        let docListenersAttached = false;
        let containerListenersAttached = false;
        let activePointerId = null;

        function restoreMapHandlers() {
            if (mapDraggingWasEnabled && map.dragging) map.dragging.enable();
            if (mapTouchZoomWasEnabled && map.touchZoom) map.touchZoom.enable();
            if (mapDoubleClickZoomWasEnabled && map.doubleClickZoom) map.doubleClickZoom.enable();
            container.style.touchAction = prevTouchAction;
        }

        function detachDocListeners() {
            if (!docListenersAttached) return;
            if (supportsPointer) {
                document.removeEventListener('pointermove', onDocPointerMove, docListenerOpts);
                document.removeEventListener('pointerup', onDocPointerUp, docListenerOpts);
                document.removeEventListener('pointercancel', onDocPointerUp, docListenerOpts);
            } else {
                document.removeEventListener('mousemove', onDocMouseMove, true);
                document.removeEventListener('mouseup', onDocMouseUp, true);
                document.removeEventListener('touchmove', onDocTouchMove, docListenerOpts);
                document.removeEventListener('touchend', onDocTouchEnd, docListenerOpts);
                document.removeEventListener('touchcancel', onDocTouchEnd, docListenerOpts);
            }
            docListenersAttached = false;
        }

        function attachDocListeners() {
            if (docListenersAttached) return;
            if (supportsPointer) {
                document.addEventListener('pointermove', onDocPointerMove, docListenerOpts);
                document.addEventListener('pointerup', onDocPointerUp, docListenerOpts);
                document.addEventListener('pointercancel', onDocPointerUp, docListenerOpts);
            } else {
                document.addEventListener('mousemove', onDocMouseMove, true);
                document.addEventListener('mouseup', onDocMouseUp, true);
                document.addEventListener('touchmove', onDocTouchMove, docListenerOpts);
                document.addEventListener('touchend', onDocTouchEnd, docListenerOpts);
                document.addEventListener('touchcancel', onDocTouchEnd, docListenerOpts);
            }
            docListenersAttached = true;
        }

        function detachContainerListeners() {
            if (!containerListenersAttached) return;
            if (supportsPointer) {
                container.removeEventListener('pointerdown', onContainerPointerDown, true);
            } else {
                container.removeEventListener('touchstart', onContainerTouchStart, docListenerOpts);
                container.removeEventListener('mousedown', onContainerMouseDown, true);
            }
            containerListenersAttached = false;
        }

        function attachContainerListeners() {
            if (containerListenersAttached) return;
            if (supportsPointer) {
                container.addEventListener('pointerdown', onContainerPointerDown, true);
            } else {
                container.addEventListener('touchstart', onContainerTouchStart, docListenerOpts);
                container.addEventListener('mousedown', onContainerMouseDown, true);
            }
            containerListenersAttached = true;
        }

        function latLngFromClientPoint(clientX, clientY) {
            const rect = container.getBoundingClientRect();
            const point = L.point(clientX - rect.left, clientY - rect.top);
            return map.containerPointToLatLng(point);
        }

        function teardownSessionUi() {
            detachContainerListeners();
            detachDocListeners();
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            try {
                map.removeLayer(queryLayer);
            } catch (e) {
                /* ignore */
            }
            container.style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            syncRenderedFeatureInteractionForPolygonDraw();
            restoreMapHandlers();
            notifyCreateTicketMapDrawMobileChips();
        }

        function destroyDrawingSession(opts) {
            opts = opts || {};
            const reopen = opts.reopenWizard === true;
            teardownSessionUi();
            if (!reopen && activePolygonDrawContext && activePolygonDrawContext.type === 'bulk') {
                activePolygonDrawContext = null;
            }
            resumeAfterPolygonDraw(reopen);
        }

        function renderCirclePreview() {
            queryLayer.clearLayers();
            if (!centerLatLng) return;
            const previewRadiusM = Math.max(currentRadiusM, CIRCLE_DRAW_MIN_RADIUS_M);
            L.circleMarker(centerLatLng, {
                radius: CIRCLE_DRAW_CENTER_MARKER_PX,
                color: '#0d9488',
                weight: 2,
                fillColor: '#14b8a6',
                fillOpacity: 1,
            }).addTo(queryLayer);
            L.circle(centerLatLng, {
                radius: previewRadiusM,
                color: '#14b8a6',
                weight: 3,
                fillColor: '#14b8a6',
                fillOpacity: 0.15,
                dashArray: '5, 5',
            }).addTo(queryLayer);
            syncCircleDrawMeasureHint(queryLayer, centerLatLng, previewRadiusM);
        }

        async function finishCreateTicketCircle() {
            if (finishing) return;
            if (!centerLatLng || currentRadiusM < CIRCLE_DRAW_MIN_RADIUS_M) {
                if (typeof window.appAlert === 'function') {
                    window.appAlert('Click and drag on the map to set the dig site circle, then tap Finish.');
                }
                return;
            }
            finishing = true;

            const geo = circleToGeoJsonPolygon(centerLatLng, currentRadiusM, CIRCLE_DRAW_RING_STEPS);
            createTicketPolygonGeo = geo;

            teardownSessionUi();
            clearCreateTicketPolygonDrawingFns();

            const bulkCtx =
                activePolygonDrawContext && activePolygonDrawContext.type === 'bulk'
                    ? activePolygonDrawContext
                    : null;
            if (!bulkCtx) return;

            const handlers = bulkCtx.handlers;
            const siteIndex = bulkCtx.siteIndex;
            activePolygonDrawContext = null;
            ctwHubWasOpenForMapDraw = false;

            let geocode = null;
            try {
                const actId =
                    typeof handlers.getActivityId === 'function' ? handlers.getActivityId() : 1;
                geocode = await reverseGeocodePolygonGeoJson(geo, actId);
            } catch (err) {
                console.error('[createTicketMapPolygon] reverse geocode', err);
            }
            if (typeof handlers.onComplete === 'function') {
                await handlers.onComplete(siteIndex, geo, geocode);
            }
            if (typeof handlers.resumeOverlay === 'function') {
                await handlers.resumeOverlay();
            }
        }

        function updateRadiusFromLatLng(latlng) {
            if (!centerLatLng || !latlng) return;
            let radiusM = map.distance(centerLatLng, latlng);
            const lim = digLimits();
            if (lim) {
                radiusM = lim.clampCircleRadiusMeters(radiusM);
            }
            currentRadiusM = radiusM;
            renderCirclePreview();
        }

        function updateFromClient(clientX, clientY) {
            const dragPx = Math.hypot(clientX - centerClientX, clientY - centerClientY);
            if (dragPx > peakDragPx) peakDragPx = dragPx;
            updateRadiusFromLatLng(latLngFromClientPoint(clientX, clientY));
        }

        function beginGesture(clientX, clientY, pointerId) {
            if (finishing || drawingActive) return;
            centerLatLng = latLngFromClientPoint(clientX, clientY);
            centerClientX = clientX;
            centerClientY = clientY;
            currentRadiusM = 0;
            peakDragPx = 0;
            drawingActive = true;
            activePointerId = pointerId != null ? pointerId : null;
            renderCirclePreview();
            attachDocListeners();
        }

        function completeOrResetGesture() {
            drawingActive = false;
            activePointerId = null;
            detachDocListeners();
            if (!centerLatLng) return;
            if (peakDragPx < CIRCLE_DRAW_MIN_DRAG_PX) {
                // Tap / no meaningful drag: clear preview and keep the draw session open.
                centerLatLng = null;
                currentRadiusM = 0;
                peakDragPx = 0;
                queryLayer.clearLayers();
                return;
            }
            if (currentRadiusM < CIRCLE_DRAW_MIN_RADIUS_M) {
                // Short intentional drag: snap to minimum dig-site radius.
                currentRadiusM = CIRCLE_DRAW_MIN_RADIUS_M;
                renderCirclePreview();
            }
            finishCreateTicketCircle().catch(function (err) {
                console.error('[createTicketMapPolygon] finish circle', err);
            });
        }

        function onContainerPointerDown(ev) {
            if (finishing || drawingActive) return;
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginGesture(ev.clientX, ev.clientY, ev.pointerId);
            try {
                if (typeof container.setPointerCapture === 'function') {
                    container.setPointerCapture(ev.pointerId);
                }
            } catch (err) {
                /* ignore capture failures */
            }
        }

        function onContainerTouchStart(ev) {
            if (finishing || drawingActive) return;
            if (!ev.touches || !ev.touches.length) return;
            const t = ev.touches[0];
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginGesture(t.clientX, t.clientY, null);
        }

        function onContainerMouseDown(ev) {
            if (finishing || drawingActive) return;
            if (ev.button !== 0) return;
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginGesture(ev.clientX, ev.clientY, null);
        }

        function onDocPointerMove(ev) {
            if (!drawingActive || finishing || !centerLatLng) return;
            if (activePointerId != null && ev.pointerId !== activePointerId) return;
            updateFromClient(ev.clientX, ev.clientY);
            if (ev.cancelable) ev.preventDefault();
        }

        function onDocPointerUp(ev) {
            if (!drawingActive || finishing) return;
            if (activePointerId != null && ev.pointerId !== activePointerId) return;
            if (centerLatLng) updateFromClient(ev.clientX, ev.clientY);
            completeOrResetGesture();
        }

        function onDocMouseMove(ev) {
            if (!drawingActive || finishing || !centerLatLng) return;
            updateFromClient(ev.clientX, ev.clientY);
        }

        function onDocMouseUp(ev) {
            if (!drawingActive || finishing) return;
            if (centerLatLng) updateFromClient(ev.clientX, ev.clientY);
            completeOrResetGesture();
        }

        function onDocTouchMove(ev) {
            if (!drawingActive || finishing || !centerLatLng) return;
            if (!ev.touches || !ev.touches.length) return;
            const t = ev.touches[0];
            updateFromClient(t.clientX, t.clientY);
            if (ev.cancelable) ev.preventDefault();
        }

        function onDocTouchEnd(ev) {
            if (!drawingActive || finishing) return;
            if (centerLatLng && ev.changedTouches && ev.changedTouches.length) {
                const t = ev.changedTouches[0];
                updateFromClient(t.clientX, t.clientY);
            }
            completeOrResetGesture();
        }

        cancelHandler = function (e) {
            if (e.key === 'Escape' && typeof createTicketPolygonDrawingCleanup === 'function') {
                const c = createTicketPolygonDrawingCleanup;
                clearCreateTicketPolygonDrawingFns();
                c({ reopenWizard: true });
            }
        };

        createTicketPolygonDrawingCleanup = destroyDrawingSession;
        createTicketPolygonDrawingFinish = finishCreateTicketCircle;
        attachContainerListeners();
        window.addEventListener('keydown', cancelHandler);
    }

    function startBulkCreateLineDrawing(siteIndex, handlers) {
        const map = window.map;
        if (!map) {
            if (typeof window.appAlert === 'function') window.appAlert('Map is not ready yet.');
            return;
        }
        if (!handlers || typeof handlers.onComplete !== 'function') return;
        cancelCreateTicketPolygonDrawingIfActive();
        activePolygonDrawContext = {
            type: 'bulk',
            siteIndex: siteIndex,
            handlers: handlers,
        };
        createTicketPolygonGeo =
            handlers.existingPolygon && handlers.existingPolygon.type === 'Polygon'
                ? handlers.existingPolygon
                : null;
        suspendTicketHubForCreateTicketMapDraw();
        if (typeof handlers.beforeDraw === 'function') handlers.beforeDraw();
        runCreateTicketLineMapDrawSession();
    }

    function runCreateTicketLineMapDrawSession() {
        const map = window.map;
        if (!map) return;
        prepareCreateTicketDrawSessionHygiene();

        const queryLayer = L.layerGroup().addTo(map);
        const container = map.getContainer();
        const supportsPointer = typeof window.PointerEvent === 'function';
        const docListenerOpts = { capture: true, passive: false };
        const prevTouchAction = container.style.touchAction;

        window.mapQueryPolygonDrawing = true;
        syncRenderedFeatureInteractionForPolygonDraw();
        notifyCreateTicketMapDrawMobileChips();
        container.style.cursor = 'crosshair';

        let cancelHandler = null;
        let phase = 1;
        let queryPoints = [];
        let lineLatLngs = [];
        let currentRadiusM = 0;
        let peakDragPx = 0;
        let drawingActive = false;
        let finishing = false;
        let widthCommitted = false;
        let gestureOriginX = 0;
        let gestureOriginY = 0;
        let docListenersAttached = false;
        let containerListenersAttached = false;
        let activePointerId = null;
        let mapHandlersDisabled = false;
        let mapDraggingWasEnabled = false;
        let mapTouchZoomWasEnabled = false;
        let mapDoubleClickZoomWasEnabled = false;
        let lineLengthCap = { maxLineFeet: 2640, label: 'City · up to 0.5 mi' };
        let lineCapRefreshToken = 0;
        /** @type {Promise<{ maxLineFeet: number, label: string }> | null} */
        let lineCapRefreshPromise = null;

        function syncLineDrawStrip() {
            const lim = digLimits();
            if (!lim) {
                setCreateTicketMapDrawStripLabel('Draw the line, then Finish');
                return;
            }
            const lenFt = lim.polylineLengthFeet(map, queryPoints);
            setCreateTicketMapDrawStripLabel(lineLengthCap.label + ' · ' + lim.formatLengthFeet(lenFt));
        }

        function refreshLineLengthCap() {
            const lim = digLimits();
            if (!lim || queryPoints.length < 1) {
                syncLineDrawStrip();
                return;
            }
            const token = ++lineCapRefreshToken;
            lineCapRefreshPromise = lim.computeLineLengthCap(map, queryPoints).then(function (cap) {
                if (token !== lineCapRefreshToken) return cap;
                lineLengthCap = cap;
                syncLineDrawStrip();
                return cap;
            });
        }

        function awaitLineCapForLatLngs(latlngs, reuseInFlightRefresh) {
            const lim = digLimits();
            if (!lim || !Array.isArray(latlngs) || latlngs.length < 1) {
                return Promise.resolve(lineLengthCap);
            }
            return lim.loadTransportData().then(function () {
                const transportCap = lim.computeTransportOnlyLineCap(map, latlngs);
                const fullPromise =
                    reuseInFlightRefresh && lineCapRefreshPromise
                        ? lineCapRefreshPromise
                        : lim.computeLineLengthCap(map, latlngs);
                return fullPromise.then(function (fullCap) {
                    const merged = lim.mergeLineCaps(fullCap, transportCap);
                    if (reuseInFlightRefresh || latlngs === queryPoints) {
                        lineLengthCap = merged;
                    }
                    return merged;
                });
            });
        }

        function clampWidthRadiusForMaxArea(radiusM) {
            const lim = digLimits();
            if (!lim || lineLatLngs.length < 2) return radiusM;
            let r = radiusM;
            let geo = bufferPolylineToGeoJsonPolygon(lineLatLngs, r);
            let guard = 0;
            while (geo && lim.exceedsMaxAreaSqFeet(map, geo) && r > LINE_DRAW_MIN_RADIUS_M && guard < 80) {
                r = Math.max(LINE_DRAW_MIN_RADIUS_M, r * 0.92);
                geo = bufferPolylineToGeoJsonPolygon(lineLatLngs, r);
                guard++;
            }
            return clampLineBufferRadiusMeters(r);
        }

        function latLngFromClientPoint(clientX, clientY) {
            const rect = container.getBoundingClientRect();
            const point = L.point(clientX - rect.left, clientY - rect.top);
            return map.containerPointToLatLng(point);
        }

        function restoreMapHandlers() {
            if (!mapHandlersDisabled) return;
            if (mapDraggingWasEnabled && map.dragging) map.dragging.enable();
            if (mapTouchZoomWasEnabled && map.touchZoom) map.touchZoom.enable();
            if (mapDoubleClickZoomWasEnabled && map.doubleClickZoom) map.doubleClickZoom.enable();
            container.style.touchAction = prevTouchAction;
            mapHandlersDisabled = false;
        }

        function disableMapHandlersForWidth() {
            if (mapHandlersDisabled) return;
            mapDraggingWasEnabled = map.dragging && map.dragging.enabled();
            mapTouchZoomWasEnabled = map.touchZoom && map.touchZoom.enabled();
            mapDoubleClickZoomWasEnabled = map.doubleClickZoom && map.doubleClickZoom.enabled();
            if (map.dragging) map.dragging.disable();
            if (map.touchZoom) map.touchZoom.disable();
            if (map.doubleClickZoom) map.doubleClickZoom.disable();
            container.style.touchAction = 'none';
            mapHandlersDisabled = true;
        }

        function detachDocListeners() {
            if (!docListenersAttached) return;
            if (supportsPointer) {
                document.removeEventListener('pointermove', onDocPointerMove, docListenerOpts);
                document.removeEventListener('pointerup', onDocPointerUp, docListenerOpts);
                document.removeEventListener('pointercancel', onDocPointerUp, docListenerOpts);
            } else {
                document.removeEventListener('mousemove', onDocMouseMove, true);
                document.removeEventListener('mouseup', onDocMouseUp, true);
                document.removeEventListener('touchmove', onDocTouchMove, docListenerOpts);
                document.removeEventListener('touchend', onDocTouchEnd, docListenerOpts);
                document.removeEventListener('touchcancel', onDocTouchEnd, docListenerOpts);
            }
            docListenersAttached = false;
        }

        function attachDocListeners() {
            if (docListenersAttached) return;
            if (supportsPointer) {
                document.addEventListener('pointermove', onDocPointerMove, docListenerOpts);
                document.addEventListener('pointerup', onDocPointerUp, docListenerOpts);
                document.addEventListener('pointercancel', onDocPointerUp, docListenerOpts);
            } else {
                document.addEventListener('mousemove', onDocMouseMove, true);
                document.addEventListener('mouseup', onDocMouseUp, true);
                document.addEventListener('touchmove', onDocTouchMove, docListenerOpts);
                document.addEventListener('touchend', onDocTouchEnd, docListenerOpts);
                document.addEventListener('touchcancel', onDocTouchEnd, docListenerOpts);
            }
            docListenersAttached = true;
        }

        function detachContainerListeners() {
            if (!containerListenersAttached) return;
            if (supportsPointer) {
                container.removeEventListener('pointerdown', onContainerPointerDown, true);
            } else {
                container.removeEventListener('touchstart', onContainerTouchStart, docListenerOpts);
                container.removeEventListener('mousedown', onContainerMouseDown, true);
            }
            containerListenersAttached = false;
        }

        function attachContainerListeners() {
            if (containerListenersAttached) return;
            if (supportsPointer) {
                container.addEventListener('pointerdown', onContainerPointerDown, true);
            } else {
                container.addEventListener('touchstart', onContainerTouchStart, docListenerOpts);
                container.addEventListener('mousedown', onContainerMouseDown, true);
            }
            containerListenersAttached = true;
        }

        function teardownSessionUi() {
            map.off('click', queryClickHandler);
            detachContainerListeners();
            detachDocListeners();
            if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
            try {
                map.removeLayer(queryLayer);
            } catch (e) {
                /* ignore */
            }
            container.style.cursor = '';
            window.mapQueryPolygonDrawing = false;
            syncRenderedFeatureInteractionForPolygonDraw();
            restoreMapHandlers();
            notifyCreateTicketMapDrawMobileChips();
        }

        function destroyDrawingSession(opts) {
            opts = opts || {};
            const reopen = opts.reopenWizard === true;
            teardownSessionUi();
            if (!reopen && activePolygonDrawContext && activePolygonDrawContext.type === 'bulk') {
                activePolygonDrawContext = null;
            }
            resumeAfterPolygonDraw(reopen);
        }

        function renderPhase1Preview() {
            queryLayer.clearLayers();
            queryPoints.forEach(function (point, index) {
                const isLast = index === queryPoints.length - 1;
                const canFinish = isLast && queryPoints.length >= 2;
                const marker = L.marker(point, {
                    icon: L.divIcon({
                        className: 'create-ticket-wizard-draw-marker',
                        html:
                            '<div style="background-color: ' +
                            (canFinish ? 'var(--app-success)' : '#0d9488') +
                            '; width: ' +
                            (canFinish ? '20' : '12') +
                            'px; height: ' +
                            (canFinish ? '20' : '12') +
                            'px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ' +
                            (canFinish ? '12' : '0') +
                            'px; font-weight: bold; cursor: ' +
                            (canFinish ? 'pointer' : 'default') +
                            ';">' +
                            (canFinish ? '✓' : '') +
                            '</div>',
                        iconSize: [canFinish ? 20 : 12, canFinish ? 20 : 12],
                        iconAnchor: [canFinish ? 10 : 6, canFinish ? 10 : 6],
                    }),
                });
                if (canFinish) {
                    marker.on('click', function (e) {
                        L.DomEvent.stopPropagation(e);
                        enterWidthPhase();
                    });
                }
                queryLayer.addLayer(marker);
            });
            if (queryPoints.length >= 2) {
                queryLayer.addLayer(
                    L.polyline(
                        queryPoints.map(function (p) {
                            return [p.lat, p.lng];
                        }),
                        {
                            color: '#14b8a6',
                            weight: 3,
                            dashArray: '5, 5',
                        }
                    )
                );
            }
        }

        function renderWidthPreview(hintText) {
            queryLayer.clearLayers();
            if (lineLatLngs.length >= 2) {
                queryLayer.addLayer(
                    L.polyline(
                        lineLatLngs.map(function (p) {
                            return [p.lat, p.lng];
                        }),
                        {
                            color: '#0d9488',
                            weight: 3,
                        }
                    )
                );
            }
            if (currentRadiusM >= LINE_DRAW_MIN_RADIUS_M) {
                const geo = bufferPolylineToGeoJsonPolygon(lineLatLngs, currentRadiusM);
                if (geo) {
                    queryLayer.addLayer(
                        L.geoJSON(geo, {
                            style: {
                                color: '#14b8a6',
                                weight: 3,
                                fillColor: '#14b8a6',
                                fillOpacity: 0.15,
                                dashArray: '5, 5',
                            },
                        })
                    );
                }
            }
            const hintAt = midpointOfPolyline(lineLatLngs);
            if (hintAt && hintText) {
                let text = hintText;
                const limHint = digLimits();
                if (limHint && currentRadiusM >= LINE_DRAW_MIN_RADIUS_M) {
                    const geoHint = bufferPolylineToGeoJsonPolygon(lineLatLngs, currentRadiusM);
                    if (geoHint) {
                        text +=
                            ' · ' + limHint.formatAreaSqFt(limHint.geoJsonPolygonAreaSqFeet(map, geoHint));
                    }
                }
                queryLayer.addLayer(
                    L.marker(hintAt, {
                        icon: lineHintDivIcon(text),
                        interactive: false,
                    })
                );
            }
        }

        function completeLinePolygon() {
            if (finishing) return;
            if (lineLatLngs.length < 2 || currentRadiusM < LINE_DRAW_MIN_RADIUS_M) {
                if (typeof window.appAlert === 'function') {
                    window.appAlert('Click and drag on the map to set the line width, then tap Finish.');
                }
                return;
            }
            finishing = true;
            const limFinish = digLimits();
            return awaitLineCapForLatLngs(lineLatLngs)
                .then(function (cap) {
                    if (limFinish && limFinish.wouldExceedLineCap(map, lineLatLngs, cap.maxLineFeet)) {
                        finishing = false;
                        if (typeof window.appAlert === 'function') {
                            window.appAlert(
                                'Line length exceeds ' +
                                    limFinish.formatLengthFeet(cap.maxLineFeet) +
                                    ' for this location (' +
                                    cap.label +
                                    ').'
                            );
                        }
                        return null;
                    }
                    const geo = bufferPolylineToGeoJsonPolygon(lineLatLngs, currentRadiusM);
                    if (!geo) {
                        finishing = false;
                        if (typeof window.appAlert === 'function') {
                            window.appAlert('Could not build a dig site from that line. Try again.');
                        }
                        return null;
                    }
                    if (limFinish && limFinish.exceedsMaxAreaSqFeet(map, geo)) {
                        finishing = false;
                        if (typeof window.appAlert === 'function') {
                            window.appAlert(
                                'Corridor area exceeds USAN maximum (' +
                                    limFinish.formatAreaSqFt(limFinish.MAX_AREA_SQ_FT) +
                                    '). Reduce line width or shorten the line.'
                            );
                        }
                        return null;
                    }
                    createTicketPolygonGeo = geo;
                    teardownSessionUi();
                    clearCreateTicketPolygonDrawingFns();

                    const bulkCtx =
                        activePolygonDrawContext && activePolygonDrawContext.type === 'bulk'
                            ? activePolygonDrawContext
                            : null;
                    if (!bulkCtx) return null;

                    const handlers = bulkCtx.handlers;
                    const siteIndex = bulkCtx.siteIndex;
                    activePolygonDrawContext = null;
                    ctwHubWasOpenForMapDraw = false;

                    return Promise.resolve()
                        .then(function () {
                            const actId =
                                typeof handlers.getActivityId === 'function' ? handlers.getActivityId() : 1;
                            return reverseGeocodePolygonGeoJson(geo, actId);
                        })
                        .catch(function (err) {
                            console.error('[createTicketMapPolygon] reverse geocode', err);
                            return null;
                        })
                        .then(function (geocode) {
                            if (typeof handlers.onComplete === 'function') {
                                return handlers.onComplete(siteIndex, geo, geocode);
                            }
                        })
                        .then(function () {
                            if (typeof handlers.resumeOverlay === 'function') {
                                return handlers.resumeOverlay();
                            }
                        });
                })
                .catch(function (err) {
                    finishing = false;
                    console.error('[createTicketMapPolygon] finish line', err);
                });
        }

        function enterWidthPhase() {
            if (phase !== 1) return;
            if (queryPoints.length < 2) {
                if (typeof window.appAlert === 'function') {
                    window.appAlert('A line needs at least 2 points.');
                }
                return;
            }
            phase = 2;
            lineLatLngs = queryPoints.slice();
            currentRadiusM = 0;
            widthCommitted = false;
            map.off('click', queryClickHandler);
            disableMapHandlersForWidth();
            attachContainerListeners();
            setCreateTicketMapDrawStripLabel('Drag to set width');
            renderWidthPreview('Drag to set width');
            notifyCreateTicketMapDrawMobileChips();
        }

        function updateWidthFromLatLng(latlng) {
            if (!latlng || lineLatLngs.length < 2) return;
            currentRadiusM = clampLineBufferRadiusMeters(
                distancePointToPolylineMeters(map, latlng, lineLatLngs)
            );
            currentRadiusM = clampWidthRadiusForMaxArea(currentRadiusM);
            renderWidthPreview(formatLineWidthFeet(currentRadiusM));
        }

        function updateFromClient(clientX, clientY) {
            const dragPx = Math.hypot(clientX - gestureOriginX, clientY - gestureOriginY);
            if (dragPx > peakDragPx) peakDragPx = dragPx;
            updateWidthFromLatLng(latLngFromClientPoint(clientX, clientY));
        }

        function beginWidthGesture(clientX, clientY, pointerId) {
            if (finishing || drawingActive || phase !== 2) return;
            gestureOriginX = clientX;
            gestureOriginY = clientY;
            peakDragPx = 0;
            drawingActive = true;
            activePointerId = pointerId != null ? pointerId : null;
            updateWidthFromLatLng(latLngFromClientPoint(clientX, clientY));
            attachDocListeners();
        }

        function completeOrResetWidthGesture() {
            drawingActive = false;
            activePointerId = null;
            detachDocListeners();
            if (peakDragPx < LINE_DRAW_MIN_DRAG_PX) {
                if (!widthCommitted) {
                    currentRadiusM = 0;
                    renderWidthPreview('Drag to set width');
                } else {
                    renderWidthPreview(formatLineWidthFeet(currentRadiusM));
                }
                return;
            }
            currentRadiusM = clampLineBufferRadiusMeters(currentRadiusM);
            widthCommitted = true;
            renderWidthPreview(formatLineWidthFeet(currentRadiusM));
            completeLinePolygon().catch(function (err) {
                console.error('[createTicketMapPolygon] finish line', err);
            });
        }

        function onContainerPointerDown(ev) {
            if (finishing || drawingActive || phase !== 2) return;
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginWidthGesture(ev.clientX, ev.clientY, ev.pointerId);
            try {
                if (typeof container.setPointerCapture === 'function') {
                    container.setPointerCapture(ev.pointerId);
                }
            } catch (err) {
                /* ignore capture failures */
            }
        }

        function onContainerTouchStart(ev) {
            if (finishing || drawingActive || phase !== 2) return;
            if (!ev.touches || !ev.touches.length) return;
            const t = ev.touches[0];
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginWidthGesture(t.clientX, t.clientY, null);
        }

        function onContainerMouseDown(ev) {
            if (finishing || drawingActive || phase !== 2) return;
            if (ev.button !== 0) return;
            if (ev.cancelable) ev.preventDefault();
            ev.stopPropagation();
            beginWidthGesture(ev.clientX, ev.clientY, null);
        }

        function onDocPointerMove(ev) {
            if (!drawingActive || finishing || phase !== 2) return;
            if (activePointerId != null && ev.pointerId !== activePointerId) return;
            updateFromClient(ev.clientX, ev.clientY);
            if (ev.cancelable) ev.preventDefault();
        }

        function onDocPointerUp(ev) {
            if (!drawingActive || finishing) return;
            if (activePointerId != null && ev.pointerId !== activePointerId) return;
            updateFromClient(ev.clientX, ev.clientY);
            completeOrResetWidthGesture();
        }

        function onDocMouseMove(ev) {
            if (!drawingActive || finishing || phase !== 2) return;
            updateFromClient(ev.clientX, ev.clientY);
        }

        function onDocMouseUp(ev) {
            if (!drawingActive || finishing) return;
            updateFromClient(ev.clientX, ev.clientY);
            completeOrResetWidthGesture();
        }

        function onDocTouchMove(ev) {
            if (!drawingActive || finishing || phase !== 2) return;
            if (!ev.touches || !ev.touches.length) return;
            const t = ev.touches[0];
            updateFromClient(t.clientX, t.clientY);
            if (ev.cancelable) ev.preventDefault();
        }

        function onDocTouchEnd(ev) {
            if (!drawingActive || finishing) return;
            if (ev.changedTouches && ev.changedTouches.length) {
                const t = ev.changedTouches[0];
                updateFromClient(t.clientX, t.clientY);
            }
            completeOrResetWidthGesture();
        }

        const queryClickHandler = function (e) {
            if (phase !== 1) return;
            L.DomEvent.stopPropagation(e);
            const limClick = digLimits();
            if (limClick && queryPoints.length >= 1) {
                const trial = queryPoints.concat([e.latlng]);
                void awaitLineCapForLatLngs(trial, false).then(function (cap) {
                    if (limClick.wouldExceedLineCap(map, trial, cap.maxLineFeet)) {
                        if (typeof window.appAlert === 'function') {
                            window.appAlert(
                                'Line length exceeds ' +
                                    limClick.formatLengthFeet(cap.maxLineFeet) +
                                    ' for this location (' +
                                    cap.label +
                                    ').'
                            );
                        }
                        return;
                    }
                    queryPoints.push(e.latlng);
                    renderPhase1Preview();
                    refreshLineLengthCap();
                });
                return;
            }
            queryPoints.push(e.latlng);
            renderPhase1Preview();
            refreshLineLengthCap();
        };

        function finishFromStrip() {
            if (phase === 1) {
                enterWidthPhase();
                return;
            }
            return completeLinePolygon();
        }

        cancelHandler = function (e) {
            if (e.key === 'Escape' && typeof createTicketPolygonDrawingCleanup === 'function') {
                const c = createTicketPolygonDrawingCleanup;
                clearCreateTicketPolygonDrawingFns();
                c({ reopenWizard: true });
            }
        };

        createTicketPolygonDrawingCleanup = destroyDrawingSession;
        createTicketPolygonDrawingFinish = finishFromStrip;
        const limBoot = digLimits();
        if (limBoot) {
            lineLengthCap = { maxLineFeet: limBoot.HALF_MILE_FT, label: 'City · up to 0.5 mi' };
            limBoot.loadTransportData();
        }
        setCreateTicketMapDrawStripLabel('Draw the line, then Finish');
        map.on('click', queryClickHandler);
        window.addEventListener('keydown', cancelHandler);
    }

    window.canUseCreateTicketWizard = canUseCreateTicketWizard;
    window.resolveCreateTicketOrgId = resolveCreateTicketOrgId;
    window.isCreateTicketMapDrawingActive = isCreateTicketMapDrawingActive;
    window.syncRenderedFeatureInteractionForPolygonDraw = syncRenderedFeatureInteractionForPolygonDraw;
    window.createTicketWizardCancelPolygonDrawingIfActive = cancelCreateTicketPolygonDrawingIfActive;
    window.finishCreateTicketMapDrawingIfActive = finishCreateTicketMapDrawingIfActive;
    window.getCreateTicketMapDrawStripLabel = getCreateTicketMapDrawStripLabel;
    window.createTicketWizardBulkApi = {
        startBulkCreatePolygonDrawing: startBulkCreatePolygonDrawing,
        startBulkCreateCircleDrawing: startBulkCreateCircleDrawing,
        startBulkCreateLineDrawing: startBulkCreateLineDrawing,
        reverseGeocodePolygonGeoJson: reverseGeocodePolygonGeoJson,
        syncBulkCreatePolygonsOnMap: syncBulkCreatePolygonsOnMap,
    };
})();
