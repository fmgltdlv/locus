/**
 * Build a conservative FTS5 MATCH string for SQLite (unicode61 tokenizer).
 * Tokens are ANDed; each token is a double-quoted phrase to limit injection of FTS operators.
 *
 * @param {string} raw
 * @param {{ maxInputLength?: number, maxTokens?: number }} [opts]
 * @returns {string|null} null if nothing to search
 */
function buildAndQuotedTokenFtsQuery(raw, opts) {
    const maxInputLength = opts && opts.maxInputLength != null ? opts.maxInputLength : 200;
    const maxTokens = opts && opts.maxTokens != null ? opts.maxTokens : 12;
    const s = String(raw || '')
        .trim()
        .slice(0, maxInputLength);
    if (!s) return null;
    const tokens = s.split(/\s+/).filter(Boolean).slice(0, maxTokens);
    if (tokens.length === 0) return null;
    return tokens
        .map((tok) => {
            const escaped = tok.replace(/"/g, '""');
            return `"${escaped}"`;
        })
        .join(' AND ');
}

module.exports = {
    buildAndQuotedTokenFtsQuery,
};
