/**
 * Safely parse JSON that may be a string or already an object.
 * Handles double-encoded strings (e.g. stringified twice).
 * @param {string|object|null|undefined} raw - Value to parse
 * @param {*} [defaultVal=null] - Value to return on parse failure or non-object result
 * @returns {object|null|*} Parsed object or defaultVal
 */
function safeParseJSON(raw, defaultVal = null) {
    if (raw == null) return defaultVal;
    try {
        let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        return parsed && typeof parsed === 'object' ? parsed : defaultVal;
    } catch (e) {
        return defaultVal;
    }
}

module.exports = { safeParseJSON };
