/**
 * On-device USAN confirmation / Full history PDF cache (IndexedDB usanDocs).
 */
(function () {
    'use strict';

    var MAX_BLOB_BUDGET_BYTES = 200 * 1024 * 1024;

    function store() {
        return window.offlineStore || null;
    }

    function resolveTicketBase(ticket) {
        if (!ticket) return '';
        if (ticket.ticketBaseNumber != null && String(ticket.ticketBaseNumber).trim() !== '') {
            return String(ticket.ticketBaseNumber).trim();
        }
        var full =
            (ticket.ticketNumberFull && String(ticket.ticketNumberFull).trim()) ||
            (ticket.ticketNumber && String(ticket.ticketNumber).trim()) ||
            '';
        var idx = full.indexOf('-');
        return idx === -1 ? full : full.slice(0, idx);
    }

    function resolveRevision(ticket) {
        if (!ticket) return '';
        if (ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== '') {
            return String(ticket.ticketRevision).trim();
        }
        var full =
            (ticket.ticketNumberFull && String(ticket.ticketNumberFull).trim()) ||
            (ticket.ticketNumber && String(ticket.ticketNumber).trim()) ||
            '';
        var idx = full.indexOf('-');
        return idx === -1 ? '' : full.slice(idx + 1);
    }

    async function withinBudget(extraBytes) {
        var s = store();
        if (!s || typeof s.estimateBlobBytes !== 'function') return true;
        try {
            var bytes = await s.estimateBlobBytes();
            return bytes + (extraBytes || 0) <= MAX_BLOB_BUDGET_BYTES;
        } catch (_e) {
            return true;
        }
    }

    async function putConfirmation(orgId, ticketBase, revision, blob, meta) {
        var s = store();
        if (!s || !blob) return false;
        var key = s.usanDocConfirmationKey(orgId, ticketBase, revision);
        if (!(await withinBudget(blob.size || 0))) {
            console.warn('[offlineUsanDocs] blob budget full; skip confirmation cache');
            return false;
        }
        try {
            await s.putUsanDoc(key, blob, Object.assign({ kind: 'confirmation', revision: revision }, meta || {}));
            return true;
        } catch (e) {
            console.warn('[offlineUsanDocs] put confirmation:', e && e.message ? e.message : e);
            return false;
        }
    }

    async function getConfirmation(orgId, ticketBase, revision) {
        var s = store();
        if (!s) return null;
        try {
            return await s.getUsanDoc(s.usanDocConfirmationKey(orgId, ticketBase, revision));
        } catch (e) {
            console.warn('[offlineUsanDocs] get confirmation:', e && e.message ? e.message : e);
            return null;
        }
    }

    async function putFullHistory(orgId, ticketBase, blob, meta) {
        var s = store();
        if (!s || !blob) return false;
        var key = s.usanDocFullHistoryKey(orgId, ticketBase);
        if (!(await withinBudget(blob.size || 0))) {
            console.warn('[offlineUsanDocs] blob budget full; skip full-history cache');
            return false;
        }
        try {
            await s.putUsanDoc(key, blob, Object.assign({ kind: 'full-history' }, meta || {}));
            return true;
        } catch (e) {
            console.warn('[offlineUsanDocs] put full-history:', e && e.message ? e.message : e);
            return false;
        }
    }

    async function getFullHistory(orgId, ticketBase) {
        var s = store();
        if (!s) return null;
        try {
            return await s.getUsanDoc(s.usanDocFullHistoryKey(orgId, ticketBase));
        } catch (e) {
            console.warn('[offlineUsanDocs] get full-history:', e && e.message ? e.message : e);
            return null;
        }
    }

    /**
     * List cached confirmation revisions for a ticket base.
     * @returns {Promise<string[]>}
     */
    async function listCachedConfirmationRevisions(orgId, ticketBase) {
        var s = store();
        if (!s || typeof s.listUsanDocKeysWithPrefix !== 'function') return [];
        var prefix = s.usanDocConfirmationKey(orgId, ticketBase, '');
        // key ends with confirmation: — strip trailing empty revision
        prefix = prefix.replace(/:$/, ':');
        try {
            var keys = await s.listUsanDocKeysWithPrefix(prefix);
            var revs = [];
            var marker = ':confirmation:';
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var idx = k.lastIndexOf(marker);
                if (idx === -1) continue;
                var rev = k.slice(idx + marker.length);
                if (rev) revs.push(rev);
            }
            revs.sort();
            return revs;
        } catch (e) {
            console.warn('[offlineUsanDocs] list confirmations:', e && e.message ? e.message : e);
            return [];
        }
    }

    window.offlineUsanDocs = {
        resolveTicketBase: resolveTicketBase,
        resolveRevision: resolveRevision,
        putConfirmation: putConfirmation,
        getConfirmation: getConfirmation,
        putFullHistory: putFullHistory,
        getFullHistory: getFullHistory,
        listCachedConfirmationRevisions: listCachedConfirmationRevisions,
    };
})();
