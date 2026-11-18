/**
 * USAN ticket commencement rules by ticket type (Pacific).
 * Keep in sync with frontend/js/tickets/ticketCommencementDates.js
 */
const BUSINESS_DAY_COUNT = 2;
const BUSINESS_DAY_END_HM = '17:00';
const USAN_TZ = 'America/Los_Angeles';
const SHORT_NOTICE_HOURS = 2;
const TICKET_TYPES = new Set(['Normal', 'Short', 'Emergency']);

function normalizeTicketType(ticketType) {
    const t = String(ticketType || 'Normal').trim();
    return TICKET_TYPES.has(t) ? t : 'Normal';
}

function purposeIdFromTicketType(ticketType) {
    const t = normalizeTicketType(ticketType);
    if (t === 'Short') return 1;
    if (t === 'Emergency') return 3;
    return 0;
}

function ticketTypeFromPurposeId(purposeId) {
    const n = Number(purposeId);
    if (n === 1) return 'Short';
    if (n === 3) return 'Emergency';
    return 'Normal';
}

function parseYmd(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    return { y, m: mo, d };
}

function parseHm(hm) {
    const tm = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
    if (!tm) return null;
    const h = parseInt(tm[1], 10);
    const min = parseInt(tm[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h, min };
}

function normalizeHm(hm) {
    const p = parseHm(hm);
    if (!p) return null;
    return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

function ymdInTimeZone(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function hmInTimeZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const h = parts.find((p) => p.type === 'hour');
    const m = parts.find((p) => p.type === 'minute');
    return `${h && h.value ? h.value : '00'}:${m && m.value ? m.value : '00'}`;
}

function ymdToUtcDate(ymd) {
    const p = parseYmd(ymd);
    if (!p) return null;
    return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

function dateToYmd(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function isWeekendYmd(ymd) {
    const d = ymdToUtcDate(ymd);
    if (!d) return false;
    const dow = d.getUTCDay();
    return dow === 0 || dow === 6;
}

function addDaysToYmd(ymd, days) {
    const d = ymdToUtcDate(ymd);
    if (!d) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return dateToYmd(d);
}

/** @param {string} startYmd yyyy-mm-dd */
function addWeekdaysFromYmd(startYmd, count) {
    let ymd = startYmd;
    let added = 0;
    while (added < count) {
        ymd = addDaysToYmd(ymd, 1);
        if (!ymd) return null;
        if (!isWeekendYmd(ymd)) added++;
    }
    return ymd;
}

/**
 * @param {string} aYmd
 * @param {string} aHm
 * @param {string} bYmd
 * @param {string} bHm
 * @returns {-1|0|1|null}
 */
function compareYmdHm(aYmd, aHm, bYmd, bHm) {
    if (!parseYmd(aYmd) || !parseYmd(bYmd)) return null;
    const dateCmp = String(aYmd).localeCompare(String(bYmd));
    if (dateCmp !== 0) return dateCmp < 0 ? -1 : 1;
    const a = parseHm(aHm);
    const b = parseHm(bHm);
    if (!a || !b) return null;
    const aMins = a.h * 60 + a.min;
    const bMins = b.h * 60 + b.min;
    if (aMins < bMins) return -1;
    if (aMins > bMins) return 1;
    return 0;
}

function zonedYmdHmToUtcDate(ymd, hm, timeZone) {
    const normalized = normalizeHm(hm);
    if (!parseYmd(ymd) || !normalized) return null;
    const p = parseYmd(ymd);
    const dayStart = Date.UTC(p.y, p.m - 1, p.d, 12, 0);
    let lo = dayStart - 36 * 3600000;
    let hi = dayStart + 36 * 3600000;
    for (let i = 0; i < 48; i++) {
        const mid = Math.floor((lo + hi) / 2);
        const d = new Date(mid);
        const cmp = compareYmdHm(ymdInTimeZone(d, timeZone), hmInTimeZone(d, timeZone), ymd, normalized);
        if (cmp === 0) return d;
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
    }
    return new Date(Math.floor((lo + hi) / 2));
}

function addMinutesToYmdHm(ymd, hm, minutes, timeZone) {
    const start = zonedYmdHmToUtcDate(ymd, hm, timeZone);
    if (!start) return null;
    const end = new Date(start.getTime() + minutes * 60000);
    return { ymd: ymdInTimeZone(end, timeZone), hm: hmInTimeZone(end, timeZone) };
}

function getNormalEarliestAllowedCommencement(now) {
    const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const todayYmd = ymdInTimeZone(ref, USAN_TZ);
    const ymd = addWeekdaysFromYmd(todayYmd, BUSINESS_DAY_COUNT);
    return { ymd: ymd || todayYmd, hm: BUSINESS_DAY_END_HM };
}

/**
 * @param {Date} [now]
 * @param {string} [ticketType]
 * @returns {{ ymd: string, hm: string, ticketType: string }}
 */
function getEarliestAllowedCommencement(now, ticketType) {
    const type = normalizeTicketType(ticketType);
    const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    if (type === 'Emergency') {
        return { ymd: ymdInTimeZone(ref, USAN_TZ), hm: hmInTimeZone(ref, USAN_TZ), ticketType: type };
    }
    if (type === 'Short') {
        const todayYmd = ymdInTimeZone(ref, USAN_TZ);
        const nowHm = hmInTimeZone(ref, USAN_TZ);
        const plus = addMinutesToYmdHm(todayYmd, nowHm, SHORT_NOTICE_HOURS * 60, USAN_TZ);
        return {
            ymd: plus ? plus.ymd : todayYmd,
            hm: plus ? plus.hm : nowHm,
            ticketType: type,
        };
    }
    const normal = getNormalEarliestAllowedCommencement(ref);
    return { ymd: normal.ymd, hm: normal.hm, ticketType: type };
}

/**
 * @param {Date} [now]
 * @param {string} [ticketType]
 * @returns {{ ymd: string, hm: string }|null}
 */
function getLatestAllowedCommencement(now, ticketType) {
    const type = normalizeTicketType(ticketType);
    const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    if (type === 'Emergency') {
        const todayYmd = ymdInTimeZone(ref, USAN_TZ);
        const nowHm = hmInTimeZone(ref, USAN_TZ);
        const plus = addMinutesToYmdHm(todayYmd, nowHm, SHORT_NOTICE_HOURS * 60, USAN_TZ);
        return plus ? { ymd: plus.ymd, hm: plus.hm } : null;
    }
    if (type === 'Short') {
        const normalEarliest = getNormalEarliestAllowedCommencement(ref);
        const minus = addMinutesToYmdHm(normalEarliest.ymd, normalEarliest.hm, -1, USAN_TZ);
        return minus ? { ymd: minus.ymd, hm: minus.hm } : null;
    }
    return null;
}

/**
 * @param {{ ymd: string, hm?: string }} earliest
 * @param {string} [ticketType]
 * @returns {string}
 */
function formatEarliestCommencementHint(earliest, ticketType) {
    if (!earliest || !earliest.ymd) return '';
    const d = ymdToUtcDate(earliest.ymd);
    if (!d) return '';
    const dateStr = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });
    const hm = normalizeHm(earliest.hm) || '00:00';
    const type = normalizeTicketType(ticketType);
    if (type === 'Emergency') return `${dateStr} at ${hm} (now)`;
    if (type === 'Short') return `${dateStr} at ${hm} (at least 2 hours from now)`;
    return `${dateStr} at 5:00 PM`;
}

function formatLatestCommencementHint(latest, ticketType) {
    if (!latest || !latest.ymd) return '';
    const d = ymdToUtcDate(latest.ymd);
    if (!d) return '';
    const dateStr = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
    });
    const hm = normalizeHm(latest.hm) || '00:00';
    const type = normalizeTicketType(ticketType);
    if (type === 'Emergency') return `${dateStr} at ${hm} (within 2 hours)`;
    if (type === 'Short') return `${dateStr} at ${hm} (before legal notice window)`;
    return '';
}

/**
 * @param {string} startDateYmd yyyy-mm-dd
 * @param {string} startTimeHm HH:mm
 * @param {Date} [now]
 * @param {string} [ticketType]
 * @returns {{ ok: boolean, message?: string, earliest?: { ymd: string, hm: string }, latest?: { ymd: string, hm: string } }}
 */
function validateCommencementDateTime(startDateYmd, startTimeHm, now, ticketType) {
    const type = normalizeTicketType(ticketType);
    const ymd = String(startDateYmd || '').trim();
    const hm = normalizeHm(startTimeHm);
    if (!parseYmd(ymd)) {
        return { ok: false, message: 'Select a valid planned work start date' };
    }
    if (!hm) {
        return { ok: false, message: 'Select a valid work start time' };
    }
    const earliest = getEarliestAllowedCommencement(now, type);
    const cmp = compareYmdHm(ymd, hm, earliest.ymd, earliest.hm);
    if (cmp === null || cmp < 0) {
        const hint = formatEarliestCommencementHint(earliest, type);
        if (type === 'Emergency') {
            return {
                ok: false,
                message: `Emergency work start cannot be in the past. Earliest: ${hint}.`,
                earliest,
            };
        }
        if (type === 'Short') {
            return {
                ok: false,
                message: `Short-notice work must start at least 2 hours from now. Earliest: ${hint}.`,
                earliest,
            };
        }
        return {
            ok: false,
            message: `Planned work start must be at least 2 business days from today. Earliest: ${hint}.`,
            earliest,
        };
    }

    const latest = getLatestAllowedCommencement(now, type);
    if (latest) {
        const cmpMax = compareYmdHm(ymd, hm, latest.ymd, latest.hm);
        if (cmpMax === null || cmpMax > 0) {
            const hint = formatLatestCommencementHint(latest, type);
            if (type === 'Emergency') {
                return {
                    ok: false,
                    message: `Emergency work must start within 2 hours. Latest: ${hint}.`,
                    earliest,
                    latest,
                };
            }
            return {
                ok: false,
                message: `Short-notice work must start before the legal notice window. Latest: ${hint}.`,
                earliest,
                latest,
            };
        }
    }

    if (type === 'Normal') {
        const normalEarliest = getNormalEarliestAllowedCommencement(now);
        if (ymd === normalEarliest.ymd) {
            const timeCmp = compareYmdHm(ymd, hm, normalEarliest.ymd, normalEarliest.hm);
            if (timeCmp === null || timeCmp < 0) {
                const hint = formatEarliestCommencementHint(normalEarliest, type);
                return {
                    ok: false,
                    message: `On the earliest allowed date, work cannot start before 5:00 PM. Earliest: ${hint}.`,
                    earliest: normalEarliest,
                };
            }
        }
    }

    return { ok: true, earliest, latest: latest || undefined };
}

/**
 * @param {string} commencesOnDate dd/mm/yyyy
 * @param {string} commencesOnTime HH:mm
 * @returns {{ ymd: string, hm: string }|null}
 */
function commencesPayloadToYmdHm(commencesOnDate, commencesOnTime) {
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(commencesOnDate || '').trim());
    if (!dm) return null;
    const ymd = `${dm[3]}-${dm[2]}-${dm[1]}`;
    const hm = normalizeHm(commencesOnTime);
    if (!parseYmd(ymd) || !hm) return null;
    return { ymd, hm };
}

module.exports = {
    BUSINESS_DAY_COUNT,
    BUSINESS_DAY_END_HM,
    USAN_TZ,
    SHORT_NOTICE_HOURS,
    normalizeTicketType,
    purposeIdFromTicketType,
    ticketTypeFromPurposeId,
    ymdInTimeZone,
    hmInTimeZone,
    isWeekendYmd,
    addWeekdaysFromYmd,
    getEarliestAllowedCommencement,
    getLatestAllowedCommencement,
    validateCommencementDateTime,
    compareYmdHm,
    formatEarliestCommencementHint,
    formatLatestCommencementHint,
    commencesPayloadToYmdHm,
};
