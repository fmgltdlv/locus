/**
 * US Pacific (America/Los_Angeles) helpers for display, filters, and ticket expiry.
 * Keep parseInstantForDisplay in sync with frontend/js/utils.js.
 */
const USAN_TZ = 'America/Los_Angeles';

/**
 * Parse a value from the API/DB into a Date. SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" with no
 * timezone; `new Date` would treat that as local. Space-separated datetimes are interpreted as UTC.
 * @param {*} value
 * @returns {Date|null}
 */
function parseInstantForDisplay(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return value;
    const s = String(value).trim();
    if (/Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
        return new Date(s);
    }
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
    if (m) {
        return new Date(`${m[1]}T${m[2]}Z`);
    }
    return new Date(s);
}

/** YYYY-MM-DD in America/Los_Angeles for the given instant. */
function pacificYmd(d) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: USAN_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d || new Date());
}

/**
 * UTC ms for a Pacific wall-clock on calendar day `ymd`.
 * @param {string} ymd
 * @param {number} [hours]
 * @param {number} [minutes]
 * @param {number} [seconds]
 */
function pacificYmdHmToUtcMs(ymd, hours, minutes, seconds) {
    const parts = String(ymd).split('-').map((x) => parseInt(x, 10));
    const y = parts[0];
    const mo = parts[1];
    const d = parts[2];
    const targetH = hours || 0;
    const targetM = minutes || 0;
    const targetS = seconds || 0;
    let ms = Date.UTC(y, mo - 1, d, 12, 0, 0);
    for (let attempt = 0; attempt < 48; attempt++) {
        const wall = new Intl.DateTimeFormat('en-US', {
            timeZone: USAN_TZ,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(new Date(ms));
        const py = parseInt(
            wall.find((p) => p.type === 'year').value,
            10
        );
        const pm = parseInt(
            wall.find((p) => p.type === 'month').value,
            10
        );
        const pd = parseInt(
            wall.find((p) => p.type === 'day').value,
            10
        );
        const ph = parseInt(
            wall.find((p) => p.type === 'hour').value,
            10
        );
        const pmin = parseInt(
            wall.find((p) => p.type === 'minute').value,
            10
        );
        const ps = parseInt(
            wall.find((p) => p.type === 'second').value,
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

/** Numeric offset like `-07:00` or `-08:00` for an instant in US Pacific. */
function pacificOffsetForInstant(d) {
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) return '-08:00';
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: USAN_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const offsetMin = Math.round((asUtc - date.getTime()) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');
    return `${sign}${oh}:${om}`;
}

/** DST-aware Pacific offset for calendar day `ymd` (evaluated at local noon). */
function pacificOffsetForYmd(ymd) {
    return pacificOffsetForInstant(new Date(pacificYmdHmToUtcMs(ymd, 12, 0, 0)));
}

/** Pacific end-of-day (23:59:59.999) for bare YYYY-MM-DD, as ISO UTC. */
function pacificEndOfDayUtcIsoFromYmd(ymd) {
    const ms = pacificYmdHmToUtcMs(ymd, 23, 59, 59);
    return new Date(ms + 999).toISOString();
}

/** Add signed calendar days to YYYY-MM-DD (UTC date math on the YMD components). */
function addDaysToYmd(ymd, days) {
    const parts = String(ymd).split('-').map((x) => parseInt(x, 10));
    const t = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    t.setUTCDate(t.getUTCDate() + days);
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

/**
 * Signed difference in Pacific calendar days (toYmd - fromYmd).
 * @param {number|Date|string} fromMsOrDate
 * @param {number|Date|string} toMsOrDate
 */
function pacificCalendarDayDiff(fromMsOrDate, toMsOrDate) {
    const fromYmd = pacificYmd(new Date(fromMsOrDate));
    const toYmd = pacificYmd(new Date(toMsOrDate));
    const fromDay = Date.parse(`${fromYmd}T00:00:00Z`);
    const toDay = Date.parse(`${toYmd}T00:00:00Z`);
    return Math.round((toDay - fromDay) / (24 * 60 * 60 * 1000));
}

module.exports = {
    USAN_TZ,
    parseInstantForDisplay,
    pacificYmd,
    pacificYmdHmToUtcMs,
    pacificOffsetForInstant,
    pacificOffsetForYmd,
    pacificEndOfDayUtcIsoFromYmd,
    addDaysToYmd,
    pacificCalendarDayDiff,
};
