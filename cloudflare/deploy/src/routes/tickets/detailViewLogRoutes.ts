// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canMutateOrganization, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { TICKET_VIEW_LOG_MAX, pruneTicketViewEvents, resolveTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
export function registerDetailViewLogRoutes(tickets: TicketsApp) {
  tickets.get('/:ticketNumber/view-log', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      let orgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      if (!rawTn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, rawTn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }
      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          await pruneTicketViewEvents(db, row.id);
          const rows = await allRows(
              db,
              `SELECT id, user_id, user_display_name, opened_at
               FROM ticket_view_events
               WHERE ticket_id = ?
               ORDER BY datetime(opened_at) DESC, id DESC
               LIMIT ?`,
              [row.id, TICKET_VIEW_LOG_MAX]
          );
          const events = (rows || []).map((r) => ({
              id: r.id,
              userId: r.user_id,
              userName: r.user_display_name || null,
              openedAt: r.opened_at,
          }));
          res.json({ events });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/view-log:', e);
          res.status(500).json({ error: 'Failed to load view log' });
      }
  });

  tickets.post('/:ticketNumber/view-log', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const rawTn = (req.params.ticketNumber || '').trim();
      let orgId =
          req.query.organizationId != null
              ? parseInt(req.query.organizationId, 10)
              : req.body && req.body.organizationId != null
                ? parseInt(req.body.organizationId, 10)
                : req.user.organizationId;
      if (!rawTn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, rawTn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }
      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          const userRow = await getRow(db, 'SELECT full_name, username, email FROM users WHERE id = ?', [userId]);
          const displayName =
              (userRow && userRow.full_name && String(userRow.full_name).trim()) ||
              (userRow && userRow.username) ||
              (userRow && userRow.email) ||
              '';
          await runDb(
              db,
              `INSERT INTO ticket_view_events (organization_id, ticket_id, user_id, user_display_name, opened_at)
               VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
              [orgId, row.id, userId, displayName]
          );
          await pruneTicketViewEvents(db, row.id);
          res.json({ success: true });
      } catch (e) {
          console.error('POST /tickets/:ticketNumber/view-log:', e);
          res.status(500).json({ error: 'Failed to record view' });
      }
  });

}
