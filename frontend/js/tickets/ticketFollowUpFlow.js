/**
 * Follow Up operator notification flow.
 */
(function (global) {
    'use strict';

    function truthyFlag(v) {
        const shared = global.ticketOperatorSubmitShared;
        if (shared && typeof shared.truthyFlag === 'function') return shared.truthyFlag(v);
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function openFromTicket(ticket) {
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Follow Up is not enabled.');
            return;
        }
        if (!ticket || ticket.shared) return;
        if (!truthyFlag(ticket.canBeFollowUp)) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert('Follow Up is not available for this ticket.');
            }
            return;
        }
        const shared = global.ticketOperatorSubmitShared;
        if (!shared || typeof shared.openOperatorSubmitOverlay !== 'function') return;
        shared.openOperatorSubmitOverlay({
            title: 'Follow Up',
            subtitle: 'Ask operators a question about ticket <strong>' + String(ticket.ticketNumber || '') + '</strong>.',
            ticket: ticket,
            submitLabel: 'Send follow up',
            showFaultToggle: false,
            confirmMessage: 'Submit this follow-up notification to USAN?',
            onSubmit: async function (payload) {
                const orgId =
                    global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                        ? global.orgSelectorModule.getCurrentOrgId()
                        : null;
                if (orgId == null || orgId === '') throw new Error('no org');
                const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
                if (!tn) throw new Error('no tn');
                await shared.submitOperatorSubmitJob({
                    organizationId: Number(orgId),
                    operation: 'follow_up',
                    ticketNumber: tn,
                    text: payload.text,
                    authorityIds: payload.authorityIds,
                    toastMessage: 'Submitting follow up to USAN in the background',
                });
            },
        });
    }

    global.ticketFollowUpFlow = { openFromTicket: openFromTicket };
})(typeof window !== 'undefined' ? window : globalThis);
