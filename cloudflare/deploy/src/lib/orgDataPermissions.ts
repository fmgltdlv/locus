import { canAdminOrganization } from "../auth.js";
import type { AuthUser } from "../types.js";
import { getRow } from "./db.cjs";
import { getMembershipRole, isTechMembership, isUnrestrictedOrgMembership, isOperatorMembership } from "./orgMembership.cjs";

export const ORG_DATA_DELETE_FORBIDDEN =
  "You do not have permission to delete data in this organization.";
export const ORG_DATA_EDIT_OTHERS_FORBIDDEN =
  "Tech users can only edit data they created.";

type DbLike = {
  get: Function;
};

export async function resolveOrgMembershipRole(
  db: DbLike,
  user: AuthUser,
  orgId: number
): Promise<string | null> {
  if (!user || orgId == null) return null;
  if (user.role === "dev") return null;
  return getMembershipRole(db, user.id, orgId);
}

/** Dev, global admin, org admin, or org manager — full delete/edit on org data. */
export function isUnrestrictedOrgDataActor(
  user: AuthUser,
  membershipRole: string | null,
  orgId: number
): boolean {
  if (!user) return false;
  if (user.role === "dev") return true;
  if (user.role === "admin") return true;
  if (canAdminOrganization(user, orgId)) return true;
  if (isUnrestrictedOrgMembership(membershipRole)) return true;
  return false;
}

export function membershipRoleBlocksDelete(membershipRole: string | null): boolean {
  return isOperatorMembership(membershipRole) || isTechMembership(membershipRole);
}

export async function assertOrgDataDeleteAllowed(
  req: { user: AuthUser },
  res: { status: (n: number) => { json: (b: unknown) => void } },
  db: DbLike,
  orgId: number
): Promise<boolean> {
  const role = await resolveOrgMembershipRole(db, req.user, orgId);
  if (isUnrestrictedOrgDataActor(req.user, role, orgId)) return true;
  if (membershipRoleBlocksDelete(role)) {
    res.status(403).json({ error: ORG_DATA_DELETE_FORBIDDEN });
    return false;
  }
  return true;
}

export async function assertOrgDataEditAllowed(
  req: { user: AuthUser },
  res: { status: (n: number) => { json: (b: unknown) => void } },
  db: DbLike,
  orgId: number,
  ownerUserId: number | null | undefined
): Promise<boolean> {
  const role = await resolveOrgMembershipRole(db, req.user, orgId);
  if (isUnrestrictedOrgDataActor(req.user, role, orgId)) return true;
  if (isOperatorMembership(role)) return true;
  if (isTechMembership(role)) {
    const oid = ownerUserId != null ? Number(ownerUserId) : NaN;
    if (Number.isFinite(oid) && oid === Number(req.user.id)) return true;
    res.status(403).json({ error: ORG_DATA_EDIT_OTHERS_FORBIDDEN });
    return false;
  }
  return true;
}

export async function userDisplayNameTokens(
  db: DbLike,
  userId: number
): Promise<Set<string>> {
  const row = (await getRow(db, "SELECT full_name, username, email FROM users WHERE id = ?", [
    userId,
  ])) as { full_name?: string; username?: string; email?: string } | null;
  const tokens = new Set<string>();
  if (!row) return tokens;
  for (const key of ["full_name", "username", "email"] as const) {
    const v = row[key];
    if (v != null && String(v).trim() !== "") {
      tokens.add(String(v).trim().toLowerCase());
    }
  }
  return tokens;
}

export function displayNameMatchesUser(
  createdBy: string | null | undefined,
  tokens: Set<string>
): boolean {
  if (!createdBy || String(createdBy).trim() === "") return false;
  return tokens.has(String(createdBy).trim().toLowerCase());
}

function stableAnnotationPayload(ann: Record<string, unknown>) {
  return JSON.stringify({
    type: ann.type ?? ann.annotation_type ?? null,
    name: ann.name ?? "",
    note: ann.note ?? "",
    color: ann.color ?? null,
    icon: ann.icon ?? null,
    utilityType: ann.utilityType ?? ann.utility_type ?? "",
    documentRef: ann.documentRef ?? ann.document_ref ?? "",
    linePattern: ann.linePattern ?? ann.line_pattern ?? null,
    geometry: ann.geometry ?? null,
  });
}

function dbAnnotationToComparable(row: Record<string, unknown>) {
  let geom: unknown = null;
  try {
    geom = typeof row.geometry === "string" ? JSON.parse(String(row.geometry)) : row.geometry;
  } catch {
    geom = null;
  }
  return stableAnnotationPayload({
    type: row.annotation_type,
    name: row.name,
    note: row.note,
    color: row.color,
    icon: row.icon,
    utilityType: row.utility_type,
    documentRef: row.document_ref,
    linePattern: row.line_pattern,
    geometry: geom,
  });
}

export type MapWorkspaceSavePolicyResult =
  | { ok: true; annotations: unknown[]; savedDataLayers: unknown[] }
  | { ok: false; status: number; error: string };

/**
 * Enforce org-member delete/edit rules on replace-all map workspace saves.
 * - User/tech: cannot omit existing top-level annotations or layers (no deletes).
 * - Tech: cannot modify annotations they did not create (by display name).
 */
export async function applyMapWorkspaceSavePolicy(
  db: DbLike,
  user: AuthUser,
  orgId: number,
  annotations: unknown[] | null,
  savedDataLayers: unknown[] | null
): Promise<MapWorkspaceSavePolicyResult> {
  const role = await resolveOrgMembershipRole(db, user, orgId);
  if (isUnrestrictedOrgDataActor(user, role, orgId)) {
    return {
      ok: true,
      annotations: annotations ?? [],
      savedDataLayers: savedDataLayers ?? [],
    };
  }

  const annList = annotations != null ? (Array.isArray(annotations) ? annotations : []) : null;
  const layerList =
    savedDataLayers != null ? (Array.isArray(savedDataLayers) ? savedDataLayers : []) : null;
  const blockDelete = membershipRoleBlocksDelete(role);
  const isTech = isTechMembership(role);
  const displayTokens = isTech ? await userDisplayNameTokens(db, user.id) : new Set<string>();

  const { allRows } = await import("./db.cjs");
  const existingAnnRows = (await allRows(
    db,
    `SELECT ann_id, geometry, annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern, created_by
     FROM map_workspace_annotations WHERE organization_id = ?`,
    [orgId]
  )) as Record<string, unknown>[];
  const existingLayerRows = (await allRows(
    db,
    `SELECT layer_id FROM map_workspace_data_layers WHERE organization_id = ?`,
    [orgId]
  )) as { layer_id?: string }[];

  const incomingAnnById = new Map<string, Record<string, unknown>>();
  if (annList) {
    for (const ann of annList) {
      if (!ann || typeof ann !== "object") continue;
      const id = (ann as { id?: unknown }).id;
      if (id == null) continue;
      incomingAnnById.set(String(id), ann as Record<string, unknown>);
    }
  }

  if (blockDelete && annList) {
    for (const row of existingAnnRows) {
      const id = row.ann_id != null ? String(row.ann_id) : "";
      if (id && !incomingAnnById.has(id)) {
        return { ok: false, status: 403, error: ORG_DATA_DELETE_FORBIDDEN };
      }
    }
  }
  if (blockDelete && layerList) {
    const incomingLayerIds = new Set(
      layerList
        .map((l) =>
          l && typeof l === "object" && (l as { id?: unknown }).id != null
            ? String((l as { id: unknown }).id)
            : ""
        )
        .filter(Boolean)
    );
    for (const row of existingLayerRows) {
      const id = row.layer_id != null ? String(row.layer_id) : "";
      if (id && !incomingLayerIds.has(id)) {
        return { ok: false, status: 403, error: ORG_DATA_DELETE_FORBIDDEN };
      }
    }
  }

  if (isTech && annList) {
    for (const row of existingAnnRows) {
      const id = row.ann_id != null ? String(row.ann_id) : "";
      if (!id) continue;
      const incoming = incomingAnnById.get(id);
      if (!incoming) continue;
      if (displayNameMatchesUser(row.created_by != null ? String(row.created_by) : null, displayTokens)) {
        continue;
      }
      if (dbAnnotationToComparable(row) !== stableAnnotationPayload(incoming)) {
        return { ok: false, status: 403, error: ORG_DATA_EDIT_OTHERS_FORBIDDEN };
      }
    }

    const existingLayerAnnRows = (await allRows(
      db,
      `SELECT layer_id, ann_id, geometry, annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern, created_by
       FROM map_workspace_layer_annotations WHERE organization_id = ?`,
      [orgId]
    )) as Record<string, unknown>[];

    const incomingLayerAnnByKey = new Map<string, Record<string, unknown>>();
    if (layerList) {
      for (const layer of layerList) {
        if (!layer || typeof layer !== "object") continue;
        const layerId =
          (layer as { id?: unknown }).id != null ? String((layer as { id: unknown }).id) : "";
        const layerAnns = Array.isArray((layer as { annotations?: unknown[] }).annotations)
          ? (layer as { annotations: unknown[] }).annotations
          : [];
        for (const ann of layerAnns) {
          if (!ann || typeof ann !== "object") continue;
          const annId = (ann as { id?: unknown }).id != null ? String((ann as { id: unknown }).id) : "";
          if (!layerId || !annId) continue;
          incomingLayerAnnByKey.set(`${layerId}::${annId}`, ann as Record<string, unknown>);
        }
      }
    }

    if (blockDelete && layerList) {
      for (const row of existingLayerAnnRows) {
        const layerId = row.layer_id != null ? String(row.layer_id) : "";
        const annId = row.ann_id != null ? String(row.ann_id) : "";
        const key = layerId && annId ? `${layerId}::${annId}` : "";
        if (key && !incomingLayerAnnByKey.has(key)) {
          return { ok: false, status: 403, error: ORG_DATA_DELETE_FORBIDDEN };
        }
      }
    }

    for (const row of existingLayerAnnRows) {
      const layerId = row.layer_id != null ? String(row.layer_id) : "";
      const annId = row.ann_id != null ? String(row.ann_id) : "";
      const key = layerId && annId ? `${layerId}::${annId}` : "";
      if (!key) continue;
      const incoming = incomingLayerAnnByKey.get(key);
      if (!incoming) continue;
      if (displayNameMatchesUser(row.created_by != null ? String(row.created_by) : null, displayTokens)) {
        continue;
      }
      if (dbAnnotationToComparable(row) !== stableAnnotationPayload(incoming)) {
        return { ok: false, status: 403, error: ORG_DATA_EDIT_OTHERS_FORBIDDEN };
      }
    }
  }

  return {
    ok: true,
    annotations: annList ?? [],
    savedDataLayers: layerList ?? [],
  };
}
