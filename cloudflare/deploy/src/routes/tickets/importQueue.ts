import { getDatabase } from '../../database.js';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { findOrganizationIdsForLodgedByUserName } from '../../lib/pacwebJobOrgResolve.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { registerTicketImportQueueRoutes } from '../ticketRouteRegistrars.js';
import { buildTicketResponseForClient, findFullTicketRowForOrg } from '../ticketRowHelpers.js';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import type { TicketsApp } from './types.js';
import * as pollHelpers from './pollHelpers.js';
const getPacUnassignedImportQueue = async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    if (req.user.role !== 'dev') {
        return res.status(403).json({ error: 'Developer only' });
    }
    const db = getDatabase();
    try {
        const rows = await allRows(
            db,
            `SELECT q.id, q.request_number, q.lodged_by_hint, q.created_at, q.created_by_user_id,
                    u.username AS created_by_username
             FROM pac_unassigned_import_queue q
             LEFT JOIN users u ON u.id = q.created_by_user_id
             ORDER BY q.created_at DESC`
        );
        res.json(rows || []);
    } catch (e) {
        if (/no such table/i.test(e.message || '')) {
            return res.json([]);
        }
        console.error('GET /tickets/pac-import-queue:', e);
        res.status(500).json({ error: 'Failed to load queue' });
    }
};

const deletePacUnassignedQueueEntry = async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    if (req.user.role !== 'dev') {
        return res.status(403).json({ error: 'Developer only' });
    }
    const queueId = parseInt(req.params.queueId, 10);
    if (!Number.isFinite(queueId)) {
        return res.status(400).json({ error: 'Invalid queue id' });
    }
    const db = getDatabase();
    try {
        const r = await runDb(db, `DELETE FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
        if (!r || r.changes === 0) {
            return res.status(404).json({ error: 'Queue entry not found' });
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('DELETE /tickets/pac-import-queue:', e);
        res.status(500).json({ error: 'Failed to remove' });
    }
};

const postRetryAutoAssignPacUnassignedQueue = async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    if (req.user.role !== 'dev') {
        return res.status(403).json({ error: 'Developer only' });
    }
    const db = getDatabase();
    const userId = req.user.id;
    try {
        const rows = await allRows(
            db,
            `SELECT * FROM pac_unassigned_import_queue
             ORDER BY created_at DESC, id DESC`
        );
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.json({
                ok: true,
                queueCount: 0,
                attempted: 0,
                imported: 0,
                removedAlreadyInTargetOrg: 0,
                unresolved: 0,
                ambiguous: 0,
                errors: 0,
                items: [],
            });
        }
        const pacAccounts = await allRows(
            db,
            `SELECT organization_id, pacweb_username
             FROM organization_pacweb_accounts
             WHERE pacweb_username IS NOT NULL AND TRIM(pacweb_username) != ''
             ORDER BY organization_id, id`
        );
        const items = [];
        let attempted = 0;
        let imported = 0;
        let removedAlreadyInTargetOrg = 0;
        let unresolved = 0;
        let ambiguous = 0;
        let errors = 0;
        for (const qrow of rows) {
            const queueId = Number(qrow && qrow.id);
            const rn = qrow && qrow.request_number != null ? String(qrow.request_number).trim() : '';
            if (!rn) {
                unresolved++;
                items.push({ id: queueId, status: 'unresolved', reason: 'missing_request_number' });
                continue;
            }
            let enquiry = null;
            let jobRow = null;
            try {
                enquiry = qrow.enquiry_json ? JSON.parse(qrow.enquiry_json) : null;
                jobRow = qrow.job_row_json ? JSON.parse(qrow.job_row_json) : null;
            } catch (_) {
                errors++;
                items.push({ id: queueId, requestNumber: rn, status: 'error', reason: 'invalid_stored_payload' });
                continue;
            }

            const hintedLodgedBy =
                qrow && qrow.lodged_by_hint != null && String(qrow.lodged_by_hint).trim() !== ''
                    ? String(qrow.lodged_by_hint)
                    : enquiry && enquiry.enquiryDetails && enquiry.enquiryDetails.lodgedByUserName != null
                      ? String(enquiry.enquiryDetails.lodgedByUserName)
                      : '';
            const orgIds = findOrganizationIdsForLodgedByUserName(pacAccounts, hintedLodgedBy);
            const existingOrgIds = await pollHelpers.findOrganizationIdsWithTicket(db, rn);
            let targetOrgId = null;
            let resolutionSource = null;
            if (orgIds.length === 1) {
                targetOrgId = orgIds[0];
                resolutionSource = 'lodged_by_match';
            } else if (orgIds.length > 1) {
                ambiguous++;
                items.push({
                    id: queueId,
                    requestNumber: rn,
                    status: 'ambiguous',
                    reason: 'multiple_lodged_by_matches',
                    candidateOrgIds: orgIds,
                });
                continue;
            } else if (existingOrgIds.length === 1) {
                targetOrgId = existingOrgIds[0];
                resolutionSource = 'existing_ticket_org';
            } else if (existingOrgIds.length > 1) {
                ambiguous++;
                items.push({
                    id: queueId,
                    requestNumber: rn,
                    status: 'ambiguous',
                    reason: 'multiple_existing_ticket_orgs',
                    candidateOrgIds: existingOrgIds,
                });
                continue;
            }

            if (!Number.isFinite(targetOrgId)) {
                unresolved++;
                items.push({ id: queueId, requestNumber: rn, status: 'unresolved', reason: 'no_match' });
                continue;
            }

            attempted++;
            if (!(await pollHelpers.userCanImportTicketToOrg(req, db, targetOrgId))) {
                unresolved++;
                items.push({
                    id: queueId,
                    requestNumber: rn,
                    status: 'unresolved',
                    reason: 'no_access_to_target_org',
                    targetOrgId,
                });
                continue;
            }
            if (await pollHelpers.ticketAlreadyStoredForOrg(db, targetOrgId, rn)) {
                await runDb(db, `DELETE FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
                removedAlreadyInTargetOrg++;
                items.push({
                    id: queueId,
                    requestNumber: rn,
                    status: 'removed',
                    reason: 'already_in_target_org',
                    targetOrgId,
                    resolutionSource,
                });
                continue;
            }

            const imp = await pollHelpers.importOneTicketPacPollNgenFirst(db, targetOrgId, userId, rn, jobRow, enquiry);
            if (!imp.ok) {
                errors++;
                items.push({
                    id: queueId,
                    requestNumber: rn,
                    status: 'error',
                    reason: 'import_failed',
                    targetOrgId,
                    error: imp.error || 'Import failed',
                });
                continue;
            }
            await runDb(db, `DELETE FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
            imported++;
            void invalidateOrgActiveTicketListCache(db, targetOrgId);
            items.push({
                id: queueId,
                requestNumber: rn,
                status: 'imported',
                targetOrgId,
                resolutionSource,
            });
        }
        return res.json({
            ok: true,
            queueCount: rows.length,
            attempted,
            imported,
            removedAlreadyInTargetOrg,
            unresolved,
            ambiguous,
            errors,
            items,
        });
    } catch (e) {
        console.error('POST /tickets/pac-import-queue/retry-auto:', e);
        return res.status(500).json({ error: 'Failed to retry queue auto-assign' });
    }
};

const postAssignPacUnassignedQueue = async (c) => {
    const req = buildExpressReq(c);
    const res = c.get('expressRes') as ResShim;
    if (req.user.role !== 'dev') {
        return res.status(403).json({ error: 'Developer only' });
    }
    const queueId = parseInt(req.params.queueId, 10);
    const orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : NaN;
    if (!Number.isFinite(queueId) || !Number.isFinite(orgId)) {
        return res.status(400).json({ error: 'queueId and organizationId are required' });
    }
    const db = getDatabase();
    const userId = req.user.id;
    const qrow = await getRow(db, `SELECT * FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
    if (!qrow) {
        return res.status(404).json({ error: 'Queue entry not found' });
    }
    if (!(await pollHelpers.userCanImportTicketToOrg(req, db, orgId))) {
        return res.status(403).json({ error: 'You cannot import into this organization' });
    }
    let enquiry;
    let jobRow;
    try {
        enquiry = qrow.enquiry_json ? JSON.parse(qrow.enquiry_json) : null;
        jobRow = qrow.job_row_json ? JSON.parse(qrow.job_row_json) : null;
    } catch (e) {
        return res.status(500).json({ error: 'Invalid stored queue payload' });
    }
    const rn = String(qrow.request_number || '').trim();
    if (!rn) {
        return res.status(400).json({ error: 'Invalid request number' });
    }
    if (await pollHelpers.ticketAlreadyStoredForOrg(db, orgId, rn)) {
        await runDb(db, `DELETE FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
        const fullRow = await findFullTicketRowForOrg(db, orgId, rn);
        if (!fullRow) {
            return res.json({ ok: true, alreadyInTargetOrg: true });
        }
        const ticket = await buildTicketResponseForClient(db, orgId, fullRow);
        return res.json({ ok: true, ticket, alreadyInTargetOrg: true });
    }
    const imp = await pollHelpers.importOneTicketPacPollNgenFirst(db, orgId, userId, rn, jobRow, enquiry);
    if (!imp.ok) {
        return res.status(400).json({ error: imp.error || 'Import failed' });
    }
    await runDb(db, `DELETE FROM pac_unassigned_import_queue WHERE id = ?`, [queueId]);
    void invalidateOrgActiveTicketListCache(db, orgId);
    const fullRow = await findFullTicketRowForOrg(db, orgId, rn);
    if (!fullRow) {
        return res.json({ ok: true, ticket: imp.ticket });
    }
    const ticket = await buildTicketResponseForClient(db, orgId, fullRow);
    res.json({ ok: true, ticket });
};

export function registerTicketsImportQueueRoutes(tickets: TicketsApp) {
  registerTicketImportQueueRoutes(tickets, {
    getPacUnassignedImportQueue,
    deletePacUnassignedQueueEntry,
    postRetryAutoAssignPacUnassignedQueue,
    postAssignPacUnassignedQueue,
  });
}
