/**
 * Ticket Hub bulk remark (fresh-paint path under Renew selected).
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'ticketRemarkBulkOverlay';
    /** Match server RENEW_TICKET_BATCH_MAX in tickets/shared.ts */
    const REMARK_BATCH_MAX = 25;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function overlayRoot() {
        return document.getElementById(OVERLAY_ID);
    }

    function closeOverlay() {
        const x = overlayRoot();
        if (x) x.remove();
    }

    /** Real USAN ticket number only — never fall back to internal id. */
    function realTicketNumber(t) {
        if (!t || typeof t !== 'object') return '';
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        return tn;
    }

    function ticketNumberLine(t) {
        const tn = realTicketNumber(t);
        if (tn) return tn;
        return '—';
    }

    function isRemarkable(ticket) {
        if (!ticket || ticket.shared) return false;
        const flow = global.ticketRemarkFlow;
        if (flow && typeof flow.isRemarkSubmitAvailable === 'function') {
            return flow.isRemarkSubmitAvailable(ticket);
        }
        const v = ticket.canBeRemark != null ? ticket.canBeRemark : ticket.can_be_remark;
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function skipReasonFor(ticket) {
        if (!ticket) return 'Ticket not found';
        if (ticket.shared) return 'Shared ticket';
        if (!realTicketNumber(ticket)) return 'No ticket number';
        if (!isRemarkable(ticket)) return 'Remark is not available for this ticket';
        return '';
    }

    function confirmMarkup(list) {
        const rows = (list || [])
            .map(function (t) {
                const remarkable = isRemarkable(t) && !!realTicketNumber(t);
                const eligible = remarkable ? 'Remarkable' : skipReasonFor(t) || 'Not eligible';
                const rowClass = remarkable ? '' : 'renewal-mock-table-row--skip';
                return (
                    '<tr class="' +
                    rowClass +
                    '"><td>' +
                    esc(ticketNumberLine(t)) +
                    '</td><td>' +
                    esc(eligible) +
                    '</td></tr>'
                );
            })
            .join('');

        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Remark selected tickets</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">Only tickets marked Remarkable will be submitted. Tickets that cannot be remarked are skipped. At most ' +
            REMARK_BATCH_MAX +
            ' tickets per batch.</p>' +
            '<div class="renewal-mock-table-wrap">' +
            '<table class="renewal-mock-table">' +
            '<caption class="renewal-mock-sr-only">Selected tickets remark eligibility</caption>' +
            '<thead><tr><th>Ticket</th><th>Eligible</th></tr></thead>' +
            '<tbody>' +
            rows +
            '</tbody></table>' +
            '</div>' +
            '<div class="ticket-hub-mock-field" style="margin:0.75rem 1rem 0">' +
            '<label class="ticket-hub-mock-label" for="remarkBulkSharedNote">Default note for locators</label>' +
            '<p class="ticket-hub-mock-hint" style="margin:0 0 0.35rem 0">This note is shared by all remarked tickets in this batch. You can customize individual tickets on the next screen.</p>' +
            '<textarea class="ticket-hub-mock-textarea" id="remarkBulkSharedNote" rows="4" placeholder="Describe the area that needs remarking"></textarea>' +
            '</div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-remark-bulk-dismiss>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-remark-bulk-continue disabled>Continue</button>' +
            '</div>'
        );
    }

    function buildRemarkableQueue(list) {
        const queue = [];
        (list || []).forEach(function (t) {
            const tn = realTicketNumber(t);
            if (!tn || !isRemarkable(t)) return;
            queue.push({ ticket: t, ticketNumber: tn });
        });
        return queue;
    }

    /**
     * @param {object[]} hubTickets
     */
    function openBulkRemarkFromTickets(hubTickets) {
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket actions are not enabled.');
            return;
        }
        const list = hubTickets && hubTickets.length ? hubTickets.slice() : [];
        if (list.length === 0) {
            if (typeof global.appAlert === 'function') void global.appAlert('No tickets to include.');
            return;
        }
        const orgId =
            global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                ? global.orgSelectorModule.getCurrentOrgId()
                : null;
        if (orgId == null || orgId === '') {
            if (typeof global.appAlert === 'function') void global.appAlert('Select an organization first.');
            return;
        }

        const queue = buildRemarkableQueue(list);
        closeOverlay();
        const wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Bulk ticket remark');
        wrap.innerHTML = '<div class="ticket-hub-mock-panel renewal-mock-panel--wide">' + confirmMarkup(list) + '</div>';
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-remark-bulk-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeOverlay();
        });

        const noteEl = document.getElementById('remarkBulkSharedNote');
        const continueBtn = wrap.querySelector('[data-remark-bulk-continue]');

        function updateContinueState() {
            if (!continueBtn) return;
            const hasNote = noteEl && String(noteEl.value).trim() !== '';
            const overCap = queue.length > REMARK_BATCH_MAX;
            continueBtn.disabled = !(hasNote && queue.length > 0 && !overCap);
            if (overCap) {
                continueBtn.title = 'Select at most ' + REMARK_BATCH_MAX + ' remarkable tickets.';
            } else {
                continueBtn.removeAttribute('title');
            }
        }
        if (noteEl) noteEl.addEventListener('input', updateContinueState);
        updateContinueState();

        if (queue.length > REMARK_BATCH_MAX && typeof global.appAlert === 'function') {
            void global.appAlert(
                'Too many remarkable tickets selected (' +
                    queue.length +
                    '). Select at most ' +
                    REMARK_BATCH_MAX +
                    ' and try again.'
            );
        }

        if (!continueBtn) return;
        continueBtn.addEventListener('click', function () {
            const sharedNote = noteEl && String(noteEl.value).trim() !== '' ? String(noteEl.value).trim() : '';
            if (!sharedNote) {
                if (typeof global.appAlert === 'function') void global.appAlert('Enter remark text.');
                return;
            }
            if (queue.length === 0) {
                if (typeof global.appAlert === 'function') {
                    void global.appAlert('None of the selected tickets can be remarked.');
                }
                return;
            }
            if (queue.length > REMARK_BATCH_MAX) {
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(
                        'Select at most ' + REMARK_BATCH_MAX + ' remarkable tickets per batch.'
                    );
                }
                return;
            }

            const noteOverrides = {};
            const capturedOrgId = Number(orgId);
            closeOverlay();

            const mapReview = global.ticketBulkMapReview;
            if (!mapReview || typeof mapReview.openMapReview !== 'function') {
                if (typeof global.appAlert === 'function') void global.appAlert('Map review is not loaded yet.');
                return;
            }

            const reviewItems = queue.map(function (q) {
                const tn = q.ticketNumber;
                return {
                    ticket: q.ticket,
                    ticketNumber: tn,
                    actionLabel: 'Remark',
                    getNote: function () {
                        return noteOverrides[tn] != null ? noteOverrides[tn] : sharedNote;
                    },
                    setNote: function (text) {
                        const trimmed = text != null ? String(text) : '';
                        if (trimmed.trim() === sharedNote) delete noteOverrides[tn];
                        else noteOverrides[tn] = trimmed;
                    },
                    isCustomNote: function () {
                        return noteOverrides[tn] != null && String(noteOverrides[tn]) !== sharedNote;
                    },
                };
            });

            function reopenSharedNoteStep() {
                openBulkRemarkFromTickets(list);
                const again = document.getElementById('remarkBulkSharedNote');
                if (again) again.value = sharedNote;
                const btn = document.querySelector('#ticketRemarkBulkOverlay [data-remark-bulk-continue]');
                if (btn) {
                    btn.disabled = !(sharedNote && queue.length > 0 && queue.length <= REMARK_BATCH_MAX);
                }
            }

            mapReview.openMapReview({
                title: 'Review remarks',
                hint: 'Click a ticket to see it on the map. Optionally edit that ticket’s note before submitting.',
                items: reviewItems,
                enableNotes: true,
                submitLabel: 'Submit remarks',
                onBack: reopenSharedNoteStep,
                onCancel: function () {},
                onSubmit: async function () {
                    const liveOrgId =
                        global.orgSelectorModule &&
                        typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                            ? global.orgSelectorModule.getCurrentOrgId()
                            : null;
                    if (liveOrgId == null || liveOrgId === '' || Number(liveOrgId) !== capturedOrgId) {
                        if (typeof global.appAlert === 'function') {
                            await global.appAlert(
                                'Organization changed. Cancel and start the remark batch again for the current organization.'
                            );
                        }
                        return false;
                    }

                    for (let i = 0; i < reviewItems.length; i++) {
                        const text = String(reviewItems[i].getNote() || '').trim();
                        if (!text) {
                            if (typeof global.appAlert === 'function') {
                                await global.appAlert(
                                    'Ticket ' + reviewItems[i].ticketNumber + ' needs a note for locators.'
                                );
                            }
                            return false;
                        }
                    }

                    const confirmed =
                        typeof global.appConfirm === 'function'
                            ? await global.appConfirm(
                                  'Submit remarks to USAN for ' +
                                      reviewItems.length +
                                      ' ticket(s)? Submission runs in the background.',
                                  {
                                      title: 'Submit to USAN',
                                      confirmText: 'Submit',
                                      cancelText: 'Cancel',
                                  }
                              )
                            : true;
                    if (!confirmed) return false;

                    const items = reviewItems.map(function (it, ix) {
                        return {
                            ticketNumber: it.ticketNumber,
                            text: String(it.getNote() || '').trim(),
                            idempotencyKey:
                                typeof global.newIdempotencyKey === 'function'
                                    ? global.newIdempotencyKey()
                                    : String(Date.now()) + '-' + ix,
                        };
                    });

                    if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                        global.submitJobPoller.beginEnqueueFeedback('Submitting…');
                    }
                    if (typeof global.showToast === 'function') {
                        global.showToast('Submitting', 'success');
                    }

                    try {
                        const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                            method: 'POST',
                            body: JSON.stringify({
                                organizationId: capturedOrgId,
                                operation: 'remark',
                                items: items,
                            }),
                        });
                        if (mapReview.finishAndRestoreHub) mapReview.finishAndRestoreHub();
                        if (global.submitJobPoller && typeof global.submitJobPoller.registerJob === 'function') {
                            global.submitJobPoller.registerJob(data && data.jobId);
                        } else if (
                            global.submitJobPoller &&
                            typeof global.submitJobPoller.endEnqueueFeedback === 'function'
                        ) {
                            global.submitJobPoller.endEnqueueFeedback();
                        }
                    } catch (e) {
                        if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
                            global.submitJobPoller.endEnqueueFeedback();
                        }
                        throw e;
                    }
                },
            });
        });
    }

    function closeForOrgSwitch() {
        closeOverlay();
        if (global.ticketBulkMapReview && typeof global.ticketBulkMapReview.closeForOrgSwitch === 'function') {
            global.ticketBulkMapReview.closeForOrgSwitch();
        }
    }

    global.ticketRemarkBulkFlow = {
        openBulkRemarkFromTickets: openBulkRemarkFromTickets,
        closeForOrgSwitch: closeForOrgSwitch,
        REMARK_BATCH_MAX: REMARK_BATCH_MAX,
    };
})(typeof window !== 'undefined' ? window : globalThis);
