/**
 * nGen poll / refresh credentials: **per-organization master** `organization_pacweb_accounts` in production.
 * Global `USAN_SERVICE_*` (and aliases) is allowed only when {@link ngenGlobalEnvCredsAllowed} — local dev and script testing.
 */
const { getRow } = require('./db.cjs');
const { getUsanServiceCredentialsFromEnv } = require('./usanServiceEnvCreds.cjs');
const { decryptPassword } = require('./pacwebCredentialsCrypto.cjs');
const { createAppError } = require('./appErrors.cjs');

/** App env values where global USAN service env creds may be used for nGen (wrangler dev, Node smoke scripts, CI). */
const APP_ENVS_ALLOWING_GLOBAL_USAN_NGEN = new Set(['development', 'dev', 'test', 'local']);

/**
 * True only when `APP_ENV` is an explicit dev/test marker (not `production`, not unset).
 * Production Workers must set `APP_ENV=production` and use org master accounts only.
 * @returns {boolean}
 */
function ngenGlobalEnvCredsAllowed() {
    const v = String(process.env.APP_ENV || '').trim().toLowerCase();
    return APP_ENVS_ALLOWING_GLOBAL_USAN_NGEN.has(v);
}

/**
 * @returns {'global'|'per_organization'}
 */
function pacPollCredentialsMode() {
    const m = String(process.env.USAN_POLL_CREDENTIALS_MODE || '')
        .trim()
        .toLowerCase();
    return m === 'per_organization' ? 'per_organization' : 'global';
}

/**
 * @param {import('sqlite3').Database|object} db
 * @param {number} organizationId
 * @returns {Promise<{ user: string, pass: string }|null>} null if per-org but no valid master+password
 */
async function getMasterNgenPasswordCredentialsForOrg(db, organizationId) {
    const orgId = parseInt(String(organizationId), 10);
    if (!Number.isFinite(orgId)) return null;
    const row = await getRow(
        db,
        `SELECT id, pacweb_username, password_encrypted
         FROM organization_pacweb_accounts
         WHERE organization_id = ? AND account_type = 'master'
         LIMIT 1`,
        [orgId]
    );
    if (!row) return null;
    const u = row.pacweb_username != null ? String(row.pacweb_username).trim() : '';
    if (!u) return null;
    const dec =
        row.password_encrypted != null
            ? String(await decryptPassword(String(row.password_encrypted)))
            : '';
    if (!dec) return null;
    return { user: u, pass: String(dec) };
}

/**
 * Credentials used for SearchCurrentUserEnquiries + GetCurrentUserEnquiry in poll.
 * @param {import('sqlite3').Database|object} db
 * @param {number} hubOrganizationId - org running the poll
 * @returns {Promise<{ user: string, pass: string }|null>} null = cannot poll (caller should error)
 */
async function getNgenCredentialsForPoll(db, hubOrganizationId) {
    const o = await getMasterNgenPasswordCredentialsForOrg(db, hubOrganizationId);
    if (o && o.user && o.pass) return o;
    if (!ngenGlobalEnvCredsAllowed()) {
        return null;
    }
    if (pacPollCredentialsMode() === 'per_organization') {
        return null;
    }
    const svc = getUsanServiceCredentialsFromEnv();
    if (svc && svc.user && svc.pass) return { user: svc.user, pass: svc.pass };
    return null;
}

/**
 * @param {import('sqlite3').Database|object} db
 * @param {number} hubOrganizationId
 * @returns {Promise<string|null>} user-facing error or null if ok
 */
async function validateNgenPollCanRun(db, hubOrganizationId) {
    const o = await getMasterNgenPasswordCredentialsForOrg(db, hubOrganizationId);
    if (o) return null;
    if (!ngenGlobalEnvCredsAllowed()) {
        return createAppError('NGEN_MASTER_ACCOUNT_MISSING', {
            internalMessage:
                'Production requires a master organization_pacweb_accounts row with a stored password. Global USAN_SERVICE_* nGen credentials are not used when APP_ENV is not a dev/test value (e.g. set APP_ENV=development locally).',
            meta: { hubOrganizationId },
        });
    }
    if (pacPollCredentialsMode() === 'per_organization') {
        return createAppError('NGEN_MASTER_ACCOUNT_MISSING', {
            internalMessage:
                'USAN_POLL_CREDENTIALS_MODE=per_organization requires one master organization_pacweb_accounts row with a stored password. Sub-accounts are username only.',
            meta: { hubOrganizationId },
        });
    }
    const svc = getUsanServiceCredentialsFromEnv();
    if (svc && svc.user && svc.pass) return null;
    return createAppError('NGEN_SERVICE_ACCOUNT_MISSING', {
        internalMessage:
            'Set USAN_SERVICE_USERNAME and USAN_SERVICE_PASSWORD for local/script use (APP_ENV must be development, dev, test, or local), or configure a master org password.',
        meta: { hubOrganizationId },
    });
}

module.exports = {
    pacPollCredentialsMode,
    ngenGlobalEnvCredsAllowed,
    getMasterNgenPasswordCredentialsForOrg,
    getNgenCredentialsForPoll,
    validateNgenPollCanRun,
};
