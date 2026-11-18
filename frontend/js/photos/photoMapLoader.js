/**
 * Viewport-scoped photo map loader (zoom 16+, ticket-gated).
 * Manage Data still uses savedPhotos via ensureManageDataPhotosLoaded().
 */
(function () {
    const PHOTO_MAP_MIN_ZOOM = 16;
    /** Beyond this zoom, API queries use a capped zoom + expanded bbox so markers do not vanish at z24. */
    const PHOTO_MAP_QUERY_ZOOM_CAP = 20;
    const PHOTO_MAP_FETCH_DEBOUNCE_MS = 300;
    const PHOTO_MAP_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
    const PHOTO_MAP_PAD_RATIO = 0.25;
    const POLYGON_BACKFILL_WAIT_MS = 15000;

    /** @type {Array<object>} */
    let mapViewportPhotos = [];
    /** @type {Map<string, { fetchedAt: number, payload: object, paddedBounds: L.LatLngBounds }>} */
    const sessionCache = new Map();
    let fetchDebounceTimer = null;
    let fetchSeq = 0;
    let fetchAbort = null;
    let mapListenersBound = false;
    let photoMapLastHiddenAt = null;
    /** One-off pin from Manage Data "Show on map". */
    let showOnMapPinMarker = null;
    let lastMapMode = 'points';
    let lastSuccessfulPayload = null;
    let polygonWaitStartedAt = null;
    let polygonWaitTicketKey = '';

    function getMap() {
        return window.map || null;
    }

    function isPublicCatalogMode() {
        return (
            typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
            window.isCurrentOrgPublicCatalogViewer()
        );
    }

    function isOfflineMode() {
        return !!(window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline());
    }

    function photosLayerEnabled() {
        if (
            window.photosModule &&
            typeof window.photosModule.isPhotosLayerUserEnabled === 'function'
        ) {
            return window.photosModule.isPhotosLayerUserEnabled();
        }
        if (typeof window.getMapOverlayToggleActive === 'function') {
            return !!window.getMapOverlayToggleActive('photos');
        }
        return true;
    }

    function getOrgId() {
        return window.orgSelectorModule && window.orgSelectorModule.getCurrentOrgId
            ? window.orgSelectorModule.getCurrentOrgId()
            : null;
    }

    function padBounds(bounds) {
        if (!bounds || !bounds.isValid || !bounds.isValid()) return bounds;
        const ne = bounds.getNorthEast();
        const sw = bounds.getSouthWest();
        const latPad = (ne.lat - sw.lat) * PHOTO_MAP_PAD_RATIO;
        const lngPad = (ne.lng - sw.lng) * PHOTO_MAP_PAD_RATIO;
        return L.latLngBounds(
            [sw.lat - latPad, sw.lng - lngPad],
            [ne.lat + latPad, ne.lng + lngPad]
        );
    }

    function getPhotoMapQueryZoom(map) {
        if (!map || typeof map.getZoom !== 'function') return PHOTO_MAP_QUERY_ZOOM_CAP;
        return Math.min(map.getZoom(), PHOTO_MAP_QUERY_ZOOM_CAP);
    }

    /**
     * At extreme zoom the visible bbox is tiny: ticket gates and spatial queries can miss
     * photos/tickets that were loaded at z20. Expand to at least the z20 viewport span.
     */
    function getPhotoMapViewportBounds(map) {
        if (!map || typeof map.getBounds !== 'function') return null;
        const bounds = map.getBounds();
        if (!bounds || !bounds.isValid || !bounds.isValid()) return bounds;
        const zoom = map.getZoom();
        if (!Number.isFinite(zoom) || zoom <= PHOTO_MAP_QUERY_ZOOM_CAP) return bounds;
        if (typeof map.getZoomScale !== 'function') return bounds;
        const scale = map.getZoomScale(zoom, PHOTO_MAP_QUERY_ZOOM_CAP);
        const center = bounds.getCenter();
        const latHalf = ((bounds.getNorth() - bounds.getSouth()) / 2) * scale;
        const lngHalf = ((bounds.getEast() - bounds.getWest()) / 2) * scale;
        return L.latLngBounds(
            [center.lat - latHalf, center.lng - lngHalf],
            [center.lat + latHalf, center.lng + lngHalf]
        );
    }

    function payloadHasRenderableMapData(payload) {
        if (!payload) return false;
        if (payload.mode === 'clusters') {
            return !!(payload.items && payload.items.length);
        }
        return !!(
            (payload.items && payload.items.length) ||
            (payload.noGpsClusters && payload.noGpsClusters.length)
        );
    }

    function shouldRetainMarkersAtHighZoom(map) {
        if (!map || typeof map.getZoom !== 'function') return false;
        if (map.getZoom() <= PHOTO_MAP_QUERY_ZOOM_CAP) return false;
        return !!(
            lastSuccessfulPayload &&
            (mapViewportPhotos.length ||
                lastMapMode === 'clusters' ||
                payloadHasRenderableMapData(lastSuccessfulPayload))
        );
    }

    function boundsKey(bounds) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        return [sw.lng, sw.lat, ne.lng, ne.lat].map((n) => n.toFixed(5)).join(',');
    }

    function ticketIdsHash(ids) {
        return [...ids].sort((a, b) => a - b).join(',');
    }

    function cacheKey(orgId, bounds, zoom, ticketIds, extra) {
        return `${orgId}|${boundsKey(bounds)}|${zoom}|${ticketIdsHash(ticketIds)}|${extra || ''}`;
    }

    function getPhotoMapTicketCandidates() {
        if (isPublicCatalogMode()) return [];
        const map = getMap();
        if (!map) return [];
        const bounds = getPhotoMapViewportBounds(map);
        if (!bounds || !bounds.isValid()) return [];

        const allTickets = window.ORG_TICKETS || [];
        const mapMod = window.ticketImporterModule;
        const deduped =
            mapMod && typeof mapMod.dedupeTicketsByBase === 'function'
                ? mapMod.dedupeTicketsByBase(allTickets)
                : allTickets;

        const inactive = (ticket) => {
            const status =
                window.ticketsModule && typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function'
                    ? window.ticketsModule.getTicketWorkflowStatusForMap(ticket)
                    : ticket.status ||
                      ticket.computedWorkflowStatus ||
                      ticket.workflowStatus ||
                      '';
            if (window.ticketsModule && typeof window.ticketsModule.isInactiveWorkflowStatus === 'function') {
                return window.ticketsModule.isInactiveWorkflowStatus(status);
            }
            return status === 'EXPIRED' || status === 'CANCELLED';
        };

        const inView = (ticket) => {
            if (window.ticketsModule && typeof window.ticketsModule.ticketIntersectsMapBounds === 'function') {
                return window.ticketsModule.ticketIntersectsMapBounds(ticket, bounds);
            }
            const ll =
                window.ticketsModule && typeof window.ticketsModule.ticketMapAnchorLatLng === 'function'
                    ? window.ticketsModule.ticketMapAnchorLatLng(ticket)
                    : null;
            return !!(ll && bounds.contains(ll));
        };

        return deduped.filter((t) => t && t.id != null && !inactive(t) && inView(t));
    }

    function viewportTicketsAwaitingPolygonBackfill(candidates) {
        const mod = window.ticketsModule;
        if (!mod) return false;
        const hasPoly =
            typeof mod.ticketHasDisplayablePolygon === 'function'
                ? (t) => mod.ticketHasDisplayablePolygon(t)
                : () => true;
        const isUnsettled =
            typeof mod.ticketPolygonBackfillUnsettled === 'function'
                ? (t) => mod.ticketPolygonBackfillUnsettled(t)
                : typeof mod.ticketPolygonBackfillLoading === 'function'
                  ? (t) => mod.ticketPolygonBackfillLoading(t)
                  : () => false;

        const unsettled = (candidates || []).filter((t) => !hasPoly(t) && isUnsettled(t));
        if (!unsettled.length) {
            polygonWaitStartedAt = null;
            polygonWaitTicketKey = '';
            return false;
        }

        const key = unsettled
            .map((t) => String(t.ticketNumber || t.id || '').trim())
            .filter(Boolean)
            .sort()
            .join(',');
        if (key !== polygonWaitTicketKey) {
            polygonWaitTicketKey = key;
            polygonWaitStartedAt = Date.now();
            if (typeof mod.scheduleViewportPolygonBackfillForVisibleTickets === 'function') {
                mod.scheduleViewportPolygonBackfillForVisibleTickets();
            }
        }

        if (polygonWaitStartedAt != null && Date.now() - polygonWaitStartedAt >= POLYGON_BACKFILL_WAIT_MS) {
            return false;
        }
        return true;
    }

    function shouldFetchPhotosForViewport() {
        const plan = getPhotoMapFetchPlan();
        return plan;
    }

    function getBaseViewportGate() {
        const map = getMap();
        if (!map) return { ok: false, reason: 'no_map' };
        if (isPublicCatalogMode()) return { ok: false, reason: 'public_catalog' };
        if (isOfflineMode()) return { ok: false, reason: 'offline' };
        if (!photosLayerEnabled()) return { ok: false, reason: 'layer_off' };
        if (map.getZoom() < PHOTO_MAP_MIN_ZOOM) return { ok: false, reason: 'zoom_below_min' };
        return { ok: true, map };
    }

    function getPhotoMapFetchPlan() {
        const base = getBaseViewportGate();
        if (!base.ok) return { ok: false, reason: base.reason, ticketFetch: false, spatialFetch: false };
        const map = base.map;
        const candidates = getPhotoMapTicketCandidates();
        const polygonBackfill = viewportTicketsAwaitingPolygonBackfill(candidates);
        const prefMod = window.mapRecentPhotosPreferenceModule;
        const recentDays = prefMod && typeof prefMod.getMapRecentPhotosDaysBack === 'function'
            ? prefMod.getMapRecentPhotosDaysBack()
            : 0;
        const hub = window.dataHubFiltersModule;
        const hubDates =
            hub && typeof hub.getPhotosMapCreatedParams === 'function' ? hub.getPhotosMapCreatedParams() : {};
        const spatialFetch =
            recentDays > 0 || !!(hubDates.createdFrom || hubDates.createdTo);
        const ticketFetch = candidates.length > 0 && !polygonBackfill;
        if (!ticketFetch && !spatialFetch) {
            if (!candidates.length) return { ok: false, reason: 'no_active_tickets', candidates, ticketFetch, spatialFetch };
            if (polygonBackfill) return { ok: false, reason: 'polygon_backfill', candidates, ticketFetch, spatialFetch };
        }
        return {
            ok: ticketFetch || spatialFetch,
            reason: ticketFetch || spatialFetch ? 'ok' : 'no_active_tickets',
            candidates,
            ticketFetch,
            spatialFetch,
            recentDays,
            hubDates,
            polygonBackfill,
        };
    }

    function resolveSpatialCreatedParams(plan) {
        const hubDates = (plan && plan.hubDates) || {};
        if (hubDates.createdFrom || hubDates.createdTo) return hubDates;
        const prefMod = window.mapRecentPhotosPreferenceModule;
        if (!prefMod || typeof prefMod.mapRecentPhotosCreatedFromIso !== 'function') return {};
        const from = prefMod.mapRecentPhotosCreatedFromIso(plan && plan.recentDays);
        return from ? { createdFrom: from } : {};
    }

    function mergePhotoMapPayloads(ticketPayload, spatialPayload) {
        if (!spatialPayload || !payloadHasRenderableMapData(spatialPayload)) return ticketPayload;
        if (!ticketPayload || !payloadHasRenderableMapData(ticketPayload)) return spatialPayload;
        if (ticketPayload.mode === 'clusters') {
            return {
                ...ticketPayload,
                supplementalPoints: spatialPayload.items || [],
            };
        }
        const byId = new Map();
        (ticketPayload.items || []).forEach(function (item) {
            if (item && item.id != null) byId.set(Number(item.id), item);
        });
        (spatialPayload.items || []).forEach(function (item) {
            if (!item || item.id == null) return;
            const id = Number(item.id);
            if (!byId.has(id)) byId.set(id, item);
        });
        return {
            mode: 'points',
            items: Array.from(byId.values()),
            noGpsClusters: ticketPayload.noGpsClusters || [],
            pointCount: byId.size,
        };
    }

    function findCacheHit(orgId, visibleBounds, zoom, ticketIds, extra) {
        const now = Date.now();
        const tidHash = ticketIdsHash(ticketIds);
        const suffix = `|${zoom}|${tidHash}|${extra || ''}`;
        for (const [key, entry] of sessionCache.entries()) {
            if (now - entry.fetchedAt > PHOTO_MAP_CACHE_MAX_AGE_MS) {
                sessionCache.delete(key);
                continue;
            }
            if (!key.startsWith(`${orgId}|`) || !key.endsWith(suffix)) continue;
            if (entry.paddedBounds && entry.paddedBounds.contains(visibleBounds)) {
                return entry;
            }
        }
        return null;
    }

    function mapItemToViewportPhoto(item) {
        const baseUrl =
            window.authModule && window.authModule.getApiBaseForMedia
                ? window.authModule.getApiBaseForMedia()
                : window.API_BASE_URL || window.location.origin;
        if (window.photoMapItemUtils && typeof window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto === 'function') {
            const photo = window.photoMapItemUtils.mapApiPhotoItemToViewerPhoto(item, baseUrl);
            photo.mapViewport = true;
            return photo;
        }
        const thumb = item.thumbnailUrl
            ? item.thumbnailUrl.startsWith('http')
                ? item.thumbnailUrl
                : `${baseUrl}${item.thumbnailUrl}`
            : null;
        return {
            id: `map-photo-${item.id}`,
            fileId: item.id,
            fileName: item.fileName || 'Photo',
            createdAt: item.createdAt,
            thumbnailUrl: thumb,
            imageUrl: `${baseUrl}/api/data/media/${item.id}/file`,
            latlng: { lat: Number(item.lat), lng: Number(item.lng) },
            associatedNoGps: !!item.associatedNoGps,
            uploadedBy: item.uploadedBy != null && item.uploadedBy !== '' ? String(item.uploadedBy) : '',
            note: typeof item.note === 'string' ? item.note : '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            noteLastEditedBy: typeof item.noteLastEditedBy === 'string' ? item.noteLastEditedBy : '',
            noteLastEditedAt: typeof item.noteLastEditedAt === 'string' ? item.noteLastEditedAt : '',
            hasWhitePaintMark: item.hasWhitePaintMark === true,
            mapViewport: true,
        };
    }

    function applyPayloadToMap(payload) {
        const map = getMap();
        if (!payloadHasRenderableMapData(payload) && shouldRetainMarkersAtHighZoom(map)) {
            return;
        }
        if (payloadHasRenderableMapData(payload)) {
            lastSuccessfulPayload = payload;
        }
        lastMapMode = payload && payload.mode ? payload.mode : 'points';
        const noGpsClusters = (payload && payload.noGpsClusters) || [];
        if (!payload || payload.mode === 'clusters') {
            mapViewportPhotos = (payload && payload.supplementalPoints ? payload.supplementalPoints : []).map(
                mapItemToViewportPhoto
            );
            if (window.photosModule) {
                if (typeof window.photosModule.renderServerPhotoClustersOnMap === 'function') {
                    window.photosModule.renderServerPhotoClustersOnMap(payload && payload.items ? payload.items : []);
                }
                if (typeof window.photosModule.renderNoGpsTicketClustersOnMap === 'function') {
                    window.photosModule.renderNoGpsTicketClustersOnMap(noGpsClusters);
                } else if (typeof window.photosModule.reloadPhotosOnMap === 'function') {
                    window.photosModule.reloadPhotosOnMap();
                }
            }
            return;
        }
        mapViewportPhotos = (payload.items || []).map(mapItemToViewportPhoto);
        if (window.photosModule && typeof window.photosModule.setMapNoGpsClustersFromPayload === 'function') {
            window.photosModule.setMapNoGpsClustersFromPayload(noGpsClusters);
        }
        if (window.photosModule && typeof window.photosModule.clearServerPhotoClusters === 'function') {
            window.photosModule.clearServerPhotoClusters();
        }
        if (window.photosModule && typeof window.photosModule.reloadPhotosOnMap === 'function') {
            window.photosModule.reloadPhotosOnMap();
        }
    }

    function getTimeWarpQueryParams() {
        const mod = window.aerialMapPanelModule;
        if (!mod || typeof mod.getTimeWarpConstraints !== 'function') return {};
        const c = mod.getTimeWarpConstraints();
        if (!c || !c.timeActive) return {};
        return {};
    }

    async function fetchPhotoMapForViewport(options) {
        const map = getMap();
        const orgId = getOrgId();
        if (!map || orgId == null) return;

        const plan = getPhotoMapFetchPlan();
        if (!plan.ok) {
            if (
                plan.reason === 'no_active_tickets' ||
                plan.reason === 'zoom_below_min' ||
                plan.reason === 'layer_off'
            ) {
                if (plan.reason === 'no_active_tickets' && shouldRetainMarkersAtHighZoom(map)) {
                    return;
                }
                mapViewportPhotos = [];
                lastSuccessfulPayload = null;
                if (window.photosModule && typeof window.photosModule.setMapNoGpsClustersFromPayload === 'function') {
                    window.photosModule.setMapNoGpsClustersFromPayload([]);
                }
                if (window.photosModule && typeof window.photosModule.clearServerPhotoClusters === 'function') {
                    window.photosModule.clearServerPhotoClusters();
                }
                if (window.photosModule && typeof window.photosModule.clearNoGpsTicketClusters === 'function') {
                    window.photosModule.clearNoGpsTicketClusters();
                }
                if (window.photosModule && typeof window.photosModule.reloadPhotosOnMap === 'function') {
                    window.photosModule.reloadPhotosOnMap();
                }
            } else if (plan.reason === 'polygon_backfill') {
                const waitMs =
                    polygonWaitStartedAt != null
                        ? Math.max(50, POLYGON_BACKFILL_WAIT_MS - (Date.now() - polygonWaitStartedAt) + 50)
                        : POLYGON_BACKFILL_WAIT_MS;
                setTimeout(() => scheduleFetchPhotoMapForViewport(true), waitMs);
            }
            return;
        }

        const mapVisibleBounds = map.getBounds();
        const queryBounds = getPhotoMapViewportBounds(map) || mapVisibleBounds;
        const padded = padBounds(queryBounds);
        const zoom = getPhotoMapQueryZoom(map);
        const ticketIds = (plan.candidates || []).map((t) => Number(t.id)).filter((id) => Number.isFinite(id));
        const spatialParams = resolveSpatialCreatedParams(plan);
        const cacheSuffix = `${plan.recentDays || 0}|${spatialParams.createdFrom || ''}|${spatialParams.createdTo || ''}`;

        if (!options || !options.force) {
            const hit = findCacheHit(orgId, mapVisibleBounds, zoom, ticketIds, cacheSuffix);
            if (hit) {
                applyPayloadToMap(hit.payload);
                return;
            }
        }

        const sw = padded.getSouthWest();
        const ne = padded.getNorthEast();
        const bbox = [sw.lng, sw.lat, ne.lng, ne.lat].join(',');
        const seq = ++fetchSeq;
        if (fetchAbort) {
            try {
                fetchAbort.abort();
            } catch (_) {
                /* ignore */
            }
        }
        fetchAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

        const tw = getTimeWarpQueryParams();
        const apiBase = window.authModule && window.authModule.API_BASE ? window.authModule.API_BASE : '/api';
        const headers =
            window.authModule && typeof window.authModule.getAuthHeaders === 'function'
                ? window.authModule.getAuthHeaders()
                : {};

        try {
            const requests = [];
            if (plan.ticketFetch && ticketIds.length) {
                const params = new URLSearchParams({
                    organizationId: String(orgId),
                    bbox,
                    zoom: String(zoom),
                    ticketIds: ticketIds.join(','),
                });
                if (tw.tags) params.set('tags', tw.tags);
                if (tw.uploadedBy) params.set('uploadedBy', tw.uploadedBy);
                requests.push(
                    fetch(`${apiBase}/data/media/photos/map?${params.toString()}`, {
                        headers,
                        signal: fetchAbort ? fetchAbort.signal : undefined,
                    }).then(async (res) => {
                        if (!res.ok) throw new Error(`Map photos ${res.status}`);
                        return res.json();
                    })
                );
            }
            if (plan.spatialFetch) {
                const spatialQuery = new URLSearchParams({ bbox, limit: '500' });
                if (spatialParams.createdFrom) spatialQuery.set('createdFrom', spatialParams.createdFrom);
                if (spatialParams.createdTo) spatialQuery.set('createdTo', spatialParams.createdTo);
                if (tw.tags) spatialQuery.set('tags', tw.tags);
                requests.push(
                    fetch(`${apiBase}/data/media/photos/spatial?${spatialQuery.toString()}`, {
                        headers,
                        signal: fetchAbort ? fetchAbort.signal : undefined,
                    }).then(async (res) => {
                        if (!res.ok) throw new Error(`Spatial photos ${res.status}`);
                        return res.json();
                    })
                );
            }
            if (!requests.length) return;
            const results = await Promise.allSettled(requests);
            const payloads = results
                .filter(function (result) {
                    return result.status === 'fulfilled';
                })
                .map(function (result) {
                    return result.value;
                });
            if (!payloads.length) {
                const rejected = results.find(function (result) {
                    return result.status === 'rejected';
                });
                if (rejected) throw rejected.reason;
                return;
            }
            if (seq !== fetchSeq) return;
            let merged = payloads[0];
            for (let i = 1; i < payloads.length; i++) {
                merged = mergePhotoMapPayloads(merged, payloads[i]);
            }
            if (!payloadHasRenderableMapData(merged) && shouldRetainMarkersAtHighZoom(map)) {
                return;
            }
            const key = cacheKey(orgId, padded, zoom, ticketIds, cacheSuffix);
            sessionCache.set(key, { fetchedAt: Date.now(), payload: merged, paddedBounds: padded });
            applyPayloadToMap(merged);
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            console.warn('[photoMapLoader] fetch failed:', e.message || e);
        }
    }

    function scheduleFetchPhotoMapForViewport(force) {
        if (fetchDebounceTimer) clearTimeout(fetchDebounceTimer);
        fetchDebounceTimer = setTimeout(() => {
            fetchDebounceTimer = null;
            void fetchPhotoMapForViewport({ force: !!force });
        }, PHOTO_MAP_FETCH_DEBOUNCE_MS);
    }

    function invalidatePhotoMapCache(ticketIds) {
        if (!ticketIds || !ticketIds.length) {
            sessionCache.clear();
            return;
        }
        const hash = ticketIdsHash(ticketIds.map((id) => Number(id)));
        for (const key of sessionCache.keys()) {
            const parts = key.split('|');
            if (parts.length >= 4 && parts[3] === hash) {
                sessionCache.delete(key);
            }
        }
    }

    function clearPhotoMapCache() {
        sessionCache.clear();
        lastSuccessfulPayload = null;
    }

    function onMapMoveOrZoom() {
        scheduleFetchPhotoMapForViewport(false);
    }

    function bindMapListeners() {
        const map = getMap();
        if (!map || mapListenersBound) return;
        mapListenersBound = true;
        map.on('moveend', onMapMoveOrZoom);
        map.on('zoomend', onMapMoveOrZoom);
    }

    function initPhotoMapLoader() {
        bindMapListeners();
    }

    function notifyPhotosLayerToggled(active) {
        if (active) {
            void fetchPhotoMapForViewport({ force: true });
        } else {
            mapViewportPhotos = [];
            lastSuccessfulPayload = null;
            if (window.photosModule && typeof window.photosModule.reloadPhotosOnMap === 'function') {
                window.photosModule.reloadPhotosOnMap();
            }
        }
    }

    function onAppHidden() {
        photoMapLastHiddenAt = Date.now();
    }

    function onAppVisibleAfterResume() {
        const hiddenMs =
            photoMapLastHiddenAt != null ? Date.now() - photoMapLastHiddenAt : 0;
        photoMapLastHiddenAt = null;
        if (hiddenMs >= PHOTO_MAP_CACHE_MAX_AGE_MS) {
            clearPhotoMapCache();
            void fetchPhotoMapForViewport({ force: true });
        }
    }

    function getMapViewportPhotos() {
        return mapViewportPhotos;
    }

    /**
     * Update or drop a viewport photo stub after manual GPS edit/remove (by media file id).
     * @param {number|string} fileId
     * @param {{ lat: number, lng: number }|null} latlng null removes the stub from the viewport list
     * @returns {object|null} updated viewport photo, or null if removed / not found
     */
    function patchMapViewportPhotoGps(fileId, latlng) {
        const fid = Number(fileId);
        if (!Number.isFinite(fid)) return null;
        const idx = mapViewportPhotos.findIndex((p) => p && Number(p.fileId) === fid);
        if (idx < 0) return null;
        if (latlng == null) {
            const removed = mapViewportPhotos[idx];
            mapViewportPhotos.splice(idx, 1);
            if (removed) removed.marker = null;
            return null;
        }
        const lat = Number(latlng.lat);
        const lng = Number(latlng.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return mapViewportPhotos[idx];
        mapViewportPhotos[idx].latlng = { lat, lng };
        return mapViewportPhotos[idx];
    }

    function showPhotoOnMapOneOff(photo) {
        const map = getMap();
        if (!map) return false;
        const lat = photo && photo.latlng ? Number(photo.latlng.lat) : Number(photo && photo.lat);
        const lng = photo && photo.latlng ? Number(photo.latlng.lng) : Number(photo && photo.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        if (showOnMapPinMarker) {
            try {
                showOnMapPinMarker.remove();
            } catch (_) {
                /* ignore */
            }
            showOnMapPinMarker = null;
        }
        const gate = shouldFetchPhotosForViewport();
        if (!gate.ok && gate.reason === 'no_active_tickets') {
            if (typeof window.appToast === 'function') {
                window.appToast('No active ticket in this area — showing pin only.');
            }
        }
        map.setView([lat, lng], Math.max(map.getZoom(), PHOTO_MAP_MIN_ZOOM));
        const photoIcon = L.divIcon({
            className: 'photo-marker photo-show-on-map-pin' + (photo && photo.associatedNoGps ? ' photo-marker--associated-nogps' : ''),
            html:
                window.photosModule && typeof window.photosModule.getPhotoMapMarkerIconHtml === 'function'
                    ? window.photosModule.getPhotoMapMarkerIconHtml(photo)
                    : '📷',
            iconSize: [32, 32],
            iconAnchor: [16, 32],
        });
        showOnMapPinMarker = L.marker([lat, lng], { icon: photoIcon });
        const photosMod = window.photosModule;
        if (photosMod && typeof photosMod.wirePhotoMapMarkerPopup === 'function') {
            photosMod.wirePhotoMapMarkerPopup(showOnMapPinMarker, photo);
        } else if (photosMod && typeof photosMod.buildPhotoMapPopupHtml === 'function') {
            showOnMapPinMarker.bindPopup(photosMod.buildPhotoMapPopupHtml(photo), { autoPan: false });
            showOnMapPinMarker.on('popupopen', function () {
                const el = this.getPopup().getElement();
                if (el && photosMod.setServerPhotoImageSources) photosMod.setServerPhotoImageSources(el);
                if (el && photosMod.bindPhotoPopupNoteButton) photosMod.bindPhotoPopupNoteButton(el);
                if (photosMod.centerMapOnPhotoPopup) photosMod.centerMapOnPhotoPopup(this);
            });
            if (photosMod.wirePhotoMapMarkerLeafletMobile) {
                photosMod.wirePhotoMapMarkerLeafletMobile(showOnMapPinMarker);
            }
        }
        showOnMapPinMarker.addTo(map);
        return true;
    }

    function refetchForPreferenceChange() {
        clearPhotoMapCache();
        scheduleFetchPhotoMapForViewport(true);
    }

    window.photoMapLoaderModule = {
        PHOTO_MAP_MIN_ZOOM,
        PHOTO_MAP_QUERY_ZOOM_CAP,
        getPhotoMapQueryZoom,
        getPhotoMapViewportBounds,
        initPhotoMapLoader,
        getPhotoMapTicketCandidates,
        shouldFetchPhotosForViewport,
        viewportTicketsAwaitingPolygonBackfill,
        fetchPhotoMapForViewport,
        scheduleFetchPhotoMapForViewport,
        invalidatePhotoMapCache,
        clearPhotoMapCache,
        notifyPhotosLayerToggled,
        onAppHidden,
        onAppVisibleAfterResume,
        getMapViewportPhotos,
        patchMapViewportPhotoGps,
        showPhotoOnMapOneOff,
        refetchForPreferenceChange,
        get lastMapMode() {
            return lastMapMode;
        },
    };
})();
