// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canViewOrganization, ORG_REQUIRED_MESSAGE, verifyPassword } from '../../auth.js';
import { assertOwnerOrgTicketWriteAllowed, parseViewerOrganizationId } from '../../lib/partnerTicketAccess.js';
import { applyPhotoRequirementFieldsWithDb } from '../../lib/photoRequirementCutoff.cjs';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { buildTicketResponseForClient, findFullTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import { buildWorkflowAckMapFromDbRows, computeWorkflowStatusForTicket, isRenewalEnquiryStatus, ticketAckBlockedByOperatorCodes } from '../computeWorkflowStatus.js';
import { evaluateAckComplianceEvidence, formatAckComplianceError, getWorkflowAckCompliancePolicy, getWorkflowOperatorCodeLists } from '../../lib/workflowAckCompliance.cjs';
import { workflowStatusOptionsFromContext } from '../ticketRowHelpers.js';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import type { TicketsApp } from './types.js';
export function registerDetailWorkflowRoutes(tickets: TicketsApp) {
  // ----- Workflow acknowledgement (manual READY) — see computeWorkflowStatus.ts -----

  tickets.put('/acknowledge-workflow', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      const { ticketNumber, password, note } = req.body || {};
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
      if (writeAccess.allowed === false) {
          return res.status(writeAccess.status).json({ error: writeAccess.error });
      }
      const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
      if (!tn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, tn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }
      const passwordStr = password != null ? String(password) : '';
      if (!passwordStr) {
          return res.status(400).json({ error: 'Account password is required to acknowledge workflow' });
      }
      const noteStr = note != null ? String(note).trim() : '';

      try {
          const pwdRow = await getRow(db, 'SELECT password_hash FROM users WHERE id = ?', [userId]);
          if (!pwdRow || !pwdRow.password_hash) {
              return res.status(500).json({ error: 'Account password not available' });
          }
          if (!verifyPassword(passwordStr, pwdRow.password_hash)) {
              return res.status(403).json({ error: 'Invalid password' });
          }

          const row = await findFullTicketRowForOrg(db, orgId, tn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          const ticket = await buildTicketResponseForClient(db, orgId, row);
          const orgRow = await getRow(db, 'SELECT settings FROM organizations WHERE id = ?', [orgId]);
          const workflowPolicy = getWorkflowAckCompliancePolicy(orgRow);
          const workflowOpts = workflowStatusOptionsFromContext({
              renewalAckWaivers: workflowPolicy.renewalAckWaivers === true,
              expiringSoonDays: workflowPolicy.expiringSoonDays,
              notReadyCodes: workflowPolicy.notReadyCodes,
              actionRequiredCodes: workflowPolicy.actionRequiredCodes,
              ackBlockingCodes: workflowPolicy.ackBlockingCodes,
          });
          const ackRows = await allRows(
              db,
              `SELECT ticket_number, revision, note, photos_met, acknowledged_at, acknowledged_by_name, acknowledged_by_user_id
               FROM ticket_workflow_acks WHERE organization_id = ?`,
              [orgId]
          );
          const ackMap = buildWorkflowAckMapFromDbRows(ackRows);
          const preStatus = computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts);
          const renewalWaivesGates = isRenewalEnquiryStatus(ticket) && workflowOpts.renewalAckWaivers;
          if (preStatus === 'NOT_READY' && !renewalWaivesGates) {
              return res.status(400).json({ error: 'Cannot acknowledge while utilities are still pending (Not Ready)' });
          }
          if (preStatus === 'CANCELLED' || preStatus === 'EXPIRED') {
              return res.status(400).json({ error: `Cannot acknowledge ticket in ${preStatus} state` });
          }
          if (preStatus === 'READY') {
              return res.status(400).json({ error: 'Ticket is already acknowledged for this revision' });
          }

          if (ticketAckBlockedByOperatorCodes(ticket, workflowOpts)) {
              const blocking = getWorkflowOperatorCodeLists(orgRow).ackBlockingCodes;
              return res.status(400).json({
                  error: `Cannot acknowledge while operator responses include pending codes (${blocking.join(', ')})`,
              });
          }

          await applyPhotoRequirementFieldsWithDb(db, ticket);
          const evidence = await evaluateAckComplianceEvidence(db, orgId, orgRow, row, ticket);
          if (workflowPolicy.requiredPhotoCount > 0 && !evidence.satisfied) {
              return res.status(400).json({ error: formatAckComplianceError(evidence) });
          }

          const userRow = await getRow(db, 'SELECT full_name, username, email FROM users WHERE id = ?', [userId]);
          const displayName =
              (userRow && userRow.full_name && String(userRow.full_name).trim()) ||
              (userRow && userRow.username) ||
              (userRow && userRow.email) ||
              '';
          const revision =
              row.revision != null && String(row.revision).trim() !== '' ? String(row.revision).trim() : '';

          await runDb(
              db,
              `INSERT INTO ticket_workflow_acks
                 (organization_id, ticket_number, revision, note, photos_met, acknowledged_by_user_id, acknowledged_by_name, acknowledged_at)
               VALUES (?, ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(organization_id, ticket_number) DO UPDATE SET
                 revision = excluded.revision,
                 note = excluded.note,
                 photos_met = excluded.photos_met,
                 acknowledged_by_user_id = excluded.acknowledged_by_user_id,
                 acknowledged_by_name = excluded.acknowledged_by_name,
                 acknowledged_at = CURRENT_TIMESTAMP`,
              [orgId, tn, revision, noteStr, userId, displayName]
          );

          const workflowAck = {
              ticketNumber: tn,
              revision,
              note: noteStr,
              photosMet: true,
              acknowledgedAt: new Date().toISOString(),
              acknowledgedBy: displayName,
              acknowledgedByUserId: userId,
          };
          ackMap[tn] = workflowAck;

          await invalidateOrgActiveTicketListCache(db, orgId);
          res.json({
              success: true,
              computedWorkflowStatus: computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts),
              workflowAck,
          });
      } catch (e) {
          console.error('PUT /acknowledge-workflow:', e);
          res.status(500).json({ error: e.message || 'Failed to acknowledge workflow' });
      }
  });

  tickets.delete('/acknowledge-workflow', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      const { ticketNumber } = req.body || {};
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      const membershipRole =
          req.user.role === 'dev' ? 'admin' : await getMembershipRole(db, req.user.id, orgId);
      const isOrgAdmin =
          req.user.role === 'dev' ||
          membershipRole === 'admin' ||
          (req.user.adminOrganizationIds && req.user.adminOrganizationIds.includes(orgId));
      if (!isOrgAdmin) {
          return res.status(403).json({ error: 'Only organization admins can revert workflow acknowledgement' });
      }
      const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
      if (!tn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      try {
          const result = await runDb(
              db,
              `DELETE FROM ticket_workflow_acks WHERE organization_id = ? AND ticket_number = ?`,
              [orgId, tn]
          );
          if (!result.changes) {
              return res.status(404).json({ error: 'Workflow acknowledgement not found' });
          }
          await invalidateOrgActiveTicketListCache(db, orgId);
          res.json({ success: true, computedWorkflowStatus: 'ACTION_REQUIRED' });
      } catch (e) {
          console.error('DELETE /acknowledge-workflow:', e);
          res.status(500).json({ error: e.message || 'Failed to revert workflow acknowledgement' });
      }
  });

  // Database-only ticket detail for fast popup hydration; external POSR/nGen refresh remains separate.
}
