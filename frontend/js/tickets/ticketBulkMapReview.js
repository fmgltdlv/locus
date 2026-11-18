/**
 * Shared map-review panel for bulk renew / bulk remark.
 * Soft-hides Ticket Hub, shows a floating submit list, focuses tickets on the map.
 */
(function (global) {
    'use strict';

    const PANEL_ID = 'ticketBulkMapReviewPanel';
    const SOFT_HIDE_ATTR = 'data-bulk-map-review-soft-hide';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function panelRoot() {
        return document.getElementById(PANEL_ID);
    }

    function softHideTicketHub() {
        const win = document.getElementById('ticketHubWindow');
        if (!win) return;
        if (win.classList.contains('show') || win.dataset.bulkMapReviewWasShown === '1') {
            win.setAttribute(SOFT_HIDE_ATTR, '1');
            if (win.classList.contains('show')) {
                win.dataset.bulkMapReviewWasShown = '1';
            }
            win.classList.remove('show');
            if (typeof global.syncDataWindowStackAboveHub === 'function') {
                global.syncDataWindowStackAboveHub();
            }
        }
    }

    function softRestoreTicketHub() {
        const win = document.getElementById('ticketHubWindow');
        if (!win) return;
        if (win.getAttribute(SOFT_HIDE_ATTR) !== '1') return;
        win.removeAttribute(SOFT_HIDE_ATTR);
        if (win.dataset.bulkMapReviewWasShown === '1') {
            win.classList.add('show');
            delete win.dataset.bulkMapReviewWasShown;
        }
        if (typeof global.syncDataWindowStackAboveHub === 'function') {
            global.syncDataWindowStackAboveHub();
        }
    }

    /** Clear soft-hide markers without reopening the hub (org switch already closes it). */
    function clearSoftHideState() {
        const win = document.getElementById('ticketHubWindow');
        if (!win) return;
        win.removeAttribute(SOFT_HIDE_ATTR);
        delete win.dataset.bulkMapReviewWasShown;
    }

    function closePanel() {
        const x = panelRoot();
        if (x) x.remove();
    }

    function focusTicketOnMap(ticket) {
        if (!ticket) return;
        if (typeof global.showTicketPopup === 'function') {
            void global.showTicketPopup(ticket, {
                allowOverTicketHub: true,
                skipDetailHydrate: false,
            });
        }
        if (typeof global.panMapToTicketAboveBottomChrome === 'function') {
            global.panMapToTicketAboveBottomChrome(ticket);
        }
    }

    /**
     * @param {{
     *   title: string,
     *   hint?: string,
     *   items: Array<{
     *     ticket: object,
     *     ticketNumber: string,
     *     actionLabel?: string,
     *     getNote?: () => string,
     *     setNote?: (text: string) => void,
     *     isCustomNote?: () => boolean
     *   }>,
     *   enableNotes?: boolean,
     *   submitLabel?: string,
     *   onBack?: () => void,
     *   onCancel?: () => void,
     *   onSubmit?: () => void | Promise<void>
     * }} opts
     */
    function openMapReview(opts) {
        const options = opts || {};
        const items = Array.isArray(options.items) ? options.items : [];
        const enableNotes = options.enableNotes === true;
        closePanel();
        softHideTicketHub();

        let selectedTn = items.length ? String(items[0].ticketNumber) : '';
        let submitting = false;

        const wrap = document.createElement('div');
        wrap.id = PANEL_ID;
        wrap.className = 'ticket-bulk-map-review';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'false');
        wrap.setAttribute('aria-label', options.title || 'Review tickets');

        function noteCueFor(item) {
            if (!enableNotes || typeof item.isCustomNote !== 'function') return '';
            return item.isCustomNote() ? 'Custom note' : 'Using shared note';
        }

        function renderBody() {
            const rows = items
                .map(function (item) {
                    const tn = String(item.ticketNumber);
                    const selected = tn === selectedTn;
                    const action = item.actionLabel ? esc(item.actionLabel) : '';
                    const cue = noteCueFor(item);
                    return (
                        '<li class="ticket-bulk-map-review-item' +
                        (selected ? ' is-selected' : '') +
                        (submitting ? ' is-disabled' : '') +
                        '" data-map-review-tn="' +
                        esc(tn) +
                        '" role="button" tabindex="0">' +
                        '<div class="ticket-bulk-map-review-item-main">' +
                        '<span class="ticket-bulk-map-review-tn">' +
                        esc(tn) +
                        '</span>' +
                        (action
                            ? '<span class="ticket-bulk-map-review-action">' + action + '</span>'
                            : '') +
                        '</div>' +
                        (cue
                            ? '<div class="ticket-bulk-map-review-cue">' + esc(cue) + '</div>'
                            : '') +
                        '</li>'
                    );
                })
                .join('');

            let noteBlock = '';
            if (enableNotes && selectedTn) {
                const sel = items.find(function (it) {
                    return String(it.ticketNumber) === selectedTn;
                });
                const noteVal =
                    sel && typeof sel.getNote === 'function' ? String(sel.getNote() || '') : '';
                noteBlock =
                    '<div class="ticket-bulk-map-review-note">' +
                    '<label class="ticket-hub-mock-label" for="ticketBulkMapReviewNote">Note for this ticket only</label>' +
                    '<p class="ticket-hub-mock-hint" style="margin:0 0 0.35rem 0">Edits here apply only to the selected ticket, not the shared default.</p>' +
                    '<textarea class="ticket-hub-mock-textarea" id="ticketBulkMapReviewNote" rows="3"' +
                    (submitting ? ' disabled' : '') +
                    '>' +
                    esc(noteVal) +
                    '</textarea>' +
                    '</div>';
            }

            wrap.innerHTML =
                '<div class="ticket-bulk-map-review-panel">' +
                '<div class="ticket-hub-mock-header">' +
                '<h3 class="ticket-hub-mock-title">' +
                esc(options.title || 'Review tickets') +
                '</h3>' +
                '<button type="button" class="ticket-hub-mock-close" aria-label="Close" data-map-review-cancel' +
                (submitting ? ' disabled' : '') +
                '>&times;</button>' +
                '</div>' +
                (options.hint
                    ? '<p class="ticket-hub-mock-hint">' + esc(options.hint) + '</p>'
                    : '') +
                '<ul class="ticket-bulk-map-review-list">' +
                rows +
                '</ul>' +
                noteBlock +
                '<div class="ticket-hub-mock-footer ticket-bulk-map-review-footer">' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-map-review-back' +
                (submitting ? ' disabled' : '') +
                '>Back</button>' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-map-review-cancel' +
                (submitting ? ' disabled' : '') +
                '>Cancel</button>' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-map-review-submit' +
                (submitting ? ' disabled' : '') +
                '>' +
                esc(submitting ? 'Submitting…' : options.submitLabel || 'Submit') +
                '</button>' +
                '</div></div>';

            bindInteractions();
        }

        function selectItem(tn) {
            if (submitting) return;
            selectedTn = String(tn);
            const item = items.find(function (it) {
                return String(it.ticketNumber) === selectedTn;
            });
            if (item) focusTicketOnMap(item.ticket);
            renderBody();
        }

        function bindInteractions() {
            wrap.querySelectorAll('[data-map-review-tn]').forEach(function (el) {
                const tn = el.getAttribute('data-map-review-tn');
                el.addEventListener('click', function () {
                    selectItem(tn);
                });
                el.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        selectItem(tn);
                    }
                });
            });

            const noteEl = document.getElementById('ticketBulkMapReviewNote');
            if (noteEl && enableNotes && !submitting) {
                noteEl.addEventListener('input', function () {
                    const sel = items.find(function (it) {
                        return String(it.ticketNumber) === selectedTn;
                    });
                    if (sel && typeof sel.setNote === 'function') {
                        sel.setNote(String(noteEl.value));
                        const cue = wrap.querySelector(
                            '.ticket-bulk-map-review-item.is-selected .ticket-bulk-map-review-cue'
                        );
                        if (cue) cue.textContent = noteCueFor(sel);
                    }
                });
            }

            const backBtn = wrap.querySelector('[data-map-review-back]');
            if (backBtn) {
                backBtn.addEventListener('click', function () {
                    if (submitting) return;
                    closePanel();
                    softRestoreTicketHub();
                    if (typeof options.onBack === 'function') options.onBack();
                });
            }

            wrap.querySelectorAll('[data-map-review-cancel]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    if (submitting) return;
                    closePanel();
                    softRestoreTicketHub();
                    if (typeof options.onCancel === 'function') options.onCancel();
                });
            });

            const submitBtn = wrap.querySelector('[data-map-review-submit]');
            if (submitBtn) {
                submitBtn.addEventListener('click', function () {
                    if (submitting) return;
                    void (async function () {
                        submitting = true;
                        renderBody();
                        try {
                            let result = true;
                            if (typeof options.onSubmit === 'function') {
                                result = await options.onSubmit();
                            }
                            if (result === false) {
                                submitting = false;
                                renderBody();
                            }
                        } catch (e) {
                            submitting = false;
                            renderBody();
                            const msg = e && e.message ? String(e.message) : String(e);
                            if (msg === 'cancelled') return;
                            if (typeof global.appAlert === 'function') void global.appAlert(msg);
                        }
                    })();
                });
            }
        }

        document.body.appendChild(wrap);
        renderBody();
        if (selectedTn) {
            const first = items.find(function (it) {
                return String(it.ticketNumber) === selectedTn;
            });
            if (first) focusTicketOnMap(first.ticket);
        }
    }

    function finishAndRestoreHub() {
        closePanel();
        softRestoreTicketHub();
    }

    /** Tear down map review for org switch (do not reopen Ticket Hub). */
    function closeForOrgSwitch() {
        closePanel();
        clearSoftHideState();
    }

    global.ticketBulkMapReview = {
        openMapReview: openMapReview,
        softHideTicketHub: softHideTicketHub,
        softRestoreTicketHub: softRestoreTicketHub,
        closePanel: closePanel,
        finishAndRestoreHub: finishAndRestoreHub,
        focusTicketOnMap: focusTicketOnMap,
        closeForOrgSwitch: closeForOrgSwitch,
    };
})(typeof window !== 'undefined' ? window : globalThis);
