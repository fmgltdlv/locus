import { getDatabase } from '../../database.js';
import { canMutateOrganization, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import {
    assertOwnerOrgTicketWriteAllowed,
    parseViewerOrganizationId,
} from '../../lib/partnerTicketAccess.js';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { assertNotTechWrite, TICKET_ROW_SELECT, buildTicketListSummaryFromRow, loadOperatorResponsesMapForTicketIds, loadTicketRowMapForTicketIds, loadWorkflowAckContextForOrg, workflowStatusOptionsFromContext } from '../ticketRowHelpers.js';
import { computeWorkflowStatusForTicket } from '../computeWorkflowStatus.js';
import { assertOrgDataDeleteAllowed } from '../../lib/orgDataPermissions.js';
import type { TicketsApp } from './types.js';
import {
    computeJobComplianceAttentionRequired,
    mapJobComplianceRow,
    normalizeJobNameKey,
} from '../../lib/jobComplianceDates.cjs';
import {
    JOB_PROJECT_STATUS_CLOSED,
    JOB_PROJECT_STATUS_OPEN,
    closedAtRangeSqlPredicate,
    calendarDateInInclusiveRange,
    mapProjectStatusFields,
    maxActivityTimestamp,
    parseClosedProjectDateRange,
} from '../../lib/jobProjectLifecycle.cjs';
import {
    countEffectiveTicketsForProject,
    listEffectiveTicketRowsForProject,
    addProjectTicketMembership,
    excludeProjectTicketMembership,
    removeProjectTicketMembership,
    resolveMembershipSource,
    searchTicketCandidatesForProject,
    listProjectTicketCountsForOrg,
    buildEffectiveProjectMembershipMaps,
    isTicketEffectivelyInProject,
    ticketAutoMatchesJobKey,
} from '../../lib/jobProjectMembership.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import {
    enableShareLink,
    allocateUniquePublicId,
    getActiveShareLinkRow,
    getProjectPublicId,
    normalizeProjectPublicId,
    revokeShareLinkForProject,
    sharePathForPublicId,
} from '../../lib/jobProjectShareLink.cjs';
import {
    listProjectAssignees,
    listAssigneesByProjectForOrg,
    isUserAssignedToProject,
    listAssignedOpenProjectKeysForUser,
    replaceProjectAssignees,
    assertUserIdsAreOrgMembers,
} from '../../lib/jobProjectAssignees.cjs';

const JOB_COMPLIANCE_NOTES_MAX = 4000;
const JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX = 200;
const JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX = 2000;
const JOB_COMPLIANCE_CUSTOM_ITEMS_MAX = 50;

/** Ticket workflow statuses that elevate a project to "Needs attention". */
const PROJECT_TICKET_ATTENTION_STATUSES = new Set(['NOT_READY', 'ACTION_REQUIRED', 'EXPIRING_SOON']);

function ticketWorkflowStatusNeedsProjectAttention(status) {
    if (status == null) return false;
    const s = String(status).trim().toUpperCase().replace(/\s+/g, '_');
    if (s === 'REVIEW_REQUIRED') return true;
    return PROJECT_TICKET_ATTENTION_STATUSES.has(s);
}

function projectTicketsNeedAttention(tickets) {
    return (tickets || []).some((t) =>
        ticketWorkflowStatusNeedsProjectAttention(
            t.workflowStatus || t.computedWorkflowStatus || t.status
        )
    );
}

function computeProjectAttentionRequired(compliance, tickets) {
    return (
        computeJobComplianceAttentionRequired(compliance) || projectTicketsNeedAttention(tickets)
    );
}

function normalizeComplianceDateInput(dateStr) {
    if (dateStr == null) return null;
    const d = String(dateStr).trim();
    if (!d) return null;
    if (/^n\/a$/i.test(d)) return 'N/A';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const parsed = new Date(`${d}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    return d;
}

function parseJobComplianceCustomItems(raw) {
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

const JOB_COMPLIANCE_ROW_SELECT = `id, organization_id, job_name_normalized, job_name_display, public_id,
                permit_expiration, traffic_control_permit_expiration,
                third_party_inspection_date, third_party_inspection_notes,
                general_notes, custom_items_json, updated_at, updated_by_display_name,
                status, closed_at, closed_by_user_id, closed_by_display_name`;

async function fetchJobComplianceRow(db, orgId, jobNameKey) {
    return getRow(
        db,
        `SELECT ${JOB_COMPLIANCE_ROW_SELECT}
         FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, jobNameKey]
    );
}

async function getUserDisplayName(db, userId) {
    const userRow = await getRow(db, 'SELECT full_name, username, email FROM users WHERE id = ?', [userId]);
    return (
        (userRow && userRow.full_name && String(userRow.full_name).trim()) ||
        (userRow && userRow.username) ||
        (userRow && userRow.email) ||
        ''
    );
}

async function resolveJobNameDisplay(db, orgId, jobNameKey, complianceRow) {
    let displayName =
        complianceRow && complianceRow.job_name_display != null
            ? String(complianceRow.job_name_display).trim()
            : '';
    if (!displayName) {
        const refRow = await getRow(
            db,
            `SELECT user_reference FROM tickets
             WHERE organization_id = ? AND LOWER(TRIM(user_reference)) = ?
             LIMIT 1`,
            [orgId, jobNameKey]
        );
        displayName =
            refRow && refRow.user_reference != null
                ? String(refRow.user_reference).trim()
                : jobNameKey;
    }
    return displayName || jobNameKey;
}

async function getClosedJobNameKeysForOrg(db, orgId) {
    const rows = await allRows(
        db,
        `SELECT job_name_normalized FROM job_misc_compliance
         WHERE organization_id = ? AND status = ?`,
        [orgId, JOB_PROJECT_STATUS_CLOSED]
    );
    const keys = new Set();
    for (const row of rows || []) {
        const key = row.job_name_normalized != null ? String(row.job_name_normalized).trim() : '';
        if (key) keys.add(key);
    }
    return keys;
}

async function assertOrgMemberCanManageProjectAssignees(req, db, orgId, res) {
    if (!orgId) {
        res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        return false;
    }
    if (!canMutateOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'You do not have access to that organization' });
        return false;
    }
    if (req.user.role === 'dev') return true;
    const role = await getMembershipRole(db, req.user.id, orgId);
    if (isTechMembership(role)) {
        res.status(403).json({ error: 'Tech users cannot change project assignees.' });
        return false;
    }
    return true;
}

async function assertOrgAdminForProjectAction(req, db, orgId, res) {
    if (!orgId) {
        res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        return false;
    }
    if (!canMutateOrganization(req.user, orgId)) {
        res.status(403).json({ error: 'You do not have access to that organization' });
        return false;
    }
    const membershipRole = req.user.role === 'dev' ? null : await getMembershipRole(db, req.user.id, orgId);
    const isOrgAdmin =
        req.user.role === 'dev' ||
        membershipRole === 'admin' ||
        (req.user.adminOrganizationIds && req.user.adminOrganizationIds.includes(orgId));
    if (!isOrgAdmin) {
        res.status(403).json({ error: 'Only organization admins can perform this action.' });
        return false;
    }
    return true;
}

async function mapTicketRowsToSummaries(db, orgId, jobNameKey, rows) {
    if (!rows || rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [operatorMap, workflowCtx] = await Promise.all([
        loadOperatorResponsesMapForTicketIds(db, ids),
        loadWorkflowAckContextForOrg(db, orgId),
    ]);
    const ackMap = workflowCtx.ackMap;
    const workflowOpts = workflowStatusOptionsFromContext(workflowCtx);
    const summaries = [];
    for (const r of rows) {
        const tid = r.id != null ? Number(r.id) : NaN;
        const ticket = buildTicketListSummaryFromRow(orgId, r, {
            operatorResponses: Number.isFinite(tid) ? operatorMap.get(tid) || [] : [],
        });
        const workflowStatus = computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts);
        const membershipSource = await resolveMembershipSource(db, orgId, jobNameKey, r, tid);
        summaries.push({
            id: r.id,
            ticketNumber: r.ticket_number != null ? String(r.ticket_number).trim() : '',
            address: r.address != null ? String(r.address).trim() : '',
            workDescription: r.work_description != null ? String(r.work_description).trim() : '',
            expiresAt: r.ticket_expires_at || null,
            workflowStatus,
            computedWorkflowStatus: workflowStatus,
            status: workflowStatus,
            expiringSoonDays: workflowOpts.expiringSoonDays,
            membershipSource: membershipSource || 'auto',
        });
    }
    return summaries;
}

async function listTicketSummariesForJobName(db, orgId, jobNameKey) {
    const rows = await listEffectiveTicketRowsForProject(db, orgId, jobNameKey);
    return mapTicketRowsToSummaries(db, orgId, jobNameKey, rows);
}

async function listTicketNumbersForJobName(db, orgId, jobNameKey) {
    const rows = await listTicketSummariesForJobName(db, orgId, jobNameKey);
    return rows.map((r) => r.ticketNumber).filter(Boolean);
}

async function buildTicketAttentionByJobKeyForOrg(db, orgId, excludeKeys, opts) {
    const closedKeys = excludeKeys instanceof Set ? excludeKeys : new Set();
    const options = opts || {};
    const attentionByKey = new Map();
    const maps =
        options.membershipMaps || (await buildEffectiveProjectMembershipMaps(db, orgId));
    const { projectsByTicket } = maps;
    if (!projectsByTicket || projectsByTicket.size === 0) return attentionByKey;

    const ticketIds = Array.from(projectsByTicket.keys());
    const [ticketRowById, operatorMap, workflowCtx] = await Promise.all([
        loadTicketRowMapForTicketIds(db, orgId, ticketIds),
        loadOperatorResponsesMapForTicketIds(db, ticketIds),
        loadWorkflowAckContextForOrg(db, orgId),
    ]);
    const ackMap = workflowCtx.ackMap;
    const workflowOpts = workflowStatusOptionsFromContext(workflowCtx);

    for (const tid of ticketIds) {
        const row = ticketRowById.get(tid);
        if (!row) continue;
        const projectKeys = projectsByTicket.get(tid);
        if (!projectKeys || projectKeys.size === 0) continue;
        const ticket = buildTicketListSummaryFromRow(orgId, row, {
            operatorResponses: operatorMap.get(tid) || [],
        });
        const workflowStatus = computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts);
        if (!ticketWorkflowStatusNeedsProjectAttention(workflowStatus)) continue;
        for (const key of projectKeys) {
            if (!closedKeys.has(key)) attentionByKey.set(key, true);
        }
    }
    return attentionByKey;
}

function listTicketAggForOrg(projectCounts, excludeKeys) {
    const closedKeys = excludeKeys instanceof Set ? excludeKeys : new Set();
    return (projectCounts || [])
        .filter((p) => {
            const key = p.jobNameKey != null ? String(p.jobNameKey).trim() : '';
            return key && !closedKeys.has(key);
        })
        .map((p) => ({
            job_name_key: p.jobNameKey,
            job_name_display: p.jobName,
            ticket_count: p.ticketCount,
        }));
}

async function getTicketLastActivityByJobKeyForOrg(db, orgId, excludeKeys) {
    const closedKeys = excludeKeys instanceof Set ? excludeKeys : new Set();
    let sql = `SELECT LOWER(TRIM(user_reference)) AS job_name_key,
                MAX(COALESCE(
                    NULLIF(TRIM(ngen_last_updated_time), ''),
                    updated_at,
                    created_at
                )) AS last_activity
         FROM tickets
         WHERE organization_id = ?
           AND user_reference IS NOT NULL
           AND TRIM(user_reference) != ''`;
    const params = [orgId];
    if (closedKeys.size > 0) {
        const placeholders = Array.from(closedKeys)
            .map(() => '?')
            .join(', ');
        sql += ` AND LOWER(TRIM(user_reference)) NOT IN (${placeholders})`;
        params.push(...Array.from(closedKeys));
    }
    sql += ' GROUP BY LOWER(TRIM(user_reference))';
    const rows = await allRows(db, sql, params);
    const map = new Map();
    for (const row of rows || []) {
        const key = row.job_name_key != null ? String(row.job_name_key).trim() : '';
        if (!key) continue;
        map.set(key, row.last_activity != null ? String(row.last_activity) : null);
    }
    return map;
}

function filterOpenProjectsByActivityRange(projects, complianceRowByKey, ticketActivityByKey, fromYmd, toYmd) {
    return (projects || []).filter((project) => {
        const key = project && project.jobNameKey != null ? String(project.jobNameKey).trim() : '';
        if (!key) return false;
        const complianceRow = complianceRowByKey.get(key);
        const activity = maxActivityTimestamp(
            complianceRow && complianceRow.updated_at,
            complianceRow && complianceRow.created_at,
            ticketActivityByKey.get(key)
        );
        return calendarDateInInclusiveRange(activity, fromYmd, toYmd);
    });
}

async function listJobProjectsForOrg(db, orgId, options) {
    const opts = options || {};
    const listStatus =
        opts.status === JOB_PROJECT_STATUS_CLOSED ? JOB_PROJECT_STATUS_CLOSED : JOB_PROJECT_STATUS_OPEN;

    if (listStatus === JOB_PROJECT_STATUS_CLOSED) {
        const range = parseClosedProjectDateRange(opts.closedFrom, opts.closedTo);
        if (range.ok === false) {
            return { ok: false, status: 400, error: range.error };
        }
        const [complianceRows, membershipMaps] = await Promise.all([
            allRows(
                db,
                `SELECT job_name_normalized, job_name_display, status, closed_at, closed_by_display_name
                 FROM job_misc_compliance
                 WHERE organization_id = ?
                   AND status = ?
                   AND ${closedAtRangeSqlPredicate()}
                 ORDER BY closed_at DESC, job_name_display COLLATE NOCASE ASC`,
                [orgId, JOB_PROJECT_STATUS_CLOSED, range.from, range.to]
            ),
            buildEffectiveProjectMembershipMaps(db, orgId),
        ]);
        const { ticketsByProject } = membershipMaps;
        const projects = [];
        for (const row of complianceRows || []) {
            const key = row.job_name_normalized != null ? String(row.job_name_normalized).trim() : '';
            if (!key) continue;
            const ticketSet = ticketsByProject.get(key);
            const count = ticketSet ? ticketSet.size : 0;
            const statusFields = mapProjectStatusFields(row);
            projects.push({
                jobNameKey: key,
                jobName: row.job_name_display != null ? String(row.job_name_display).trim() : key,
                ticketCount: count,
                attentionRequired: false,
                isRegisteredProject: true,
                ...statusFields,
            });
        }
        return { ok: true, projects };
    }

    const [closedKeys, complianceRows, membershipMaps] = await Promise.all([
        getClosedJobNameKeysForOrg(db, orgId),
        allRows(
            db,
            `SELECT job_name_normalized, job_name_display,
                    permit_expiration, traffic_control_permit_expiration,
                    third_party_inspection_date, third_party_inspection_notes,
                    general_notes, custom_items_json, updated_at, created_at,
                    status, closed_at, closed_by_display_name
             FROM job_misc_compliance
             WHERE organization_id = ?
               AND (status IS NULL OR status != ?)
             ORDER BY job_name_display COLLATE NOCASE ASC`,
            [orgId, JOB_PROJECT_STATUS_CLOSED]
        ),
        buildEffectiveProjectMembershipMaps(db, orgId),
    ]);
    const complianceRowByKey = new Map();
    for (const row of complianceRows || []) {
        const key = row.job_name_normalized != null ? String(row.job_name_normalized).trim() : '';
        if (key) complianceRowByKey.set(key, row);
    }
    const [projectCounts, ticketAttentionByKey] = await Promise.all([
        listProjectTicketCountsForOrg(db, orgId, { membershipMaps }),
        buildTicketAttentionByJobKeyForOrg(db, orgId, closedKeys, { membershipMaps }),
    ]);
    const ticketAgg = listTicketAggForOrg(projectCounts, closedKeys);
    const byKey = new Map();
    for (const row of complianceRows || []) {
        const key = row.job_name_normalized != null ? String(row.job_name_normalized).trim() : '';
        if (!key) continue;
        const compliance = mapJobComplianceRow(row);
        const statusFields = mapProjectStatusFields(row);
        byKey.set(key, {
            jobNameKey: key,
            jobName: row.job_name_display != null ? String(row.job_name_display).trim() : key,
            ticketCount: 0,
            attentionRequired:
                computeProjectAttentionRequired(compliance, []) ||
                ticketAttentionByKey.get(key) === true,
            isRegisteredProject: true,
            ...statusFields,
        });
    }
    for (const row of ticketAgg || []) {
        const key = row.job_name_key != null ? String(row.job_name_key).trim() : '';
        if (!key || closedKeys.has(key)) continue;
        const display =
            row.job_name_display != null ? String(row.job_name_display).trim() : key;
        const count = Number(row.ticket_count) || 0;
        const ticketsNeedAttention = ticketAttentionByKey.get(key) === true;
        const existing = byKey.get(key);
        if (existing) {
            existing.ticketCount = count;
            existing.jobName = display || existing.jobName;
            if (ticketsNeedAttention) existing.attentionRequired = true;
        } else {
            byKey.set(key, {
                jobNameKey: key,
                jobName: display,
                ticketCount: count,
                attentionRequired:
                    computeProjectAttentionRequired(null, []) || ticketsNeedAttention,
                isRegisteredProject: false,
                status: JOB_PROJECT_STATUS_OPEN,
                closedAt: null,
                closedByDisplayName: null,
            });
        }
    }
    let projects = Array.from(byKey.values()).sort((a, b) =>
        a.jobName.localeCompare(b.jobName, undefined, { sensitivity: 'base' })
    );

    const fromRaw = opts.activityFrom != null ? opts.activityFrom : opts.from;
    const toRaw = opts.activityTo != null ? opts.activityTo : opts.to;
    if (fromRaw != null && String(fromRaw).trim() !== '' && toRaw != null && String(toRaw).trim() !== '') {
        const range = parseClosedProjectDateRange(fromRaw, toRaw);
        if (range.ok === false) {
            return { ok: false, status: 400, error: range.error };
        }
        const ticketActivityByKey = await getTicketLastActivityByJobKeyForOrg(db, orgId, closedKeys);
        projects = filterOpenProjectsByActivityRange(
            projects,
            complianceRowByKey,
            ticketActivityByKey,
            range.from,
            range.to
        );
    }

    return {
        ok: true,
        projects,
    };
}

async function setJobProjectStatus(db, orgId, userId, jobNameKey, nextStatus) {
    const status =
        nextStatus === JOB_PROJECT_STATUS_CLOSED ? JOB_PROJECT_STATUS_CLOSED : JOB_PROJECT_STATUS_OPEN;
    const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
    const ticketCount = await countEffectiveTicketsForProject(db, orgId, jobNameKey);
    if (!complianceRow && ticketCount === 0 && status === JOB_PROJECT_STATUS_CLOSED) {
        return { ok: false, status: 404, error: 'Project not found' };
    }
    if (!complianceRow && ticketCount === 0 && status === JOB_PROJECT_STATUS_OPEN) {
        return { ok: false, status: 404, error: 'Project not found' };
    }

    const displayName = await resolveJobNameDisplay(db, orgId, jobNameKey, complianceRow);
    const displayNameForClose = displayName;

    if (status === JOB_PROJECT_STATUS_CLOSED) {
        const closerName = await getUserDisplayName(db, userId);
        if (complianceRow) {
            await runDb(
                db,
                `UPDATE job_misc_compliance
                 SET status = ?,
                     closed_at = CURRENT_TIMESTAMP,
                     closed_by_user_id = ?,
                     closed_by_display_name = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE organization_id = ? AND job_name_normalized = ?`,
                [JOB_PROJECT_STATUS_CLOSED, userId, closerName || null, orgId, jobNameKey]
            );
        } else {
            const publicId = await allocateUniquePublicId(db);
            await runDb(
                db,
                `INSERT INTO job_misc_compliance (
                     organization_id, job_name_normalized, job_name_display,
                     custom_items_json, public_id, status, closed_at,
                     closed_by_user_id, closed_by_display_name,
                     created_at, updated_at
                 ) VALUES (?, ?, ?, '[]', ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    orgId,
                    jobNameKey,
                    displayNameForClose,
                    publicId,
                    JOB_PROJECT_STATUS_CLOSED,
                    userId,
                    closerName || null,
                ]
            );
        }
    } else if (complianceRow) {
        await runDb(
            db,
            `UPDATE job_misc_compliance
             SET status = ?,
                 closed_at = NULL,
                 closed_by_user_id = NULL,
                 closed_by_display_name = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE organization_id = ? AND job_name_normalized = ?`,
            [JOB_PROJECT_STATUS_OPEN, orgId, jobNameKey]
        );
    }

    const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
    return { ok: true, ...detail };
}

async function saveJobComplianceForKey(db, orgId, userId, jobNameKey, jobNameDisplay, body) {
    const permitExpiration = normalizeComplianceDateInput(body.permitExpiration);
    if (body.permitExpiration != null && String(body.permitExpiration).trim() && !permitExpiration) {
        return { ok: false, status: 400, error: 'permitExpiration must use YYYY-MM-DD format or N/A' };
    }
    const trafficControlPermitExpiration = normalizeComplianceDateInput(body.trafficControlPermitExpiration);
    if (
        body.trafficControlPermitExpiration != null &&
        String(body.trafficControlPermitExpiration).trim() &&
        !trafficControlPermitExpiration
    ) {
        return { ok: false, status: 400, error: 'trafficControlPermitExpiration must use YYYY-MM-DD format or N/A' };
    }
    const thirdPartyInspectionDate = normalizeComplianceDateInput(body.thirdPartyInspectionDate);
    if (
        body.thirdPartyInspectionDate != null &&
        String(body.thirdPartyInspectionDate).trim() &&
        !thirdPartyInspectionDate
    ) {
        return { ok: false, status: 400, error: 'thirdPartyInspectionDate must use YYYY-MM-DD format or N/A' };
    }
    const thirdPartyInspectionNotes =
        body.thirdPartyInspectionNotes != null ? String(body.thirdPartyInspectionNotes).trim() : '';
    if (thirdPartyInspectionNotes.length > JOB_COMPLIANCE_NOTES_MAX) {
        return {
            ok: false,
            status: 400,
            error: `thirdPartyInspectionNotes must be at most ${JOB_COMPLIANCE_NOTES_MAX} characters`,
        };
    }
    const generalNotes = body.generalNotes != null ? String(body.generalNotes).trim() : '';
    if (generalNotes.length > JOB_COMPLIANCE_NOTES_MAX) {
        return {
            ok: false,
            status: 400,
            error: `generalNotes must be at most ${JOB_COMPLIANCE_NOTES_MAX} characters`,
        };
    }
    const customParsed = parseJobComplianceCustomItems(body.customItems);
    if (!customParsed.ok) {
        return { ok: false, status: 400, error: customParsed.error };
    }
    const userRow = await getRow(db, 'SELECT full_name, username, email FROM users WHERE id = ?', [userId]);
    const displayName =
        (userRow && userRow.full_name && String(userRow.full_name).trim()) ||
        (userRow && userRow.username) ||
        (userRow && userRow.email) ||
        '';
    const customItemsJson = JSON.stringify(customParsed.items);
    const existing = await fetchJobComplianceRow(db, orgId, jobNameKey);
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
                jobNameDisplay,
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
                jobNameDisplay,
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
    const tickets = await listTicketSummariesForJobName(db, orgId, jobNameKey);
    const linkedTicketNumbers = tickets.map((r) => r.ticketNumber).filter(Boolean);
    return {
        ok: true,
        jobName: jobNameDisplay,
        jobNameKey,
        linkedTicketNumbers,
        compliance,
        attentionRequired: computeProjectAttentionRequired(compliance, tickets),
    };
}

async function buildJobProjectDetail(db, orgId, jobNameKey) {
    const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
    const [tickets, assignees] = await Promise.all([
        listTicketSummariesForJobName(db, orgId, jobNameKey),
        listProjectAssignees(db, orgId, jobNameKey),
    ]);
    const displayName = await resolveJobNameDisplay(db, orgId, jobNameKey, complianceRow);
    const compliance = mapJobComplianceRow(complianceRow);
    const statusFields = mapProjectStatusFields(complianceRow);
    const publicId =
        normalizeProjectPublicId(complianceRow && complianceRow.public_id) ||
        (await getProjectPublicId(db, orgId, jobNameKey));
    return {
        jobName: displayName,
        jobNameKey,
        publicId: publicId || null,
        tickets,
        ticketCount: tickets.length,
        assignees,
        assigneeCount: assignees.length,
        compliance,
        attentionRequired: computeProjectAttentionRequired(compliance, tickets),
        isRegisteredProject: !!complianceRow,
        ...statusFields,
    };
}

async function assertTechCanAccessProject(req, db, orgId, jobNameKey, res) {
    if (req.user.role === 'dev') return true;
    const role = await getMembershipRole(db, req.user.id, orgId);
    if (!isTechMembership(role)) return true;
    const assigned = await isUserAssignedToProject(db, orgId, jobNameKey, req.user.id);
    if (!assigned) {
        res.status(403).json({ error: 'Tech users can only access projects they are assigned to.' });
        return false;
    }
    const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
    const status =
        complianceRow && complianceRow.status != null
            ? String(complianceRow.status).trim().toLowerCase()
            : JOB_PROJECT_STATUS_OPEN;
    if (status === JOB_PROJECT_STATUS_CLOSED) {
        res.status(403).json({ error: 'Tech users cannot access closed projects.' });
        return false;
    }
    return true;
}

function parseOrgIdFromRequest(req) {
    const raw =
        req.query.organizationId != null
            ? req.query.organizationId
            : req.body && req.body.organizationId != null
              ? req.body.organizationId
              : req.user.organizationId;
    const orgId = raw != null ? parseInt(String(raw), 10) : null;
    return Number.isFinite(orgId) ? orgId : null;
}

export function registerJobProjectRoutes(tickets: TicketsApp) {
    tickets.get('/job-projects', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        try {
            const statusRaw =
                req.query.status != null ? String(req.query.status).trim().toLowerCase() : JOB_PROJECT_STATUS_OPEN;
            const result = await listJobProjectsForOrg(db, orgId, {
                status: statusRaw,
                from: req.query.from,
                to: req.query.to,
                closedFrom: req.query.from,
                closedTo: req.query.to,
                activityFrom: req.query.from,
                activityTo: req.query.to,
            });
            if (!result.ok) {
                return res.status(result.status).json({ error: result.error });
            }
            let projects = result.projects;
            if (req.user.role !== 'dev') {
                const role = await getMembershipRole(db, req.user.id, orgId);
                if (isTechMembership(role)) {
                    // Tech: open projects they are assigned to only (closed list always empty for tech).
                    if (statusRaw === JOB_PROJECT_STATUS_CLOSED) {
                        projects = [];
                    } else {
                        const assignedKeys = await listAssignedOpenProjectKeysForUser(
                            db,
                            orgId,
                            req.user.id
                        );
                        projects = (projects || []).filter(
                            (p) => p && p.jobNameKey && assignedKeys.has(String(p.jobNameKey).trim().toLowerCase())
                        );
                    }
                }
            }
            res.json({ projects });
        } catch (e) {
            console.error('GET /tickets/job-projects:', e);
            res.status(500).json({ error: 'Failed to load projects' });
        }
    });

    tickets.post('/job-projects', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!canMutateOrganization(req.user, orgId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
        const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
        if (writeAccess.allowed === false) {
            return res.status(writeAccess.status).json({ error: writeAccess.error });
        }
        if (!(await assertNotTechWrite(req, res, orgId))) return;
        const jobNameRaw = req.body && req.body.jobName != null ? String(req.body.jobName).trim() : '';
        if (!jobNameRaw) {
            return res.status(400).json({ error: 'jobName is required' });
        }
        const jobNameKey = normalizeJobNameKey(jobNameRaw);
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobName is required' });
        }
        try {
            const existing = await fetchJobComplianceRow(db, orgId, jobNameKey);
            if (existing) {
                const existingStatus =
                    existing.status != null
                        ? String(existing.status).trim().toLowerCase()
                        : JOB_PROJECT_STATUS_OPEN;
                if (existingStatus === JOB_PROJECT_STATUS_CLOSED) {
                    return res.status(409).json({
                        error: 'A closed project with this job name already exists.',
                        code: 'CLOSED_PROJECT_EXISTS',
                        jobNameKey,
                    });
                }
                return res.status(409).json({ error: 'A project with this job name already exists.' });
            }
            const ticketCountRows = await getRow(
                db,
                `SELECT COUNT(*) AS c FROM tickets
                 WHERE organization_id = ? AND LOWER(TRIM(user_reference)) = ?`,
                [orgId, jobNameKey]
            );
            const ticketCount = ticketCountRows && ticketCountRows.c != null ? Number(ticketCountRows.c) : 0;
            if (ticketCount > 0) {
                return res.status(409).json({
                    error: 'Tickets already use this job name. Select the existing project instead.',
                });
            }
            await runDb(
                db,
                `INSERT INTO job_misc_compliance (
                     organization_id, job_name_normalized, job_name_display,
                     custom_items_json, public_id, created_at, updated_at
                 ) VALUES (?, ?, ?, '[]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [orgId, jobNameKey, jobNameRaw, await allocateUniquePublicId(db)]
            );
            const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
            res.status(201).json(detail);
        } catch (e) {
            console.error('POST /tickets/job-projects:', e);
            res.status(500).json({ error: 'Failed to create project' });
        }
    });

    tickets.get('/job-projects/analytics/top-projects', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        try {
            const projects = await listProjectTicketCountsForOrg(db, orgId);
            res.json({ projects });
        } catch (e) {
            console.error('GET /tickets/job-projects/analytics/top-projects:', e);
            res.status(500).json({ error: 'Failed to load project analytics' });
        }
    });

    /**
     * Compact open-project assignment index for hub/map "Assigned to me" filters.
     * Closed projects are omitted. Tech receives the full open index (client still gates display).
     */
    tickets.get('/job-projects/assignment-index', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        try {
            const [closedKeys, membershipMaps, assigneesByProject] = await Promise.all([
                getClosedJobNameKeysForOrg(db, orgId),
                buildEffectiveProjectMembershipMaps(db, orgId),
                listAssigneesByProjectForOrg(db, orgId),
            ]);
            const closedLower = new Set();
            for (const k of closedKeys || []) {
                const ck = k != null ? String(k).trim().toLowerCase() : '';
                if (ck) closedLower.add(ck);
            }
            const { ticketsByProject } = membershipMaps;
            const projects = [];
            for (const [rawKey, ticketSet] of ticketsByProject || []) {
                const jobNameKey = rawKey != null ? String(rawKey).trim().toLowerCase() : '';
                if (!jobNameKey || closedLower.has(jobNameKey)) {
                    continue;
                }
                const ticketIds = [];
                if (ticketSet) {
                    for (const tid of ticketSet) {
                        const n = Number(tid);
                        if (Number.isFinite(n)) ticketIds.push(n);
                    }
                }
                ticketIds.sort((a, b) => a - b);
                const assignees = assigneesByProject.get(jobNameKey) || [];
                projects.push({
                    jobNameKey,
                    assignees,
                    ticketIds,
                });
            }
            projects.sort((a, b) =>
                String(a.jobNameKey).localeCompare(String(b.jobNameKey), undefined, {
                    sensitivity: 'base',
                })
            );
            res.json({ projects });
        } catch (e) {
            console.error('GET /tickets/job-projects/assignment-index:', e);
            res.status(500).json({ error: 'Failed to load assignment index' });
        }
    });

    tickets.get('/job-projects/:jobNameKey', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (!(await assertTechCanAccessProject(req, db, orgId, jobNameKey, res))) return;
        try {
            const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
            const hasProject =
                detail.isRegisteredProject || (detail.tickets && detail.tickets.length > 0);
            if (!hasProject) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json(detail);
        } catch (e) {
            console.error('GET /tickets/job-projects/:jobNameKey:', e);
            res.status(500).json({ error: 'Failed to load project' });
        }
    });

    tickets.get('/job-projects/:jobNameKey/assignees', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (!(await assertTechCanAccessProject(req, db, orgId, jobNameKey, res))) return;
        try {
            const assignees = await listProjectAssignees(db, orgId, jobNameKey);
            res.json({ jobNameKey, assignees, assigneeCount: assignees.length });
        } catch (e) {
            console.error('GET /tickets/job-projects/:jobNameKey/assignees:', e);
            res.status(500).json({ error: 'Failed to load project assignees' });
        }
    });

    tickets.put('/job-projects/:jobNameKey/assignees', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
        if (!canMutateOrganization(req.user, orgId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
        const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
        if (writeAccess.allowed === false) {
            return res.status(writeAccess.status).json({ error: writeAccess.error });
        }
        if (!(await assertOrgMemberCanManageProjectAssignees(req, db, orgId, res))) return;
        const body = req.body || {};
        let userIds = [];
        if (Array.isArray(body.userIds)) {
            userIds = body.userIds;
        } else if (Array.isArray(body.assignees)) {
            userIds = body.assignees.map((a) => (a && a.userId != null ? a.userId : a));
        } else {
            return res.status(400).json({ error: 'userIds (array) is required' });
        }
        try {
            const memberCheck = await assertUserIdsAreOrgMembers(db, orgId, userIds);
            if (memberCheck.ok === false) {
                return res.status(memberCheck.status).json({ error: memberCheck.error });
            }
            const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
            const hasTickets = (await countEffectiveTicketsForProject(db, orgId, jobNameKey)) > 0;
            if (!complianceRow && !hasTickets) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const assignees = await replaceProjectAssignees(db, orgId, jobNameKey, userIds, userId);
            res.json({ jobNameKey, assignees, assigneeCount: assignees.length });
        } catch (e) {
            console.error('PUT /tickets/job-projects/:jobNameKey/assignees:', e);
            res.status(500).json({ error: 'Failed to update project assignees' });
        }
    });

    tickets.put('/job-projects/:jobNameKey/status', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
        if (!canMutateOrganization(req.user, orgId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
        const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
        if (writeAccess.allowed === false) {
            return res.status(writeAccess.status).json({ error: writeAccess.error });
        }
        if (!(await assertNotTechWrite(req, res, orgId))) return;
        const nextStatus =
            req.body && req.body.status != null ? String(req.body.status).trim().toLowerCase() : '';
        if (nextStatus !== JOB_PROJECT_STATUS_OPEN && nextStatus !== JOB_PROJECT_STATUS_CLOSED) {
            return res.status(400).json({ error: 'status must be "open" or "closed"' });
        }
        try {
            const saved = await setJobProjectStatus(db, orgId, userId, jobNameKey, nextStatus);
            if (saved.ok === false) {
                return res.status(Number(saved.status)).json({ error: saved.error });
            }
            res.json(saved);
        } catch (e) {
            console.error('PUT /tickets/job-projects/:jobNameKey/status:', e);
            res.status(500).json({ error: 'Failed to update project status' });
        }
    });

    tickets.get('/job-projects/:jobNameKey/compliance', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (!(await assertTechCanAccessProject(req, db, orgId, jobNameKey, res))) return;
        try {
            const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
            const linkedTicketNumbers = detail.tickets.map((t) => t.ticketNumber).filter(Boolean);
            res.json({
                jobName: detail.jobName,
                jobNameKey: detail.jobNameKey,
                linkedTicketNumbers,
                compliance: detail.compliance,
                attentionRequired: detail.attentionRequired,
            });
        } catch (e) {
            console.error('GET /tickets/job-projects/:jobNameKey/compliance:', e);
            res.status(500).json({ error: 'Failed to load compliance' });
        }
    });

    tickets.put('/job-projects/:jobNameKey/compliance', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) {
            return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (!jobNameKey) {
            return res.status(400).json({ error: 'jobNameKey is required' });
        }
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
            const complianceRow = await fetchJobComplianceRow(db, orgId, jobNameKey);
            const ticketRows = await listTicketSummariesForJobName(db, orgId, jobNameKey);
            let jobNameDisplay =
                complianceRow && complianceRow.job_name_display != null
                    ? String(complianceRow.job_name_display).trim()
                    : '';
            if (!jobNameDisplay && ticketRows.length > 0) {
                const refRow = await getRow(
                    db,
                    `SELECT user_reference FROM tickets
                     WHERE organization_id = ? AND LOWER(TRIM(user_reference)) = ?
                     LIMIT 1`,
                    [orgId, jobNameKey]
                );
                jobNameDisplay =
                    refRow && refRow.user_reference != null
                        ? String(refRow.user_reference).trim()
                        : jobNameKey;
            }
            if (!jobNameDisplay) {
                jobNameDisplay = jobNameKey;
            }
            if (!complianceRow && ticketRows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            const body = req.body || {};
            const saved = await saveJobComplianceForKey(
                db,
                orgId,
                userId,
                jobNameKey,
                jobNameDisplay,
                body
            );
            if (saved.ok === false) {
                return res.status(Number(saved.status)).json({ error: saved.error });
            }
            res.json(saved);
        } catch (e) {
            console.error('PUT /tickets/job-projects/:jobNameKey/compliance:', e);
            res.status(500).json({ error: 'Failed to save compliance' });
        }
    });

    tickets.post('/job-projects/:jobNameKey/tickets', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!canMutateOrganization(req.user, orgId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
        const writeAccess = await assertOwnerOrgTicketWriteAllowed(db, req.user, orgId, viewerOrgId);
        if (writeAccess.allowed === false) {
            return res.status(writeAccess.status).json({ error: writeAccess.error });
        }
        if (!(await assertNotTechWrite(req, res, orgId))) return;
        const ticketIdRaw = req.body && req.body.ticketId != null ? req.body.ticketId : null;
        const ticketId = ticketIdRaw != null ? parseInt(String(ticketIdRaw), 10) : NaN;
        if (!Number.isFinite(ticketId)) {
            return res.status(400).json({ error: 'ticketId is required' });
        }
        try {
            const ticketRow = await getRow(
                db,
                `SELECT id, organization_id, user_reference FROM tickets WHERE id = ? AND organization_id = ?`,
                [ticketId, orgId]
            );
            if (!ticketRow) return res.status(404).json({ error: 'Ticket not found' });
            if (await isTicketEffectivelyInProject(db, orgId, jobNameKey, ticketRow, ticketId)) {
                return res.status(409).json({ error: 'Ticket is already in this project' });
            }
            await addProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId);
            const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
            res.json(detail);
        } catch (e) {
            console.error('POST /tickets/job-projects/:jobNameKey/tickets:', e);
            res.status(500).json({ error: 'Failed to add ticket to project' });
        }
    });

    tickets.delete('/job-projects/:jobNameKey/tickets/:ticketId', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        const ticketId = parseInt(String(req.params.ticketId || ''), 10);
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'ticketId is required' });
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
            const ticketRow = await getRow(
                db,
                `SELECT id, organization_id, user_reference FROM tickets WHERE id = ? AND organization_id = ?`,
                [ticketId, orgId]
            );
            if (!ticketRow) return res.status(404).json({ error: 'Ticket not found' });
            const source = await resolveMembershipSource(db, orgId, jobNameKey, ticketRow, ticketId);
            if (mode === 'revert') {
                await removeProjectTicketMembership(db, orgId, jobNameKey, ticketId);
            } else if (source === 'manual_include') {
                await removeProjectTicketMembership(db, orgId, jobNameKey, ticketId);
            } else if (ticketAutoMatchesJobKey(ticketRow, jobNameKey)) {
                await excludeProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId);
            } else {
                return res.status(400).json({ error: 'Ticket is not in this project' });
            }
            const detail = await buildJobProjectDetail(db, orgId, jobNameKey);
            res.json(detail);
        } catch (e) {
            console.error('DELETE /tickets/job-projects/:jobNameKey/tickets/:ticketId:', e);
            res.status(500).json({ error: 'Failed to remove ticket from project' });
        }
    });

    tickets.get('/job-projects/:jobNameKey/ticket-candidates', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        try {
            const q = req.query.q != null ? String(req.query.q) : '';
            const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : 50;
            const rows = await searchTicketCandidatesForProject(db, orgId, jobNameKey, q, limit);
            res.json({
                tickets: (rows || []).map((r) => ({
                    id: r.id,
                    ticketNumber: r.ticket_number != null ? String(r.ticket_number).trim() : '',
                    address: r.address != null ? String(r.address).trim() : '',
                    jobName: r.user_reference != null ? String(r.user_reference).trim() : '',
                })),
            });
        } catch (e) {
            console.error('GET /tickets/job-projects/:jobNameKey/ticket-candidates:', e);
            res.status(500).json({ error: 'Failed to search tickets' });
        }
    });

    tickets.post('/job-projects/:jobNameKey/share-link', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const userId = req.user.id;
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!(await assertOrgAdminForProjectAction(req, db, orgId, res))) return;
        if (!(await assertNotTechWrite(req, res, orgId))) return;
        try {
            const ticketCount = await countEffectiveTicketsForProject(db, orgId, jobNameKey);
            if (ticketCount === 0) {
                return res.status(400).json({ error: 'Add at least one ticket before creating a share link' });
            }
            const displayName = await resolveJobNameDisplay(
                db,
                orgId,
                jobNameKey,
                await fetchJobComplianceRow(db, orgId, jobNameKey)
            );
            const label = req.body && req.body.label != null ? String(req.body.label) : undefined;
            const created = await enableShareLink(db, orgId, jobNameKey, userId, {
                displayName,
                label,
            });
            res.status(201).json(created);
        } catch (e) {
            console.error('POST /tickets/job-projects/:jobNameKey/share-link:', e);
            res.status(500).json({ error: 'Failed to create share link' });
        }
    });

    tickets.get('/job-projects/:jobNameKey/share-link', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!(await canViewOrganization(req.user, orgId))) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (req.user.role !== 'dev') {
            const role = await getMembershipRole(db, req.user.id, orgId);
            if (isTechMembership(role)) {
                return res.status(403).json({ error: 'Tech users cannot view project share links.' });
            }
        }
        try {
            const publicId = await getProjectPublicId(db, orgId, jobNameKey);
            const row = await getActiveShareLinkRow(db, orgId, jobNameKey);
            if (!row) {
                return res.json({
                    active: false,
                    publicId: publicId || null,
                    sharePath: publicId ? sharePathForPublicId(publicId) : null,
                });
            }
            const tokenId = normalizeProjectPublicId(row.token) || publicId;
            res.json({
                active: true,
                publicId: tokenId || null,
                sharePath: tokenId ? sharePathForPublicId(tokenId) : null,
                token: tokenId || row.token,
                label: row.label || null,
                createdAt: row.created_at || null,
                expiresAt: null,
            });
        } catch (e) {
            console.error('GET /tickets/job-projects/:jobNameKey/share-link:', e);
            res.status(500).json({ error: 'Failed to load share link' });
        }
    });

    tickets.delete('/job-projects/:jobNameKey/share-link', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes') as ResShim;
        const db = getDatabase();
        const orgId = parseOrgIdFromRequest(req);
        const jobNameKey = (req.params.jobNameKey || '').trim().toLowerCase();
        if (!orgId) return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        if (!jobNameKey) return res.status(400).json({ error: 'jobNameKey is required' });
        if (!(await assertOrgAdminForProjectAction(req, db, orgId, res))) return;
        try {
            await revokeShareLinkForProject(db, orgId, jobNameKey);
            res.json({ ok: true });
        } catch (e) {
            console.error('DELETE /tickets/job-projects/:jobNameKey/share-link:', e);
            res.status(500).json({ error: 'Failed to revoke share link' });
        }
    });
}
