/**
 * Renewal locate UX mocks (no Worker / USAN wiring).
 * Loaded by ticket popup + Ticket Hub bundles; standalone page calls `attachStandaloneDemoHandlers(document)`.
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'renewalUxMockOverlay';
    const SINGLE_SUBMIT_DELAY_MS = 900;
    const BULK_TICKET_STEP_MS = 700;

    const SUBMIT_SCENARIO = [
        { ok: true },
        {
            ok: false,
            code: 'RENEW_SUBMIT_BUSY',
            msg: 'Renewal already in progress for this ticket.',
        },
        {
            ok: false,
            code: 'UPSTREAM_REJECT',
            msg: 'Validation failed — date window closed on server.',
        },
        { ok: true },
    ];

    /** @typedef {{ ticketNumberDisplay: string, eligibleSubmit: boolean, previewHint: string, ticket: object }} BulkPreviewMeta */

    function overlayRoot() {
        return document.getElementById(OVERLAY_ID);
    }

    function closeRenewalUxMockOverlay() {
        var x = overlayRoot();
        if (x) x.remove();
    }

    function qs(sel, root) {
        return (root || document).querySelector(sel);
    }

    function qsa(sel, root) {
        return Array.from((root || document).querySelectorAll(sel));
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function trapFocus(panel) {
        var focusables = qsa(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            panel
        ).filter(function (el) {
            try {
                return el.offsetParent !== null;
            } catch (_) {
                return false;
            }
        });
        if (focusables.length) focusables[0].focus();
    }

    function bindDismissHandlers(wrap) {
        qsa('[data-renewal-mock-dismiss], .ticket-hub-mock-close', wrap).forEach(function (btn) {
            btn.addEventListener('click', closeRenewalUxMockOverlay);
        });
    }

    function attachPanelStopPropagation(panel) {
        if (!panel) return;
        panel.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }

    /**
     * @param {string} panelInnerHtml
     * @param {{ title?: string, widePanel?: boolean }} [opts]
     */
    function openRenewalUxMockOverlay(panelInnerHtml, opts) {
        closeRenewalUxMockOverlay();
        opts = opts || {};
        var wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', opts.title || 'Renew locate');
        var wideCls = opts.widePanel === true ? ' renewal-mock-panel--wide' : '';
        wrap.innerHTML = '<div class="ticket-hub-mock-panel' + wideCls + '">' + panelInnerHtml + '</div>';
        document.body.appendChild(wrap);
        var panel = wrap.querySelector('.ticket-hub-mock-panel');
        bindDismissHandlers(wrap);
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeRenewalUxMockOverlay();
        });
        attachPanelStopPropagation(panel);
        if (panel) trapFocus(panel);
    }

    function truncateOneLine(s, max) {
        var t = String(s == null ? '' : s)
            .replace(/\s+/g, ' ')
            .trim();
        if (t.length <= max) return t;
        return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
    }

    /** @param {object|null|undefined} t */
    function ticketNumberDisplayLine(t) {
        if (!t || typeof t !== 'object') return '—';
        var tn = t.ticketNumber != null ? String(t.ticketNumber).trim() : '';
        if (tn) return tn;
        if (t.id != null && String(t.id).trim()) return String(t.id).trim();
        return '—';
    }

    /** @param {object|null|undefined} t */
    function workflowDisplayLine(t) {
        if (
            global.formatWorkflowStatusDisplay &&
            typeof global.formatWorkflowStatusDisplay === 'function' &&
            t &&
            typeof t === 'object' &&
            t.status != null &&
            String(t.status).trim() !== ''
        ) {
            try {
                return global.formatWorkflowStatusDisplay(t.status);
            } catch (_) {}
        }
        var s = t && t.status != null ? String(t.status).trim() : '';
        return s || '—';
    }

    /** @param {object|null|undefined} t */
    function mockRenewalEligible(t) {
        if (!t || typeof t !== 'object') return false;
        var wf = String(t.status || '')
            .trim()
            .toUpperCase();
        var canRenew =
            t.canBeRenewal === true ||
            t.canBeRenewal === 1 ||
            t.can_be_renewal === 1 ||
            t.can_be_renewal === true;
        return wf === 'EXPIRING_SOON' && Boolean(canRenew);
    }

    /** @param {unknown} v */
    function formatLegalOrDateHuman(v) {
        if (v == null || String(v).trim() === '') return '—';
        if (global.formatDate && typeof global.formatDate === 'function') {
            try {
                return global.formatDate(v);
            } catch (_) {}
        }
        return truncateOneLine(String(v), 72);
    }

    /** @param {object} ticket */
    function legalStartLineMock(ticket) {
        var v =
            ticket.workLegalStartDate ||
            ticket.commencementDate ||
            ticket.work_legal_start_date ||
            ticket.startTime ||
            null;
        return formatLegalOrDateHuman(v);
    }

    /** @param {object} ticket */
    function cloneEnquiryEsc(ticket) {
        var raw =
            ticket.job_number != null
                ? String(ticket.job_number).trim()
                : ticket.jobNumber != null
                  ? String(ticket.jobNumber).trim()
                  : ticket.ngen_job_number != null
                    ? String(ticket.ngen_job_number).trim()
                    : ticket.ngenJobNumber != null
                      ? String(ticket.ngenJobNumber).trim()
                      : '';
        return raw ? esc(raw) : '—';
    }

    /** @param {object} ticket */
    function siteHintEsc(ticket) {
        var a =
            ticket.address ||
            ticket.locationSummary ||
            (ticket.fullAddress && typeof ticket.fullAddress === 'object'
                ? [ticket.fullAddress.street, ticket.fullAddress.city, ticket.fullAddress.state]
                      .filter(Boolean)
                      .map(function (x) {
                          return String(x).trim();
                      })
                      .filter(Boolean)
                      .join(', ')
                : '') ||
            '';
        return esc(truncateOneLine(String(a || ''), 120));
    }

    /** @returns {Promise<void>} */
    function delayMs(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    /** @param {string} tn */
    function fakeNewEnquiryId(tn) {
        var base = tn || '';
        var h = 5381;
        for (var i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) >>> 0;
        return String(750000 + (h % 40000));
    }

    /** @param {object} ticket */
    function singlePreviewMarkupFromTicket(ticket) {
        var tn = ticketNumberDisplayLine(ticket);
        var wf = workflowDisplayLine(ticket);
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Renew locate (preview)</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">' +
            '<strong>Design preview only</strong> — no Worker or USAN call yet. ' +
            'Fields hydrate from this ticket when available.' +
            '</p>' +
            '<dl class="renewal-mock-summary-grid">' +
            '<dt>Ticket</dt><dd>' +
            esc(tn) +
            ' <span class="renewal-mock-muted">' +
            esc(wf) +
            '</span></dd>' +
            '<dt>Clone from enquiry</dt><dd>' +
            cloneEnquiryEsc(ticket) +
            '</dd>' +
            '<dt>Legal start</dt><dd>' +
            esc(legalStartLineMock(ticket)) +
            ' <span class="renewal-mock-muted">after USAN renewal compute</span></dd>' +
            '<dt>Site</dt><dd>' +
            siteHintEsc(ticket) +
            '</dd>' +
            '</dl>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-renewal-mock-dismiss>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-renewal-mock-single-confirm>Confirm renewal</button>' +
            '</div>'
        );
    }

    function submittingMarkupSingle() {
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Submitting renewal…</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close" disabled style="opacity:0.35;cursor:not-allowed">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">Primary stays disabled for the mocked delay — production double-submit guard.</p>' +
            '<div class="renewal-mock-spinner-row" aria-busy="true">' +
            '<span class="renewal-mock-spinner" aria-hidden="true"></span>' +
            '<span>No outbound request fires in this demo.</span>' +
            '</div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" disabled>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" disabled aria-busy="true">Confirm renewal</button>' +
            '</div>'
        );
    }

    /** @param {object} ticket */
    function successMarkupSingle(ticket) {
        var tn = ticketNumberDisplayLine(ticket);
        var nid = fakeNewEnquiryId(tn);
        var draftReq = mockNewDraftRequestLabel(tn);
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Renewal submitted (mock)</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="renewal-mock-success-lead">Illustrative IDs only — upstream would return authoritative values.</p>' +
            '<dl class="renewal-mock-summary-grid">' +
            '<dt>New enquiry id</dt><dd>' +
            esc(nid) +
            '</dd>' +
            '<dt>New request number</dt><dd>' +
            esc(draftReq) +
            ' <span class="renewal-mock-muted">until USAN list sync</span></dd>' +
            '</dl>' +
            '<p class="ticket-hub-mock-hint renewal-mock-poll-note">' +
            'The renewed locate enters this hub automatically on the next <strong>USAN / PAC poll</strong>; no scratch row locally.' +
            '</p>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-renewal-mock-dismiss>Got it</button>' +
            '</div>'
        );
    }

    /** @param {string} tn */
    function mockNewDraftRequestLabel(tn) {
        var clean = tn.replace(/[^\w\-]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '') || 'draft';
        return clean + '-' + Date.now().toString(36).slice(-6);
    }

    /** @param {object|null|undefined} ticket */
    function openSingleRenewalMockFromTicket(ticket) {
        if (!ticket || typeof ticket !== 'object') return;

        openRenewalUxMockOverlay(singlePreviewMarkupFromTicket(ticket), {
            title: 'Renew locate preview',
            widePanel: false,
        });
        var wrap = overlayRoot();
        if (!wrap) return;
        var btn = qs('[data-renewal-mock-single-confirm]', wrap);
        if (!btn) return;
        btn.addEventListener(
            'click',
            function onConfirm() {
                btn.removeEventListener('click', onConfirm);
                var panel = qs('.ticket-hub-mock-panel', wrap);
                if (!panel) return;
                panel.innerHTML = submittingMarkupSingle();
                trapFocus(panel);
                delayMs(SINGLE_SUBMIT_DELAY_MS).then(function () {
                    var w2 = overlayRoot();
                    if (!w2 || w2 !== wrap) return;
                    var p2 = qs('.ticket-hub-mock-panel', w2);
                    if (!p2) return;
                    p2.innerHTML = successMarkupSingle(ticket);
                    bindDismissHandlers(w2);
                    trapFocus(p2);
                });
            },
            false
        );
    }

    /** @param {BulkPreviewMeta[]} previews @param {{ eligibleQueue: BulkPreviewMeta[] }} _ctx */
    function bulkPreviewMarkup(previews, _ctx) {
        var tbody = previews
            .map(function (p) {
                var warn = !p.eligibleSubmit;
                return (
                    '<tr class="' +
                    (warn ? 'renewal-mock-table-row--warn' : '') +
                    '"><td>' +
                    esc(p.ticketNumberDisplay) +
                    '</td><td>' +
                    esc(p.previewHint) +
                    '</td></tr>'
                );
            })
            .join('');
        var eligibleCt = previews.filter(function (p) {
            return p.eligibleSubmit;
        }).length;
        var noGo = eligibleCt === 0;
        var dis = noGo ? ' disabled' : '';
        var warnLine = noGo
            ? '<p class="ticket-hub-mock-hint" style="margin-top:0;color:#fca5a5;font-size:0.72rem">' +
              'Proceed disabled until at least one row is <strong>Expiring Soon</strong> <em>and</em> flagged renewable upstream.' +
              '</p>'
            : '';
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Bulk renew (preview)</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">' +
            previews.length +
            ' ticket row(s): preview scans renewal flag only (mock).' +
            '</p>' +
            '<div class="renewal-mock-table-wrap">' +
            '<table class="renewal-mock-table">' +
            '<caption class="renewal-mock-sr-only">Preview table</caption>' +
            '<thead><tr><th>Ticket</th><th>Preview</th></tr></thead>' +
            '<tbody>' +
            tbody +
            '</tbody></table>' +
            '</div>' +
            warnLine +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-renewal-mock-dismiss>Cancel</button>' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary"' +
            dis +
            ' data-renewal-mock-bulk-proceed>Proceed with renewals</button>' +
            '</div>'
        );
    }

    /** @param {number} doneBefore */
    /** @param {number} total */
    /** @param {string} curTn */
    function bulkProgressMarkup(doneBefore, total) {
        var pct = total <= 0 ? 0 : Math.round((doneBefore / total) * 100);
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Renewing tickets…</h3>' +
            '</div>' +
            '<p class="ticket-hub-mock-hint">' +
            doneBefore +
            ' of ' +
            total +
            ' completed</p>' +
            '<div class="renewal-mock-progress" role="progressbar">' +
            '<div class="renewal-mock-progress-bar" style="width:' +
            pct +
            '%"></div></div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" disabled>Cancel</button>' +
            '</div>'
        );
    }

    /**
     * @param {{ ok: number, fail: number, skip: number, failures: { t: string, code: string, msg: string }[] }} stats
     */
    function bulkRollup(stats) {
        var bsp = global.bulkSubmitProgress;
        var statStrip =
            bsp && typeof bsp.buildStatStrip === 'function'
                ? bsp.buildStatStrip(stats.ok, stats.fail)
                : '<ul class="renewal-mock-stat-strip"><li><strong>' +
                  stats.ok +
                  '</strong> succeeded</li><li><strong>' +
                  stats.fail +
                  '</strong> failed</li></ul>';
        var failureRows = (stats.failures || []).map(function (f) {
            var msg =
                bsp && typeof bsp.plainTicketFailureMessage === 'function'
                    ? bsp.plainTicketFailureMessage({ code: f.code, msg: f.msg })
                    : f.msg;
            return { label: f.t, msg: msg };
        });
        var failureMarkup =
            failureRows.length && bsp && typeof bsp.buildFailureReasonsMarkup === 'function'
                ? bsp.buildFailureReasonsMarkup(failureRows)
                : '';
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">Bulk renew complete</h3>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>' +
            statStrip +
            failureMarkup +
            '<p class="ticket-hub-mock-hint renewal-mock-poll-note">' +
            'Successful renewals still appear after the hub’s polling cycle. Leaving mid-batch is mock-only wording.' +
            '</p>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-renewal-mock-dismiss>Close</button>' +
            '</div>'
        );
    }

    /** @param {object[]} hubTicketsRaw */
    function openBulkRenewalMockTickets(hubTicketsRaw) {
        var hubTicketsNonEmpty =
            hubTicketsRaw && hubTicketsRaw.length
                ? hubTicketsRaw
                : [];

        /** @type {BulkPreviewMeta[]} */
        var previews = hubTicketsNonEmpty.map(function (t) {
            var eligibleSubmit = mockRenewalEligible(t);
            var wfU = String(t.status || '').trim().toUpperCase();
            var hint = 'OK · joins submit lane';
            if (!eligibleSubmit) {
                hint =
                    wfU !== 'EXPIRING_SOON'
                        ? 'Skipped — needs Expiring Soon'
                        : 'Skipped — upstream canBeRenewal false';
            }
            return {
                ticketNumberDisplay: ticketNumberDisplayLine(t),
                eligibleSubmit: eligibleSubmit,
                previewHint: hint,
                ticket: t,
            };
        });

        /** @type {BulkPreviewMeta[]} */
        var eligibleQueue = previews.filter(function (p) {
            return p.eligibleSubmit;
        });
        var skippedPreviewCt = previews.length - eligibleQueue.length;

        openRenewalUxMockOverlay(bulkPreviewMarkup(previews, { eligibleQueue: eligibleQueue }), {
            title: 'Bulk renew preview',
            widePanel: true,
        });
        var root = overlayRoot();
        if (!root) return;
        var proceed = qs('[data-renewal-mock-bulk-proceed]', root);
        if (!proceed) return;

        proceed.addEventListener(
            'click',
            function bulkClickOnce(ev) {
                if (eligibleQueue.length === 0) {
                    ev.preventDefault();
                    return;
                }
                proceed.disabled = true;
                var panel = qs('.ticket-hub-mock-panel', root);
                if (!panel) return;

                /** @returns {Promise<void>} */
                (async function sequentialRun() {
                    var failuresAccum = [];
                    var ok = 0;
                    var fail = 0;
                    var totalT = eligibleQueue.length;
                    for (var ix = 0; ix < eligibleQueue.length; ix++) {
                        var lb = eligibleQueue[ix].ticketNumberDisplay;
                        panel.innerHTML = bulkProgressMarkup(ix, totalT, lb);
                        trapFocus(panel);
                        await delayMs(BULK_TICKET_STEP_MS);
                        var sc = SUBMIT_SCENARIO[ix % SUBMIT_SCENARIO.length];
                        if (!sc.ok) {
                            failuresAccum.push({
                                t: lb,
                                code: sc.code,
                                msg: sc.msg,
                            });
                            fail++;
                        } else ok++;
                    }
                    if (!overlayRoot()) return;
                    if (fail > 0) {
                        var bspMock = global.bulkSubmitProgress;
                        if (bspMock && typeof bspMock.logSubmitFailures === 'function') {
                            bspMock.logSubmitFailures(
                                'ticket-renew-mock',
                                failuresAccum.map(function (f) {
                                    return { code: f.code, msg: f.msg };
                                }),
                                { mock: true }
                            );
                        }
                    }
                    panel.innerHTML = bulkRollup({
                        ok: ok,
                        fail: fail,
                        skip: skippedPreviewCt,
                        failures: failuresAccum,
                    });
                    bindDismissHandlers(overlayRoot());
                    trapFocus(panel);
                })().catch(function (e) {
                    console.warn('[renewalUxMock]', e);
                });
            },
            { once: true }
        );
    }


    function attachStandaloneDemoHandlers(root) {
        if (!root || !root.ownerDocument) return;
        /** @returns {HTMLElement | null} */
        function rq(id) {
            return root.ownerDocument.getElementById(id);
        }
        rq('btnSingleOpenPreview') &&
            rq('btnSingleOpenPreview').addEventListener('click', function () {
                global.renewalUxMockFlow.openSingleRenewalMockFromTicket({
                    ticketNumber: '251204-089',
                    status: 'EXPIRING_SOON',
                    canBeRenewal: true,
                    job_number: 756592,
                    fullAddress: { street: '1234 E Charlton Blvd', city: 'Reno', state: 'NV' },
                    workLegalStartDate: '2026-02-07T07:30:00.000Z',
                });
            });
        rq('btnBulkDemo') &&
            rq('btnBulkDemo').addEventListener('click', function () {
                global.renewalUxMockFlow.openBulkRenewalMockTickets([
                    {
                        ticketNumber: '251205-031',
                        status: 'EXPIRING_SOON',
                        canBeRenewal: true,
                    },
                    {
                        ticketNumber: '251206-072',
                        status: 'EXPIRING_SOON',
                        canBeRenewal: true,
                    },
                    {
                        ticketNumber: '251199-914',
                        status: 'NOT_READY',
                        canBeRenewal: false,
                    },
                    {
                        ticketNumber: '251207-088',
                        status: 'EXPIRING_SOON',
                        canBeRenewal: true,
                    },
                    {
                        ticketNumber: '251208-091',
                        status: 'EXPIRING_SOON',
                        canBeRenewal: true,
                    },
                ]);
            });
        rq('btnJumpSingleSuccess') &&
            rq('btnJumpSingleSuccess').addEventListener('click', function () {
                openRenewalUxMockOverlay(successMarkupSingle({ ticketNumber: mockNewDraftRequestLabel('demo'), job_number: 756592 }), {
                    title: 'Single success pane',
                    widePanel: false,
                });
                bindDismissHandlers(overlayRoot());
            });
        rq('btnJumpBulkRollup') &&
            rq('btnJumpBulkRollup').addEventListener('click', function () {
                openRenewalUxMockOverlay(
                    bulkRollup({
                        ok: 2,
                        fail: 2,
                        skip: 1,
                        failures: [
                            {
                                t: '251206-072',
                                code: 'RENEW_SUBMIT_BUSY',
                                msg: 'Renewal already in progress.',
                            },
                            {
                                t: '251207-088',
                                code: 'UPSTREAM_REJECT',
                                msg: 'Validation failed upstream.',
                            },
                        ],
                    }),
                    {
                        title: 'Bulk rollup only',
                        widePanel: true,
                    }
                );
                bindDismissHandlers(overlayRoot());
            });
    }

    /** @preserve */
    global.renewalUxMockFlow = {
        openSingleRenewalMockFromTicket: openSingleRenewalMockFromTicket,
        openBulkRenewalMockTickets: openBulkRenewalMockTickets,
        attachStandaloneDemoHandlers: attachStandaloneDemoHandlers,
        closeOverlay: closeRenewalUxMockOverlay,
    };

    /** @preserve */
})(typeof window !== 'undefined' ? window : globalThis);
