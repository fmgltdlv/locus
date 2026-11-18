/**
 * Shared operator-response comment display (Ticket Hub + map popup).
 * Dedup portal comment vs catalog / codeDescription; merge provider history notes.
 */
(function (global) {
    'use strict';

    function parseTimeMs(dateStr) {
        if (!dateStr) return -1;
        const ms = Date.parse(dateStr);
        return Number.isFinite(ms) ? ms : -1;
    }

    /**
     * @param {object|null|undefined} ticket
     * @param {string|number|null|undefined} authorityId
     * @returns {string|null}
     */
    function latestProviderNotesFromHistory(ticket, authorityId) {
        const aid = authorityId != null ? String(authorityId).trim() : '';
        if (!aid) return null;
        const legacyHistoryKey = 'ng' + 'enResponseHistory';
        const h = ticket && (ticket.providerResponseHistory || ticket[legacyHistoryKey]);
        const utils = h && h.normalized && Array.isArray(h.normalized.utilities) ? h.normalized.utilities : null;
        if (!utils || !utils.length) return null;
        const u = utils.find((x) => x && String(x.authorityId) === aid);
        if (!u || u.error || !Array.isArray(u.entries) || u.entries.length === 0) return null;
        let best = null;
        let bestMs = -1;
        for (let i = 0; i < u.entries.length; i++) {
            const ent = u.entries[i];
            if (!ent) continue;
            const ms = parseTimeMs(ent.at);
            if (ms >= bestMs) {
                bestMs = ms;
                best = ent;
            }
        }
        if (!best) return null;
        if (best.notesComment != null && String(best.notesComment).trim() !== '') {
            return String(best.notesComment).trim();
        }
        return null;
    }

    function catalogDescription(statusCode) {
        if (typeof global.lookupOperatorResponseCodeCatalogDescription === 'function') {
            return global.lookupOperatorResponseCodeCatalogDescription(statusCode);
        }
        return null;
    }

    /**
     * @param {object|null|undefined} ticket
     * @param {object|null|undefined} response
     * @returns {{ portalComment: string|null, providerNotes: string|null, showPortalComment: boolean }}
     */
    function resolveOperatorResponseComments(ticket, response) {
        const portalText =
            response && response.comment != null && String(response.comment).trim() !== ''
                ? String(response.comment).trim()
                : '';
        const codeDescriptionExplicit =
            response && response.codeDescription != null && String(response.codeDescription).trim() !== ''
                ? String(response.codeDescription).trim()
                : '';
        const catalogDesc = catalogDescription(response && response.statusCode);
        const providerNotes = latestProviderNotesFromHistory(ticket, response && response.authorityId);
        const differsFromCatalog =
            catalogDesc != null && catalogDesc !== '' && portalText !== String(catalogDesc).trim();
        const differsFromExplicit =
            codeDescriptionExplicit !== '' && portalText !== codeDescriptionExplicit;
        const noDescriptionSources = !catalogDesc && !codeDescriptionExplicit;
        const showPortalComment =
            !!portalText && (noDescriptionSources || differsFromCatalog || differsFromExplicit);
        const aid = response && response.authorityId != null ? String(response.authorityId).trim() : '';
        const missingAuthorityId = !aid;
        return {
            portalComment: showPortalComment ? portalText : null,
            providerNotes: providerNotes || null,
            showPortalComment,
            missingAuthorityId,
        };
    }

    /**
     * @param {function(string): string} escapeFn
     * @param {object|null|undefined} ticket
     * @param {object|null|undefined} response
     * @returns {string}
     */
    function formatOperatorResponseCommentsHtml(escapeFn, ticket, response) {
        const emDash =
            global.TICKET_HUB_TEXT && global.TICKET_HUB_TEXT.EM_DASH != null
                ? global.TICKET_HUB_TEXT.EM_DASH
                : '—';
        const { portalComment, providerNotes, missingAuthorityId } = resolveOperatorResponseComments(ticket, response);
        if (portalComment) {
            let html = escapeFn(portalComment);
            if (providerNotes) html += '<br>' + escapeFn(providerNotes);
            return html;
        }
        if (providerNotes) return escapeFn(providerNotes);
        if (missingAuthorityId) {
            return `<span class="ticket-hub-muted" title="Utility ID unavailable — history comments cannot be matched">${
                typeof escapeFn === 'function' ? escapeFn(emDash) : emDash
            }</span>`;
        }
        const historyLoading =
            (typeof global.isNgenProviderResponseHistoryLoadPending === 'function' &&
                global.isNgenProviderResponseHistoryLoadPending(ticket)) ||
            (ticket && ticket.ngenResponseHistoryStatus === 'loading');
        if (historyLoading) {
            return '<span class="ticket-responses-comments-loading" aria-busy="true">Loading comments…</span>';
        }
        return emDash;
    }

    /**
     * Plain text for map popup / tooltips (portal + provider notes, newline-separated).
     * @param {object|null|undefined} ticket
     * @param {object|null|undefined} response
     * @returns {string|null}
     */
    function formatOperatorResponseCommentsPlain(ticket, response) {
        const { portalComment, providerNotes } = resolveOperatorResponseComments(ticket, response);
        const parts = [];
        if (portalComment) parts.push(portalComment);
        if (providerNotes) parts.push(providerNotes);
        return parts.length ? parts.join('\n') : null;
    }

    global.resolveOperatorResponseComments = resolveOperatorResponseComments;
    global.formatOperatorResponseCommentsHtml = formatOperatorResponseCommentsHtml;
    global.formatOperatorResponseCommentsPlain = formatOperatorResponseCommentsPlain;
})(typeof window !== 'undefined' ? window : globalThis);
