'use strict';

const { allRows, getRow, runDb } = require('./db.cjs');

/**
 * @param {import('sqlite3').Database} db
 * @param {number} orgId
 * @param {string} jobNameKey normalized job key
 * @returns {Promise<Array<{ userId: number, userName: string|null, createdAt: string|null }>>}
 */
async function listProjectAssignees(db, orgId, jobNameKey) {
    const key = jobNameKey != null ? String(jobNameKey).trim().toLowerCase() : '';
    if (!orgId || !key) return [];
    const rows = await allRows(
        db,
        `SELECT a.user_id AS user_id,
                a.created_at AS created_at,
                u.full_name AS full_name,
                u.username AS username,
                u.email AS user_email
         FROM job_project_assignees a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.organization_id = ? AND a.job_name_normalized = ?
         ORDER BY LOWER(COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), u.email, '')) ASC,
                  a.user_id ASC`,
        [orgId, key]
    );
    return (rows || []).map((r) => {
        const userId = r.user_id != null ? Number(r.user_id) : NaN;
        const name =
            r.full_name != null && String(r.full_name).trim()
                ? String(r.full_name).trim()
                : r.username != null && String(r.username).trim()
                  ? String(r.username).trim()
                  : r.user_email != null
                    ? String(r.user_email).trim()
                    : null;
        return {
            userId,
            userName: name,
            createdAt: r.created_at || null,
        };
    }).filter((a) => Number.isFinite(a.userId));
}

/**
 * All project assignees for an org, keyed by normalized job name.
 * @returns {Promise<Map<string, Array<{ userId: number, userName: string|null }>>>}
 */
async function listAssigneesByProjectForOrg(db, orgId) {
    const out = new Map();
    if (!orgId) return out;
    const rows = await allRows(
        db,
        `SELECT a.job_name_normalized AS job_name_normalized,
                a.user_id AS user_id,
                u.full_name AS full_name,
                u.username AS username,
                u.email AS user_email
         FROM job_project_assignees a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.organization_id = ?
         ORDER BY a.job_name_normalized ASC,
                  LOWER(COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.username), ''), u.email, '')) ASC,
                  a.user_id ASC`,
        [orgId]
    );
    for (const r of rows || []) {
        const key =
            r.job_name_normalized != null ? String(r.job_name_normalized).trim().toLowerCase() : '';
        if (!key) continue;
        const userId = r.user_id != null ? Number(r.user_id) : NaN;
        if (!Number.isFinite(userId)) continue;
        const name =
            r.full_name != null && String(r.full_name).trim()
                ? String(r.full_name).trim()
                : r.username != null && String(r.username).trim()
                  ? String(r.username).trim()
                  : r.user_email != null
                    ? String(r.user_email).trim()
                    : null;
        if (!out.has(key)) out.set(key, []);
        out.get(key).push({ userId, userName: name });
    }
    return out;
}

/**
 * @returns {Promise<boolean>}
 */
async function isUserAssignedToProject(db, orgId, jobNameKey, userId) {
    const key = jobNameKey != null ? String(jobNameKey).trim().toLowerCase() : '';
    const uid = Number(userId);
    if (!orgId || !key || !Number.isFinite(uid)) return false;
    const row = await getRow(
        db,
        `SELECT 1 AS ok FROM job_project_assignees
         WHERE organization_id = ? AND job_name_normalized = ? AND user_id = ?
         LIMIT 1`,
        [orgId, key, uid]
    );
    return Boolean(row);
}

/**
 * Open project keys the user is assigned to in this org.
 * @returns {Promise<Set<string>>}
 */
async function listAssignedOpenProjectKeysForUser(db, orgId, userId) {
    const uid = Number(userId);
    const out = new Set();
    if (!orgId || !Number.isFinite(uid)) return out;
    const rows = await allRows(
        db,
        `SELECT a.job_name_normalized AS job_name_normalized
         FROM job_project_assignees a
         LEFT JOIN job_misc_compliance c
           ON c.organization_id = a.organization_id
          AND c.job_name_normalized = a.job_name_normalized
         WHERE a.organization_id = ?
           AND a.user_id = ?
           AND (
             c.id IS NULL
             OR LOWER(TRIM(COALESCE(c.status, 'open'))) = 'open'
           )`,
        [orgId, uid]
    );
    for (const r of rows || []) {
        const k = r.job_name_normalized != null ? String(r.job_name_normalized).trim().toLowerCase() : '';
        if (k) out.add(k);
    }
    return out;
}

/**
 * Replace-all assignees for a project. userIds must already be validated as org members.
 * @param {number[]} userIds
 * @returns {Promise<Array<{ userId: number, userName: string|null, createdAt: string|null }>>}
 */
async function replaceProjectAssignees(db, orgId, jobNameKey, userIds, createdByUserId) {
    const key = jobNameKey != null ? String(jobNameKey).trim().toLowerCase() : '';
    if (!orgId || !key) {
        throw new Error('organization_id and job_name_normalized are required');
    }
    const uniqueIds = [];
    const seen = new Set();
    for (const raw of userIds || []) {
        const uid = Number(raw);
        if (!Number.isFinite(uid) || uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        uniqueIds.push(uid);
    }

    await runDb(
        db,
        `DELETE FROM job_project_assignees
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, key]
    );

    const createdBy =
        createdByUserId != null && Number.isFinite(Number(createdByUserId))
            ? Number(createdByUserId)
            : null;

    for (const uid of uniqueIds) {
        await runDb(
            db,
            `INSERT INTO job_project_assignees (
                 organization_id, job_name_normalized, user_id, created_by_user_id, created_at
             ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [orgId, key, uid, createdBy]
        );
    }

    return listProjectAssignees(db, orgId, key);
}

/**
 * Validate that every userId is a member of the organization.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status: number }>}
 */
async function assertUserIdsAreOrgMembers(db, orgId, userIds) {
    const uniqueIds = [];
    const seen = new Set();
    for (const raw of userIds || []) {
        const uid = Number(raw);
        if (!Number.isFinite(uid) || uid <= 0) {
            return { ok: false, status: 400, error: 'Each userId must be a positive number' };
        }
        if (seen.has(uid)) continue;
        seen.add(uid);
        uniqueIds.push(uid);
    }
    if (uniqueIds.length === 0) return { ok: true };

    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = await allRows(
        db,
        `SELECT user_id FROM user_organizations
         WHERE organization_id = ? AND user_id IN (${placeholders})`,
        [orgId, ...uniqueIds]
    );
    const found = new Set((rows || []).map((r) => Number(r.user_id)));
    const missing = uniqueIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
        return {
            ok: false,
            status: 400,
            error: `User(s) are not members of this organization: ${missing.join(', ')}`,
        };
    }
    return { ok: true };
}

module.exports = {
    listProjectAssignees,
    listAssigneesByProjectForOrg,
    isUserAssignedToProject,
    listAssignedOpenProjectKeysForUser,
    replaceProjectAssignees,
    assertUserIdsAreOrgMembers,
};
