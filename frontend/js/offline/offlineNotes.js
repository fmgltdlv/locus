/**
 * Offline ticket notes cache and outbox.
 */
(function () {
    'use strict';

    var flushInFlight = null;

    function newClientNoteId() {
        if (typeof generateUuid === 'function') return generateUuid();
        return 'offline-note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function resolveOrgId(ticket) {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            return window.orgSelectorModule.getCurrentOrgId();
        }
        var u = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        return (ticket && ticket.organizationId != null ? ticket.organizationId : null) || (u && u.organizationId);
    }

    async function cacheTicketNotes(orgId, ticketNumber, notes, reviewRequired) {
        if (!window.offlineStore) return;
        try {
            await window.offlineStore.putTicketNotes(orgId, ticketNumber, notes, reviewRequired);
        } catch (e) {
            console.warn('[offlineNotes] cache:', e.message || e);
        }
    }

    async function getCachedTicketNotes(orgId, ticketNumber) {
        if (!window.offlineStore) return null;
        try {
            return await window.offlineStore.getTicketNotes(orgId, ticketNumber);
        } catch (_e) {
            return null;
        }
    }

    async function listPendingNotesForTicket(orgId, ticketNumber) {
        if (!window.offlineStore) return [];
        var tn = String(ticketNumber || '').trim();
        var all = await window.offlineStore.listPendingNotes();
        return all.filter(function (n) {
            return Number(n.orgId) === Number(orgId) && String(n.ticketNumber || '').trim() === tn;
        });
    }

    async function enqueuePendingNote(ticket, body) {
        if (!window.offlineStore || !ticket) return null;
        var orgId = resolveOrgId(ticket);
        var tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn || !body) return null;
        var user = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        var displayName =
            (user && user.fullName && String(user.fullName).trim()) ||
            (user && user.username) ||
            (user && user.email) ||
            'You';
        var clientNoteId = newClientNoteId();
        var entry = {
            orgId: orgId,
            ticketNumber: tn,
            body: String(body).trim(),
            createdAt: new Date().toISOString(),
            userDisplayName: displayName,
        };
        await window.offlineStore.putPendingNote(clientNoteId, entry);
        if (window.offlineUi && window.offlineUi.updateAccountMenuPendingLabel) {
            window.offlineUi.updateAccountMenuPendingLabel();
        }
        return { clientNoteId: clientNoteId, entry: entry };
    }

    function pendingNoteToDisplayRow(entry, clientNoteId) {
        return {
            id: 'pending-' + clientNoteId,
            userName: entry.userDisplayName || 'You',
            body: entry.body,
            createdAt: entry.createdAt,
            pendingSync: true,
        };
    }

    function flushPendingTicketNotes() {
        if (flushInFlight) return flushInFlight;
        flushInFlight = (async function () {
            if (!window.offlineStore || !window.authModule || !window.authModule.apiRequest) return;
            var conn = window.offlineConnectivity;
            if (conn && !conn.isOnline()) return;
            var list = await window.offlineStore.listPendingNotes();
            for (var i = 0; i < list.length; i++) {
                var row = list[i];
                try {
                    await window.authModule.apiRequest(
                        window.authModule.API_BASE +
                            '/tickets/' +
                            encodeURIComponent(row.ticketNumber) +
                            '/notes',
                        {
                            method: 'POST',
                            body: JSON.stringify({
                                body: row.body,
                                organizationId: row.orgId,
                                clientNoteId: row.clientNoteId,
                            }),
                        }
                    );
                    await window.offlineStore.removePendingNote(row.clientNoteId);
                } catch (err) {
                    console.warn('[offlineNotes] flush:', err.message || err);
                }
            }
            if (window.offlineUi && window.offlineUi.updateAccountMenuPendingLabel) {
                window.offlineUi.updateAccountMenuPendingLabel();
            }
        })().finally(function () {
            flushInFlight = null;
        });
        return flushInFlight;
    }

    window.offlineNotes = {
        cacheTicketNotes: cacheTicketNotes,
        getCachedTicketNotes: getCachedTicketNotes,
        listPendingNotesForTicket: listPendingNotesForTicket,
        enqueuePendingNote: enqueuePendingNote,
        pendingNoteToDisplayRow: pendingNoteToDisplayRow,
        flushPendingTicketNotes: flushPendingTicketNotes,
        newClientNoteId: newClientNoteId,
    };
})();
