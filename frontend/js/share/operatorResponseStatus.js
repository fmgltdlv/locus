/**
 * Slim operator-response readiness helpers for the public share page.
 * Keep code lists in sync with frontend/js/tickets/ticket-status.js and
 * cloudflare/deploy/src/lib/ticketBuilder.cjs (getOperatorStatus).
 */
(function (global) {
    'use strict';

    // Note: 041 and 042 appear in both lists; NOT_READY takes precedence.
    const NOT_READY_CODES = ['000', '888', '999', '014', '050', '020', '021', '024', '052', '054', '041', '042', '080', '555'];
    const ACTION_REQUIRED_CODES = ['002', '011', '012', '031', '034', '041', '042'];

    function getOperatorStatus(responseCode) {
        if (!responseCode) return 'READY';
        const code = String(responseCode).trim();
        if (NOT_READY_CODES.includes(code)) return 'NOT_READY';
        if (ACTION_REQUIRED_CODES.includes(code)) return 'ACTION_REQUIRED';
        return 'READY';
    }

    function formatWorkflowStatusDisplay(status) {
        if (status === 'ACTION_REQUIRED') return 'REVIEW REQUIRED';
        if (status == null || status === '') return '';
        return String(status).replace(/_/g, ' ');
    }

    /**
     * Prefer statusCode → getOperatorStatus. Only trust operatorStatus when it is
     * already READY|NOT_READY|ACTION_REQUIRED (D1 fallback rows).
     */
    function classifyShareOperatorResponse(row) {
        if (!row || typeof row !== 'object') return 'READY';
        const code = row.statusCode;
        if (code != null && String(code).trim() !== '') {
            return getOperatorStatus(code);
        }
        const os = row.operatorStatus;
        if (os === 'NOT_READY' || os === 'ACTION_REQUIRED' || os === 'READY') {
            return os;
        }
        return 'READY';
    }

    /** Worst of classified rows for Responses tab dot. NOT_READY wins; else ACTION_REQUIRED; else null. */
    function worstResponsesTabStatus(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        let worst = null;
        for (let i = 0; i < rows.length; i += 1) {
            const status = classifyShareOperatorResponse(rows[i]);
            if (status === 'NOT_READY') return 'NOT_READY';
            if (status === 'ACTION_REQUIRED') worst = 'ACTION_REQUIRED';
        }
        return worst;
    }

    function workflowStatusToDotClass(status) {
        if (status === 'NOT_READY') return 'not-ready';
        if (status === 'ACTION_REQUIRED') return 'action-required';
        return null;
    }

    function responseRowModifierClass(status) {
        if (status === 'NOT_READY') return 'project-share-response-row--not-ready';
        if (status === 'ACTION_REQUIRED') return 'project-share-response-row--action-required';
        return 'project-share-response-row--ready';
    }

    function badgeModifierClass(status) {
        if (status === 'NOT_READY') return 'project-share-status-badge--not-ready';
        if (status === 'ACTION_REQUIRED') return 'project-share-status-badge--action-required';
        return 'project-share-status-badge--ready';
    }

    global.shareOperatorResponseStatus = {
        NOT_READY_CODES,
        ACTION_REQUIRED_CODES,
        getOperatorStatus,
        formatWorkflowStatusDisplay,
        classifyShareOperatorResponse,
        worstResponsesTabStatus,
        workflowStatusToDotClass,
        responseRowModifierClass,
        badgeModifierClass,
    };
})(typeof window !== 'undefined' ? window : globalThis);
