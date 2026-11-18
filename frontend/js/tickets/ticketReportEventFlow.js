/**
 * Report Event flow — Exposed / Damage USAN operator notifications, or Internal Core-only DIRT form.
 */
(function (global) {
    'use strict';

    const TYPE_OVERLAY_ID = 'ticketReportEventTypeOverlay';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function truthyFlag(v) {
        const shared = global.ticketOperatorSubmitShared;
        if (shared && typeof shared.truthyFlag === 'function') return shared.truthyFlag(v);
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function hubEnabled() {
        return typeof global.isTicketRenewalHubEnabled === 'function' && global.isTicketRenewalHubEnabled();
    }

    function canBeExposed(ticket) {
        return truthyFlag(ticket && ticket.canBeExposed);
    }

    function canBeDamage(ticket) {
        return truthyFlag(ticket && ticket.canBeDamage);
    }

    function shouldShowReportEventButton(ticket) {
        if (!ticket) return false;
        if (!hubEnabled()) return true;
        if (ticket.shared) return false;
        return canBeExposed(ticket) || canBeDamage(ticket) || true;
    }

    function closeTypeOverlay() {
        const x = document.getElementById(TYPE_OVERLAY_ID);
        if (x) x.remove();
    }

    async function logDirtStub(ticket) {
        if (typeof global.reportEventForTicket !== 'function') return;
        try {
            await global.reportEventForTicket(ticket, { skipTicketPopup: true, usanOnlyStub: true });
        } catch (_e) {
            /* audit trail optional */
        }
    }

    function openInternalReportForm(ticket) {
        closeTypeOverlay();
        if (!ticket) {
            if (typeof global.appAlert === 'function') void global.appAlert('No ticket selected.');
            return;
        }
        if (typeof global.selectTicket === 'function' && ticket.id != null) {
            global.selectTicket(ticket.id);
        }
        global.dirtReportReportType = 'internal';
        if (typeof global.openDirtReportModal === 'function') {
            void global.openDirtReportModal();
        } else if (typeof global.appAlert === 'function') {
            void global.appAlert('Report form is not available. Please refresh the page.');
        }
    }

    function openExposedOrDamageForm(ticket, type) {
        const shared = global.ticketOperatorSubmitShared;
        if (!shared || typeof shared.openOperatorSubmitOverlay !== 'function') return;
        const operation = type === 'damage' ? 'damage' : 'exposed';
        const title = type === 'damage' ? 'Report damage' : 'Report exposed facility';
        shared.openOperatorSubmitOverlay({
            title: title,
            subtitle:
                'Notify utility operators (USAN) for ticket <strong>' +
                esc(ticket.ticketNumber || '') +
                '</strong>. Scope of work is copied from the ticket.',
            ticket: ticket,
            submitLabel: type === 'damage' ? 'Report damage' : 'Report exposed',
            showFaultToggle: type === 'damage',
            confirmMessage:
                type === 'damage'
                    ? 'Submit this damage notification to USAN?'
                    : 'Submit this exposed facility notification to USAN?',
            onSubmit: async function (payload) {
                const orgId =
                    global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                        ? global.orgSelectorModule.getCurrentOrgId()
                        : null;
                if (orgId == null || orgId === '') {
                    if (typeof global.appAlert === 'function') void global.appAlert('Select an organization first.');
                    throw new Error('no org');
                }
                const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
                if (!tn) {
                    if (typeof global.appAlert === 'function') void global.appAlert('Ticket number is missing.');
                    throw new Error('no tn');
                }
                await shared.submitOperatorSubmitJob({
                    organizationId: Number(orgId),
                    operation: operation,
                    ticketNumber: tn,
                    text: payload.text,
                    authorityIds: payload.authorityIds,
                    isOperatorFault: payload.isOperatorFault,
                    toastMessage:
                        type === 'damage'
                            ? 'Reporting damage to USAN in the background'
                            : 'Reporting exposed facility to USAN in the background',
                });
                void logDirtStub(ticket);
            },
        });
    }

    function openTypePicker(ticket) {
        const exposed = canBeExposed(ticket);
        const damage = canBeDamage(ticket);
        closeTypeOverlay();
        const wrap = document.createElement('div');
        wrap.id = TYPE_OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');

        const internalTypeBtn =
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary ticket-report-event-type-btn" data-report-type="internal">Internal</button>';

        let bodyHtml = '';
        if (!exposed && !damage) {
            bodyHtml =
                '<p class="ticket-hub-mock-hint">Exposed and Damage notifications are not available for this ticket right now.</p>' +
                '<p class="ticket-hub-mock-hint">You can still log an internal event in Locus or open the USAN portal.</p>' +
                '<div class="ticket-report-event-type-list">' +
                internalTypeBtn +
                '</div>' +
                '<div class="ticket-hub-mock-footer">' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-report-event-dismiss>Close</button>' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-report-event-portal>Open USAN portal</button>' +
                '</div>';
        } else {
            bodyHtml =
                '<p class="ticket-hub-mock-hint">Choose the notification type for ticket <strong>' +
                esc(ticket.ticketNumber || '') +
                '</strong>.</p>' +
                '<div class="ticket-report-event-type-list">' +
                (exposed
                    ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary ticket-report-event-type-btn" data-report-type="exposed">Exposed facility</button>'
                    : '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" disabled title="Exposed notification not available">Exposed facility</button>') +
                (damage
                    ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary ticket-report-event-type-btn" data-report-type="damage">Damage</button>'
                    : '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" disabled title="Damage notification not available">Damage</button>') +
                internalTypeBtn +
                '</div>' +
                '<div class="ticket-hub-mock-footer">' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-report-event-dismiss>Cancel</button>' +
                '</div>';
        }

        wrap.innerHTML =
            '<div class="ticket-hub-mock-panel">' +
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Report Event</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            bodyHtml +
            '</div>';
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-report-event-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeTypeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeTypeOverlay();
        });

        const portalBtn = wrap.querySelector('[data-report-event-portal]');
        if (portalBtn) {
            portalBtn.addEventListener('click', function () {
                closeTypeOverlay();
                void (async function () {
                    await logDirtStub(ticket);
                    if (typeof global.openUsanNgenPortalForTicket === 'function') {
                        global.openUsanNgenPortalForTicket(ticket);
                    }
                    if (typeof global.refreshDataWindow === 'function') {
                        global.refreshDataWindow();
                    }
                })();
            });
        }
        wrap.querySelectorAll('[data-report-type]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const type = btn.getAttribute('data-report-type');
                if (type === 'internal') {
                    openInternalReportForm(ticket);
                    return;
                }
                closeTypeOverlay();
                openExposedOrDamageForm(ticket, type);
            });
        });
    }

    function openReportEventFromTicket(ticket) {
        if (!ticket) {
            if (typeof global.appAlert === 'function') void global.appAlert('No ticket selected.');
            return;
        }
        if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Report Event requires an internet connection.')) {
            return;
        }
        if (ticket.shared) {
            if (typeof global.appAlert === 'function') void global.appAlert('Report Event is not available on shared tickets.');
            return;
        }
        if (!hubEnabled()) {
            if (typeof global.reportEventForTicket === 'function') {
                void global.reportEventForTicket(ticket, { legacyOnly: true });
            }
            return;
        }
        openTypePicker(ticket);
    }

    global.ticketReportEventFlow = {
        shouldShowReportEventButton: shouldShowReportEventButton,
        openReportEventFromTicket: openReportEventFromTicket,
        canBeExposed: canBeExposed,
        canBeDamage: canBeDamage,
    };
})(typeof window !== 'undefined' ? window : globalThis);
