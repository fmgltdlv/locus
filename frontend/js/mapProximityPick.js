// Map proximity pick: open line/polygon annotation popups when tap is within a pixel tolerance of the stroke.

(function () {
    /** Max distance from tap to stroke, in layer/CSS pixels. Edit this only. */
    const ANNOTATION_PROXIMITY_TOLERANCE_PX = 12;

    let installed = false;

    function distPointToSegmentSquared(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) {
            const ddx = px - x1;
            const ddy = py - y1;
            return ddx * ddx + ddy * ddy;
        }
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const qx = x1 + t * dx;
        const qy = y1 + t * dy;
        const ddx = px - qx;
        const ddy = py - qy;
        return ddx * ddx + ddy * ddy;
    }

    function flattenLatLngs(latlngs, out) {
        if (!latlngs || !latlngs.length) return out;
        const first = latlngs[0];
        if (first && typeof first.lat === 'number' && typeof first.lng === 'number') {
            for (let i = 0; i < latlngs.length; i++) out.push(latlngs[i]);
            return out;
        }
        for (let i = 0; i < latlngs.length; i++) flattenLatLngs(latlngs[i], out);
        return out;
    }

    function minDistSqOpenPolyline(map, latlngs, ptLayer) {
        if (!latlngs || latlngs.length < 2) return Infinity;
        let minSq = Infinity;
        for (let i = 0; i < latlngs.length - 1; i++) {
            const p1 = map.latLngToLayerPoint(latlngs[i]);
            const p2 = map.latLngToLayerPoint(latlngs[i + 1]);
            const d = distPointToSegmentSquared(ptLayer.x, ptLayer.y, p1.x, p1.y, p2.x, p2.y);
            if (d < minSq) minSq = d;
        }
        return minSq;
    }

    function minDistSqClosedRing(map, ring, ptLayer) {
        const n = ring.length;
        if (n < 2) return Infinity;
        let minSq = Infinity;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const p1 = map.latLngToLayerPoint(ring[i]);
            const p2 = map.latLngToLayerPoint(ring[j]);
            minSq = Math.min(minSq, distPointToSegmentSquared(ptLayer.x, ptLayer.y, p1.x, p1.y, p2.x, p2.y));
        }
        return minSq;
    }

    function minDistSqPolygon(map, latlngsNested, ptLayer) {
        const rings = [];
        if (!latlngsNested || !latlngsNested.length) return Infinity;
        if (latlngsNested[0] && typeof latlngsNested[0].lat === 'number') {
            rings.push(latlngsNested);
        } else {
            for (let r = 0; r < latlngsNested.length; r++) {
                const flat = [];
                flattenLatLngs(latlngsNested[r], flat);
                if (flat.length >= 2) rings.push(flat);
            }
        }
        let minSq = Infinity;
        for (let r = 0; r < rings.length; r++) {
            minSq = Math.min(minSq, minDistSqClosedRing(map, rings[r], ptLayer));
        }
        return minSq;
    }

    function minDistSqForPathLayer(map, layer, ptLayer) {
        if (!layer || !map) return Infinity;
        if (layer instanceof L.Polygon) {
            return minDistSqPolygon(map, layer.getLatLngs(), ptLayer);
        }
        if (layer instanceof L.Polyline) {
            const flat = [];
            flattenLatLngs(layer.getLatLngs(), flat);
            return minDistSqOpenPolyline(map, flat, ptLayer);
        }
        return Infinity;
    }

    function isPickablePathLayer(layer) {
        if (!layer) return false;
        if (layer instanceof L.Marker || layer instanceof L.CircleMarker) return false;
        if (!(layer instanceof L.Polygon) && !(layer instanceof L.Polyline)) return false;
        if (layer.options && layer.options.interactive === false) return false;
        return true;
    }

    function collectPathLayersFromGroup(group, out) {
        if (!group || typeof group.eachLayer !== 'function') return out;
        group.eachLayer(function (layer) {
            if (isPickablePathLayer(layer)) {
                out.push(layer);
            } else if (layer && typeof layer.eachLayer === 'function') {
                collectPathLayersFromGroup(layer, out);
            }
        });
        return out;
    }

    function collectPickablePathLayers() {
        const out = [];
        const tracked = window.annotationRendererModule && window.annotationRendererModule.annotationLayers;
        if (Array.isArray(tracked)) {
            tracked.forEach(function (layer) {
                if (isPickablePathLayer(layer)) out.push(layer);
            });
        }

        const annotationsGroup = window.layerManagerModule && window.layerManagerModule.annotationsLayerGroup;
        const map = window.map;
        if (annotationsGroup && map && map.hasLayer(annotationsGroup)) {
            collectPathLayersFromGroup(annotationsGroup, out);
        }

        const dataLayerGroups = window.layerManagerModule && window.layerManagerModule.dataLayerGroups;
        if (dataLayerGroups && typeof dataLayerGroups.forEach === 'function' && map) {
            dataLayerGroups.forEach(function (group) {
                if (group && map.hasLayer(group)) {
                    collectPathLayersFromGroup(group, out);
                }
            });
        }

        const seen = new Set();
        return out.filter(function (layer) {
            if (seen.has(layer)) return false;
            seen.add(layer);
            return true;
        });
    }

    function clickTargetIsOtherInteractive(originalEvent) {
        if (!originalEvent || !originalEvent.target || !originalEvent.target.closest) return false;
        const el = originalEvent.target.closest('.leaflet-interactive');
        if (!el) return false;
        if (el.closest('.leaflet-ticket-pane')) return false;
        return true;
    }

    function shouldSkipProximityPick() {
        if (window.drawingModule && window.drawingModule.currentDrawingMode) return true;
        if (window.photoUploadMode) return true;
        if (window.photoLocationTagMode) return true;
        if (window.measureModule && window.measureModule.measureMode) return true;
        if (window.documentsModule && window.documentsModule.documentLocationMode) return true;
        if (window.queryByTicketMode) return true;
        if (window.photoTicketAssociationPickMode) return true;
        if (window.mapQueryPolygonDrawing) return true;
        if (window.complianceHubProjectMapPickMode) return true;
        return false;
    }

    function findNearestMapFeatureLayer(map, latlng, tolerancePx) {
        if (!map || !latlng) return null;
        const layers = collectPickablePathLayers();
        if (!layers.length) return null;

        const ptLayer = map.latLngToLayerPoint(latlng);
        const tol = Number.isFinite(Number(tolerancePx)) ? Number(tolerancePx) : ANNOTATION_PROXIMITY_TOLERANCE_PX;
        const tolSq = tol * tol;

        let best = null;
        let bestSq = Infinity;

        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const distSq = minDistSqForPathLayer(map, layer, ptLayer);
            if (distSq <= tolSq && distSq < bestSq) {
                bestSq = distSq;
                best = layer;
            }
        }

        return best;
    }

    function onMapClickProximity(e) {
        const map = window.map;
        if (!map || shouldSkipProximityPick()) return;
        if (clickTargetIsOtherInteractive(e.originalEvent)) return;

        const layer = findNearestMapFeatureLayer(map, e.latlng, ANNOTATION_PROXIMITY_TOLERANCE_PX);
        if (!layer || typeof layer.openPopup !== 'function') return;

        layer.openPopup(e.latlng);
    }

    function initAnnotationProximityPick(map) {
        if (!map || installed) return;
        installed = true;
        map.on('click', onMapClickProximity);
    }

    window.initAnnotationProximityPick = initAnnotationProximityPick;
    window.findNearestMapFeatureLayer = findNearestMapFeatureLayer;
    window.ANNOTATION_PROXIMITY_TOLERANCE_PX = ANNOTATION_PROXIMITY_TOLERANCE_PX;
})();
