/**
 * USAN amendment overlay — edit ticket details before submit (scope + excavation locked).
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'ticketAmendmentOverlay';

    function esc(s) {
        if (typeof global.escapeHtml === 'function') return global.escapeHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function pickField(ticket, keys) {
        if (!ticket) return '';
        const list = Array.isArray(keys) ? keys : [keys];
        for (let i = 0; i < list.length; i += 1) {
            const v = ticket[list[i]];
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
    }

    function hubField(ticket, providerKey, fallbackKeys) {
        if (typeof global.hubMappedField === 'function') {
            const v = global.hubMappedField(ticket, providerKey);
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return pickField(ticket, fallbackKeys);
    }

    function canPreviewUsanPayload() {
        return !!(
            global.authModule &&
            typeof global.authModule.isDev === 'function' &&
            global.authModule.isDev()
        );
    }

    function closeOverlay() {
        const x = document.getElementById(OVERLAY_ID);
        if (x) x.remove();
    }

    function ticketLabel(t) {
        if (!t) return '—';
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        return tn || (t.id != null ? String(t.id) : '—');
    }

    /**
     * @param {object} ticket
     * @returns {object}
     */
    function buildAmendmentFormState(ticket) {
        return {
            userReference: hubField(ticket, 'jobName', ['ngenUserReference', 'jobName', 'userReference']),
            principalContactName: pickField(ticket, ['ngenPrincipalContactName', 'principalContactName']),
            principalContactMobile: pickField(ticket, ['ngenPrincipalContactPhone', 'principalContactPhone']),
            ammendReason: '',
        };
    }

    /**
     * @param {object} formState
     * @returns {object}
     */
    function collectAmendmentFieldsFromForm(formState) {
        const s = formState || {};
        return {
            userReference: String(s.userReference || '').trim(),
            principalContactName: String(s.principalContactName || '').trim(),
            principalContactMobile: String(s.principalContactMobile || '').trim(),
        };
    }

    function readFormStateFromOverlay() {
        function val(id) {
            const el = document.getElementById(id);
            return el && el.value != null ? String(el.value) : '';
        }
        return {
            userReference: val('ticketAmendmentJobName'),
            principalContactName: val('ticketAmendmentContactName'),
            principalContactMobile: val('ticketAmendmentContactPhone'),
            ammendReason: val('ticketAmendmentReason').trim(),
        };
    }

    function buildAmendmentOverlayHtml(ticket, state) {
        const scope = hubField(ticket, 'ticketScope', ['scopeOfWork', 'ticketScope', 'ngenNotes']);
        const workActivity = hubField(ticket, 'workActivity', ['workActivity', 'categoryOfWork']);
        const excavationMethod = hubField(ticket, 'excavationMethod', ['excavationMethod']);
        const lockedBlock =
            '<div class="ticket-amendment-locked">' +
            '<p class="ticket-hub-mock-label">Locked on amendment</p>' +
            '<dl class="ticket-amendment-locked-dl">' +
            '<dt>Scope of work</dt><dd>' +
            (scope ? esc(scope) : '—') +
            '</dd>' +
            '<dt>Work activity</dt><dd>' +
            (workActivity ? esc(workActivity) : '—') +
            '</dd>' +
            '<dt>Excavation method</dt><dd>' +
            (excavationMethod ? esc(excavationMethod) : '—') +
            '</dd>' +
            '</dl></div>';

        return (
            '<div class="ticket-hub-mock-panel ticket-amendment-panel renewal-mock-panel--wide">' +
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Amendment</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">Update job name or principal contact below. Scope of work and excavation type cannot be changed on an amendment. Ticket <strong>' +
            esc(ticketLabel(ticket)) +
            '</strong>.</p>' +
            lockedBlock +
            '<div class="ticket-amendment-form-grid">' +
            '<div class="ticket-hub-mock-field ticket-amendment-field--full">' +
            '<label class="ticket-hub-mock-label" for="ticketAmendmentJobName">Job name</label>' +
            '<input type="text" class="ticket-hub-mock-input" id="ticketAmendmentJobName" value="' +
            esc(state.userReference) +
            '" autocomplete="off" />' +
            '</div>' +
            '<div class="ticket-hub-mock-field">' +
            '<label class="ticket-hub-mock-label" for="ticketAmendmentContactName">Principal contact name</label>' +
            '<input type="text" class="ticket-hub-mock-input" id="ticketAmendmentContactName" value="' +
            esc(state.principalContactName) +
            '" autocomplete="name" />' +
            '</div>' +
            '<div class="ticket-hub-mock-field">' +
            '<label class="ticket-hub-mock-label" for="ticketAmendmentContactPhone">Principal contact phone</label>' +
            '<input type="tel" class="ticket-hub-mock-input" id="ticketAmendmentContactPhone" value="' +
            esc(state.principalContactMobile) +
            '" autocomplete="tel" />' +
            '</div>' +
            '<div class="ticket-hub-mock-field ticket-amendment-field--full">' +
            '<label class="ticket-hub-mock-label" for="ticketAmendmentReason">Amendment reason</label>' +
            '<textarea class="ticket-hub-mock-textarea" id="ticketAmendmentReason" rows="3" placeholder="Explain what you are changing (required)"></textarea>' +
            '</div>' +
            '</div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-amendment-dismiss>Cancel</button>' +
            (canPreviewUsanPayload()
                ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-amendment-preview-payload>Preview USAN payload</button>'
                : '') +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-amendment-submit>Submit amendment</button>' +
            '</div></div>'
        );
    }

    /**
     * @param {object} ticket
     */
    function openFromTicket(ticket) {
        const remarkFlow = global.ticketRemarkFlow;
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket amendment is not enabled.');
            return;
        }
        if (!ticket) return;
        if (
            !remarkFlow ||
            typeof remarkFlow.isAmendmentMenuEnabled !== 'function' ||
            !remarkFlow.isAmendmentMenuEnabled(ticket)
        ) {
            const reason =
                remarkFlow && typeof remarkFlow.getAmendmentDisabledReason === 'function'
                    ? remarkFlow.getAmendmentDisabledReason(ticket)
                    : 'Amendment is not available.';
            if (typeof global.appAlert === 'function') void global.appAlert(reason);
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

        const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket number is missing.');
            return;
        }

        closeOverlay();
        const wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.innerHTML = buildAmendmentOverlayHtml(ticket, buildAmendmentFormState(ticket));
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-amendment-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeOverlay();
        });

        const previewBtn = wrap.querySelector('[data-amendment-preview-payload]');
        if (previewBtn) {
            previewBtn.addEventListener('click', function () {
                const formState = readFormStateFromOverlay();
                const fields = collectAmendmentFieldsFromForm(formState);
                const preview = global.usanPayloadPreview;
                if (!preview || typeof preview.fetchAmendmentPayloadPreview !== 'function') return;
                const run = async function () {
                    try {
                        const submitPayload = await preview.fetchAmendmentPayloadPreview({
                            organizationId: Number(orgId),
                            ticketNumber: tn,
                            text: formState.ammendReason || '<preview>',
                            fields: fields,
                        });
                        preview.open({
                            title: 'USAN payload preview (amendment)',
                            hint: preview.REMARK_PREVIEW_HINT || '',
                            json: submitPayload,
                        });
                    } catch (e) {
                        if (typeof global.closeUsanPayloadPreview === 'function') {
                            global.closeUsanPayloadPreview();
                        }
                        const msg = e && e.message ? String(e.message) : String(e);
                        if (typeof global.appAlert === 'function') await global.appAlert(msg);
                    }
                };
                if (typeof preview.withPreviewButtonLoading === 'function') {
                    void preview.withPreviewButtonLoading(previewBtn, 'Loading…', run);
                } else {
                    void run();
                }
            });
        }

        const submit = wrap.querySelector('[data-amendment-submit]');
        if (!submit) return;
        submit.addEventListener('click', function () {
            const formState = readFormStateFromOverlay();
            if (!formState.ammendReason) {
                if (typeof global.appAlert === 'function') void global.appAlert('Enter amendment reason.');
                return;
            }
            const fields = collectAmendmentFieldsFromForm(formState);
            const submitLabel = 'Submit amendment';
            (async function () {
                const confirmed =
                    typeof global.appConfirm === 'function'
                        ? await global.appConfirm('Submit this amendment to USAN? Submission runs in the background.', {
                              title: 'Submit to USAN',
                              confirmText: 'Submit',
                              cancelText: 'Cancel',
                          })
                        : true;
                if (!confirmed) return;
                submit.disabled = true;
                submit.textContent = 'Submitting…';
                if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                    global.submitJobPoller.beginEnqueueFeedback('Submitting…');
                }
                if (typeof global.showToast === 'function') {
                    global.showToast('Submitting', 'success');
                }
                const idempotencyKey =
                    typeof global.newIdempotencyKey === 'function' ? global.newIdempotencyKey() : String(Date.now());
                try {
                    const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                        method: 'POST',
                        body: JSON.stringify({
                            organizationId: Number(orgId),
                            operation: 'amendment',
                            items: [
                                {
                                    ticketNumber: tn,
                                    text: formState.ammendReason,
                                    fields: fields,
                                    idempotencyKey: idempotencyKey,
                                },
                            ],
                        }),
                    });
                    closeOverlay();
                    if (global.submitJobPoller && typeof global.submitJobPoller.registerJob === 'function') {
                        global.submitJobPoller.registerJob(data && data.jobId);
                    } else if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
                        global.submitJobPoller.endEnqueueFeedback();
                    }
                } catch (e) {
                    if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
                        global.submitJobPoller.endEnqueueFeedback();
                    }
                    const bsp = global.bulkSubmitProgress;
                    const err =
                        bsp && typeof bsp.normalizeFailure === 'function'
                            ? bsp.normalizeFailure(e)
                            : {
                                  code: 'AMENDMENT_FAILED',
                                  msg: e && e.message ? String(e.message) : String(e),
                              };
                    if (bsp && typeof bsp.logSubmitFailures === 'function') {
                        bsp.logSubmitFailures('ticket-amendment', [{ ...err, ticketNumber: tn }], {
                            organizationId: orgId,
                            ticketNumber: tn,
                        });
                    }
                    const inProgress =
                        err.msg.indexOf('already in progress') !== -1 ||
                        err.msg.indexOf('IDEMPOTENCY_IN_PROGRESS') !== -1 ||
                        err.code === 'IDEMPOTENCY_IN_PROGRESS';
                    const userMsg =
                        bsp && typeof bsp.plainTicketFailureMessage === 'function'
                            ? bsp.plainTicketFailureMessage(err)
                            : err.msg;
                    if (typeof global.appAlert === 'function') {
                        await global.appAlert(
                            inProgress
                                ? 'Submit already in progress — wait a moment or refresh before trying again.'
                                : 'Ticket ' + tn + ': ' + userMsg
                        );
                    }
                    if (!inProgress) {
                        submit.disabled = false;
                        submit.textContent = submitLabel;
                    }
                }
            })();
        });
    }

    global.ticketAmendmentFlow = {
        openFromTicket: openFromTicket,
        buildAmendmentFormState: buildAmendmentFormState,
        collectAmendmentFieldsFromForm: collectAmendmentFieldsFromForm,
    };
})(typeof window !== 'undefined' ? window : globalThis);
