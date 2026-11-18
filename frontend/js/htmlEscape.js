/**
 * Safe string encoding for HTML templates and inline onclick handlers.
 * Load before table renderers (see frontend/build.mjs).
 */
function escapeHtmlText(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Attribute values (e.g. data-id, alt, title). */
function escapeHtmlAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

/** Single-quoted JavaScript string inside onclick="...'...'..." */
function escapeJsStringLiteral(s) {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

window.escapeHtmlText = escapeHtmlText;
window.escapeHtmlAttr = escapeHtmlAttr;
window.escapeJsStringLiteral = escapeJsStringLiteral;
