// Ticket refresh — split from former monolithic refresh.ts (Phase 1)

export {
    mergeRefreshedTicketDataForSibling,
    upsertSiblingPacwebEnrichmentJobNumber,
    fanoutRefreshedTicketToSiblingRows,
} from './refreshFanout.js';

export {
    resolveJobNumberFromPacwebEnrichmentRow,
    resolveJobNumberFromTicketDbRow,
    resolveNgenJobNumberForTicket,
    upsertPacwebEnrichmentJobNumber,
    resolveNgenJobNumberFromPacJobRow,
    fetchPacPollEnquirySearch,
    findLatestNgenRevisionForBase,
    resolveJobNumberFromTicketData,
    canSkipRevisionFollowForLiteRefresh,
    runBackgroundOrgSyncAfterTicketRefresh,
    fetchNgenNotificationHistoryForTicket,
    ensureNgenNotificationHistoryForTicket,
    resolveNgenHistoryRequestNumber,
    mergeNgenNotificationHistoryIntoTicketData,
    runNgenEnquiryRefreshIfConfigured,
    runBackgroundPersistAfterLiteRefresh,
    finalizeMergedTicketForClient,
    runNgenEnquiryRefreshIfConfiguredWithTimeout,
} from './refreshNgen.js';

export { registerTicketsRefreshRoutes } from './refreshRoutes.js';
