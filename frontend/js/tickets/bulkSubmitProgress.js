/**
 * Shared live progress UI for bulk ticket create / renewal submits.
 */
(function (global) {
    'use strict';

    const USAN_SUBMIT_PACE_MS = 11000;
    /** Same as live submit pacing so dry runs feel realistic. */
    const DRY_RUN_STEP_MS = USAN_SUBMIT_PACE_MS;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function sleepMs(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    /**
     * @param {number} ok
     * @param {number} fail
     * @returns {string}
     */
    function buildSubmitStatStrip(ok, fail) {
        const parts = [];
        if (ok > 0) parts.push('<li><strong>' + ok + '</strong> succeeded</li>');
        if (fail > 0) parts.push('<li><strong>' + fail + '</strong> failed</li>');
        if (parts.length === 0) {
            parts.push('<li>Nothing submitted.</li>');
        }
        return '<ul class="renewal-mock-stat-strip">' + parts.join('') + '</ul>';
    }

    /**
     * @param {*} e
     * @returns {{ code: string, msg: string, supportId?: string }}
     */
    function normalizeSubmitFailure(e) {
        const auth = global.authModule;
        const msg =
            auth && typeof auth.getFriendlyErrorMessage === 'function'
                ? auth.getFriendlyErrorMessage(e)
                : e && e.message
                  ? String(e.message)
                  : String(e);
        let code = 'SUBMIT_FAILED';
        if (e && e.errorCode != null && String(e.errorCode).trim()) {
            code = String(e.errorCode).trim();
        } else if (e && e.code != null && String(e.code).trim()) {
            code = String(e.code).trim();
        }
        /** @type {{ code: string, msg: string, supportId?: string }} */
        const out = { code: code, msg: msg };
        if (e && e.supportId != null && String(e.supportId).trim()) {
            out.supportId = String(e.supportId).trim();
        }
        return out;
    }

    function stripTechnicalErrorSuffix(msg) {
        return String(msg == null ? '' : msg)
            .replace(/\s*\(Code:[^)]*\)\s*$/i, '')
            .trim();
    }

    /**
     * Plain-English message for new-ticket create failures (non-technical).
     * @param {{ code?: string, msg?: string }} failure
     * @returns {string}
     */
    function plainCreateFailureMessage(failure) {
        const code = failure && failure.code != null ? String(failure.code).trim() : '';
        const raw = failure && failure.msg != null ? String(failure.msg) : '';
        const msg = stripTechnicalErrorSuffix(raw);
        const lower = msg.toLowerCase();

        if (code === 'IDEMPOTENCY_IN_PROGRESS' || lower.indexOf('already in progress') !== -1) {
            return 'A submit is already in progress. Wait a moment and try again.';
        }
        if (lower.indexOf('rate limit') !== -1 || lower.indexOf('max 1 submit per 10 seconds') !== -1) {
            return 'USAN is limiting how fast tickets can be submitted. Wait about 10 seconds and try again.';
        }
        if (
            lower.indexOf('polygon') !== -1 ||
            lower.indexOf('wkt') !== -1 ||
            lower.indexOf('dig area') !== -1 ||
            lower.indexOf('reverse geocode') !== -1 ||
            lower.indexOf('not accepted by usan') !== -1
        ) {
            return 'The dig area on the map was not accepted. Adjust the polygon and try again.';
        }
        if (lower.indexOf('cross street') !== -1 || lower.indexOf('nearestcrossstreet') !== -1) {
            return 'The cross street field has invalid characters. Use letters and numbers only.';
        }
        if (lower.indexOf('commences') !== -1 || lower.indexOf('start date') !== -1 || lower.indexOf('start time') !== -1) {
            return 'The planned work start date or time is not valid.';
        }
        if (lower.indexOf('principal contact') !== -1 || lower.indexOf('contact fields') !== -1) {
            return 'Contact information is incomplete. Check the name and phone number.';
        }
        if (lower.indexOf('payload builder') !== -1 || lower.indexOf('lookups') !== -1) {
            return 'The form could not be prepared for submit. Refresh the page and try again.';
        }
        if (lower.indexOf('submit rejected') !== -1 || lower.indexOf('incomplete response') !== -1) {
            return 'USAN did not accept this ticket. Review your entries and try again.';
        }
        if (lower.indexOf('not authenticated') !== -1 || lower.indexOf('authentication expired') !== -1) {
            return 'Your session expired. Sign in again and retry.';
        }
        if (lower.indexOf('permission') !== -1 || lower.indexOf('do not have access') !== -1) {
            return 'You do not have permission to create tickets in this organization.';
        }
        if (lower.indexOf('normal tickets only') !== -1) {
            return 'Only normal ticket types can be submitted right now.';
        }
        if (lower.indexOf('dry run') !== -1 || code === 'DRY_RUN_FAIL') {
            return 'This was a practice run — one ticket was simulated as failed.';
        }
        if (msg && !/^(http\s*)?\d{3}\b/i.test(msg) && msg.indexOf('SUBMIT_FAILED') === -1) {
            return msg;
        }
        return 'This ticket could not be submitted. Review your entries and try again.';
    }

    /**
     * User-facing message for renew/remark failures (may include server text; strips support metadata).
     * @param {{ code?: string, msg?: string }} failure
     * @returns {string}
     */
    function plainTicketFailureMessage(failure) {
        const code = failure && failure.code != null ? String(failure.code).trim() : '';
        const msg = stripTechnicalErrorSuffix(failure && failure.msg != null ? String(failure.msg) : '');
        const lower = msg.toLowerCase();
        if (code === 'IDEMPOTENCY_IN_PROGRESS' || lower.indexOf('already in progress') !== -1) {
            return 'Submit already in progress — wait a moment or refresh before trying again.';
        }
        if (msg) return msg;
        return 'This ticket could not be submitted. Try again or contact support.';
    }

    /**
     * @param {string} flow
     * @param {Array<{ code?: string, msg: string, supportId?: string, ticketNumber?: string, label?: string }>} failures
     * @param {object} [context]
     */
    function logSubmitFailures(flow, failures, context) {
        if (!failures || !failures.length) return;
        console.error('[ticket-submit] ' + String(flow) + ' failure(s)', {
            flow: flow,
            count: failures.length,
            failures: failures,
            context: context || null,
        });
    }

    /**
     * @param {Array<{ label?: string, msg: string }>} failures
     * @returns {string}
     */
    function buildFailureReasonsMarkup(failures) {
        if (!failures || !failures.length) return '';
        const seen = new Set();
        const unique = [];
        for (let i = 0; i < failures.length; i++) {
            const f = failures[i];
            const key = (f.label || '') + '|' + f.msg;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(f);
        }
        let items = '';
        for (let j = 0; j < unique.length; j++) {
            const f = unique[j];
            const label = f.label != null && String(f.label).trim() !== '' ? String(f.label).trim() : '';
            const prefix = label ? '<strong>' + esc(label) + '</strong>: ' : '';
            items += '<li>' + prefix + esc(f.msg) + '</li>';
        }
        return (
            '<details class="renewal-mock-fail-details" open>' +
            '<summary>Failure details (' +
            unique.length +
            ')</summary>' +
            '<ul class="renewal-mock-fail-list">' +
            items +
            '</ul></details>'
        );
    }

    /**
     * @param {HTMLElement} panel
     * @param {{ title?: string, total?: number, items?: string[], dryRunBanner?: boolean }} opts
     * @returns {object}
     */
    function mountBulkSubmitProgress(panel, opts) {
        const o = opts || {};
        const title = o.title != null ? String(o.title) : 'Submitting…';
        const items = Array.isArray(o.items) ? o.items.map(String) : [];
        const total = Math.max(0, o.total != null ? Number(o.total) : items.length);
        const dryRunBanner = o.dryRunBanner === true;

        panel.innerHTML =
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title" data-bulk-submit-title>' +
            esc(title) +
            '</h3></div>' +
            (dryRunBanner
                ? '<p class="renewal-mock-banner bulk-submit-dry-run-banner" role="status">Dry run — simulated timing, nothing submitted to USAN.</p>'
                : '') +
            '<p class="ticket-hub-mock-hint" data-bulk-submit-count role="status"></p>' +
            '<div class="renewal-mock-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" data-bulk-submit-progressbar>' +
            '<div class="renewal-mock-progress-bar" data-bulk-submit-progress-fill style="width:0%"></div>' +
            '<div class="renewal-mock-progress-bar renewal-mock-progress-bar--active" data-bulk-submit-progress-active hidden style="width:0%"></div>' +
            '</div>';

        /** @type {object} */
        const controller = {
            panel: panel,
            total: total,
            done: 0,
            currentIndex: 0,
            items: items,
            inFlight: false,
            els: {
                count: panel.querySelector('[data-bulk-submit-count]'),
                fill: panel.querySelector('[data-bulk-submit-progress-fill]'),
                active: panel.querySelector('[data-bulk-submit-progress-active]'),
                progressbar: panel.querySelector('[data-bulk-submit-progressbar]'),
            },
        };

        updateCountDisplay(controller);
        return controller;
    }

    function updateCountDisplay(ctrl) {
        if (!ctrl.els.count) return;
        ctrl.els.count.textContent = ctrl.done + ' of ' + ctrl.total + ' completed';
    }

    function progressPct(ctrl) {
        if (ctrl.total <= 0) return 0;
        let base = (ctrl.done / ctrl.total) * 100;
        if (ctrl.inFlight) {
            base += (0.35 / ctrl.total) * 100;
        }
        return Math.min(100, Math.round(base));
    }

    function updateProgressBar(ctrl) {
        const pct = progressPct(ctrl);
        if (ctrl.els.fill) {
            ctrl.els.fill.style.width = (ctrl.done / Math.max(1, ctrl.total)) * 100 + '%';
        }
        if (ctrl.els.active) {
            if (ctrl.inFlight && ctrl.done < ctrl.total) {
                ctrl.els.active.hidden = false;
                const slotPct = 100 / Math.max(1, ctrl.total);
                ctrl.els.active.style.width = slotPct + '%';
                ctrl.els.active.style.left = (ctrl.done / Math.max(1, ctrl.total)) * 100 + '%';
                ctrl.els.active.style.marginLeft = '0';
            } else {
                ctrl.els.active.hidden = true;
            }
        }
        if (ctrl.els.progressbar) {
            ctrl.els.progressbar.setAttribute('aria-valuenow', String(pct));
        }
    }

    /**
     * @param {object} ctrl
     * @param {'preparing'|'submitting'} phase
     */
    function setPhase(ctrl, phase) {
        void ctrl;
        void phase;
    }

    /** @param {object} ctrl */
    function startInFlight(ctrl) {
        if (!ctrl) return;
        ctrl.inFlight = true;
        updateProgressBar(ctrl);
        updateCountDisplay(ctrl);
    }

    /** @param {object} ctrl */
    function stopInFlight(ctrl) {
        if (!ctrl) return;
        ctrl.inFlight = false;
        updateProgressBar(ctrl);
        updateCountDisplay(ctrl);
    }

    /**
     * @param {object} ctrl
     * @param {number} index
     * @param {boolean} ok
     */
    function markComplete(ctrl, index, ok) {
        if (!ctrl) return;
        void ok;
        ctrl.done = Math.min(ctrl.total, index + 1);
        ctrl.currentIndex = Math.min(ctrl.total, index + 1);
        updateProgressBar(ctrl);
        updateCountDisplay(ctrl);
    }

    /** @param {object} ctrl */
    function destroyBulkSubmitProgress(ctrl) {
        if (!ctrl) return;
        ctrl.inFlight = false;
    }

    /**
     * @param {HTMLElement} panel
     * @param {{ title?: string, items?: string[], stepMs?: number, simulateFailureIndex?: number, onComplete?: (stats: { ok: number, fail: number, failures: { t: string, code: string, msg: string }[] }) => void }} opts
     */
    async function runBulkSubmitProgressDryRun(panel, opts) {
        const o = opts || {};
        const items = Array.isArray(o.items) ? o.items.map(String) : [];
        const total = items.length;
        if (total === 0) return;

        const stepMs = o.stepMs != null ? Number(o.stepMs) : DRY_RUN_STEP_MS;
        const failIx =
            o.simulateFailureIndex != null
                ? Number(o.simulateFailureIndex)
                : total > 1
                  ? 1
                  : -1;

        const ctrl = mountBulkSubmitProgress(panel, {
            title: o.title || 'Submitting…',
            total: total,
            items: items,
            dryRunBanner: true,
        });

        const failures = [];
        let ok = 0;
        let fail = 0;

        for (let ix = 0; ix < total; ix++) {
            ctrl.currentIndex = ix;
            setPhase(ctrl, 'preparing');
            await sleepMs(Math.round(stepMs * 0.15));
            setPhase(ctrl, 'submitting');
            startInFlight(ctrl);
            await sleepMs(Math.round(stepMs * 0.85));
            stopInFlight(ctrl);

            const shouldFail = ix === failIx;
            if (shouldFail) {
                fail++;
                failures.push({
                    t: items[ix],
                    code: 'DRY_RUN_FAIL',
                    msg: 'Simulated failure (dry run only).',
                });
                markComplete(ctrl, ix, false);
            } else {
                ok++;
                markComplete(ctrl, ix, true);
            }
        }

        destroyBulkSubmitProgress(ctrl);

        const stats = { ok: ok, fail: fail, skip: 0, failures: failures };
        if (typeof o.onComplete === 'function') {
            o.onComplete(stats);
        }
        return stats;
    }

    global.bulkSubmitProgress = {
        USAN_SUBMIT_PACE_MS: USAN_SUBMIT_PACE_MS,
        buildStatStrip: buildSubmitStatStrip,
        buildFailureReasonsMarkup: buildFailureReasonsMarkup,
        plainCreateFailureMessage: plainCreateFailureMessage,
        plainTicketFailureMessage: plainTicketFailureMessage,
        normalizeFailure: normalizeSubmitFailure,
        logSubmitFailures: logSubmitFailures,
        mount: mountBulkSubmitProgress,
        setPhase: setPhase,
        startInFlight: startInFlight,
        stopInFlight: stopInFlight,
        markComplete: markComplete,
        destroy: destroyBulkSubmitProgress,
        runDryRun: runBulkSubmitProgressDryRun,
    };
})(typeof window !== 'undefined' ? window : globalThis);
