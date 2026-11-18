/**
 * US Pacific date windows for nGen SearchCurrentUserEnquiries / USAN list poll.
 * (Formerly bundled with optional PAC web job-list enrichment, which was removed.)
 */
const { getAppKv, KEYS, getUsanListLastSyncAtForOrg } = require('./appKv.js');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM-DD in America/Los_Angeles for the given instant. */
function pacificYmd(d) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function subtractCalendarDaysYmd(ymd, days) {
    const parts = ymd.split('-').map((x) => parseInt(x, 10));
    const y = parts[0];
    const m = parts[1];
    const day = parts[2];
    const t = new Date(Date.UTC(y, m - 1, day));
    t.setUTCDate(t.getUTCDate() - days);
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(t.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

/** Dashboard-style "19 Apr 2026" using US Pacific calendar date YYYY-MM-DD. */
function ymdToPacDashboardFormat(ymd) {
    const parts = ymd.split('-').map((x) => parseInt(x, 10));
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * US Pacific YYYY-MM-DD range for incremental poll since last `LAST_PACWEB_POLL_AT` watermark.
 * @param {import('sqlite3').Database|object} db
 * @returns {Promise<{ fromYmd: string, toYmd: string, usedFullRangeFallback: boolean }>}
 */
async function getPacwebPollDateRangeYmd(db) {
    const last = await getAppKv(db, KEYS.LAST_PACWEB_POLL_AT);
    const todayYmd = pacificYmd(new Date());
    if (!last || !String(last).trim()) {
        const days = Math.max(1, parseInt(process.env.PAC_ENRICHMENT_DAYS_BACK || '120', 10) || 120);
        const fromYmd = subtractCalendarDaysYmd(todayYmd, days);
        return { fromYmd, toYmd: todayYmd, usedFullRangeFallback: true };
    }
    const lastYmd = pacificYmd(new Date(last));
    let fromYmd = lastYmd;
    if (fromYmd > todayYmd) fromYmd = todayYmd;
    return { fromYmd, toYmd: todayYmd, usedFullRangeFallback: false };
}

function utcMsStartOfPacificYmd(ymd) {
    const parts = ymd.split('-').map((x) => parseInt(x, 10));
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    let t = Date.UTC(y, m - 1, d - 1, 7, 0, 0, 0);
    const tEnd = Date.UTC(y, m - 1, d + 1, 7, 0, 0, 0);
    for (; t < tEnd; t += 60000) {
        if (pacificYmd(new Date(t)) === ymd) return t;
    }
    return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
}

function utcMsEndOfPacificYmd(ymd) {
    const parts = ymd.split('-').map((x) => parseInt(x, 10));
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    let t = Date.UTC(y, m - 1, d, 5, 0, 0, 0);
    const tEnd = Date.UTC(y, m - 1, d + 2, 0, 0, 0, 0);
    let last = t;
    for (; t < tEnd; t += 60000) {
        if (pacificYmd(new Date(t)) === ymd) last = t;
    }
    return last + 59999;
}

/**
 * nGen `createdDateFrom` / `createdDateTo` (ISO) for SearchCurrentUserEnquiries, inclusive.
 * @param {{ fromYmd: string, toYmd: string }} param0
 * @returns {{ from: string, to: string }}
 */
function pacificYmdRangeToNgenSearchIso({ fromYmd, toYmd }) {
    const a = String(fromYmd || '').trim();
    const b = String(toYmd || '').trim();
    if (!a || !b) {
        const t = new Date();
        return { from: t.toISOString(), to: t.toISOString() };
    }
    return {
        from: new Date(utcMsStartOfPacificYmd(a)).toISOString(),
        to: new Date(utcMsEndOfPacificYmd(b)).toISOString(),
    };
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

/** Absolute calendar-day cap for full list sync windows (`USAN_LIST_LOOKBACK_MAX_DAYS`, default 730). */
function getUsanListLookbackMaxDays() {
    const maxLookbackRaw = parseInt(String(process.env.USAN_LIST_LOOKBACK_MAX_DAYS || '730'), 10);
    return Math.max(1, Math.min(3660, Number.isFinite(maxLookbackRaw) ? maxLookbackRaw : 730));
}

/**
 * Routine incremental list poll createdDate window (default 7 calendar days, US Pacific).
 * Capped by `USAN_LIST_MAX_DAYS_BACK` (default 30).
 */
function getUsanListIncrementalDaysBack() {
    const raw = parseInt(String(process.env.USAN_LIST_INCREMENTAL_DAYS_BACK || '7'), 10);
    const capRaw = parseInt(String(process.env.USAN_LIST_MAX_DAYS_BACK || '30'), 10);
    const d = Number.isFinite(raw) ? raw : 7;
    const cap = Number.isFinite(capRaw) ? capRaw : 30;
    return Math.max(1, Math.min(Math.max(1, Math.min(30, cap)), d));
}

async function getEarliestOpenTicketPacificYmd(db, orgId) {
    if (orgId == null || String(orgId).trim() === '') return null;
    try {
        const r = await dbGet(
            db,
            `SELECT MIN(COALESCE(NULLIF(TRIM(lodged_on), ''), NULLIF(TRIM(created_at), ''))) AS min_open_date
             FROM tickets
             WHERE organization_id = ?
               AND (
                 ticket_expires_at IS NULL OR TRIM(ticket_expires_at) = ''
                 OR date(substr(trim(ticket_expires_at), 1, 10)) >= date('now')
               )`,
            [orgId]
        );
        const rawMin = r && r.min_open_date != null ? String(r.min_open_date).trim() : '';
        if (!rawMin) return null;
        const md = new Date(rawMin);
        if (Number.isNaN(md.getTime())) return null;
        return pacificYmd(md);
    } catch (e) {
        console.warn('[getNgenSearchPacificYmdRangeForPoll] MIN open ticket date:', e && e.message ? e.message : e);
        return null;
    }
}

/**
 * YMD window for nGen list — aligned with runPacwebPollCore date options (US Pacific).
 * @param {import('sqlite3').Database|object} db
 * @param {{ fullSync?: boolean, legacyFullRange?: boolean, hubWindowDaysBack?: number | null, settingsDaysBack: number, organizationId?: number | string | null, maxWindowCalendarDays?: number }} opts
 * @returns {Promise<{ fromYmd: string, toYmd: string, usedFullRangeFallback: boolean }>}
 */
async function getNgenSearchPacificYmdRangeForPoll(db, opts) {
    const todayYmd = pacificYmd(new Date());
    const fs = opts && opts.fullSync;
    const lr = opts && opts.legacyFullRange;
    const rawHub = opts && opts.hubWindowDaysBack;
    const h = rawHub != null && String(rawHub).trim() !== '' ? parseInt(String(rawHub), 10) : null;
    const orgId = opts && opts.organizationId;
    const maxDaysRaw =
        opts && opts.maxWindowCalendarDays != null
            ? parseInt(String(opts.maxWindowCalendarDays), 10)
            : parseInt(process.env.USAN_LIST_MAX_DAYS_BACK || '30', 10);
    const maxDays = Math.max(1, Math.min(30, Number.isFinite(maxDaysRaw) ? maxDaysRaw : 30));
    const maxLookback = getUsanListLookbackMaxDays();
    const earliestAllowedYmd = subtractCalendarDaysYmd(todayYmd, maxLookback);

    if (fs || lr) {
        const d = Math.max(1, Math.min(maxLookback, Number(opts.settingsDaysBack) || 1));
        let fromYmd = subtractCalendarDaysYmd(todayYmd, d);
        const openMinYmd = await getEarliestOpenTicketPacificYmd(db, orgId);
        if (openMinYmd && openMinYmd < fromYmd) fromYmd = openMinYmd;
        if (fromYmd < earliestAllowedYmd) fromYmd = earliestAllowedYmd;
        if (fromYmd > todayYmd) fromYmd = todayYmd;
        return { fromYmd, toYmd: todayYmd, usedFullRangeFallback: true };
    }
    if (h != null && Number.isFinite(h) && h > 0) {
        const d = Math.min(365, Math.max(1, h));
        return { fromYmd: subtractCalendarDaysYmd(todayYmd, d), toYmd: todayYmd, usedFullRangeFallback: true };
    }
    if (orgId != null && String(orgId).trim() !== '') {
        const incrementalDays = getUsanListIncrementalDaysBack();
        const routineFromYmd = subtractCalendarDaysYmd(todayYmd, incrementalDays);
        const capFromYmd = subtractCalendarDaysYmd(todayYmd, maxDays);
        let fromYmd = routineFromYmd;
        let extendedSinceLastSync = false;

        const lastSyncIso = await getUsanListLastSyncAtForOrg(db, orgId);
        if (lastSyncIso) {
            const lastSyncYmd = pacificYmd(new Date(lastSyncIso));
            if (lastSyncYmd < fromYmd) {
                fromYmd = lastSyncYmd;
                extendedSinceLastSync = true;
            }
        }

        if (fromYmd < capFromYmd) fromYmd = capFromYmd;
        if (fromYmd < earliestAllowedYmd) fromYmd = earliestAllowedYmd;
        if (fromYmd > todayYmd) fromYmd = todayYmd;
        return { fromYmd, toYmd: todayYmd, usedFullRangeFallback: extendedSinceLastSync };
    }
    return getPacwebPollDateRangeYmd(db);
}

module.exports = {
    getNgenSearchPacificYmdRangeForPoll,
    getUsanListLookbackMaxDays,
    getUsanListIncrementalDaysBack,
    pacificYmd,
    subtractCalendarDaysYmd,
    pacificYmdRangeToNgenSearchIso,
    ymdToPacDashboardFormat,
};
