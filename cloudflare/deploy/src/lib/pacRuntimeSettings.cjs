/**
 * Persisted PAC poll settings (app_kv), with env fallbacks matching .env.sample.
 * Keys: pac_search_date_option, pacweb_poll_max_new, pac_enrichment_days_back
 */
const { getAppKv, setAppKv } = require('./appKv.js');
const { getUsanListLookbackMaxDays } = require('./ngenUsanPollDates.cjs');

const KEYS = {
    PAC_SEARCH_DATE_OPTION: 'pac_search_date_option',
    PACWEB_POLL_MAX_NEW: 'pacweb_poll_max_new',
    PAC_ENRICHMENT_DAYS_BACK: 'pac_enrichment_days_back',
};
/** Default / non-dev cap for persisted full-sync window. */
const MAX_DAYS_BACK = 120;

function envSearchDateOption() {
    const raw = String(process.env.PAC_SEARCH_DATE_OPTION || '').trim().toLowerCase();
    if (raw === 'legalstart') return 'legalstart';
    return 'createdon';
}

function envMaxPoll() {
    return Math.min(100, Math.max(1, parseInt(process.env.PACWEB_POLL_MAX_NEW || '40', 10) || 40));
}

function envDaysBack() {
    return Math.min(MAX_DAYS_BACK, Math.max(1, parseInt(process.env.PAC_ENRICHMENT_DAYS_BACK || '120', 10) || 120));
}

/**
 * @param {number|string|null|undefined} n
 * @param {{ dev?: boolean }} [opts] When `dev` is true, allow up to {@link getUsanListLookbackMaxDays}.
 * @returns {number|null}
 */
function clampDaysBack(n, opts) {
    const raw = parseInt(String(n), 10);
    if (!Number.isFinite(raw)) return null;
    const max = opts && opts.dev ? getUsanListLookbackMaxDays() : MAX_DAYS_BACK;
    return Math.min(max, Math.max(1, raw));
}

/**
 * @param {import('sqlite3').Database} db
 * @returns {Promise<{ searchDateOption: 'createdon'|'legalstart', maxPoll: number, daysBack: number }>}
 */
async function getPacRuntimeSettings(db) {
    const map = new Map();
    for (const k of [KEYS.PAC_SEARCH_DATE_OPTION, KEYS.PACWEB_POLL_MAX_NEW, KEYS.PAC_ENRICHMENT_DAYS_BACK]) {
        const v = await getAppKv(db, k);
        if (v != null && String(v).trim() !== '') map.set(String(k), String(v));
    }

    let searchDateOption = envSearchDateOption();
    const s = map.get(KEYS.PAC_SEARCH_DATE_OPTION);
    if (s === 'legalstart' || s === 'createdon') searchDateOption = s;

    let maxPoll = envMaxPoll();
    const m = map.get(KEYS.PACWEB_POLL_MAX_NEW);
    if (m != null && String(m).trim() !== '') {
        const n = parseInt(String(m), 10);
        if (Number.isFinite(n)) maxPoll = Math.min(100, Math.max(1, n));
    }

    let daysBack = envDaysBack();
    const d = map.get(KEYS.PAC_ENRICHMENT_DAYS_BACK);
    if (d != null && String(d).trim() !== '') {
        const clamped = clampDaysBack(d, { dev: true });
        if (clamped != null) daysBack = clamped;
    }

    return { searchDateOption, maxPoll, daysBack };
}

/**
 * @param {import('sqlite3').Database} db
 * @param {{ searchDateOption?: string, maxPoll?: number, daysBack?: number }} partial
 * @param {{ dev?: boolean }} [opts]
 */
async function setPacRuntimeSettings(db, partial, opts) {
    const upsert = async (key, value) => {
        await setAppKv(db, key, value);
    };
    if (partial.searchDateOption != null) {
        const v = String(partial.searchDateOption).trim().toLowerCase();
        if (v === 'legalstart' || v === 'createdon') {
            await upsert(KEYS.PAC_SEARCH_DATE_OPTION, v);
        }
    }
    if (partial.maxPoll != null) {
        const n = parseInt(String(partial.maxPoll), 10);
        if (Number.isFinite(n)) {
            await upsert(KEYS.PACWEB_POLL_MAX_NEW, String(Math.min(100, Math.max(1, n))));
        }
    }
    if (partial.daysBack != null) {
        const clamped = clampDaysBack(partial.daysBack, opts);
        if (clamped != null) {
            await upsert(KEYS.PAC_ENRICHMENT_DAYS_BACK, String(clamped));
        }
    }
}

module.exports = {
    KEYS,
    MAX_DAYS_BACK,
    getPacRuntimeSettings,
    setPacRuntimeSettings,
    clampDaysBack,
    getUsanListLookbackMaxDays,
    envSearchDateOption,
    envMaxPoll,
    envDaysBack,
};
