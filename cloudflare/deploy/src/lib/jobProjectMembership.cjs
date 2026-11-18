/**
 * Effective project ticket membership: auto job-name match + manual include/exclude overrides.
 */
const { allRows, getRow, runDb } = require('./db.cjs');
const { normalizeJobNameKey } = require('./jobComplianceDates.cjs');

const MEMBERSHIP_INCLUDE = 'include';
const MEMBERSHIP_EXCLUDE = 'exclude';

const EFFECTIVE_MATCH_SQL = `
  (
    EXISTS (
      SELECT 1 FROM job_project_ticket_membership m
      WHERE m.organization_id = ?
        AND m.job_name_normalized = ?
        AND m.ticket_id = t.id
        AND m.membership = 'include'
    )
    OR (
      LOWER(TRIM(t.user_reference)) = ?
      AND NOT EXISTS (
        SELECT 1 FROM job_project_ticket_membership m
        WHERE m.organization_id = ?
          AND m.job_name_normalized = ?
          AND m.ticket_id = t.id
          AND m.membership = 'exclude'
      )
    )
  )
`;

const EFFECTIVE_TICKET_WHERE = `t.organization_id = ? AND ${EFFECTIVE_MATCH_SQL}`;

function ticketAutoMatchesJobKey(row, jobNameKey) {
    if (!row || !jobNameKey) return false;
    const key = normalizeJobNameKey(row.user_reference);
    return key === String(jobNameKey).trim().toLowerCase();
}

async function getMembershipRow(db, orgId, jobNameKey, ticketId) {
    return getRow(
        db,
        `SELECT membership FROM job_project_ticket_membership
         WHERE organization_id = ? AND job_name_normalized = ? AND ticket_id = ?`,
        [orgId, jobNameKey, ticketId]
    );
}

async function isTicketExcludedFromProject(db, orgId, jobNameKey, ticketId) {
    const row = await getMembershipRow(db, orgId, jobNameKey, ticketId);
    return !!(row && String(row.membership).trim() === MEMBERSHIP_EXCLUDE);
}

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {string} jobNameKey
 * @param {object} ticketRow
 * @param {number} [ticketId]
 */
async function isTicketEffectivelyInProject(db, orgId, jobNameKey, ticketRow, ticketId) {
    const tid = ticketId != null ? Number(ticketId) : ticketRow && ticketRow.id != null ? Number(ticketRow.id) : NaN;
    if (!Number.isFinite(tid) || !jobNameKey) return false;
    const key = String(jobNameKey).trim().toLowerCase();
    const override = await getMembershipRow(db, orgId, key, tid);
    if (override) {
        return String(override.membership).trim() === MEMBERSHIP_INCLUDE;
    }
    return ticketAutoMatchesJobKey(ticketRow, key);
}

/**
 * Compliance visible when effectively in project (exclude removes both membership and compliance).
 */
async function ticketSeesProjectCompliance(db, orgId, jobNameKey, ticketRow, ticketId) {
    return isTicketEffectivelyInProject(db, orgId, jobNameKey, ticketRow, ticketId);
}

/**
 * @returns {'manual_include'|'auto'|null} null if not in project
 */
async function resolveMembershipSource(db, orgId, jobNameKey, ticketRow, ticketId) {
    const tid = ticketId != null ? Number(ticketId) : ticketRow && ticketRow.id != null ? Number(ticketRow.id) : NaN;
    if (!Number.isFinite(tid) || !jobNameKey) return null;
    const key = String(jobNameKey).trim().toLowerCase();
    const override = await getMembershipRow(db, orgId, key, tid);
    if (override) {
        if (String(override.membership).trim() === MEMBERSHIP_INCLUDE) return 'manual_include';
        return null;
    }
    if (ticketAutoMatchesJobKey(ticketRow, key)) return 'auto';
    return null;
}

async function listEffectiveTicketRowsForProject(db, orgId, jobNameKey, ticketSelect) {
    const key = String(jobNameKey).trim().toLowerCase();
    if (!key) return [];
    const select = ticketSelect || 't.*';
    return allRows(
        db,
        `SELECT ${select}
         FROM tickets t
         WHERE ${EFFECTIVE_TICKET_WHERE}
         ORDER BY t.ticket_number ASC`,
        [orgId, orgId, key, key, orgId, key]
    );
}

async function countEffectiveTicketsForProject(db, orgId, jobNameKey) {
    const key = String(jobNameKey).trim().toLowerCase();
    if (!key) return 0;
    const row = await getRow(
        db,
        `SELECT COUNT(*) AS c
         FROM tickets t
         WHERE ${EFFECTIVE_TICKET_WHERE}`,
        [orgId, orgId, key, key, orgId, key]
    );
    return row && row.c != null ? Number(row.c) : 0;
}

async function listEffectiveTicketIdsForProject(db, orgId, jobNameKey) {
    const rows = await listEffectiveTicketRowsForProject(db, orgId, jobNameKey, 't.id');
    return (rows || []).map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
}

async function setProjectTicketMembership(db, orgId, jobNameKey, ticketId, membership, userId) {
    const key = String(jobNameKey).trim().toLowerCase();
    await runDb(
        db,
        `INSERT INTO job_project_ticket_membership (
             organization_id, job_name_normalized, ticket_id, membership, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, job_name_normalized, ticket_id)
         DO UPDATE SET membership = excluded.membership,
                       created_by_user_id = excluded.created_by_user_id,
                       created_at = CURRENT_TIMESTAMP`,
        [orgId, key, ticketId, membership, userId != null ? userId : null]
    );
}

async function addProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId) {
    await setProjectTicketMembership(db, orgId, jobNameKey, ticketId, MEMBERSHIP_INCLUDE, userId);
}

async function excludeProjectTicketMembership(db, orgId, jobNameKey, ticketId, userId) {
    await setProjectTicketMembership(db, orgId, jobNameKey, ticketId, MEMBERSHIP_EXCLUDE, userId);
}

async function removeProjectTicketMembership(db, orgId, jobNameKey, ticketId) {
    const key = String(jobNameKey).trim().toLowerCase();
    await runDb(
        db,
        `DELETE FROM job_project_ticket_membership
         WHERE organization_id = ? AND job_name_normalized = ? AND ticket_id = ?`,
        [orgId, key, ticketId]
    );
}

async function searchTicketCandidatesForProject(db, orgId, jobNameKey, query, limit) {
    const key = String(jobNameKey).trim().toLowerCase();
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const q = query != null ? String(query).trim().toLowerCase() : '';
    let sql = `SELECT t.id, t.ticket_number, t.address, t.user_reference
               FROM tickets t
               WHERE t.organization_id = ?
                 AND NOT (${EFFECTIVE_MATCH_SQL})`;
    const params = [orgId, orgId, key, key, orgId, key];
    if (q) {
        sql += ` AND (
            LOWER(t.ticket_number) LIKE ? OR
            LOWER(COALESCE(t.address, '')) LIKE ? OR
            LOWER(COALESCE(t.user_reference, '')) LIKE ?
        )`;
        const like = `%${q}%`;
        params.push(like, like, like);
    }
    sql += ' ORDER BY t.ticket_number ASC LIMIT ?';
    params.push(lim);
    return allRows(db, sql, params);
}

/**
 * List all projects a ticket belongs to with membership source.
 */
async function listProjectsForTicket(db, orgId, ticketRow) {
    const tid = ticketRow && ticketRow.id != null ? Number(ticketRow.id) : NaN;
    if (!Number.isFinite(tid)) return [];

    const overrideRows = await allRows(
        db,
        `SELECT job_name_normalized, membership FROM job_project_ticket_membership
         WHERE organization_id = ? AND ticket_id = ?`,
        [orgId, tid]
    );
    const excludeKeys = new Set();
    const includeKeys = new Set();
    for (const r of overrideRows || []) {
        const k = r.job_name_normalized != null ? String(r.job_name_normalized).trim() : '';
        if (!k) continue;
        if (String(r.membership).trim() === MEMBERSHIP_EXCLUDE) excludeKeys.add(k);
        else if (String(r.membership).trim() === MEMBERSHIP_INCLUDE) includeKeys.add(k);
    }

    const autoKey = normalizeJobNameKey(ticketRow.user_reference);
    const projectKeys = new Set(includeKeys);
    if (autoKey && !excludeKeys.has(autoKey)) projectKeys.add(autoKey);

    if (projectKeys.size === 0) return [];

    const keys = Array.from(projectKeys);
    const placeholders = keys.map(() => '?').join(', ');
    const complianceRows = await allRows(
        db,
        `SELECT job_name_normalized, job_name_display, status, closed_at
         FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized IN (${placeholders})`,
        [orgId, ...keys]
    );
    const displayByKey = new Map();
    for (const r of complianceRows || []) {
        const k = r.job_name_normalized != null ? String(r.job_name_normalized).trim() : '';
        if (k) {
            displayByKey.set(k, {
                jobName: r.job_name_display != null ? String(r.job_name_display).trim() : k,
                status: r.status != null ? String(r.status).trim() : 'open',
                closedAt: r.closed_at || null,
            });
        }
    }

    const projects = [];
    for (const key of keys) {
        let jobName = displayByKey.get(key)?.jobName;
        if (!jobName) {
            if (autoKey === key && ticketRow.user_reference) {
                jobName = String(ticketRow.user_reference).trim();
            } else {
                jobName = key;
            }
        }
        const membershipSource = includeKeys.has(key) ? 'manual_include' : 'auto';
        projects.push({
            jobNameKey: key,
            jobName,
            membershipSource,
            status: displayByKey.get(key)?.status || 'open',
            closedAt: displayByKey.get(key)?.closedAt || null,
        });
    }
    projects.sort((a, b) => a.jobName.localeCompare(b.jobName, undefined, { sensitivity: 'base' }));
    return projects;
}

/**
 * Effective ticket ↔ project maps for an org (auto match + include/exclude overrides).
 * @returns {Promise<{ ticketsByProject: Map<string, Set<number>>, projectsByTicket: Map<number, Set<string>> }>}
 */
async function buildEffectiveProjectMembershipMaps(db, orgId) {
    const [ticketRows, membershipRows] = await Promise.all([
        allRows(
            db,
            `SELECT id, user_reference FROM tickets WHERE organization_id = ?`,
            [orgId]
        ),
        allRows(
            db,
            `SELECT ticket_id, job_name_normalized, membership
             FROM job_project_ticket_membership
             WHERE organization_id = ?`,
            [orgId]
        ),
    ]);

    const includesByTicket = new Map();
    const excludesByTicket = new Map();
    for (const r of membershipRows || []) {
        const tid = r.ticket_id != null ? Number(r.ticket_id) : NaN;
        if (!Number.isFinite(tid)) continue;
        const key = r.job_name_normalized != null ? String(r.job_name_normalized).trim() : '';
        if (!key) continue;
        const mem = String(r.membership || '').trim();
        if (mem === MEMBERSHIP_INCLUDE) {
            if (!includesByTicket.has(tid)) includesByTicket.set(tid, new Set());
            includesByTicket.get(tid).add(key);
        } else if (mem === MEMBERSHIP_EXCLUDE) {
            if (!excludesByTicket.has(tid)) excludesByTicket.set(tid, new Set());
            excludesByTicket.get(tid).add(key);
        }
    }

    const ticketsByProject = new Map();
    const projectsByTicket = new Map();
    for (const t of ticketRows || []) {
        const tid = t.id != null ? Number(t.id) : NaN;
        if (!Number.isFinite(tid)) continue;
        const autoKey = normalizeJobNameKey(t.user_reference);
        const excluded = excludesByTicket.get(tid);
        const projectKeys = new Set(includesByTicket.get(tid) || []);
        if (autoKey && !(excluded && excluded.has(autoKey))) {
            projectKeys.add(autoKey);
        }
        if (projectKeys.size === 0) continue;
        projectsByTicket.set(tid, projectKeys);
        for (const key of projectKeys) {
            if (!ticketsByProject.has(key)) ticketsByProject.set(key, new Set());
            ticketsByProject.get(key).add(tid);
        }
    }

    return { ticketsByProject, projectsByTicket };
}

async function collectProjectDisplayMetaForOrg(db, orgId) {
    const complianceRows = await allRows(
        db,
        `SELECT job_name_normalized, job_name_display
         FROM job_misc_compliance
         WHERE organization_id = ?`,
        [orgId]
    );
    const keySet = new Set();
    const displayByKey = new Map();
    for (const r of complianceRows || []) {
        const k = r.job_name_normalized != null ? String(r.job_name_normalized).trim() : '';
        if (!k) continue;
        keySet.add(k);
        displayByKey.set(
            k,
            r.job_name_display != null ? String(r.job_name_display).trim() : k
        );
    }

    const autoRows = await allRows(
        db,
        `SELECT DISTINCT LOWER(TRIM(user_reference)) AS job_name_key,
                MIN(TRIM(user_reference)) AS job_name_display
         FROM tickets
         WHERE organization_id = ?
           AND user_reference IS NOT NULL
           AND TRIM(user_reference) != ''
         GROUP BY LOWER(TRIM(user_reference))`,
        [orgId]
    );
    for (const r of autoRows || []) {
        const k = r.job_name_key != null ? String(r.job_name_key).trim() : '';
        if (!k) continue;
        keySet.add(k);
        if (!displayByKey.has(k) && r.job_name_display) {
            displayByKey.set(k, String(r.job_name_display).trim());
        }
    }

    const includeRows = await allRows(
        db,
        `SELECT DISTINCT job_name_normalized FROM job_project_ticket_membership
         WHERE organization_id = ? AND membership = 'include'`,
        [orgId]
    );
    for (const r of includeRows || []) {
        const k = r.job_name_normalized != null ? String(r.job_name_normalized).trim() : '';
        if (k) keySet.add(k);
    }

    return { keySet, displayByKey };
}

/**
 * Analytics: count tickets per project key using effective membership.
 * @param {{ membershipMaps?: { ticketsByProject: Map<string, Set<number>> } }} [opts]
 */
async function listProjectTicketCountsForOrg(db, orgId, opts) {
    const options = opts || {};
    const [displayMeta, maps] = await Promise.all([
        collectProjectDisplayMetaForOrg(db, orgId),
        options.membershipMaps
            ? Promise.resolve(options.membershipMaps)
            : buildEffectiveProjectMembershipMaps(db, orgId),
    ]);
    const { keySet, displayByKey } = displayMeta;
    const { ticketsByProject } = maps;

    const counts = [];
    for (const key of keySet) {
        const ticketSet = ticketsByProject.get(key);
        const count = ticketSet ? ticketSet.size : 0;
        if (count > 0) {
            counts.push({
                jobNameKey: key,
                jobName: displayByKey.get(key) || key,
                ticketCount: count,
            });
        }
    }
    counts.sort((a, b) => b.ticketCount - a.ticketCount || a.jobName.localeCompare(b.jobName));
    return counts;
}

/**
 * Resolve job name keys for which ticket should show compliance (effective membership).
 */
async function listComplianceJobKeysForTicket(db, orgId, ticketRow) {
    const projects = await listProjectsForTicket(db, orgId, ticketRow);
    return projects.map((p) => p.jobNameKey);
}

module.exports = {
    MEMBERSHIP_INCLUDE,
    MEMBERSHIP_EXCLUDE,
    ticketAutoMatchesJobKey,
    isTicketEffectivelyInProject,
    isTicketExcludedFromProject,
    ticketSeesProjectCompliance,
    resolveMembershipSource,
    listEffectiveTicketRowsForProject,
    listEffectiveTicketIdsForProject,
    countEffectiveTicketsForProject,
    addProjectTicketMembership,
    excludeProjectTicketMembership,
    removeProjectTicketMembership,
    setProjectTicketMembership,
    searchTicketCandidatesForProject,
    listProjectsForTicket,
    buildEffectiveProjectMembershipMaps,
    collectProjectDisplayMetaForOrg,
    listProjectTicketCountsForOrg,
    listComplianceJobKeysForTicket,
};
