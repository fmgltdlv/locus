/** Global account roles (users.role). */
export const GLOBAL_ROLES = ["operator", "admin", "dev"] as const;

/** Per-org membership roles (user_organizations.role). */
export const ORG_ROLES = ["operator", "manager", "admin", "tech"] as const;

export type GlobalRole = (typeof GLOBAL_ROLES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];

/** Map legacy stored role "user" to "operator". */
export function normalizeGlobalRole(role: string | null | undefined): string {
  const r = role != null ? String(role).trim() : "";
  if (!r || r === "user") return "operator";
  return r;
}

/** Map legacy stored role "user" to "operator". */
export function normalizeOrgRole(role: string | null | undefined): string {
  const r = role != null ? String(role).trim() : "";
  if (!r || r === "user") return "operator";
  return r;
}

export function isValidGlobalRole(role: string): boolean {
  return GLOBAL_ROLES.includes(normalizeGlobalRole(role) as GlobalRole);
}

export function isValidOrgRole(role: string): boolean {
  return ORG_ROLES.includes(normalizeOrgRole(role) as OrgRole);
}

export function isTechMembership(role: string | null | undefined): boolean {
  return normalizeOrgRole(role) === "tech";
}

export function isManagerMembership(role: string | null | undefined): boolean {
  return normalizeOrgRole(role) === "manager";
}

export function isOperatorMembership(role: string | null | undefined): boolean {
  return normalizeOrgRole(role) === "operator";
}

export function isOrgAdminMembership(role: string | null | undefined): boolean {
  return normalizeOrgRole(role) === "admin";
}

/** Org roles allowed to perform USAN ticket create/renew/remark/amend/submit-jobs. */
export function isTicketWriteMembership(role: string | null | undefined): boolean {
  const r = normalizeOrgRole(role);
  return r === "admin" || r === "manager";
}

/** Org roles with full delete/edit on org data (same as org admin). */
export function isUnrestrictedOrgMembership(role: string | null | undefined): boolean {
  const r = normalizeOrgRole(role);
  return r === "admin" || r === "manager";
}
