// Measure tool module

// Measure state
let measureMode = false;
let measurePoints = [];
let measureLayer = null;
let measureInfo = null;
/** True after user closed shape by clicking near the first point (≥3 vertices). */
let measureClosedAsPolygon = false;

const MEASURE_CLOSE_PIXEL_THRESHOLD = 18;

const FEET_PER_METER = 3.28084;
const SQ_FEET_PER_SQ_METER = 10.7639;
const FEET_PER_MILE = 5280;
const METERS_PER_KM = 1000;
const SQ_FEET_PER_ACRE = 43560;
const SQ_METERS_PER_HECTARE = 10000;
const SQ_METERS_PER_SQ_KM = 1_000_000;

function getMeasureUnits() {
    const preferred =
        window.preferredUnits ||
        (typeof window.getUserProfile === 'function' ? window.getUserProfile().units : null);
    return preferred === 'metric' ? 'metric' : 'imperial';
}

function formatMeasureNumber(value, maxDecimals = 2) {
    if (!Number.isFinite(value)) return '0';
    const abs = Math.abs(value);
    const decimals =
        abs >= 100 ? 0 : abs >= 10 ? 1 : Math.min(maxDecimals, abs >= 1 ? 1 : 2);
    return value.toFixed(decimals);
}

/** Format geodesic length using profile units; auto ft→mi and m→km. */
function formatMeasureLength(meters) {
    if (getMeasureUnits() === 'metric') {
        if (meters >= METERS_PER_KM) {
            return `${formatMeasureNumber(meters / METERS_PER_KM)} km`;
        }
        return `${formatMeasureNumber(meters)} m`;
    }
    const feet = meters * FEET_PER_METER;
    if (feet >= FEET_PER_MILE) {
        return `${formatMeasureNumber(feet / FEET_PER_MILE)} mi`;
    }
    return `${formatMeasureNumber(feet)} ft`;
}

/** Format GPS horizontal accuracy (always in meters from the device) using profile units. */
function formatGpsAccuracyMeters(meters) {
    if (!Number.isFinite(meters) || meters <= 0) return '';
    return `\u00B1${formatMeasureLength(meters)}`;
}

/** Format planar area using profile units; auto sq ft→acres and m²→ha/km². */
function formatMeasureArea(sqMeters) {
    if (getMeasureUnits() === 'metric') {
        if (sqMeters >= SQ_METERS_PER_SQ_KM) {
            return `${formatMeasureNumber(sqMeters / SQ_METERS_PER_SQ_KM)} km²`;
        }
        if (sqMeters >= SQ_METERS_PER_HECTARE) {
            return `${formatMeasureNumber(sqMeters / SQ_METERS_PER_HECTARE)} ha`;
        }
        return `${formatMeasureNumber(sqMeters)} m²`;
    }
    const sqFeet = sqMeters * SQ_FEET_PER_SQ_METER;
    if (sqFeet >= SQ_FEET_PER_ACRE) {
        return `${formatMeasureNumber(sqFeet / SQ_FEET_PER_ACRE)} acres`;
    }
    return `${formatMeasureNumber(sqFeet, 0)} sq ft`;
}

function clickNearFirstPoint(map, clickLatLng, firstLatLng) {
    const a = map.latLngToLayerPoint(clickLatLng);
    const b = map.latLngToLayerPoint(firstLatLng);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy) <= MEASURE_CLOSE_PIXEL_THRESHOLD;
}

/** Planar shoelace in local meters from ref corner; adequate for site-scale polygons. */
function polygonAreaSqMeters(map, latlngs) {
    if (latlngs.length < 3) return 0;
    const ref = latlngs[0];
    const xy = latlngs.map((p) => {
        const x =
            map.distance(L.latLng(ref.lat, ref.lng), L.latLng(ref.lat, p.lng)) *
            (p.lng >= ref.lng ? 1 : -1);
        const y =
            map.distance(L.latLng(ref.lat, ref.lng), L.latLng(p.lat, ref.lng)) *
            (p.lat >= ref.lat ? 1 : -1);
        return { x, y };
    });
    let sum = 0;
    const n = xy.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        sum += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
    }
    return Math.abs(sum / 2);
}

function polygonPerimeterMeters(map, latlngs) {
    if (latlngs.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < latlngs.length; i++) {
        const j = (i + 1) % latlngs.length;
        total += map.distance(latlngs[i], latlngs[j]);
    }
    return total;
}

// Measure handlers
let measureClickHandler = null;
let measureKeyHandler = null;

function syncTicketLayersAfterMeasureChange() {
    if (window.ticketsModule && window.ticketsModule.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
}

// Toggle measure mode
function toggleMeasureMode() {
    if (measureMode) {
        cancelMeasureMode();
    } else {
        // Cancel drawing mode if active (annotations export may be missing; drawing module is canonical)
        if (window.annotationsModule && window.annotationsModule.cancelDrawingMode) {
            window.annotationsModule.cancelDrawingMode();
        }
        if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
            window.drawingModule.cancelDrawingMode();
        }
        measureMode = true;
        measurePoints = [];
        measureClosedAsPolygon = false;
        if (window.annotationsModule && window.annotationsModule.updateDrawingButtons) {
            window.annotationsModule.updateDrawingButtons();
        }
        setupMeasureHandlers();
        updateMeasureDisplay();
        syncTicketLayersAfterMeasureChange();
    }
}

// Cancel measure mode
function cancelMeasureMode() {
    measureMode = false;
    measurePoints = [];
    measureClosedAsPolygon = false;
    const map = window.map;
    if (measureLayer && map) {
        map.removeLayer(measureLayer);
        measureLayer = null;
    }
    measureInfo = null;
    if (window.annotationsModule && window.annotationsModule.updateDrawingButtons) {
        window.annotationsModule.updateDrawingButtons();
    }
    updateMeasureDisplay();
    removeMeasureHandlers();
    syncTicketLayersAfterMeasureChange();
}

function redrawMeasureLayers(map) {
    if (!measureLayer) {
        measureLayer = L.layerGroup().addTo(map);
    }
    measureLayer.clearLayers();

    measurePoints.forEach((point) => {
        const marker = L.marker(point, {
            icon: L.divIcon({
                className: 'measure-marker',
                html: '<div style="background-color: #facc15; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.5);"></div>',
                iconSize: [12, 12],
                iconAnchor: [6, 6],
            }),
        });
        measureLayer.addLayer(marker);
    });

    if (measureClosedAsPolygon && measurePoints.length >= 3) {
        const ring = measurePoints.map((p) => [p.lat, p.lng]);
        const poly = L.polygon(ring, {
            color: '#facc15',
            weight: 3,
            dashArray: '4 4',
            fillColor: '#facc15',
            fillOpacity: 0.2,
        });
        measureLayer.addLayer(poly);
        const perimeterM = polygonPerimeterMeters(map, measurePoints);
        const areaM2 = polygonAreaSqMeters(map, measurePoints);
        measureInfo = {
            type: 'polygon',
            points: measurePoints.length,
            distanceMeters: perimeterM,
            distanceFeet: perimeterM * FEET_PER_METER,
            areaSqMeters: areaM2,
            areaSqFeet: areaM2 * SQ_FEET_PER_SQ_METER,
        };
    } else if (measurePoints.length >= 2) {
        const line = L.polyline(
            measurePoints.map((p) => [p.lat, p.lng]),
            {
                color: '#facc15',
                weight: 3,
                dashArray: '4 4',
            }
        );
        measureLayer.addLayer(line);
        let totalDistance = 0;
        for (let i = 1; i < measurePoints.length; i++) {
            totalDistance += map.distance(measurePoints[i - 1], measurePoints[i]);
        }
        measureInfo = {
            type: 'line',
            points: measurePoints.length,
            distanceMeters: totalDistance,
            distanceFeet: totalDistance * FEET_PER_METER,
        };
    } else {
        measureInfo = {
            type: 'line',
            points: measurePoints.length,
            distanceMeters: 0,
            distanceFeet: 0,
        };
    }
}

// Setup measure handlers
function setupMeasureHandlers() {
    const map = window.map;
    if (!map) return;

    measureClickHandler = function (e) {
        L.DomEvent.stopPropagation(e);

        if (measureClosedAsPolygon && measureInfo && measureInfo.type === 'polygon') {
            measurePoints = [e.latlng];
            measureClosedAsPolygon = false;
            redrawMeasureLayers(map);
            updateMeasureDisplay();
            return;
        }

        if (measurePoints.length >= 3 && !measureClosedAsPolygon) {
            if (clickNearFirstPoint(map, e.latlng, measurePoints[0])) {
                measureClosedAsPolygon = true;
                redrawMeasureLayers(map);
                updateMeasureDisplay();
                return;
            }
        }

        measurePoints.push(e.latlng);
        measureClosedAsPolygon = false;
        redrawMeasureLayers(map);
        updateMeasureDisplay();
    };
    
    map.on('click', measureClickHandler);
    
    measureKeyHandler = function(e) {
        if (e.key === 'Escape') {
            cancelMeasureMode();
        }
    };
    
    window.addEventListener('keydown', measureKeyHandler);
}

// Remove measure handlers
function removeMeasureHandlers() {
    const map = window.map;
    if (map && measureClickHandler) {
        map.off('click', measureClickHandler);
        measureClickHandler = null;
    }
    if (measureKeyHandler) {
        window.removeEventListener('keydown', measureKeyHandler);
        measureKeyHandler = null;
    }
}

// Update measure display
function updateMeasureDisplay() {
    const measureDisplay = document.getElementById('measureDisplay');
    if (!measureDisplay) return;
    
    // Only show if measure mode is active
    if (measureMode) {
        if (measureInfo) {
            let text = `Measure mode • ${measureInfo.points} point${measureInfo.points === 1 ? '' : 's'}`;
            if (measureInfo.type === 'polygon' && measureInfo.points >= 3) {
                text += ` • Polygon perimeter ${formatMeasureLength(measureInfo.distanceMeters)}`;
                text += ` • Area ${formatMeasureArea(measureInfo.areaSqMeters)}`;
            } else if (measureInfo.points >= 2) {
                text += ` • Length ${formatMeasureLength(measureInfo.distanceMeters)}`;
                if (measureInfo.type === 'line' && measurePoints.length >= 3 && !measureClosedAsPolygon) {
                    text += ' • Click first point to close polygon';
                }
            }
            measureDisplay.textContent = text;
        } else {
            measureDisplay.textContent = 'Measure mode • Click on map to start measuring';
        }
        measureDisplay.style.display = 'block';
    } else {
        // Always hide when measure mode is not active
        measureDisplay.style.display = 'none';
        measureDisplay.textContent = '';
    }
}

// Make functions globally available
window.toggleMeasureMode = toggleMeasureMode;
window.cancelMeasureMode = cancelMeasureMode;

// Export for use in other modules - use getter to always return current value
Object.defineProperty(window, 'measureMode', {
    get: function() { return measureMode; },
    configurable: true
});

window.measureModule = {
    get measureMode() { return measureMode; },
    toggleMeasureMode,
    cancelMeasureMode,
    updateMeasureDisplay,
    getMeasureUnits,
    formatMeasureLength,
    formatGpsAccuracyMeters,
    formatMeasureArea,
};

