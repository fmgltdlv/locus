// Data Hub routes — split from data.ts (Phase 3)
import { getDatabase } from "../database.js";
import { requireOrganizationMiddleware } from "../auth.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import { getRow, allRows } from "../lib/db.cjs";
import { assertOrgDataDeleteAllowed, assertOrgDataEditAllowed } from "../lib/orgDataPermissions.js";
import { computeGeomAabbAndType, parseGeometryJson } from "../lib/geoAabb.cjs";
import { resolveDataOrgIdRead, type DataApp } from "./dataShared.js";

export function registerDataGeospatialRoutes(data: DataApp) {
  data.post("/geospatial", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const { dataType, dataId, geometry, properties } = req.body as Record<string, unknown>;
    const orgId = req.orgId;
    if (!dataType || !dataId || !geometry) {
      return res.status(400).json({ error: "dataType, dataId, and geometry are required" });
    }
    const existing = await getRow(
      db,
      `SELECT user_id FROM geospatial_data WHERE organization_id = ? AND data_type = ? AND data_id = ?`,
      [orgId, dataType, dataId]
    );
    if (existing) {
      if (
        !(await assertOrgDataEditAllowed(
          req,
          res,
          db,
          orgId!,
          existing.user_id != null ? Number(existing.user_id) : null
        ))
      ) {
        return;
      }
    }
    const g = typeof geometry === "object" ? geometry : parseGeometryJson(geometry);
    const aabb = g ? computeGeomAabbAndType(g) : null;
    const geomStr = g ? JSON.stringify(g) : JSON.stringify(geometry);
    db.run(
      `
          INSERT OR REPLACE INTO geospatial_data 
          (organization_id, user_id, data_type, data_id, geometry, properties, geom_type, min_lng, min_lat, max_lng, max_lat, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
      [
        orgId,
        req.user.id,
        dataType,
        dataId,
        geomStr,
        properties ? JSON.stringify(properties) : null,
        aabb ? aabb.geom_type : null,
        aabb ? aabb.min_lng : null,
        aabb ? aabb.min_lat : null,
        aabb ? aabb.max_lng : null,
        aabb ? aabb.max_lat : null,
      ],
      function (err: Error | null) {
        if (err) {
          console.error("Error saving geospatial data:", err);
          return res.status(500).json({ error: "Failed to save geospatial data" });
        }
        res.json({
          id: this.lastID,
          message: "Geospatial data saved successfully",
        });
      }
    );
  });
  
  data.get("/geospatial", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return;
    const dataType = req.query.type;
    let q = `
          SELECT 
              id,
              data_type,
              data_id,
              geometry,
              properties,
              created_at,
              updated_at
          FROM geospatial_data
          WHERE organization_id = ?
      `;
    const params: unknown[] = [orgId];
    if (dataType) {
      q += " AND data_type = ?";
      params.push(dataType);
    }
    q += " ORDER BY created_at DESC";
    try {
      const rows = await allRows(db, q, params);
      const mapRow = (row: Record<string, unknown>, shareMeta: { sourceOrgId: number; displayLabel: string } | null) => {
        const base = {
          id: row.id,
          dataType: row.data_type,
          dataId: row.data_id,
          geometry: JSON.parse(String(row.geometry)),
          properties: row.properties ? JSON.parse(String(row.properties)) : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        if (shareMeta) {
          Object.assign(base, {
            shared: true,
            sharedFromOrganizationId: shareMeta.sourceOrgId,
            sharedSourceLabel: shareMeta.displayLabel,
          });
        }
        return base;
      };
      const out = (rows || []).map((row: Record<string, unknown>) => mapRow(row, null));
      res.json(out);
    } catch (e) {
      console.error("Error fetching geospatial data:", e);
      res.status(500).json({ error: "Failed to fetch geospatial data" });
    }
  });
  
  data.delete("/geospatial/:dataType/:dataId", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = req.orgId!;
    const { dataType, dataId } = req.params;
    if (!(await assertOrgDataDeleteAllowed(req, res, db, orgId))) return;
    db.run(
      `
          DELETE FROM geospatial_data
          WHERE organization_id = ? AND data_type = ? AND data_id = ?
      `,
      [orgId, dataType, dataId],
      function (err: Error | null) {
        if (err) {
          console.error("Error deleting geospatial data:", err);
          return res.status(500).json({ error: "Failed to delete geospatial data" });
        }
        if (this.changes === 0) {
          return res.status(404).json({ error: "Data not found" });
        }
        res.json({ message: "Geospatial data deleted successfully" });
      }
    );
  });
}
