/** Nevada tract → USDA Primary RUCA (2020) for dig-site line-length caps. */
const nvRucaBundle = require('../data/nv-ruca-2020.json');

const HALF_MILE_FT = 2640;
const TWO_MILE_FT = 10560;

const tractRuca =
    nvRucaBundle && nvRucaBundle.tracts && typeof nvRucaBundle.tracts === 'object'
        ? nvRucaBundle.tracts
        : {};

const tractCache = new Map();

function isMetroRuca(ruca) {
    if (!Number.isFinite(ruca)) return true;
    if (ruca === 99) return true;
    return ruca >= 1 && ruca <= 3;
}

function maxLineFeetForRuca(ruca) {
    return isMetroRuca(ruca) ? HALF_MILE_FT : TWO_MILE_FT;
}

function labelForCap(maxLineFeet, ruca) {
    if (maxLineFeet >= TWO_MILE_FT && Number.isFinite(ruca) && !isMetroRuca(ruca)) {
        return 'Rural · up to 2 mi';
    }
    return 'City · up to 0.5 mi';
}

async function fetchCensusTractGeoid(lat, lng) {
    const x = Number(lng);
    const y = Number(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const url =
        'https://geocoding.geo.census.gov/geocoder/geographies/coordinates?' +
        new URLSearchParams({
            x: String(x),
            y: String(y),
            benchmark: 'Public_AR_Current',
            vintage: 'Current_Current',
            format: 'json',
        }).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        const res = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'ExcavatorManagement/1.0' },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        const tracts =
            data &&
            data.result &&
            data.result.geographies &&
            data.result.geographies['Census Tracts'];
        const row = Array.isArray(tracts) && tracts.length ? tracts[0] : null;
        const geoid = row && row.GEOID != null ? String(row.GEOID).trim() : '';
        return geoid || null;
    } catch (_e) {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{ ruca: number|null, rural: boolean, maxLineFeet: number, label: string, tractGeoid: string|null }>}
 */
async function resolveRuralClassForLatLng(lat, lng) {
    const cacheKey = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
    if (tractCache.has(cacheKey)) {
        return tractCache.get(cacheKey);
    }

    const geoid = await fetchCensusTractGeoid(lat, lng);
    let ruca = null;
    if (geoid && tractRuca[geoid] != null) {
        ruca = Number(tractRuca[geoid]);
    }
    const maxLineFeet = maxLineFeetForRuca(ruca);
    const out = {
        ruca: Number.isFinite(ruca) ? ruca : null,
        rural: Number.isFinite(ruca) ? !isMetroRuca(ruca) : false,
        maxLineFeet,
        label: labelForCap(maxLineFeet, ruca),
        tractGeoid: geoid,
    };
    tractCache.set(cacheKey, out);
    if (tractCache.size > 5000) {
        const first = tractCache.keys().next().value;
        tractCache.delete(first);
    }
    return out;
}

module.exports = {
    HALF_MILE_FT,
    TWO_MILE_FT,
    isMetroRuca,
    maxLineFeetForRuca,
    resolveRuralClassForLatLng,
};
