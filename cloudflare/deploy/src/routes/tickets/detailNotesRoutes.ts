// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canMutateOrganization } from '../../auth.js';
import { assertOwnerOrgTicketWriteAllowed, parseViewerOrganizationId } from '../../lib/partnerTicketAccess.js';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { resolveTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
import { TICKET_NOTE_BODY_MAX, computeTicketNotesReviewRequired, assertTicketNotesViewAccess } from './detailShared.js';
export function registerDetailNotesRoutes(tickets: TicketsApp) {
  tickets.get('/:ticketNumber/notes/status', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          const reviewRequired = await computeTicketNotesReviewRequired(db, row.id, req.user.id);
          res.json({ reviewRequired });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/notes/status:', e);
          res.status(500).json({ error: 'Failed to load notes status' });
      }
  });

  tickets.get('/:ticketNumber/notes', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          const noteRows = await allRows(
              db,
              `SELECT id, user_id, user_display_name, body, created_at, updated_at
               FROM ticket_notes
               WHERE ticket_id = ?
               ORDER BY datetime(created_at) DESC, id DESC`,
              [row.id]
          );
          const notes = (noteRows || []).map((r) => ({
              id: r.id,
              userId: r.user_id,
              userName: r.user_display_name || null,
              body: r.body,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
          }));
          const reviewRequired = await computeTicketNotesReviewRequired(db, row.id, req.user.id);
          res.json({ notes, reviewRequired });
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/notes:', e);
          res.status(500).json({ error: 'Failed to load notes' });
      }
  });

  tickets.post('/:ticketNumber/notes/mark-read', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const rawTn = (req.params.ticketNumber || '').trim();
      const orgId =
          req.query.organizationId != null
              ? parseInt(req.query.organizationId, 10)
              : req.body && req.body.organizationId != null
                ? parseInt(req.body.organizationId, 10)
                : req.user.organizationId;
      try {
          const row = await assertTicketNotesViewAccess(req, res, db, orgId, rawTn);
          if (!row) return;
          await runDb(
              db,
              `INSERT INTO ticket_note_read_state (user_id, ticket_id, last_read_at)
               VALUES (?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(user_id, ticket_id) DO UPDATE SET last_read_at = CURRENT_TIMESTAMP`,
              [userId, row.id]
          );
          res.json({ reviewRequired: false });
      } catch (e) {
          console.error('POST /tickets/:ticketNumber/notes/mark-read:', e);
          res.status(500).json({ error: 'Failed to mark notes read' });
      }
  });

  tickets.post('/:ticketNumber/notes', async (c) => {
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
      const tn = rawTn;
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, tn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }
      const bodyRaw = req.body && req.body.body != null ? String(req.body.body).trim() : '';
      if (!bodyRaw) {
          return res.status(400).json({ error: 'Note body is required' });
      }
      if (bodyRaw.length > TICKET_NOTE_BODY_MAX) {
          return res.status(400).json({ error: `Note must be at most ${TICKET_NOTE_BODY_MAX} characters` });
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
          const clientNoteIdRaw =
              req.body && req.body.clientNoteId != null ? String(req.body.clientNoteId).trim() : '';
          if (clientNoteIdRaw) {
              const existing = await getRow(
                  db,
                  `SELECT id, user_id, user_display_name, body, created_at, updated_at
                   FROM ticket_notes
                   WHERE client_note_id = ?
                   LIMIT 1`,
                  [clientNoteIdRaw]
              );
              if (existing) {
                  return res.status(201).json({
                      note: {
                          id: existing.id,
                          userId: existing.user_id,
                          userName: existing.user_display_name || null,
                          body: existing.body,
                          createdAt: existing.created_at,
                          updatedAt: existing.updated_at,
                      },
                      deduped: true,
                  });
              }
          }
          const result = await runDb(
              db,
              `INSERT INTO ticket_notes (organization_id, ticket_id, user_id, user_display_name, body, client_note_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [orgId, row.id, userId, displayName, bodyRaw, clientNoteIdRaw || null]
          );
          res.status(201).json({
              note: {
                  id: result.lastID,
                  userId,
                  userName: displayName || null,
                  body: bodyRaw,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
              },
          });
      } catch (e) {
          console.error('POST /tickets/:ticketNumber/notes:', e);
          res.status(500).json({ error: 'Failed to create note' });
      }
  });

}
