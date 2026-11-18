/**
 * Shared aerial TMS helpers (primary app + public share page).
 * No auth / org dependencies — callers supply layer class and map lifecycle.
 */
(function (global) {
    'use strict';

    /** Orthophoto tiles are not shown until map zoom >= this. */
    const AERIAL_MIN_RENDER_ZOOM = 16;
    /** When catalog row has no stored native zoom (legacy rows). */
    const AERIAL_TMS_FALLBACK_MIN_ZOOM = 5;
    const AERIAL_TMS_FALLBACK_MAX_ZOOM = 22;

    const TRANSPARENT_TILE =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    function nativeZoomFromAerialMap(aerialMap) {
        const minZ = aerialMap && aerialMap.minNativeZoom != null ? Number(aerialMap.minNativeZoom) : NaN;
        const maxZ = aerialMap && aerialMap.maxNativeZoom != null ? Number(aerialMap.maxNativeZoom) : NaN;
        if (Number.isFinite(minZ) && Number.isFinite(maxZ)) {
            return { minNativeZoom: Math.min(minZ, maxZ), maxNativeZoom: Math.max(minZ, maxZ) };
        }
        return { minNativeZoom: AERIAL_TMS_FALLBACK_MIN_ZOOM, maxNativeZoom: AERIAL_TMS_FALLBACK_MAX_ZOOM };
    }

    function isSupportedAerialTmsUrl(url) {
        const u = url != null ? String(url) : '';
        return u.includes('tilemapresource.xml') || u.includes('orthophoto_tiles');
    }

    function resolveAerialTileUrlTemplate(aerialMap) {
        if (!aerialMap || !aerialMap.url || !isSupportedAerialTmsUrl(aerialMap.url)) return null;
        const baseUrl = String(aerialMap.url).replace('/tilemapresource.xml', '');
        return {
            baseUrl,
            tileUrlTemplate: `${baseUrl}/{z}/{x}/{y}.png`,
        };
    }

    function aerialBoundsFromMap(aerialMap) {
        if (!aerialMap || !aerialMap.boundingBox || !aerialMap.boundingBox.coordinates) return null;
        try {
            const coords = aerialMap.boundingBox.coordinates[0];
            return L.latLngBounds(coords.map((coord) => [coord[1], coord[0]]));
        } catch (_e) {
            return null;
        }
    }

    /**
     * @param {object} aerialMap
     * @param {object} [extra] merged into Leaflet tile layer options
     */
    function buildAerialTileLayerOptions(aerialMap, extra) {
        const { minNativeZoom, maxNativeZoom } = nativeZoomFromAerialMap(aerialMap);
        const tileBounds = aerialBoundsFromMap(aerialMap);
        const opts = {
            attribution: '',
            tms: true,
            minNativeZoom,
            maxNativeZoom,
            minZoom: Math.max(AERIAL_MIN_RENDER_ZOOM, minNativeZoom),
            maxZoom: 24,
            opacity: 1.0,
            className: 'aerial-map-tile-layer',
            pane: 'aerialMapPane',
            errorTileUrl: TRANSPARENT_TILE,
            bounds: tileBounds || undefined,
            keepBuffer: 3,
            updateWhenIdle: true,
            updateWhenZooming: false,
            updateInterval: 200,
            fadeAnimation: false,
            zIndex: 100,
        };
        if (extra && typeof extra === 'object') {
            Object.assign(opts, extra);
        }
        return opts;
    }

    /**
     * Create a Leaflet TMS tile layer for an aerial map row.
     * @param {object} aerialMap
     * @param {{ LayerClass?: Function, layerOptions?: object }} [options]
     * @returns {{ layer: object, mapId: string, tileBounds: object|null } | null}
     */
    function createAerialTileLayer(aerialMap, options) {
        const opts = options || {};
        const resolved = resolveAerialTileUrlTemplate(aerialMap);
        if (!resolved) return null;
        const mapId =
            aerialMap && aerialMap.id != null ? String(aerialMap.id) : resolved.tileUrlTemplate;
        const layerOptions = buildAerialTileLayerOptions(aerialMap, {
            aerialMapId: mapId,
            ...(opts.layerOptions || {}),
        });
        const LayerClass = opts.LayerClass || (typeof L !== 'undefined' ? L.TileLayer : null);
        if (!LayerClass) return null;
        const layer = new LayerClass(resolved.tileUrlTemplate, layerOptions);
        return {
            layer,
            mapId,
            tileBounds: aerialBoundsFromMap(aerialMap),
            tileUrlTemplate: resolved.tileUrlTemplate,
        };
    }

    function ensureAerialMapStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('aerial-map-styles')) return;
        const style = document.createElement('style');
        style.id = 'aerial-map-styles';
        style.textContent = `
            .aerial-map-tile-layer img {
                filter: none !important;
                -webkit-filter: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    global.mapAerialTileLayer = {
        AERIAL_MIN_RENDER_ZOOM,
        AERIAL_TMS_FALLBACK_MIN_ZOOM,
        AERIAL_TMS_FALLBACK_MAX_ZOOM,
        nativeZoomFromAerialMap,
        isSupportedAerialTmsUrl,
        resolveAerialTileUrlTemplate,
        aerialBoundsFromMap,
        buildAerialTileLayerOptions,
        createAerialTileLayer,
        ensureAerialMapStyles,
    };
})(typeof window !== 'undefined' ? window : globalThis);
