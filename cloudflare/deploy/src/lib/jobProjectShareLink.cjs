/**
 * Project public share link management.
 * Share token is the project's stable 10-char public_id (enable/disable only; never regenerates).
 */
const crypto = require('crypto');
const { getRow, runDb } = require('./db.cjs');

const PUBLIC_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_ID_LENGTH = 10;
const PUBLIC_ID_RE = /^[A-Z0-9]{10}$/;
const PUBLIC_ID_INPUT_RE = /^[A-Za-z0-9]{10}$/;

function generateProjectPublicId() {
    const bytes = crypto.randomBytes(PUBLIC_ID_LENGTH);
    let out = '';
    for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
        out += PUBLIC_ID_ALPHABET[bytes[i] % PUBLIC_ID_ALPHABET.length];
    }
    return out;
}

function normalizeProjectPublicId(raw) {
    if (raw == null) return null;
    const trimmed = String(raw).trim();
    if (!PUBLIC_ID_INPUT_RE.test(trimmed)) return null;
    return trimmed.toUpperCase();
}

function sharePathForPublicId(publicId) {
    // Prefer /share/?token=… (static share/index.html). Avoids /share → /share/ 308 and
    // Pages SPA fallback that was serving the map shell for /share/{id}.
    return `/share/?token=${encodeURIComponent(publicId)}`;
}

async function allocateUniquePublicId(db) {
    for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = generateProjectPublicId();
        const clash = await getRow(db, 'SELECT 1 AS ok FROM job_misc_compliance WHERE public_id = ?', [
            candidate,
        ]);
        if (!clash) return candidate;
    }
    throw new Error('Failed to allocate unique project public_id');
}

/**
 * Ensure job_misc_compliance has a stable public_id for this project.
 * Creates a registry row when missing.
 * @returns {Promise<string>} uppercase public_id
 */
async function ensureProjectPublicId(db, orgId, jobNameKey, displayName) {
    const key = String(jobNameKey).trim().toLowerCase();
    const existing = await getRow(
        db,
        `SELECT public_id, job_name_display FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, key]
    );
    if (existing) {
        const current = normalizeProjectPublicId(existing.public_id);
        if (current) return current;
        for (let attempt = 0; attempt < 12; attempt++) {
            const candidate = await allocateUniquePublicId(db);
            try {
                await runDb(
                    db,
                    `UPDATE job_misc_compliance
                     SET public_id = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE organization_id = ? AND job_name_normalized = ?
                       AND (public_id IS NULL OR trim(public_id) = '')`,
                    [candidate, orgId, key]
                );
                const again = await getRow(
                    db,
                    `SELECT public_id FROM job_misc_compliance
                     WHERE organization_id = ? AND job_name_normalized = ?`,
                    [orgId, key]
                );
                const normalized = normalizeProjectPublicId(again && again.public_id);
                if (normalized) return normalized;
            } catch (_e) {
                // UNIQUE collision — retry
            }
        }
        throw new Error('Failed to assign project public_id');
    }

    const display =
        displayName != null && String(displayName).trim()
            ? String(displayName).trim()
            : key;
    for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = await allocateUniquePublicId(db);
        try {
            await runDb(
                db,
                `INSERT INTO job_misc_compliance (
                     organization_id, job_name_normalized, job_name_display,
                     custom_items_json, public_id, created_at, updated_at
                 ) VALUES (?, ?, ?, '[]', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [orgId, key, display, candidate]
            );
            return candidate;
        } catch (e) {
            const msg = e && e.message != null ? String(e.message) : '';
            if (/UNIQUE|unique|constraint/i.test(msg)) {
                const raced = await getRow(
                    db,
                    `SELECT public_id FROM job_misc_compliance
                     WHERE organization_id = ? AND job_name_normalized = ?`,
                    [orgId, key]
                );
                const normalized = normalizeProjectPublicId(raced && raced.public_id);
                if (normalized) return normalized;
                continue;
            }
            throw e;
        }
    }
    throw new Error('Failed to create project with public_id');
}

async function getProjectPublicId(db, orgId, jobNameKey) {
    const key = String(jobNameKey).trim().toLowerCase();
    const row = await getRow(
        db,
        `SELECT public_id FROM job_misc_compliance
         WHERE organization_id = ? AND job_name_normalized = ?`,
        [orgId, key]
    );
    return normalizeProjectPublicId(row && row.public_id);
}

async function revokeActiveShareLinksForProject(db, orgId, jobNameKey) {
    await runDb(
        db,
        `UPDATE job_project_share_links
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE organization_id = ? AND job_name_normalized = ? AND revoked_at IS NULL`,
        [orgId, jobNameKey]
    );
}

async function getActiveShareLinkRow(db, orgId, jobNameKey) {
    return getRow(
        db,
        `SELECT token, organization_id, job_name_normalized, label, created_at, expires_at, revoked_at
         FROM job_project_share_links
         WHERE organization_id = ? AND job_name_normalized = ?
           AND revoked_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [orgId, jobNameKey]
    );
}

/**
 * Enable sharing for a project using its stable public_id (does not mint a new ID).
 */
async function enableShareLink(db, orgId, jobNameKey, userId, opts) {
    const key = String(jobNameKey).trim().toLowerCase();
    const displayName = opts && opts.displayName != null ? opts.displayName : undefined;
    const label = opts && opts.label != null ? String(opts.label).trim() || null : null;
    const publicId = await ensureProjectPublicId(db, orgId, key, displayName);

    const active = await getActiveShareLinkRow(db, orgId, key);
    if (active && normalizeProjectPublicId(active.token) === publicId) {
        if (active.expires_at != null) {
            await runDb(
                db,
                `UPDATE job_project_share_links
                 SET expires_at = NULL
                 WHERE organization_id = ? AND job_name_normalized = ?
                   AND token = ? AND revoked_at IS NULL`,
                [orgId, key, publicId]
            );
        }
        return {
            token: publicId,
            publicId,
            jobNameKey: key,
            label: active.label || label,
            expiresAt: null,
            sharePath: sharePathForPublicId(publicId),
        };
    }

    // Revoke any other active tokens (legacy 64-hex), then reuse or insert public_id row.
    await revokeActiveShareLinksForProject(db, orgId, key);

    const byToken = await getRow(
        db,
        `SELECT token, label, revoked_at FROM job_project_share_links WHERE token = ?`,
        [publicId]
    );
    if (byToken) {
        await runDb(
            db,
            `UPDATE job_project_share_links
             SET organization_id = ?,
                 job_name_normalized = ?,
                 label = COALESCE(?, label),
                 created_by_user_id = ?,
                 expires_at = NULL,
                 revoked_at = NULL,
                 created_at = CURRENT_TIMESTAMP
             WHERE token = ?`,
            [orgId, key, label, userId != null ? userId : null, publicId]
        );
    } else {
        await runDb(
            db,
            `INSERT INTO job_project_share_links (
                 token, organization_id, job_name_normalized, label,
                 created_by_user_id, expires_at
             ) VALUES (?, ?, ?, ?, ?, NULL)`,
            [publicId, orgId, key, label, userId != null ? userId : null]
        );
    }

    return {
        token: publicId,
        publicId,
        jobNameKey: key,
        label,
        expiresAt: null,
        sharePath: sharePathForPublicId(publicId),
    };
}

/** @deprecated Use enableShareLink — kept as alias for call-site clarity during transition. */
async function createOrRegenerateShareLink(db, orgId, jobNameKey, userId, opts) {
    return enableShareLink(db, orgId, jobNameKey, userId, opts);
}

async function revokeShareLinkForProject(db, orgId, jobNameKey) {
    await revokeActiveShareLinksForProject(db, orgId, String(jobNameKey).trim().toLowerCase());
}

async function resolveShareLinkByToken(db, token) {
    const publicId = normalizeProjectPublicId(token);
    if (!publicId) return null;
    const row = await getRow(
        db,
        `SELECT token, organization_id, job_name_normalized, label, created_at, expires_at, revoked_at
         FROM job_project_share_links
         WHERE token = ?`,
        [publicId]
    );
    if (!row) return null;
    if (row.revoked_at != null) return { invalid: true, reason: 'revoked' };
    if (row.expires_at != null) {
        const exp = new Date(String(row.expires_at));
        if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) {
            return { invalid: true, reason: 'expired' };
        }
    }
    return { ok: true, row };
}

module.exports = {
    PUBLIC_ID_LENGTH,
    PUBLIC_ID_RE,
    generateProjectPublicId,
    normalizeProjectPublicId,
    sharePathForPublicId,
    allocateUniquePublicId,
    ensureProjectPublicId,
    getProjectPublicId,
    enableShareLink,
    createOrRegenerateShareLink,
    getActiveShareLinkRow,
    revokeShareLinkForProject,
    resolveShareLinkByToken,
};
