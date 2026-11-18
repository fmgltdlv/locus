/**
 * Map preview for failed submit-job items (ticket highlight or WKT polygon).
 */
(function (global) {
    'use strict';

    let previewGroup = null;

    function getMap() {
        return global.map || null;
    }

    function ensureGroup() {
        const map = getMap();
        if (!map || typeof L === 'undefined') return null;
        if (!previewGroup) {
            previewGroup = L.featureGroup();
            previewGroup.addTo(map);
        } else if (!map.hasLayer(previewGroup)) {
            previewGroup.addTo(map);
        }
        return previewGroup;
    }

    function parsePolygonWkt(wkt) {
        if (!wkt || typeof wkt !== 'string') return null;
        const m = wkt.trim().match(/^POLYGON\s*\(\((.+)\)\)$/i);
        if (!m) return null;
        const latlngs = [];
        m[1].split(',').forEach(function (pair) {
            const parts = pair.trim().split(/\s+/);
            if (parts.length < 2) return;
            const lng = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            latlngs.push([lat, lng]);
        });
        return latlngs.length >= 3 ? latlngs : null;
    }

    function findTicketByNumber(ticketNumber) {
        if (ticketNumber == null || String(ticketNumber).trim() === '') return null;
        const tn = String(ticketNumber).trim();
        const pools = [
            global.HUB_EXPIRED_TICKETS,
            global.HUB_COMBINED_TICKETS,
            global.HUB_ACTIVE_TICKETS,
            global.ORG_TICKETS,
        ];
        for (let i = 0; i < pools.length; i++) {
            const list = pools[i];
            if (!Array.isArray(list)) continue;
            const found = list.find(function (t) {
                return t && String(t.ticketNumber).trim() === tn;
            });
            if (found) return found;
        }
        return null;
    }

    function clearPreview() {
        if (previewGroup) {
            previewGroup.clearLayers();
            const map = getMap();
            if (map && map.hasLayer(previewGroup)) {
                map.removeLayer(previewGroup);
            }
            previewGroup = null;
        }
    }

    function setSelectedItems(items) {
        clearPreview();
        if (!Array.isArray(items) || !items.length) return;

        const map = getMap();
        if (!map || typeof L === 'undefined') return;

        const group = ensureGroup();
        if (!group) return;

        const bounds = [];
        let lastTicketId = null;

        items.forEach(function (item) {
            const mp = item && item.mapPreview;
            if (!mp) return;

            if (mp.kind === 'ticket' && mp.ticketNumber) {
                const ticket = findTicketByNumber(mp.ticketNumber);
                if (ticket && ticket.id != null) lastTicketId = ticket.id;
                return;
            }

            if (mp.kind === 'wkt' && mp.wkt) {
                const latlngs = parsePolygonWkt(mp.wkt);
                if (latlngs) {
                    const poly = L.polygon(latlngs, {
                        color: '#dc2626',
                        weight: 2,
                        fillColor: '#dc2626',
                        fillOpacity: 0.15,
                        dashArray: '6 4',
                    });
                    group.addLayer(poly);
                    try {
                        bounds.push(poly.getBounds());
                    } catch (_) {
                        /* ignore */
                    }
                } else if (mp.ticketNumber) {
                    const ticket = findTicketByNumber(mp.ticketNumber);
                    if (ticket && ticket.id != null) lastTicketId = ticket.id;
                }
            }
        });

        if (bounds.length) {
            try {
                const combined = bounds[0];
                for (let i = 1; i < bounds.length; i++) combined.extend(bounds[i]);
                map.fitBounds(combined, { padding: [40, 40], maxZoom: 17 });
            } catch (_) {
                /* ignore */
            }
        }

        if (lastTicketId != null && typeof global.selectTicket === 'function') {
            global.selectTicket(lastTicketId);
        }
    }

    global.submitFailureMapPreview = {
        clearPreview: clearPreview,
        setSelectedItems: setSelectedItems,
    };
})(typeof window !== 'undefined' ? window : globalThis);
