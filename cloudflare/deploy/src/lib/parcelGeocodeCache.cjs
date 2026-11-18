/**
 * D1 cache for assessor parcel situs addresses (map right-click / parcel lookup).
 */
const { getRow, runDb } = require('./db.cjs');

const DEFAULT_PROVIDER = 'clark_nv_gismo';

function titleCaseAddressWord(word) {
    const w = String(word || '');
    if (!w) return '';
    if (/^\d+[A-Za-z]?$/.test(w)) return w;
    const lower = w.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizeParcelSiteAddress(raw) {
    return String(raw || '')
        .trim()
        .replace(/\s+/g, ' ')
        .split(' ')
        .filter((part) => part.length > 0)
        .map(titleCaseAddressWord)
        .join(' ');
}

/**
 * @param {object} db
 * @param {string} parcelId
 * @returns {Promise<{ parcelId: string, siteAddress: string, zipCode: string, fetchedAt: string } | null>}
 */
async function getCachedParcelGeocode(db, parcelId) {
    const id = String(parcelId || '').trim();
    if (!id) return null;
    const row = await getRow(
        db,
        `SELECT parcel_id, site_address, zip_code, fetched_at
         FROM parcel_geocode_cache
         WHERE parcel_id = ?`,
        [id],
    );
    if (!row || !row.site_address) return null;
    return {
        parcelId: String(row.parcel_id),
        siteAddress: String(row.site_address),
        zipCode: row.zip_code != null ? String(row.zip_code) : '',
        fetchedAt: row.fetched_at != null ? String(row.fetched_at) : '',
    };
}

/**
 * @param {object} db
 * @param {{ parcelId: string, siteAddress: string, zipCode?: string, provider?: string }} record
 */
async function upsertCachedParcelGeocode(db, record) {
    const id = String(record && record.parcelId || '').trim();
    const siteAddress = normalizeParcelSiteAddress(record && record.siteAddress);
    if (!id || !siteAddress) return;
    const zipCode = String((record && record.zipCode) || '').trim();
    const provider = String((record && record.provider) || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const now = new Date().toISOString();
    await runDb(
        db,
        `INSERT INTO parcel_geocode_cache (parcel_id, site_address, zip_code, provider, fetched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parcel_id) DO UPDATE SET
           site_address = excluded.site_address,
           zip_code = excluded.zip_code,
           provider = excluded.provider,
           updated_at = excluded.updated_at`,
        [id, siteAddress, zipCode || null, provider, now, now],
    );
}

module.exports = {
    DEFAULT_PROVIDER,
    normalizeParcelSiteAddress,
    getCachedParcelGeocode,
    upsertCachedParcelGeocode,
};
