// API Configuration — base URLs are set in config-override.js (same file for all pages).
// API paths are always under /api (API_BASE = origin + '/api').
function getConfiguredApiBaseUrl(key) {
    if (window[key] != null && String(window[key]).trim() !== "") {
        // Strip trailing slashes so `${origin}/api` never becomes `...//api`
        return String(window[key]).trim().replace(/\/+$/, "");
    }
    return "";
}

function isLocalDevOrigin() {
    if (window.location.protocol === "file:") return true;
    const host = window.location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function getApiBaseUrl() {
    const devApiBaseUrl = getConfiguredApiBaseUrl("DEV_API_BASE_URL");
    if (isLocalDevOrigin() && devApiBaseUrl) return devApiBaseUrl;

    const apiBaseUrl = getConfiguredApiBaseUrl("API_BASE_URL");
    if (apiBaseUrl) return apiBaseUrl;

    // Same origin as the page (backend serves frontend on one port)
    return window.location.origin;
}

/** Collapse accidental double slashes in path (e.g. ...dev//api from old cached config). */
function normalizeApiBase(full) {
    if (!full) return full;
    try {
        const u = new URL(full);
        u.pathname = u.pathname.replace(/\/{2,}/g, "/");
        let out = u.origin + u.pathname;
        if (out.endsWith("/") && u.pathname.length > 1) out = out.slice(0, -1);
        return out;
    } catch {
        return full.replace(/([^:])\/\/+(api)(\/|$)/, "$1/$2$3");
    }
}

const API_BASE_URL = getApiBaseUrl();
const API_BASE = normalizeApiBase(`${API_BASE_URL}/api`);
window.normalizeApiBase = normalizeApiBase;

/** Non-empty Mapbox public access token from config-override.js, or '' */
function getMapboxAccessToken() {
    if (window.MAPBOX_ACCESS_TOKEN == null) return '';
    return String(window.MAPBOX_ACCESS_TOKEN).trim();
}
window.getMapboxAccessToken = getMapboxAccessToken;

// One-time client-side visibility for active API host config.
if (!window.__API_HOST_LOGGED__) {
    window.__API_HOST_LOGGED__ = true;
    console.info('[api-config]', {
        pageOrigin: window.location.origin,
        apiEnvironment: isLocalDevOrigin() && getConfiguredApiBaseUrl("DEV_API_BASE_URL") ? "development" : "production",
        apiBaseUrl: API_BASE_URL,
        apiBase: API_BASE
    });
}

// Map configuration
const MAP_CONFIG = {
    defaultCenter: [36.1699, -115.1398], // Las Vegas
    defaultZoom: 12,
    minZoom: 0,
    maxZoom: 24,
};

// In-memory tickets for the current org (map, Ticket Hub, importer) — populated from API / import
const ORG_TICKETS = [];

// Color options for annotations
const COLOR_OPTIONS = [
    '#2563eb', // blue (literal hex: Leaflet/canvas need resolved colors)
    '#dc2626', // red
    '#22c55e', // green
    '#facc15', // yellow
    '#f97316', // orange
    '#a855f7', // purple
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#84cc16', // lime
    '#eab308', // amber
];

// Export constants to window for global access
window.MAP_CONFIG = MAP_CONFIG;
window.ORG_TICKETS = ORG_TICKETS;
window.COLOR_OPTIONS = COLOR_OPTIONS;
window.API_BASE_URL = API_BASE_URL;
window.API_BASE = API_BASE;

/** Core branch: set `window.CORE_PRODUCT = true` in config-override.js only. */
if (typeof window.CORE_PRODUCT === 'undefined') {
    window.CORE_PRODUCT = false;
}
function isCoreProduct() {
    return window.CORE_PRODUCT === true;
}
window.isCoreProduct = isCoreProduct;
function applyCoreProductDocumentClass() {
    if (window.CORE_PRODUCT !== true || typeof document === 'undefined') return;
    document.documentElement.classList.add('core-product');
    if (document.body) document.body.classList.add('core-product');
}
if (typeof document !== 'undefined' && document.documentElement) {
    applyCoreProductDocumentClass();
    document.addEventListener('DOMContentLoaded', applyCoreProductDocumentClass);
}

/**
 * Fetches GET /api/public-config (ticket detail lock ms, feature flags) and sets
 * `window.LOCUS_TICKET_DETAIL_COOP_LOCK_MS`, `window.LOCUS_ENABLE_TICKET_RENEWAL`,
 * `window.LOCUS_HIDE_SITE_DOCUMENTATION`,
 * `window.LOCUS_ENABLE_GUIDED_TOUR`, and `window.LOCUS_SIGNUPS_CLOSED`.
 * Safe to call once per page load; failure keeps the in-script default.
 */
async function loadPublicWorkerConfig() {
    if (window.__LOCUS_PUBLIC_CONFIG_LOADED__) return;
    try {
        const r = await fetch(`${API_BASE}/public-config`, { method: 'GET', credentials: 'omit', cache: 'no-store' });
        if (!r.ok) {
            window.LOCUS_ENABLE_TICKET_RENEWAL = false;
            window.__LOCUS_PUBLIC_CONFIG_LOADED__ = true;
            return;
        }
        const j = await r.json();
        const ticketLockRaw = j.ticketDetailCoopLockMs;
        const n =
            typeof ticketLockRaw === 'number'
                ? ticketLockRaw
                : parseInt(String(ticketLockRaw != null ? ticketLockRaw : ''), 10);
        if (Number.isFinite(n) && n > 0) {
            window.LOCUS_TICKET_DETAIL_COOP_LOCK_MS = n;
            console.log('[public-config]', {
                ticketDetailCoopLockMs: n,
                source: 'backend',
                endpoint: `${API_BASE}/public-config`,
            });
        }
        const er = j.enableTicketRenewal;
        window.LOCUS_ENABLE_TICKET_RENEWAL =
            er === true ||
            er === 1 ||
            String(er).trim() === '1' ||
            String(er).trim().toLowerCase() === 'true';
        window.LOCUS_HIDE_SITE_DOCUMENTATION =
            window.CORE_PRODUCT === true || j.hideSiteDocumentation === true;
        window.LOCUS_SIGNUPS_CLOSED = j.signupsClosed === true;
        window.LOCUS_ENABLE_GUIDED_TOUR =
            window.LOCUS_ENABLE_GUIDED_TOUR === true || j.enableGuidedTour === true;
    } catch (_e) {
        /* use tickets-core default */
    }
    if (window.LOCUS_ENABLE_TICKET_RENEWAL !== true) {
        window.LOCUS_ENABLE_TICKET_RENEWAL = false;
    }
    if (window.CORE_PRODUCT === true) {
        window.LOCUS_HIDE_SITE_DOCUMENTATION = true;
        window.LOCUS_ENABLE_GUIDED_TOUR = false;
    }
    window.__LOCUS_PUBLIC_CONFIG_LOADED__ = true;
}
window.loadPublicWorkerConfig = loadPublicWorkerConfig;
