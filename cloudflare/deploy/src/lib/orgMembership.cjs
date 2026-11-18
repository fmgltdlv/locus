const { getRow } = require('./db.cjs');
const {
    isTechMembership,
    isManagerMembership,
    isOperatorMembership,
    isOrgAdminMembership,
    isTicketWriteMembership,
    isUnrestrictedOrgMembership,
    normalizeOrgRole,
} = require('./roles.cjs');

/**
 * @param {import('sqlite3').Database} db
 * @param {number} userId
 * @param {number} organizationId
 * @returns {Promise<string|null>} role in user_organizations or null if no row
 */
async function getMembershipRole(db, userId, organizationId) {
    if (userId == null || organizationId == null) return null;
    const row = await getRow(
        db,
        'SELECT role FROM user_organizations WHERE user_id = ? AND organization_id = ?',
        [userId, organizationId]
    );
    return row && row.role ? normalizeOrgRole(String(row.role)) : null;
}

module.exports = {
    getMembershipRole,
    isTechMembership,
    isManagerMembership,
    isOperatorMembership,
    isOrgAdminMembership,
    isTicketWriteMembership,
    isUnrestrictedOrgMembership,
    normalizeOrgRole,
};
