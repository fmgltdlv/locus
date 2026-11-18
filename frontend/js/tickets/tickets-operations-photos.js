/**
 * tickets-operations-photos.js — delete ticket (dev) and related ops helpers.
 * Globals: same window/function names as before (IIFE bundle).
 */

// Delete ticket (Dev only)
async function deleteTicket(ticketNumber, organizationIdOverride, ticketIdOverride, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!window.authModule || !window.authModule.isDev()) {
        await appAlert('Only developers can delete tickets.');
        return false;
    }

    if (!opts.skipConfirm) {
        if (!(await appConfirm(`Are you sure you want to delete ticket #${ticketNumber}? This action cannot be undone.`))) {
            return false;
        }
    }

    const ticketToDelete = window.ORG_TICKETS?.find(t =>
        ticketIdOverride != null ? ticketIdEquals(t.id, ticketIdOverride) : t.ticketNumber === ticketNumber
    );
    const ticketIdToDelete = ticketToDelete?.id;
    
    try {
        const orgId =
            organizationIdOverride != null && organizationIdOverride !== ''
                ? organizationIdOverride
                : window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
                  ? window.orgSelectorModule.getCurrentOrgId()
                  : window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId;
        const orgQs =
            orgId != null && orgId !== ''
                ? `?organizationId=${encodeURIComponent(String(orgId))}`
                : '';
        await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/tickets/${encodeURIComponent(ticketNumber)}${orgQs}`,
            {
                method: 'DELETE',
            }
        );
        
        // Remove from local array
        if (window.ORG_TICKETS) {
            window.ORG_TICKETS = window.ORG_TICKETS.filter(t =>
                ticketIdToDelete != null ? !ticketIdEquals(t.id, ticketIdToDelete) : t.ticketNumber !== ticketNumber
            );
        }
        
        // Clear selected ticket if it was the deleted one
        if (ticketIdEquals(selectedTicketId, ticketIdToDelete)) {
            selectedTicketId = null;
            // Close popup if open
            const popup = document.getElementById('ticketPopup');
            if (popup) {
                popup.style.display = 'none';
            }
        }
        
        // Re-render tickets
        if (window.ticketsModule && window.ticketsModule.renderTickets) {
            window.ticketsModule.renderTickets();
        }
        
        // Re-render ticket list
        renderTicketList();

        if (window.ticketHubModule && typeof window.ticketHubModule.handleTicketDeleted === 'function') {
            window.ticketHubModule.handleTicketDeleted(ticketIdToDelete);
        }

        refreshTicketsOrgCacheSnapshot(orgId);
        if (!opts.skipSuccessAlert) {
            await appAlert('Ticket deleted successfully');
        }
        return true;
    } catch (error) {
        console.error('Error deleting ticket:', error);
        if (!opts.skipSuccessAlert) {
            await appAlert(`Error deleting ticket: ${error.message}`);
        }
        // Even if server deletion fails, remove from local array if it was a client-side issue
        if (window.ORG_TICKETS) {
            window.ORG_TICKETS = window.ORG_TICKETS.filter(t => t.ticketNumber !== ticketNumber);
            renderTicketList();
            if (window.ticketsModule && window.ticketsModule.renderTickets) {
                window.ticketsModule.renderTickets();
            }
            if (window.ticketHubModule && typeof window.ticketHubModule.handleTicketDeleted === 'function') {
                window.ticketHubModule.handleTicketDeleted(ticketIdToDelete);
            }
        }
        return false;
    }
}
