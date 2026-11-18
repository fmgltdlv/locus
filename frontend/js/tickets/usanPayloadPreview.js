/**
 * USAN SubmitCurrentUserEnquiryAsync JSON preview (shared modal).
 * Remark / bulk renew: live payload via POST dryRun. Create-ticket wizard uses client-built JSON.
 */
(function (global) {
    'use strict';

    const MODAL_ID = 'createTicketPayloadPreviewModal';
    const TEXTAREA_ID = 'ctwPayloadPreviewText';
    const TITLE_ID = 'usanPayloadPreviewTitle';
    const HINT_ID = 'usanPayloadPreviewHint';

    const CREATE_TICKET_DEFAULT_TITLE = 'USAN payload preview';
    const CREATE_TICKET_DEFAULT_HINT =
        'Preview only. <code>commencesOnDate</code> / <code>commencesOnTime</code> come from your planned work start; USAN applies legal start on submit. Use <strong>Submit to USAN</strong> in the wizard to lodge the ticket.';

    const REMARK_PREVIEW_HINT =
        'Built from live nGen enquiry for this ticket. <code>ammendReason</code> uses the remark field (or placeholder if empty).';
    const BULK_RENEW_PREVIEW_HINT =
        'Built from live nGen enquiry per ticket. Skipped tickets have no payload.';

    function matchPreviewToTicket(previewTickets, hubTicket) {
        const tn = hubTicket && hubTicket.ticketNumber != null ? String(hubTicket.ticketNumber).trim() : '';
        return (previewTickets || []).find(function (p) {
            return p && String(p.ticketNumber).trim() === tn;
        });
    }

    function resultByTicketNumber(results, ticketNumber) {
        const tn = String(ticketNumber).trim();
        return (results || []).find(function (r) {
            return r && String(r.ticketNumber).trim() === tn;
        });
    }

    /**
     * @param {{ title?: string, hint?: string, json?: object|string }} [opts]
     */
    function openUsanPayloadPreview(opts) {
        opts = opts || {};
        const modal = document.getElementById(MODAL_ID);
        const ta = document.getElementById(TEXTAREA_ID);
        const titleEl = document.getElementById(TITLE_ID);
        const hintEl = document.getElementById(HINT_ID);

        let jsonStr = '';
        if (opts.json != null) {
            jsonStr =
                typeof opts.json === 'string'
                    ? opts.json
                    : JSON.stringify(opts.json, null, 2);
        }

        if (ta) ta.value = jsonStr;
        if (titleEl) {
            titleEl.textContent =
                opts.title != null && String(opts.title).trim() !== ''
                    ? String(opts.title)
                    : CREATE_TICKET_DEFAULT_TITLE;
        }
        if (hintEl) {
            hintEl.innerHTML =
                opts.hint != null && String(opts.hint).trim() !== ''
                    ? String(opts.hint)
                    : CREATE_TICKET_DEFAULT_HINT;
        }
        if (modal) {
            modal.style.display = 'flex';
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeUsanPayloadPreview() {
        const modal = document.getElementById(MODAL_ID);
        if (modal) {
            modal.style.display = 'none';
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function copyUsanPayloadPreview() {
        const ta = document.getElementById(TEXTAREA_ID);
        if (!ta || !ta.value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(ta.value).catch(function () {
                try {
                    ta.select();
                    document.execCommand('copy');
                } catch (e2) {
                    /* ignore */
                }
            });
        } else {
            try {
                ta.select();
                document.execCommand('copy');
            } catch (e) {
                /* ignore */
            }
        }
    }

    function apiRequest(path, body) {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') {
            return Promise.reject(new Error('API client is not available.'));
        }
        return global.authModule.apiRequest(path, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    /**
     * @param {{ organizationId: number, ticketNumber: string, text?: string }} opts
     * @returns {Promise<object>}
     */
    async function fetchRemarkPayloadPreview(opts) {
        const orgId = opts && opts.organizationId != null ? Number(opts.organizationId) : NaN;
        const tn = opts && opts.ticketNumber != null ? String(opts.ticketNumber).trim() : '';
        const text = opts && opts.text != null ? String(opts.text).trim() : '';
        if (!Number.isFinite(orgId)) throw new Error('organizationId is required');
        if (!tn) throw new Error('ticketNumber is required');

        const data = await apiRequest('tickets/remark', {
            organizationId: orgId,
            ticketNumber: tn,
            text: text,
            dryRun: true,
        });
        if (!data || data.submitPayload == null) {
            throw new Error('No submitPayload returned from remark preview.');
        }
        return data.submitPayload;
    }

    async function fetchAmendmentPayloadPreview(opts) {
        const orgId = opts && opts.organizationId != null ? Number(opts.organizationId) : NaN;
        const tn = opts && opts.ticketNumber != null ? String(opts.ticketNumber).trim() : '';
        const text = opts && opts.text != null ? String(opts.text).trim() : '';
        if (!Number.isFinite(orgId)) throw new Error('organizationId is required');
        if (!tn) throw new Error('ticketNumber is required');

        const data = await apiRequest('tickets/amendment', {
            organizationId: orgId,
            ticketNumber: tn,
            text: text,
            fields: opts.fields != null && typeof opts.fields === 'object' ? opts.fields : undefined,
            dryRun: true,
        });
        if (!data || data.submitPayload == null) {
            throw new Error('No submitPayload returned from amendment preview.');
        }
        return data.submitPayload;
    }

    /**
     * @param {{ organizationId: number, ticketNumber: string, route: string, text?: string, authorityIds?: number[], isOperatorFault?: boolean }} opts
     * @returns {Promise<object>}
     */
    async function fetchOperatorSubmitPayloadPreview(opts) {
        const orgId = opts && opts.organizationId != null ? Number(opts.organizationId) : NaN;
        const tn = opts && opts.ticketNumber != null ? String(opts.ticketNumber).trim() : '';
        const route = opts && opts.route != null ? String(opts.route).trim() : '';
        if (!Number.isFinite(orgId)) throw new Error('organizationId is required');
        if (!tn) throw new Error('ticketNumber is required');
        if (!route) throw new Error('route is required');
        const body = {
            organizationId: orgId,
            ticketNumber: tn,
            text: opts.text != null ? String(opts.text) : '<preview>',
            authorityIds: Array.isArray(opts.authorityIds) ? opts.authorityIds : [0],
            dryRun: true,
        };
        if (opts.isOperatorFault === true) body.isOperatorFault = true;
        const data = await apiRequest('tickets/' + route, body);
        if (!data || data.submitPayload == null) {
            throw new Error('No submitPayload returned from operator submit preview.');
        }
        return data.submitPayload;
    }

    /**
     * @param {{ organizationId: number, ticketNumbers: string[] }} opts
     * @returns {Promise<object>}
     */
    async function fetchBulkRenewPayloadPreview(opts) {
        const orgId = opts && opts.organizationId != null ? Number(opts.organizationId) : NaN;
        const ticketNumbers = (opts && opts.ticketNumbers) || [];
        if (!Number.isFinite(orgId)) throw new Error('organizationId is required');
        if (!ticketNumbers.length) throw new Error('ticketNumbers is required');

        return apiRequest('tickets/renew', {
            organizationId: orgId,
            ticketNumbers: ticketNumbers,
            dryRun: true,
        });
    }

    /**
     * @param {{ organizationId?: number, hubTickets?: object[], previewData?: object, renewDryRunResponse?: object }} opts
     */
    function formatBulkRenewPreviewDocument(opts) {
        const hubTickets = (opts && opts.hubTickets) || [];
        const previewData = (opts && opts.previewData) || {};
        const previewTickets = previewData.tickets || [];
        const results = (opts && opts.renewDryRunResponse && opts.renewDryRunResponse.results) || [];
        const orgId = opts && opts.organizationId != null ? opts.organizationId : null;

        return {
            dryRun: true,
            organizationId: orgId,
            summary: opts && opts.renewDryRunResponse && opts.renewDryRunResponse.summary ? opts.renewDryRunResponse.summary : null,
            tickets: hubTickets.map(function (t) {
                const p = matchPreviewToTicket(previewTickets, t);
                const action = p && p.action ? p.action : 'skip';
                const tn = t && t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
                const r = resultByTicketNumber(results, tn);
                return {
                    ticketNumber: tn || '—',
                    action: action,
                    skipReason: p && p.skipReason ? p.skipReason : null,
                    previewOk: r ? r.ok === true : false,
                    previewError: r && !r.ok && r.error ? r.error : null,
                    submitPayload: r && r.submitPayload != null ? r.submitPayload : null,
                };
            }),
        };
    }

    /**
     * @param {HTMLButtonElement|null} btn
     * @param {string} loadingLabel
     * @param {() => Promise<void>} fn
     */
    async function withPreviewButtonLoading(btn, loadingLabel, fn) {
        const prevLabel = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = loadingLabel;
        }
        openUsanPayloadPreview({ json: 'Loading payload…', title: 'USAN payload preview', hint: '' });
        try {
            await fn();
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = prevLabel;
            }
        }
    }

    global.usanPayloadPreview = {
        open: openUsanPayloadPreview,
        close: closeUsanPayloadPreview,
        copy: copyUsanPayloadPreview,
        fetchRemarkPayloadPreview: fetchRemarkPayloadPreview,
        fetchAmendmentPayloadPreview: fetchAmendmentPayloadPreview,
        fetchOperatorSubmitPayloadPreview: fetchOperatorSubmitPayloadPreview,
        fetchBulkRenewPayloadPreview: fetchBulkRenewPayloadPreview,
        formatBulkRenewPreviewDocument: formatBulkRenewPreviewDocument,
        withPreviewButtonLoading: withPreviewButtonLoading,
        REMARK_PREVIEW_HINT: REMARK_PREVIEW_HINT,
        BULK_RENEW_PREVIEW_HINT: BULK_RENEW_PREVIEW_HINT,
    };

    global.openUsanPayloadPreview = openUsanPayloadPreview;
    global.closeUsanPayloadPreview = closeUsanPayloadPreview;
    global.copyUsanPayloadPreview = copyUsanPayloadPreview;
})(typeof window !== 'undefined' ? window : globalThis);
