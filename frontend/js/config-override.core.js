// Core product build — used by `npm run build:core` (see frontend/package.json).

window.CORE_PRODUCT = true;
if (window.CORE_PRODUCT === true && typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.classList.add('core-product');
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#0b0d10');
    var faviconHref = '/assets/logo-mark-core.svg';
    var favicon = document.querySelector('link[rel="icon"]');
    if (!favicon && document.head) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        favicon.id = 'favicon';
        document.head.appendChild(favicon);
    }
    if (favicon) {
        favicon.type = 'image/svg+xml';
        favicon.href = faviconHref;
    }
}

// Same-origin: UI and API on one Worker (set to '' when Worker serves both).
window.API_BASE_URL = '';
window.DEV_API_BASE_URL = 'http://127.0.0.1:8787';

// window.MAPBOX_ACCESS_TOKEN = 'pk.eyJ...';