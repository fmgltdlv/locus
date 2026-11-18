
export function registerUsanPollRoutes(tickets, postUsanPoll) {
    tickets.post('/usan-poll', postUsanPoll);
    tickets.post('/pacweb-poll', postUsanPoll);
}

export function registerTicketImportQueueRoutes(
    tickets,
    {
        getPacUnassignedImportQueue,
        deletePacUnassignedQueueEntry,
        postRetryAutoAssignPacUnassignedQueue,
        postAssignPacUnassignedQueue,
    }
) {
    tickets.get('/pac-import-queue', getPacUnassignedImportQueue);
    tickets.get('/ticket-import-queue', getPacUnassignedImportQueue);

    tickets.delete('/pac-import-queue/:queueId', deletePacUnassignedQueueEntry);
    tickets.delete('/ticket-import-queue/:queueId', deletePacUnassignedQueueEntry);

    tickets.post('/pac-import-queue/retry-auto', postRetryAutoAssignPacUnassignedQueue);
    tickets.post('/ticket-import-queue/retry-auto', postRetryAutoAssignPacUnassignedQueue);

    tickets.post('/pac-import-queue/:queueId/assign', postAssignPacUnassignedQueue);
    tickets.post('/ticket-import-queue/:queueId/assign', postAssignPacUnassignedQueue);
}
