/**
 * Extract display fields from PAC GetEnquiryBySubset job rows (Pelican property names vary by version).
 */

function firstNonEmptyString(...vals) {
    for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v == null) continue;
        const s = String(v).trim();
        if (s !== '') return s;
    }
    return null;
}

/**
 * @param {object|null|undefined} pacJobRow
 * @returns {string|null}
 */
function pickCreatedByFromPacJobRow(pacJobRow) {
    if (!pacJobRow || typeof pacJobRow !== 'object') return null;
    return firstNonEmptyString(
        pacJobRow.TextCreatedBy,
        pacJobRow.textCreatedBy,
        pacJobRow.CreatedBy,
        pacJobRow.createdBy,
        pacJobRow.Text_Created_By,
        pacJobRow.text_created_by
    );
}

module.exports = {
    pickCreatedByFromPacJobRow,
};
