// Data Hub routes — split from data.ts (Phase 3)
import { getDatabase } from "../database.js";
import { requireOrganizationMiddleware } from "../auth.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import { getRow, allRows, runDb } from "../lib/db.cjs";
import { assertOrgDataDeleteAllowed } from "../lib/orgDataPermissions.js";
import {
  getProductTierFromOrgRow,
  hasAerialEntitlementFromOrgRow,
  queryAerialMapsForView,
  queryAccessibleAerialMapsPaged,
  rowToMap,
  loadAllowedOrganizationsForMaps,
  orgAerialAccessWhereSql,
  orgCanAccessAerialMap,
  normalizeAccessMode,
  hiddenFromUsersForAccessMode,
  pruneAerialFavoritesForMapAccess,
  isValidAccessMode,
} from "../lib/aerialMapQuery.cjs";
import { registerAerialMapFromUrl } from "../lib/aerialMapRegister.cjs";
import {
  DEFAULT_PREFIX,
  DEFAULT_TILESET_SUFFIX,
  isValidGcsBucketName,
  listFoldersByPrefix,
  normalizeFolderQuery,
  normalizePrefix,
  normalizeTilesetSuffix,
  tilesetUrlForFolder,
} from "../lib/gcsBucketSearch.cjs";
import {
  resolveDataOrgIdRead,
  resolveDataOrgId,
  type DataApp,
} from "./dataShared.js";

type AerialBucketProviderRow = {
  id: number;
  name: string;
  bucket: string;
  prefix: string;
  tileset_suffix: string;
  enabled: number;
  created_at?: string;
  updated_at?: string;
};

function rowToBucketProvider(row: AerialBucketProviderRow) {
  return {
    id: Number(row.id),
    name: String(row.name || ""),
    bucket: String(row.bucket || ""),
    prefix: String(row.prefix || DEFAULT_PREFIX),
    tilesetSuffix: String(row.tileset_suffix || DEFAULT_TILESET_SUFFIX),
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function parseProviderWriteBody(body: Record<string, unknown> | null | undefined, partial: boolean) {
  const nameRaw = body?.name != null ? String(body.name).trim() : "";
  const bucketRaw = body?.bucket != null ? String(body.bucket).trim() : "";
  if (!partial && !nameRaw) {
    return { error: "Name is required" as const };
  }
  if (!partial && !bucketRaw) {
    return { error: "Bucket is required" as const };
  }
  if (bucketRaw && !isValidGcsBucketName(bucketRaw)) {
    return { error: "Invalid GCS bucket name" as const };
  }
  let prefix: string | undefined;
  let tilesetSuffix: string | undefined;
  try {
    if (!partial || body?.prefix != null) {
      prefix = normalizePrefix(body?.prefix);
    }
    if (!partial || body?.tilesetSuffix != null || body?.tileset_suffix != null) {
      tilesetSuffix = normalizeTilesetSuffix(body?.tilesetSuffix ?? body?.tileset_suffix);
    }
  } catch (e) {
    const err = e as Error;
    return { error: err.message || "Invalid prefix or tileset suffix" as const };
  }
  let enabled: number | undefined;
  if (body?.enabled != null) {
    enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0;
  } else if (!partial) {
    enabled = 1;
  }
  return {
    name: nameRaw || undefined,
    bucket: bucketRaw || undefined,
    prefix,
    tilesetSuffix,
    enabled,
  };
}

export function registerDataAerialRoutes(data: DataApp) {
  data.get("/aerial-maps/for-view", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
  
    const db = getDatabase();
    const zoom = req.query.zoom != null ? parseFloat(req.query.zoom) : NaN;
    const warm = req.query.warm === "1" || req.query.warm === "true";
    const mode = req.query.mode === "refresh" ? "refresh" : "auto";
    let bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null = null;
    if (req.query.bbox) {
      const parts = String(req.query.bbox)
        .split(",")
        .map((x) => parseFloat(String(x).trim()));
      if (parts.length === 4 && parts.every((x) => Number.isFinite(x))) {
        bbox = { minLng: parts[0], minLat: parts[1], maxLng: parts[2], maxLat: parts[3] };
      }
    }
  
    try {
      const result = await queryAerialMapsForView(db, orgId, { zoom, bbox, warm, mode } as Parameters<typeof queryAerialMapsForView>[2]);
      if (result.status === 400) {
        return res.status(400).json({ error: result.error || "Bad request" });
      }
      res.json({
        tier: result.tier,
        maps: result.maps || [],
        skipReason: result.skipReason,
        warmed: result.warmed,
      });
    } catch (e) {
      console.error("aerial-maps/for-view:", e);
      res.status(500).json({ error: "Failed to query aerial maps" });
    }
  });
  
  data.get("/aerial-maps/accessible", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
  
    let bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null = null;
    const rawBbox = req.query.bbox != null ? String(req.query.bbox) : "";
    if (rawBbox.trim()) {
      const parts = rawBbox.split(",").map((x) => parseFloat(String(x).trim()));
      if (parts.length === 4 && parts.every((x) => Number.isFinite(x))) {
        bbox = { minLng: parts[0], minLat: parts[1], maxLng: parts[2], maxLat: parts[3] };
      }
    }
    if (!bbox) {
      return res.status(400).json({ error: "bbox query is required (minLng,minLat,maxLng,maxLat)" });
    }
  
    const page = req.query.page != null ? parseInt(String(req.query.page), 10) : 1;
    const pageSize = req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : undefined;
  
    const db = getDatabase();
    try {
      const result = await queryAccessibleAerialMapsPaged(db, orgId, bbox, { page, pageSize });
      if (result.status === 400) {
        return res.status(400).json({ error: result.error || "Invalid bbox" });
      }
      res.json({
        tier: result.tier,
        maps: result.maps || [],
        total: result.total ?? 0,
        page: result.page ?? 1,
        pageSize: result.pageSize ?? 20,
        totalPages: result.totalPages ?? 0,
        bbox: result.bbox,
      });
    } catch (e) {
      console.error("aerial-maps/accessible:", e);
      res.status(500).json({ error: "Failed to query accessible aerial maps" });
    }
    return await res.getResponse();
  });
  
  data.post("/aerial-maps", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can add aerial maps" });
    }
    const db = getDatabase();
    const { url, capturedAt } = (req.body || {}) as { url?: string; capturedAt?: unknown };
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }
    const capAt =
      capturedAt && String(capturedAt).trim() !== "" ? new Date(String(capturedAt)).toISOString() : null;
    try {
      const result = await registerAerialMapFromUrl(db, req.user.id, url.trim(), { capturedAt: capAt });
      if (result.skipped === true) {
        return res.status(409).json({ error: "Aerial map with this URL already exists", id: result.id });
      }
      res.json({
        id: result.id,
        name: result.name,
        url: result.url,
        boundingBox: result.boundingBox,
        minNativeZoom: result.minNativeZoom,
        maxNativeZoom: result.maxNativeZoom,
        organizationId: null,
        capturedAt: result.capturedAt,
        createdAt: new Date().toISOString(),
        hiddenFromUsers: result.hiddenFromUsers === 1,
        message: "Aerial map added successfully",
      });
    } catch (error: unknown) {
      const err = error as Error;
      console.error("Error adding aerial map:", err);
      return res.status(400).json({
        error: err.message || "Failed to add aerial map",
      });
    }
    return await res.getResponse();
  });

  data.get("/aerial-maps/bucket-providers", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can manage aerial bucket providers" });
    }
    const db = getDatabase();
    try {
      const rows = (await allRows(
        db,
        `SELECT id, name, bucket, prefix, tileset_suffix, enabled, created_at, updated_at
         FROM aerial_bucket_providers
         ORDER BY name COLLATE NOCASE ASC, id ASC`,
        []
      )) as AerialBucketProviderRow[];
      res.json((rows || []).map((row) => rowToBucketProvider(row)));
    } catch (e) {
      console.error("aerial-maps/bucket-providers list:", e);
      res.status(500).json({ error: "Failed to list aerial bucket providers" });
    }
    return await res.getResponse();
  });

  data.post("/aerial-maps/bucket-providers", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can manage aerial bucket providers" });
    }
    const parsed = parseProviderWriteBody((req.body || {}) as Record<string, unknown>, false);
    if ("error" in parsed && parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const db = getDatabase();
    try {
      const result = await runDb(
        db,
        `INSERT INTO aerial_bucket_providers (name, bucket, prefix, tileset_suffix, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [parsed.name, parsed.bucket, parsed.prefix, parsed.tilesetSuffix, parsed.enabled]
      );
      const row = (await getRow(
        db,
        `SELECT id, name, bucket, prefix, tileset_suffix, enabled, created_at, updated_at
         FROM aerial_bucket_providers WHERE id = ?`,
        [result.lastID]
      )) as AerialBucketProviderRow | null;
      res.json(row ? rowToBucketProvider(row) : { id: result.lastID });
    } catch (e) {
      const err = e as Error;
      if (/unique|constraint/i.test(err.message || "")) {
        return res.status(409).json({ error: "A provider with this bucket and prefix already exists" });
      }
      console.error("aerial-maps/bucket-providers create:", e);
      res.status(500).json({ error: "Failed to add aerial bucket provider" });
    }
    return await res.getResponse();
  });

  data.patch("/aerial-maps/bucket-providers/:id", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can manage aerial bucket providers" });
    }
    const providerId = parseInt(req.params.id, 10);
    if (!providerId || Number.isNaN(providerId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const parsed = parseProviderWriteBody((req.body || {}) as Record<string, unknown>, true);
    if ("error" in parsed && parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (parsed.name != null) {
      sets.push("name = ?");
      params.push(parsed.name);
    }
    if (parsed.bucket != null) {
      sets.push("bucket = ?");
      params.push(parsed.bucket);
    }
    if (parsed.prefix != null) {
      sets.push("prefix = ?");
      params.push(parsed.prefix);
    }
    if (parsed.tilesetSuffix != null) {
      sets.push("tileset_suffix = ?");
      params.push(parsed.tilesetSuffix);
    }
    if (parsed.enabled != null) {
      sets.push("enabled = ?");
      params.push(parsed.enabled);
    }
    if (!sets.length) {
      return res.status(400).json({ error: "No fields to update" });
    }
    sets.push("updated_at = CURRENT_TIMESTAMP");
    params.push(providerId);
    const db = getDatabase();
    try {
      const result = await runDb(
        db,
        `UPDATE aerial_bucket_providers SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      if (!result.changes) {
        return res.status(404).json({ error: "Provider not found" });
      }
      const row = (await getRow(
        db,
        `SELECT id, name, bucket, prefix, tileset_suffix, enabled, created_at, updated_at
         FROM aerial_bucket_providers WHERE id = ?`,
        [providerId]
      )) as AerialBucketProviderRow | null;
      res.json(row ? rowToBucketProvider(row) : { id: providerId });
    } catch (e) {
      const err = e as Error;
      if (/unique|constraint/i.test(err.message || "")) {
        return res.status(409).json({ error: "A provider with this bucket and prefix already exists" });
      }
      console.error("aerial-maps/bucket-providers update:", e);
      res.status(500).json({ error: "Failed to update aerial bucket provider" });
    }
    return await res.getResponse();
  });

  data.delete("/aerial-maps/bucket-providers/:id", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can manage aerial bucket providers" });
    }
    const providerId = parseInt(req.params.id, 10);
    if (!providerId || Number.isNaN(providerId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const db = getDatabase();
    try {
      const result = await runDb(db, "DELETE FROM aerial_bucket_providers WHERE id = ?", [providerId]);
      if (!result.changes) {
        return res.status(404).json({ error: "Provider not found" });
      }
      res.json({ message: "Provider deleted", id: providerId });
    } catch (e) {
      console.error("aerial-maps/bucket-providers delete:", e);
      res.status(500).json({ error: "Failed to delete aerial bucket provider" });
    }
    return await res.getResponse();
  });

  data.get("/aerial-maps/bucket-search", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can search aerial bucket providers" });
    }
    const q = normalizeFolderQuery(req.query.q);
    if (!q) {
      return res.status(400).json({ error: "q is required" });
    }
    const providerIdRaw = req.query.providerId != null ? parseInt(String(req.query.providerId), 10) : NaN;
    const db = getDatabase();
    try {
      const rows = (await allRows(
        db,
        Number.isFinite(providerIdRaw) && providerIdRaw > 0
          ? `SELECT id, name, bucket, prefix, tileset_suffix, enabled, created_at, updated_at
             FROM aerial_bucket_providers WHERE id = ? AND enabled = 1`
          : `SELECT id, name, bucket, prefix, tileset_suffix, enabled, created_at, updated_at
             FROM aerial_bucket_providers WHERE enabled = 1 ORDER BY name COLLATE NOCASE ASC, id ASC`,
        Number.isFinite(providerIdRaw) && providerIdRaw > 0 ? [providerIdRaw] : []
      )) as AerialBucketProviderRow[];
      if (Number.isFinite(providerIdRaw) && providerIdRaw > 0 && !(rows || []).length) {
        return res.status(404).json({ error: "Provider not found or disabled" });
      }

      const results: {
        providerId: number;
        providerName: string;
        folder: string;
        tilesetUrl: string;
        alreadyInCatalog: boolean;
      }[] = [];
      const errors: { providerId: number; providerName: string; message: string }[] = [];
      let truncated = false;

      for (const row of rows || []) {
        const provider = rowToBucketProvider(row);
        try {
          const page = await listFoldersByPrefix(provider.bucket, provider.prefix, q, { maxPages: 3 });
          if (page.truncated) truncated = true;
          for (const folder of page.folders) {
            const tilesetUrl = tilesetUrlForFolder(
              provider.bucket,
              provider.prefix,
              folder,
              provider.tilesetSuffix
            );
            results.push({
              providerId: provider.id,
              providerName: provider.name,
              folder,
              tilesetUrl,
              alreadyInCatalog: false,
            });
          }
        } catch (e) {
          const err = e as Error;
          errors.push({
            providerId: provider.id,
            providerName: provider.name,
            message: err.message || "Failed to search bucket",
          });
        }
      }

      const urls = [...new Set(results.map((r) => r.tilesetUrl))];
      if (urls.length) {
        const placeholders = urls.map(() => "?").join(",");
        const existing = await allRows(
          db,
          `SELECT url FROM aerial_maps WHERE url IN (${placeholders})`,
          urls
        );
        const have = new Set((existing || []).map((r) => String(r.url)));
        for (const item of results) {
          item.alreadyInCatalog = have.has(item.tilesetUrl);
        }
      }

      res.json({
        query: q,
        results,
        errors,
        truncated,
      });
    } catch (e) {
      console.error("aerial-maps/bucket-search:", e);
      res.status(500).json({ error: "Failed to search aerial bucket providers" });
    }
    return await res.getResponse();
  });
  
  data.patch("/aerial-maps/:id/visibility", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can change aerial map visibility" });
    }
    const mapId = parseInt(req.params.id, 10);
    if (!mapId || Number.isNaN(mapId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const body = (req.body || {}) as { hiddenFromUsers?: unknown };
    if (typeof body.hiddenFromUsers !== "boolean") {
      return res.status(400).json({ error: "hiddenFromUsers boolean is required" });
    }
    const db = getDatabase();
    const accessMode = body.hiddenFromUsers ? "hidden" : "global";
    const hidden = hiddenFromUsersForAccessMode(accessMode);
    try {
      const result = await runDb(
        db,
        "UPDATE aerial_maps SET hidden_from_users = ?, access_mode = ? WHERE id = ? AND organization_id IS NULL",
        [hidden, accessMode, mapId]
      );
      if (!result.changes) {
        return res.status(404).json({ error: "Aerial map not found" });
      }
      await pruneAerialFavoritesForMapAccess(db, mapId);
      res.json({
        id: mapId,
        accessMode,
        hiddenFromUsers: body.hiddenFromUsers,
        message: "Visibility updated",
      });
    } catch (e) {
      console.error("aerial-maps visibility:", e);
      res.status(500).json({ error: "Failed to update visibility" });
    }
    return await res.getResponse();
  });
  
  data.patch("/aerial-maps/:id/access", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can change aerial map access" });
    }
    const mapId = parseInt(req.params.id, 10);
    if (!mapId || Number.isNaN(mapId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const body = (req.body || {}) as { accessMode?: unknown };
    const accessMode = String(body.accessMode || "").trim().toLowerCase();
    if (!isValidAccessMode(accessMode)) {
      return res.status(400).json({ error: "accessMode must be global, restricted, or hidden" });
    }
    const db = getDatabase();
    const hidden = hiddenFromUsersForAccessMode(accessMode);
    try {
      const result = await runDb(
        db,
        "UPDATE aerial_maps SET access_mode = ?, hidden_from_users = ? WHERE id = ? AND organization_id IS NULL",
        [accessMode, hidden, mapId]
      );
      if (!result.changes) {
        return res.status(404).json({ error: "Aerial map not found" });
      }
      await pruneAerialFavoritesForMapAccess(db, mapId);
      res.json({
        id: mapId,
        accessMode,
        hiddenFromUsers: accessMode === "hidden",
        message: "Access updated",
      });
    } catch (e) {
      console.error("aerial-maps access:", e);
      res.status(500).json({ error: "Failed to update access" });
    }
    return await res.getResponse();
  });
  
  data.put("/aerial-maps/:id/orgs", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can manage aerial map org access" });
    }
    const mapId = parseInt(req.params.id, 10);
    if (!mapId || Number.isNaN(mapId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const body = (req.body || {}) as { organizationIds?: unknown };
    const rawIds = Array.isArray(body.organizationIds) ? body.organizationIds : [];
    const organizationIds = [
      ...new Set(
        rawIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];
    const db = getDatabase();
    try {
      const mapRow = await getRow(
        db,
        "SELECT id, access_mode, hidden_from_users FROM aerial_maps WHERE id = ? AND organization_id IS NULL",
        [mapId]
      );
      if (!mapRow) {
        return res.status(404).json({ error: "Aerial map not found" });
      }
      if (organizationIds.length > 0) {
        const placeholders = organizationIds.map(() => "?").join(",");
        const existing = await allRows(
          db,
          `SELECT id FROM organizations WHERE id IN (${placeholders})`,
          organizationIds
        );
        if ((existing || []).length !== organizationIds.length) {
          return res.status(400).json({ error: "One or more organization IDs are invalid" });
        }
      }
      await runDb(db, "DELETE FROM aerial_map_org_access WHERE aerial_map_id = ?", [mapId]);
      const userId = req.user?.id != null ? Number(req.user.id) : null;
      for (const orgId of organizationIds) {
        await runDb(
          db,
          `INSERT INTO aerial_map_org_access (aerial_map_id, organization_id, created_by_user_id)
           VALUES (?, ?, ?)`,
          [mapId, orgId, Number.isFinite(userId) ? userId : null]
        );
      }
      await pruneAerialFavoritesForMapAccess(db, mapId);
      const accessMode = normalizeAccessMode(mapRow.access_mode, mapRow.hidden_from_users);
      const allowedOrganizations = await loadAllowedOrganizationsForMaps(db, [mapId]);
      res.json({
        id: mapId,
        accessMode,
        organizationIds,
        allowedOrganizations: allowedOrganizations.get(mapId) || [],
      });
    } catch (e) {
      console.error("aerial-maps orgs:", e);
      res.status(500).json({ error: "Failed to update org access" });
    }
    return await res.getResponse();
  });
  
  data.get("/aerial-maps", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can list the global aerial catalog" });
    }
    const db = getDatabase();
    try {
      const rows = await allRows(
        db,
        `
          SELECT
              a.id,
              a.name,
              a.url,
              a.min_lng,
              a.min_lat,
              a.max_lng,
              a.max_lat,
              a.min_native_zoom,
              a.max_native_zoom,
              a.captured_at,
              a.created_at,
              a.organization_id,
              a.hidden_from_users,
              a.access_mode,
              u.username as added_by
          FROM aerial_maps a
          LEFT JOIN users u ON u.id = a.user_id
          WHERE a.organization_id IS NULL
          ORDER BY COALESCE(a.captured_at, a.created_at) DESC, a.created_at DESC
      `,
        []
      );
      const allowByMap = await loadAllowedOrganizationsForMaps(
        db,
        (rows || []).map((row) => Number(row.id))
      );
      const maps = (rows || []).map((row) => {
        const mapId = Number(row.id);
        return rowToMap(row, {
          allowedOrganizations: allowByMap.get(mapId) || [],
        });
      });
      res.json(maps);
    } catch (e) {
      console.error("Error fetching aerial maps:", e);
      res.status(500).json({ error: "Failed to fetch aerial maps" });
    }
    return await res.getResponse();
  });
  
  data.get("/aerial-favorites", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
  
    const db = getDatabase();
    try {
      const orgRow = await getRow(db, "SELECT settings, subscription_tier FROM organizations WHERE id = ?", [orgId]);
      const productTier = getProductTierFromOrgRow(orgRow);
      if (!hasAerialEntitlementFromOrgRow(orgRow)) {
        return res.json({ maps: [], tier: productTier });
      }
      const favoriteIds = await allRows(
        db,
        "SELECT aerial_map_id FROM org_aerial_favorites WHERE organization_id = ?",
        [orgId]
      );
      for (const fav of favoriteIds || []) {
        const mapId = Number(fav.aerial_map_id);
        if (!Number.isFinite(mapId)) continue;
        const canAccess = await orgCanAccessAerialMap(db, orgId, mapId);
        if (!canAccess) {
          await runDb(
            db,
            "DELETE FROM org_aerial_favorites WHERE organization_id = ? AND aerial_map_id = ?",
            [orgId, mapId]
          );
        }
      }
      const access = orgAerialAccessWhereSql("a", orgId);
      const rows = await allRows(
        db,
        `
              SELECT
                  a.id,
                  a.name,
                  a.url,
                  a.min_lng,
                  a.min_lat,
                  a.max_lng,
                  a.max_lat,
                  a.min_native_zoom,
                  a.max_native_zoom,
                  a.captured_at,
                  a.created_at,
                  a.organization_id,
                  a.access_mode,
                  a.hidden_from_users,
                  u.username as added_by
              FROM org_aerial_favorites f
              JOIN aerial_maps a ON a.id = f.aerial_map_id
              LEFT JOIN users u ON u.id = a.user_id
              WHERE f.organization_id = ?
              ${access.sql}
              ORDER BY f.created_at DESC
          `,
        [orgId, ...access.params]
      );
      res.json({ maps: (rows || []).map((row) => rowToMap(row)), tier: "enhanced" });
    } catch (e) {
      console.error("aerial-favorites:", e);
      res.status(500).json({ error: "Failed to fetch favorites" });
    }
    return await res.getResponse();
  });
  
  data.post("/aerial-favorites", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = resolveDataOrgId(req, res);
    if (orgId == null) return await res.getResponse();
  
    const aerialMapId = parseInt((req.body as { aerialMapId?: unknown })?.aerialMapId as string, 10);
    if (!aerialMapId || Number.isNaN(aerialMapId)) {
      return res.status(400).json({ error: "aerialMapId is required" });
    }
  
    const db = getDatabase();
    try {
      const orgRow = await getRow(db, "SELECT settings, subscription_tier FROM organizations WHERE id = ?", [orgId]);
      if (!hasAerialEntitlementFromOrgRow(orgRow)) {
        return res.status(403).json({ error: "Favorites are not available for this organization" });
      }
      const mapRow = await getRow(
        db,
        "SELECT id FROM aerial_maps WHERE id = ? AND (organization_id IS NULL OR organization_id = ?)",
        [aerialMapId, orgId]
      );
      if (!mapRow) {
        return res.status(404).json({ error: "Aerial map not found" });
      }
      const canAccess = await orgCanAccessAerialMap(db, orgId, aerialMapId);
      if (!canAccess) {
        return res.status(403).json({ error: "This organization cannot access this aerial map" });
      }
      const result = await runDb(
        db,
        "INSERT OR IGNORE INTO org_aerial_favorites (organization_id, aerial_map_id) VALUES (?, ?)",
        [orgId, aerialMapId]
      );
      res.json({ message: "Saved", aerialMapId, changes: result.changes });
    } catch (e) {
      console.error("aerial-favorites insert:", e);
      res.status(500).json({ error: "Failed to save favorite" });
    }
    return await res.getResponse();
  });
  
  data.delete("/aerial-favorites/:aerialMapId", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = resolveDataOrgId(req, res);
    if (orgId == null) return await res.getResponse();

    const aerialMapId = parseInt(req.params.aerialMapId, 10);
    if (!aerialMapId || Number.isNaN(aerialMapId)) {
      return res.status(400).json({ error: "Invalid aerial map id" });
    }

    const db = getDatabase();
    if (!(await assertOrgDataDeleteAllowed(req, res, db, orgId))) return await res.getResponse();

    try {
      const orgRow = await getRow(db, "SELECT settings, subscription_tier FROM organizations WHERE id = ?", [orgId]);
      if (!orgRow) return res.status(404).json({ error: "Organization not found" });
      if (!hasAerialEntitlementFromOrgRow(orgRow)) {
        return res.status(403).json({ error: "Favorites are not available for this organization" });
      }
      const result = await runDb(
        db,
        "DELETE FROM org_aerial_favorites WHERE organization_id = ? AND aerial_map_id = ?",
        [orgId, aerialMapId]
      );
      if (!result.changes) return res.status(404).json({ error: "Favorite not found" });
      res.json({ message: "Removed", aerialMapId });
    } catch (delErr) {
      console.error("aerial-favorites delete:", delErr);
      res.status(500).json({ error: "Failed to remove favorite" });
    }
    return await res.getResponse();
  });
  
  data.delete("/aerial-maps/:id", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    if (req.user.role !== "dev") {
      return res.status(403).json({ error: "Only developers can delete aerial maps from the global catalog" });
    }
    const db = getDatabase();
    const mapId = parseInt(req.params.id, 10);
    if (!mapId || Number.isNaN(mapId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
  
    try {
      const result = await runDb(db, "DELETE FROM aerial_maps WHERE id = ? AND organization_id IS NULL", [mapId]);
      if (!result.changes) return res.status(404).json({ error: "Aerial map not found" });
      res.json({ message: "Aerial map deleted successfully" });
    } catch (delErr) {
      console.error("Error deleting aerial map:", delErr);
      res.status(500).json({ error: "Failed to delete aerial map" });
    }
    return await res.getResponse();
  });
}
