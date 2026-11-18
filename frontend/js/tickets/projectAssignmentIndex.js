/**
 * Project-based ticket assignment index (open projects only).
 * Used by hub/map "Assigned to me" stats and assignee filters.
 */
(function () {
    'use strict';

    /** @type {Map<number, Array<{ userId: number, userName: string|null }>>} */
    let assigneesByTicketId = new Map();
    let assignmentIndexOrgId = null;
    let assignmentIndexLoaded = false;
    /** @type {Promise<Map<number, Array<{ userId: number, userName: string|null }>>>|null} */
    let assignmentIndexPromise = null;

    function assignmentIndexApiBase() {
        let orgId = null;
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            orgId = window.orgSelectorModule.getCurrentOrgId();
        } else if (window.authModule && window.authModule.getCurrentUser) {
            const u = window.authModule.getCurrentUser();
            orgId = u && u.organizationId;
        }
        const base = window.authModule && window.authModule.API_BASE ? window.authModule.API_BASE : '';
        const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
        return { base, q, orgId };
    }

    function clearProjectAssignmentIndex() {
        assigneesByTicketId = new Map();
        assignmentIndexOrgId = null;
        assignmentIndexLoaded = false;
        assignmentIndexPromise = null;
    }

    /**
     * Build assigneesByTicketId from assignment-index API payload.
     * @param {{ projects?: Array<{ ticketIds?: number[], assignees?: Array<{ userId: number, userName?: string|null }> }> }} data
     * @returns {Map<number, Array<{ userId: number, userName: string|null }>>}
     */
    function buildAssigneesByTicketIdFromPayload(data) {
        /** @type {Map<number, Map<number, { userId: number, userName: string|null }>>} */
        const byTicket = new Map();
        const projects = Array.isArray(data && data.projects) ? data.projects : [];
        for (const p of projects) {
            const ticketIds = Array.isArray(p && p.ticketIds) ? p.ticketIds : [];
            const assignees = Array.isArray(p && p.assignees) ? p.assignees : [];
            if (ticketIds.length === 0 || assignees.length === 0) continue;
            for (const rawTid of ticketIds) {
                const tid = Number(rawTid);
                if (!Number.isFinite(tid)) continue;
                if (!byTicket.has(tid)) byTicket.set(tid, new Map());
                const userMap = byTicket.get(tid);
                for (const a of assignees) {
                    const userId = a && a.userId != null ? parseInt(a.userId, 10) : NaN;
                    if (Number.isNaN(userId)) continue;
                    if (!userMap.has(userId)) {
                        userMap.set(userId, {
                            userId,
                            userName: a.userName != null ? String(a.userName) : null,
                        });
                    }
                }
            }
        }
        const out = new Map();
        for (const [tid, userMap] of byTicket) {
            out.set(tid, Array.from(userMap.values()));
        }
        return out;
    }

    /**
     * Load open-project assignment index for the current org.
     * @param {{ force?: boolean }} [opts]
     * @returns {Promise<Map<number, Array<{ userId: number, userName: string|null }>>>}
     */
    async function refreshProjectAssignmentIndex(opts) {
        const force = !!(opts && opts.force);
        const api = assignmentIndexApiBase();
        if (!api.orgId || !window.authModule || !window.authModule.apiRequest) {
            clearProjectAssignmentIndex();
            return assigneesByTicketId;
        }
        if (
            !force &&
            assignmentIndexPromise &&
            assignmentIndexOrgId != null &&
            String(assignmentIndexOrgId) === String(api.orgId)
        ) {
            return assignmentIndexPromise;
        }
        if (
            !force &&
            assignmentIndexLoaded &&
            assignmentIndexOrgId != null &&
            String(assignmentIndexOrgId) === String(api.orgId)
        ) {
            return assigneesByTicketId;
        }
        assignmentIndexOrgId = api.orgId;
        assignmentIndexPromise = (async () => {
            try {
                const data = await window.authModule.apiRequest(
                    `${api.base}/tickets/job-projects/assignment-index${api.q}`
                );
                assigneesByTicketId = buildAssigneesByTicketIdFromPayload(data);
            } catch (e) {
                console.warn('[tickets] project assignment index refresh failed', e);
                assigneesByTicketId = new Map();
            }
            assignmentIndexLoaded = true;
            return assigneesByTicketId;
        })();
        try {
            return await assignmentIndexPromise;
        } finally {
            assignmentIndexPromise = null;
        }
    }

    /**
     * Effective open-project assignees for a ticket (from cached index).
     * @param {object} ticket
     * @returns {Array<{ userId: number, userName: string|null }>}
     */
    function getProjectAssigneesForTicket(ticket) {
        if (!ticket || ticket.id == null) return [];
        const tid = Number(ticket.id);
        if (!Number.isFinite(tid)) return [];
        const list = assigneesByTicketId.get(tid);
        return Array.isArray(list) ? list.slice() : [];
    }

    function ticketHasAnyProjectAssignee(ticket) {
        return getProjectAssigneesForTicket(ticket).length > 0;
    }

    function ticketIsAssignedToUserViaProject(ticket, userId) {
        if (userId == null) return false;
        const uid = parseInt(userId, 10);
        if (Number.isNaN(uid)) return false;
        return getProjectAssigneesForTicket(ticket).some((a) => a.userId === uid);
    }

    window.clearProjectAssignmentIndex = clearProjectAssignmentIndex;
    window.refreshProjectAssignmentIndex = refreshProjectAssignmentIndex;
    window.getProjectAssigneesForTicket = getProjectAssigneesForTicket;
    window.ticketHasAnyProjectAssignee = ticketHasAnyProjectAssignee;
    window.ticketIsAssignedToUserViaProject = ticketIsAssignedToUserViaProject;
})();
