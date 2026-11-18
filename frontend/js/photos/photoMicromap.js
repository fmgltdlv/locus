// Shared Leaflet micromap: position dot, optional heading arrow, optional accuracy ring.

const PHOTO_MICROMAP_ZOOM = 17;

function photoMicromapGetMarkerHtml(headingDeg) {
    const rot = headingDeg != null && isFinite(headingDeg) ? String(Math.round(headingDeg)) : '0';
    const arrowHidden =
        headingDeg == null || !isFinite(headingDeg) ? ' in-page-camera-micromap-arrow--hidden' : '';
    return (
        '<div class="in-page-camera-micromap-marker">' +
        '<span class="in-page-camera-micromap-arrow' +
        arrowHidden +
        '" style="transform: rotate(' +
        rot +
        'deg)"></span>' +
        '<span class="in-page-camera-micromap-dot"></span>' +
        '</div>'
    );
}

function photoMicromapGetDivIcon(headingDeg) {
    return L.divIcon({
        className: 'in-page-camera-micromap-marker-wrapper',
        html: photoMicromapGetMarkerHtml(headingDeg),
        iconSize: [32, 32],
        iconAnchor: [16, 16],
    });
}

function photoMicromapInvalidateSize(map) {
    if (!map) return;
    try {
        map.invalidateSize({ animate: false });
    } catch (_) {
        /* ignore */
    }
}

function photoMicromapScheduleInvalidateSize(map) {
    if (!map) return;
    requestAnimationFrame(function () {
        photoMicromapInvalidateSize(map);
        requestAnimationFrame(function () {
            photoMicromapInvalidateSize(map);
        });
    });
    setTimeout(function () {
        photoMicromapInvalidateSize(map);
    }, 120);
    setTimeout(function () {
        photoMicromapInvalidateSize(map);
    }, 400);
}

/**
 * @param {HTMLElement} mapContainerEl
 * @param {{ lat: number, lng: number, heading?: number|null, accuracy?: number|null }} fix
 * @returns {{ map: object, marker: object|null, accuracyCircle: object|null, update: Function, invalidateSize: Function, destroy: Function }|null}
 */
function photoMicromapCreate(mapContainerEl, fix) {
    if (!mapContainerEl || typeof L === 'undefined') return null;

    const lat = fix && Number(fix.lat);
    const lng = fix && Number(fix.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    mapContainerEl.innerHTML = '';

    const map = L.map(mapContainerEl, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        touchZoom: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        tap: false,
        zoomSnap: 0.25,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        updateWhenIdle: true,
        updateWhenZooming: false,
    }).addTo(map);

    const state = {
        map: map,
        marker: null,
        accuracyCircle: null,
    };

    function applyFix(nextFix) {
        if (!state.map || !nextFix) return;
        const nlat = Number(nextFix.lat);
        const nlng = Number(nextFix.lng);
        if (!Number.isFinite(nlat) || !Number.isFinite(nlng)) return;

        const latlng = L.latLng(nlat, nlng);
        const heading = nextFix.heading;
        const acc = nextFix.accuracy;

        if (state.accuracyCircle) {
            state.map.removeLayer(state.accuracyCircle);
            state.accuracyCircle = null;
        }
        if (typeof acc === 'number' && acc > 0 && isFinite(acc)) {
            state.accuracyCircle = L.circle(latlng, {
                radius: acc,
                color: 'var(--app-success)',
                fillColor: 'var(--app-success)',
                fillOpacity: 0.15,
                weight: 1,
                opacity: 0.5,
            }).addTo(state.map);
        }

        if (state.marker) {
            state.marker.setLatLng(latlng);
            state.marker.setIcon(photoMicromapGetDivIcon(heading));
        } else {
            state.marker = L.marker(latlng, {
                icon: photoMicromapGetDivIcon(heading),
                interactive: false,
                zIndexOffset: 500,
            }).addTo(state.map);
        }

        state.map.setView(latlng, PHOTO_MICROMAP_ZOOM, { animate: false });
    }

    applyFix(fix);
    photoMicromapScheduleInvalidateSize(map);

    return {
        map: state.map,
        marker: state.marker,
        accuracyCircle: state.accuracyCircle,
        update: applyFix,
        invalidateSize: function () {
            photoMicromapInvalidateSize(state.map);
        },
        destroy: function () {
            if (state.map) {
                state.map.remove();
            }
            state.map = null;
            state.marker = null;
            state.accuracyCircle = null;
            mapContainerEl.innerHTML = '';
        },
    };
}

if (typeof window !== 'undefined') {
    window.photoMicromap = {
        ZOOM: PHOTO_MICROMAP_ZOOM,
        getMarkerHtml: photoMicromapGetMarkerHtml,
        getDivIcon: photoMicromapGetDivIcon,
        create: photoMicromapCreate,
        invalidateSize: photoMicromapInvalidateSize,
        scheduleInvalidateSize: photoMicromapScheduleInvalidateSize,
    };
}
