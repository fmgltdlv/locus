// Copy from config-override.example.js and adjust for your deployment. See docs/DEPLOYMENT.md.

// Same host as the UI (Node serves frontend + API): leave empty.
window.API_BASE_URL = '';

// Separate API host (Pages + Worker, custom domain, etc.):
// window.API_BASE_URL = 'https://your-api.example.com';

// Local Worker dev host. Used automatically on localhost, 127.0.0.1, ::1, or file://.
window.DEV_API_BASE_URL = 'http://127.0.0.1:8787';

// Mapbox public token — enables "Mapbox Hybrid" basemap (satellite-streets-v12).
// window.MAPBOX_ACCESS_TOKEN = 'pk.eyJ...';