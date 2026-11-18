// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canMutateOrganization } from '../../auth.js';
import { assertOwnerOrgTicketWriteAllowed, parseViewerOrganizationId } from '../../lib/partnerTicketAccess.js';
import { runDb, getRow } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { assertNotTechWrite, resolveTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import { assertOrgDataDeleteAllowed } from '../../lib/orgDataPermissions.js';
import type { TicketsApp } from './types.js';
import { computeJobComplianceAttentionRequired, mapJobComplianceRow } from '../../lib/jobComplianceDates.cjs';
import { listProjectsForTicket, addProjectTicketMembership, excludeProjectTicketMembership, removeProjectTicketMembership, resolveMembershipSource, ticketAutoMatchesJobKey, isTicketEffectivelyInProject } from '../../lib/jobProjectMembership.cjs';
import { allocateUniquePublicId } from '../../lib/jobProjectShareLink.cjs';
import { JOB_COMPLIANCE_NOTES_MAX, resolveJobNameFromTicketRow, normalizeComplianceDateInput, parseJobComplianceCustomItems, fetchJobComplianceRow, listTicketNumbersForJobName, resolveComplianceJobNameKeyForTicket, assertTicketNotesViewAccess } from './detailShared.js';
export function registerDetailProjectsComplianceRoutes(tickets: TicketsApp) {
  tickets.get('/:ticketNumber/projects', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          const projects = await listProjectsForTicket(db, orgId, row);
          res.json({ projects });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/projects:', e);
          res.status(500).json({ error: 'Failed to load ticket projects' });
      }
  });

  tickets.post('/:ticketNumber/projects', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.body && req.body.organizationId != null
              ? parseInt(req.body.organizationId, 10)
              : req.user.organizationId;
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
      if (writeAccess.allowed === false) {
          return res.status(writeAccess.status).json({ error: writeAccess.error });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;
      const jobNameKey =
          req.body && req.body.jobNameKey != null ? String(req.body.jobNameKey).trim().toLowerCase() : '';
      if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) return res.status(404).json({ error: 'Ticket not found' });
          const ticketId = row.id != null ? Number(row.id) : NaN;
          if (!Number.isFinite(ticketId)) return res.status(404).json({ error: 'Ticket not found' });
          if (await isTicketEffectivelyInProject(db, orgId, jobNameKey, row, ticketId)) {
              return res.status(409).json({ error: 'Ticket is already in this project' });
          }
          await addProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId);
          const projects = await listProjectsForTicket(db, orgId, row);
          res.json({ projects });
      } catch (e) {
          console.error('POST /tickets/:ticketNumber/projects:', e);
          res.status(500).json({ error: 'Failed to add ticket to project' });
      }
  });

  tickets.delete('/:ticketNumber/projects/:jobNameKey', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const rawTn = (req.params.ticketNumber || '').trim();
      const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
      const orgId =
          req.body && req.body.organizationId != null
              ? parseInt(req.body.organizationId, 10)
              : req.user.organizationId;
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
      if (writeAccess.allowed === false) {
          return res.status(writeAccess.status).json({ error: writeAccess.error });
      }
      if (!(await assertOrgDataDeleteAllowed(req, res, db, orgId))) return;
      const mode =
          req.body && req.body.mode != null ? String(req.body.mode).trim().toLowerCase() : 'exclude';
      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) return res.status(404).json({ error: 'Ticket not found' });
          const ticketId = row.id != null ? Number(row.id) : NaN;
          if (!Number.isFinite(ticketId)) return res.status(404).json({ error: 'Ticket not found' });
          const source = await resolveMembershipSource(db, orgId, jobNameKey, row, ticketId);
          if (mode === 'revert') {
              await removeProjectTicketMembership(db, orgId, jobNameKey, ticketId);
          } else if (source === 'manual_include') {
              await removeProjectTicketMembership(db, orgId, jobNameKey, ticketId);
          } else if (ticketAutoMatchesJobKey(row, jobNameKey)) {
              await excludeProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId);
          } else {
              return res.status(400).json({ error: 'Ticket is not in this project' });
          }
          const projects = await listProjectsForTicket(db, orgId, row);
          res.json({ projects });
      } catch (e) {
          console.error('DELETE /tickets/:ticketNumber/projects/:jobNameKey:', e);
          res.status(500).json({ error: 'Failed to remove ticket from project' });
      }
  });

  tickets.get('/:ticketNumber/job-compliance/status', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          const jobNameKey = await resolveComplianceJobNameKeyForTicket(req, db, orgId, row);
          if (!jobNameKey) {
              return res.json({ hasJobName: false, attentionRequired: false });
          }
          const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
          const compliance = mapJobComplianceRow(complianceRow);
          const jobName =
              resolveJobNameFromTicketRow(row) ||
              (complianceRow && complianceRow.job_name_display
                  ? String(complianceRow.job_name_display).trim()
                  : jobNameKey);
          res.json({
              hasJobName: true,
              jobName,
              jobNameKey,
              attentionRequired: computeJobComplianceAttentionRequired(compliance),
          });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/job-compliance/status:', e);
          res.status(500).json({ error: 'Failed to load compliance status' });
      }
  });

  tickets.get('/:ticketNumber/job-compliance', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          const jobNameKey = await resolveComplianceJobNameKeyForTicket(req, db, orgId, row);
          if (!jobNameKey) {
              return res.json({
                  jobName: null,
                  jobNameKey: null,
                  linkedTicketNumbers: [],
                  compliance: null,
                  attentionRequired: false,
                  complianceLinked: false,
              });
          }
          const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
          const compliance = mapJobComplianceRow(complianceRow);
          const linkedTicketNumbers = await listTicketNumbersForJobName(db, orgId, jobNameKey);
          const jobName =
              (complianceRow && complianceRow.job_name_display
                  ? String(complianceRow.job_name_display).trim()
                  : '') ||
              resolveJobNameFromTicketRow(row) ||
              jobNameKey;
          res.json({
              jobName,
              jobNameKey,
              linkedTicketNumbers,
              compliance,
              attentionRequired: computeJobComplianceAttentionRequired(compliance),
              complianceLinked: true,
          });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/job-compliance:', e);
          res.status(500).json({ error: 'Failed to load job compliance' });
      }
  });

  tickets.put('/:ticketNumber/job-compliance', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.body && req.body.organizationId != null
              ? parseInt(req.body.organizationId, 10)
              : req.user.organizationId;
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
      if (writeAccess.allowed === false) {
          return res.status(writeAccess.status).json({ error: writeAccess.error });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;
      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
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
          const jobNameKey = await resolveComplianceJobNameKeyForTicket(req, db, orgId, row);
          if (!jobNameKey) {
              return res.status(400).json({
                  error: 'This ticket is not linked to a project. Add it to a project to track compliance.',
              });
          }
          const body = req.body || {};
          const permitExpiration = normalizeComplianceDateInput(body.permitExpiration);
          if (body.permitExpiration != null && String(body.permitExpiration).trim() && !permitExpiration) {
              return res.status(400).json({ error: 'permitExpiration must use YYYY-MM-DD format or N/A' });
          }
          const trafficControlPermitExpiration = normalizeComplianceDateInput(body.trafficControlPermitExpiration);
          if (
              body.trafficControlPermitExpiration != null &&
              String(body.trafficControlPermitExpiration).trim() &&
              !trafficControlPermitExpiration
          ) {
              return res.status(400).json({ error: 'trafficControlPermitExpiration must use YYYY-MM-DD format or N/A' });
          }
          const thirdPartyInspectionDate = normalizeComplianceDateInput(body.thirdPartyInspectionDate);
          if (
              body.thirdPartyInspectionDate != null &&
              String(body.thirdPartyInspectionDate).trim() &&
              !thirdPartyInspectionDate
          ) {
              return res.status(400).json({ error: 'thirdPartyInspectionDate must use YYYY-MM-DD format or N/A' });
          }
          const thirdPartyInspectionNotes =
              body.thirdPartyInspectionNotes != null ? String(body.thirdPartyInspectionNotes).trim() : '';
          if (thirdPartyInspectionNotes.length > JOB_COMPLIANCE_NOTES_MAX) {
              return res.status(400).json({
                  error: `thirdPartyInspectionNotes must be at most ${JOB_COMPLIANCE_NOTES_MAX} characters`,
              });
          }
          const generalNotes = body.generalNotes != null ? String(body.generalNotes).trim() : '';
          if (generalNotes.length > JOB_COMPLIANCE_NOTES_MAX) {
              return res.status(400).json({
                  error: `generalNotes must be at most ${JOB_COMPLIANCE_NOTES_MAX} characters`,
              });
          }
          const customParsed = parseJobComplianceCustomItems(body.customItems);
          if (!customParsed.ok) {
              return res.status(400).json({ error: customParsed.error });
          }
          const userRow = await getRow(db, 'SELECT full_name, username, email FROM users WHERE id = ?', [userId]);
          const displayName =
              (userRow && userRow.full_name && String(userRow.full_name).trim()) ||
              (userRow && userRow.username) ||
              (userRow && userRow.email) ||
              '';
          const customItemsJson = JSON.stringify(customParsed.items);
          const existing = await fetchJobComplianceRow(db, orgId, jobNameKey);
          const jobName =
              (existing && existing.job_name_display
                  ? String(existing.job_name_display).trim()
                  : '') ||
              resolveJobNameFromTicketRow(row) ||
              jobNameKey;
          if (existing) {
              await runDb(
                  db,
                  `UPDATE job_misc_compliance
                   SET job_name_display = ?,
                       permit_expiration = ?,
                       traffic_control_permit_expiration = ?,
                       third_party_inspection_date = ?,
                       third_party_inspection_notes = ?,
                       general_notes = ?,
                       custom_items_json = ?,
                       updated_by_user_id = ?,
                       updated_by_display_name = ?,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE organization_id = ? AND job_name_normalized = ?`,
                  [
                      jobName,
                      permitExpiration,
                      trafficControlPermitExpiration,
                      thirdPartyInspectionDate,
                      thirdPartyInspectionNotes || null,
                      generalNotes || null,
                      customItemsJson,
                      userId,
                      displayName || null,
                      orgId,
                      jobNameKey,
                  ]
              );
          } else {
              const publicId = await allocateUniquePublicId(db);
              await runDb(
                  db,
                  `INSERT INTO job_misc_compliance (
                       organization_id, job_name_normalized, job_name_display,
                       permit_expiration, traffic_control_permit_expiration,
                       third_party_inspection_date, third_party_inspection_notes,
                       general_notes, custom_items_json, public_id,
                       updated_by_user_id, updated_by_display_name,
                       created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  [
                      orgId,
                      jobNameKey,
                      jobName,
                      permitExpiration,
                      trafficControlPermitExpiration,
                      thirdPartyInspectionDate,
                      thirdPartyInspectionNotes || null,
                      generalNotes || null,
                      customItemsJson,
                      publicId,
                      userId,
                      displayName || null,
                  ]
              );
          }
          const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
          const compliance = mapJobComplianceRow(complianceRow);
          const linkedTicketNumbers = await listTicketNumbersForJobName(db, orgId, jobNameKey);
          res.json({
              jobName,
              linkedTicketNumbers,
              compliance,
              attentionRequired: computeJobComplianceAttentionRequired(compliance),
          });
      } catch (e) {
          console.error('PUT /tickets/:ticketNumber/job-compliance:', e);
          res.status(500).json({ error: 'Failed to save job compliance' });
      }
  });

  // Ticket-level assignment removed — use project assignees instead.
}
