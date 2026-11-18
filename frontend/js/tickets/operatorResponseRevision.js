/**
 * Revision-scoped operator response rows (#168).
 * History tab uses raw operatorResponses; popup/hub/ack use filtered rows only.
 */
(function () {
    function normalizeRevisionToken(rev) {
        if (rev == null) return '';
        return String(rev).trim().toUpperCase();
    }

    function revisionsMatch(a, b) {
        const sa = normalizeRevisionToken(a);
        const sb = normalizeRevisionToken(b);
        if (!sa || !sb) return false;
        if (sa === sb) return true;
        const stripLeading = function (s) {
            const t = s.replace(/^0+/, '');
            return t || '0';
        };
        if (/^\d+$/.test(stripLeading(sa)) && /^\d+$/.test(stripLeading(sb))) {
            return stripLeading(sa) === stripLeading(sb);
        }
        return false;
    }

    function resolveTicketCurrentRevisionForOperatorFilter(ticket) {
        if (!ticket || typeof ticket !== 'object') return '';
        if (ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== '') {
            return String(ticket.ticketRevision).trim();
        }
        const mod = window.ticketDocumentPackFlowModule;
        if (mod && typeof mod.resolveCurrentRevision === 'function') {
            const rev = mod.resolveCurrentRevision(ticket);
            return rev != null ? String(rev).trim() : '';
        }
        return '';
    }

    function filterOperatorResponsesForCurrentRevision(ticket, responses) {
        if (!Array.isArray(responses) || !responses.length) return [];
        const current = resolveTicketCurrentRevisionForOperatorFilter(ticket);
        if (!current) return responses.slice();
        return responses.filter(function (r) {
            const snap =
                r && r.ticketRevisionSnapshot != null ? String(r.ticketRevisionSnapshot).trim() : '';
            if (!snap) return true;
            return revisionsMatch(snap, current);
        });
    }

    window.operatorResponseRevisionModule = {
        revisionsMatch,
        resolveTicketCurrentRevisionForOperatorFilter,
        filterOperatorResponsesForCurrentRevision,
    };
})();
