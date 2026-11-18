/**
 * Prefix-search public GCS buckets via the XML ListBucket API.
 */

const DEFAULT_MAX_PAGES = 3;
const MAX_QUERY_LEN = 200;
const DEFAULT_PREFIX = 'outputs/';
const DEFAULT_TILESET_SUFFIX = 'orthophoto_tiles/tilemapresource.xml';

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFolderQuery(raw) {
    const q = String(raw || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/\.\./g, '')
        .replace(/[/\\]/g, '');
    return q.slice(0, MAX_QUERY_LEN);
}

/**
 * @param {unknown} bucket
 * @returns {boolean}
 */
function isValidGcsBucketName(bucket) {
    if (typeof bucket !== 'string') return false;
    const name = bucket.trim();
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
    return /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name);
}

/**
 * @param {unknown} prefix
 * @returns {string}
 */
function normalizePrefix(prefix) {
    let p = String(prefix == null || String(prefix).trim() === '' ? DEFAULT_PREFIX : prefix).trim();
    p = p.replace(/^\/+/, '');
    if (!p.endsWith('/')) p += '/';
    if (p.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(p)) {
        throw new Error('Invalid prefix');
    }
    return p;
}

/**
 * @param {unknown} suffix
 * @returns {string}
 */
function normalizeTilesetSuffix(suffix) {
    const s = String(
        suffix == null || String(suffix).trim() === '' ? DEFAULT_TILESET_SUFFIX : suffix
    )
        .trim()
        .replace(/^\/+/, '');
    if (!s || s.includes('..') || !/^[a-zA-Z0-9._/-]+\.xml$/i.test(s)) {
        throw new Error('Invalid tileset suffix');
    }
    return s;
}

/**
 * @param {string} xml
 * @returns {{ prefixes: string[], isTruncated: boolean, nextMarker: string|null }}
 */
function parseListBucketResultXml(xml) {
    const prefixes = [];
    const prefixRe = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g;
    let m;
    while ((m = prefixRe.exec(xml)) !== null) {
        prefixes.push(m[1]);
    }
    const truncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/i);
    const isTruncated = truncatedMatch ? truncatedMatch[1].toLowerCase() === 'true' : false;
    const nextMarkerMatch = xml.match(/<NextMarker>([^<]*)<\/NextMarker>/);
    const nextMarker =
        nextMarkerMatch && nextMarkerMatch[1] && nextMarkerMatch[1].trim() !== ''
            ? nextMarkerMatch[1].trim()
            : null;
    return { prefixes, isTruncated, nextMarker };
}

/**
 * @param {string} listedPrefix
 * @param {string} basePrefix
 * @returns {string|null}
 */
function folderNameFromListedPrefix(listedPrefix, basePrefix) {
    if (!listedPrefix || typeof listedPrefix !== 'string') return null;
    if (!listedPrefix.startsWith(basePrefix)) return null;
    const rest = listedPrefix.slice(basePrefix.length).replace(/\/$/, '');
    if (!rest || rest.includes('/')) return null;
    return rest;
}

/**
 * @param {string} bucket
 * @param {string} prefix
 * @param {string} folderName
 * @param {string} [tilesetSuffix]
 * @returns {string}
 */
function tilesetUrlForFolder(bucket, prefix, folderName, tilesetSuffix) {
    const p = normalizePrefix(prefix);
    const s = normalizeTilesetSuffix(tilesetSuffix);
    const folder = String(folderName || '').replace(/^\/+|\/+$/g, '');
    return `https://storage.googleapis.com/${bucket}/${p}${folder}/${s}`;
}

/**
 * @param {string} bucket
 * @param {string} listPrefix
 * @param {string|null} [marker]
 * @returns {string}
 */
function buildListUrl(bucket, listPrefix, marker) {
    const params = new URLSearchParams({ prefix: listPrefix, delimiter: '/' });
    if (marker) params.set('marker', String(marker));
    return `https://storage.googleapis.com/${encodeURIComponent(bucket)}/?${params.toString()}`;
}

/**
 * @param {string} bucket
 * @param {string} prefix
 * @param {string} query
 * @param {{ maxPages?: number }} [opts]
 * @returns {Promise<{ folders: string[], truncated: boolean }>}
 */
async function listFoldersByPrefix(bucket, prefix, query, opts = {}) {
    if (!isValidGcsBucketName(bucket)) {
        throw new Error('Invalid bucket name');
    }
    const q = normalizeFolderQuery(query);
    if (!q) {
        return { folders: [], truncated: false };
    }
    const basePrefix = normalizePrefix(prefix);
    const listPrefix = `${basePrefix}${q}`;
    const maxPages = Number.isFinite(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : DEFAULT_MAX_PAGES;
    const folders = [];
    let marker = null;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
        const url = buildListUrl(bucket, listPrefix, marker);
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`GCS list failed: ${res.status} ${res.statusText}`);
        }
        const parsed = parseListBucketResultXml(await res.text());
        for (const listed of parsed.prefixes) {
            const name = folderNameFromListedPrefix(listed, basePrefix);
            if (name) folders.push(name);
        }
        if (parsed.isTruncated) {
            truncated = true;
            if (parsed.nextMarker) {
                marker = parsed.nextMarker;
            } else {
                break;
            }
        } else {
            truncated = false;
            break;
        }
    }

    return { folders, truncated };
}

module.exports = {
    DEFAULT_MAX_PAGES,
    DEFAULT_PREFIX,
    DEFAULT_TILESET_SUFFIX,
    MAX_QUERY_LEN,
    normalizeFolderQuery,
    isValidGcsBucketName,
    normalizePrefix,
    normalizeTilesetSuffix,
    parseListBucketResultXml,
    folderNameFromListedPrefix,
    tilesetUrlForFolder,
    buildListUrl,
    listFoldersByPrefix,
};
