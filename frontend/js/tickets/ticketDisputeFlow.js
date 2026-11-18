/**
 * Dispute operator notification flow.
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
            if (typeof global.appAlert === 'function') void global.appAlert('Dispute is not enabled.');
            return;
        }
        if (!ticket || ticket.shared) return;
        if (!truthyFlag(ticket.canBeDisputed)) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert('Dispute is not available for this ticket.');
            }
            return;
        }
        const shared = global.ticketOperatorSubmitShared;
        if (!shared || typeof shared.openOperatorSubmitOverlay !== 'function') return;
        shared.openOperatorSubmitOverlay({
            title: 'Dispute',
            subtitle: 'Dispute an operator response on ticket <strong>' + String(ticket.ticketNumber || '') + '</strong>.',
            ticket: ticket,
            submitLabel: 'Submit dispute',
            showFaultToggle: false,
            confirmMessage: 'Submit this dispute notification to USAN?',
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
                    operation: 'disputed',
                    ticketNumber: tn,
                    text: payload.text,
                    authorityIds: payload.authorityIds,
                    toastMessage: 'Submitting dispute to USAN in the background',
                });
            },
        });
    }

    global.ticketDisputeFlow = { openFromTicket: openFromTicket };
})(typeof window !== 'undefined' ? window : globalThis);
