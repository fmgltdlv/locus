/**
 * Public offline module facade (window.offlineModule).
 */
(function () {
    'use strict';

    window.offlineModule = {
        isOnline: function () {
            return window.offlineConnectivity && window.offlineConnectivity.isOnline
                ? window.offlineConnectivity.isOnline()
                : true;
        },
        isNetworkError: function (err) {
            return window.offlineConnectivity && window.offlineConnectivity.isNetworkError
                ? window.offlineConnectivity.isNetworkError(err)
                : false;
        },
        onConnectivityChange: function (cb) {
            return window.offlineConnectivity && window.offlineConnectivity.onConnectivityChange
                ? window.offlineConnectivity.onConnectivityChange(cb)
                : function () {};
        },
        refreshBanner: function () {
            if (window.offlineUi && window.offlineUi.refreshBanner) window.offlineUi.refreshBanner();
        },
        guardOfflineAction: function (msg) {
            return window.offlineUi && window.offlineUi.guardOfflineAction
                ? window.offlineUi.guardOfflineAction(msg)
                : false;
        },
        shouldDisableMutations: function () {
            return window.offlineUi && window.offlineUi.shouldDisableMutations
                ? window.offlineUi.shouldDisableMutations()
                : false;
        },
        flushAllOutboxes: function () {
            if (window.offlineSync && window.offlineSync.flushAllOutboxes) {
                return window.offlineSync.flushAllOutboxes();
            }
            return Promise.resolve();
        },
        hydrateTicketsFromIdb: function (orgId) {
            if (window.offlineTickets && window.offlineTickets.hydrateOrgTicketsFromIdb) {
                return window.offlineTickets.hydrateOrgTicketsFromIdb(orgId);
            }
            return Promise.resolve(false);
        },
        persistTicketsSnapshot: function (orgId, tickets, hubUsernames) {
            if (window.offlineTickets && window.offlineTickets.persistTicketsOrgSnapshot) {
                return window.offlineTickets.persistTicketsOrgSnapshot(orgId, tickets, hubUsernames);
            }
            return Promise.resolve();
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            if (window.offlineStore && window.offlineStore.purgeExpiredCaches) {
                void window.offlineStore.purgeExpiredCaches();
            }
            if (window.offlineUi && window.offlineUi.refreshBanner) window.offlineUi.refreshBanner();
        });
    } else {
        if (window.offlineStore && window.offlineStore.purgeExpiredCaches) {
            void window.offlineStore.purgeExpiredCaches();
        }
        if (window.offlineUi && window.offlineUi.refreshBanner) window.offlineUi.refreshBanner();
    }
})();
