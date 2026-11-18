import { Hono } from "hono";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim } from "../expressCompat.js";
import type { Env } from "../types.js";
import { authMiddleware } from "../auth.js";
import { getDatabase } from "../database.js";

const { getCachedParcelGeocode, upsertCachedParcelGeocode, normalizeParcelSiteAddress } = require('../lib/parcelGeocodeCache.cjs');
const { resolveRuralClassForLatLng } = require('../lib/ruralClass.cjs');

const geocoding = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
geocoding.use("*", jsonBodyMiddleware);
geocoding.use("*", authMiddleware);
geocoding.use("*", expressReqResMiddleware);

// Geocoding service configuration
// Options: 'photon', 'nominatim', or 'both' (try photon first, fallback to nominatim)
// Default: 'photon'
const GEOCODING_SERVICE = (process.env.GEOCODING_SERVICE || 'photon').toLowerCase();

/** Base URL for OSM Nominatim (no trailing slash). Override with self-hosted if needed. */
const NOMINATIM_BASE = (process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');

/**
 * Headers required by https://operations.osmfoundation.org/policies/nominatim/
 * (identifiable User-Agent and Referer; stock library defaults are rejected → 403).
 */
function nominatimHeaders(req) {
    const contactHint =
        process.env.NOMINATIM_CONTACT_EMAIL ||
        process.env.NOMINATIM_CONTACT ||
        (process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.split(',')[0].trim()) ||
        'http://localhost:3001';
    const userAgent =
        process.env.NOMINATIM_USER_AGENT ||
        `Locus/1.0 (${contactHint})`;
    const referer = req.headers.referer || contactHint;
    return {
        'User-Agent': userAgent,
        Referer: referer,
        Accept: 'application/json',
        'Accept-Language': 'en',
    };
}

// Simple in-memory rate limiter and cache
const requestCache = new Map(); // Cache for recent requests
const requestTimestampsByClient = new Map(); // Track request timestamps per client for rate limiting
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
const MAX_REQUESTS_PER_WINDOW = 1; // Limit to 1 request per window (Nominatim policy: max 1 request per second)
const RATE_LIMIT_WINDOW = 2 * 1000; // 2 second window (more conservative than Nominatim's 1 req/sec)

/** Assessor parcel lookup (GISMO) — separate bucket from Nominatim; map right-click is one combined action. */
const parcelLookupTimestampsByClient = new Map();
const PARCEL_LOOKUP_MAX_REQUESTS = 12;
const PARCEL_LOOKUP_RATE_WINDOW = 2 * 1000;

/** Create-ticket line cap (Census tract + RUCA) — separate from Nominatim search/reverse. */
const ruralClassTimestampsByClient = new Map();
const RURAL_CLASS_MAX_REQUESTS = 40;
const RURAL_CLASS_RATE_WINDOW = 60 * 1000;

/**
 * Soft regional bias for Photon/Nominatim forward search when the client sends no bbox.
 * west,south,east,north — approximate Nevada state bounds (not map viewport).
 * Override with GEOCODING_BIAS_BBOX; set to empty string to disable.
 */
const DEFAULT_GEOCODING_BIAS_BBOX = '-120.006,35.002,-114.04,42.002';
const GEOCODING_BIAS_BBOX = (
    process.env.GEOCODING_BIAS_BBOX !== undefined
        ? String(process.env.GEOCODING_BIAS_BBOX).trim()
        : DEFAULT_GEOCODING_BIAS_BBOX
);

console.log(`Geocoding service configured: ${GEOCODING_SERVICE}`);

function getRateLimitClientKey(c) {
    return (
        c.req.header('cf-connecting-ip') ||
        c.req.header('x-forwarded-for') ||
        (c.get('user') && c.get('user').id ? `user:${c.get('user').id}` : 'unknown')
    );
}

function pruneRateLimitMap(map, now, windowMs) {
    if (map.size <= 1000) return;
    for (const [key, timestamps] of map) {
        if (!timestamps.length || timestamps[timestamps.length - 1] < now - windowMs) {
            map.delete(key);
        }
    }
}

function checkRateLimit(timestampsByClient, clientKey, now, maxRequests, windowMs) {
    const requestTimestamps = timestampsByClient.get(clientKey) || [];
    while (requestTimestamps.length > 0 && requestTimestamps[0] < now - windowMs) {
        requestTimestamps.shift();
    }
    if (requestTimestamps.length >= maxRequests) {
        const oldestRequest = requestTimestamps[0];
        const waitTime = Math.max(1, Math.ceil((oldestRequest + windowMs - now) / 1000));
        return { allowed: false, waitTime, requestTimestamps };
    }
    requestTimestamps.push(now);
    timestampsByClient.set(clientKey, requestTimestamps);
    return { allowed: true, waitTime: 0, requestTimestamps };
}

// Rate limiting middleware (Hono signature)
function createRateLimitMiddleware(timestampsByClient, maxRequests, windowMs, label) {
    return async function rateLimit(c, next) {
        const now = Date.now();
        const clientKey = getRateLimitClientKey(c);
        const result = checkRateLimit(timestampsByClient, clientKey, now, maxRequests, windowMs);

        if (!result.allowed) {
            return c.json({
                error: 'Rate limit exceeded',
                message: `Too many ${label} requests. Please wait ${result.waitTime} seconds before trying again.`,
                retryAfter: result.waitTime,
            }, 429);
        }

        pruneRateLimitMap(timestampsByClient, now, windowMs);
        await next();
    };
}

const rateLimitGeocoding = createRateLimitMiddleware(
    requestTimestampsByClient,
    MAX_REQUESTS_PER_WINDOW,
    RATE_LIMIT_WINDOW,
    'geocoding',
);

const rateLimitParcelLookup = createRateLimitMiddleware(
    parcelLookupTimestampsByClient,
    PARCEL_LOOKUP_MAX_REQUESTS,
    PARCEL_LOOKUP_RATE_WINDOW,
    'parcel lookup',
);

const rateLimitRuralClass = createRateLimitMiddleware(
    ruralClassTimestampsByClient,
    RURAL_CLASS_MAX_REQUESTS,
    RURAL_CLASS_RATE_WINDOW,
    'rural-class',
);

// Helper function to convert Photon format to Nominatim-like format
function convertPhotonToNominatimFormat(photonResults) {
    return photonResults.features.map(feature => {
        const [lon, lat] = feature.geometry.coordinates;
        const props = feature.properties;
        
        // Build display name from available properties
        const parts = [];
        if (props.name) parts.push(props.name);
        if (props.housenumber && props.street) {
            parts.push(`${props.housenumber} ${props.street}`);
        } else if (props.street) {
            parts.push(props.street);
        }
        if (props.city) parts.push(props.city);
        if (props.state) parts.push(props.state);
        if (props.country) parts.push(props.country);
        
        const display_name = parts.join(', ') || props.name || 'Unknown location';
        
        return {
            display_name: display_name,
            lat: lat.toString(),
            lon: lon.toString(),
            name: props.name || '',
            address: {
                house_number: props.housenumber || '',
                road: props.street || '',
                city: props.city || '',
                state: props.state || '',
                country: props.country || '',
                postcode: props.postcode || ''
            },
            boundingbox: feature.bbox ? [
                feature.bbox[1].toString(), // min lat
                feature.bbox[3].toString(), // max lat
                feature.bbox[0].toString(), // min lon
                feature.bbox[2].toString()  // max lon
            ] : null
        };
    });
}

/** Single-feature Photon reverse → shape expected by clients using Nominatim reverse (`display_name`, etc.). */
function convertPhotonReverseToNominatimLike(photonData) {
    const feature = photonData.features && photonData.features[0];
    if (!feature) return null;
    const props = feature.properties;
    const parts = [];
    if (props.name) parts.push(props.name);
    if (props.housenumber && props.street) {
        parts.push(`${props.housenumber} ${props.street}`);
    } else if (props.street) {
        parts.push(props.street);
    }
    if (props.city) parts.push(props.city);
    if (props.state) parts.push(props.state);
    if (props.country) parts.push(props.country);
    const display_name = parts.join(', ') || props.name || 'Unknown location';
    const [lonCoord, latCoord] = feature.geometry.coordinates;
    return {
        display_name,
        lat: String(latCoord),
        lon: String(lonCoord),
        name: props.name || '',
        address: {
            house_number: props.housenumber || '',
            road: props.street || '',
            city: props.city || '',
            state: props.state || '',
            country: props.country || '',
            postcode: props.postcode || '',
        },
    };
}

function parseOptionalCoord(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Parse `bbox=west,south,east,north` for geocode search bias. */
function parseGeocodeSearchBbox(bboxParam) {
    if (!bboxParam || typeof bboxParam !== 'string') return null;
    const parts = bboxParam.split(',').map((s) => Number(String(s).trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [west, south, east, north] = parts;
    if (west >= east || south >= north) return null;
    if (west < -180 || east > 180 || south < -90 || north > 90) return null;
    return { west, south, east, north };
}

function geocodeBiasFromRequestQuery(query) {
    const lat = parseOptionalCoord(query.lat);
    const lon = parseOptionalCoord(query.lon);
    let bbox = parseGeocodeSearchBbox(query.bbox != null ? String(query.bbox) : '');
    const bounded = query.bounded === '1' || query.bounded === 'true';
    const countrycodes =
        query.countrycodes != null && String(query.countrycodes).trim() !== ''
            ? String(query.countrycodes).trim().toLowerCase()
            : '';
    if (!bbox && GEOCODING_BIAS_BBOX) {
        bbox = parseGeocodeSearchBbox(GEOCODING_BIAS_BBOX);
    }
    return { lat, lon, bbox, bounded, countrycodes: countrycodes || null };
}

function geocodeBiasCacheSuffix(bias) {
    const bbox = bias.bbox;
    const bboxKey = bbox ? [bbox.west, bbox.south, bbox.east, bbox.north].join(',') : '';
    return [
        bias.lat != null ? bias.lat : '',
        bias.lon != null ? bias.lon : '',
        bboxKey,
        bias.bounded ? '1' : '0',
        bias.countrycodes || '',
    ].join('|');
}

function buildPhotonSearchUrl(searchQuery, limit, bias) {
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(searchQuery)}&limit=${limit}&lang=en`;
    if (bias.lat != null && bias.lon != null) {
        url += `&lat=${encodeURIComponent(bias.lat)}&lon=${encodeURIComponent(bias.lon)}`;
    }
    if (bias.bbox) {
        const b = bias.bbox;
        url += `&bbox=${encodeURIComponent(b.west)},${encodeURIComponent(b.south)},${encodeURIComponent(b.east)},${encodeURIComponent(b.north)}`;
    }
    return url;
}

function buildNominatimSearchUrl(searchQuery, limit, addressdetails, bias) {
    let url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=${limit}&addressdetails=${addressdetails}&accept-language=en`;
    if (bias.countrycodes) {
        url += `&countrycodes=${encodeURIComponent(bias.countrycodes)}`;
    }
    if (bias.lat != null && bias.lon != null) {
        url += `&lat=${encodeURIComponent(bias.lat)}&lon=${encodeURIComponent(bias.lon)}`;
    }
    if (bias.bbox) {
        const b = bias.bbox;
        url += `&viewbox=${encodeURIComponent(b.west)},${encodeURIComponent(b.north)},${encodeURIComponent(b.east)},${encodeURIComponent(b.south)}`;
        if (bias.bounded) url += '&bounded=1';
    }
    return url;
}

// Search addresses - try Photon first (better rate limits), fallback to Nominatim
geocoding.get('/search', rateLimitGeocoding, async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    try {
        const { q, limit = 5, addressdetails = 1 } = req.query;
        
        if (!q || q.trim().length < 3) {
            return res.status(400).json({ error: 'Query must be at least 3 characters' });
        }
        
        const searchQuery = q.trim();
        const bias = geocodeBiasFromRequestQuery(req.query);

        // Build cache key
        const query = searchQuery.toLowerCase();
        const cacheKey = `${query}_${limit}_${addressdetails}_${geocodeBiasCacheSuffix(bias)}`;
        
        // Check cache first
        const cached = requestCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            console.log('Geocoding cache hit:', query);
            return res.json(cached.data);
        }
        
        console.log('Geocoding request:', {
            query: searchQuery,
            limit,
            addressdetails,
            service: GEOCODING_SERVICE,
            bias: {
                lat: bias.lat,
                lon: bias.lon,
                bbox: bias.bbox,
                bounded: bias.bounded,
                countrycodes: bias.countrycodes,
            },
        });
        
        // Use Photon if configured
        if (GEOCODING_SERVICE === 'photon' || GEOCODING_SERVICE === 'both') {
            const photonUrl = buildPhotonSearchUrl(searchQuery, limit, bias);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                const photonResponse = await fetch(photonUrl, {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'CJS-Ticket-System/1.0'
                    },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                
                if (photonResponse.ok) {
                    const photonData = (await photonResponse.json()) as { features?: unknown[] };
                    
                    if (photonData.features && photonData.features.length > 0) {
                        // Convert Photon format to Nominatim-like format for compatibility
                        const convertedData = convertPhotonToNominatimFormat(photonData);
                        
                        console.log('Geocoding results (Photon):', convertedData.length, 'results found');
                        
                        // Cache the result
                        requestCache.set(cacheKey, {
                            data: convertedData,
                            timestamp: Date.now()
                        });
                        
                        // Clean up old cache entries
                        if (requestCache.size > 100) {
                            const oldestKey = Array.from(requestCache.entries())
                                .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
                            requestCache.delete(oldestKey);
                        }
                        
                        return res.json(convertedData);
                    }
                }
                
                // No Photon hits is an empty suggestion list, not a server error.
                if (GEOCODING_SERVICE !== 'both') {
                    return res.json([]);
                }
                console.log('Photon returned no results or failed, trying Nominatim fallback...');
                
            } catch (photonError) {
                if (photonError.name === 'AbortError') {
                    if (GEOCODING_SERVICE === 'photon') {
                        throw new Error('Request timeout: Geocoding service took too long to respond');
                    }
                } else if (GEOCODING_SERVICE === 'both') {
                    console.warn('Photon request failed, trying Nominatim fallback:', photonError.message);
                } else {
                    throw photonError;
                }
            }
        }
        
        // Use Nominatim if configured (either as primary or fallback)
        if (GEOCODING_SERVICE === 'nominatim' || GEOCODING_SERVICE === 'both') {
            const nominatimUrl = buildNominatimSearchUrl(searchQuery, limit, addressdetails, bias);
            
            const fetchOptions = {
                headers: nominatimHeaders(req),
            };
            
            const controller2 = new AbortController();
            const timeoutId2 = setTimeout(() => controller2.abort(), 10000);
            
            try {
                const response = await fetch(nominatimUrl, {
                    ...fetchOptions,
                    signal: controller2.signal
                });
                clearTimeout(timeoutId2);
                
                console.log('Nominatim response status:', response.status);
                
                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'Unknown error');
                    console.error('Nominatim API error:', response.status, response.statusText);
                    
                    // Handle specific error codes
                    if (response.status === 403) {
                        throw new Error('Geocoding service has temporarily blocked requests. Please wait a few hours before trying again.');
                    } else if (response.status === 503) {
                        throw new Error('Geocoding service is temporarily unavailable. Please try again in a moment.');
                    } else if (response.status === 429) {
                        throw new Error('Too many requests to geocoding service. Please wait before trying again.');
                    }
                    
                    throw new Error(`Geocoding service error: ${response.status} ${response.statusText}`);
                }
                
                const data = await response.json();
                
                // Check if data is valid
                if (!Array.isArray(data)) {
                    console.error('Unexpected response format from Nominatim:', typeof data, data);
                    throw new Error('Invalid response format from geocoding service');
                }
                
                console.log('Geocoding results (Nominatim):', data.length, 'results found');
                
                // Cache the result
                requestCache.set(cacheKey, {
                    data: data,
                    timestamp: Date.now()
                });
                
                // Clean up old cache entries
                if (requestCache.size > 100) {
                    const oldestKey = Array.from(requestCache.entries())
                        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
                    requestCache.delete(oldestKey);
                }
                
                return res.json(data);
            } catch (fetchError) {
                clearTimeout(timeoutId2);
                if (fetchError.name === 'AbortError') {
                    throw new Error('Request timeout: Geocoding service took too long to respond');
                }
                throw fetchError;
            }
        }
        
        // If we get here and no service was configured, return error
        throw new Error('No geocoding service configured. Set GEOCODING_SERVICE environment variable to "photon", "nominatim", or "both".');
    } catch (error) {
        console.error('Error proxying Nominatim search:', error);
        console.error('Error stack:', error.stack);
        
        // Provide more detailed error message
        const errorMessage = error.message || 'Unknown error occurred';
        res.status(500).json({ 
            error: 'Failed to search addresses', 
            details: errorMessage,
            hint: 'This might be due to rate limiting or network issues. Please try again in a moment.'
        });
    }
});

async function fetchPhotonReverse(lat, lon) {
    const photonUrl = `https://photon.komoot.io/reverse?lon=${encodeURIComponent(lon)}&lat=${encodeURIComponent(lat)}&lang=en`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
        const photonRes = await fetch(photonUrl, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'ExcavatorManagement/1.0',
            },
            signal: controller.signal,
        });
        if (!photonRes.ok) return null;
        const photonData = await photonRes.json();
        return convertPhotonReverseToNominatimLike(photonData);
    } finally {
        clearTimeout(timeoutId);
    }
}

// Reverse geocoding (lat/lon to address)
geocoding.get('/reverse', rateLimitGeocoding, async (c) => { const req = buildExpressReq(c); const res = c.get("expressRes");
    try {
        const { lat, lon } = req.query;

        if (!lat || !lon) {
            return res.status(400).json({ error: 'Latitude and longitude are required' });
        }

        // Match /search: Photon first when configured (lighter policy limits than public Nominatim).
        if (GEOCODING_SERVICE === 'photon' || GEOCODING_SERVICE === 'both') {
            try {
                const fromPhoton = await fetchPhotonReverse(lat, lon);
                if (fromPhoton) {
                    return res.json(fromPhoton);
                }
            } catch (e) {
                if (GEOCODING_SERVICE === 'both') {
                    console.warn('Photon reverse failed, trying Nominatim:', e.message);
                } else {
                    throw e;
                }
            }
            if (GEOCODING_SERVICE === 'photon') {
                return res.status(502).json({
                    error: 'Failed to reverse geocode',
                    details: 'Photon reverse returned no result',
                });
            }
        }

        const nominatimUrl = `${NOMINATIM_BASE}/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&addressdetails=1`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let response;
        try {
            response = await fetch(nominatimUrl, {
                headers: nominatimHeaders(req),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (response.ok) {
            const data = await response.json();
            return res.json(data);
        }

        const status = response.status;
        console.warn('Nominatim reverse failed:', status, response.statusText);

        if (status === 403 || status === 429 || status === 503) {
            try {
                const fromPhoton = await fetchPhotonReverse(lat, lon);
                if (fromPhoton) {
                    console.log('Reverse geocoding fallback (Photon): ok');
                    return res.json(fromPhoton);
                }
            } catch (e) {
                if (e.name !== 'AbortError') {
                    console.warn('Photon reverse fallback failed:', e.message);
                }
            }
        }

        if (status === 403) {
            return res.status(502).json({
                error: 'Failed to reverse geocode',
                details:
                    'Nominatim refused the request (403). Set NOMINATIM_USER_AGENT and NOMINATIM_CONTACT_EMAIL in server env to identify your app, or wait if your IP was temporarily blocked.',
            });
        }

        throw new Error(`Nominatim API error: ${status} ${response.statusText}`);
    } catch (error) {
        console.error('Error proxying Nominatim reverse geocoding:', error);
        const msg =
            error.name === 'AbortError'
                ? 'Reverse geocoding request timed out'
                : error.message;
        res.status(500).json({ error: 'Failed to reverse geocode', details: msg });
    }
});

const GISMO_BASE =
    'https://maps.clarkcountynv.gov/gismo/webservice/GISDataWCF/GISDataService.svc/jsonep';

/** Clark County stopped Composite_All; Composite_All_Pro is the live locator (same WKID 102707). */
const CLARK_ARCGIS_GEOCODE_URL =
    'https://maps.clarkcountynv.gov/arcgis/rest/services/Locators/Clark_County_Composite_All_Pro/GeocodeServer/findAddressCandidates';

async function fetchGismoJson(pathAndQuery) {
    const url = `${GISMO_BASE}/${pathAndQuery}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'ExcavatorManagement/1.0' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`GISMO request failed: ${response.status} ${response.statusText}`);
        }
        return response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

function resolveParcelIdFromPoint(pointData) {
    if (!pointData || pointData.error) {
        return {
            parcelId: '',
            error: pointData && pointData.error ? String(pointData.error) : 'Parcel lookup failed',
        };
    }
    let parcelId = String(pointData.parcel || '').trim();
    if (pointData.isCondo === true && Array.isArray(pointData.condoList) && pointData.condoList.length) {
        const first = String(pointData.condoList[0] || '').trim();
        if (first) parcelId = first;
    }
    if (!parcelId) {
        return { parcelId: '', error: 'No parcel at this location' };
    }
    return { parcelId, error: null };
}

/** Parse GISMO parcelGeometry (JSON string or array) → outer ring [[x,y], ...] in state plane. */
function parseParcelGeometryFromPoint(pointData) {
    if (!pointData || pointData.parcelGeometry == null || pointData.parcelGeometry === '') return null;
    try {
        const raw = pointData.parcelGeometry;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed) || !parsed.length) return null;
        const ring = parsed[0];
        if (!Array.isArray(ring) || ring.length < 3) return null;
        return ring;
    } catch {
        return null;
    }
}

async function fetchParcelProperty(db, parcelId) {
    const id = String(parcelId || '').trim();
    if (!id) return { siteAddress: '', zipCode: '', propertyFromCache: false };

    const cached = await getCachedParcelGeocode(db, id);
    if (cached) {
        return {
            siteAddress: cached.siteAddress,
            zipCode: cached.zipCode,
            propertyFromCache: true,
        };
    }

    const info = (await fetchGismoJson(`getPropertyInfo?parcel=${encodeURIComponent(id)}`)) as {
        SiteAddress?: unknown;
        ZipCode?: unknown;
    } | null;
    const siteAddress = normalizeParcelSiteAddress(info && info.SiteAddress);
    const zipCode = String((info && info.ZipCode) || '').trim();
    if (siteAddress) {
        await upsertCachedParcelGeocode(db, { parcelId: id, siteAddress, zipCode });
    }
    return { siteAddress, zipCode, propertyFromCache: false };
}

/**
 * Combined parcel lookup: PointToParcel + getPropertyInfo (property skipped when D1 cache hits).
 * One client request per map right-click. Provider: Clark County GISMO (NV).
 */
geocoding.get('/parcel/lookup', rateLimitParcelLookup, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes');
    try {
        const db = getDatabase();
        const x = req.query.x;
        const y = req.query.y;
        const wkid = req.query.wkid || '102707';
        if (x == null || x === '' || y == null || y === '') {
            return res.status(400).json({ error: 'x and y are required' });
        }
        const pointData = await fetchGismoJson(
            `PointToParcel?method=gismo&xcoordinate=${encodeURIComponent(String(x))}&ycoordinate=${encodeURIComponent(String(y))}&returnGeometry=true&wkid=${encodeURIComponent(String(wkid))}`,
        );
        const { parcelId, error: pointError } = resolveParcelIdFromPoint(pointData);
        const parcelGeometry = parseParcelGeometryFromPoint(pointData);
        if (pointError) {
            return res.json({
                parcelId: parcelId || '',
                error: pointError,
                siteAddress: '',
                zipCode: '',
                propertyFromCache: false,
                parcelGeometry,
            });
        }

        const property = await fetchParcelProperty(db, parcelId);

        return res.json({
            parcelId,
            error: null,
            siteAddress: property.siteAddress || '',
            zipCode: property.zipCode || '',
            propertyFromCache: property.propertyFromCache,
            parcelGeometry,
        });
    } catch (error) {
        console.error('Error in parcel lookup:', error);
        const msg = error.name === 'AbortError' ? 'Parcel lookup timed out' : error.message;
        return res.status(502).json({ error: 'Failed to look up parcel', details: msg });
    }
});

/** PointToParcel proxy (state plane x/y → parcel id). */
geocoding.get('/parcel/point', rateLimitParcelLookup, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes');
    try {
        const x = req.query.x;
        const y = req.query.y;
        const wkid = req.query.wkid || '102707';
        if (x == null || x === '' || y == null || y === '') {
            return res.status(400).json({ error: 'x and y are required' });
        }
        const data = await fetchGismoJson(
            `PointToParcel?method=gismo&xcoordinate=${encodeURIComponent(String(x))}&ycoordinate=${encodeURIComponent(String(y))}&returnGeometry=false&wkid=${encodeURIComponent(String(wkid))}`,
        );
        return res.json(data);
    } catch (error) {
        console.error('Error proxying PointToParcel:', error);
        const msg = error.name === 'AbortError' ? 'Parcel lookup timed out' : error.message;
        return res.status(502).json({ error: 'Failed to look up parcel', details: msg });
    }
});

/** getPropertyInfo proxy (parcel id → situs address). Uses D1 cache when available. */
geocoding.get('/parcel/property', rateLimitParcelLookup, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes');
    try {
        const parcel = req.query.parcel;
        if (parcel == null || String(parcel).trim() === '') {
            return res.status(400).json({ error: 'parcel is required' });
        }
        const db = getDatabase();
        const property = await fetchParcelProperty(db, String(parcel).trim());
        return res.json({
            SiteAddress: property.siteAddress || '',
            ZipCode: property.zipCode || '',
            fromCache: property.propertyFromCache,
        });
    } catch (error) {
        console.error('Error proxying getPropertyInfo:', error);
        const msg = error.name === 'AbortError' ? 'Property lookup timed out' : error.message;
        return res.status(502).json({ error: 'Failed to look up property', details: msg });
    }
});

/** Clark County ArcGIS forward geocode (address / intersection → state plane point). */
geocoding.get('/address/search', rateLimitParcelLookup, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes');
    try {
        const singleLine = req.query.singleLine != null ? String(req.query.singleLine).trim() : '';
        const q = req.query.q != null ? String(req.query.q).trim() : '';
        const query = singleLine || q;
        if (!query) {
            return res.status(400).json({ error: 'singleLine or q is required' });
        }
        const maxLocations = Math.min(
            10,
            Math.max(1, parseInt(String(req.query.maxLocations || '5'), 10) || 5),
        );
        const url =
            `${CLARK_ARCGIS_GEOCODE_URL}?Street=&SingleLine=${encodeURIComponent(query)}` +
            `&outFields=&maxLocations=${encodeURIComponent(String(maxLocations))}` +
            '&matchOutOfRange=true&f=json';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
            response = await fetch(url, {
                headers: { Accept: 'application/json', 'User-Agent': 'ExcavatorManagement/1.0' },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!response.ok) {
            throw new Error(`ArcGIS geocode failed: ${response.status} ${response.statusText}`);
        }
        const raw = await response.text();
        if (!raw || !raw.trim()) {
            throw new Error('ArcGIS geocode returned an empty body');
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error('ArcGIS geocode returned invalid JSON');
        }
        if (data && data.error) {
            const code = data.error.code != null ? String(data.error.code) : '';
            const message = data.error.message ? String(data.error.message) : 'ArcGIS geocode error';
            throw new Error(`ArcGIS geocode failed: ${code} ${message}`.trim());
        }
        return res.json(data);
    } catch (error) {
        console.error('Error proxying Clark County address search:', error);
        const msg = error.name === 'AbortError' ? 'Address search timed out' : error.message;
        return res.status(502).json({ error: 'Failed to search addresses', details: msg });
    }
});

/** USDA RUCA-based line-length cap hint for create-ticket map drawing (Nevada tracts). */
geocoding.get('/rural-class', rateLimitRuralClass, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes');
    try {
        const lat = parseFloat(String(req.query.lat ?? ''));
        const lng = parseFloat(String(req.query.lng ?? ''));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ error: 'lat and lng are required' });
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return res.status(400).json({ error: 'lat and lng out of range' });
        }
        const payload = await resolveRuralClassForLatLng(lat, lng);
        return res.json(payload);
    } catch (error) {
        console.error('Error in rural-class lookup:', error);
        const msg = error && error.message ? String(error.message) : String(error);
        return res.status(502).json({ error: 'Failed rural classification lookup', details: msg });
    }
});

export { geocoding };

