// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canMutateOrganization, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { assertOwnerOrgTicketWriteAllowed, parseViewerOrganizationId } from '../../lib/partnerTicketAccess.js';
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { POSR_API_BASE } from '../ticketProxyRoutes.js';
import { assertNotTechWrite, attachComputedWorkflowStatusForOrgTicket, buildTicketResponseForClient, findFullTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import type { TicketsApp } from './types.js';
export function registerDetailCorePatchRoutes(tickets: TicketsApp) {
  tickets.patch('/:ticketNumber', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTicketNumber = (req.params.ticketNumber || '').trim();
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!rawTicketNumber) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
      if (writeAccess.allowed === false) {
          return res.status(writeAccess.status).json({ error: writeAccess.error });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;
      const { assignedToUserId, assignedToUserName, assignedToUsers } = req.body || {};
      const isChangingAssignment =
          assignedToUserId !== undefined || assignedToUserName !== undefined || assignedToUsers !== undefined;
      if (isChangingAssignment) {
          return res.status(410).json({
              error: 'Ticket-level assignees are removed. Assign crew on the project instead (PUT /tickets/job-projects/:jobNameKey/assignees).',
              code: 'TICKET_ASSIGNEES_REMOVED',
          });
      }
      return res.status(400).json({ error: 'No updatable fields provided' });
  });

  // ----- Ticket overrides (operator / photo) — stored per organization, shared by all org members -----

}

export function registerDetailCoreTerminalRoutes(tickets: TicketsApp) {
  tickets.get('/db-detail', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = req.query.ticketNumber != null ? String(req.query.ticketNumber).trim() : '';
      const orgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
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
          const row = await findFullTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          const includeRaw = req.query.include != null ? String(req.query.include).trim().toLowerCase() : '';
          const includeTokens = includeRaw
              .split(/[,+\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
          const includeHistory = includeTokens.includes('history');
          const includeProviderHistory =
              includeTokens.includes('providerhistory') || includeTokens.includes('provider_history');
          const ticket = await buildTicketResponseForClient(db, orgId, row, {
              includeHistory,
              includeProviderHistory: includeProviderHistory || includeHistory,
              includeWorkflowAckCompliance: true,
              userId: req.user.id,
          });
          await attachComputedWorkflowStatusForOrgTicket(db, orgId, ticket);
          res.json({ ticket });
      } catch (e) {
          console.error('GET /tickets/db-detail:', e);
          res.status(500).json({ error: e.message || 'Failed to load ticket detail' });
      }
  });

  /**
   * POSR JSON proxy (same as backend/server.js GET /api/tickets/:ticketNumber).
   * Registered after /search and other literal segments so "search" is not captured.
   */
  tickets.get("/:ticketNumber", async (c) => {
      const req = buildExpressReq(c);
      const res = c.get("expressRes") as ResShim;
      const ticketNumber = req.params.ticketNumber;
      try {
          const url = `${POSR_API_BASE}${ticketNumber}`;
          const response = await fetch(url, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          });
          if (!response.ok) {
              return res.status(502).json({ error: `Failed to fetch POSR details: ${response.status}` });
          }
          const data = (await response.json()) as unknown;
          return res.json(data);
      } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return res.status(500).json({ error: msg });
      }
  });

  // Delete ticket (Dev only)
  tickets.delete('/:ticketNumber', (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const user = req.user;
      const rawTicketNumber = decodeURIComponent(String(req.params.ticketNumber || '').trim());
      let orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;

      if (user.role !== 'dev') {
          return res.status(403).json({ error: 'Access denied. Only devs can delete tickets.' });
      }

      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }

      const base = ticketBuilder.normalizeTicketBase(rawTicketNumber);
      const candidates = [];
      if (rawTicketNumber) candidates.push(rawTicketNumber);
      if (base && base !== rawTicketNumber) candidates.push(base);
      const stripped = rawTicketNumber.replace(/-0+$/, '');
      if (stripped && !candidates.includes(stripped)) candidates.push(stripped);

      function tryDeleteQueue(queue) {
          if (queue.length === 0) {
              if (!base) {
                  return res.status(404).json({ error: 'Ticket not found' });
              }
              db.get(
                  `SELECT ticket_number FROM tickets WHERE organization_id = ? AND ticket_number LIKE ? ORDER BY updated_at DESC LIMIT 1`,
                  [orgId, `${base}-%`],
                  (err, row) => {
                      if (err) {
                          console.error('Error resolving ticket for delete:', err);
                          return res.status(500).json({ error: 'Failed to delete ticket' });
                      }
                      if (!row || !row.ticket_number) {
                          return res.status(404).json({ error: 'Ticket not found' });
                      }
                      db.run(
                          `DELETE FROM tickets WHERE organization_id = ? AND ticket_number = ?`,
                          [orgId, row.ticket_number],
                          function (delErr) {
                              if (delErr) {
                                  console.error('Error deleting ticket:', delErr);
                                  return res.status(500).json({ error: 'Failed to delete ticket' });
                              }
                              if (this.changes === 0) {
                                  return res.status(404).json({ error: 'Ticket not found' });
                              }
                              void invalidateOrgActiveTicketListCache(db, orgId);
                              res.json({ message: 'Ticket deleted successfully' });
                          }
                      );
                  }
              );
              return;
          }
          const tn = queue.shift();
          db.run(
              `DELETE FROM tickets WHERE organization_id = ? AND ticket_number = ?`,
              [orgId, tn],
              function (err) {
                  if (err) {
                      console.error('Error deleting ticket:', err);
                      return res.status(500).json({ error: 'Failed to delete ticket' });
                  }
                  if (this.changes > 0) {
                      void invalidateOrgActiveTicketListCache(db, orgId);
                      return res.json({ message: 'Ticket deleted successfully' });
                  }
                  tryDeleteQueue(queue);
              }
          );
      }

      tryDeleteQueue([...new Set(candidates)]);
  });
}
