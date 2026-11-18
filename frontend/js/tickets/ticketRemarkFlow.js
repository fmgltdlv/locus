/**
 * Single-ticket USAN remark (map popup + ticket hub).
 * When EXPIRING_SOON with canBeRenewal and canBeRemark both false, routes to renewal clone-new flow.
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'ticketRemarkOverlay';

    function canPreviewUsanPayload() {
        return !!(
            global.authModule &&
            typeof global.authModule.isDev === 'function' &&
            global.authModule.isDev()
        );
    }

    function truthyUsanTicketFlag(v) {
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    async function confirmUsanSubmit(message) {
        if (typeof global.appConfirm === 'function') {
            return global.appConfirm(message, {
                title: 'Submit to USAN',
                confirmText: 'Submit',
                cancelText: 'Cancel',
            });
        }
        return true;
    }

    /**
     * Same classification as server `classifyRenewActionFromEnquiry` for exhausted expiring locates.
     * @param {object} ticket
     */
    function isCloneNewInsteadOfRemark(ticket) {
        if (!ticket || ticket.status !== 'EXPIRING_SOON') return false;
        return !truthyUsanTicketFlag(ticket.canBeRenewal) && !truthyUsanTicketFlag(ticket.canBeRemark);
    }

    function isRemarkSubmitAvailable(ticket) {
        return (
            truthyUsanTicketFlag(ticket && ticket.canBeRemark) ||
            truthyUsanTicketFlag(ticket && ticket.can_be_remark)
        );
    }

    function ticketCanBeRenewal(ticket) {
        return (
            truthyUsanTicketFlag(ticket && ticket.canBeRenewal) ||
            truthyUsanTicketFlag(ticket && ticket.can_be_renewal)
        );
    }

    function isAmendmentAvailable(ticket) {
        return (
            truthyUsanTicketFlag(ticket && ticket.canBeAmended) ||
            truthyUsanTicketFlag(ticket && ticket.can_be_amended)
        );
    }

    function isAmendmentMenuEnabled(ticket) {
        return isAmendmentAvailable(ticket);
    }

    function isNewTicketInRemarkSlotEnabled(ticket) {
        return false;
    }

    function isNewTicketMenuEnabled(ticket) {
        return false;
    }

    function isRemarkSlotEnabled(ticket) {
        if (!ticket || ticket.shared) return false;
        return isRemarkSubmitAvailable(ticket);
    }

    function isRemarkButtonEnabled(ticket) {
        return isRemarkSlotEnabled(ticket);
    }

    function getAmendmentDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isAmendmentAvailable(ticket)) return '';
        return 'Amendment is not available for this ticket.';
    }

    function getRemarkDisabledReason(ticket) {
        return getRemarkSlotDisabledReason(ticket);
    }

    function getRemarkSlotDisabledReason(ticket) {
        if (!ticket || ticket.shared) return 'Not available on shared tickets.';
        if (isRemarkSubmitAvailable(ticket)) return '';
        return 'Remark is not available for this ticket.';
    }

    function getNewTicketDisabledReason(ticket) {
        return getRemarkSlotDisabledReason(ticket);
    }

    function getNewTicketUnavailableHint(ticket) {
        if (isCloneNewInsteadOfRemark(ticket)) {
            return (
                'This ticket has exhausted its refresh cycles — a remark or renewal can no longer be requested. ' +
                'The only option is to submit a new USAN ticket copied from this locate.'
            );
        }
        return (
            'A remark cannot be requested for this ticket and renewal is no longer available. ' +
            'Submit a new USAN ticket copied from this locate.'
        );
    }

    /**
     * Positive knowledge that every required utility operator has responded.
     * Prefers nGen aggregate counts; falls back to loaded operator rows.
     * Mirrors getTicketResponseProgress().complete in tickets-core.js.
     * @param {object} ticket
     */
    function allOperatorsResponded(ticket) {
        if (!ticket || typeof ticket !== 'object') return false;
        const req = ticket.ngenRequiredResponseCount;
        const rec = ticket.ngenReceivedResponseCount;
        const reqNum =
            req != null && String(req).trim() !== '' && Number.isFinite(Number(req)) ? Number(req) : null;
        const recNum =
            rec != null && String(rec).trim() !== '' && Number.isFinite(Number(rec)) ? Number(rec) : null;
        if (reqNum != null) return recNum != null && recNum >= reqNum;
        const rows = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
        if (rows === 0) return false;
        const outstanding = Array.isArray(ticket.outstandingOperators) ? ticket.outstandingOperators.length : null;
        return outstanding === 0;
    }

    /**
     * Route a Remark-slot click to the correct upstream action.
     * @param {object} ticket
     * @returns {'remark'|'use_renew'|'create_new'|'blocked'}
     */
    function classifyRemarkClick(ticket) {
        if (isRemarkSubmitAvailable(ticket)) return 'remark';
        if (ticketCanBeRenewal(ticket)) return 'use_renew';
        return 'unavailable';
    }

    function shouldShowRemarkButton(ticket) {
        if (!ticket || ticket.shared) return false;
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            return false;
        }
        return true;
    }

    /**
     * @param {object} ticket
     * @returns {{ label: string, mode: string }}
     */
    function getRemarkActionUi(ticket) {
        const mode = classifyRemarkClick(ticket);
        return { label: 'Remark', mode: mode };
    }

    function closeOverlay() {
        const x = document.getElementById(OVERLAY_ID);
        if (x) x.remove();
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function ticketLabel(t) {
        if (!t) return '—';
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        return tn || (t.id != null ? String(t.id) : '—');
    }

    const SUBMIT_OVERLAY_CONFIG = {
        remark: {
            title: 'Remark',
            hint: 'Notify locators that an area on this ticket needs to be remarked.',
            fieldLabel: 'Note for locators',
            placeholder: 'Describe the area that needs remarking',
            submitLabel: 'Submit remark',
            previewTitle: 'USAN payload preview (remark)',
            operation: 'remark',
            toast: 'Submitting remark to USAN in the background',
            failureCode: 'REMARK_FAILED',
            emptyMsg: 'Enter remark text.',
            previewRoute: 'remark',
            logContext: 'ticket-remark',
            confirmMessage: 'Submit this remark to USAN? Submission runs in the background.',
        },
        amendment: {
            title: 'Amendment',
            hint: 'File a non-scope change such as contact number or job name. Dig polygon, scope, and commencement dates stay locked.',
            fieldLabel: 'Amendment reason',
            placeholder: 'Explain what you are changing (e.g. updated job name or contact)',
            submitLabel: 'Submit amendment',
            previewTitle: 'USAN payload preview (amendment)',
            operation: 'amendment',
            toast: 'Submitting amendment to USAN in the background',
            failureCode: 'AMENDMENT_FAILED',
            emptyMsg: 'Enter amendment reason.',
            previewRoute: 'amendment',
            logContext: 'ticket-amendment',
            confirmMessage: 'Submit this amendment to USAN? Submission runs in the background.',
        },
    };

    /**
     * @param {object} ticket
     * @param {'remark'|'amendment'} kind
     */
    function openTextSubmitOverlay(ticket, kind) {
        const cfg = SUBMIT_OVERLAY_CONFIG[kind];
        if (!cfg) return;
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket actions are not enabled.');
            return;
        }
        if (!ticket) return;

        const enabled =
            kind === 'remark'
                ? isRemarkSubmitAvailable(ticket)
                : isAmendmentAvailable(ticket);
        if (!enabled) {
            const reason = kind === 'remark' ? getRemarkDisabledReason(ticket) : getAmendmentDisabledReason(ticket);
            if (typeof global.appAlert === 'function') void global.appAlert(reason || cfg.title + ' is not available.');
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
        wrap.innerHTML =
            '<div class="ticket-hub-mock-panel">' +
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">' +
            esc(cfg.title) +
            '</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">' +
            esc(cfg.hint) +
            ' Ticket <strong>' +
            esc(ticketLabel(ticket)) +
            '</strong>.</p>' +
            '<div class="ticket-hub-mock-field">' +
            '<label class="ticket-hub-mock-label" for="ticketRemarkText">' +
            esc(cfg.fieldLabel) +
            '</label>' +
            '<textarea class="ticket-hub-mock-textarea" id="ticketRemarkText" rows="4" placeholder="' +
            esc(cfg.placeholder) +
            '"></textarea>' +
            '</div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-remark-dismiss>Cancel</button>' +
            (canPreviewUsanPayload()
                ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-remark-preview-payload>Preview USAN payload</button>'
                : '') +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-remark-submit>' +
            esc(cfg.submitLabel) +
            '</button>' +
            '</div></div>';
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-remark-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeOverlay();
        });

        const previewBtn = wrap.querySelector('[data-remark-preview-payload]');
        if (previewBtn) {
            previewBtn.addEventListener('click', function () {
                const tx = document.getElementById('ticketRemarkText');
                const text = tx && tx.value != null ? String(tx.value) : '';
                const preview = global.usanPayloadPreview;
                const previewFn =
                    cfg.previewRoute === 'amendment'
                        ? preview && preview.fetchAmendmentPayloadPreview
                        : preview && preview.fetchRemarkPayloadPreview;
                if (!previewFn) return;
                const run = async function () {
                    try {
                        const submitPayload = await previewFn({
                            organizationId: Number(orgId),
                            ticketNumber: tn,
                            text: text,
                        });
                        preview.open({
                            title: cfg.previewTitle,
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

        const submit = wrap.querySelector('[data-remark-submit]');
        if (!submit) return;
        submit.addEventListener('click', function () {
            const tx = document.getElementById('ticketRemarkText');
            const text = tx && String(tx.value).trim() !== '' ? String(tx.value).trim() : '';
            if (!text) {
                if (typeof global.appAlert === 'function') void global.appAlert(cfg.emptyMsg);
                return;
            }
            (async function () {
                const confirmed = await confirmUsanSubmit(cfg.confirmMessage || 'Submit to USAN?');
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
                            operation: cfg.operation,
                            items: [
                                {
                                    ticketNumber: tn,
                                    text: text,
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
                                  code: cfg.failureCode,
                                  msg: e && e.message ? String(e.message) : String(e),
                              };
                    if (bsp && typeof bsp.logSubmitFailures === 'function') {
                        bsp.logSubmitFailures(cfg.logContext, [{ ...err, ticketNumber: tn }], {
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
                        submit.textContent = cfg.submitLabel;
                    }
                }
            })();
        });
    }

    /**
     * Open USAN remark overlay — notifies locators an area needs remarking.
     * @param {object} ticket
     */
    function openRemarkFromTicket(ticket) {
        openTextSubmitOverlay(ticket, 'remark');
    }

    /**
     * Open USAN amendment overlay — non-scope field updates.
     * @param {object} ticket
     */
    function openAmendmentFromTicket(ticket) {
        if (global.ticketAmendmentFlow && typeof global.ticketAmendmentFlow.openFromTicket === 'function') {
            global.ticketAmendmentFlow.openFromTicket(ticket);
            return;
        }
        openTextSubmitOverlay(ticket, 'amendment');
    }

    /**
     * @param {object} ticket
     */
    function openSingleRemarkFromTicket(ticket) {
        openRemarkFromTicket(ticket);
    }

    function formatCloneNewDate(value) {
        if (value == null || String(value).trim() === '') return '';
        if (typeof global.formatDate === 'function') {
            try {
                const out = global.formatDate(value);
                if (out && String(out).trim() !== '') return String(out);
            } catch (e) {
                /* fall through to native */
            }
        }
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
        return String(value);
    }

    /**
     * Key ticket fields shown in the create-new confirmation, so the user reviews what they resubmit.
     * @param {object} ticket
     * @returns {{ label: string, value: string }[]}
     */
    function buildCloneNewDetailRows(ticket) {
        if (!ticket || typeof ticket !== 'object') return [];
        const rows = [];
        const push = function (label, value) {
            if (value != null && String(value).trim() !== '') rows.push({ label: label, value: String(value).trim() });
        };
        push('Ticket', ticketLabel(ticket));
        push('Address', ticket.address || ticket.locationSummary);
        const dm = global.ticketHubDisplayMap;
        const typeDisplay =
            dm && typeof dm.formatTicketTypeWithUsanStatus === 'function'
                ? dm.formatTicketTypeWithUsanStatus(ticket)
                : ticket.ngenTicketType;
        push('Ticket type', typeDisplay);
        push('Scope of work', ticket.scopeOfWork || ticket.workDescription);
        const expires = formatCloneNewDate(
            ticket.expirationDate || ticket.ticketExpiration || ticket.workExpires || ticket.expiresAt
        );
        push('Work expires', expires);
        return rows;
    }

    /**
     * Remark is unavailable upstream but all operators have responded: offer to submit a
     * NEW USAN ticket copied from this locate (clone-new). Requires account password and
     * explicit confirmation of the ticket details.
     * @param {object} ticket
     */
    function openCreateNewFromRemark(ticket) {
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket actions are not enabled.');
            return;
        }
        if (!isNewTicketInRemarkSlotEnabled(ticket)) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert(getRemarkSlotDisabledReason(ticket) || 'New ticket is not available for this ticket.');
            }
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

        const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket number is missing.');
            return;
        }

        const hintHtml = getNewTicketUnavailableHint(ticket);
        const detailRows = buildCloneNewDetailRows(ticket);
        const detailsHtml = detailRows
            .map(function (r) {
                return (
                    '<div class="ticket-hub-mock-detail-row"><span class="ticket-hub-mock-detail-label">' +
                    esc(r.label) +
                    ':</span> <span class="ticket-hub-mock-detail-value">' +
                    esc(r.value) +
                    '</span></div>'
                );
            })
            .join('');

        closeOverlay();
        const wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.innerHTML =
            '<div class="ticket-hub-mock-panel">' +
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Create new ticket</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">' +
            esc(hintHtml) +
            ' Ticket <strong>' +
            esc(ticketLabel(ticket)) +
            '</strong>.</p>' +
            '<div class="ticket-hub-mock-field">' +
            '<div class="ticket-hub-mock-label">Review the ticket you are about to resubmit</div>' +
            '<div class="ticket-hub-mock-detail-list">' +
            (detailsHtml || '<div class="ticket-hub-mock-detail-row">Ticket ' + esc(ticketLabel(ticket)) + '</div>') +
            '</div>' +
            '</div>' +
            '<div class="ticket-hub-mock-field">' +
            '<label class="ticket-hub-mock-label" for="ticketRemarkNewPassword">Enter your account password to create a new ticket based on this existing ticket</label>' +
            '<input type="password" id="ticketRemarkNewPassword" class="ticket-hub-mock-input" autocomplete="current-password" />' +
            '</div>' +
            '<label class="ticket-hub-mock-confirm">' +
            '<input type="checkbox" id="ticketRemarkNewConfirm" />' +
            '<span>I have reviewed the details above and confirm I want to submit a new USAN ticket copied from this one.</span>' +
            '</label>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-remark-new-dismiss>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-remark-new-submit disabled>Create new ticket</button>' +
            '</div></div>';
        document.body.appendChild(wrap);

        wrap.querySelectorAll('[data-remark-new-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeOverlay();
        });

        const pwdInput = document.getElementById('ticketRemarkNewPassword');
        const confirmInput = document.getElementById('ticketRemarkNewConfirm');
        const submit = wrap.querySelector('[data-remark-new-submit]');
        if (!submit) return;
        function updateCreateNewSubmitState() {
            const hasPwd = !!pwdInput && String(pwdInput.value).trim() !== '';
            const confirmed = !!confirmInput && confirmInput.checked;
            submit.disabled = !(hasPwd && confirmed);
        }
        if (pwdInput) pwdInput.addEventListener('input', updateCreateNewSubmitState);
        if (confirmInput) confirmInput.addEventListener('change', updateCreateNewSubmitState);
        updateCreateNewSubmitState();

        submit.addEventListener('click', function () {
            const password = pwdInput && pwdInput.value != null ? String(pwdInput.value) : '';
            if (String(password).trim() === '') {
                if (typeof global.appAlert === 'function') void global.appAlert('Enter your account password.');
                return;
            }
            if (!confirmInput || !confirmInput.checked) {
                if (typeof global.appAlert === 'function') {
                    void global.appAlert('Confirm the details before submitting a new ticket.');
                }
                return;
            }
            (async function () {
                const confirmed = await confirmUsanSubmit(
                    'Submit a new USAN ticket copied from this locate? This creates a new ticket, not a remark request.'
                );
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
                            operation: 'clone_new',
                            password: password,
                            items: [
                                {
                                    ticketNumber: tn,
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
                                  code: 'CLONE_NEW_FAILED',
                                  msg: e && e.message ? String(e.message) : String(e),
                              };
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
                        submit.textContent = 'Create new ticket';
                    }
                }
            })();
        });
    }

    global.ticketRemarkFlow = {
        openSingleRemarkFromTicket: openSingleRemarkFromTicket,
        openRemarkFromTicket: openRemarkFromTicket,
        openAmendmentFromTicket: openAmendmentFromTicket,
        openCreateNewFromRemark: openCreateNewFromRemark,
        truthyUsanTicketFlag: truthyUsanTicketFlag,
        isCloneNewInsteadOfRemark: isCloneNewInsteadOfRemark,
        isRemarkSubmitAvailable: isRemarkSubmitAvailable,
        isAmendmentAvailable: isAmendmentAvailable,
        isAmendmentMenuEnabled: isAmendmentMenuEnabled,
        getAmendmentDisabledReason: getAmendmentDisabledReason,
        isRemarkButtonEnabled: isRemarkButtonEnabled,
        getRemarkDisabledReason: getRemarkDisabledReason,
        isNewTicketMenuEnabled: isNewTicketMenuEnabled,
        isNewTicketInRemarkSlotEnabled: isNewTicketInRemarkSlotEnabled,
        isRemarkSlotEnabled: isRemarkSlotEnabled,
        getNewTicketDisabledReason: getNewTicketDisabledReason,
        getRemarkSlotDisabledReason: getRemarkSlotDisabledReason,
        getNewTicketUnavailableHint: getNewTicketUnavailableHint,
        allOperatorsResponded: allOperatorsResponded,
        classifyRemarkClick: classifyRemarkClick,
        shouldShowRemarkButton: shouldShowRemarkButton,
        getRemarkActionUi: getRemarkActionUi,
    };
})(typeof window !== 'undefined' ? window : globalThis);
