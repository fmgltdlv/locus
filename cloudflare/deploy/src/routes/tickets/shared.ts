import { ORG_REQUIRED_MESSAGE, canMutateOrganization } from '../../auth.js';
import { getEnv } from '../../envContext.js';
import { resolveEnableTicketRenewal } from '../../lib/cooperativeLockMs.js';
import { resolveEnableTicketActions } from '../appSettingsAdmin.js';
import { getMembershipRole, isTicketWriteMembership } from '../../lib/orgMembership.cjs';
import { truthyRenewalFlag } from '../../lib/ngenRenewal.cjs';
import { truthyRemarkFlag } from '../../lib/ngenRemark.cjs';
import { assertNotTechWrite } from '../ticketRowHelpers.js';

export const RENEW_TICKET_BATCH_MAX = 25;

/** Classify renew batch action from live nGen enquiry flags (not workflow status). */
export function classifyRenewActionFromEnquiry(details, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const autoCloneExhausted = opts.autoCloneExhausted !== false;
    if (!details) {
        return { action: 'skip', skipReason: 'no_enquiry_details' };
    }
    if (truthyRenewalFlag(details.canBeRenewal)) {
        return { action: 'renew', skipReason: null };
    }
    if (autoCloneExhausted && !truthyRenewalFlag(details.canBeRenewal) && !truthyRemarkFlag(details.canBeRemark)) {
        return { action: 'clone_new', skipReason: null };
    }
    return { action: 'skip', skipReason: 'can_remark_instead' };
}

/** User-visible label for renewal plan / preview skip codes (snake_case → plain language). */
const RENEW_SKIP_REASON_LABELS = {
    ticket_not_found: 'Ticket not found',
    shared_ticket: 'Shared ticket',
    not_expiring_soon: 'Not expiring soon',
    no_job_number: 'No job number',
    no_enquiry_details: 'No details received from USAN',
    can_remark_instead: 'Remark available instead of renewal',
    auto_clone_disabled: 'New copy not included in this batch',
    skipped: 'Skipped',
};

export function formatRenewSkipReason(reason) {
    if (reason == null || reason === '') return '';
    const key = String(reason).trim();
    if (RENEW_SKIP_REASON_LABELS[key]) return RENEW_SKIP_REASON_LABELS[key];
    if (/^[a-z][a-z0-9_]*$/.test(key)) {
        return key
            .split('_')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }
    return key;
}

export async function assertTicketRenewalOrgAdmin(req, db, orgId, res) {
    const ticketActionsOn = await resolveEnableTicketActions(db, resolveEnableTicketRenewal(getEnv()));
    if (!ticketActionsOn) {
        res.status(403).json({ error: 'Ticket actions are turned off.' });
        return false;
    }
    if (!orgId) {
        res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        return false;
    }
    if (!canMutateOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'You do not have access to that organization' });
        return false;
    }
    if (!(await assertNotTechWrite(req, res, orgId))) return false;
    const membershipRole = req.user.role === 'dev' ? null : await getMembershipRole(db, req.user.id, orgId);
    const isAuthorized =
        req.user.role === 'dev' ||
        isTicketWriteMembership(membershipRole) ||
        (req.user.adminOrganizationIds && req.user.adminOrganizationIds.includes(orgId));
    if (!isAuthorized) {
        res.status(403).json({ error: 'Only organization admins and managers can perform this action.' });
        return false;
    }
    return true;
}

export function parseRenewTicketNumberList(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return { error: 'ticketNumbers array is required', uniq: [] };
    const uniq = [];
    const seen = new Set();
    for (const x of rawList) {
        const s = x != null ? String(x).trim() : '';
        if (!s || seen.has(s)) continue;
        seen.add(s);
        uniq.push(s);
        if (uniq.length > RENEW_TICKET_BATCH_MAX) {
            return { error: `At most ${RENEW_TICKET_BATCH_MAX} tickets per request`, uniq: [] };
        }
    }
    if (uniq.length === 0) return { error: 'ticketNumbers array is required', uniq: [] };
    return { error: null, uniq };
}
