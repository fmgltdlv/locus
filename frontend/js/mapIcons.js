// Lucide stroke icons for map UI (assets/icons/map/) and account menu (assets/icons/app/).

(function () {
    'use strict';

    const DEFAULT_SIZE = 18;
    const TOOLBAR_SIZE = 20;

    function svgInner(size, inner) {
        return (
            '<svg width="' +
            size +
            '" height="' +
            size +
            '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            inner +
            '</svg>'
        );
    }

    function svgFilled16(size, inner) {
        return (
            '<svg width="' +
            size +
            '" height="' +
            size +
            '" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">' +
            inner +
            '</svg>'
        );
    }

    const TICKET_MAP_PIN_COLORS = {
        READY: 'var(--app-success)',
        NOT_READY: 'var(--app-danger)',
        ACTION_REQUIRED: '#facc15',
        EXPIRING_SOON: '#f59e0b',
        EXPIRED: '#6b7280',
        CANCELLED: '#6b7280',
    };

    function normalizeTicketMapPinStatus(status) {
        const raw = status == null ? '' : String(status).trim();
        if (!raw) return 'READY';
        if (raw === 'REVIEW REQUIRED' || raw.toUpperCase() === 'REVIEW REQUIRED') return 'ACTION_REQUIRED';
        const normalized = raw.toUpperCase().replace(/\s+/g, '_');
        if (Object.prototype.hasOwnProperty.call(TICKET_MAP_PIN_COLORS, normalized)) return normalized;
        return 'READY';
    }

    function ticketMapPinColor(status) {
        return TICKET_MAP_PIN_COLORS[normalizeTicketMapPinStatus(status)] || '#888888';
    }

    function ticketMapPinSvg(status, size) {
        const pinSize = size == null ? DEFAULT_SIZE : size;
        const key = normalizeTicketMapPinStatus(status);
        switch (key) {
            case 'NOT_READY':
                return svgFilled16(
                    pinSize,
                    '<path d="M5.15 1h5.7L15 5.15v5.7L10.85 15h-5.7L1 10.85v-5.7L5.15 1z"/>'
                );
            case 'ACTION_REQUIRED':
                return svgFilled16(
                    pinSize,
                    '<path d="M8 1.15L15.25 14.1H.75L8 1.15z"/>' +
                        '<rect x="7.25" y="5.85" width="1.5" height="4.15" rx="0.35" fill="#111827"/>' +
                        '<circle cx="8" cy="12.15" r="0.95" fill="#111827"/>'
                );
            case 'EXPIRING_SOON':
                return svgInner(
                    pinSize,
                    '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>'
                );
            case 'EXPIRED':
            case 'CANCELLED':
                return svgInner(
                    pinSize,
                    '<path d="M6 2h12"></path><path d="M6 22h12"></path>' +
                        '<path d="M8 2v5.2c0 1.24.63 2.39 1.67 3.05L12 12l2.33-1.75c1.04-.66 1.67-1.81 1.67-3.05V2"></path>' +
                        '<path d="M8 22v-5.2c0-1.24.63-2.39 1.67-3.05L12 12l2.33 1.75c1.04.66 1.67 1.81 1.67 3.05V22"></path>' +
                        '<path fill="currentColor" stroke="none" d="M9.75 15.75h4.5V22h-4.5z"></path>'
                );
            case 'READY':
            default:
                return svgInner(
                    pinSize,
                    '<path d="M7 10v12"></path>' +
                        '<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>'
                );
        }
    }

    function buildTicketMapPinMarkerHtml(status, size, borderStyle) {
        const color = ticketMapPinColor(status);
        const border = borderStyle || '1.5px solid rgba(0,0,0,0.25)';
        return (
            '<div class="ticket-811-marker-icon" style="color:' +
            color +
            ';border:' +
            border +
            ';">' +
            ticketMapPinSvg(status, size) +
            '</div>'
        );
    }

    const EVENT_DAMAGE_MARKER_WIDTH = 42;
    const EVENT_DAMAGE_MARKER_HEIGHT = 52;

    function eventDamageMarkerSvg(width, height) {
        const w = width == null ? EVENT_DAMAGE_MARKER_WIDTH : width;
        const h = height == null ? EVENT_DAMAGE_MARKER_HEIGHT : height;
        return (
            '<svg width="' +
            w +
            '" height="' +
            h +
            '" viewBox="0 0 32 40" aria-hidden="true" focusable="false">' +
            '<path fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" d="M16 37.5S5 22.5 5 14a11 11 0 1 1 22 0c0 8.5-11 23.5-11 23.5z"></path>' +
            '<g fill="#fff">' +
            '<rect x="4.25" y="10.5" width="9.25" height="7" rx="3.5"></rect>' +
            '<rect x="18.5" y="10.5" width="9.25" height="7" rx="3.5"></rect>' +
            '<circle cx="13.5" cy="20.75" r="1.2"></circle>' +
            '<circle cx="16.25" cy="22.15" r="1"></circle>' +
            '<circle cx="18.75" cy="20.85" r="0.85"></circle>' +
            '</g>' +
            '<rect x="12.5" y="12.25" width="2" height="3.5" rx="0.45" fill="currentColor"></rect>' +
            '<rect x="17.5" y="12.25" width="2" height="3.5" rx="0.45" fill="currentColor"></rect>' +
            '<path fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M13.1 9.75 L15.85 14 L13.1 18.25"></path>' +
            '<path fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M18.9 9.75 L16.15 14 L18.9 18.25"></path>' +
            '</svg>'
        );
    }

    function buildEventDamageMarkerHtml(size) {
        const w = size == null ? EVENT_DAMAGE_MARKER_WIDTH : size;
        const h = Math.round((w * EVENT_DAMAGE_MARKER_HEIGHT) / EVENT_DAMAGE_MARKER_WIDTH);
        return (
            '<div class="event-damage-marker-icon" style="color:var(--app-danger);width:' +
            w +
            'px;height:' +
            h +
            'px;">' +
            eventDamageMarkerSvg(w, h) +
            '</div>'
        );
    }

    function buildEventMapDivIconOptions(size) {
        const w = size == null ? EVENT_DAMAGE_MARKER_WIDTH : size;
        const h = Math.round((w * EVENT_DAMAGE_MARKER_HEIGHT) / EVENT_DAMAGE_MARKER_WIDTH);
        return {
            className: 'event-marker event-damage-marker',
            html: buildEventDamageMarkerHtml(w),
            iconSize: [w, h],
            iconAnchor: [w / 2, h],
        };
    }

    const ICONS = {
        ticketHub:
            '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path>' +
            '<path d="M13 5v2"></path>' +
            '<path d="M13 17v2"></path>' +
            '<path d="M13 11v2"></path>',
        createTicket:
            '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path>' +
            '<path d="M9 12h6"></path>' +
            '<path d="M12 9v6"></path>',
        location:
            '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path>' +
            '<circle cx="12" cy="10" r="3"></circle>',
        locationOff:
            '<path d="M12.34 12.34 16 16"></path>' +
            '<path d="M18.5 10.5c1.33-1.01 2.56-2.32 2.57-3.83"></path>' +
            '<path d="M2 2 20 20"></path>' +
            '<path d="M9.5 9.5 3.59 3.59"></path>' +
            '<path d="M12.34 2.34a9 9 0 0 1 7.67 7.67"></path>',
        mapLayers:
            '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path>' +
            '<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"></path>' +
            '<path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"></path>',
        mapPoint: '<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="1"></circle>',
        mapLine: '<path d="M5 12h14"></path>',
        mapPolygon:
            '<path d="M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z"></path>',
        measure:
            '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"></path>' +
            '<path d="m14.5 12.5 2-2"></path>' +
            '<path d="m11.5 9.5 2-2"></path>' +
            '<path d="m8.5 6.5 2-2"></path>' +
            '<path d="m17.5 15.5 2-2"></path>',
        camera:
            '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>' +
            '<circle cx="12" cy="13" r="3"></circle>',
        document:
            '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path>' +
            '<path d="M14 2v4a2 2 0 0 0 2 2h4"></path>' +
            '<path d="M10 9H8"></path>' +
            '<path d="M16 13H8"></path>' +
            '<path d="M16 17H8"></path>',
        upload:
            '<path d="M12 3v12"></path>' +
            '<path d="m17 8-5-5-5 5"></path>' +
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>',
        reportEvent:
            '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path>' +
            '<path d="M12 9v4"></path>' +
            '<path d="M12 17h.01"></path>',
        requestServices:
            '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>',
        dataHub:
            '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>' +
            '<path d="M3 5V19A9 3 0 0 0 21 19V5"></path>' +
            '<path d="M3 12A9 3 0 0 0 21 12"></path>',
        close: '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
        profile:
            '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path>' +
            '<circle cx="12" cy="7" r="4"></circle>',
        settings:
            '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>' +
            '<circle cx="12" cy="12" r="3"></circle>',
        userGuide:
            '<path d="M12 7v14"></path>' +
            '<path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path>',
        about:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<path d="M12 16v-4"></path>' +
            '<path d="M12 8h.01"></path>',
        trash:
            '<path d="M3 6h18"></path>' +
            '<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>' +
            '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>' +
            '<line x1="10" x2="10" y1="11" y2="17"></line>' +
            '<line x1="14" x2="14" y1="11" y2="17"></line>',
        adminPanel:
            '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path>' +
            '<path d="m9 12 2 2 4-4"></path>',
        hammer:
            '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"></path>' +
            '<path d="m18 15 4-4"></path>' +
            '<path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756l-.725.725a6 6 0 0 0 1.756 4.202L15 7h1.172a2 2 0 0 1 1.414.586L19.5 9.5"></path>',
        callBeforeYouDig:
            '<path d="M2 22v-5l5-5 5 5-5 5z"></path>' +
            '<path d="M9.5 14.5 16 8"></path>' +
            '<path d="m17 2 5 5"></path>' +
            '<path d="m14 5 7 12"></path>',
    };

    function icon(name, size) {
        const inner = ICONS[name];
        if (!inner) return '';
        return svgInner(size == null ? DEFAULT_SIZE : size, inner);
    }

    window.mapIcons = {
        DEFAULT_SIZE: DEFAULT_SIZE,
        TOOLBAR_SIZE: TOOLBAR_SIZE,
        icon: icon,
        ticketHub: function (size) {
            return icon('ticketHub', size);
        },
        createTicket: function (size) {
            return icon('createTicket', size);
        },
        location: function (size) {
            return icon('location', size);
        },
        locationOff: function (size) {
            return icon('locationOff', size);
        },
        mapLayers: function (size) {
            return icon('mapLayers', size);
        },
        mapPoint: function (size) {
            return icon('mapPoint', size);
        },
        mapLine: function (size) {
            return icon('mapLine', size);
        },
        mapPolygon: function (size) {
            return icon('mapPolygon', size);
        },
        measure: function (size) {
            return icon('measure', size);
        },
        camera: function (size) {
            return icon('camera', size);
        },
        document: function (size) {
            return icon('document', size);
        },
        upload: function (size) {
            return icon('upload', size);
        },
        reportEvent: function (size) {
            return icon('reportEvent', size);
        },
        requestServices: function (size) {
            return icon('requestServices', size);
        },
        dataHub: function (size) {
            return icon('dataHub', size);
        },
        close: function (size) {
            return icon('close', size);
        },
        profile: function (size) {
            return icon('profile', size);
        },
        settings: function (size) {
            return icon('settings', size);
        },
        userGuide: function (size) {
            return icon('userGuide', size);
        },
        about: function (size) {
            return icon('about', size);
        },
        trash: function (size) {
            return icon('trash', size);
        },
        adminPanel: function (size) {
            return icon('adminPanel', size);
        },
        hammer: function (size) {
            return icon('hammer', size);
        },
        callBeforeYouDig: function (size) {
            return icon('callBeforeYouDig', size);
        },
        normalizeTicketMapPinStatus: normalizeTicketMapPinStatus,
        ticketMapPinColor: ticketMapPinColor,
        ticketMapPin: ticketMapPinSvg,
        buildTicketMapPinMarkerHtml: buildTicketMapPinMarkerHtml,
        EVENT_DAMAGE_MARKER_WIDTH: EVENT_DAMAGE_MARKER_WIDTH,
        EVENT_DAMAGE_MARKER_HEIGHT: EVENT_DAMAGE_MARKER_HEIGHT,
        eventDamageMarker: eventDamageMarkerSvg,
        buildEventDamageMarkerHtml: buildEventDamageMarkerHtml,
        buildEventMapDivIconOptions: buildEventMapDivIconOptions,
        toolbar: function (name) {
            return icon(name, TOOLBAR_SIZE);
        },
    };
})();
