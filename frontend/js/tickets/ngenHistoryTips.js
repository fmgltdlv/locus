/**
 * Client-side enquiry tip fingerprints — must match Worker `ngenHistoryTips.cjs`.
 * Tip = statusCode + respondedAt + comment, keyed by authorityId.
 */
(function () {
    'use strict';

    function tipText(value) {
        if (value == null) return '';
        return String(value).trim();
    }

    function buildNgenHistoryTipFingerprint(row) {
        if (!row || typeof row !== 'object') return '';
        return [tipText(row.statusCode), tipText(row.respondedAt), tipText(row.comment)].join('\u001f');
    }

    function tipsByAuthorityFromOperatorResponses(operatorResponses) {
        const out = {};
        if (!Array.isArray(operatorResponses)) return out;
        for (const row of operatorResponses) {
            if (!row || typeof row !== 'object') continue;
            const aid = tipText(row.authorityId);
            if (!aid) continue;
            out[aid] = buildNgenHistoryTipFingerprint(row);
        }
        return out;
    }

    /**
     * True when in-memory ngenResponseHistory can be reused without POST.
     * @param {object|null|undefined} history
     * @param {unknown} operatorResponses
     * @param {string|null|undefined} currentRequestNumber
     * @returns {boolean}
     */
    function ngenResponseHistoryTipsMatchTicket(history, operatorResponses, currentRequestNumber) {
        if (!history || typeof history !== 'object') return false;
        const tipByAuthority = history.tipByAuthority;
        if (!tipByAuthority || typeof tipByAuthority !== 'object') return false;
        const currentTips = tipsByAuthorityFromOperatorResponses(operatorResponses);
        const currentAids = Object.keys(currentTips);
        if (currentAids.length === 0) return false;

        const histRn = tipText(history.requestNumber) || null;
        const curRn = tipText(currentRequestNumber) || null;
        if (histRn && curRn && histRn !== curRn) return false;

        for (let i = 0; i < currentAids.length; i++) {
            const aid = currentAids[i];
            if (tipText(tipByAuthority[aid]) !== tipText(currentTips[aid])) return false;
        }
        return true;
    }

    window.ngenHistoryTips = {
        buildNgenHistoryTipFingerprint,
        tipsByAuthorityFromOperatorResponses,
        ngenResponseHistoryTipsMatchTicket,
    };
})();
