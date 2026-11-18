/**
 * Locate/USAN response code → description map for operator responses UI.
 * Edit `data/operator-response-code-catalog.json` (deployed as `/data/operator-response-code-catalog.json`).
 * Keys are matched case-insensitively after trim (stored keys are normalized to uppercase).
 * Each entry may be a plain string (legacy description) or { short, description }.
 */

let operatorResponseCodeCatalogMap = null;
let operatorResponseCodeCatalogLoadPromise = null;

function normalizeOperatorResponseCodeKey(code) {
    if (code == null || code === '') return '';
    return String(code).trim().toUpperCase();
}

/** @param {string} description */
function deriveShortFromDescription(description) {
    if (!description || String(description).trim() === '') return null;
    const text = String(description).trim();
    const dash = text.indexOf(' - ');
    if (dash > 0) return text.slice(0, dash).trim() || null;
    return text;
}

/**
 * @param {string|{ short?: string, description?: string }} value
 * @returns {{ short: string|null, description: string }}
 */
function normalizeCatalogEntry(value) {
    if (value == null) return { short: null, description: '' };
    if (typeof value === 'string') {
        const description = value.trim();
        return { short: deriveShortFromDescription(description), description };
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        const description =
            value.description != null && String(value.description).trim() !== ''
                ? String(value.description).trim()
                : '';
        let short =
            value.short != null && String(value.short).trim() !== ''
                ? String(value.short).trim()
                : null;
        if (!short && description) short = deriveShortFromDescription(description);
        return { short, description };
    }
    return { short: null, description: '' };
}

function buildOperatorResponseCodeCatalogMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        const entry = normalizeCatalogEntry(v);
        if (!entry.description && !entry.short) continue;
        const nk = normalizeOperatorResponseCodeKey(k);
        if (!nk) continue;
        out[nk] = entry;
    }
    return out;
}

function getCatalogEntry(statusCode) {
    if (!operatorResponseCodeCatalogMap || statusCode == null || String(statusCode).trim() === '') {
        return null;
    }
    const raw = String(statusCode).trim();
    const k = normalizeOperatorResponseCodeKey(raw);
    const map = operatorResponseCodeCatalogMap;
    if (map[k] != null) return map[k];
    if (map[raw] != null) return map[raw];
    return null;
}

/**
 * Fetch and cache the catalog. Safe to call multiple times.
 * @returns {Promise<void>}
 */
async function ensureOperatorResponseCodeCatalogLoaded() {
    if (operatorResponseCodeCatalogMap !== null) return;
    if (operatorResponseCodeCatalogLoadPromise) return operatorResponseCodeCatalogLoadPromise;
    operatorResponseCodeCatalogLoadPromise = (async () => {
        try {
            const url = new URL('data/operator-response-code-catalog.json', window.location.href).href;
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) {
                operatorResponseCodeCatalogMap = {};
                return;
            }
            const json = await res.json();
            operatorResponseCodeCatalogMap = buildOperatorResponseCodeCatalogMap(json);
        } catch (e) {
            console.warn('[operator-response-code-catalog] load failed:', e.message || e);
            operatorResponseCodeCatalogMap = {};
        }
    })();
    await operatorResponseCodeCatalogLoadPromise;
}

/**
 * @param {string|null|undefined} statusCode ticket operator response `statusCode`
 * @returns {string|null} description from JSON catalog, or null to use API fields
 */
function lookupOperatorResponseCodeCatalogDescription(statusCode) {
    const entry = getCatalogEntry(statusCode);
    if (!entry || !entry.description) return null;
    return entry.description;
}

/**
 * @param {string|null|undefined} statusCode ticket operator response `statusCode`
 * @returns {string|null} short label from JSON catalog, or null to use API fields
 */
function lookupOperatorResponseCodeCatalogShort(statusCode) {
    const entry = getCatalogEntry(statusCode);
    if (!entry || !entry.short) return null;
    return entry.short;
}

window.ensureOperatorResponseCodeCatalogLoaded = ensureOperatorResponseCodeCatalogLoaded;
window.lookupOperatorResponseCodeCatalogDescription = lookupOperatorResponseCodeCatalogDescription;
window.lookupOperatorResponseCodeCatalogShort = lookupOperatorResponseCodeCatalogShort;
window.normalizeOperatorResponseCodeKey = normalizeOperatorResponseCodeKey;
