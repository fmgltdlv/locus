// Data Hub routes — split from data.ts (Phase 3)
import { randomBytes } from "node:crypto";
import { getDatabase } from "../database.js";
import {
  canAdminOrganization,
  canMutateOrganization,
  ORG_REQUIRED_MESSAGE,
} from "../auth.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import { getRow, allRows, runDb } from "../lib/db.cjs";
import { isPublicCatalogOrgId } from "../lib/publicShareQuery.cjs";
import { applyMapWorkspaceSavePolicy } from "../lib/orgDataPermissions.js";
import { computeGeomAabbAndType, parseGeometryJson } from "../lib/geoAabb.cjs";
import {
  resolveDataOrgIdRead,
  resolveDataOrgId,
  type DataApp,
} from "./dataShared.js";

function annotationRowToClient(r: Record<string, unknown>) {
  let geom: unknown = null;
  try {
    geom = typeof r.geometry === "string" ? JSON.parse(String(r.geometry)) : r.geometry;
  } catch (_) {
    geom = null;
  }
  const out: Record<string, unknown> = {
    id: r.ann_id,
    type: r.annotation_type || undefined,
    geometry: geom,
    name: r.name || "",
    note: r.note || "",
    color: r.color || undefined,
    icon: r.icon || undefined,
    utilityType: r.utility_type || "",
    documentRef: r.document_ref || "",
    linePattern: r.line_pattern || undefined,
    originalName: r.original_name || undefined,
    createdAt: r.created_at || undefined,
    createdBy: r.created_by || undefined,
    lastEditedBy: r.last_edited_by || undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

function annotationInsertValues(orgId: number, ann: Record<string, unknown>, geometry: unknown, aabb: Record<string, unknown> | null) {
  const annId = ann.id != null ? String(ann.id) : `ann_${randomBytes(8).toString("hex")}`;
  return [
    orgId,
    annId,
    JSON.stringify(geometry),
    aabb ? aabb.geom_type : null,
    aabb ? aabb.min_lng : null,
    aabb ? aabb.min_lat : null,
    aabb ? aabb.max_lng : null,
    aabb ? aabb.max_lat : null,
    ann.type != null ? String(ann.type) : null,
    ann.name != null ? String(ann.name) : null,
    ann.note != null ? String(ann.note) : null,
    ann.color != null ? String(ann.color) : null,
    ann.icon != null ? String(ann.icon) : null,
    ann.utilityType != null ? String(ann.utilityType) : null,
    ann.documentRef != null ? String(ann.documentRef) : null,
    ann.linePattern != null ? String(ann.linePattern) : null,
    ann.originalName != null ? String(ann.originalName) : null,
    ann.createdAt != null ? String(ann.createdAt) : null,
    ann.createdBy != null ? String(ann.createdBy) : null,
    ann.lastEditedBy != null ? String(ann.lastEditedBy) : null,
  ];
}

const WORKSPACE_ANNOTATION_INSERT_COLUMNS = `
  organization_id, ann_id, geometry, geom_type, min_lng, min_lat, max_lng, max_lat,
  annotation_type, name, note, color, icon, utility_type, document_ref, line_pattern,
  original_name, created_at, created_by, last_edited_by, updated_at
`;

const WORKSPACE_ANNOTATION_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP";

function layerRowToClient(layer: Record<string, unknown>, annotations: unknown[]) {
  return {
    id: layer.layer_id,
    name: layer.name || "",
    originalName: layer.original_name || layer.name || "",
    annotations,
    utilityType: layer.utility_type || "",
    createdAt: layer.created_at || undefined,
    isVisible: Number(layer.is_visible) !== 0,
    listInLayerPanel: Number(layer.list_in_layer_panel) !== 0,
    source: layer.source || undefined,
    organizationId: layer.organization_id,
    isPublic: Number(layer.is_public) === 1,
  };
}

function saveMapWorkspaceNormalized(
  db: ReturnType<typeof getDatabase>,
  orgId: number,
  annotations: unknown[],
  savedDataLayers: unknown[],
  cb: (e: Error | null) => void
) {
  db.run(`DELETE FROM map_workspace_annotations WHERE organization_id = ?`, [orgId], (e1: Error | null) => {
    if (e1) return cb(e1);
    db.run(`DELETE FROM map_workspace_layer_annotations WHERE organization_id = ?`, [orgId], (e2: Error | null) => {
      if (e2) return cb(e2);
      db.run(`DELETE FROM map_workspace_data_layers WHERE organization_id = ?`, [orgId], (e3: Error | null) => {
        if (e3) return cb(e3);

      function insAnn(i: number) {
        if (i >= annotations.length) return insLayer(0);
        const ann = annotations[i];
        if (!ann || typeof ann !== "object" || !(ann as { geometry?: unknown }).geometry) return insAnn(i + 1);
        const a = ann as Record<string, unknown> & { geometry: unknown };
        const g =
          typeof a.geometry === "object" && a.geometry !== null
            ? (a.geometry as object)
            : parseGeometryJson(a.geometry);
        if (!g) return insAnn(i + 1);
        const aabb = computeGeomAabbAndType(g);
        db.run(
          `INSERT INTO map_workspace_annotations
                     (${WORKSPACE_ANNOTATION_INSERT_COLUMNS})
                     VALUES (${WORKSPACE_ANNOTATION_PLACEHOLDERS})`,
          annotationInsertValues(orgId, a, g, aabb),
          () => insAnn(i + 1)
        );
      }

      function insLayer(j: number) {
        if (j >= savedDataLayers.length) {
          db.run(
            `
                        INSERT INTO map_workspace_state (organization_id, annotations_json, data_layers_json, updated_at)
                        VALUES (?, '[]', '[]', CURRENT_TIMESTAMP)
                        ON CONFLICT(organization_id) DO UPDATE SET
                            annotations_json = '[]',
                            data_layers_json = '[]',
                            updated_at = CURRENT_TIMESTAMP
                        `,
            [orgId],
            (e3: Error | null) => cb(e3)
          );
          return;
        }
        const layer = savedDataLayers[j];
        if (!layer || typeof layer !== "object") return insLayer(j + 1);
        const l = layer as Record<string, unknown> & { id?: unknown; annotations?: unknown[] };
        const lid = l.id != null ? String(l.id) : `layer_${randomBytes(8).toString("hex")}`;
        db.run(
          `INSERT INTO map_workspace_data_layers
             (organization_id, layer_id, name, original_name, source, utility_type, is_visible, list_in_layer_panel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            orgId,
            lid,
            l.name != null ? String(l.name) : null,
            l.originalName != null ? String(l.originalName) : null,
            l.source != null ? String(l.source) : null,
            l.utilityType != null ? String(l.utilityType) : null,
            l.isVisible === false ? 0 : 1,
            l.listInLayerPanel === false ? 0 : 1,
            l.createdAt != null ? String(l.createdAt) : null,
          ],
          (layerErr: Error | null) => {
            if (layerErr) return cb(layerErr);
            const layerAnnotations = Array.isArray(l.annotations) ? l.annotations : [];
            function insLayerAnn(k: number) {
              if (k >= layerAnnotations.length) return insLayer(j + 1);
              const ann = layerAnnotations[k];
              if (!ann || typeof ann !== "object" || !(ann as { geometry?: unknown }).geometry) {
                return insLayerAnn(k + 1);
              }
              const a = ann as Record<string, unknown> & { geometry: unknown };
              const g =
                typeof a.geometry === "object" && a.geometry !== null
                  ? (a.geometry as object)
                  : parseGeometryJson(a.geometry);
              if (!g) return insLayerAnn(k + 1);
              const aabb = computeGeomAabbAndType(g);
              const values = annotationInsertValues(orgId, a, g, aabb);
              db.run(
                `INSERT INTO map_workspace_layer_annotations
                   (${WORKSPACE_ANNOTATION_INSERT_COLUMNS.replace("organization_id, ann_id", "organization_id, layer_id, ann_id")})
                 VALUES (?, ${WORKSPACE_ANNOTATION_PLACEHOLDERS})`,
                [orgId, lid, ...values.slice(1)],
                () => insLayerAnn(k + 1)
              );
            }
            insLayerAnn(0);
          }
        );
      }

      insAnn(0);
      });
    });
  });
}

function touchMapWorkspaceStateUpdatedAt(
  db: ReturnType<typeof getDatabase>,
  orgId: number,
  cb: (e: Error | null) => void
) {
  db.run(
    `
    INSERT INTO map_workspace_state (organization_id, annotations_json, data_layers_json, updated_at)
    VALUES (?, '[]', '[]', CURRENT_TIMESTAMP)
    ON CONFLICT(organization_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `,
    [orgId],
    cb
  );
}

function saveMapWorkspaceAnnotationsOnly(
  db: ReturnType<typeof getDatabase>,
  orgId: number,
  annotations: unknown[],
  cb: (e: Error | null) => void
) {
  db.run(`DELETE FROM map_workspace_annotations WHERE organization_id = ?`, [orgId], (e1: Error | null) => {
    if (e1) return cb(e1);

    function insAnn(i: number) {
      if (i >= annotations.length) return touchMapWorkspaceStateUpdatedAt(db, orgId, cb);
      const ann = annotations[i];
      if (!ann || typeof ann !== "object" || !(ann as { geometry?: unknown }).geometry) return insAnn(i + 1);
      const a = ann as Record<string, unknown> & { geometry: unknown };
      const g =
        typeof a.geometry === "object" && a.geometry !== null
          ? (a.geometry as object)
          : parseGeometryJson(a.geometry);
      if (!g) return insAnn(i + 1);
      const aabb = computeGeomAabbAndType(g);
      db.run(
        `INSERT INTO map_workspace_annotations
                   (${WORKSPACE_ANNOTATION_INSERT_COLUMNS})
                   VALUES (${WORKSPACE_ANNOTATION_PLACEHOLDERS})`,
        annotationInsertValues(orgId, a, g, aabb),
        () => insAnn(i + 1)
      );
    }

    insAnn(0);
  });
}

function saveMapWorkspaceLayersOnly(
  db: ReturnType<typeof getDatabase>,
  orgId: number,
  savedDataLayers: unknown[],
  cb: (e: Error | null) => void
) {
  db.run(`DELETE FROM map_workspace_layer_annotations WHERE organization_id = ?`, [orgId], (e2: Error | null) => {
    if (e2) return cb(e2);
    db.run(`DELETE FROM map_workspace_data_layers WHERE organization_id = ?`, [orgId], (e3: Error | null) => {
      if (e3) return cb(e3);

      function insLayer(j: number) {
        if (j >= savedDataLayers.length) {
          return touchMapWorkspaceStateUpdatedAt(db, orgId, cb);
        }
        const layer = savedDataLayers[j];
        if (!layer || typeof layer !== "object") return insLayer(j + 1);
        const l = layer as Record<string, unknown> & { id?: unknown; annotations?: unknown[] };
        const lid = l.id != null ? String(l.id) : `layer_${randomBytes(8).toString("hex")}`;
        db.run(
          `INSERT INTO map_workspace_data_layers
             (organization_id, layer_id, name, original_name, source, utility_type, is_visible, list_in_layer_panel, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            orgId,
            lid,
            l.name != null ? String(l.name) : null,
            l.originalName != null ? String(l.originalName) : null,
            l.source != null ? String(l.source) : null,
            l.utilityType != null ? String(l.utilityType) : null,
            l.isVisible === false ? 0 : 1,
            l.listInLayerPanel === false ? 0 : 1,
            l.createdAt != null ? String(l.createdAt) : null,
          ],
          (layerErr: Error | null) => {
            if (layerErr) return cb(layerErr);
            const layerAnnotations = Array.isArray(l.annotations) ? l.annotations : [];
            function insLayerAnn(k: number) {
              if (k >= layerAnnotations.length) return insLayer(j + 1);
              const ann = layerAnnotations[k];
              if (!ann || typeof ann !== "object" || !(ann as { geometry?: unknown }).geometry) {
                return insLayerAnn(k + 1);
              }
              const a = ann as Record<string, unknown> & { geometry: unknown };
              const g =
                typeof a.geometry === "object" && a.geometry !== null
                  ? (a.geometry as object)
                  : parseGeometryJson(a.geometry);
              if (!g) return insLayerAnn(k + 1);
              const aabb = computeGeomAabbAndType(g);
              const values = annotationInsertValues(orgId, a, g, aabb);
              db.run(
                `INSERT INTO map_workspace_layer_annotations
                   (${WORKSPACE_ANNOTATION_INSERT_COLUMNS.replace("organization_id, ann_id", "organization_id, layer_id, ann_id")})
                 VALUES (?, ${WORKSPACE_ANNOTATION_PLACEHOLDERS})`,
                [orgId, lid, ...values.slice(1)],
                () => insLayerAnn(k + 1)
              );
            }
            insLayerAnn(0);
          }
        );
      }

      insLayer(0);
    });
  });
}

async function loadWorkspaceLayersForOrg(db: unknown, orgId: number) {
  const layerRows = await allRows(
    db,
    `SELECT * FROM map_workspace_data_layers WHERE organization_id = ? ORDER BY id`,
    [orgId]
  );
  if (layerRows.length === 0) return [];
  const featureRows = await allRows(
    db,
    `SELECT * FROM map_workspace_layer_annotations WHERE organization_id = ? ORDER BY layer_id, id`,
    [orgId]
  );
  const byLayer = new Map<string, unknown[]>();
  for (const feature of featureRows as Record<string, unknown>[]) {
    const lid = feature.layer_id != null ? String(feature.layer_id) : "";
    if (!lid) continue;
    if (!byLayer.has(lid)) byLayer.set(lid, []);
    byLayer.get(lid)!.push(annotationRowToClient(feature));
  }
  return (layerRows as Record<string, unknown>[]).map((layer) =>
    layerRowToClient(layer, byLayer.get(String(layer.layer_id || "")) || [])
  );
}

export function registerDataMapWorkspaceRoutes(data: DataApp) {
  data.get("/map-workspace", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
  
    const includeRaw = req.query.include != null ? String(req.query.include).trim().toLowerCase() : "all";
    const wantAnnotations = includeRaw === "all" || includeRaw === "annotations";
    const wantLayers = includeRaw === "all" || includeRaw === "layers";
  
    try {
      if (await isPublicCatalogOrgId(db, orgId)) {
        const empty: Record<string, unknown> = { updatedAt: null, savedDataLayersCount: 0 };
        if (wantAnnotations) empty.annotations = [];
        if (wantLayers) empty.savedDataLayers = [];
        return res.json(empty);
      }
      const row = await getRow(
        db,
        `SELECT annotations_json, data_layers_json, updated_at FROM map_workspace_state WHERE organization_id = ?`,
        [orgId]
      );
      let annotations: unknown[] = [];
      let savedDataLayers: unknown[] = [];
      let updatedAt = row ? row.updated_at : null;
      let savedDataLayersCount = 0;
  
      try {
        const annRows = wantAnnotations
          ? await allRows(
              db,
              `SELECT * FROM map_workspace_annotations WHERE organization_id = ? ORDER BY id`,
              [orgId]
            )
          : [];
        if (wantLayers) {
          savedDataLayers = await loadWorkspaceLayersForOrg(db, orgId);
          savedDataLayersCount = savedDataLayers.length;
        } else {
          const layerCountRow = await getRow(
            db,
            `SELECT COUNT(*) AS c FROM map_workspace_data_layers WHERE organization_id = ?`,
            [orgId]
          );
          savedDataLayersCount = layerCountRow && layerCountRow.c != null ? Number(layerCountRow.c) : 0;
        }
        if (wantAnnotations && annRows.length > 0) {
          annotations = annRows.map((r: Record<string, unknown>) => annotationRowToClient(r));
        }
        if (
          wantAnnotations &&
          annRows.length === 0 &&
          (!wantLayers ? savedDataLayersCount === 0 : savedDataLayers.length === 0) &&
          row
        ) {
          try {
            annotations = JSON.parse(String(row.annotations_json || "[]"));
          } catch (_) {
            annotations = [];
          }
          if (wantLayers) {
            try {
              savedDataLayers = JSON.parse(String(row.data_layers_json || "[]"));
            } catch (_) {
              savedDataLayers = [];
            }
            savedDataLayersCount = savedDataLayers.length;
          }
          updatedAt = row.updated_at;
        }
      } catch (e) {
        console.error("map-workspace normalized load:", e);
        if (row && wantAnnotations) {
          try {
            annotations = JSON.parse(String(row.annotations_json || "[]"));
          } catch (_) {
            annotations = [];
          }
          if (wantLayers) {
            try {
              savedDataLayers = JSON.parse(String(row.data_layers_json || "[]"));
            } catch (_) {
              savedDataLayers = [];
            }
            savedDataLayersCount = savedDataLayers.length;
          }
          updatedAt = row.updated_at;
        }
      }
  
      if (wantAnnotations && !Array.isArray(annotations)) annotations = [];
      if (wantLayers && !Array.isArray(savedDataLayers)) savedDataLayers = [];
  
      const payload: Record<string, unknown> = {
        updatedAt,
        savedDataLayersCount,
      };
      if (wantAnnotations) payload.annotations = annotations;
      if (wantLayers) payload.savedDataLayers = savedDataLayers;
      res.json(payload);
    } catch (e) {
      console.error("Error fetching map workspace:", e);
      res.status(500).json({ error: "Failed to fetch map workspace" });
    }
  });
  
  data.put("/map-workspace", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = resolveDataOrgId(req, res);
    if (orgId == null) return;
    if (!canMutateOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have permission to edit this organization" });
    }

    const body = (req.body || {}) as {
      annotations?: unknown;
      savedDataLayers?: unknown;
    };
    const hasAnnotations = Object.prototype.hasOwnProperty.call(body, "annotations");
    const hasLayers = Object.prototype.hasOwnProperty.call(body, "savedDataLayers");
    if (!hasAnnotations && !hasLayers) {
      return res.status(400).json({ error: "annotations and/or savedDataLayers are required" });
    }
    if (hasAnnotations && !Array.isArray(body.annotations)) {
      return res.status(400).json({ error: "annotations must be an array when provided" });
    }
    if (hasLayers && !Array.isArray(body.savedDataLayers)) {
      return res.status(400).json({ error: "savedDataLayers must be an array when provided" });
    }

    const policy = await applyMapWorkspaceSavePolicy(
      db,
      req.user,
      orgId,
      hasAnnotations ? (body.annotations as unknown[]) : null,
      hasLayers ? (body.savedDataLayers as unknown[]) : null
    );
    if (policy.ok === false) {
      return res.status(policy.status).json({ error: policy.error });
    }

    const onSaved = (runErr: Error | null) => {
      if (runErr) {
        console.error("Error saving map workspace:", runErr);
        return res.status(500).json({ error: "Failed to save map workspace" });
      }
      res.json({ message: "Map workspace saved", updatedAt: new Date().toISOString() });
    };

    if (hasAnnotations && hasLayers) {
      saveMapWorkspaceNormalized(
        db,
        orgId,
        policy.annotations,
        policy.savedDataLayers,
        onSaved
      );
    } else if (hasAnnotations) {
      saveMapWorkspaceAnnotationsOnly(db, orgId, policy.annotations, onSaved);
    } else {
      saveMapWorkspaceLayersOnly(db, orgId, policy.savedDataLayers, onSaved);
    }
  });
}

export function registerDataMapWorkspaceLayerPublicRoutes(data: DataApp) {
  data.patch("/map-workspace/layers/:layerId/public", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const layerId = req.params.layerId;
    const orgId =
      req.body.organizationId != null ? parseInt(String(req.body.organizationId), 10) : req.user.organizationId;
    if (!orgId || Number.isNaN(orgId)) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canAdminOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "Only organization admins can change public sharing for layers" });
    }
    const row = await getRow(
      db,
      "SELECT id FROM map_workspace_data_layers WHERE organization_id = ? AND layer_id = ?",
      [orgId, layerId]
    );
    if (!row) {
      return res.status(404).json({ error: "Layer not found" });
    }
    const isPublic = !!(req.body && req.body.isPublic);
    try {
      await runDb(
        db,
        "UPDATE map_workspace_data_layers SET is_public = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND layer_id = ?",
        [isPublic ? 1 : 0, orgId, layerId]
      );
      res.json({ layerId, isPublic });
    } catch (e) {
      console.error("PATCH /map-workspace/layers/:layerId/public:", e);
      res.status(500).json({ error: "Failed to update layer public flag" });
    }
  });
}
