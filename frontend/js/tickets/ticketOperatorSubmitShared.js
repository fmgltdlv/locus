/**
 * Shared operator-select overlay + submit-jobs helper for USAN operator notifications.
 */
(function (global) {
    'use strict';

    const SHARED_OVERLAY_ID = 'ticketOperatorSubmitOverlay';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function truthyFlag(v) {
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function ticketLabel(t) {
        if (!t) return '—';
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        return tn || (t.id != null ? String(t.id) : '—');
    }

    function closeOverlay() {
        const x = document.getElementById(SHARED_OVERLAY_ID);
        if (x) x.remove();
    }

    /**
     * @param {object} ticket
     * @returns {Array<{ authorityId: number, label: string }>}
     */
    function getOperatorChoices(ticket) {
        const rows = Array.isArray(ticket && ticket.operatorResponses) ? ticket.operatorResponses : [];
        const out = [];
        const seen = new Set();
        rows.forEach(function (r) {
            if (!r || r.authorityId == null) return;
            const id = Number(r.authorityId);
            if (!Number.isFinite(id) || seen.has(id)) return;
            seen.add(id);
            const name =
                r.operatorName != null && String(r.operatorName).trim() !== ''
                    ? String(r.operatorName).trim()
                    : r.stationCode != null
                      ? String(r.stationCode).trim()
                      : 'Operator ' + id;
            const status =
                r.responseStatus != null && String(r.responseStatus).trim() !== ''
                    ? ' — ' + String(r.responseStatus).trim()
                    : '';
            out.push({ authorityId: id, label: name + status });
        });
        return out;
    }

    /**
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} [opts.subtitle]
     * @param {object} opts.ticket
     * @param {string} opts.submitLabel
     * @param {boolean} [opts.showFaultToggle]
     * @param {string} [opts.confirmMessage]
     * @param {function} opts.onSubmit — ({ text, authorityIds, isOperatorFault }) => Promise<void>
     */
    function openOperatorSubmitOverlay(opts) {
        const ticket = opts.ticket;
        const operators = getOperatorChoices(ticket);
        closeOverlay();

        const operatorHtml =
            operators.length > 0
                ? operators
                      .map(function (op) {
                          return (
                              '<label class="ticket-operator-submit-check">' +
                              '<input type="checkbox" class="ticket-operator-submit-cb" value="' +
                              esc(String(op.authorityId)) +
                              '" />' +
                              '<span>' +
                              esc(op.label) +
                              '</span></label>'
                          );
                      })
                      .join('')
                : '<p class="ticket-hub-mock-hint">No operators loaded for this ticket. Refresh the ticket and try again.</p>';

        const wrap = document.createElement('div');
        wrap.id = SHARED_OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.innerHTML =
            '<div class="ticket-hub-mock-panel ticket-operator-submit-panel">' +
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">' +
            esc(opts.title) +
            '</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            (opts.subtitle
                ? '<p class="ticket-hub-mock-hint">' + opts.subtitle + '</p>'
                : '<p class="ticket-hub-mock-hint">Ticket <strong>' + esc(ticketLabel(ticket)) + '</strong></p>') +
            '<div class="ticket-hub-mock-field">' +
            '<label class="ticket-hub-mock-label" for="ticketOperatorSubmitText">Message to operators</label>' +
            '<textarea class="ticket-hub-mock-textarea" id="ticketOperatorSubmitText" rows="4" placeholder="Enter notification notes"></textarea>' +
            '</div>' +
            '<div class="ticket-hub-mock-field">' +
            '<div class="ticket-operator-submit-op-header">' +
            '<span class="ticket-hub-mock-label">Notify operators</span>' +
            (operators.length > 1
                ? '<button type="button" class="ticket-operator-submit-select-all" data-select-all>Select all</button>'
                : '') +
            '</div>' +
            '<div class="ticket-operator-submit-op-list">' +
            operatorHtml +
            '</div></div>' +
            (opts.showFaultToggle
                ? '<label class="ticket-hub-mock-confirm ticket-operator-submit-fault">' +
                  '<input type="checkbox" id="ticketOperatorSubmitFault" />' +
                  '<span>Operator at fault</span></label>'
                : '') +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-operator-submit-dismiss>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-operator-submit-go disabled>' +
            esc(opts.submitLabel || 'Submit') +
            '</button></div></div>';
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-operator-submit-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeOverlay();
        });

        const textEl = document.getElementById('ticketOperatorSubmitText');
        const submitBtn = wrap.querySelector('[data-operator-submit-go]');
        const checkboxes = wrap.querySelectorAll('.ticket-operator-submit-cb');
        const selectAllBtn = wrap.querySelector('[data-select-all]');

        function selectedAuthorityIds() {
            const ids = [];
            checkboxes.forEach(function (cb) {
                if (cb.checked) {
                    const n = Number(cb.value);
                    if (Number.isFinite(n)) ids.push(n);
                }
            });
            return ids;
        }

        function updateSubmitState() {
            const hasText = textEl && String(textEl.value || '').trim() !== '';
            const hasOps = selectedAuthorityIds().length > 0;
            if (submitBtn) submitBtn.disabled = !(hasText && hasOps);
        }

        if (textEl) textEl.addEventListener('input', updateSubmitState);
        checkboxes.forEach(function (cb) {
            cb.addEventListener('change', updateSubmitState);
        });
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', function () {
                checkboxes.forEach(function (cb) {
                    cb.checked = true;
                });
                updateSubmitState();
            });
        }
        updateSubmitState();

        if (!submitBtn) return;
        submitBtn.addEventListener('click', function () {
            const text = textEl && String(textEl.value).trim() !== '' ? String(textEl.value).trim() : '';
            const authorityIds = selectedAuthorityIds();
            if (!text || !authorityIds.length) return;
            const faultEl = document.getElementById('ticketOperatorSubmitFault');
            const isOperatorFault = !!(faultEl && faultEl.checked);
            const submitLabel = opts.submitLabel || 'Submit';
            void (async function () {
                if (opts.confirmMessage) {
                    const confirmed =
                        typeof global.appConfirm === 'function'
                            ? await global.appConfirm(opts.confirmMessage, {
                                  title: 'Submit to USAN',
                                  confirmText: 'Submit',
                                  cancelText: 'Cancel',
                              })
                            : true;
                    if (!confirmed) return;
                }
                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting…';
                if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                    global.submitJobPoller.beginEnqueueFeedback('Submitting…');
                }
                if (typeof global.showToast === 'function') {
                    global.showToast('Submitting', 'success');
                }
                try {
                    await opts.onSubmit({
                        text: text,
                        authorityIds: authorityIds,
                        isOperatorFault: isOperatorFault,
                    });
                    closeOverlay();
                } catch (_e) {
                    if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
                        global.submitJobPoller.endEnqueueFeedback();
                    }
                    submitBtn.disabled = false;
                    submitBtn.textContent = submitLabel;
                }
            })();
        });
    }

    /**
     * @param {object} opts
     * @param {number} opts.organizationId
     * @param {string} opts.operation
     * @param {string} opts.ticketNumber
     * @param {string} opts.text
     * @param {number[]} opts.authorityIds
     * @param {boolean} [opts.isOperatorFault]
     * @param {string} [opts.toastMessage]
     */
    async function submitOperatorSubmitJob(opts) {
        const idempotencyKey =
            typeof global.newIdempotencyKey === 'function' ? global.newIdempotencyKey() : String(Date.now());
        const item = {
            ticketNumber: opts.ticketNumber,
            text: opts.text,
            authorityIds: opts.authorityIds,
            idempotencyKey: idempotencyKey,
        };
        if (opts.isOperatorFault === true) item.isOperatorFault = true;
        try {
            const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: Number(opts.organizationId),
                    operation: opts.operation,
                    items: [item],
                }),
            });
            if (global.submitJobPoller && typeof global.submitJobPoller.registerJob === 'function') {
                global.submitJobPoller.registerJob(data && data.jobId);
            } else if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
                global.submitJobPoller.endEnqueueFeedback();
            }
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            if (typeof global.appAlert === 'function') void global.appAlert(msg);
            throw e;
        }
    }

    global.ticketOperatorSubmitShared = {
        truthyFlag: truthyFlag,
        getOperatorChoices: getOperatorChoices,
        openOperatorSubmitOverlay: openOperatorSubmitOverlay,
        submitOperatorSubmitJob: submitOperatorSubmitJob,
        closeOverlay: closeOverlay,
    };
})(typeof window !== 'undefined' ? window : globalThis);
