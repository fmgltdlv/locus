/**
 * Ticket Hub bulk renewal + auto-clone against POST /api/tickets/renew (server-gated).
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'ticketRenewalBulkOverlay';

    function canPreviewUsanPayload() {
        return !!(
            global.authModule &&
            typeof global.authModule.isDev === 'function' &&
            global.authModule.isDev()
        );
    }

    function overlayRoot() {
        return document.getElementById(OVERLAY_ID);
    }

    function closeOverlay() {
        const x = overlayRoot();
        if (x) x.remove();
    }

    function qs(sel, root) {
        return (root || document).querySelector(sel);
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function ticketNumberLine(t) {
        if (!t || typeof t !== 'object') return '—';
        const tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        if (tn) return tn;
        if (t.id != null && String(t.id).trim()) return String(t.id).trim();
        return '—';
    }

    function actionLabel(action) {
        if (action === 'renew') return 'Ticket Renewable - No New Paint Marks';
        if (action === 'clone_new') return 'New Ticket Will Be Created';
        return 'Ticket Will Be Skipped';
    }

    function eligibleLabel(action, skipReason) {
        if (action === 'renew') return 'Renewable - No New Paint Marks';
        if (action === 'clone_new') return 'New copy';
        const reason = formatSkipReason(skipReason || 'skipped');
        return reason || 'Not eligible';
    }

    function formatSkipReason(reason) {
        if (reason == null || reason === '') return '';
        const s = String(reason).trim();
        const labels = {
            ticket_not_found: 'Ticket not found',
            shared_ticket: 'Shared ticket',
            not_expiring_soon: 'Not expiring soon',
            no_job_number: 'No job number',
            no_enquiry_details: 'No details received from USAN',
            can_remark_instead: 'Remark available instead of renewal',
            auto_clone_disabled: 'New copy not included in this batch',
            skipped: 'Skipped',
        };
        if (labels[s]) return labels[s];
        if (/^[a-z][a-z0-9_]*$/.test(s)) {
            return s
                .split('_')
                .map(function (w) {
                    return w.charAt(0).toUpperCase() + w.slice(1);
                })
                .join(' ');
        }
        return s;
    }

    function isHubRenewUserOrgAdmin() {
        const auth = global.authModule;
        if (!auth) return false;
        if (auth.isDev && auth.isDev()) return true;
        if (typeof auth.canWriteTicketsInCurrentOrg === 'function' && auth.canWriteTicketsInCurrentOrg()) {
            return true;
        }
        const orgId =
            global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                ? global.orgSelectorModule.getCurrentOrgId()
                : null;
        if (orgId == null || orgId === '') return false;
        const oid = Number(orgId);
        if (!Number.isFinite(oid)) return false;
        if (typeof auth.getOrgRoleForOrg === 'function' && auth.getOrgRoleForOrg(oid) === 'admin') return true;
        const u = auth.getCurrentUser && auth.getCurrentUser();
        if (u && Array.isArray(u.adminOrganizationIds) && u.adminOrganizationIds.map(Number).includes(oid)) return true;
        return false;
    }

    function isRenewalFeatureEnabled() {
        return global.LOCUS_ENABLE_TICKET_RENEWAL === true;
    }

    function truthyUsanTicketFlag(v) {
        if (global.ticketRemarkFlow && typeof global.ticketRemarkFlow.truthyUsanTicketFlag === 'function') {
            return global.ticketRemarkFlow.truthyUsanTicketFlag(v);
        }
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    function ticketCanBeRenewal(ticket) {
        if (!ticket) return false;
        return truthyUsanTicketFlag(ticket.canBeRenewal) || truthyUsanTicketFlag(ticket.can_be_renewal);
    }

    function shouldShowRenewButton(ticket) {
        if (!ticket || ticket.shared) return false;
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            return false;
        }
        return ticketCanBeRenewal(ticket);
    }

    function matchPreviewToTicket(previewTickets, hubTicket) {
        const tn = hubTicket && hubTicket.ticketNumber != null ? String(hubTicket.ticketNumber).trim() : '';
        return (previewTickets || []).find(function (p) {
            return p && String(p.ticketNumber).trim() === tn;
        });
    }

    function confirmMarkup(list, previewData) {
        const tickets = previewData && previewData.tickets ? previewData.tickets : [];
        const summary = previewData && previewData.summary ? previewData.summary : {};
        const cloneCount = summary.clone_new || 0;
        const rows = (list || [])
            .map(function (t) {
                const p = matchPreviewToTicket(tickets, t);
                const action = p && p.action ? p.action : 'skip';
                let rowClass = '';
                if (action === 'skip') rowClass = 'renewal-mock-table-row--skip';
                else if (action === 'clone_new') rowClass = 'renewal-mock-table-row--warn';
                const eligible = eligibleLabel(action, p && p.skipReason);
                const eligibleExtra =
                    action === 'clone_new'
                        ? ' <span class="renewal-mock-eligible-note">(new base ticket)</span>'
                        : '';
                return (
                    '<tr class="' +
                    rowClass +
                    '"><td>' +
                    esc(ticketNumberLine(t)) +
                    '</td><td>' +
                    esc(eligible) +
                    eligibleExtra +
                    '</td></tr>'
                );
            })
            .join('');

        const passwordBlock =
            cloneCount > 0
                ? '<div class="ticket-hub-mock-field" style="margin-top:0.75rem">' +
                  '<label class="ticket-hub-mock-label" for="renewBulkPassword">Your account password (required for new copies)</label>' +
                  '<input type="password" id="renewBulkPassword" class="ticket-hub-mock-input" autocomplete="current-password" />' +
                  '</div>'
                : '';

        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Renew selected tickets</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="renewal-mock-table-wrap">' +
            '<table class="renewal-mock-table">' +
            '<caption class="renewal-mock-sr-only">Selected tickets renewal eligibility</caption>' +
            '<thead><tr><th>Ticket</th><th>Eligible</th></tr></thead>' +
            '<tbody>' +
            rows +
            '</tbody></table>' +
            '</div>' +
            passwordBlock +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-renewal-bulk-dismiss>Cancel</button>' +
            (canPreviewUsanPayload()
                ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-renewal-bulk-preview-payload>Preview USAN payload</button>' +
                  '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-renewal-bulk-dry-run>Dry run progress</button>'
                : '') +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-renewal-bulk-submit>Continue</button>' +
            '</div>'
        );
    }

    function loadingPreviewMarkup() {
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Renew selected tickets</h3>' +
            '</div>' +
            '<div class="renewal-mock-spinner-row" aria-busy="true">' +
            '<span class="renewal-mock-spinner" aria-hidden="true"></span>' +
            '<span role="status">Loading renewal preview from the server…</span>' +
            '</div>'
        );
    }

    function notifyRenewalBusy(message) {
        if (typeof global.showToast === 'function') {
            global.showToast(message, 'success');
        }
    }

    function buildRenewSubmitQueue(list, previewData) {
        const tickets = previewData && previewData.tickets ? previewData.tickets : [];
        const queue = [];
        (list || []).forEach(function (t) {
            const p = matchPreviewToTicket(tickets, t);
            const action = p && p.action ? p.action : 'skip';
            if (action === 'renew' || action === 'clone_new') {
                const tn = ticketNumberLine(t);
                queue.push({
                    ticketNumber: tn,
                    action: action,
                    label: actionLabel(action) + ' ' + tn,
                });
            }
        });
        return queue;
    }

    function skippedResultsFromPreview(list, previewData) {
        const tickets = previewData && previewData.tickets ? previewData.tickets : [];
        const out = [];
        (list || []).forEach(function (t) {
            const p = matchPreviewToTicket(tickets, t);
            if (p && p.action === 'skip') {
                out.push({
                    ticketNumber: ticketNumberLine(t),
                    ok: false,
                    error: formatSkipReason(p.skipReason || 'skipped'),
                    actionTaken: 'skip',
                });
            }
        });
        return out;
    }

    function failureReasonsFromResults(results) {
        const bsp = global.bulkSubmitProgress;
        return (results || [])
            .filter(function (r) {
                return !r.ok;
            })
            .map(function (r) {
                const rawMsg =
                    r.error != null && String(r.error).trim() !== ''
                        ? formatSkipReason(r.error)
                        : 'Submit failed';
                const code = r.code != null && String(r.code).trim() ? String(r.code).trim() : 'RENEW_FAILED';
                const msg =
                    bsp && typeof bsp.plainTicketFailureMessage === 'function'
                        ? bsp.plainTicketFailureMessage({ code: code, msg: rawMsg })
                        : rawMsg;
                /** @type {{ code: string, msg: string, supportId?: string, ticketNumber?: string }} */
                const out = { code: code, msg: msg };
                if (r.ticketNumber != null && String(r.ticketNumber).trim()) {
                    out.ticketNumber = String(r.ticketNumber).trim();
                }
                if (r.supportId != null && String(r.supportId).trim()) {
                    out.supportId = String(r.supportId).trim();
                }
                return out;
            });
    }

    function failureDisplayRowsFromResults(results) {
        return failureReasonsFromResults(results).map(function (f) {
            return {
                label: f.ticketNumber || '',
                msg: f.msg,
            };
        });
    }

    function rollupMarkup(results, opts) {
        const dryRun = opts && opts.dryRun === true;
        const ok = (results || []).filter(function (r) {
            return r.ok;
        }).length;
        const fail = (results || []).length - ok;
        const title = dryRun ? 'Dry run complete' : 'Renewal results';
        const pollNote = dryRun
            ? 'This was a simulated submit for UX preview only.'
            : 'Successful renewals appear after the next USAN sync.';
        const bsp = global.bulkSubmitProgress;
        const statStrip =
            bsp && typeof bsp.buildStatStrip === 'function'
                ? bsp.buildStatStrip(ok, fail)
                : '<ul class="renewal-mock-stat-strip"><li><strong>' +
                  ok +
                  '</strong> succeeded</li><li><strong>' +
                  fail +
                  '</strong> failed</li></ul>';
        const failureRows = failureDisplayRowsFromResults(results);
        const failureMarkup =
            failureRows.length && bsp && typeof bsp.buildFailureReasonsMarkup === 'function'
                ? bsp.buildFailureReasonsMarkup(failureRows)
                : '';
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">' +
            esc(title) +
            '</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            statStrip +
            failureMarkup +
            '<p class="ticket-hub-mock-hint renewal-mock-poll-note">' +
            esc(pollNote) +
            '</p>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-renewal-bulk-dismiss>Close</button>' +
            '</div>'
        );
    }

    function dryRunRenewResultsFromStats(queue, stats) {
        const results = [];
        for (let i = 0; i < queue.length; i++) {
            const q = queue[i];
            const failEntry = (stats.failures || []).find(function (f) {
                return f.t === q.label;
            });
            if (failEntry) {
                results.push({
                    ticketNumber: q.ticketNumber,
                    ok: false,
                    error: failEntry.msg,
                    actionTaken: q.action,
                });
            } else {
                results.push({
                    ticketNumber: q.ticketNumber,
                    ok: true,
                    actionTaken: q.action,
                });
            }
        }
        return results;
    }

    /**
     * Enqueue bulk renewal dry run as a background submit job (simulated timing only).
     * @param {{ orgId: number, list: object[], previewData: object, queue: object[], needsPassword: boolean, pwdInput: HTMLInputElement|null }} ctx
     */
    async function runBulkRenewDryRunViaJob(ctx) {
        const queue = ctx.queue || [];
        const orgId = ctx.orgId;

        if (queue.length === 0) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('No tickets in the submit queue for dry run.');
            }
            return;
        }

        const ticketNumbers = queue.map(function (q) {
            return q.ticketNumber;
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
                    organizationId: Number(orgId),
                    operation: 'renew',
                    dryRun: true,
                    ticketNumbers: ticketNumbers,
                    autoCloneExhausted: true,
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
            const msg = e && e.message ? String(e.message) : String(e);
            if (typeof global.appAlert === 'function') await global.appAlert(msg);
            closeOverlay();
        }
    }

    /**
     * Enqueue bulk renewal as a background submit job.
     * @param {{ orgId: number, list: object[], previewData: object, queue: object[], needsPassword: boolean, pwdInput: HTMLInputElement|null }} ctx
     */
    async function runBulkRenewViaJob(ctx) {
        const queue = ctx.queue || [];
        const orgId = ctx.orgId;
        const skipResults = skippedResultsFromPreview(ctx.list, ctx.previewData);

        if (queue.length === 0) {
            openOverlay(rollupMarkup(skipResults));
            return;
        }

        const ticketNumbers = queue.map(function (q) {
            return q.ticketNumber;
        });
        const idempotencyKeys = {};
        for (let i = 0; i < queue.length; i++) {
            const tn = queue[i].ticketNumber;
            idempotencyKeys[tn] =
                typeof global.newIdempotencyKey === 'function'
                    ? global.newIdempotencyKey()
                    : String(Date.now()) + '-' + i;
        }

        const body = {
            organizationId: Number(orgId),
            operation: 'renew',
            ticketNumbers: ticketNumbers,
            idempotencyKeys: idempotencyKeys,
            autoCloneExhausted: true,
        };
        if (ctx.needsPassword && ctx.pwdInput) {
            body.password = String(ctx.pwdInput.value);
        }

        if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
            global.submitJobPoller.beginEnqueueFeedback('Submitting…');
        }
        if (typeof global.showToast === 'function') {
            global.showToast('Submitting', 'success');
        }

        try {
            const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                method: 'POST',
                body: JSON.stringify(body),
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
            const rootErr = overlayRoot();
            if (rootErr) rootErr.removeAttribute('aria-busy');
            const msg = e && e.message ? String(e.message) : String(e);
            if (typeof global.appAlert === 'function') await global.appAlert(msg);
            closeOverlay();
        }
    }

    /**
     * @param {HTMLElement} panel
     * @param {{ orgId: number, list: object[], previewData: object, queue: object[], needsPassword: boolean, pwdInput: HTMLInputElement|null }} ctx
     */
    async function runBulkRenewSequential(panel, ctx) {
        const bsp = global.bulkSubmitProgress;
        const queue = ctx.queue || [];
        const orgId = ctx.orgId;
        const skipResults = skippedResultsFromPreview(ctx.list, ctx.previewData);
        const submitResults = [];

        if (queue.length === 0) {
            const failureLog = failureReasonsFromResults(skipResults);
            if (failureLog.length && bsp && typeof bsp.logSubmitFailures === 'function') {
                bsp.logSubmitFailures('ticket-renew', failureLog, { organizationId: orgId, skippedOnly: true });
            }
            openOverlay(rollupMarkup(skipResults));
            return;
        }

        notifyRenewalBusy(
            queue.length === 1
                ? 'Renewal in progress with USAN — please wait.'
                : 'Renewing ' + queue.length + ' tickets with USAN — please wait.'
        );

        const root = overlayRoot();
        if (root) root.setAttribute('aria-busy', 'true');

        /** @type {object|null} */
        let progress = null;
        if (bsp && typeof bsp.mount === 'function') {
            progress = bsp.mount(panel, {
                title: 'Renewing tickets…',
                total: queue.length,
                items: queue.map(function (q) {
                    return q.label;
                }),
            });
        }

        for (let ix = 0; ix < queue.length; ix++) {
            const item = queue[ix];
            const tn = item.ticketNumber;
            const idempotencyKey =
                typeof global.newIdempotencyKey === 'function'
                    ? global.newIdempotencyKey()
                    : String(Date.now()) + '-' + ix;

            if (progress && bsp) {
                progress.currentIndex = ix;
                bsp.setPhase(progress, 'preparing');
                bsp.setPhase(progress, 'submitting');
                bsp.startInFlight(progress);
            }

            const body = {
                organizationId: Number(orgId),
                ticketNumbers: [tn],
                idempotencyKeys: {},
            };
            body.idempotencyKeys[tn] = idempotencyKey;
            if (ctx.needsPassword && ctx.pwdInput) {
                body.password = String(ctx.pwdInput.value);
            }

            try {
                const data = await global.authModule.apiRequest('tickets/renew', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });
                const row = data && data.results && data.results[0];
                if (row) submitResults.push(row);
                else {
                    submitResults.push({
                        ticketNumber: tn,
                        ok: false,
                        error: 'No result returned',
                        actionTaken: item.action,
                    });
                }
                if (progress && bsp) bsp.markComplete(progress, ix, !!(row && row.ok));
            } catch (e) {
                const bspNorm = global.bulkSubmitProgress;
                const err =
                    bspNorm && typeof bspNorm.normalizeFailure === 'function'
                        ? bspNorm.normalizeFailure(e)
                        : { code: 'RENEW_FAILED', msg: e && e.message ? String(e.message) : String(e) };
                submitResults.push({
                    ticketNumber: tn,
                    ok: false,
                    error: err.msg,
                    code: err.code,
                    supportId: err.supportId,
                    actionTaken: item.action,
                });
                if (progress && bsp) bsp.markComplete(progress, ix, false);
            } finally {
                if (progress && bsp) bsp.stopInFlight(progress);
            }
        }

        if (progress && bsp) bsp.destroy(progress);
        const rootDone = overlayRoot();
        if (rootDone) rootDone.removeAttribute('aria-busy');

        const allResults = skipResults.concat(submitResults);
        const failureLog = failureReasonsFromResults(allResults);
        if (failureLog.length && bsp && typeof bsp.logSubmitFailures === 'function') {
            bsp.logSubmitFailures('ticket-renew', failureLog, { organizationId: orgId, total: allResults.length });
        }
        openOverlay(rollupMarkup(allResults));
    }

    function preventOverlayDismiss() {
        const root = overlayRoot();
        if (!root) return;
        root.querySelectorAll('[data-renewal-bulk-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
            btn.disabled = true;
            btn.hidden = true;
        });
    }

    function openOverlay(html, opts) {
        closeOverlay();
        const preventDismiss = opts && opts.preventDismiss === true;
        const wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Bulk ticket renewal');
        wrap.innerHTML = '<div class="ticket-hub-mock-panel renewal-mock-panel--wide">' + html + '</div>';
        document.body.appendChild(wrap);
        const panel = wrap.querySelector('.ticket-hub-mock-panel');
        if (!preventDismiss) {
            wrap.querySelectorAll('[data-renewal-bulk-dismiss], .ticket-hub-mock-close').forEach(function (btn) {
                btn.addEventListener('click', closeOverlay);
            });
            wrap.addEventListener('click', function (ev) {
                if (ev.target === wrap) closeOverlay();
            });
        }
        if (panel) {
            panel.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }
    }

    /**
     * @param {object[]} hubTickets
     */
    function openBulkRenewalFromTickets(hubTickets) {
        if (!isRenewalFeatureEnabled()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket renewal is not enabled.');
            return;
        }
        if (!isHubRenewUserOrgAdmin()) {
            if (typeof global.appAlert === 'function') void global.appAlert('Only organization admins can renew tickets.');
            return;
        }
        const list = hubTickets && hubTickets.length ? hubTickets : [];
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

        const ticketNumbers = list
            .map(function (t) {
                return t && t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
            })
            .filter(Boolean);

        openOverlay(loadingPreviewMarkup(), { preventDismiss: true });

        (async function () {
            let previewData;
            try {
                previewData = await global.authModule.apiRequest('tickets/renew/preview', {
                    method: 'POST',
                    body: JSON.stringify({
                        organizationId: Number(orgId),
                        ticketNumbers: ticketNumbers,
                    }),
                });
            } catch (e) {
                closeOverlay();
                const msg = e && e.message ? String(e.message) : String(e);
                if (typeof global.appAlert === 'function') await global.appAlert(msg);
                return;
            }

            openOverlay(confirmMarkup(list, previewData));
            const root = overlayRoot();
            if (!root) return;

            const previewPayloadBtn = qs('[data-renewal-bulk-preview-payload]', root);
            if (previewPayloadBtn) {
                previewPayloadBtn.addEventListener('click', function () {
                    const preview = global.usanPayloadPreview;
                    if (
                        !preview ||
                        typeof preview.fetchBulkRenewPayloadPreview !== 'function' ||
                        typeof preview.formatBulkRenewPreviewDocument !== 'function'
                    ) {
                        return;
                    }
                    const run = async function () {
                        try {
                            const renewResponse = await preview.fetchBulkRenewPayloadPreview({
                                organizationId: Number(orgId),
                                ticketNumbers: ticketNumbers,
                            });
                            const doc = preview.formatBulkRenewPreviewDocument({
                                organizationId: Number(orgId),
                                hubTickets: list,
                                previewData: previewData,
                                renewDryRunResponse: renewResponse,
                            });
                            preview.open({
                                title: 'USAN payload preview (bulk renew)',
                                hint: preview.BULK_RENEW_PREVIEW_HINT || '',
                                json: doc,
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
                        void preview.withPreviewButtonLoading(previewPayloadBtn, 'Loading…', run);
                    } else {
                        void run();
                    }
                });
            }

            const submit = qs('[data-renewal-bulk-submit]', root);
            const needsPassword = (previewData.summary && previewData.summary.clone_new) > 0;
            const pwdInput = document.getElementById('renewBulkPassword');

            function updateProceedState() {
                if (!submit) return;
                const submitQueueCheck = buildRenewSubmitQueue(list, previewData);
                if (submitQueueCheck.length === 0) {
                    submit.disabled = true;
                    return;
                }
                if (needsPassword && pwdInput && String(pwdInput.value).trim() === '') {
                    submit.disabled = true;
                } else {
                    submit.disabled = false;
                }
            }
            if (needsPassword && pwdInput) {
                pwdInput.addEventListener('input', updateProceedState);
            }
            updateProceedState();

            if (!submit) return;

            const dryRunBtn = qs('[data-renewal-bulk-dry-run]', root);
            const submitQueue = buildRenewSubmitQueue(list, previewData);

            function lockConfirmActions() {
                if (submit) {
                    submit.disabled = true;
                    submit.textContent = 'Submitting…';
                }
                if (dryRunBtn) {
                    dryRunBtn.disabled = true;
                    dryRunBtn.textContent = 'Submitting…';
                }
            }

            function buildRenewCtx() {
                return {
                    orgId: Number(orgId),
                    list: list,
                    previewData: previewData,
                    queue: submitQueue,
                    needsPassword: needsPassword,
                    pwdInput: pwdInput,
                    password:
                        needsPassword && pwdInput ? String(pwdInput.value) : '',
                };
            }

            if (dryRunBtn) {
                dryRunBtn.addEventListener(
                    'click',
                    function onDryRun() {
                        lockConfirmActions();
                        void runBulkRenewDryRunViaJob(buildRenewCtx());
                    },
                    { once: true }
                );
            }

            submit.addEventListener('click', function onContinue() {
                if (needsPassword && pwdInput && String(pwdInput.value).trim() === '') {
                    if (typeof global.appAlert === 'function') {
                        void global.appAlert('Enter your account password for new copies.');
                    }
                    return;
                }
                if (submitQueue.length === 0) {
                    if (typeof global.appAlert === 'function') {
                        void global.appAlert('No tickets are eligible to renew.');
                    }
                    return;
                }

                const savedPassword =
                    needsPassword && pwdInput ? String(pwdInput.value) : '';
                const renewCtx = buildRenewCtx();
                renewCtx.password = savedPassword;
                renewCtx.pwdInput = null;

                const ticketByNumber = {};
                (list || []).forEach(function (t) {
                    const tn = ticketNumberLine(t);
                    if (tn && tn !== '—') ticketByNumber[tn] = t;
                });

                closeOverlay();

                const mapReview = global.ticketBulkMapReview;
                if (!mapReview || typeof mapReview.openMapReview !== 'function') {
                    if (typeof global.appAlert === 'function') {
                        void global.appAlert('Map review is not loaded yet.');
                    }
                    return;
                }

                const reviewItems = submitQueue.map(function (q) {
                    return {
                        ticket: ticketByNumber[q.ticketNumber] || { ticketNumber: q.ticketNumber },
                        ticketNumber: q.ticketNumber,
                        actionLabel: q.action === 'clone_new' ? 'New copy' : 'Renew',
                    };
                });

                function reopenPreviewStep() {
                    openBulkRenewalFromTickets(list);
                }

                mapReview.openMapReview({
                    title: 'Review renewals',
                    hint: 'Click a ticket to see it on the map before submitting the refresh.',
                    items: reviewItems,
                    enableNotes: false,
                    submitLabel: 'Submit renewals',
                    onBack: reopenPreviewStep,
                    onCancel: function () {},
                    onSubmit: async function () {
                        const confirmed =
                            typeof global.appConfirm === 'function'
                                ? await global.appConfirm(
                                      'Submit renewal to USAN? Submission runs in the background.',
                                      {
                                          title: 'Submit to USAN',
                                          confirmText: 'Submit',
                                          cancelText: 'Cancel',
                                      }
                                  )
                                : true;
                        if (!confirmed) return false;

                        if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                            global.submitJobPoller.beginEnqueueFeedback('Submitting…');
                        }
                        if (typeof global.showToast === 'function') {
                            global.showToast('Submitting', 'success');
                        }

                        try {
                            const liveOrgId =
                                global.orgSelectorModule &&
                                typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                                    ? global.orgSelectorModule.getCurrentOrgId()
                                    : null;
                            if (
                                liveOrgId == null ||
                                liveOrgId === '' ||
                                Number(liveOrgId) !== Number(renewCtx.orgId)
                            ) {
                                if (typeof global.appAlert === 'function') {
                                    await global.appAlert(
                                        'Organization changed. Cancel and start the renew batch again for the current organization.'
                                    );
                                }
                                return false;
                            }

                            const queue = renewCtx.queue || [];
                            if (queue.length === 0) {
                                if (mapReview.finishAndRestoreHub) mapReview.finishAndRestoreHub();
                                openOverlay(rollupMarkup(skippedResultsFromPreview(renewCtx.list, renewCtx.previewData)));
                                return;
                            }

                            const ticketNumbers = queue.map(function (q) {
                                return q.ticketNumber;
                            });
                            const idempotencyKeys = {};
                            for (let i = 0; i < queue.length; i++) {
                                const tn = queue[i].ticketNumber;
                                idempotencyKeys[tn] =
                                    typeof global.newIdempotencyKey === 'function'
                                        ? global.newIdempotencyKey()
                                        : String(Date.now()) + '-' + i;
                            }

                            const body = {
                                organizationId: Number(renewCtx.orgId),
                                operation: 'renew',
                                ticketNumbers: ticketNumbers,
                                idempotencyKeys: idempotencyKeys,
                                autoCloneExhausted: true,
                            };
                            if (renewCtx.needsPassword && renewCtx.password) {
                                body.password = String(renewCtx.password);
                            }

                            const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                                method: 'POST',
                                body: JSON.stringify(body),
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
        })();
    }

    global.ticketRenewalBulkFlow = {
        openBulkRenewalFromTickets: openBulkRenewalFromTickets,
        shouldShowRenewButton: shouldShowRenewButton,
        isHubRenewUserOrgAdmin: isHubRenewUserOrgAdmin,
        closeForOrgSwitch: function closeForOrgSwitch() {
            closeOverlay();
            if (global.ticketBulkMapReview && typeof global.ticketBulkMapReview.closeForOrgSwitch === 'function') {
                global.ticketBulkMapReview.closeForOrgSwitch();
            }
        },
    };
    global.isTicketRenewalHubEnabled = function () {
        return isRenewalFeatureEnabled() && isHubRenewUserOrgAdmin();
    };
})(typeof window !== 'undefined' ? window : globalThis);
