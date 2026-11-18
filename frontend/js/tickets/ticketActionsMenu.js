/**
 * Ticket Actions dropdown — Renew, Remark, Amendment, Follow Up, Dispute, No Response.
 */
(function (global) {
    'use strict';

    const MENU_ROOT_CLASS = 'ticket-actions-menu';
    let openMenuEl = null;

    function esc(s) {
        if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function hubEnabled() {
        return typeof global.isTicketRenewalHubEnabled === 'function' && global.isTicketRenewalHubEnabled();
    }

    function shouldShowTicketActionsMenu(ticket) {
        if (!hubEnabled()) return false;
        if (!ticket || ticket.shared) return false;
        return true;
    }

    function isRenewMenuEnabled(ticket) {
        const renewFlow = global.ticketRenewalBulkFlow;
        return !!(
            renewFlow &&
            typeof renewFlow.shouldShowRenewButton === 'function' &&
            renewFlow.shouldShowRenewButton(ticket)
        );
    }

    function getRenewDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isRenewMenuEnabled(ticket)) return '';
        return 'Renewal is not available for this ticket.';
    }

    function truthyFlag(ticket, key) {
        const remarkFlow = global.ticketRemarkFlow;
        if (remarkFlow && typeof remarkFlow.truthyUsanTicketFlag === 'function') {
            return remarkFlow.truthyUsanTicketFlag(ticket && ticket[key]);
        }
        const v = ticket && ticket[key];
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function isFollowUpMenuEnabled(ticket) {
        return truthyFlag(ticket, 'canBeFollowUp');
    }

    function getFollowUpDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isFollowUpMenuEnabled(ticket)) return '';
        return 'Follow Up is not available for this ticket.';
    }

    function isDisputeMenuEnabled(ticket) {
        return truthyFlag(ticket, 'canBeDisputed');
    }

    function getDisputeDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isDisputeMenuEnabled(ticket)) return '';
        return 'Dispute is not available for this ticket.';
    }

    function isNoResponseMenuEnabled(ticket) {
        return truthyFlag(ticket, 'canBeNoResponse');
    }

    function getNoResponseDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isNoResponseMenuEnabled(ticket)) return '';
        return 'No Response is not available for this ticket.';
    }

    function getMenuItems(ticket) {
        const remarkFlow = global.ticketRemarkFlow;
        const remarkUi =
            remarkFlow && typeof remarkFlow.getRemarkActionUi === 'function'
                ? remarkFlow.getRemarkActionUi(ticket)
                : { label: 'Remark', mode: 'blocked' };
        const items = [
            {
                id: 'renew',
                label: 'Renew',
                enabled: isRenewMenuEnabled(ticket),
                title: getRenewDisabledReason(ticket),
            },
            {
                id: 'remark',
                label: remarkUi.label || 'Remark',
                enabled:
                    remarkFlow &&
                    typeof remarkFlow.isRemarkSlotEnabled === 'function' &&
                    remarkFlow.isRemarkSlotEnabled(ticket),
                title:
                    remarkFlow && typeof remarkFlow.getRemarkSlotDisabledReason === 'function'
                        ? remarkFlow.getRemarkSlotDisabledReason(ticket)
                        : '',
            },
            {
                id: 'amendment',
                label: 'Amendment',
                enabled:
                    remarkFlow &&
                    typeof remarkFlow.isAmendmentMenuEnabled === 'function' &&
                    remarkFlow.isAmendmentMenuEnabled(ticket),
                title:
                    remarkFlow && typeof remarkFlow.getAmendmentDisabledReason === 'function'
                        ? remarkFlow.getAmendmentDisabledReason(ticket)
                        : '',
            },
            {
                id: 'clone',
                label: 'Clone Ticket',
                enabled: true,
                title: '',
            },
            {
                id: 'follow_up',
                label: 'Follow Up',
                enabled: isFollowUpMenuEnabled(ticket),
                title: getFollowUpDisabledReason(ticket),
                phase2: true,
            },
            {
                id: 'dispute',
                label: 'Dispute',
                enabled: isDisputeMenuEnabled(ticket),
                title: getDisputeDisabledReason(ticket),
                phase2: true,
            },
            {
                id: 'no_response',
                label: 'No Response',
                enabled: isNoResponseMenuEnabled(ticket),
                title: getNoResponseDisabledReason(ticket),
                phase2: true,
            },
        ];
        return items;
    }

    function closeOpenMenu() {
        if (!openMenuEl) return;
        openMenuEl.classList.remove('is-open');
        openMenuEl = null;
    }

    function onDocumentPointerDown(ev) {
        if (!openMenuEl) return;
        if (openMenuEl.contains(ev.target)) return;
        closeOpenMenu();
    }

    function onDocumentKeyDown(ev) {
        if (ev.key === 'Escape') closeOpenMenu();
    }

    function menuButtonClass(context) {
        if (context === 'hub') return 'ticket-hub-action-btn ticket-hub-action-secondary ticket-actions-menu-toggle';
        return 'ticket-popup-mock-btn ticket-popup-mock-btn--secondary ticket-actions-menu-toggle';
    }

    function toolButtonClass(context, primary) {
        if (context === 'hub') {
            return primary
                ? 'ticket-hub-action-btn ticket-hub-action-primary ticket-detail-tool'
                : 'ticket-hub-action-btn ticket-hub-action-secondary ticket-detail-tool';
        }
        return primary
            ? 'ticket-popup-mock-btn ticket-detail-tool ticket-popup-mock-btn-renew'
            : 'ticket-popup-mock-btn ticket-popup-mock-btn--secondary ticket-detail-tool';
    }

    function overflowExtraHtml(ticket, context) {
        const extra = [];
        const posrLane = typeof global.isPosrLaneTicket === 'function' && global.isPosrLaneTicket(ticket);
        if (context === 'hub') {
            if (!posrLane) {
                extra.push(
                    '<button type="button" class="ticket-actions-menu-item ticket-hub-action-menu-item" data-hub-action="ticket-history" title="Ticket status, utility response, and view history">Ticket History</button>'
                );
            }
            if (!ticket.shared && global.LOCUS_HIDE_SITE_DOCUMENTATION !== true) {
                extra.push(
                    '<button type="button" class="ticket-actions-menu-item ticket-hub-action-menu-item" data-hub-action="hub-request-services" title="Request services for this ticket">Request Services</button>'
                );
            }
            extra.push(
                '<button type="button" class="ticket-actions-menu-item ticket-hub-action-menu-item" data-hub-action="hub-report-event" title="Log a reported event and open the USAN portal">Report Event</button>'
            );
            if (
                global.workflowAckModule &&
                typeof global.workflowAckModule.shouldShowRevertAckButton === 'function' &&
                global.workflowAckModule.shouldShowRevertAckButton(ticket, {
                    externalForOrg:
                        typeof global.isHubTicketExternalForOrg === 'function' &&
                        global.isHubTicketExternalForOrg(ticket),
                }) &&
                typeof global.workflowAckModule.buildRevertAckButtonHtml === 'function'
            ) {
                extra.push(global.workflowAckModule.buildRevertAckButtonHtml({ context: 'hub' }));
            }
        } else {
            if (!ticket.shared && global.LOCUS_HIDE_SITE_DOCUMENTATION !== true) {
                extra.push(
                    '<button type="button" class="ticket-actions-menu-item ticket-popup-request-services-btn" title="Request services for this ticket">Request Services</button>'
                );
            }
            if (!ticket.shared) {
                extra.push(
                    '<button type="button" class="ticket-actions-menu-item ticket-popup-open-project-btn" title="Open this ticket\'s project in Ticket Hub">Open Project</button>'
                );
            }
            if (global.CORE_PRODUCT !== true) {
                extra.push(
                    '<button type="button" class="ticket-actions-menu-item ticket-popup-report-event-btn" title="Log a reported event and open the USAN portal">Report Event</button>'
                );
            }
            if (
                global.workflowAckModule &&
                typeof global.workflowAckModule.shouldShowRevertAckButton === 'function' &&
                global.workflowAckModule.shouldShowRevertAckButton(ticket) &&
                typeof global.workflowAckModule.buildRevertAckButtonHtml === 'function'
            ) {
                extra.push(global.workflowAckModule.buildRevertAckButtonHtml({ context: 'popup' }));
            }
        }
        return extra.join('');
    }

    function menuItemClass(context, enabled) {
        const base = context === 'hub' ? 'ticket-actions-menu-item ticket-hub-action-menu-item' : 'ticket-actions-menu-item';
        return enabled ? base : base + ' is-disabled';
    }

    /**
     * @param {object} ticket
     * @param {{ context?: 'popup'|'hub' }} opts
     */
    function buildTicketActionsMenuHtml(ticket, opts) {
        const context = opts && opts.context === 'hub' ? 'hub' : 'popup';
        const overflow = !!(opts && opts.overflow);
        const exclude = {};
        (opts && Array.isArray(opts.excludeIds) ? opts.excludeIds : []).forEach(function (id) {
            exclude[id] = true;
        });
        const extraHtml = overflow ? overflowExtraHtml(ticket, context) : '';
        const includeTicketActions = !opts || opts.includeTicketActions !== false;
        const items =
            includeTicketActions && shouldShowTicketActionsMenu(ticket)
            ? getMenuItems(ticket).filter(function (item) {
                  return !exclude[item.id];
              })
            : [];
        if (!overflow && !items.length) return '';
        if (overflow && !items.length && !extraHtml) return '';
        const itemHtml = items
            .map(function (item) {
                const title = item.title ? ' title="' + esc(item.title) + '"' : '';
                const disabled = item.enabled ? '' : ' disabled aria-disabled="true"';
                return (
                    '<button type="button" class="' +
                    menuItemClass(context, item.enabled) +
                    '" data-ticket-action="' +
                    esc(item.id) +
                    '"' +
                    title +
                    disabled +
                    '>' +
                    esc(item.label) +
                    '</button>'
                );
            })
            .join('');
        const toggleLabel = (opts && opts.toggleLabel) || (overflow ? 'More' : 'Ticket Actions');
        const excludeAttr = Object.keys(exclude).join(',');
        return (
            '<div class="' +
            MENU_ROOT_CLASS +
            ' ticket-actions-menu--' +
            context +
            (overflow ? ' ticket-actions-menu--overflow' : '') +
            '" data-ticket-actions-menu data-ticket-actions-context="' +
            context +
            '" data-ticket-actions-overflow="' +
            (overflow ? '1' : '0') +
            '" data-ticket-actions-toggle-label="' +
            esc(toggleLabel) +
            '" data-ticket-actions-exclude="' +
            esc(excludeAttr) +
            '" data-ticket-actions-include="' +
            (includeTicketActions ? '1' : '0') +
            '">' +
            '<button type="button" class="' +
            menuButtonClass(context) +
            '" data-ticket-actions-toggle aria-haspopup="menu" aria-expanded="false">' +
            esc(toggleLabel) +
            '</button>' +
            '<div class="ticket-actions-menu-dropdown" role="menu">' +
            itemHtml +
            extraHtml +
            '</div></div>'
        );
    }

    function popupMayShowTicketActions() {
        const isOrgAdmin =
            global.ticketRenewalBulkFlow &&
            typeof global.ticketRenewalBulkFlow.isHubRenewUserOrgAdmin === 'function' &&
            global.ticketRenewalBulkFlow.isHubRenewUserOrgAdmin();
        return !!isOrgAdmin && global.LOCUS_ENABLE_TICKET_RENEWAL === true;
    }

    function buildTicketDetailToolbarHtml(ticket, opts) {
        const context = opts && opts.context === 'hub' ? 'hub' : 'popup';
        const includeTicketActions = context === 'hub' || popupMayShowTicketActions();
        const showRenew =
            includeTicketActions &&
            shouldShowTicketActionsMenu(ticket) &&
            isRenewMenuEnabled(ticket);
        const showDocumentPack =
            global.ticketDocumentPackFlow &&
            typeof global.ticketDocumentPackFlow.shouldShowDocumentPackButton === 'function' &&
            global.ticketDocumentPackFlow.shouldShowDocumentPackButton(ticket);
        const tools = [];
        if (showRenew) {
            if (context === 'hub') {
                tools.push(
                    '<button type="button" class="' +
                        toolButtonClass(context, true) +
                        '" data-hub-action="hub-renew">Renew</button>'
                );
            } else {
                tools.push(
                    '<button type="button" class="' +
                        toolButtonClass(context, true) +
                        '">Renew</button>'
                );
            }
        }
        if (showDocumentPack) {
            const docsTitle =
                ' title="View confirmation sheet and full ticket history in browser; download ZIP pack optional"';
            if (context === 'hub') {
                tools.push(
                    '<button type="button" class="' +
                        toolButtonClass(context, false) +
                        '" data-hub-action="hub-document-pack"' +
                        docsTitle +
                        '>View docs</button>'
                );
            } else {
                tools.push(
                    '<button type="button" class="' +
                        toolButtonClass(context, false) +
                        ' ticket-popup-document-pack-btn"' +
                        docsTitle +
                        '>View docs</button>'
                );
            }
        }
        if (context === 'hub') {
            tools.push(
                '<button type="button" class="' +
                    toolButtonClass(context, false) +
                    '" data-hub-action="hub-show-on-map" title="Show this ticket on the map">Map</button>'
            );
        }
        const moreHtml = buildTicketActionsMenuHtml(ticket, {
            context: context,
            overflow: true,
            toggleLabel: 'More',
            excludeIds: showRenew ? ['renew'] : [],
            includeTicketActions: includeTicketActions,
        });
        if (!tools.length && !moreHtml) return '';
        return '<div class="ticket-detail-toolbar">' + tools.join('') + moreHtml + '</div>';
    }

    function handleMenuAction(actionId, ticket) {
        if (!ticket) return;
        if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Ticket actions require an internet connection.')) {
            return;
        }
        if (actionId === 'renew') {
            const flow = global.ticketRenewalBulkFlow;
            if (flow && typeof flow.openBulkRenewalFromTickets === 'function') {
                flow.openBulkRenewalFromTickets([ticket]);
            }
            return;
        }
        if (actionId === 'remark') {
            const flow = global.ticketRemarkFlow;
            if (!flow || typeof flow.classifyRemarkClick !== 'function') return;
            const route = flow.classifyRemarkClick(ticket);
            if (route === 'remark' && typeof flow.openRemarkFromTicket === 'function') {
                flow.openRemarkFromTicket(ticket);
            } else if (route === 'create_new' && typeof flow.openCreateNewFromRemark === 'function') {
                flow.openCreateNewFromRemark(ticket);
            }
            return;
        }
        if (actionId === 'amendment') {
            const flow = global.ticketAmendmentFlow || global.ticketRemarkFlow;
            if (flow && typeof flow.openFromTicket === 'function') {
                flow.openFromTicket(ticket);
            } else if (global.ticketRemarkFlow && typeof global.ticketRemarkFlow.openAmendmentFromTicket === 'function') {
                global.ticketRemarkFlow.openAmendmentFromTicket(ticket);
            }
            return;
        }
        if (actionId === 'clone') {
            const flow = global.ticketCloneFlow;
            if (flow && typeof flow.openFromTicket === 'function') {
                flow.openFromTicket(ticket);
            } else if (typeof global.appAlert === 'function') {
                void global.appAlert('Clone Ticket is not available.');
            }
            return;
        }
        if (actionId === 'new_ticket') {
            const flow = global.ticketRemarkFlow;
            if (flow && typeof flow.openCreateNewFromRemark === 'function') {
                flow.openCreateNewFromRemark(ticket);
            }
            return;
        }
        if (actionId === 'follow_up') {
            const flow = global.ticketFollowUpFlow;
            if (flow && typeof flow.openFromTicket === 'function') {
                flow.openFromTicket(ticket);
            } else if (typeof global.appAlert === 'function') {
                void global.appAlert('Follow Up is not available yet.');
            }
            return;
        }
        if (actionId === 'dispute') {
            const flow = global.ticketDisputeFlow;
            if (flow && typeof flow.openFromTicket === 'function') {
                flow.openFromTicket(ticket);
            } else if (typeof global.appAlert === 'function') {
                void global.appAlert('Dispute is not available yet.');
            }
            return;
        }
        if (actionId === 'no_response') {
            const flow = global.ticketNoResponseFlow;
            if (flow && typeof flow.openFromTicket === 'function') {
                flow.openFromTicket(ticket);
            } else if (typeof global.appAlert === 'function') {
                void global.appAlert('No Response is not available yet.');
            }
        }
    }

    /**
     * @param {Element} root
     * @param {object} ticket
     */
    function wireTicketActionsMenu(root, ticket) {
        if (!root || !ticket) return;
        const menuRoot = root.querySelector('[data-ticket-actions-menu]');
        if (!menuRoot) return;
        const toggle = menuRoot.querySelector('[data-ticket-actions-toggle]');
        const dropdown = menuRoot.querySelector('.ticket-actions-menu-dropdown');
        if (!toggle || !dropdown) return;

        toggle.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const isOpen = menuRoot.classList.contains('is-open');
            closeOpenMenu();
            if (!isOpen) {
                menuRoot.classList.add('is-open');
                toggle.setAttribute('aria-expanded', 'true');
                openMenuEl = menuRoot;
            }
        });

        dropdown.querySelectorAll('[data-ticket-action]').forEach(function (btn) {
            btn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (btn.disabled || btn.classList.contains('is-disabled')) return;
                const actionId = btn.getAttribute('data-ticket-action');
                closeOpenMenu();
                handleMenuAction(actionId, ticket);
            });
        });
        dropdown.querySelectorAll('button:not([data-ticket-action])').forEach(function (btn) {
            btn.addEventListener('click', function () {
                closeOpenMenu();
            });
        });
    }

    /**
     * Rebuild the menu already in the DOM from the latest ticket (flags often arrive after first paint).
     * Keeps the dropdown open so the list updates in place. Does not insert a menu that was never shown.
     * @param {Element} root
     * @param {object} ticket
     * @param {{ context?: 'popup'|'hub' }} opts
     */
    function syncTicketActionsMenu(root, ticket, opts) {
        if (!root || !ticket) return;
        const existing = root.querySelector('[data-ticket-actions-menu]');
        if (!existing) return;
        const wasOpen = existing.classList.contains('is-open');
        const storedOpts = {
            context:
                (opts && opts.context) ||
                existing.getAttribute('data-ticket-actions-context') ||
                'popup',
            overflow: existing.getAttribute('data-ticket-actions-overflow') === '1',
            toggleLabel: existing.getAttribute('data-ticket-actions-toggle-label') || undefined,
            includeTicketActions: existing.getAttribute('data-ticket-actions-include') !== '0',
            excludeIds: (existing.getAttribute('data-ticket-actions-exclude') || '')
                .split(',')
                .filter(Boolean),
        };
        const html = buildTicketActionsMenuHtml(ticket, Object.assign({}, storedOpts, opts || {}));
        if (!html) {
            if (openMenuEl === existing) openMenuEl = null;
            existing.remove();
            return;
        }
        const wrap = document.createElement('div');
        wrap.innerHTML = html;
        const next = wrap.firstElementChild;
        if (!next) return;
        if (wasOpen) {
            next.classList.add('is-open');
            const toggle = next.querySelector('[data-ticket-actions-toggle]');
            if (toggle) toggle.setAttribute('aria-expanded', 'true');
        }
        existing.replaceWith(next);
        openMenuEl = wasOpen ? next : openMenuEl === existing ? null : openMenuEl;
        wireTicketActionsMenu(root, ticket);
    }

    if (!global._ticketActionsMenuDocListeners) {
        global._ticketActionsMenuDocListeners = true;
        document.addEventListener('pointerdown', onDocumentPointerDown, true);
        document.addEventListener('keydown', onDocumentKeyDown, true);
    }

    global.ticketActionsMenu = {
        shouldShowTicketActionsMenu: shouldShowTicketActionsMenu,
        buildTicketActionsMenuHtml: buildTicketActionsMenuHtml,
        buildTicketDetailToolbarHtml: buildTicketDetailToolbarHtml,
        wireTicketActionsMenu: wireTicketActionsMenu,
        syncTicketActionsMenu: syncTicketActionsMenu,
        getMenuItems: getMenuItems,
        handleMenuAction: handleMenuAction,
        closeOpenMenu: closeOpenMenu,
    };
})(typeof window !== 'undefined' ? window : globalThis);
