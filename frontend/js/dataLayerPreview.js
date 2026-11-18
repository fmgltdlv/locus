// Data Layer Preview module - viewport detail at zoom 16+ only (LOD overview disabled for now)

const DATA_LAYER_DETAIL_ZOOM = 16;
const DATA_LAYER_VIEWPORT_REFRESH_MS = 150;
const CURRENT_ANNOTATIONS_LAYER_ID = '__current_annotations__';

let previewRefreshTimer = null;
let previewMapListenersAttached = false;
const previewLayerCache = new Map();

function layerId(layer) {
    return layer && layer.id != null ? layer.id : null;
}

function isCurrentAnnotationsLayer(layer) {
    return layer && layer.id === CURRENT_ANNOTATIONS_LAYER_ID;
}

function buildCurrentAnnotationsLayer() {
    let annotations = window.annotationStorageModule?.annotations || [];
    const hub = window.dataHubFiltersModule;
    if (hub?.hasActiveFilters?.('annotations')) {
        annotations = hub.filterForMap('annotations', annotations);
    }
    return {
        id: CURRENT_ANNOTATIONS_LAYER_ID,
        annotations,
        isVisible: true
    };
}

function shouldCurrentAnnotationsBeOnMap() {
    const layerManager = window.layerManagerModule;
    if (!layerManager || layerManager.annotationsLayerCleared) return false;
    if (layerManager.annotationOverlaysHiddenForTicketDraw) return false;
    if (layerManager.annotationsLayerUserWantsVisible === false) return false;
    const layer = buildCurrentAnnotationsLayer();
    return (layer.annotations || []).length > 0;
}

function ensureAnnotationsLayerGroup() {
    if (!window.layerManagerModule?.initAnnotationsLayer) return null;
    return window.layerManagerModule.initAnnotationsLayer();
}

function ensureDataLayerGroups() {
    if (!window.layerManagerModule) return null;
    if (!window.layerManagerModule.dataLayerGroups) {
        window.layerManagerModule.dataLayerGroups = new Map();
    }
    return window.layerManagerModule.dataLayerGroups;
}

function ensureLayerGroup(layer) {
    const id = layerId(layer);
    const groups = ensureDataLayerGroups();
    if (id == null || !groups) return null;
    let group = groups.get(id);
    if (!group) {
        group = L.layerGroup();
        groups.set(id, group);
    }
    return group;
}

function annotationLatLngs(annotation) {
    if (!annotation || !annotation.geometry || !annotation.geometry.coordinates) return [];
    if (annotation.type === 'point') {
        const [lng, lat] = annotation.geometry.coordinates;
        return [L.latLng(lat, lng)];
    }
    if (annotation.type === 'line') {
        return annotation.geometry.coordinates.map(coord => L.latLng(coord[1], coord[0]));
    }
    if (annotation.type === 'polygon' && annotation.geometry.coordinates[0]) {
        return annotation.geometry.coordinates[0].map(coord => L.latLng(coord[1], coord[0]));
    }
    return [];
}

function annotationBounds(annotation) {
    const latLngs = annotationLatLngs(annotation);
    if (latLngs.length === 0) return null;
    const bounds = L.latLngBounds(latLngs);
    return bounds && bounds.isValid && bounds.isValid() ? bounds : null;
}

function layerBounds(layer) {
    const all = [];
    (layer?.annotations || []).forEach(annotation => {
        all.push(...annotationLatLngs(annotation));
    });
    if (all.length === 0) return null;
    const bounds = L.latLngBounds(all);
    return bounds && bounds.isValid && bounds.isValid() ? bounds : null;
}

function sampleLatLngs(latLngs, maxPoints) {
    if (!Array.isArray(latLngs) || latLngs.length <= maxPoints) return latLngs;
    if (maxPoints <= 2) return [latLngs[0], latLngs[latLngs.length - 1]];
    const out = [];
    for (let i = 0; i < maxPoints; i++) {
        const idx = Math.round((i * (latLngs.length - 1)) / (maxPoints - 1));
        out.push(latLngs[idx]);
    }
    return out;
}

function cloneAnnotationWithLatLngs(annotation, latLngs) {
    if (annotation.type === 'point') return annotation;
    const coords = latLngs.map(ll => [ll.lng, ll.lat]);
    if (annotation.type === 'line') {
        return { ...annotation, geometry: { ...annotation.geometry, coordinates: coords } };
    }
    if (annotation.type === 'polygon') {
        const closed = coords.length > 0 ? coords.slice() : coords;
        const first = closed[0];
        const last = closed[closed.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) closed.push(first);
        return { ...annotation, geometry: { ...annotation.geometry, coordinates: [closed] } };
    }
    return annotation;
}

function simplifyAnnotation(annotation) {
    const latLngs = annotationLatLngs(annotation);
    if (annotation.type === 'line') {
        return cloneAnnotationWithLatLngs(annotation, sampleLatLngs(latLngs, 4));
    }
    if (annotation.type === 'polygon') {
        const bounds = annotationBounds(annotation);
        if (!bounds) return null;
        const rect = [
            bounds.getSouthWest(),
            L.latLng(bounds.getSouth(), bounds.getEast()),
            bounds.getNorthEast(),
            L.latLng(bounds.getNorth(), bounds.getWest()),
            bounds.getSouthWest()
        ];
        return cloneAnnotationWithLatLngs(annotation, rect);
    }
    return annotation;
}

function buildLayerCache(layer) {
    const bounds = layerBounds(layer);
    const annotationBoundsList = [];
    const overviewAnnotations = [];
    (layer.annotations || []).forEach(annotation => {
        annotationBoundsList.push(annotationBounds(annotation));
        const overview = simplifyAnnotation(annotation);
        if (overview) overviewAnnotations.push(overview);
    });
    return {
        layer,
        bounds,
        annotationBoundsList,
        overviewAnnotations
    };
}

function popupFactory() {
    return window.annotationRendererModule?.createAnnotationPopup || function () { return ''; };
}

function renderAnnotation(annotation, group, options) {
    if (!annotation || !annotation.geometry || !group) return;
    const opts = options || {};
    const createPopup = opts.bindPopup ? popupFactory() : null;
    const popupOpts = { readOnly: opts.readOnly !== false };

    if (annotation.type === 'point') {
        const coords = annotation.geometry.coordinates;
        if (!coords) return;
        const basePt = annotation.color || 'var(--app-accent)';
        const ptFill = window.utilityTypesModule?.getAnnotationIconColor
            ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, basePt)
            : basePt;
        if (opts.preview) {
            const size = 10;
            const marker = L.circleMarker([coords[1], coords[0]], {
                radius: size / 2,
                color: ptFill,
                fillColor: ptFill,
                fillOpacity: 0.45,
                weight: 2,
                interactive: false
            });
            marker.addTo(group);
            return;
        }
        const iconType = (annotation.icon && annotation.icon !== 'none') ? annotation.icon : 'circle';
        const excavationPad = annotation.utilityType === 'Proposed Excavation';
        const iconOpts = { excavationPadding: excavationPad };
        const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
        const iconHTML = getIconHTML(iconType, ptFill, iconOpts);
        const layout = window.iconsModule?.getMapIconLayout
            ? window.iconsModule.getMapIconLayout(iconOpts)
            : { size: 24, anchor: 12 };
        const marker = L.marker([coords[1], coords[0]], {
            icon: L.divIcon({
                className: 'annotation-marker',
                html: iconHTML,
                iconSize: [layout.size, layout.size],
                iconAnchor: [layout.anchor, layout.anchor],
            }),
            interactive: true
        });
        marker.addTo(group);
        if (createPopup) marker.bindPopup(createPopup(annotation, popupOpts));
    } else if (annotation.type === 'line') {
        const coords = annotation.geometry.coordinates;
        if (!coords) return;
        const col = annotation.color || 'var(--app-accent)';
        const lineBase = { color: col, weight: 3, opacity: opts.preview ? 0.65 : 1, interactive: !opts.preview };
        const lineOpts = window.featureTypeLibraryModule?.mergePolylineStyle
            ? window.featureTypeLibraryModule.mergePolylineStyle(lineBase, annotation)
            : lineBase;
        const polyline = L.polyline(coords.map(coord => [coord[1], coord[0]]), lineOpts);
        polyline.addTo(group);
        if (createPopup) polyline.bindPopup(createPopup(annotation, popupOpts));
        if (!opts.preview && annotation.icon && annotation.icon !== 'none') {
            const iconType = annotation.icon;
            const iconColor = window.utilityTypesModule?.getAnnotationIconColor
                ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, col)
                : col;
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad, size: 20 };
            const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const vLayout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 20, anchor: 10 };
            coords.forEach(coord => {
                const vertexMarker = L.marker([coord[1], coord[0]], {
                    icon: L.divIcon({
                        className: 'annotation-vertex-marker',
                        html: iconHTML,
                        iconSize: [vLayout.size, vLayout.size],
                        iconAnchor: [vLayout.anchor, vLayout.anchor],
                    }),
                });
                vertexMarker.addTo(group);
            });
        }
    } else if (annotation.type === 'polygon') {
        const coords = annotation.geometry.coordinates && annotation.geometry.coordinates[0];
        if (!coords) return;
        const col = annotation.color || 'var(--app-accent)';
        const polyBase = {
            color: col,
            weight: 3,
            fillColor: col,
            fillOpacity: opts.preview ? 0.08 : 0.2,
            opacity: opts.preview ? 0.65 : 1,
            interactive: !opts.preview
        };
        const polyOpts = window.featureTypeLibraryModule?.mergePolygonStyle
            ? window.featureTypeLibraryModule.mergePolygonStyle(polyBase, annotation)
            : polyBase;
        const polygon = L.polygon(coords.map(coord => [coord[1], coord[0]]), polyOpts);
        polygon.addTo(group);
        if (createPopup) polygon.bindPopup(createPopup(annotation, popupOpts));
        if (!opts.preview && annotation.icon && annotation.icon !== 'none') {
            const iconType = annotation.icon;
            const iconColor = window.utilityTypesModule?.getAnnotationIconColor
                ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, col)
                : col;
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad, size: 20 };
            const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const vLayout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 20, anchor: 10 };
            coords.forEach(coord => {
                const vertexMarker = L.marker([coord[1], coord[0]], {
                    icon: L.divIcon({
                        className: 'annotation-vertex-marker',
                        html: iconHTML,
                        iconSize: [vLayout.size, vLayout.size],
                        iconAnchor: [vLayout.anchor, vLayout.anchor],
                    }),
                });
                vertexMarker.addTo(group);
            });
        }
    }
}

function getAnnotationsInViewport(cache, mapBounds) {
    if (!cache || !mapBounds) return [];
    return (cache.layer.annotations || []).filter((annotation, idx) => {
        const b = cache.annotationBoundsList[idx];
        if (!b) return false;
        if (annotation.type === 'point') return mapBounds.contains(b.getCenter());
        return mapBounds.intersects(b);
    });
}

function renderViewportDetail(cache, group) {
    const map = window.map;
    if (!map) return;
    const bounds = map.getBounds();
    const annotations = getAnnotationsInViewport(cache, bounds);
    if (isCurrentAnnotationsLayer(cache.layer)) {
        if (window.annotationRendererModule?.renderAnnotationsInViewport) {
            window.annotationRendererModule.renderAnnotationsInViewport(group, annotations);
        }
        return;
    }
    annotations.forEach(annotation => renderAnnotation(annotation, group, { bindPopup: true, readOnly: true }));
}

function renderLodOverview(cache, group) {
    cache.overviewAnnotations.forEach(annotation => renderAnnotation(annotation, group, { preview: true }));
}

function layerPassesHubFilters(layer) {
    if (isCurrentAnnotationsLayer(layer)) return true;
    const hub = window.dataHubFiltersModule;
    if (!hub?.hasActiveFilters?.('layers')) return true;
    const matched = hub.filterForMap('layers', [layer]);
    return matched.length > 0;
}

function shouldLayerBeOnMap(layer) {
    if (window.layerManagerModule && window.layerManagerModule.annotationOverlaysHiddenForTicketDraw) return false;
    if (isCurrentAnnotationsLayer(layer)) return shouldCurrentAnnotationsBeOnMap();
    if (!layerPassesHubFilters(layer)) return false;
    return !!(layer && layer.isVisible !== false);
}

function resolveLayerGroup(layer) {
    if (isCurrentAnnotationsLayer(layer)) return ensureAnnotationsLayerGroup();
    return ensureLayerGroup(layer);
}

function renderLayerNow(layer) {
    const map = window.map;
    if (!map || !layer) return;
    const id = layerId(layer);
    const cache = previewLayerCache.get(id);
    if (!cache) return;
    const group = resolveLayerGroup(layer);
    if (!group) return;
    group.clearLayers();

    if (!shouldLayerBeOnMap(layer)) {
        if (map.hasLayer(group)) map.removeLayer(group);
        return;
    }

    if (map.getZoom() >= DATA_LAYER_DETAIL_ZOOM) {
        renderViewportDetail(cache, group);
        if (!map.hasLayer(group)) group.addTo(map);
        if (
            window.createTicketOverlayDrawActive &&
            typeof window.syncRenderedFeatureInteractionForPolygonDraw === 'function'
        ) {
            window.syncRenderedFeatureInteractionForPolygonDraw();
        }
    } else if (map.hasLayer(group)) {
        map.removeLayer(group);
    }
}

function refreshAnnotationsLayer() {
    const map = window.map;
    if (!map) return;
    const layer = buildCurrentAnnotationsLayer();
    const cache = buildLayerCache(layer);
    previewLayerCache.set(CURRENT_ANNOTATIONS_LAYER_ID, cache);
    ensureMapListeners();
    renderLayerNow(layer);
}

function registerLayer(layer, options) {
    if (!layer || layerId(layer) == null || !Array.isArray(layer.annotations)) return null;
    const cache = buildLayerCache(layer);
    previewLayerCache.set(layerId(layer), cache);
    ensureLayerGroup(layer);
    if (!options || options.deferRender !== true) renderLayerNow(layer);
    ensureMapListeners();
    return cache;
}

function unregisterLayer(layerIdValue) {
    previewLayerCache.delete(layerIdValue);
}

function refreshVisibleLayers(layers) {
    const sourceLayers = Array.isArray(layers)
        ? layers
        : Array.from(previewLayerCache.values())
            .map(cache => cache.layer)
            .filter(layer => !isCurrentAnnotationsLayer(layer));
    sourceLayers.forEach(layer => {
        if (!layer || layer.listInLayerPanel === false) return;
        if (!previewLayerCache.has(layerId(layer))) registerLayer(layer, { deferRender: true });
        renderLayerNow(layer);
    });
    refreshAnnotationsLayer();
}

function scheduleRefreshVisibleLayers() {
    if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
    previewRefreshTimer = setTimeout(() => {
        previewRefreshTimer = null;
        refreshVisibleLayers();
    }, DATA_LAYER_VIEWPORT_REFRESH_MS);
}

function ensureMapListeners() {
    const map = window.map;
    if (!map || previewMapListenersAttached) return;
    previewMapListenersAttached = true;
    map.on('zoomend moveend', scheduleRefreshVisibleLayers);
}

function clearAllPreviewLayers() {
    const groups = ensureDataLayerGroups();
    const map = window.map;
    if (groups && map) {
        groups.forEach(group => {
            if (group && map.hasLayer(group)) map.removeLayer(group);
            if (group && typeof group.clearLayers === 'function') group.clearLayers();
        });
        groups.clear();
    }
    const annotationsGroup = window.layerManagerModule?.annotationsLayerGroup;
    if (annotationsGroup && map) {
        if (map.hasLayer(annotationsGroup)) map.removeLayer(annotationsGroup);
        annotationsGroup.clearLayers();
    }
    previewLayerCache.clear();
}

function getLayerBounds(layer) {
    const id = layerId(layer);
    const cache = previewLayerCache.get(id);
    if (cache) return cache.bounds;
    return layerBounds(layer);
}

window.addEventListener('app:map-ready', function () {
    ensureMapListeners();
});

window.dataLayerPreviewModule = {
    DATA_LAYER_DETAIL_ZOOM,
    CURRENT_ANNOTATIONS_LAYER_ID,
    registerLayer,
    unregisterLayer,
    refreshAnnotationsLayer,
    refreshVisibleLayers,
    scheduleRefreshVisibleLayers,
    clearAllPreviewLayers,
    getLayerBounds
};
