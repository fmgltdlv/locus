// Data Hub advanced filters — annotations, layers, photos, documents, events tabs.

const FILTER_VIEWS = new Set(['annotations', 'layers', 'photos', 'documents', 'events']);
const ANNOTATION_TYPES = ['point', 'line', 'polygon'];
const EVENT_COMPLETED_OPTIONS = ['Yes', 'No'];
const EVENT_UTILITY_FALLBACKS = [
    'electric',
    'gas',
    'water',
    'sewer',
    'telecommunications',
    'oil_fuel',
    'unknown',
    'other',
];

const appliedFiltersByView = {
    annotations: { types: [], utilities: [], uploadedBy: [], bounds: null },
    layers: { utilities: [], savedBy: [], bounds: null },
    photos: {
        tags: [],
        uploadedBy: [],
        bounds: null,
        dateFrom: '',
        dateTo: '',
        timeRangeEnabled: false,
        timeFrom: '00:00',
        timeTo: '23:59',
    },
    documents: { uploadedBy: [], bounds: null },
    events: { utilities: [], completed: [], bounds: null },
};

const draftFiltersByView = {};
let filterPreviewLayer = null;
const FILTER_RESULT_LAYER_IDS = {
    documents: 'data-hub-document-filter',
    events: 'data-hub-event-filter',
};
const FILTER_RESULT_LAYER_LABELS = {
    documents: 'Filter results: Documents',
    events: 'Filter results: Events',
};
const filterResultMarkersByView = {
    documents: null,
    events: null,
};
const filterResultLayerRegistered = {
    documents: false,
    events: false,
};

function cloneFilterState(state) {
    if (!state) return null;
    return {
        types: [...(state.types || [])],
        utilities: [...(state.utilities || [])],
        uploadedBy: [...(state.uploadedBy || [])],
        savedBy: [...(state.savedBy || [])],
        tags: [...(state.tags || [])],
        completed: [...(state.completed || [])],
        bounds: state.bounds ? JSON.parse(JSON.stringify(state.bounds)) : null,
        dateFrom: state.dateFrom ? String(state.dateFrom) : '',
        dateTo: state.dateTo ? String(state.dateTo) : '',
        timeRangeEnabled: !!state.timeRangeEnabled,
        timeFrom: state.timeFrom ? String(state.timeFrom) : '00:00',
        timeTo: state.timeTo ? String(state.timeTo) : '23:59',
    };
}

function emptyFiltersForView(view) {
    if (view === 'annotations') return { types: [], utilities: [], uploadedBy: [], bounds: null };
    if (view === 'layers') return { utilities: [], savedBy: [], bounds: null };
    if (view === 'photos')
        return {
            tags: [],
            uploadedBy: [],
            bounds: null,
            dateFrom: '',
            dateTo: '',
            timeRangeEnabled: false,
            timeFrom: '00:00',
            timeTo: '23:59',
        };
    if (view === 'documents') return { uploadedBy: [], bounds: null };
    if (view === 'events') return { utilities: [], completed: [], bounds: null };
    return null;
}

function getFilters(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v)) return null;
    return appliedFiltersByView[v];
}

function getDraftFilters(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!draftFiltersByView[v]) {
        draftFiltersByView[v] = cloneFilterState(getFilters(v) || emptyFiltersForView(v));
    }
    return draftFiltersByView[v];
}

function resetDraftFromApplied(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    draftFiltersByView[v] = cloneFilterState(getFilters(v) || emptyFiltersForView(v));
}

function geometryToLeafletPolygon(geometry) {
    if (!geometry || geometry.type !== 'Polygon' || !geometry.coordinates?.[0]) return null;
    const coords = geometry.coordinates[0].map((c) => [c[1], c[0]]);
    return L.polygon(coords);
}

function getAnnotationUtilityType(annotation) {
    if (annotation.utilityType) return annotation.utilityType;
    const ut = window.utilityTypesModule;
    if (ut?.getUtilityTypeFromColor && annotation.color) {
        return ut.getUtilityTypeFromColor(annotation.color) || '';
    }
    return '';
}

function getLayerSavedBy(layer) {
    if (layer.createdBy) return layer.createdBy;
    const ann = (layer.annotations || []).find((a) => a.createdBy);
    return ann?.createdBy || '';
}

function getPhotoCoordinates(photo) {
    if (photo.exifData?.gpsLat != null && photo.exifData?.gpsLng != null) {
        return { lat: photo.exifData.gpsLat, lng: photo.exifData.gpsLng };
    }
    if (photo.latlng?.lat != null && photo.latlng?.lng != null) {
        return { lat: photo.latlng.lat, lng: photo.latlng.lng };
    }
    if (photo.lat != null && photo.lng != null) {
        return { lat: photo.lat, lng: photo.lng };
    }
    return null;
}

function ticketPolygonIntersectsFilter(ticketPolygon, filterPolygon) {
    const tq = window.tableQueriesModule;
    if (!tq?.isPointInPolygon || !filterPolygon) return false;
    let ring = [];
    if (ticketPolygon?.type === 'Polygon' && ticketPolygon.coordinates?.[0]) {
        ring = ticketPolygon.coordinates[0];
    } else if (Array.isArray(ticketPolygon)) {
        ring = ticketPolygon.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat]));
    }
    if (!ring.length) return false;
    return ring.some((c) => {
        const point = L.latLng(c[1], c[0]);
        return filterPolygon.getBounds().contains(point) && tq.isPointInPolygon(point, filterPolygon);
    });
}

function photoMatchesBounds(photo, boundsGeometry) {
    const filterPolygon = geometryToLeafletPolygon(boundsGeometry);
    if (!filterPolygon) return false;
    const tq = window.tableQueriesModule;
    const photoMod = window.photoTicketAssociationModule;
    const coords = getPhotoCoordinates(photo);
    if (coords && tq?.isPointInPolygon) {
        const point = L.latLng(coords.lat, coords.lng);
        return filterPolygon.getBounds().contains(point) && tq.isPointInPolygon(point, filterPolygon);
    }
    const ticketId = photoMod?.getPhotoAssociatedTicketId?.(photo);
    if (ticketId == null) return false;
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find(
        (t) => String(t.id) === String(ticketId) || String(t.ticketId) === String(ticketId)
    );
    if (!ticket?.polygon) return false;
    return ticketPolygonIntersectsFilter(ticket.polygon, filterPolygon);
}

function annotationMatchesBounds(annotation, boundsGeometry) {
    const filterPolygon = geometryToLeafletPolygon(boundsGeometry);
    if (!filterPolygon) return false;
    return window.tableQueriesModule?.annotationIntersectsPolygon?.(annotation, filterPolygon) || false;
}

function layerMatchesBounds(layer, boundsGeometry) {
    const anns = layer.annotations || [];
    return anns.some((a) => annotationMatchesBounds(a, boundsGeometry));
}

function documentMatchesBounds(doc, boundsGeometry) {
    const filterPolygon = geometryToLeafletPolygon(boundsGeometry);
    if (!filterPolygon || !doc?.geometry) return false;
    return window.tableQueriesModule?.documentIntersectsPolygon?.(doc.geometry, filterPolygon) || false;
}

function eventMatchesBounds(report, boundsGeometry) {
    const filterPolygon = geometryToLeafletPolygon(boundsGeometry);
    if (!filterPolygon) return false;
    const loc = report?.location;
    if (loc?.lat == null || loc?.lng == null) return false;
    const tq = window.tableQueriesModule;
    const point = L.latLng(loc.lat, loc.lng);
    return filterPolygon.getBounds().contains(point) && !!tq?.isPointInPolygon?.(point, filterPolygon);
}

function isEventFormCompletedForFilter(report) {
    if (window.eventsTableRenderer?.isEventFormCompleted) {
        return !!window.eventsTableRenderer.isEventFormCompleted(report);
    }
    if (!report) return false;
    return !!(report.technicianSignature === true && (report.description || report.utilityType || report.severity));
}

function matchesMultiSelect(selected, value) {
    if (!selected || selected.length === 0) return true;
    return selected.includes(value);
}

function applyAnnotationsFilters(items, filters) {
    if (!filters) return items;
    const f = filters;
    return (items || []).filter((annotation) => {
        if (f.types?.length && !f.types.includes(annotation.type)) return false;
        if (f.utilities?.length) {
            const util = getAnnotationUtilityType(annotation);
            if (!f.utilities.includes(util)) return false;
        }
        if (f.uploadedBy?.length) {
            const by = annotation.createdBy || '';
            if (!f.uploadedBy.includes(by)) return false;
        }
        if (f.bounds && !annotationMatchesBounds(annotation, f.bounds)) return false;
        return true;
    });
}

function applyLayersFilters(items, filters) {
    if (!filters) return items;
    const various = window.utilityTypesModule?.DATA_LAYER_UTILITY_VARIOUS || 'Various';
    return (items || []).filter((layer) => {
        if (filters.utilities?.length) {
            const util = layer.utilityType || various;
            if (!filters.utilities.includes(util)) return false;
        }
        if (filters.savedBy?.length) {
            const by = getLayerSavedBy(layer);
            if (!filters.savedBy.includes(by)) return false;
        }
        if (filters.bounds && !layerMatchesBounds(layer, filters.bounds)) return false;
        return true;
    });
}

function applyPhotosFilters(items, filters) {
    if (!filters) return items;
    const tagMod = window.photoTagsModule;
    const range = photoFilterRangeMs(filters);
    const fromMs = range.fromMs;
    const toMs = range.toMs;
    return (items || []).filter((photo) => {
        if (filters.tags?.length) {
            const tags = tagMod?.getPhotoTags ? tagMod.getPhotoTags(photo) : [];
            if (!filters.tags.some((t) => tags.includes(t))) return false;
        }
        if (filters.uploadedBy?.length) {
            const by = photo.uploadedBy || '';
            if (!filters.uploadedBy.includes(by)) return false;
        }
        if (filters.bounds && !photoMatchesBounds(photo, filters.bounds)) return false;
        if (fromMs != null || toMs != null) {
            const t = photoCreatedAtMs(photo);
            if (t == null) return false;
            if (fromMs != null && t < fromMs) return false;
            if (toMs != null && t > toMs) return false;
        }
        return true;
    });
}

function photoCreatedAtMs(photo) {
    if (!photo || photo.createdAt == null || photo.createdAt === '') return null;
    const d =
        typeof window.parseInstantForDisplay === 'function'
            ? window.parseInstantForDisplay(photo.createdAt)
            : new Date(photo.createdAt);
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.getTime();
}

/** Pacific start of day for YYYY-MM-DD (inclusive). */
function photoFilterDateStartMs(ymd) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
    if (typeof window.pacificYmdHmToUtcMs === 'function') {
        return window.pacificYmdHmToUtcMs(String(ymd), 0, 0, 0);
    }
    return null;
}

/** Pacific end of day for YYYY-MM-DD (inclusive). */
function photoFilterDateEndMs(ymd) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
    if (typeof window.pacificYmdHmToUtcMs === 'function') {
        return window.pacificYmdHmToUtcMs(String(ymd), 23, 59, 59) + 999;
    }
    return null;
}

function photoFilterDateTimeStartMs(ymd, timeHm) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
    const parts = String(timeHm || '00:00').split(':').map(Number);
    if (typeof window.pacificYmdHmToUtcMs === 'function') {
        return window.pacificYmdHmToUtcMs(String(ymd), parts[0] || 0, parts[1] || 0, 0);
    }
    return null;
}

function photoFilterDateTimeEndMs(ymd, timeHm) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
    const parts = String(timeHm || '23:59').split(':').map(Number);
    if (typeof window.pacificYmdHmToUtcMs === 'function') {
        return window.pacificYmdHmToUtcMs(String(ymd), parts[0] || 0, parts[1] || 0, 59) + 999;
    }
    return null;
}

function photoFilterRangeMs(filters) {
    if (!filters) return { fromMs: null, toMs: null };
    if (filters.timeRangeEnabled) {
        const fromMs = filters.dateFrom
            ? photoFilterDateTimeStartMs(filters.dateFrom, filters.timeFrom || '00:00')
            : null;
        let toMs = null;
        if (filters.dateTo) {
            toMs = photoFilterDateTimeEndMs(filters.dateTo, filters.timeTo || '23:59');
        } else if (filters.dateFrom) {
            toMs = photoFilterDateTimeEndMs(filters.dateFrom, filters.timeTo || '23:59');
        }
        return { fromMs, toMs };
    }
    return {
        fromMs: photoFilterDateStartMs(filters.dateFrom),
        toMs: photoFilterDateEndMs(filters.dateTo),
    };
}

function getPhotosMapCreatedParams() {
    const f = getFilters('photos');
    if (!f || (!f.dateFrom && !f.dateTo)) return {};
    const range = photoFilterRangeMs(f);
    const out = {};
    if (range.fromMs != null) out.createdFrom = new Date(range.fromMs).toISOString();
    if (range.toMs != null) out.createdTo = new Date(range.toMs).toISOString();
    return out;
}

function formatPhotoFilterDateLabel(ymd) {
    if (!ymd) return '';
    const ms = photoFilterDateStartMs(ymd);
    if (ms == null) return String(ymd);
    const d = new Date(ms);
    if (typeof window.formatRecordedDate === 'function') {
        return window.formatRecordedDate(d, String(ymd), String(ymd));
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function applyDocumentsFilters(items, filters) {
    if (!filters) return items;
    return (items || []).filter((doc) => {
        if (filters.uploadedBy?.length) {
            const by = doc.uploadedBy || '';
            if (!filters.uploadedBy.includes(by)) return false;
        }
        if (filters.bounds && !documentMatchesBounds(doc, filters.bounds)) return false;
        return true;
    });
}

function applyEventsFilters(items, filters) {
    if (!filters) return items;
    return (items || []).filter((report) => {
        if (filters.utilities?.length) {
            const util = report.utilityType || '';
            if (!filters.utilities.includes(util)) return false;
        }
        if (filters.completed?.length) {
            const label = isEventFormCompletedForFilter(report) ? 'Yes' : 'No';
            if (!filters.completed.includes(label)) return false;
        }
        if (filters.bounds && !eventMatchesBounds(report, filters.bounds)) return false;
        return true;
    });
}

function applyFilters(view, items) {
    const v = view || window.dataWindowModule?.currentDataView;
    const filters = getFilters(v);
    if (!filters || !items) return items || [];
    if (v === 'annotations') return applyAnnotationsFilters(items, filters);
    if (v === 'layers') return applyLayersFilters(items, filters);
    if (v === 'photos') return applyPhotosFilters(items, filters);
    if (v === 'documents') return applyDocumentsFilters(items, filters);
    if (v === 'events') return applyEventsFilters(items, filters);
    return items;
}

function filterForMap(view, items) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v) || !hasActiveFilters(v)) return items || [];
    return applyFilters(v, items || []);
}

function hasActiveMapFilters(view) {
    return hasActiveFilters(view);
}

function hasAnyActiveMapFilters() {
    for (const v of FILTER_VIEWS) {
        if (hasActiveFilters(v)) return true;
    }
    return false;
}

const DATA_HUB_OPEN_BUTTON_DEFAULT_TITLE =
    'Data Hub: annotations, layers, photos, documents, and events';
const DATA_HUB_OPEN_BUTTON_FILTERED_TITLE = 'Data Hub — map filter active';

function isDataHubWindowOpen() {
    const dataWindow = document.getElementById('dataWindow');
    return !!(dataWindow && dataWindow.classList.contains('show'));
}

function syncDataHubMapFilterIndicator() {
    const show = hasAnyActiveMapFilters() && !isDataHubWindowOpen();
    const hubBtn = document.getElementById('dataHubOpenButton');
    if (hubBtn) {
        hubBtn.classList.toggle('map-top-left-hub-btn--map-filtered', show);
        if (typeof window.applyDataHubDraftBadge === 'function') {
            window.applyDataHubDraftBadge();
        } else {
            const title = show ? DATA_HUB_OPEN_BUTTON_FILTERED_TITLE : DATA_HUB_OPEN_BUTTON_DEFAULT_TITLE;
            hubBtn.title = title;
            hubBtn.setAttribute('aria-label', title);
        }
    }
    if (typeof window.syncMapTopLeftDataHubFilterBubble === 'function') {
        window.syncMapTopLeftDataHubFilterBubble(show);
    }
}

function refreshMapForView(view, options) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v)) return;
    if (v === 'photos') {
        const loader = window.photoMapLoaderModule;
        if (loader && typeof loader.clearPhotoMapCache === 'function') {
            loader.clearPhotoMapCache();
        }
        if (loader && typeof loader.scheduleFetchPhotoMapForViewport === 'function') {
            loader.scheduleFetchPhotoMapForViewport(true);
        }
        window.photosModule?.reloadPhotosOnMap?.();
        return;
    }
    if (v === 'annotations') {
        window.annotationRendererModule?.renderAnnotations?.();
        return;
    }
    if (v === 'layers') {
        const layers = window.annotationStorageModule?.savedDataLayers || [];
        window.dataLayerPreviewModule?.refreshVisibleLayers?.(layers);
        return;
    }
    if (v === 'documents' || v === 'events') {
        syncFilterResultMarkers(v, options);
    }
}

function getFilterSignature(view) {
    const f = getFilters(view);
    if (!f) return '';
    return JSON.stringify(f);
}

function hasActiveFilters(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    const f = getFilters(v);
    if (!f) return false;
    if (f.bounds) return true;
    if (f.dateFrom || f.dateTo) return true;
    if (f.timeRangeEnabled) return true;
    return ['types', 'utilities', 'uploadedBy', 'savedBy', 'tags', 'completed'].some(
        (k) => Array.isArray(f[k]) && f[k].length > 0
    );
}

function getFilterSummaryText(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    const f = getFilters(v);
    if (!f || !hasActiveFilters(v)) return '';
    const parts = [];
    if (v === 'annotations') {
        if (f.types?.length) parts.push(`${f.types.length} type(s)`);
        if (f.utilities?.length) parts.push(`${f.utilities.length} utility(ies)`);
        if (f.uploadedBy?.length) parts.push(`${f.uploadedBy.length} uploader(s)`);
    } else if (v === 'layers') {
        if (f.utilities?.length) parts.push(`${f.utilities.length} utility(ies)`);
        if (f.savedBy?.length) parts.push(`${f.savedBy.length} saver(s)`);
    } else if (v === 'photos') {
        if (f.dateFrom || f.dateTo) {
            const fromLabel = f.dateFrom ? formatPhotoFilterDateLabel(f.dateFrom) : '…';
            const toLabel = f.dateTo ? formatPhotoFilterDateLabel(f.dateTo) : '…';
            let rangeLabel = `${fromLabel}–${toLabel}`;
            if (f.timeRangeEnabled) {
                rangeLabel += ` ${f.timeFrom || '00:00'}–${f.timeTo || '23:59'}`;
            }
            parts.push(rangeLabel);
        }
        if (f.tags?.length) parts.push(`${f.tags.length} tag(s)`);
        if (f.uploadedBy?.length) parts.push(`${f.uploadedBy.length} uploader(s)`);
    } else if (v === 'documents') {
        if (f.uploadedBy?.length) parts.push(`${f.uploadedBy.length} uploader(s)`);
    } else if (v === 'events') {
        if (f.utilities?.length) parts.push(`${f.utilities.length} utility(ies)`);
        if (f.completed?.length) parts.push(`${f.completed.length} completion status(es)`);
    }
    if (f.bounds) parts.push('map area');
    return parts.length ? `Filters: ${parts.join(', ')}.` : '';
}

function clearFilters(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v)) return;
    appliedFiltersByView[v] = emptyFiltersForView(v);
    draftFiltersByView[v] = cloneFilterState(appliedFiltersByView[v]);
    clearFilterPreview();
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(v);
    }
    syncSearchIconBadge();
    if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
    syncDataHubMapFilterIndicator();
    refreshMapForView(v);
}

function setBounds(view, geometry) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v)) return;
    appliedFiltersByView[v].bounds = geometry;
    draftFiltersByView[v] = cloneFilterState(appliedFiltersByView[v]);
    showFilterPreview(geometry);
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(v);
    }
    syncSearchIconBadge();
    if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
    syncDataHubMapFilterIndicator();
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    syncPanelForView(v);
    refreshMapForView(v, { fitBounds: true });
}

function clearFilterPreview() {
    const map = window.map;
    if (filterPreviewLayer && map) {
        map.removeLayer(filterPreviewLayer);
        filterPreviewLayer = null;
    }
}

function showFilterPreview(geometry) {
    clearFilterPreview();
    const map = window.map;
    const poly = geometryToLeafletPolygon(geometry);
    if (!map || !poly) return;
    filterPreviewLayer = L.layerGroup().addTo(map);
    L.polygon(poly.getLatLngs(), {
        color: 'var(--app-accent)',
        weight: 2,
        fillColor: 'var(--app-accent)',
        fillOpacity: 0.08,
        dashArray: '6, 4',
    }).addTo(filterPreviewLayer);
}

function getTicketCentroid(ticket) {
    if (!ticket?.polygon) return null;
    let poly = null;
    const p = ticket.polygon;
    if (p.type === 'Polygon' && p.coordinates?.[0]) {
        const coords = p.coordinates[0].map((c) => [c[1], c[0]]);
        poly = L.polygon(coords);
    } else if (Array.isArray(p)) {
        const coords = p.map((pt) => (Array.isArray(pt) ? [pt[1], pt[0]] : [pt.lat, pt.lng]));
        poly = L.polygon(coords);
    }
    if (!poly) return null;
    try {
        const bounds = poly.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            const center = bounds.getCenter();
            return { lat: center.lat, lng: center.lng };
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

function getTicketById(ticketId) {
    const tickets = window.ORG_TICKETS || [];
    return tickets.find(
        (t) => String(t.id) === String(ticketId) || String(t.ticketId) === String(ticketId)
    );
}

function getDocumentMapPoint(doc) {
    const geometry = doc?.geometry;
    if (!geometry || !geometry.coordinates) return null;
    if (geometry.type === 'Point') {
        const [lng, lat] = geometry.coordinates;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
    }
    if (geometry.type === 'LineString' && geometry.coordinates.length) {
        const mid = geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
        return { lat: mid[1], lng: mid[0] };
    }
    if (geometry.type === 'Polygon' && geometry.coordinates?.[0]?.length) {
        const ring = geometry.coordinates[0];
        let latSum = 0;
        let lngSum = 0;
        ring.forEach((c) => {
            lngSum += c[0];
            latSum += c[1];
        });
        return { lat: latSum / ring.length, lng: lngSum / ring.length };
    }
    return null;
}

function createDocumentFilterMarkerIcon() {
    return L.divIcon({
        className: 'document-filter-marker',
        html:
            '<div style="background-color:var(--app-accent);width:24px;height:24px;border-radius:50%;border:2px solid var(--app-text-inverse);box-shadow:0 2px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:var(--app-text-inverse);font-size:12px;font-weight:bold;">D</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
    });
}

function createEventFilterMarkerIcon() {
    if (window.mapIcons && typeof window.mapIcons.buildEventMapDivIconOptions === 'function') {
        return L.divIcon(window.mapIcons.buildEventMapDivIconOptions());
    }
    return L.divIcon({
        className: 'event-marker',
        html:
            '<div style="background-color:var(--app-danger);width:24px;height:24px;border-radius:50%;border:2px solid var(--app-text-inverse);box-shadow:0 2px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:var(--app-text-inverse);font-size:14px;font-weight:bold;">⚠</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
    });
}

function buildDocumentFilterPopupHtml(doc) {
    const esc =
        typeof escapeHtmlText === 'function'
            ? escapeHtmlText
            : (s) =>
                  String(s ?? '')
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;');
    const name = esc(doc?.fileName || 'Document');
    const by = doc?.uploadedBy ? `<div class="map-leaflet-popup__meta">Uploaded by: <strong>${esc(doc.uploadedBy)}</strong></div>` : '';
    return `<div class="map-leaflet-popup"><div class="map-leaflet-popup__title">${name}</div>${by}</div>`;
}

function buildEventFilterPopupHtml(report) {
    const esc =
        typeof escapeHtmlText === 'function'
            ? escapeHtmlText
            : (s) =>
                  String(s ?? '')
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;');
    const ticket = esc(report?.ticketNumber || '—');
    const date = esc(report?.incidentDate || '—');
    const severity = esc(report?.severity || '—');
    const gpsRow =
        report?.location && typeof window.buildMapPopupGpsRow === 'function'
            ? window.buildMapPopupGpsRow(report.location.lat, report.location.lng)
            : '';
    return (
        '<div class="map-leaflet-popup">' +
        '<div class="map-leaflet-popup__title">Event Report</div>' +
        `<div class="map-leaflet-popup__meta">Ticket: <strong>${ticket}</strong></div>` +
        `<div class="map-leaflet-popup__meta">Date: <strong>${date}</strong></div>` +
        `<div class="map-leaflet-popup__meta">Severity: <strong>${severity}</strong></div>` +
        gpsRow +
        '</div>'
    );
}

function getEventsForFilterMarkers() {
    let reports = [];
    if (window.reportedEventsStore?.getReportsForCurrentOrg) {
        reports = window.reportedEventsStore.getReportsForCurrentOrg() || [];
    }
    if (!reports.length) {
        try {
            let currentOrgId = null;
            if (window.authModule?.isAuthenticated?.()) {
                currentOrgId = window.authModule.getCurrentUser()?.organizationId;
            }
            const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            reports = allReports.filter((report) => report.organizationId === currentOrgId);
        } catch (_) {
            reports = [];
        }
    }
    return reports;
}

function clearFilterResultMarkers(view) {
    const v = view;
    if (v !== 'documents' && v !== 'events') return;
    const layerId = FILTER_RESULT_LAYER_IDS[v];
    const group = filterResultMarkersByView[v];
    const tq = window.tableQueriesModule;
    if (tq?.removeTempLayerFromControl) {
        tq.removeTempLayerFromControl(layerId, group);
    } else if (group && window.map) {
        try {
            window.map.removeLayer(group);
        } catch (_) {
            /* ignore */
        }
    }
    filterResultMarkersByView[v] = null;
    filterResultLayerRegistered[v] = false;
}

function syncFilterResultMarkers(view, options) {
    const fitBounds = !!(options && options.fitBounds);
    const v = view;
    if (v !== 'documents' && v !== 'events') return;

    if (!hasActiveFilters(v)) {
        clearFilterResultMarkers(v);
        return;
    }

    const map = window.map;
    const tq = window.tableQueriesModule;
    if (!map || !tq) return;

    let filtered = [];
    if (v === 'documents') {
        const docs = window.documentsModule?.savedDocuments || [];
        filtered = applyDocumentsFilters(docs, getFilters(v));
    } else {
        filtered = applyEventsFilters(getEventsForFilterMarkers(), getFilters(v));
    }

    let group = filterResultMarkersByView[v];
    if (!group) {
        group = L.layerGroup().addTo(map);
        filterResultMarkersByView[v] = group;
    } else {
        group.clearLayers();
        if (!map.hasLayer(group)) group.addTo(map);
    }

    filtered.forEach((item) => {
        let point = null;
        if (v === 'documents') {
            point = getDocumentMapPoint(item);
        } else if (item?.location?.lat != null && item?.location?.lng != null) {
            point = { lat: Number(item.location.lat), lng: Number(item.location.lng) };
        }
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
        const icon = v === 'documents' ? createDocumentFilterMarkerIcon() : createEventFilterMarkerIcon();
        const marker = L.marker([point.lat, point.lng], { icon });
        const popupHtml = v === 'documents' ? buildDocumentFilterPopupHtml(item) : buildEventFilterPopupHtml(item);
        marker.bindPopup(popupHtml);
        marker.addTo(group);
    });

    if (group.getLayers().length === 0) {
        clearFilterResultMarkers(v);
        return;
    }

    const layerId = FILTER_RESULT_LAYER_IDS[v];
    if (!filterResultLayerRegistered[v] && tq.addTempLayerToControl) {
        tq.addTempLayerToControl(layerId, FILTER_RESULT_LAYER_LABELS[v], group);
        filterResultLayerRegistered[v] = true;
    }

    if (fitBounds) {
        try {
            const bounds = group.getBounds();
            if (bounds?.isValid?.()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        } catch (_) {
            /* ignore */
        }
    }
}

function collectDistinctValues(items, getter) {
    const set = new Set();
    (items || []).forEach((item) => {
        const v = getter(item);
        if (v) set.add(v);
    });
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

function getUtilityOptions() {
    const ut = window.utilityTypesModule;
    const opts = ut?.UTILITY_TYPE_OPTIONS ? [...ut.UTILITY_TYPE_OPTIONS] : [];
    const various = ut?.DATA_LAYER_UTILITY_VARIOUS || 'Various';
    if (!opts.includes(various)) opts.push(various);
    return opts;
}

function getUploadedByOptions(view) {
    if (view === 'annotations') {
        const anns = window.annotationStorageModule?.annotations || [];
        return collectDistinctValues(anns, (a) => a.createdBy);
    }
    if (view === 'photos') {
        const photos = window.photosModule?.savedPhotos || [];
        return collectDistinctValues(photos, (p) => p.uploadedBy);
    }
    if (view === 'documents') {
        const docs = window.documentsModule?.savedDocuments || [];
        return collectDistinctValues(docs, (d) => d.uploadedBy);
    }
    return [];
}

function getSavedByOptions() {
    const layers = window.annotationStorageModule?.savedDataLayers || [];
    return collectDistinctValues(layers, (l) => getLayerSavedBy(l));
}

function getTagOptions() {
    const tagMod = window.photoTagsModule;
    const photos = window.photosModule?.savedPhotos || [];
    const fromPhotos = tagMod?.collectOrgPhotoTagsFromLocalPhotos
        ? tagMod.collectOrgPhotoTagsFromLocalPhotos(photos)
        : [];
    const presets = tagMod?.PHOTO_TAG_PRESETS ? [...tagMod.PHOTO_TAG_PRESETS] : [];
    const set = new Set([...presets, ...fromPhotos]);
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

function getEventUtilityOptions() {
    let reports = [];
    if (window.reportedEventsStore?.getReportsForCurrentOrg) {
        reports = window.reportedEventsStore.getReportsForCurrentOrg() || [];
    }
    const fromData = collectDistinctValues(reports, (r) => r.utilityType);
    const set = new Set([...EVENT_UTILITY_FALLBACKS, ...fromData]);
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

function esc(s) {
    return typeof escapeHtmlText === 'function' ? escapeHtmlText(String(s)) : String(s);
}

function escAttr(s) {
    return typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(String(s)) : String(s);
}

function renderCheckboxGroup(sectionId, label, options, selected, namePrefix) {
    if (!options.length) {
        return `<div class="data-hub-filter-section" data-section="${escAttr(sectionId)}"><h4 class="data-hub-filter-heading">${esc(label)}</h4><p class="data-hub-filter-empty">No options available</p></div>`;
    }
    const boxes = options
        .map((opt) => {
            const checked = selected.includes(opt) ? ' checked' : '';
            const id = `${namePrefix}-${escAttr(opt).replace(/\s+/g, '-')}`;
            return `<label class="data-hub-filter-check"><input type="checkbox" class="data-hub-filter-cb" data-filter-key="${escAttr(sectionId)}" value="${escAttr(opt)}" id="${id}"${checked}><span>${esc(opt)}</span></label>`;
        })
        .join('');
    return `<div class="data-hub-filter-section" data-section="${escAttr(sectionId)}"><h4 class="data-hub-filter-heading">${esc(label)}</h4><div class="data-hub-filter-checks">${boxes}</div></div>`;
}

function renderSortSection(view, isMobile) {
    const sortMod = window.tableSortingModule;
    const sort = sortMod?.getSortStateForView ? sortMod.getSortStateForView(view) : sortMod?.getSortState?.() || {};
    const col = sort.column || '';
    const dir = sort.direction || 'asc';
    const currentVal = col ? `${col}:${dir}` : '';

    const dateRadios = [
        { val: 'created:desc', label: 'Newest first' },
        { val: 'created:asc', label: 'Oldest first' },
    ];
    const dateHtml = dateRadios
        .map((r) => {
            const checked = currentVal === r.val ? ' checked' : '';
            return `<label class="data-hub-filter-radio"><input type="radio" name="dataHubSortDate" class="data-hub-sort-radio" value="${escAttr(r.val)}"${checked}><span>${esc(r.label)}</span></label>`;
        })
        .join('');

    let extraOpts = '';
    if (view === 'documents' || isMobile) {
        const extras = [
            { val: 'name:asc', label: 'Name (A–Z)' },
            { val: 'name:desc', label: 'Name (Z–A)' },
        ];
        if (view === 'documents') {
            extras.push({ val: 'size:asc', label: 'Size (smallest first)' });
            extras.push({ val: 'size:desc', label: 'Size (largest first)' });
        }
        const opts = extras
            .map((r) => `<option value="${escAttr(r.val)}"${currentVal === r.val ? ' selected' : ''}>${esc(r.label)}</option>`)
            .join('');
        extraOpts = `<label class="data-hub-filter-sort-extra-label" for="dataHubSortExtra">Also sort by</label><select id="dataHubSortExtra" class="data-hub-sort-extra-select"><option value="">—</option>${opts}</select>`;
    }

    return `<div class="data-hub-filter-section data-hub-filter-sort-section"><h4 class="data-hub-filter-heading">Sort by date</h4><div class="data-hub-filter-radios">${dateHtml}</div>${extraOpts}</div>`;
}

function renderBoundsSection(draft) {
    const hasBounds = !!draft.bounds;
    const status = hasBounds ? 'Area filter active' : 'No area filter';
    return `<div class="data-hub-filter-section data-hub-filter-bounds-section"><h4 class="data-hub-filter-heading">Map area</h4><p class="data-hub-filter-bounds-status">${esc(status)}</p><div class="data-hub-filter-bounds-actions"><button type="button" class="data-hub-filter-draw-btn" data-action="draw-bounds">Draw area on map</button>${hasBounds ? '<button type="button" class="data-hub-filter-clear-bounds-btn" data-action="clear-bounds">Clear area</button>' : ''}</div></div>`;
}

function renderPhotosDateRangeSection(draft) {
    const from = draft.dateFrom ? String(draft.dateFrom) : '';
    const to = draft.dateTo ? String(draft.dateTo) : '';
    const timeEnabled = !!draft.timeRangeEnabled;
    const timeFrom = draft.timeFrom ? String(draft.timeFrom) : '00:00';
    const timeTo = draft.timeTo ? String(draft.timeTo) : '23:59';
    let timeHtml = '';
    if (from) {
        timeHtml =
            '<div class="data-hub-filter-time-range time-warp-datetime-row">' +
            '<label class="time-warp-datetime-label data-hub-filter-time-enabled-label">' +
            '<input type="checkbox" class="data-hub-filter-time-enabled"' +
            (timeEnabled ? ' checked' : '') +
            '> Time of day</label>' +
            '<label class="time-warp-datetime-label">From<input type="time" class="data-hub-filter-time-input" data-filter-time="from" value="' +
            escAttr(timeFrom) +
            '"' +
            (timeEnabled ? '' : ' disabled') +
            '></label>' +
            '<label class="time-warp-datetime-label">To<input type="time" class="data-hub-filter-time-input" data-filter-time="to" value="' +
            escAttr(timeTo) +
            '"' +
            (timeEnabled ? '' : ' disabled') +
            '></label></div>';
    }
    return (
        '<div class="data-hub-filter-section data-hub-filter-date-range-section"><h4 class="data-hub-filter-heading">Date range</h4>' +
        '<div class="data-hub-filter-date-range"><label class="data-hub-filter-date-label">From<input type="date" class="data-hub-filter-date-input" data-filter-date="from" value="' +
        escAttr(from) +
        '"></label><label class="data-hub-filter-date-label">To<input type="date" class="data-hub-filter-date-input" data-filter-date="to" value="' +
        escAttr(to) +
        '"></label></div>' +
        timeHtml +
        '</div>'
    );
}

function renderFiltersPanel(view, containerEl) {
    if (!containerEl) return;
    const draft = getDraftFilters(view);
    let html = '';
    if (view === 'annotations') {
        html += renderCheckboxGroup('types', 'Type', ANNOTATION_TYPES, draft.types || [], 'dh-type');
        html += renderCheckboxGroup('utilities', 'Utility', getUtilityOptions(), draft.utilities || [], 'dh-util');
        html += renderCheckboxGroup('uploadedBy', 'Uploaded by', getUploadedByOptions(view), draft.uploadedBy || [], 'dh-up');
        html += renderBoundsSection(draft);
    } else if (view === 'layers') {
        html += renderCheckboxGroup('utilities', 'Utility', getUtilityOptions(), draft.utilities || [], 'dh-util');
        html += renderCheckboxGroup('savedBy', 'Saved by', getSavedByOptions(), draft.savedBy || [], 'dh-sv');
        html += renderBoundsSection(draft);
    } else if (view === 'photos') {
        html += renderPhotosDateRangeSection(draft);
        html += renderCheckboxGroup('tags', 'Tags', getTagOptions(), draft.tags || [], 'dh-tag');
        html += renderCheckboxGroup('uploadedBy', 'Uploaded by', getUploadedByOptions(view), draft.uploadedBy || [], 'dh-up');
        html += renderBoundsSection(draft);
    } else if (view === 'documents') {
        html += renderCheckboxGroup('uploadedBy', 'Uploaded by', getUploadedByOptions(view), draft.uploadedBy || [], 'dh-up');
        html += renderBoundsSection(draft);
    } else if (view === 'events') {
        html += renderCheckboxGroup('utilities', 'Utility', getEventUtilityOptions(), draft.utilities || [], 'dh-util');
        html += renderCheckboxGroup('completed', 'Form completed', EVENT_COMPLETED_OPTIONS, draft.completed || [], 'dh-done');
        html += renderBoundsSection(draft);
    }
    const isMobile = containerEl.id === 'dataSearchFilterBody';
    html += renderSortSection(view, isMobile);
    containerEl.innerHTML = html;
}

function readDraftFromPanel(containerEl, view) {
    const v = view || window.dataWindowModule?.currentDataView;
    const draft = getDraftFilters(v);
    if (!containerEl) return draft;
    const keys =
        v === 'annotations'
            ? ['types', 'utilities', 'uploadedBy']
            : v === 'layers'
              ? ['utilities', 'savedBy']
              : v === 'photos'
                ? ['tags', 'uploadedBy']
                : v === 'documents'
                  ? ['uploadedBy']
                  : v === 'events'
                    ? ['utilities', 'completed']
                    : [];
    keys.forEach((key) => {
        draft[key] = Array.from(containerEl.querySelectorAll(`.data-hub-filter-cb[data-filter-key="${key}"]`))
            .filter((cb) => cb.checked)
            .map((cb) => cb.value);
    });
    if (v === 'photos') {
        const fromInput = containerEl.querySelector('.data-hub-filter-date-input[data-filter-date="from"]');
        const toInput = containerEl.querySelector('.data-hub-filter-date-input[data-filter-date="to"]');
        draft.dateFrom = fromInput && fromInput.value ? String(fromInput.value) : '';
        draft.dateTo = toInput && toInput.value ? String(toInput.value) : '';
        const timeEnabledCb = containerEl.querySelector('.data-hub-filter-time-enabled');
        const timeFromInput = containerEl.querySelector('.data-hub-filter-time-input[data-filter-time="from"]');
        const timeToInput = containerEl.querySelector('.data-hub-filter-time-input[data-filter-time="to"]');
        draft.timeRangeEnabled = !!(timeEnabledCb && timeEnabledCb.checked);
        draft.timeFrom = timeFromInput && timeFromInput.value ? String(timeFromInput.value) : '00:00';
        draft.timeTo = timeToInput && timeToInput.value ? String(timeToInput.value) : '23:59';
    }
    return draft;
}

function applyDraftToApplied(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(v)) return;
    appliedFiltersByView[v] = cloneFilterState(getDraftFilters(v));
    if (appliedFiltersByView[v].bounds) {
        showFilterPreview(appliedFiltersByView[v].bounds);
    } else {
        clearFilterPreview();
    }
    if (window.dataHubPaginationModule?.resetDataHubPage) {
        window.dataHubPaginationModule.resetDataHubPage(v);
    }
    syncSearchIconBadge();
    if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
    syncDataHubMapFilterIndicator();
    refreshMapForView(v);
}

function applySortFromPanel(containerEl, view) {
    const sortMod = window.tableSortingModule;
    if (!sortMod?.setSortStateForView) return;
    const dateRadio = containerEl?.querySelector('.data-hub-sort-radio:checked');
    const extraSel = containerEl?.querySelector('#dataHubSortExtra');
    let val = dateRadio?.value || '';
    if (extraSel?.value) val = extraSel.value;
    if (!val) {
        sortMod.setSortStateForView(view, null, 'asc');
    } else {
        const idx = val.indexOf(':');
        if (idx > 0) {
            sortMod.setSortStateForView(view, val.slice(0, idx), val.slice(idx + 1) || 'asc');
        }
    }
}

function syncPanelForView(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    resetDraftFromApplied(v);
    const desktopBody = document.getElementById('dataHubFiltersModalBody');
    const mobileBody = document.getElementById('dataSearchFilterBody');
    if (desktopBody && desktopBody.offsetParent !== null) renderFiltersPanel(v, desktopBody);
    if (mobileBody) renderFiltersPanel(v, mobileBody);
    syncToolbarControls(v);
    refreshMapForView(v);
}

function syncToolbarControls(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    const filterBtn = document.getElementById('dataHubFiltersButton');
    const sortSel = document.getElementById('dataHubSortSelect');
    const showFilters = FILTER_VIEWS.has(v);
    const showSortToolbar = !showFilters && v === 'aerialmaps';
    if (filterBtn) filterBtn.style.display = showFilters ? '' : 'none';
    if (sortSel) {
        sortSel.style.display = showSortToolbar ? '' : 'none';
        syncDesktopSortSelect(v);
    }
    syncSearchIconBadge();
    updateMobileSearchTitle(v);
}

function syncDesktopSortSelect(view) {
    const sel = document.getElementById('dataHubSortSelect');
    const sortMod = window.tableSortingModule;
    if (!sel || !sortMod?.getSortStateForView) return;
    const v = view || window.dataWindowModule?.currentDataView;
    sel.querySelectorAll('option[data-sort-for-views]').forEach((opt) => {
        const allowed = (opt.getAttribute('data-sort-for-views') || '').split(/\s+/).filter(Boolean);
        opt.hidden = allowed.length > 0 && !allowed.includes(v);
    });
    const { column, direction } = sortMod.getSortStateForView(v);
    sel.value = `${column}:${direction}`;
}

function syncSearchIconBadge() {
    const btn = document.getElementById('dataSearchMobileOpenBtn');
    if (!btn) return;
    const view = window.dataWindowModule?.currentDataView;
    const searchTerm = window.tableFilteringModule?.getSearchTerm?.() || '';
    const sortMod = window.tableSortingModule;
    const hasExplicitSort = sortMod?.hasExplicitSortForView ? sortMod.hasExplicitSortForView(view) : false;
    const active = !!searchTerm || hasActiveFilters(view) || hasExplicitSort;
    btn.classList.toggle('has-active-filters', active);
}

function updateMobileSearchTitle(view) {
    const title = document.getElementById('dataSearchModalTitle');
    if (!title) return;
    if (FILTER_VIEWS.has(view)) {
        title.textContent = 'Search & filter';
    } else {
        title.textContent = 'Search & sort';
    }
}

function bindPanelEvents(containerEl, view, onApply) {
    if (!containerEl || containerEl._dataHubFiltersBound) return;
    containerEl._dataHubFiltersBound = true;
    containerEl.addEventListener('click', (e) => {
        const v = window.dataWindowModule?.currentDataView;
        const drawBtn = e.target.closest('[data-action="draw-bounds"]');
        if (drawBtn) {
            e.preventDefault();
            readDraftFromPanel(containerEl, v);
            startBoundsDrawing(v);
            return;
        }
        const clearBounds = e.target.closest('[data-action="clear-bounds"]');
        if (clearBounds) {
            e.preventDefault();
            const draft = getDraftFilters(v);
            draft.bounds = null;
            renderFiltersPanel(v, containerEl);
        }
    });
    containerEl.addEventListener('change', (e) => {
        if (e.target.classList.contains('data-hub-sort-radio') && e.target.checked) {
            const extra = containerEl.querySelector('#dataHubSortExtra');
            if (extra) extra.value = '';
        }
        if (e.target.id === 'dataHubSortExtra' && e.target.value) {
            const radios = containerEl.querySelectorAll('.data-hub-sort-radio');
            radios.forEach((r) => {
                r.checked = r.value === 'created:desc';
            });
        }
        if (e.target.classList.contains('data-hub-filter-time-enabled')) {
            const enabled = e.target.checked;
            containerEl.querySelectorAll('.data-hub-filter-time-input').forEach((input) => {
                input.disabled = !enabled;
            });
        }
        if (
            e.target.classList.contains('data-hub-filter-date-input') &&
            e.target.dataset.filterDate === 'from'
        ) {
            const v = window.dataWindowModule?.currentDataView;
            if (v === 'photos') {
                readDraftFromPanel(containerEl, v);
                renderFiltersPanel(v, containerEl);
            }
        }
    });
}

function startBoundsDrawing(view) {
    const v = view || window.dataWindowModule?.currentDataView;
    const body = document.getElementById('dataSearchFilterBody');
    const desktopBody = document.getElementById('dataHubFiltersModalBody');
    if (body) readDraftFromPanel(body, v);
    else if (desktopBody) readDraftFromPanel(desktopBody, v);
    const searchOverlay = document.getElementById('dataSearchModalOverlay');
    if (searchOverlay?.classList.contains('is-open')) {
        applyMobileSearchSheet();
        searchOverlay.classList.remove('is-open');
        searchOverlay.setAttribute('aria-hidden', 'true');
    }
    closeDesktopFiltersModal();
    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = dataWindow?.classList.contains('show');
    if (wasOpen && window.closeDataWindow) window.closeDataWindow();
    setTimeout(() => {
        if (window.tableQueriesModule?.startDataHubFilterBoundsDrawing) {
            window.tableQueriesModule.startDataHubFilterBoundsDrawing(v, wasOpen);
        }
    }, wasOpen ? 150 : 0);
}

function openDesktopFiltersModal() {
    const view = window.dataWindowModule?.currentDataView;
    if (!FILTER_VIEWS.has(view)) return;
    const modal = document.getElementById('dataHubFiltersModal');
    const body = document.getElementById('dataHubFiltersModalBody');
    if (!modal || !body) return;
    resetDraftFromApplied(view);
    renderFiltersPanel(view, body);
    bindPanelEvents(body, view);
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
}

function closeDesktopFiltersModal() {
    const modal = document.getElementById('dataHubFiltersModal');
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
}

function applyDesktopFilters() {
    const view = window.dataWindowModule?.currentDataView;
    const body = document.getElementById('dataHubFiltersModalBody');
    readDraftFromPanel(body, view);
    applyDraftToApplied(view);
    applySortFromPanel(body, view);
    closeDesktopFiltersModal();
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function clearDesktopFilters() {
    const view = window.dataWindowModule?.currentDataView;
    clearFilters(view);
    const body = document.getElementById('dataHubFiltersModalBody');
    if (body) renderFiltersPanel(view, body);
    if (window.tableSortingModule?.setSortStateForView) {
        window.tableSortingModule.setSortStateForView(view, null, 'asc');
    }
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function applyMobileSearchSheet() {
    const view = window.dataWindowModule?.currentDataView;
    const body = document.getElementById('dataSearchFilterBody');
    if (FILTER_VIEWS.has(view) && body) {
        readDraftFromPanel(body, view);
        applyDraftToApplied(view);
    }
    if (body) applySortFromPanel(body, view);
    syncSearchIconBadge();
    syncDataHubMapFilterIndicator();
}

function initDataHubFilters() {
    const desktopBody = document.getElementById('dataHubFiltersModalBody');
    const mobileBody = document.getElementById('dataSearchFilterBody');
    if (desktopBody) bindPanelEvents(desktopBody, null);
    if (mobileBody) bindPanelEvents(mobileBody, null);

    const filterBtn = document.getElementById('dataHubFiltersButton');
    if (filterBtn && !filterBtn._bound) {
        filterBtn._bound = true;
        filterBtn.addEventListener('click', openDesktopFiltersModal);
    }
    const sortSel = document.getElementById('dataHubSortSelect');
    if (sortSel && !sortSel._bound) {
        sortSel._bound = true;
        sortSel.addEventListener('change', () => {
            const view = window.dataWindowModule?.currentDataView;
            const v = sortSel.value;
            const sortMod = window.tableSortingModule;
            if (!sortMod?.setSortStateForView) return;
            if (!v) sortMod.setSortStateForView(view, null, 'asc');
            else {
                const idx = v.indexOf(':');
                if (idx > 0) sortMod.setSortStateForView(view, v.slice(0, idx), v.slice(idx + 1));
            }
            if (window.dataHubPaginationModule?.resetDataHubPage) {
                window.dataHubPaginationModule.resetDataHubPage(view);
            }
            if (window.dataTableRendererModule?.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
        });
    }
    syncDataHubMapFilterIndicator();
}

window.dataHubFiltersModule = {
    applyFilters,
    filterForMap,
    applyAnnotationsFilters,
    applyLayersFilters,
    applyPhotosFilters,
    getPhotosMapCreatedParams,
    photoFilterRangeMs,
    applyDocumentsFilters,
    applyEventsFilters,
    getFilters,
    getFilterSignature,
    hasActiveFilters,
    hasActiveMapFilters,
    hasAnyActiveMapFilters,
    syncDataHubMapFilterIndicator,
    getFilterSummaryText,
    clearFilters,
    setBounds,
    refreshMapForView,
    renderFiltersPanel,
    resetDraftFromApplied,
    syncPanelForView,
    syncToolbarControls,
    syncDesktopSortSelect,
    syncSearchIconBadge,
    updateMobileSearchTitle,
    openDesktopFiltersModal,
    closeDesktopFiltersModal,
    applyDesktopFilters,
    clearDesktopFilters,
    applyMobileSearchSheet,
    initDataHubFilters,
    FILTER_VIEWS,
    getPhotoCoordinates,
    photoMatchesBounds,
};

window.openDataHubFiltersModal = openDesktopFiltersModal;
window.closeDataHubFiltersModal = closeDesktopFiltersModal;
window.applyDataHubFilters = applyDesktopFilters;
window.clearDataHubFilters = clearDesktopFilters;
window.syncDataHubMapFilterIndicator = syncDataHubMapFilterIndicator;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDataHubFilters);
} else {
    initDataHubFilters();
}
