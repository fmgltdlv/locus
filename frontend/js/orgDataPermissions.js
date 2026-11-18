// Org-scoped Data Hub permissions (mirrors cloudflare/deploy/src/lib/orgDataPermissions.ts).

function getCurrentOrgIdForPerms() {
    if (typeof window.getCurrentOrgId === 'function') {
        const v = window.getCurrentOrgId();
        if (v != null && v !== '') return Number(v);
    }
    const user = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
    return user && user.organizationId != null ? Number(user.organizationId) : null;
}

function resolveOrgRole(orgId) {
    const auth = window.authModule;
    if (!auth || !auth.getOrgRoleForOrg) return null;
    const oid = orgId != null ? orgId : getCurrentOrgIdForPerms();
    return auth.getOrgRoleForOrg(oid);
}

/** Dev, global admin, org admin, or org manager — full delete/edit on org data. */
function isUnrestrictedOrgDataActor(orgId) {
    const auth = window.authModule;
    if (!auth || !auth.getCurrentUser) return false;
    const user = auth.getCurrentUser();
    if (!user) return false;
    if (user.role === 'dev' || user.role === 'admin') return true;
    const oid = orgId != null ? Number(orgId) : getCurrentOrgIdForPerms();
    if (oid != null && Array.isArray(user.adminOrganizationIds) && user.adminOrganizationIds.includes(oid)) {
        return true;
    }
    const role = resolveOrgRole(oid);
    if (window.rolesModule && typeof window.rolesModule.isUnrestrictedOrgMembership === 'function') {
        return window.rolesModule.isUnrestrictedOrgMembership(role);
    }
    return role === 'admin' || role === 'manager';
}

function membershipRoleBlocksDelete(orgId) {
    const role = resolveOrgRole(orgId);
    if (window.rolesModule && typeof window.rolesModule.isOperatorMembership === 'function') {
        return window.rolesModule.isOperatorMembership(role) || window.rolesModule.isTechMembership(role);
    }
    return role === 'operator' || role === 'user' || role === 'tech';
}

function canDeleteOrgData(orgId) {
    if (isUnrestrictedOrgDataActor(orgId)) return true;
    return !membershipRoleBlocksDelete(orgId);
}

function canEditOrgDataResource(ownerUserId, orgId) {
    if (isUnrestrictedOrgDataActor(orgId)) return true;
    const role = resolveOrgRole(orgId);
    if (role === 'operator' || role === 'user') return true;
    if (role === 'tech') {
        const auth = window.authModule;
        const user = auth && auth.getCurrentUser ? auth.getCurrentUser() : null;
        if (!user) return false;
        const oid = ownerUserId != null ? Number(ownerUserId) : NaN;
        return Number.isFinite(oid) && oid === Number(user.id);
    }
    return true;
}

function userDisplayNameTokens() {
    const auth = window.authModule;
    const user = auth && auth.getCurrentUser ? auth.getCurrentUser() : null;
    const tokens = new Set();
    if (!user) return tokens;
    ['full_name', 'username', 'email'].forEach((key) => {
        const v = user[key];
        if (v != null && String(v).trim() !== '') {
            tokens.add(String(v).trim().toLowerCase());
        }
    });
    return tokens;
}

function displayNameMatchesCurrentUser(createdBy) {
    if (!createdBy || String(createdBy).trim() === '') return false;
    return userDisplayNameTokens().has(String(createdBy).trim().toLowerCase());
}

function canEditAnnotation(annotation, orgId) {
    if (isUnrestrictedOrgDataActor(orgId)) return true;
    const role = resolveOrgRole(orgId);
    if (role === 'operator' || role === 'user') return true;
    if (role === 'tech') {
        return displayNameMatchesCurrentUser(annotation && annotation.createdBy);
    }
    return true;
}

function canEditDataItem(type, item, orgId) {
    if (!item) return canEditOrgDataResource(null, orgId);
    if (type === 'annotation') return canEditAnnotation(item, orgId);
    if (type === 'event') {
        return canEditOrgDataResource(item.createdByUserId, orgId);
    }
    if (type === 'photo') {
        return canEditOrgDataResource(item.uploadedByUserId || item.userId, orgId);
    }
    return canEditOrgDataResource(item.userId || item.createdByUserId, orgId);
}

function guardDeleteOrgData(orgId) {
    if (canDeleteOrgData(orgId)) return true;
    void appAlert('You do not have permission to delete data in this organization.');
    return false;
}

function guardEditDataItem(type, item, orgId) {
    if (canEditDataItem(type, item, orgId)) return true;
    void appAlert('You do not have permission to edit this item.');
    return false;
}

window.orgDataPermissionsModule = {
    isUnrestrictedOrgDataActor,
    canDeleteOrgData,
    canEditOrgDataResource,
    canEditAnnotation,
    canEditDataItem,
    displayNameMatchesCurrentUser,
    guardDeleteOrgData,
    guardEditDataItem,
};
