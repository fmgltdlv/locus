import { getDatabase } from '../../database.js';
import { canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { computeWorkflowStatusForTicket, type WorkflowAckMap } from '../computeWorkflowStatus.js';
import { loadWorkflowAckContextForOrg } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
import * as ticketAnalytics from '../../lib/ticketAnalyticsQueries.cjs';

type AuthUserLike = {
    id: number;
    role?: string;
    organizationId?: number;
    username?: string;
    email?: string;
    adminOrganizationIds?: number[];
    organizationIds?: number[];
};

async function assertCanViewTicketAnalytics(
    db: ReturnType<typeof getDatabase>,
    user: AuthUserLike,
    orgId: number
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!(await canViewOrganization(user as Parameters<typeof canViewOrganization>[0], orgId))) {
        return { ok: false, status: 403, error: 'You do not have access to that organization' };
    }
    if (user.role === 'dev') return { ok: true };
    const role = await getMembershipRole(db, user.id, orgId);
    if (isTechMembership(role)) {
        return { ok: false, status: 403, error: 'Analytics are not available for tech users' };
    }
    if (role === 'admin') return { ok: true };
    return { ok: false, status: 403, error: 'Analytics are available to organization admins and developers' };
}

function parseOrgId(raw: unknown, fallback: unknown): number | null {
    const parsed = raw != null ? parseInt(String(raw), 10) : fallback != null ? parseInt(String(fallback), 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

async function loadSummaryContext(
    db: ReturnType<typeof getDatabase>,
    orgId: number,
    range: { from: string; to: string; dateField: 'lodged_on' | 'expires_at' }
) {
    const ctx = await loadWorkflowAckContextForOrg(db, orgId);
    const analyticsOpts = { renewalAckWaivers: ctx.renewalAckWaivers, expiringSoonDays: ctx.expiringSoonDays };
    const summary = await ticketAnalytics.buildAnalyticsSummary(
        db,
        orgId,
        range,
        ctx.ackMap as Record<string, unknown>,
        (ticket, map) =>
            computeWorkflowStatusForTicket(ticket, map as WorkflowAckMap, 'owner', analyticsOpts),
        analyticsOpts
    );
    return { summary, analyticsOpts };
}

function parseRangeFromQuery(query: Record<string, unknown>) {
    return ticketAnalytics.parseAnalyticsDateRange(
        query.from as string | undefined,
        query.to as string | undefined,
        query.dateField as string | undefined
    );
}

export function registerTicketsAnalyticsRoutes(tickets: TicketsApp) {
    tickets.get('/analytics/summary', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgId(req.query.organizationId, req.user.organizationId);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        const auth = await assertCanViewTicketAnalytics(db, req.user as AuthUserLike, orgId);
        if (auth.ok === false) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const rangeParsed = parseRangeFromQuery(req.query);
        if (rangeParsed.ok === false) {
            return res.status(400).json({ error: rangeParsed.error });
        }
        try {
            const { summary } = await loadSummaryContext(db, orgId, rangeParsed);
            res.json({
                ticketCount: summary.ticketCount,
                activeCount: summary.activeCount,
                range: summary.range,
                statusBreakdown: summary.statusBreakdown,
                ackBlockers: summary.ackBlockers,
                pendingUtility: summary.pendingUtility,
                lateResponses: summary.lateResponses,
                responseProgress: summary.responseProgress,
            });
        } catch (e) {
            console.error('GET /tickets/analytics/summary:', e);
            res.status(500).json({ error: 'Failed to load analytics summary' });
        }
    });

    tickets.get('/analytics/blockers', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgId(req.query.organizationId, req.user.organizationId);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        const auth = await assertCanViewTicketAnalytics(db, req.user as AuthUserLike, orgId);
        if (auth.ok === false) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const rangeParsed = parseRangeFromQuery(req.query);
        if (rangeParsed.ok === false) {
            return res.status(400).json({ error: rangeParsed.error });
        }
        try {
            const { summary, analyticsOpts } = await loadSummaryContext(db, orgId, rangeParsed);
            const list = await ticketAnalytics.listAnalyticsTicketsByKind(
                db,
                orgId,
                rangeParsed,
                'blockers',
                200,
                analyticsOpts
            );
            res.json({
                range: rangeParsed,
                ticketCount: summary.ackBlockers.ticketCount,
                byCode: ticketAnalytics.rollupOperatorCodes(summary.ackBlockers.byCode),
                tickets: list.tickets,
            });
        } catch (e) {
            console.error('GET /tickets/analytics/blockers:', e);
            res.status(500).json({ error: 'Failed to load blocker analytics' });
        }
    });

    tickets.get('/analytics/pending-utility', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgId(req.query.organizationId, req.user.organizationId);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        const auth = await assertCanViewTicketAnalytics(db, req.user as AuthUserLike, orgId);
        if (auth.ok === false) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const rangeParsed = parseRangeFromQuery(req.query);
        if (rangeParsed.ok === false) {
            return res.status(400).json({ error: rangeParsed.error });
        }
        try {
            const { summary, analyticsOpts } = await loadSummaryContext(db, orgId, rangeParsed);
            const list = await ticketAnalytics.listAnalyticsTicketsByKind(
                db,
                orgId,
                rangeParsed,
                'pending-utility',
                200,
                analyticsOpts
            );
            res.json({
                range: rangeParsed,
                ticketCount: summary.pendingUtility.ticketCount,
                byCode: ticketAnalytics.rollupOperatorCodes(summary.pendingUtility.byCode),
                byCountRule: summary.pendingUtility.byCountRule,
                tickets: list.tickets,
            });
        } catch (e) {
            console.error('GET /tickets/analytics/pending-utility:', e);
            res.status(500).json({ error: 'Failed to load pending utility analytics' });
        }
    });

    tickets.get('/analytics/late-responses', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgId(req.query.organizationId, req.user.organizationId);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        const auth = await assertCanViewTicketAnalytics(db, req.user as AuthUserLike, orgId);
        if (auth.ok === false) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const rangeParsed = parseRangeFromQuery(req.query);
        if (rangeParsed.ok === false) {
            return res.status(400).json({ error: rangeParsed.error });
        }
        try {
            const { summary } = await loadSummaryContext(db, orgId, rangeParsed);
            const list = await ticketAnalytics.listAnalyticsTicketsByKind(db, orgId, rangeParsed, 'late', 200);
            res.json({
                range: rangeParsed,
                ticketCount: summary.lateResponses.ticketCount,
                byCode999: summary.lateResponses.byCode999,
                tickets: list.tickets,
            });
        } catch (e) {
            console.error('GET /tickets/analytics/late-responses:', e);
            res.status(500).json({ error: 'Failed to load late response analytics' });
        }
    });

    tickets.get('/analytics/export.csv', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgId(req.query.organizationId, req.user.organizationId);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        const auth = await assertCanViewTicketAnalytics(db, req.user as AuthUserLike, orgId);
        if (auth.ok === false) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const rangeParsed = parseRangeFromQuery(req.query);
        if (rangeParsed.ok === false) {
            return res.status(400).json({ error: rangeParsed.error });
        }
        try {
            const { summary } = await loadSummaryContext(db, orgId, rangeParsed);
            const csv = ticketAnalytics.summaryToCsv(summary);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="ticket-analytics-${orgId}-${rangeParsed.from}-${rangeParsed.to}.csv"`
            );
            res.status(200);
            res.sendBuffer(new TextEncoder().encode(csv));
        } catch (e) {
            console.error('GET /tickets/analytics/export.csv:', e);
            res.status(500).json({ error: 'Failed to export analytics' });
        }
    });
}
