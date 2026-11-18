/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

import { NavigationRoute, registerRoute } from 'workbox-routing';
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

precacheAndRoute(__WB_MANIFEST_INJECT);

cleanupOutdatedCaches();

/** Map shell only: other HTML entry points (admin, auth, legal, public share) are separate apps. */
var navigationHandler = createHandlerBoundToURL('/index.html');
registerRoute(
    new NavigationRoute(navigationHandler, {
        denylist: [
            /^\/api\//,
            /^\/im\//,
            /^\/admin\.html$/,
            /^\/login\.html$/,
            /^\/forgot-password\.html$/,
            /^\/reset-password\.html$/,
            /^\/signup\.html$/,
            /^\/privacy-policy\.html$/,
            /^\/loading-indicators\.html$/,
            /^\/share\.html$/,
            /^\/share(\/|$)/,
        ],
    }),
);

self.skipWaiting();
self.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

/** Tile cache: entry cap + purge-on-quota approximates ~40 MB budget (tile sizes vary). */
var TILE_CACHE_NAME = 'locus-basemap-tiles-v3';
var TILE_MAX_ENTRIES = 450;
var TILE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** Drone/aerial orthophoto TMS tiles (GCS); 24-hour offline retention. */
var AERIAL_TILE_CACHE_NAME = 'locus-aerial-tiles-v1';
var AERIAL_TILE_MAX_ENTRIES = 300;
var AERIAL_TILE_MAX_AGE_SEC = 60 * 60 * 24;

/**
 * Standard Leaflet basemaps from map.js only — not aerial/time-warp TMS hosts.
 */
function isAllowlistedBasemapTile(url) {
    var h = url.hostname.toLowerCase();
    if (h === 'tile.openstreetmap.org' || h.endsWith('.tile.openstreetmap.org')) {
        return true;
    }
    return false;
}

/** Mapbox Static Tiles API (Styles v1 and Classic v4; per-user device cache). */
function isMapboxTile(url) {
    var h = url.hostname.toLowerCase();
    if (h !== 'api.mapbox.com') {
        return false;
    }
    if (/\/styles\/v1\/[^/]+\/[^/]+\/tiles\/(\d+\/)?\d+\/\d+\/\d+/i.test(url.pathname)) {
        return true;
    }
    return /\/v4\/[^/]+\/\d+\/\d+\/\d+(@2x)?\.png$/i.test(url.pathname);
}

function isCachedBasemapTileRequest(url) {
    if (isMapboxTile(url)) {
        return true;
    }
    if (!isAllowlistedBasemapTile(url)) {
        return false;
    }
    return /\.(png|jpg|jpeg|webp)$/i.test(url.pathname);
}

/** NodeODM / GCS orthophoto TMS tiles ({z}/{x}/{y}.png under orthophoto_tiles). */
function isAerialOrthophotoTileRequest(url) {
    var h = url.hostname.toLowerCase();
    if (h !== 'storage.googleapis.com') {
        return false;
    }
    return /\/orthophoto_tiles\/\d+\/\d+\/\d+\.png$/i.test(url.pathname);
}

registerRoute(
    ({ url, request }) => {
        if (request.method !== 'GET') return false;
        return isCachedBasemapTileRequest(url);
    },
    new CacheFirst({
        cacheName: TILE_CACHE_NAME,
        plugins: [
            new ExpirationPlugin({
                maxEntries: TILE_MAX_ENTRIES,
                maxAgeSeconds: TILE_MAX_AGE_SEC,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

registerRoute(
    ({ url, request }) => {
        if (request.method !== 'GET') return false;
        return isAerialOrthophotoTileRequest(url);
    },
    new CacheFirst({
        cacheName: AERIAL_TILE_CACHE_NAME,
        plugins: [
            new ExpirationPlugin({
                maxEntries: AERIAL_TILE_MAX_ENTRIES,
                maxAgeSeconds: AERIAL_TILE_MAX_AGE_SEC,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);
