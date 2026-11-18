/**
 * nGen GetAccessToken JWT cache:
 * - L1: in-process Map (per isolate)
 * - L2: APP_KV via appKv (shared across isolates; D1 app_kv fallback)
 *
 * Soft TTL defaults to 1h sliding (extend on use), always capped by JWT exp − skew.
 * Kill switch: NGEN_ACCESS_TOKEN_CACHE=0.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** When JWT `exp` cannot be parsed, do not cache for the full sliding window. */
const UNKNOWN_JWT_SOFT_TTL_MS = 10 * 60 * 1000;
const JWT_EXP_SKEW_MS = 60 * 1000;
const TOUCH_DEBOUNCE_MS = 2 * 60 * 1000;
const TOKEN_FETCH_LEASE_MS = 45 * 1000;
const LOSER_WAIT_MS = 1500;
const LOSER_POLL_MS = 250;
/** Extra seconds on KV hard TTL beyond soft expiry. */
const KV_TTL_BUFFER_SEC = 120;
/** Tombstone TTL so in-flight touch cannot resurrect an invalidated JWT. */
const TOMBSTONE_TTL_SEC = 120;

/** @type {Map<string, { token: string, expiresAtMs: number, passwordFp?: string }>} */
const store = new Map();

/** Per-username invalidate generation (this isolate). In-flight touches abort when bumped. */
/** @type {Map<string, number>} */
const invalidateEpochByUser = new Map();

function isCacheEnabled() {
    return String(process.env.NGEN_ACCESS_TOKEN_CACHE || '1').trim() !== '0';
}

/**
 * @param {string} username
 * @returns {string}
 */
function normalizeCacheKey(username) {
    return String(username || '')
        .trim()
        .toLowerCase();
}

/**
 * @param {string} key normalized username
 * @returns {number}
 */
function getInvalidateEpoch(key) {
    return invalidateEpochByUser.get(key) || 0;
}

/**
 * @param {string} key normalized username
 * @returns {number} new epoch
 */
function bumpInvalidateEpoch(key) {
    const next = getInvalidateEpoch(key) + 1;
    invalidateEpochByUser.set(key, next);
    return next;
}

/**
 * Short fingerprint so password rotation invalidates cached JWT for the same username.
 * @param {string|null|undefined} password
 * @returns {string}
 */
function passwordFingerprint(password) {
    const p = password != null ? String(password) : '';
    return crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {string} token
 * @returns {string}
 */
function tokenContentHash(token) {
    return crypto.createHash('sha256').update(String(token || '').trim(), 'utf8').digest('hex').slice(0, 24);
}

/**
 * @param {string} username
 * @returns {string}
 */
function durableTokenKey(username) {
    return `ngen:token:v1:${normalizeCacheKey(username)}`;
}

/**
 * @param {string} username
 * @returns {string}
 */
function durableActiveKey(username) {
    return `ngen:token:active:v1:${normalizeCacheKey(username)}`;
}

/**
 * @param {string} username
 * @returns {string}
 */
function durableTombstoneKey(username) {
    return `ngen:token:tomb:v1:${normalizeCacheKey(username)}`;
}

/**
 * Parse JWT payload `exp` (seconds since epoch) without verifying signature.
 * @param {string} token
 * @returns {number|null} exp in ms, or null
 */
function jwtExpMsFromToken(token) {
    const t = String(token || '').trim();
    if (!t) return null;
    const parts = t.split('.');
    if (parts.length < 2) return null;
    try {
        let payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = payloadB64.length % 4;
        if (pad) payloadB64 += '='.repeat(4 - pad);
        const json = Buffer.from(payloadB64, 'base64').toString('utf8');
        const payload = JSON.parse(json);
        if (payload == null || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
            return null;
        }
        return payload.exp * 1000;
    } catch (_) {
        return null;
    }
}

/**
 * Soft expiry: now + sliding window, capped by JWT exp − skew.
 * Unparsed JWT → short soft TTL ({@link UNKNOWN_JWT_SOFT_TTL_MS}), not full window.
 * @param {string} token
 * @param {number} [ttlMs] default from env or 1h
 * @returns {number}
 */
function computeExpiresAtMs(token, ttlMs) {
    const configured = process.env.NGEN_ACCESS_TOKEN_CACHE_TTL_MS;
    const cap =
        ttlMs != null && Number.isFinite(ttlMs)
            ? ttlMs
            : Math.max(60_000, parseInt(String(configured || '').trim(), 10) || DEFAULT_TTL_MS);
    const now = Date.now();
    const ceiling = now + cap;
    const jwtExp = jwtExpMsFromToken(token);
    if (jwtExp == null) {
        return Math.min(ceiling, now + UNKNOWN_JWT_SOFT_TTL_MS);
    }
    const jwtCap = jwtExp - JWT_EXP_SKEW_MS;
    return Math.min(ceiling, jwtCap);
}

function tryGetDb() {
    try {
        return require('../database.js').getDatabase();
    } catch (_) {
        return null;
    }
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isOutsideRequestContextError(e) {
    const msg = e != null && typeof e === 'object' && e.message != null ? String(e.message) : String(e);
    return /outside request context/i.test(msg);
}

/**
 * Run L2 work.
 * @template T
 * @param {(api: { getAppKv: Function, setAppKv: Function, deleteAppKv: Function, db: unknown }) => Promise<T>} fn
 * @param {{ throwOnError?: boolean }} [options] When true, rethrow real KV/D1 errors (not "outside ALS").
 * @returns {Promise<T|undefined>}
 */
async function withDurable(fn, options) {
    if (!isCacheEnabled()) return undefined;
    const throwOnError = !!(options && options.throwOnError);
    let getAppKv;
    let setAppKv;
    let deleteAppKv;
    try {
        ({ getAppKv, setAppKv, deleteAppKv } = require('./appKv.js'));
    } catch (e) {
        // Unbundled Node (unit tests) — L2 unavailable; Worker bundle resolves appKv.js.
        return undefined;
    }
    try {
        const db = tryGetDb();
        return await fn({ getAppKv, setAppKv, deleteAppKv, db });
    } catch (e) {
        if (isOutsideRequestContextError(e)) return undefined;
        if (throwOnError) throw e;
        console.warn('[ngenAccessTokenCache] durable op failed:', e && e.message ? e.message : e);
        return undefined;
    }
}

/**
 * @param {string} username
 * @param {string|null|undefined} [password]
 * @returns {{ token: string, expiresAtMs: number, passwordFp?: string } | null}
 */
function getCached(username, password) {
    if (!isCacheEnabled()) return null;
    const key = normalizeCacheKey(username);
    if (!key) return null;
    const row = store.get(key);
    if (!row || !row.token) return null;
    if (Date.now() >= row.expiresAtMs) {
        store.delete(key);
        return null;
    }
    if (password != null && row.passwordFp) {
        if (row.passwordFp !== passwordFingerprint(password)) {
            store.delete(key);
            return null;
        }
    }
    return row;
}

/**
 * @param {string} username
 * @param {string} token
 * @param {string|null|undefined} [password]
 * @param {number} [expiresAtMs]
 */
function setCached(username, token, password, expiresAtMs) {
    if (!isCacheEnabled()) return;
    const key = normalizeCacheKey(username);
    if (!key || !String(token || '').trim()) return;
    const exp = expiresAtMs != null && Number.isFinite(expiresAtMs) ? expiresAtMs : computeExpiresAtMs(token);
    /** @type {{ token: string, expiresAtMs: number, passwordFp?: string }} */
    const row = { token: String(token).trim(), expiresAtMs: exp };
    if (password != null) row.passwordFp = passwordFingerprint(password);
    store.set(key, row);
}

/**
 * L1 only (sync). Prefer {@link invalidateAsync} when clearing durable store too.
 * @param {string} username
 */
function invalidate(username) {
    const key = normalizeCacheKey(username);
    if (key) store.delete(key);
}

/**
 * @param {unknown} raw
 * @returns {{ tokenHash: string } | null}
 */
function parseTombstone(raw) {
    if (!raw) return null;
    try {
        const o = JSON.parse(String(raw));
        if (!o || typeof o.tokenHash !== 'string' || !o.tokenHash) return null;
        return { tokenHash: String(o.tokenHash) };
    } catch (_) {
        return null;
    }
}

/**
 * @param {unknown} raw
 * @param {string} passwordFp
 * @returns {{ token: string, expiresAtMs: number, passwordFp?: string, lastTouchedAtMs?: number } | null}
 */
function parseDurableRow(raw, passwordFp) {
    if (!raw) return null;
    try {
        const o = JSON.parse(String(raw));
        if (!o || typeof o.token !== 'string' || !o.token.trim()) return null;
        if (typeof o.expiresAtMs !== 'number' || !Number.isFinite(o.expiresAtMs)) return null;
        if (Date.now() >= o.expiresAtMs) return null;
        if (o.passwordFp != null && String(o.passwordFp) !== passwordFp) return null;
        return {
            token: String(o.token).trim(),
            expiresAtMs: o.expiresAtMs,
            passwordFp: o.passwordFp != null ? String(o.passwordFp) : undefined,
            lastTouchedAtMs: typeof o.lastTouchedAtMs === 'number' ? o.lastTouchedAtMs : undefined,
        };
    } catch (_) {
        return null;
    }
}

/**
 * @param {string} username
 * @param {string|null|undefined} password
 * @returns {Promise<{ token: string, expiresAtMs: number } | null>}
 */
async function getCachedDurable(username, password) {
    const key = normalizeCacheKey(username);
    if (!key || !isCacheEnabled()) return null;
    const fp = passwordFingerprint(password);
    const row = await withDurable(async ({ getAppKv, deleteAppKv, db }) => {
        const raw = await getAppKv(db, durableTokenKey(username));
        const parsed = parseDurableRow(raw, fp);
        if (!parsed) return null;
        const tomb = parseTombstone(await getAppKv(db, durableTombstoneKey(username)));
        if (tomb && tomb.tokenHash === tokenContentHash(parsed.token)) {
            // Zombie resurrected after invalidate — drop it.
            await deleteAppKv(db, durableTokenKey(username)).catch(() => {});
            return null;
        }
        return parsed;
    });
    return row && row.token ? { token: row.token, expiresAtMs: row.expiresAtMs } : null;
}

/**
 * @param {string} username
 * @param {string} token
 * @param {string|null|undefined} password
 * @param {number} [expiresAtMs]
 */
async function setCachedDurable(username, token, password, expiresAtMs) {
    const key = normalizeCacheKey(username);
    if (!key || !isCacheEnabled() || !String(token || '').trim()) return;
    const exp = expiresAtMs != null && Number.isFinite(expiresAtMs) ? expiresAtMs : computeExpiresAtMs(token);
    const now = Date.now();
    const payload = JSON.stringify({
        token: String(token).trim(),
        expiresAtMs: exp,
        lastTouchedAtMs: now,
        passwordFp: passwordFingerprint(password),
    });
    const ttlSec = Math.max(60, Math.ceil((exp - now) / 1000) + KV_TTL_BUFFER_SEC);
    await withDurable(async ({ setAppKv, deleteAppKv, db }) => {
        await setAppKv(db, durableTokenKey(username), payload, { expirationTtl: ttlSec });
        // Fresh token supersedes any invalidate tombstone for the prior JWT.
        await deleteAppKv(db, durableTombstoneKey(username));
    });
}

/**
 * Slide soft TTL on reuse. Never recreates L2 after invalidate (tombstone + token match + epoch).
 * @param {string} username
 * @param {string} token
 * @param {string|null|undefined} password
 */
async function touchCachedDurable(username, token, password) {
    const key = normalizeCacheKey(username);
    if (!key || !isCacheEnabled() || !String(token || '').trim()) return;
    const expectedToken = String(token).trim();
    const expectedHash = tokenContentHash(expectedToken);
    const epochAtStart = getInvalidateEpoch(key);
    const newExp = computeExpiresAtMs(expectedToken);
    const fp = passwordFingerprint(password);

    await withDurable(async ({ getAppKv, setAppKv, db }) => {
        if (getInvalidateEpoch(key) !== epochAtStart) return;

        const tomb = parseTombstone(await getAppKv(db, durableTombstoneKey(username)));
        if (tomb && tomb.tokenHash === expectedHash) return;

        const raw = await getAppKv(db, durableTokenKey(username));
        if (!raw) return; // invalidated / missing — do not resurrect

        let prevExp = 0;
        try {
            const o = JSON.parse(String(raw));
            if (!o || String(o.token || '').trim() !== expectedToken) return;
            if (typeof o.expiresAtMs === 'number') prevExp = o.expiresAtMs;
            if (o.passwordFp != null && String(o.passwordFp) !== fp) {
                /* password changed — allow rewrite below */
            } else if (newExp < prevExp + TOUCH_DEBOUNCE_MS) {
                return;
            }
        } catch (_) {
            return;
        }

        if (getInvalidateEpoch(key) !== epochAtStart) return;
        const tomb2 = parseTombstone(await getAppKv(db, durableTombstoneKey(username)));
        if (tomb2 && tomb2.tokenHash === expectedHash) return;

        const now = Date.now();
        const payload = JSON.stringify({
            token: expectedToken,
            expiresAtMs: newExp,
            lastTouchedAtMs: now,
            passwordFp: fp,
        });
        const ttlSec = Math.max(60, Math.ceil((newExp - now) / 1000) + KV_TTL_BUFFER_SEC);
        await setAppKv(db, durableTokenKey(username), payload, { expirationTtl: ttlSec });
    });
}

/**
 * Delete L2 token + active lease; write short-lived tombstone so in-flight touch cannot resurrect.
 * Throws on real KV/D1 failure when inside request context.
 * @param {string} username
 * @param {string|null|undefined} [tokenHint] L1 token used for tombstone when L2 already empty
 */
async function invalidateDurable(username, tokenHint) {
    const key = normalizeCacheKey(username);
    if (!key) return;
    await withDurable(async ({ getAppKv, setAppKv, deleteAppKv, db }) => {
        const tkey = durableTokenKey(username);
        const raw = await getAppKv(db, tkey);
        let tokenHash = null;
        if (raw) {
            try {
                const o = JSON.parse(String(raw));
                if (o && typeof o.token === 'string' && o.token.trim()) {
                    tokenHash = tokenContentHash(o.token);
                }
            } catch (_) {
                /* ignore */
            }
        }
        if (!tokenHash && tokenHint != null && String(tokenHint).trim()) {
            tokenHash = tokenContentHash(tokenHint);
        }
        await deleteAppKv(db, tkey);
        await deleteAppKv(db, durableActiveKey(username));
        if (tokenHash) {
            await setAppKv(
                db,
                durableTombstoneKey(username),
                JSON.stringify({ tokenHash, at: Date.now() }),
                { expirationTtl: TOMBSTONE_TTL_SEC }
            );
        }
        return true;
    }, { throwOnError: true });
}

/**
 * Clear L2 then L1. Bumps local epoch so in-flight touches on this isolate abort.
 * @param {string} username
 */
async function invalidateAsync(username) {
    const key = normalizeCacheKey(username);
    const l1Token = key && store.get(key) ? store.get(key).token : null;
    if (key) bumpInvalidateEpoch(key);
    await invalidateDurable(username, l1Token);
    invalidate(username);
}

/**
 * @param {string} username
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function tryBeginTokenFetch(username) {
    const key = normalizeCacheKey(username);
    if (!key) return { ok: false, reason: 'missing_username' };
    const result = await withDurable(async ({ getAppKv, setAppKv, db }) => {
        const now = Date.now();
        const activeUntil = now + TOKEN_FETCH_LEASE_MS;
        const akey = durableActiveKey(username);
        const existing = await getAppKv(db, akey);
        if (existing) {
            const t = Date.parse(String(existing));
            if (Number.isFinite(t) && now < t) {
                return { ok: false, reason: 'token_fetch_in_progress' };
            }
        }
        await setAppKv(db, akey, new Date(activeUntil).toISOString(), {
            expirationTtl: Math.max(60, Math.ceil(TOKEN_FETCH_LEASE_MS / 1000) + 30),
        });
        return { ok: true };
    });
    if (result === undefined) return { ok: true, reason: 'durable_unavailable' };
    return result;
}

/**
 * @param {string} username
 */
async function releaseTokenFetch(username) {
    const key = normalizeCacheKey(username);
    if (!key) return;
    await withDurable(async ({ deleteAppKv, db }) => {
        await deleteAppKv(db, durableActiveKey(username));
    });
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Brief poll for another isolate's GetAccessToken result.
 * @param {string} username
 * @param {string|null|undefined} password
 * @param {number} [maxWaitMs]
 * @returns {Promise<{ token: string, expiresAtMs: number } | null>}
 */
async function waitForDurableToken(username, password, maxWaitMs) {
    const budget = maxWaitMs != null && Number.isFinite(maxWaitMs) ? maxWaitMs : LOSER_WAIT_MS;
    const deadline = Date.now() + Math.max(0, budget);
    while (Date.now() < deadline) {
        const row = await getCachedDurable(username, password);
        if (row && row.token) return row;
        await sleep(LOSER_POLL_MS);
    }
    return getCachedDurable(username, password);
}

module.exports = {
    normalizeCacheKey,
    computeExpiresAtMs,
    jwtExpMsFromToken,
    passwordFingerprint,
    tokenContentHash,
    getCached,
    setCached,
    invalidate,
    invalidateAsync,
    invalidateDurable,
    getCachedDurable,
    setCachedDurable,
    touchCachedDurable,
    tryBeginTokenFetch,
    releaseTokenFetch,
    waitForDurableToken,
    isCacheEnabled,
    getInvalidateEpoch,
    bumpInvalidateEpoch,
    DEFAULT_TTL_MS,
    UNKNOWN_JWT_SOFT_TTL_MS,
    TOUCH_DEBOUNCE_MS,
    TOKEN_FETCH_LEASE_MS,
    LOSER_WAIT_MS,
    durableTokenKey,
    durableActiveKey,
    durableTombstoneKey,
};
