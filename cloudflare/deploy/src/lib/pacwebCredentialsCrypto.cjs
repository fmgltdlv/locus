/**
 * `organization_pacweb_accounts.password_encrypted` stores master PAC/nGen passwords
 * with AES-256-GCM. Existing plaintext rows still decrypt by falling back to the raw
 * value so they can be rotated or re-saved without a hard cutover.
 *
 * Key material: `NGEN_CREDENTIALS_KEY` (primary for new encrypt), optional
 * `NGEN_CREDENTIALS_KEY_OLD` during rotation, then legacy JWT-derived keying until
 * all rows are migrated off JWT.
 *
 * AES-GCM uses the Web Crypto API so it runs under Workers/unenv (Node's
 * createCipheriv is not implemented there).
 */
const nodeCrypto = require('crypto');

const ALGO = 'AES-GCM';
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
/** Historical KDF salt — do not change; it is mixed into existing ciphertext. */
const KDF_SALT = 'excavator-ngen-credential-v1';
const ENCRYPTED_PREFIX = 'v1:';

function isProductionAppEnv() {
    const v = String(process.env.APP_ENV || '')
        .trim()
        .toLowerCase();
    return v === 'production';
}

function getJwtSecretMaterial() {
    const s = process.env.JWT_SECRET;
    if (s != null && String(s).trim() !== '') {
        return String(s).trim();
    }
    throw new Error('JWT_SECRET must be set (required for legacy decrypt paths)');
}

function getKeyFromJwtSecret() {
    return nodeCrypto.scryptSync(getJwtSecretMaterial(), KDF_SALT, 32);
}

/**
 * Derive a 32-byte AES key from raw env material (hex64, base64-32B, or scrypt passphrase).
 * @param {string|null|undefined} raw
 * @returns {Buffer|null}
 */
function keyMaterialToKey(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const s = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
        return Buffer.from(s, 'hex');
    }
    try {
        const b = Buffer.from(s, 'base64');
        if (b.length === 32) return b;
    } catch (_) {
        /* fall through */
    }
    return nodeCrypto.scryptSync(s, 'ngen-cred-salt', 32);
}

/** Primary credential key from `NGEN_CREDENTIALS_KEY` (legacy env name kept for compatibility). */
function keyFromPrimaryEnv() {
    const s = process.env.NGEN_CREDENTIALS_KEY;
    return s != null && String(s).trim() !== '' ? keyMaterialToKey(String(s).trim()) : null;
}

function keyFromOldEnv() {
    const s = process.env.NGEN_CREDENTIALS_KEY_OLD;
    return s != null && String(s).trim() !== '' ? keyMaterialToKey(String(s).trim()) : null;
}

/**
 * Key used only by encryptPassword. Production requires `NGEN_CREDENTIALS_KEY`; non-production
 * may fall back to JWT-derived material for local dev before keys are set.
 * @returns {Buffer}
 */
function getEncryptPrimaryKeyBytes() {
    const k = keyFromPrimaryEnv();
    if (k) return k;
    if (isProductionAppEnv()) {
        throw new Error(
            'NGEN_CREDENTIALS_KEY must be set in production to encrypt USAN/nGen stored credentials'
        );
    }
    return getKeyFromJwtSecret();
}

function toUint8(key) {
    if (key instanceof Uint8Array) return key;
    return new Uint8Array(key);
}

/**
 * @param {string} plaintext
 * @param {Buffer|Uint8Array} key
 */
async function encryptWithKey(plaintext, key) {
    const subtle = globalThis.crypto.subtle;
    const keyBuf = toUint8(key);
    const cryptoKey = await subtle.importKey('raw', keyBuf, { name: ALGO, length: 256 }, false, ['encrypt']);
    const iv = new Uint8Array(IV_LEN);
    globalThis.crypto.getRandomValues(iv);
    const enc = new TextEncoder().encode(String(plaintext));
    const ciphertext = await subtle.encrypt({ name: ALGO, iv, tagLength: AUTH_TAG_LEN * 8 }, cryptoKey, enc);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return Buffer.from(combined).toString('base64');
}

/**
 * @param {string} stored
 * @param {Buffer|Uint8Array} key
 */
async function decryptWithKey(stored, key) {
    const buf = Buffer.from(String(stored), 'base64');
    if (buf.length < IV_LEN + AUTH_TAG_LEN + 1) {
        throw new Error('Invalid encrypted password blob');
    }
    const iv = new Uint8Array(buf.subarray(0, IV_LEN));
    const ctAndTag = buf.subarray(IV_LEN);
    const subtle = globalThis.crypto.subtle;
    const keyBuf = toUint8(key);
    const cryptoKey = await subtle.importKey('raw', keyBuf, { name: ALGO, length: 256 }, false, ['decrypt']);
    const pt = await subtle.decrypt(
        { name: ALGO, iv, tagLength: AUTH_TAG_LEN * 8 },
        cryptoKey,
        new Uint8Array(ctAndTag)
    );
    return new TextDecoder().decode(pt);
}

/**
 * Try decrypting a v1 payload (base64 after prefix) with each key in order.
 * @param {string} payloadB64
 * @param {Array<Buffer|null|undefined>} keys
 */
async function decryptV1PayloadWithKeys(payloadB64, keys) {
    let lastErr;
    for (const kb of keys) {
        if (!kb) continue;
        try {
            return await decryptWithKey(payloadB64, kb);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('Unable to decrypt stored ngen password');
}

function buildDecryptKeyChain() {
    /** @type {Array<Buffer|null>} */
    const keys = [];
    const primary = keyFromPrimaryEnv();
    if (primary) keys.push(primary);
    const oldK = keyFromOldEnv();
    if (oldK) keys.push(oldK);
    try {
        keys.push(getKeyFromJwtSecret());
    } catch (_) {
        /* JWT unset — skip legacy JWT decrypt */
    }
    return keys;
}

/**
 * SHA-256 hex of trimmed `NGEN_CREDENTIALS_KEY` for fingerprint / no-op deploy checks.
 * @returns {string}
 */
function getNgenPrimaryKeyFingerprint() {
    const raw = process.env.NGEN_CREDENTIALS_KEY;
    if (!raw || String(raw).trim() === '') return '';
    return nodeCrypto.createHash('sha256').update(String(raw).trim(), 'utf8').digest('hex');
}

/**
 * @param {string} plaintext
 * @returns {Promise<string>} Version-prefixed AES-GCM ciphertext.
 */
async function encryptPassword(plaintext) {
    if (plaintext == null || plaintext === '') return '';
    const keyBytes = getEncryptPrimaryKeyBytes();
    return ENCRYPTED_PREFIX + (await encryptWithKey(String(plaintext), keyBytes));
}

/**
 * @param {string} stored
 * @returns {Promise<string>}
 */
async function decryptPassword(stored) {
    if (stored == null || stored === '') return '';
    const s = String(stored);
    if (s.startsWith(ENCRYPTED_PREFIX)) {
        const payload = s.slice(ENCRYPTED_PREFIX.length);
        const chain = buildDecryptKeyChain();
        try {
            return await decryptV1PayloadWithKeys(payload, chain);
        } catch (_) {
            throw new Error('Unable to decrypt stored ngen password');
        }
    }
    const buf = Buffer.from(s, 'base64');
    if (buf.length >= IV_LEN + AUTH_TAG_LEN + 1) {
        const primary = keyFromPrimaryEnv();
        const oldK = keyFromOldEnv();
        const tryOrder = [primary, oldK];
        let jwtK = null;
        try {
            jwtK = getKeyFromJwtSecret();
        } catch (_) {
            jwtK = null;
        }
        if (jwtK) tryOrder.push(jwtK);
        for (const kb of tryOrder) {
            if (!kb) continue;
            try {
                return await decryptWithKey(s, kb);
            } catch (_) {
                /* next */
            }
        }
    }
    return s;
}

module.exports = {
    encryptPassword,
    decryptPassword,
    getNgenPrimaryKeyFingerprint,
};
