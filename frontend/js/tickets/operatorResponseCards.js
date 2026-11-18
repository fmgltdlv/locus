/**
 * Shared operator-response card HTML (map popup + Ticket Hub detail).
 * Same card at all breakpoints: name, short code desc, status glyph; click opens status modal.
 */
(function (global) {
    'use strict';

    function escapeCardHtml(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function emDash() {
        return (global.TICKET_HUB_TEXT && global.TICKET_HUB_TEXT.EM_DASH) || '—';
    }

    /** Full code description: catalog, then codeDescription, then comment. */
    function getOperatorResponseCodeDescriptionDisplay(response) {
        if (!response) return emDash();
        const fromCatalog =
            typeof global.lookupOperatorResponseCodeCatalogDescription === 'function'
                ? global.lookupOperatorResponseCodeCatalogDescription(response.statusCode)
                : null;
        if (fromCatalog) return fromCatalog;
        const cd =
            response.codeDescription != null && String(response.codeDescription).trim() !== ''
                ? String(response.codeDescription).trim()
                : null;
        const cm =
            response.comment != null && String(response.comment).trim() !== ''
                ? String(response.comment).trim()
                : null;
        if (cd) return cd;
        if (cm) return cm;
        return emDash();
    }

    /** Shorthand for cards: catalog short, else codeDescription before " - ". */
    function getOperatorResponseCodeShortDisplay(response) {
        if (!response) return null;
        const statusCode = response.statusCode;
        if (statusCode == null || String(statusCode).trim() === '') return null;
        const fromCatalog =
            typeof global.lookupOperatorResponseCodeCatalogShort === 'function'
                ? global.lookupOperatorResponseCodeCatalogShort(statusCode)
                : null;
        if (fromCatalog) return fromCatalog;
        const cd =
            response.codeDescription != null && String(response.codeDescription).trim() !== ''
                ? String(response.codeDescription).trim()
                : null;
        if (!cd) return null;
        const dash = cd.indexOf(' - ');
        if (dash > 0) return cd.slice(0, dash).trim() || null;
        return cd;
    }

    function shouldPaintResponsesGreenAfterAck(ticket) {
        if (!ticket || !ticket.hasWorkflowAck) return false;
        const mod = global.workflowAckComplianceModule;
        const policy =
            mod && typeof mod.getCurrentOrgWorkflowAckPolicy === 'function'
                ? mod.getCurrentOrgWorkflowAckPolicy()
                : null;
        return !!(policy && policy.greenResponsesAfterAck);
    }

    function buildStatusIndicatorHtml(response, index, context, paintGreen) {
        const mod = global.workflowAckModule;
        if (!mod || typeof mod.buildOperatorResponseStatusIndicatorHtml !== 'function') return '';
        const operatorStatus = response.effectiveStatus || response.operatorStatus || 'READY';
        const stationLabel = response.operatorName || response.stationCode || response.operatorCode || '';
        return mod.buildOperatorResponseStatusIndicatorHtml({
            operatorStatus,
            indicatorKind: paintGreen ? 'ready' : undefined,
            stationLabel,
            respIndex: index,
            context: context === 'hub' ? 'hub' : 'popup',
        });
    }

    /**
     * @param {object} ticket
     * @param {object} response
     * @param {number} index
     * @param {{ context?: 'popup'|'hub' }} [opts]
     * @returns {string}
     */
    function buildOperatorResponseCardHtml(ticket, response, index, opts) {
        opts = opts || {};
        const context = opts.context === 'hub' ? 'hub' : 'popup';
        const isOutstanding =
            ticket &&
            ticket.outstandingOperators &&
            (ticket.outstandingOperators.includes(response.operatorName) ||
                ticket.outstandingOperators.includes(response.stationCode));
        const operatorStatus = response.effectiveStatus || response.operatorStatus || 'READY';
        const paintGreen = shouldPaintResponsesGreenAfterAck(ticket);
        let statusClass = 'ready';
        if (paintGreen) statusClass = 'acked-green';
        else if (operatorStatus === 'NOT_READY') statusClass = 'not-ready';
        else if (operatorStatus === 'ACTION_REQUIRED') statusClass = 'action-required';

        const nameStr = response.operatorName != null ? String(response.operatorName).trim() : '';
        const codeStr = response.stationCode || response.operatorCode || '';
        const cardTitleHtml =
            nameStr !== ''
                ? escapeCardHtml(nameStr)
                : codeStr
                  ? escapeCardHtml(codeStr)
                  : escapeCardHtml(emDash());
        const shortDisplay = getOperatorResponseCodeShortDisplay(response);
        const shortDescHtml =
            shortDisplay != null
                ? `<div class="ticket-response-card-code-desc">${escapeCardHtml(shortDisplay)}</div>`
                : '';
        const statusIndicatorHtml = buildStatusIndicatorHtml(response, index, context, paintGreen);
        const statusLabel =
            typeof global.formatWorkflowStatusDisplay === 'function'
                ? global.formatWorkflowStatusDisplay(operatorStatus)
                : String(operatorStatus).replace(/_/g, ' ');
        const ariaStation = nameStr || codeStr || 'operator';
        const rowAria = escapeCardHtml(
            shortDisplay
                ? `Status: ${statusLabel} — ${ariaStation}. ${shortDisplay}. Tap for details`
                : `Status: ${statusLabel} — ${ariaStation}. Tap for details`
        );

        const clickClass =
            context === 'hub'
                ? ''
                : ' ticket-popup-op-status-row';
        const hubAttr =
            context === 'hub' ? ' data-hub-action="op-status-detail"' : '';

        return `
                <div class="ticket-response-card ticket-response-card--clickable ticket-response-card--status-${statusClass} ${isOutstanding ? 'outstanding' : ''}${clickClass}" data-resp-index="${index}" data-status="${escapeCardHtml(operatorStatus)}"${hubAttr} role="button" tabindex="0" aria-label="${rowAria}">
                    <div class="ticket-response-card-header">
                        <div class="ticket-response-card-name-block">
                            <span class="ticket-response-card-name">${cardTitleHtml}</span>
                            ${shortDescHtml}
                        </div>
                        ${statusIndicatorHtml}
                    </div>
                </div>`;
    }

    /**
     * @param {object} ticket
     * @param {object[]} operatorResponses
     * @param {{ context?: 'popup'|'hub' }} [opts]
     * @returns {string}
     */
    function buildOperatorResponseCardsListHtml(ticket, operatorResponses, opts) {
        const cards = (operatorResponses || [])
            .map((response, index) => buildOperatorResponseCardHtml(ticket, response, index, opts))
            .join('');
        return `<div class="ticket-responses-cards">${cards}</div>`;
    }

    global.getOperatorResponseCodeDescriptionDisplay = getOperatorResponseCodeDescriptionDisplay;
    global.getOperatorResponseCodeShortDisplay = getOperatorResponseCodeShortDisplay;
    global.buildOperatorResponseCardHtml = buildOperatorResponseCardHtml;
    global.buildOperatorResponseCardsListHtml = buildOperatorResponseCardsListHtml;
})(typeof window !== 'undefined' ? window : globalThis);
