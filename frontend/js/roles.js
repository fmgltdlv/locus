/**
 * Role constants and helpers (mirrors cloudflare/deploy/src/lib/roles.ts).
 */
(function (global) {
    'use strict';

    const GLOBAL_ROLES = ['operator', 'admin', 'dev'];
    const ORG_ROLES = ['operator', 'manager', 'admin', 'tech'];

    function normalizeGlobalRole(role) {
        const r = role != null ? String(role).trim() : '';
        if (!r || r === 'user') return 'operator';
        return r;
    }

    function normalizeOrgRole(role) {
        const r = role != null ? String(role).trim() : '';
        if (!r || r === 'user') return 'operator';
        return r;
    }

    function isValidGlobalRole(role) {
        return GLOBAL_ROLES.includes(normalizeGlobalRole(role));
    }

    function isValidOrgRole(role) {
        return ORG_ROLES.includes(normalizeOrgRole(role));
    }

    function isTechMembership(role) {
        return normalizeOrgRole(role) === 'tech';
    }

    function isManagerMembership(role) {
        return normalizeOrgRole(role) === 'manager';
    }

    function isOperatorMembership(role) {
        return normalizeOrgRole(role) === 'operator';
    }

    function isOrgAdminMembership(role) {
        return normalizeOrgRole(role) === 'admin';
    }

    function isTicketWriteMembership(role) {
        const r = normalizeOrgRole(role);
        return r === 'admin' || r === 'manager';
    }

    function isUnrestrictedOrgMembership(role) {
        const r = normalizeOrgRole(role);
        return r === 'admin' || r === 'manager';
    }

    global.rolesModule = {
        GLOBAL_ROLES,
        ORG_ROLES,
        normalizeGlobalRole,
        normalizeOrgRole,
        isValidGlobalRole,
        isValidOrgRole,
        isTechMembership,
        isManagerMembership,
        isOperatorMembership,
        isOrgAdminMembership,
        isTicketWriteMembership,
        isUnrestrictedOrgMembership,
    };
})(typeof window !== 'undefined' ? window : globalThis);
