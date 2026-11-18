// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import { getRow } from '../../lib/db.cjs';
import { canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { resolveTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import { normalizeJobNameKey } from '../../lib/jobComplianceDates.cjs';
import { listEffectiveTicketRowsForProject, listComplianceJobKeysForTicket } from '../../lib/jobProjectMembership.cjs';
/**
 * Full USAN request number with revision suffix (e.g. 2026051100200-001).
 * @param {object|null|undefined} ticketData
 * @param {string} rawTn
 * @returns {string|null}
 */
export function resolveRequestNumberForTicket(ticketData, rawTn) {
    const candidates = [
        ticketData && ticketData.ticketNumberFull,
        ticketData && ticketData.ticketNumber,
        ticketData && ticketData.requestNumberFull,
        rawTn,
    ];
    for (const c of candidates) {
        const s = c != null ? String(c).trim() : '';
        if (!s) continue;
        const parts = ticketBuilder.parseTicketNumberParts(s);
        if (parts.revisionSuffix != null && String(parts.revisionSuffix).trim() !== '') {
            return parts.displayFull;
        }
    }
    const base = ticketBuilder.normalizeTicketBase(rawTn) || String(rawTn || '').trim();
    const rev =
        ticketData && ticketData.ticketRevision != null ? String(ticketData.ticketRevision).trim() : '';
    if (base && rev) {
        return `${base}-${rev}`;
    }
    return null;
}

export const TICKET_NOTE_BODY_MAX = 4000;
export const JOB_COMPLIANCE_NOTES_MAX = 4000;
export const JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX = 200;
export const JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX = 2000;
export const JOB_COMPLIANCE_CUSTOM_ITEMS_MAX = 50;

/**
 * @param {object|null|undefined} row
 * @returns {string|null}
 */
export function resolveJobNameFromTicketRow(row) {
    if (!row || row.user_reference == null) return null;
    const raw = String(row.user_reference).trim();
    return raw || null;
}

/**
 * Strip characters unsafe for Content-Disposition / filesystem names.
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function sanitizeFilenamePart(value) {
    return String(value || '')
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 120);
}

/**
 * Human-readable prefix for USAN document downloads: ticket number plus job name.
 * @param {string|null|undefined} requestNumber
 * @param {string|null|undefined} jobName
 * @returns {string}
 */
export function buildUsanDocumentNamePrefix(requestNumber, jobName) {
    const ticketNumber = String(requestNumber || '').trim();
    const sanitizedJob = sanitizeFilenamePart(jobName);
    if (ticketNumber && sanitizedJob) return `${ticketNumber} - ${sanitizedJob}`;
    return ticketNumber || sanitizedJob || 'document';
}

/**
 * Safe Content-Disposition attachment header for a filename.
 * @param {string} filename
 * @returns {string}
 */
export function contentDispositionAttachment(filename) {
    const safe = String(filename || 'download')
        .replace(/[\r\n]/g, '')
        .replace(/"/g, "'");
    return `attachment; filename="${safe}"`;
}

/**
 * @param {string|null|undefined} dateStr
 * @returns {string|null}
 */
export function normalizeComplianceDateInput(dateStr) {
    if (dateStr == null) return null;
    const d = String(dateStr).trim();
    if (!d) return null;
    if (/^n\/a$/i.test(d)) return 'N/A';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const parsed = new Date(`${d}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    return d;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, items: Array<{ id: string, label: string, date: string|null, notes: string|null }> } | { ok: false, error: string }}
 */
export function parseJobComplianceCustomItems(raw) {
    if (!Array.isArray(raw)) {
        return { ok: false, error: 'customItems must be an array' };
    }
    if (raw.length > JOB_COMPLIANCE_CUSTOM_ITEMS_MAX) {
        return { ok: false, error: `At most ${JOB_COMPLIANCE_CUSTOM_ITEMS_MAX} custom items allowed` };
    }
    const items = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
            return { ok: false, error: 'Each custom item must be an object' };
        }
        const label = entry.label != null ? String(entry.label).trim() : '';
        if (!label) {
            return { ok: false, error: 'Each custom item requires a label' };
        }
        if (label.length > JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX) {
            return {
                ok: false,
                error: `Custom item labels must be at most ${JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX} characters`,
            };
        }
        const notesRaw = entry.notes != null ? String(entry.notes).trim() : '';
        if (notesRaw.length > JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX) {
            return {
                ok: false,
                error: `Custom item notes must be at most ${JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX} characters`,
            };
        }
        const date = normalizeComplianceDateInput(entry.date);
        if (entry.date != null && String(entry.date).trim() && !date) {
            return { ok: false, error: 'Custom item dates must use YYYY-MM-DD format or N/A' };
        }
        const id =
            entry.id != null && String(entry.id).trim()
                ? String(entry.id).trim().slice(0, 64)
                : `item-${Date.now()}-${items.length}`;
        items.push({
            id,
            label,
            date,
            notes: notesRaw || null,
        });
    }
    return { ok: true, items };
}

/**
 * @param {import('../../database.js').Database} db
 * @param {number} orgId
 * @param {string} jobNameKey
 * @returns {Promise<object|null>}
 */
export async function fetchJobComplianceRow(db, orgId, jobNameKey) {
    return getRow(
        db,
        `SELECT id, organization_id, job_name_normalized, job_name_display,
                permit_expiration, traffic_control_permit_expiration,
                third_party_inspection_date, third_party_inspection_notes,
                general_notes, custom_items_json, updated_at, updated_by_display_name
         FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, jobNameKey]
    );
}

/**
 * @param {import('../../database.js').Database} db
 * @param {number} orgId
 * @param {string} jobNameKey
 * @returns {Promise<string[]>}
 */
export async function listTicketNumbersForJobName(db, orgId, jobNameKey) {
    const rows = await listEffectiveTicketRowsForProject(db, orgId, jobNameKey);
    return (rows || [])
        .map((r) => (r.ticket_number != null ? String(r.ticket_number).trim() : ''))
        .filter(Boolean);
}

export async function resolveComplianceJobNameKeyForTicket(req, db, orgId, row) {
    const keys = await listComplianceJobKeysForTicket(db, orgId, row);
    if (!keys || keys.length === 0) return null;
    const fromQuery =
        req.query && req.query.jobNameKey != null
            ? String(req.query.jobNameKey).trim().toLowerCase()
            : req.body && req.body.jobNameKey != null
              ? String(req.body.jobNameKey).trim().toLowerCase()
              : '';
    if (fromQuery && keys.includes(fromQuery)) return fromQuery;
    const fromJob = normalizeJobNameKey(resolveJobNameFromTicketRow(row));
    if (fromJob && keys.includes(fromJob)) return fromJob;
    return keys[0];
}

/**
 * @param {import('../../database.js').Database} db
 * @param {number} ticketId
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
export async function computeTicketNotesReviewRequired(db, ticketId, userId) {
    const readRow = await getRow(
        db,
        'SELECT last_read_at FROM ticket_note_read_state WHERE user_id = ? AND ticket_id = ?',
        [userId, ticketId]
    );
    const lastReadAt = readRow && readRow.last_read_at ? String(readRow.last_read_at) : null;
    if (lastReadAt) {
        const unread = await getRow(
            db,
            `SELECT 1 AS ok FROM ticket_notes
             WHERE ticket_id = ? AND user_id != ? AND datetime(created_at) > datetime(?)
             LIMIT 1`,
            [ticketId, userId, lastReadAt]
        );
        return !!unread;
    }
    const fromOther = await getRow(
        db,
        `SELECT 1 AS ok FROM ticket_notes
         WHERE ticket_id = ? AND user_id != ?
         LIMIT 1`,
        [ticketId, userId]
    );
    return !!fromOther;
}

export async function assertTicketNotesViewAccess(req, res, db, orgId, rawTn) {
    if (!rawTn) {
        res.status(400).json({ error: 'ticketNumber is required' });
        return null;
    }
    if (!orgId) {
        res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        return null;
    }
    if (!(await canViewOrganization(req.user, orgId))) {
        res.status(403).json({ error: 'You do not have access to that organization' });
        return null;
    }
    if (req.user.role !== 'dev') {
        const role = await getMembershipRole(db, req.user.id, orgId);
        if (isTechMembership(role)) {
            const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, rawTn);
            if (!ok) {
                res.status(403).json({ error: 'You do not have access to this ticket' });
                return null;
            }
        }
    }
    const row = await resolveTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        res.status(404).json({ error: 'Ticket not found' });
        return null;
    }
    return row;
}
