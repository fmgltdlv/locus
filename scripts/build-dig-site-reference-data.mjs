/**
 * One-off / CI: build Nevada RUCA tract table + simplified freeway & railroad centerlines
 * for create-ticket dig-site line-length rules.
 *
 * Outputs:
 *   frontend/data/usda/nv-ruca-2020.json
 *   frontend/data/transport/nv-freeways.json
 *   frontend/data/transport/nv-railroads.json
 *   cloudflare/deploy/src/data/nv-ruca-2020.json (copy for Worker rural-class)
 */
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const NV_STATEFP = '32';
const RUCA_CSV_URL =
    'https://www.ers.usda.gov/media/5443/2020-rural-urban-commuting-area-codes-census-tracts.csv?v=65796';

const NDOT_FSYSTEM_LAYER =
    'https://gis.dot.nv.gov/rhgis/rest/services/GeoHub/LRS_ReadOnly/MapServer/45/query';
const NARN_RAIL_LAYER =
    'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_North_American_Rail_Network_Lines/FeatureServer/0/query';

function simplifyRing(ring, maxPoints) {
    if (!Array.isArray(ring) || ring.length <= maxPoints) return ring;
    const out = [];
    const step = Math.max(1, Math.floor((ring.length - 1) / maxPoints));
    for (let i = 0; i < ring.length - 1; i += step) {
        out.push(ring[i]);
    }
    const last = ring[ring.length - 1];
    if (out.length && (out[out.length - 1][0] !== last[0] || out[out.length - 1][1] !== last[1])) {
        out.push(last);
    }
    return out;
}

function bboxOfCoords(coords) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const pt of coords) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lng = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
    }
    if (!Number.isFinite(minLng)) return null;
    return [minLng, minLat, maxLng, maxLat];
}

function geoJsonLinesToSegments(geojson, maxVertsPerLine) {
    const segments = [];
    const features = geojson && Array.isArray(geojson.features) ? geojson.features : [];
    for (const f of features) {
        const geom = f && f.geometry;
        if (!geom) continue;
        const pushLine = (coords) => {
            if (!Array.isArray(coords) || coords.length < 2) return;
            const simplified = simplifyRing(coords, maxVertsPerLine);
            const bbox = bboxOfCoords(simplified);
            if (!bbox) return;
            segments.push({ bbox, coords: simplified });
        };
        if (geom.type === 'LineString') {
            pushLine(geom.coordinates);
        } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
            geom.coordinates.forEach(pushLine);
        }
    }
    return segments;
}

async function fetchArcGisGeoJson(baseUrl, where, pageSize = 2000) {
    const all = { type: 'FeatureCollection', features: [] };
    let offset = 0;
    for (;;) {
        const params = new URLSearchParams({
            where,
            outFields: 'OBJECTID',
            returnGeometry: 'true',
            outSR: '4326',
            f: 'geojson',
            resultRecordCount: String(pageSize),
            resultOffset: String(offset),
        });
        const res = await fetch(`${baseUrl}?${params}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'CoreDigSiteDataBuild/1.0' },
        });
        if (!res.ok) {
            throw new Error(`ArcGIS query failed ${res.status}: ${baseUrl}`);
        }
        const chunk = await res.json();
        const feats = chunk && Array.isArray(chunk.features) ? chunk.features : [];
        all.features.push(...feats);
        if (chunk.exceededTransferLimit !== true && feats.length < pageSize) break;
        if (feats.length === 0) break;
        offset += feats.length;
        if (offset > 500000) break;
    }
    return all;
}

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}

async function buildNvRuca() {
    const res = await fetch(RUCA_CSV_URL, {
        headers: { 'User-Agent': 'CoreDigSiteDataBuild/1.0' },
    });
    if (!res.ok) {
        throw new Error(`RUCA CSV download failed: ${res.status}`);
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error('RUCA CSV empty');
    const header = parseCsvLine(lines[0]).map((h) => h.trim().replace(/^\ufeff/, ''));
    const idxState20 = header.findIndex((h) => h === 'StateFIPS20');
    const idxTractFips20 = header.findIndex((h) => h === 'TractFIPS20');
    const idxRuca = header.findIndex((h) => h === 'PrimaryRUCA');

    if (idxRuca < 0 || idxState20 < 0 || idxTractFips20 < 0) {
        throw new Error(`RUCA CSV missing columns: ${header.slice(0, 12).join(',')}`);
    }

    /** @type {Record<string, number>} */
    const tracts = {};
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const stateFp = String(cols[idxState20] || '').padStart(2, '0');
        if (stateFp !== NV_STATEFP) continue;
        const geoid = String(cols[idxTractFips20] || '').trim();
        if (!geoid || geoid.length < 11) continue;
        const ruca = parseInt(String(cols[idxRuca] || '').trim(), 10);
        if (!Number.isFinite(ruca)) continue;
        tracts[geoid] = ruca;
    }
    if (Object.keys(tracts).length < 100) {
        throw new Error(`Too few Nevada tracts in RUCA (${Object.keys(tracts).length})`);
    }
    return {
        source: 'USDA ERS RUCA 2020',
        stateFips: NV_STATEFP,
        tracts,
    };
}

async function main() {
    const outUsda = join(ROOT, 'frontend/data/usda');
    const outTransport = join(ROOT, 'frontend/data/transport');
    const outWorkerData = join(ROOT, 'cloudflare/deploy/src/data');
    await mkdir(outUsda, { recursive: true });
    await mkdir(outTransport, { recursive: true });
    await mkdir(outWorkerData, { recursive: true });

    console.log('Building Nevada RUCA table…');
    const ruca = await buildNvRuca();
    const rucaPath = join(outUsda, 'nv-ruca-2020.json');
    await writeFile(rucaPath, JSON.stringify(ruca));
    await copyFile(rucaPath, join(outWorkerData, 'nv-ruca-2020.json'));
    console.log(`  ${Object.keys(ruca.tracts).length} tracts → ${rucaPath}`);

    console.log('Fetching NDOT freeway centerlines (FSystem 1–2)…');
    const fwGeo = await fetchArcGisGeoJson(
        NDOT_FSYSTEM_LAYER,
        "FSystem IN ('1','2')",
        2000,
    );
    const freeways = {
        source: 'NDOT GeoHub LRS_ReadOnly FSystem',
        classes: ['1-Interstate', '2-Principal Arterial: Other Freeways/Expressways'],
        segments: geoJsonLinesToSegments(fwGeo, 24),
    };
    const fwPath = join(outTransport, 'nv-freeways.json');
    await writeFile(fwPath, JSON.stringify(freeways));
    console.log(`  ${freeways.segments.length} segments → ${fwPath}`);

    console.log('Fetching Nevada railroad centerlines (NARN)…');
    const railGeo = await fetchArcGisGeoJson(NARN_RAIL_LAYER, "STATEAB='NV'", 2000);
    const railroads = {
        source: 'NTAD North American Rail Network Lines (NV)',
        segments: geoJsonLinesToSegments(railGeo, 20),
    };
    const railPath = join(outTransport, 'nv-railroads.json');
    await writeFile(railPath, JSON.stringify(railroads));
    console.log(`  ${railroads.segments.length} segments → ${railPath}`);

    const fwKb = (JSON.stringify(freeways).length / 1024).toFixed(1);
    const railKb = (JSON.stringify(railroads).length / 1024).toFixed(1);
    const rucaKb = (JSON.stringify(ruca).length / 1024).toFixed(1);
    console.log(`Done. Sizes: RUCA ${rucaKb} KB, freeways ${fwKb} KB, railroads ${railKb} KB`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
