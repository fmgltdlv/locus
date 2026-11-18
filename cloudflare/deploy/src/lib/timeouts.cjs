/**
 * Default timeout for outbound HTTP / long operations (nGen, PAC, etc.).
 * Override with OPERATION_TIMEOUT_MS in environment (milliseconds).
 */
function getOperationTimeoutMs() {
    const raw = process.env.OPERATION_TIMEOUT_MS;
    if (raw != null && String(raw).trim() !== '') {
        const n = parseInt(String(raw).trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 15000;
}

/** Max time an automatic PAC poll may hold the in-flight reservation (ms). */
function getPacPollActiveLeaseMs() {
    const t = getOperationTimeoutMs();
    return Math.max(120000, t * 8);
}

const DEFAULT_COOPERATIVE_LOCK_MS = 30 * 60 * 1000;
const DEFAULT_TICKET_DETAIL_COOP_LOCK_MS = 2 * 60 * 1000;
/** Min/max keep typos from disabling locks or setting absurd values (ms). */
const COOPERATIVE_LOCK_MIN_MS = 1000;
const COOPERATIVE_LOCK_MAX_MS = 7 * 24 * 60 * 60 * 1000;

function parseBoundedLockMs(raw, defaultMs) {
    if (raw != null && String(raw).trim() !== "") {
        const n = parseInt(String(raw).trim(), 10);
        if (Number.isFinite(n) && n >= COOPERATIVE_LOCK_MIN_MS && n <= COOPERATIVE_LOCK_MAX_MS) {
            return n;
        }
    }
    return defaultMs;
}

/**
 * USAN org list / PAC poll cooperative lock (ms).
 * Set `COOPERATIVE_LOCK_MS` in wrangler [vars] (string integer milliseconds).
 * Keep bounds/default in sync with `src/lib/cooperativeLockMs.ts`.
 */
function getCooperativeLockMs() {
    return parseBoundedLockMs(process.env.COOPERATIVE_LOCK_MS, DEFAULT_COOPERATIVE_LOCK_MS);
}

/**
 * Per-ticket nGen full-detail refresh skip window (ms).
 * Set `TICKET_DETAIL_COOP_LOCK_MS` in wrangler [vars]. Exposed via GET /api/public-config.
 */
function getTicketDetailCoopLockMs() {
    return parseBoundedLockMs(process.env.TICKET_DETAIL_COOP_LOCK_MS, DEFAULT_TICKET_DETAIL_COOP_LOCK_MS);
}

module.exports = {
    getOperationTimeoutMs,
    getPacPollActiveLeaseMs,
    getCooperativeLockMs,
    getTicketDetailCoopLockMs,
};
