'use strict';

function normalizeRevisionToken(rev) {
    if (rev == null) return '';
    return String(rev).trim().toUpperCase();
}

function revisionsMatch(a, b) {
    const sa = normalizeRevisionToken(a);
    const sb = normalizeRevisionToken(b);
    if (!sa || !sb) return false;
    if (sa === sb) return true;
    const stripLeading = (s) => {
        const t = s.replace(/^0+/, '');
        return t || '0';
    };
    if (/^\d+$/.test(stripLeading(sa)) && /^\d+$/.test(stripLeading(sb))) {
        return stripLeading(sa) === stripLeading(sb);
    }
    return false;
}

function filterOperatorResponsesForCurrentRevision(ticket, responses) {
    if (!Array.isArray(responses) || !responses.length) return [];
    const rev =
        ticket && ticket.ticketRevision != null ? String(ticket.ticketRevision).trim() : '';
    if (!rev) return responses;
    return responses.filter((r) => {
        const snap = r && r.ticketRevisionSnapshot != null ? String(r.ticketRevisionSnapshot).trim() : '';
        if (!snap) return true;
        return revisionsMatch(snap, rev);
    });
}

module.exports = {
    normalizeRevisionToken,
    revisionsMatch,
    filterOperatorResponsesForCurrentRevision,
};
