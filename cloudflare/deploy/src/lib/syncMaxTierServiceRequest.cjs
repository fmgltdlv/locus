/**
 * Max-tier auto service_request on new ticket / revision change.
 * No map work here. Overlaps OK (no dedup).
 * Pure CJS (no .ts requires) so ticketPersist can call it safely.
 */

const { getRow, runDb } = require('./db.cjs');
const { buildFeedServiceRequestNote } = require('./feedServiceRequestNote.cjs');

/** When false, Max-tier auto SR insert is disabled; manual POST only. */
const FEED_AUTO_SERVICE_REQUEST_ENABLED = false;

function envAutoUserId() {
    const raw =
        (typeof process !== 'undefined' &&
            process.env &&
            process.env.FEED_AUTO_SERVICE_REQUEST_USER_ID) ||
        '';
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

function normalizeRevision(value) {
    if (value == null || String(value).trim() === '') return '';
    return String(value).trim();
}

function ticketRevisionOf(ticket) {
    if (!ticket || typeof ticket !== 'object') return '';
    return normalizeRevision(
        ticket.ticketRevision ?? ticket.revision ?? ticket.ticket_revision
    );
}

function ticketNumberOf(ticket) {
    if (!ticket || typeof ticket !== 'object') return '';
    const n = ticket.ticketNumber ?? ticket.ticket_number;
    return n != null ? String(n).trim() : '';
}

function getNgenEnquiryStatus(ticket) {
    if (!ticket || typeof ticket !== 'object') return '';
    const raw =
        ticket.ngenEnquiryStatus ??
        ticket.providerEnquiryStatus ??
        ticket.currentNgenEnquiryStatus ??
        ticket.current_ngen_enquiry_status ??
        ticket.ngen_enquiry_status ??
        ticket.provider_enquiry_status;
    return raw != null ? String(raw).trim() : '';
}

function shouldSkipAutoSrForEnquiry(ticket) {
    const status = getNgenEnquiryStatus(ticket).toUpperCase();
    return status === 'RNEW' || status === 'AMND';
}

function orgIsMaxTier(orgRow) {
    if (orgRow && orgRow.subscription_tier != null && String(orgRow.subscription_tier).trim() !== '') {
        return String(orgRow.subscription_tier).trim().toLowerCase() === 'max';
    }
    let settings = {};
    try {
        const raw = orgRow && orgRow.settings;
        if (typeof raw === 'string' && raw.trim()) settings = JSON.parse(raw);
        else if (raw && typeof raw === 'object') settings = raw;
    } catch (_) {
        settings = {};
    }
    const t = String(settings.subscriptionTier || settings.subscription_tier || '')
        .trim()
        .toLowerCase();
    return t === 'max';
}

/**
 * @param {import('sqlite3').Database} db
 * @param {{
 *   orgId: number,
 *   ticket: Record<string, unknown>,
 *   prev?: Record<string, unknown>|null,
 * }} opts
 * @returns {Promise<{ inserted: boolean, skipped?: string, id?: number }>}
 */
async function syncMaxTierServiceRequest(db, opts) {
    if (!FEED_AUTO_SERVICE_REQUEST_ENABLED) {
        return { inserted: false, skipped: 'disabled' };
    }

    const orgId = Number(opts && opts.orgId);
    const ticket = opts && opts.ticket;
    const prev = opts && opts.prev != null ? opts.prev : null;

    if (!Number.isFinite(orgId) || orgId <= 0 || !ticket || typeof ticket !== 'object') {
        return { inserted: false, skipped: 'invalid_args' };
    }

    const orgRow = await getRow(
        db,
        'SELECT id, name, settings, subscription_tier FROM organizations WHERE id = ?',
        [orgId]
    );
    if (!orgRow) return { inserted: false, skipped: 'org_missing' };

    if (!orgIsMaxTier(orgRow)) {
        return { inserted: false, skipped: 'not_max' };
    }

    const ticketNumber = ticketNumberOf(ticket);
    if (!ticketNumber) return { inserted: false, skipped: 'no_ticket_number' };

    const nextRev = ticketRevisionOf(ticket);
    const prevRev = prev ? ticketRevisionOf(prev) : '';
    const isNew = prev == null;
    const revChanged = prev != null && nextRev !== prevRev;

    if (!isNew && !revChanged) {
        return { inserted: false, skipped: 'no_new_or_revision' };
    }

    if (shouldSkipAutoSrForEnquiry(ticket)) {
        return { inserted: false, skipped: 'rnew_or_amnd' };
    }

    try {
        const ticketId = ticket.id != null ? Number(ticket.id) : null;
        if (Number.isFinite(ticketId) && ticketId > 0) {
            const enq = await getRow(
                db,
                `SELECT status FROM ticket_revision_enquiries
                 WHERE ticket_id = ? AND COALESCE(revision, '') = ?
                 LIMIT 1`,
                [ticketId, nextRev || '']
            );
            if (enq && String(enq.status || '').trim().toUpperCase() === 'AMND') {
                return { inserted: false, skipped: 'amnd_enquiry_row' };
            }
        }
    } catch (_) {
        /* ignore missing table / column mismatch */
    }

    const orgName =
        orgRow.name != null && String(orgRow.name).trim() !== ''
            ? String(orgRow.name).trim()
            : `Org ${orgId}`;
    const userId = await resolveAutoServiceRequestUserId(db, orgId, ticket);
    if (userId == null) {
        console.error(
            'syncMaxTierServiceRequest: no valid users.id for auto SR (check FEED_AUTO_SERVICE_REQUEST_USER_ID / org members)'
        );
        return { inserted: false, skipped: 'no_valid_user_id' };
    }
    const note = buildFeedServiceRequestNote({
        source: 'max_auto',
        serviceRequested: 'site_documentation',
        ticketOrganizationId: orgId,
        ticketNumber,
        ticketRevision: nextRev || undefined,
        userNote: '',
    });

    try {
        const result = await runDb(
            db,
            `INSERT INTO service_requests
             (organization_id, user_id, user_name, user_email, service_type, note, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [orgId, userId, orgName, '', 'site_documentation', note, 'incomplete']
        );
        return {
            inserted: true,
            id: result && result.lastID != null ? Number(result.lastID) : undefined,
        };
    } catch (err) {
        console.error('syncMaxTierServiceRequest insert failed:', err);
        return { inserted: false, skipped: 'insert_error' };
    }
}

/**
 * Prefer env/default user id 3; fall back to an org member so FK never fails silently.
 * @returns {Promise<number|null>}
 */
async function resolveAutoServiceRequestUserId(db, orgId, ticket) {
    const preferred = envAutoUserId();
    const preferredRow = await getRow(db, 'SELECT id FROM users WHERE id = ?', [preferred]);
    if (preferredRow && preferredRow.id != null) {
        return Number(preferredRow.id);
    }

    const member = await getRow(
        db,
        `SELECT user_id FROM user_organizations
         WHERE organization_id = ?
         ORDER BY user_id ASC
         LIMIT 1`,
        [orgId]
    );
    if (member && member.user_id != null && Number.isFinite(Number(member.user_id))) {
        console.warn(
            'syncMaxTierServiceRequest: preferred user',
            preferred,
            'missing; using org member',
            member.user_id
        );
        return Number(member.user_id);
    }

    const ticketUser =
        ticket && ticket.userId != null
            ? Number(ticket.userId)
            : ticket && ticket.user_id != null
              ? Number(ticket.user_id)
              : NaN;
    if (Number.isFinite(ticketUser) && ticketUser > 0) {
        const tu = await getRow(db, 'SELECT id FROM users WHERE id = ?', [ticketUser]);
        if (tu && tu.id != null) {
            console.warn(
                'syncMaxTierServiceRequest: preferred user',
                preferred,
                'missing; using ticket user',
                ticketUser
            );
            return ticketUser;
        }
    }

    return null;
}

module.exports = {
    syncMaxTierServiceRequest,
    envAutoUserId,
    resolveAutoServiceRequestUserId,
};
