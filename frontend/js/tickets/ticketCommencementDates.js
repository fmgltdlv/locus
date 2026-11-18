/**
 * USAN ticket commencement rules by ticket type (Pacific).
 * Keep in sync with cloudflare/deploy/src/lib/ticketCommencementDates.cjs
 */
(function (global) {
    'use strict';

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
        return { y: y, m: mo, d: d };
    }

    function parseHm(hm) {
        const tm = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
        if (!tm) return null;
        const h = parseInt(tm[1], 10);
        const min = parseInt(tm[2], 10);
        if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
        return { h: h, min: min };
    }

    function normalizeHm(hm) {
        const p = parseHm(hm);
        if (!p) return null;
        return String(p.h).padStart(2, '0') + ':' + String(p.min).padStart(2, '0');
    }

    function ymdInTimeZone(date, timeZone) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date);
    }

    function hmInTimeZone(date, timeZone) {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);
        let h = '00';
        let m = '00';
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].type === 'hour') h = parts[i].value;
            if (parts[i].type === 'minute') m = parts[i].value;
        }
        return h + ':' + m;
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
        return y + '-' + m + '-' + day;
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
     * Parse USAN ISO datetime (e.g. legalCommencementDate / enquiryEarliestDate) to Pacific ymd + hm.
     * @param {string|null|undefined} iso
     * @returns {{ ymd: string, hm: string }|null}
     */
    function isoToUsanYmdHm(iso) {
        const s = iso != null ? String(iso).trim() : '';
        if (!s) return null;
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return null;
        const ymd = ymdInTimeZone(d, USAN_TZ);
        const hm = normalizeHm(hmInTimeZone(d, USAN_TZ));
        if (!ymd || !hm) return null;
        return { ymd: ymd, hm: hm };
    }

    function formatEarliestCommencementHint(earliest, ticketType, opts) {
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
        const fromUsan = opts && opts.source === 'usan';
        if (fromUsan) return dateStr + ' at ' + hm;
        if (type === 'Emergency') return dateStr + ' at ' + hm + ' (now)';
        if (type === 'Short') return dateStr + ' at ' + hm + ' (at least 2 hours from now)';
        return dateStr + ' at 5:00 PM';
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
        if (type === 'Emergency') return dateStr + ' at ' + hm + ' (within 2 hours)';
        if (type === 'Short') return dateStr + ' at ' + hm + ' (before legal notice window)';
        return '';
    }

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
                    message: 'Emergency work start cannot be in the past. Earliest: ' + hint + '.',
                    earliest: earliest,
                };
            }
            if (type === 'Short') {
                return {
                    ok: false,
                    message: 'Short-notice work must start at least 2 hours from now. Earliest: ' + hint + '.',
                    earliest: earliest,
                };
            }
            return {
                ok: false,
                message: 'Planned work start must be at least 2 business days from today. Earliest: ' + hint + '.',
                earliest: earliest,
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
                        message: 'Emergency work must start within 2 hours. Latest: ' + hint + '.',
                        earliest: earliest,
                        latest: latest,
                    };
                }
                return {
                    ok: false,
                    message: 'Short-notice work must start before the legal notice window. Latest: ' + hint + '.',
                    earliest: earliest,
                    latest: latest,
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
                        message: 'On the earliest allowed date, work cannot start before 5:00 PM. Earliest: ' + hint + '.',
                        earliest: normalEarliest,
                    };
                }
            }
        }

        return { ok: true, earliest: earliest, latest: latest || undefined };
    }

    global.ticketCommencementDatesApi = {
        BUSINESS_DAY_END_HM: BUSINESS_DAY_END_HM,
        SHORT_NOTICE_HOURS: SHORT_NOTICE_HOURS,
        USAN_TZ: USAN_TZ,
        normalizeTicketType: normalizeTicketType,
        purposeIdFromTicketType: purposeIdFromTicketType,
        ticketTypeFromPurposeId: ticketTypeFromPurposeId,
        getEarliestAllowedCommencement: getEarliestAllowedCommencement,
        getLatestAllowedCommencement: getLatestAllowedCommencement,
        validateCommencementDateTime: validateCommencementDateTime,
        formatEarliestCommencementHint: formatEarliestCommencementHint,
        formatLatestCommencementHint: formatLatestCommencementHint,
        compareYmdHm: compareYmdHm,
        isoToUsanYmdHm: isoToUsanYmdHm,
        normalizeHm: normalizeHm,
    };
})(typeof window !== 'undefined' ? window : globalThis);
