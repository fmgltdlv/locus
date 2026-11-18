import { canMutateOrganization } from '../auth.js';
import type { AuthUser } from '../types.js';

export function parseViewerOrganizationId(
    body: Record<string, unknown> | null | undefined,
    query: Record<string, unknown> | null | undefined,
    user: AuthUser
): number | null {
    const raw =
        (body && body.viewerOrganizationId != null ? body.viewerOrganizationId : null) ??
        (query && query.viewerOrganizationId != null ? query.viewerOrganizationId : null) ??
        (user && user.organizationId != null ? user.organizationId : null);
    if (raw == null || raw === '') return null;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
}

export async function assertOwnerOrgTicketWriteAllowed(
    _db: unknown,
    user: AuthUser,
    ownerOrgId: number,
    _viewerOrgId: number | null
): Promise<{ allowed: true } | { allowed: false; status: number; error: string }> {
    if (canMutateOrganization(user, ownerOrgId)) {
        return { allowed: true };
    }
    return { allowed: false, status: 403, error: 'You do not have access to that organization' };
}

export async function canViewerRefreshSharedTicketFromOrg(
    _db: unknown,
    user: AuthUser,
    ownerOrgId: number,
    _viewerOrgId: number | null
): Promise<boolean> {
    return canMutateOrganization(user, ownerOrgId);
}
