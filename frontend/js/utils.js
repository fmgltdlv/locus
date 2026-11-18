// Shared frontend utilities
(function () {
    'use strict';

    /** Format latitude and longitude to 6 decimal places (e.g. "36.169900, -115.139800") */
    function formatLatLng(lat, lng) {
        const la = Number(lat);
        const lo = Number(lng);
        if (typeof la !== 'number' || typeof lo !== 'number' || isNaN(la) || isNaN(lo)) {
            return '—';
        }
        return la.toFixed(6) + ', ' + lo.toFixed(6);
    }

    /** HTML row for map popup GPS display; returns '' if coords invalid. */
    function buildMapPopupGpsRow(lat, lng) {
        const formatted = formatLatLng(lat, lng);
        if (formatted === '—') return '';
        return (
            '<div class="map-leaflet-popup__meta map-popup-gps-row">' +
            '📍 GPS: <strong class="map-leaflet-popup__mono">' +
            formatted +
            '</strong></div>'
        );
    }

    /** Minimum number of characters before running address search (avoids noisy/expensive requests) */
    var MIN_ADDRESS_QUERY_LENGTH = 3;

    /** Truncate image/photo file names for on-screen labels (Manage Data, map popups, tickets, etc.). */
    function truncateImageNameForDisplay(name) {
        if (name == null) return '';
        var s = String(name);
        return s.length > 10 ? s.slice(0, 10) + '...' : s;
    }

    /** External dashboard URL used by ticket actions. */
    var EXTERNAL_JOBS_DASHBOARD_URL =
        typeof window.EXTERNAL_JOBS_DASHBOARD_URL === 'string' && window.EXTERNAL_JOBS_DASHBOARD_URL.trim() !== ''
            ? window.EXTERNAL_JOBS_DASHBOARD_URL.trim()
            : '/portal/external-dashboard';

    /** Response codes 000 / 999 use external portal handling. */
    function isExternalPortalSpecialOperatorResponseCode(code) {
        if (code == null || code === '') return false;
        if (typeof code === 'number' && isFinite(code)) {
            return code === 0 || code === 999;
        }
        var s = String(code).trim();
        return s === '000' || s === '999';
    }

    function openExternalJobsDashboard() {
        window.open(EXTERNAL_JOBS_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
    }

    /** Nevada USAN nGen web app (enquiryId = nGen job / enquiry id). */
    var USAN_NGEN_WEB_BASE = 'https://onecallnv.undergroundservicealert.org/ngen.web/';

    /** Stable UUID for USAN submit idempotency (one per intended submit). */
    function newIdempotencyKey() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    /**
     * Coerce a stored job/enquiry id to a positive integer string, or null if invalid.
     * @param {*} v
     * @returns {string|null}
     */
    function parseUsanEnquiryIdString(v) {
        if (v == null || v === '') return null;
        var s = String(v).trim();
        if (s === '') return null;
        var n = parseInt(s, 10);
        if (!Number.isFinite(n) || n <= 0) return null;
        return String(n);
    }

    /**
     * Resolve nGen `enquiryId` for the USAN portal URL (ngenJobNumber, providerJobNumber, hub field pickers when loaded).
     * @param {object|undefined|null} ticket
     * @returns {string|null}
     */
    function getUsanEnquiryIdFromTicket(ticket) {
        if (!ticket) return null;
        var c = parseUsanEnquiryIdString(ticket.ngenJobNumber);
        if (c) return c;
        c = parseUsanEnquiryIdString(ticket.providerJobNumber);
        if (c) return c;
        if (window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function') {
            c = parseUsanEnquiryIdString(window.ticketHubDisplayMap.pickTicketField(ticket, 'providerJobNumber'));
            if (c) return c;
        }
        return null;
    }

    /**
     * @param {object|undefined|null} ticket
     * @returns {string} full URL, with `?enquiryId=` when an id is known
     */
    function getUsanNgenEnquiryUrlForTicket(ticket) {
        var id = getUsanEnquiryIdFromTicket(ticket);
        if (id) {
            return USAN_NGEN_WEB_BASE + '?enquiryId=' + encodeURIComponent(id);
        }
        return USAN_NGEN_WEB_BASE;
    }

    /**
     * Open USAN nGen in a new tab — deep link when the ticket has a resolvable enquiry/job id.
     * @param {object|undefined|null} ticket
     */
    function openUsanNgenPortalForTicket(ticket) {
        window.open(getUsanNgenEnquiryUrlForTicket(ticket), '_blank', 'noopener,noreferrer');
    }

    /**
     * Parse a value from the API/DB into a Date. SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" with no
     * timezone; `new Date` would treat that as local. Space-separated datetimes are interpreted as UTC.
     */
    var DISPLAY_TIMEZONE = 'America/Los_Angeles';

    function parseInstantForDisplay(value) {
        if (value == null || value === '') return null;
        if (value instanceof Date) return value;
        var s = String(value).trim();
        if (/Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
            return new Date(s);
        }
        var m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
        if (m) {
            return new Date(m[1] + 'T' + m[2] + 'Z');
        }
        return new Date(s);
    }

    function getPacificTimeSuffix(d) {
        try {
            var parts = Intl.DateTimeFormat('en-US', {
                timeZone: DISPLAY_TIMEZONE,
                timeZoneName: 'short',
            }).formatToParts(d);
            var tz = parts.filter(function (p) {
                return p.type === 'timeZoneName';
            })[0];
            return tz && tz.value ? ' ' + tz.value : ' PST';
        } catch (_e) {
            return ' PST';
        }
    }

    /**
     * EXIF DateTimeOriginal has no timezone — show wall-clock as Pacific with PST/PDT suffix.
     */
    function formatRecordedExifWallClock(year, month, day, hour, minute) {
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var y = Number(year);
        var mo = Math.max(0, Math.min(11, Number(month) - 1));
        var dNum = Number(day);
        var h = Number(hour);
        var mi = Number(minute);
        if (!Number.isFinite(y) || !Number.isFinite(dNum) || !Number.isFinite(h) || !Number.isFinite(mi)) return '';
        var hour12 = h % 12 || 12;
        var ampm = h >= 12 ? 'PM' : 'AM';
        var anchor = new Date(y, mo, dNum, h, mi);
        return (
            months[mo] +
            ' ' +
            dNum +
            ', ' +
            y +
            ', ' +
            hour12 +
            ':' +
            String(mi).padStart(2, '0') +
            ' ' +
            ampm +
            getPacificTimeSuffix(anchor)
        );
    }

    /**
     * Format a UTC instant for display in US Pacific time with a PST/PDT suffix.
     * Use for created/recorded timestamps. Avoids toLocaleDateString() with time fields (wrong API).
     * @param {*} isoOrDate
     * @param {string} [emptyValue] when value is missing/empty (default '—')
     * @param {*} [invalidFallback] when the date is invalid (default same as emptyValue)
     */
    function formatRecordedDateTime(isoOrDate, emptyValue, invalidFallback) {
        var empty = emptyValue != null ? emptyValue : '—';
        if (isoOrDate == null || isoOrDate === '') return empty;
        var d = parseInstantForDisplay(isoOrDate);
        if (d == null || Number.isNaN(d.getTime())) return invalidFallback !== undefined ? invalidFallback : empty;
        var formatted = d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: DISPLAY_TIMEZONE
        });
        return formatted + getPacificTimeSuffix(d);
    }

    /**
     * Date only (no time) for gallery footers and similar.
     */
    function formatRecordedDate(isoOrDate, emptyValue, invalidFallback) {
        var empty = emptyValue != null ? emptyValue : '—';
        if (isoOrDate == null || isoOrDate === '') return empty;
        var d = parseInstantForDisplay(isoOrDate);
        if (d == null || Number.isNaN(d.getTime())) return invalidFallback !== undefined ? invalidFallback : empty;
        return d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: DISPLAY_TIMEZONE
        });
    }

    /** YYYY-MM-DD in America/Los_Angeles for the given instant. */
    function getPacificYmd(date) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: DISPLAY_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date || new Date());
    }

    /** HH:MM (24h) in America/Los_Angeles for the given instant. */
    function getPacificHm(date) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: DISPLAY_TIMEZONE,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date || new Date());
        const h = parts.find(function (p) {
            return p.type === 'hour';
        });
        const m = parts.find(function (p) {
            return p.type === 'minute';
        });
        return (h && m ? h.value + ':' + m.value : '00:00');
    }

    /**
     * UTC ms for a Pacific wall-clock on calendar day `ymd`.
     * Keep in sync with cloudflare/deploy/src/lib/pacificTime.cjs.
     */
    function pacificYmdHmToUtcMs(ymd, hours, minutes, seconds) {
        const parts = String(ymd).split('-').map(function (x) {
            return parseInt(x, 10);
        });
        const y = parts[0];
        const mo = parts[1];
        const d = parts[2];
        const targetH = hours || 0;
        const targetM = minutes || 0;
        const targetS = seconds || 0;
        let ms = Date.UTC(y, mo - 1, d, 12, 0, 0);
        for (let attempt = 0; attempt < 48; attempt++) {
            const wall = new Intl.DateTimeFormat('en-US', {
                timeZone: DISPLAY_TIMEZONE,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
            }).formatToParts(new Date(ms));
            const py = parseInt(
                wall.find(function (p) {
                    return p.type === 'year';
                }).value,
                10
            );
            const pm = parseInt(
                wall.find(function (p) {
                    return p.type === 'month';
                }).value,
                10
            );
            const pd = parseInt(
                wall.find(function (p) {
                    return p.type === 'day';
                }).value,
                10
            );
            const ph = parseInt(
                wall.find(function (p) {
                    return p.type === 'hour';
                }).value,
                10
            );
            const pmin = parseInt(
                wall.find(function (p) {
                    return p.type === 'minute';
                }).value,
                10
            );
            const ps = parseInt(
                wall.find(function (p) {
                    return p.type === 'second';
                }).value,
                10
            );
            if (py === y && pm === mo && pd === d && ph === targetH && pmin === targetM && ps === targetS) {
                return ms;
            }
            const delta = ((targetH - ph) * 3600 + (targetM - pmin) * 60 + (targetS - ps)) * 1000;
            ms += delta;
        }
        return Date.UTC(y, mo - 1, d, targetH + 8, targetM, targetS);
    }

    /** Pacific end-of-day (23:59:59.999) for bare YYYY-MM-DD, as ISO UTC string. */
    function pacificEndOfDayInstantFromYmd(ymd) {
        const ms = pacificYmdHmToUtcMs(ymd, 23, 59, 59);
        return new Date(ms + 999).toISOString();
    }

    function addPacificYmdDays(ymd, days) {
        const p = String(ymd).split('-').map(function (x) {
            return parseInt(x, 10);
        });
        const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
        t.setUTCDate(t.getUTCDate() + days);
        const yy = t.getUTCFullYear();
        const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(t.getUTCDate()).padStart(2, '0');
        return yy + '-' + mm + '-' + dd;
    }

    /** Signed difference in Pacific calendar days (to - from). */
    function pacificCalendarDayDiff(fromMsOrDate, toMsOrDate) {
        const fromYmd = getPacificYmd(new Date(fromMsOrDate));
        const toYmd = getPacificYmd(new Date(toMsOrDate));
        const fromDay = Date.parse(fromYmd + 'T00:00:00Z');
        const toDay = Date.parse(toYmd + 'T00:00:00Z');
        return Math.round((toDay - fromDay) / (24 * 60 * 60 * 1000));
    }

    window.formatLatLng = formatLatLng;
    window.buildMapPopupGpsRow = buildMapPopupGpsRow;
    window.MIN_ADDRESS_QUERY_LENGTH = MIN_ADDRESS_QUERY_LENGTH;
    window.truncateImageNameForDisplay = truncateImageNameForDisplay;
    window.EXTERNAL_JOBS_DASHBOARD_URL = EXTERNAL_JOBS_DASHBOARD_URL;
    window.isExternalPortalSpecialOperatorResponseCode = isExternalPortalSpecialOperatorResponseCode;
    window.openExternalJobsDashboard = openExternalJobsDashboard;
    window.USAN_NGEN_WEB_BASE = USAN_NGEN_WEB_BASE;
    window.newIdempotencyKey = newIdempotencyKey;
    window.parseUsanEnquiryIdString = parseUsanEnquiryIdString;
    window.getUsanEnquiryIdFromTicket = getUsanEnquiryIdFromTicket;
    window.getUsanNgenEnquiryUrlForTicket = getUsanNgenEnquiryUrlForTicket;
    window.openUsanNgenPortalForTicket = openUsanNgenPortalForTicket;
    window.parseInstantForDisplay = parseInstantForDisplay;
    window.DISPLAY_TIMEZONE = DISPLAY_TIMEZONE;
    window.getPacificTimeSuffix = getPacificTimeSuffix;
    window.formatRecordedExifWallClock = formatRecordedExifWallClock;
    window.formatRecordedDateTime = formatRecordedDateTime;
    window.formatRecordedDate = formatRecordedDate;
    window.getPacificYmd = getPacificYmd;
    window.getPacificHm = getPacificHm;
    window.pacificYmdHmToUtcMs = pacificYmdHmToUtcMs;
    window.pacificEndOfDayInstantFromYmd = pacificEndOfDayInstantFromYmd;
    window.addPacificYmdDays = addPacificYmdDays;
    window.pacificCalendarDayDiff = pacificCalendarDayDiff;

    /**
     * Themed checkbox markup (Manage Data, Ticket Hub bulk select).
     * @param {string} attrs raw attributes for the input (without type/class)
     * @param {{ wrapperClass?: string, inputClass?: string }} [opts]
     */
    function appCheckboxHtml(attrs, opts) {
        opts = opts || {};
        var wrapperClass = 'app-checkbox' + (opts.wrapperClass ? ' ' + opts.wrapperClass : '');
        var attrStr = String(attrs || '').trim();
        var extraClass = '';
        var classMatch = attrStr.match(/\bclass="([^"]*)"/);
        if (classMatch) {
            extraClass = classMatch[1].replace(/\bapp-checkbox-input\b/g, '').trim();
            attrStr = attrStr.replace(/\s*\bclass="[^"]*"/, '').trim();
        }
        var inputClass = 'app-checkbox-input';
        if (opts.inputClass) inputClass += ' ' + opts.inputClass;
        if (extraClass) inputClass += ' ' + extraClass;
        return (
            '<label class="' +
            wrapperClass +
            '">' +
            '<input type="checkbox" class="' +
            inputClass +
            '"' +
            (attrStr ? ' ' + attrStr : '') +
            ' />' +
            '<span class="app-checkbox-box" aria-hidden="true"></span></label>'
        );
    }

    window.appCheckboxHtml = appCheckboxHtml;
})();
