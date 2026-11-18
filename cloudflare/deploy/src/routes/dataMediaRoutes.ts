// Data Hub routes — split from data.ts (Phase 3)
import { randomBytes } from "node:crypto";
import { getDatabase } from "../database.js";
import {
  canAccessOrganization,
  canAdminOrganization,
  requireOrganizationMiddleware,
  ORG_REQUIRED_MESSAGE,
  verifyPassword,
} from "../auth.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import { safeParseJSON } from "../lib/utils.js";
import { getRow, allRows, runDb } from "../lib/db.cjs";
import { isPublicCatalogOrgId } from "../lib/publicShareQuery.cjs";
import {
  shouldGenerateThumbnail,
  generatePhotoThumbnailFromBuffer,
} from "../lib/mediaThumbnail.cjs";
import * as r2 from "../r2Worker.js";
import { computeGeomAabbAndType, parseGeometryJson } from "../lib/geoAabb.cjs";
import { recomputeTicketIds } from "../lib/ticketPhotoIntersection.cjs";
import { resolveAffectedTicketIdsForMediaDelete } from "../lib/mediaTicketJunction.cjs";
import {
  normalizePhotoTags,
  photoTagsIncludeWhitePaint,
  mergePhotoTagVocabulary,
  collectTagsFromMediaMetas,
} from "../lib/photoTags.cjs";
import {
  assertOrgDataDeleteAllowed,
  assertOrgDataEditAllowed,
} from "../lib/orgDataPermissions.js";
import {
  canReadOrgData,
  canViewerReadMediaFile,
  resolveDataOrgIdRead,
  MEDIA_TOKEN_TTL_MS,
  mediaPointFromRow,
  scheduleTicketIdsRecompute,
  scheduleJunctionSyncForMedia,
  scheduleTicketPhotoIntersectionRecompute,
  insertMediaAccessToken,
  getMediaAccessTokenRow,
  indexedFieldsFromMediaMeta,
  gpsSourceFromMediaMeta,
  applyGpsToMediaMeta,
  clearGpsFromMediaMeta,
  loadMediaEditorDisplayName,
  multipartMediaMiddleware,
  type DataApp,
} from "./dataShared.js";

export function registerDataMediaBinaryRoutes(data: DataApp) {
  data.get("/media/:id/file", async (c) => {
    const db = getDatabase();
    const fileId = parseInt(c.req.param("id"), 10);
    const token = c.req.query("token");
    const row = await getRow(
      db,
      "SELECT file_path, file_name, mime_type, organization_id, is_public FROM media_files WHERE id = ?",
      [fileId]
    );
    if (!row) return c.json({ error: "File not found" }, 404);
    if (token) {
      const tok = await getMediaAccessTokenRow(db, token);
      if (!tok || Number(tok.mediaId) !== fileId) return c.json({ error: "Invalid or expired token" }, 403);
    } else {
      const build = buildExpressReq(c);
      const res = new ResShim(c);
      const viewerOrg = await resolveDataOrgIdRead(build, res);
      if (viewerOrg == null) return await res.getResponse();
      if (!(await canViewerReadMediaFile(db, build.user, viewerOrg, row))) {
        return c.json({ error: "Access denied" }, 403);
      }
    }
    const storageKey = String(row.file_path || "").replace(/\\/g, "/");
    if (!r2.isR2ObjectKey(storageKey)) {
      return c.json({ error: "File not available in Workers storage (expected R2 key)" }, 404);
    }
    if (!r2.isR2Configured()) return c.json({ error: "Object storage is not configured" }, 503);
    try {
      const { body, contentType } = await r2.getObjectStream(storageKey);
      const mimeType = row.mime_type || contentType || "application/octet-stream";
      return new Response(body, {
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": "inline",
        },
      });
    } catch (e) {
      console.error("media file R2:", e);
      return c.json({ error: "Failed to load file" }, 500);
    }
  });
  
  data.get("/media/:id/thumbnail", async (c) => {
    const db = getDatabase();
    const fileId = parseInt(c.req.param("id"), 10);
    const token = c.req.query("token");
    const row = await getRow(
      db,
      "SELECT thumbnail_path, file_path, mime_type, organization_id, is_public FROM media_files WHERE id = ?",
      [fileId]
    );
    if (!row) return c.json({ error: "File not found" }, 404);
    if (token) {
      const tok = await getMediaAccessTokenRow(db, token);
      if (!tok || Number(tok.mediaId) !== fileId) return c.json({ error: "Invalid or expired token" }, 403);
    } else {
      const build = buildExpressReq(c);
      const res = new ResShim(c);
      const viewerOrg = await resolveDataOrgIdRead(build, res);
      if (viewerOrg == null) return await res.getResponse();
      if (!(await canViewerReadMediaFile(db, build.user, viewerOrg, row))) {
        return c.json({ error: "Access denied" }, 403);
      }
    }
    const thumbKey = String(row.thumbnail_path || "").replace(/\\/g, "/");
    const fileKey = String(row.file_path || "").replace(/\\/g, "/");
    const storageKey =
      row.thumbnail_path && r2.isR2ObjectKey(thumbKey)
        ? thumbKey
        : r2.isR2ObjectKey(fileKey)
          ? fileKey
          : null;
    if (!storageKey) return c.json({ error: "Thumbnail not available" }, 404);
    if (!r2.isR2Configured()) return c.json({ error: "Object storage is not configured" }, 503);
    try {
      const { body, contentType } = await r2.getObjectStream(storageKey);
      const mimeType =
        storageKey === thumbKey
          ? "image/jpeg"
          : row.mime_type || contentType || "application/octet-stream";
      return new Response(body, {
        headers: { "Content-Type": mimeType, "Content-Disposition": "inline" },
      });
    } catch (e) {
      console.error("media thumbnail R2:", e);
      return c.json({ error: "Failed to load thumbnail" }, 500);
    }
  });
}

export function registerDataMediaUploadListRoutes(data: DataApp) {
  data.post("/media", multipartMediaMiddleware, (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const bodyOrgId = req.body && (req.body as Record<string, unknown>).organizationId != null
      ? parseInt(String((req.body as Record<string, unknown>).organizationId), 10)
      : null;
    const userId = req.user.id;
  
    function doUpload(orgId: number) {
      if (!orgId) {
        return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const { fileType, metadata } = req.body as Record<string, unknown>;
      if (!fileType) {
        return res.status(400).json({ error: "fileType is required" });
      }
      if (!r2.isR2Configured()) {
        return res.status(503).json({ error: "R2 is not configured (required on Workers)" });
      }
      const fileBuffer = req.file.buffer;
      const pendingRel = `uploads/mem_${randomBytes(16).toString("hex")}`;
      const metadataToStore =
        metadata == null ? null : typeof metadata === "string" ? metadata : JSON.stringify(metadata);
      const metaObj: Record<string, unknown> = metadataToStore ? safeParseJSON(metadataToStore, {}) : {};
      const ix = indexedFieldsFromMediaMeta(metaObj);
  
      db.run(
        `
              INSERT INTO media_files 
              (organization_id, user_id, file_name, file_type, file_size, file_path, mime_type, metadata, thumbnail_path,
               note_text, note_last_edited_by, note_last_edited_at, batch_id, batch_name, latitude, longitude, has_gps)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        [
          orgId,
          userId,
          req.file.originalname,
          fileType,
          req.file.size,
          pendingRel,
          req.file.mimetype,
          metadataToStore,
          null,
          ix.note,
          ix.nBy,
          ix.nAt,
          ix.bid,
          ix.bname,
          ix.lat,
          ix.lng,
          ix.hasGps,
        ],
        function (err: Error | null) {
          if (err) {
            console.error("Error saving media file:", err);
            return res.status(500).json({ error: "Failed to save media file" });
          }
          const newId = Number((this as { lastID: number }).lastID);
  
          function sendUploadJson(thumbnailPathRel: string | null, filePathForPayload: string | null) {
            const fp = filePathForPayload != null ? filePathForPayload : pendingRel;
            db.get(
              `
                  SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) as uploaded_by
                  FROM media_files m
                  JOIN users u ON u.id = m.user_id
                  WHERE m.id = ?
              `,
              [newId],
              (lookupErr: Error | null, urow: { uploaded_by?: string }) => {
                const uploadedBy =
                  !lookupErr && urow && urow.uploaded_by
                    ? urow.uploaded_by
                    : (req.user.username || req.user.email || null);
                const payload: Record<string, unknown> = {
                  id: newId,
                  fileName: req.file.originalname,
                  fileSize: req.file.size,
                  filePath: fp,
                  url: `/api/data/media/${newId}/file`,
                  uploadedBy,
                  message: "Media file uploaded successfully",
                };
                if (thumbnailPathRel) {
                  payload.thumbnailUrl = `/api/data/media/${newId}/thumbnail`;
                }
                res.json(payload);
              }
            );
          }
  
          db.run(
            `
                  UPDATE organizations 
                  SET storage_used = storage_used + ?,
                      updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
              `,
            [req.file.size, orgId],
            function (storageErr: Error | null) {
              if (storageErr) {
                console.error("Error bumping organization storage:", storageErr);
                db.run("DELETE FROM media_files WHERE id = ?", [newId], () => {
                  res.status(500).json({ error: "Failed to save media file" });
                });
                return;
              }
  
              void (async () => {
                const mainKey = r2.objectKeyMain(orgId, newId);
                const thumbKey = r2.objectKeyThumb(orgId, newId);
                let uploadedMain = false;
                let uploadedThumb = false;
                try {
                  const clientThumb = c.get("multerThumb") as { buffer?: Buffer; mimetype?: string } | undefined;
                  let thumbBuf: Buffer | null = null;
                  if (clientThumb && clientThumb.buffer && clientThumb.buffer.length) {
                    thumbBuf = clientThumb.buffer;
                  } else if (shouldGenerateThumbnail(String(fileType), req.file.mimetype)) {
                    thumbBuf = await generatePhotoThumbnailFromBuffer(fileBuffer);
                  }
                  await r2.putObjectFromBuffer(mainKey, fileBuffer, req.file.mimetype);
                  uploadedMain = true;
                  let thumbKeyForDb: string | null = null;
                  if (thumbBuf && thumbBuf.length) {
                    await r2.putObjectFromBuffer(thumbKey, thumbBuf, "image/jpeg");
                    uploadedThumb = true;
                    thumbKeyForDb = thumbKey;
                  }
                  await new Promise<void>((resolve, reject) => {
                    db.run(
                      "UPDATE media_files SET file_path = ?, thumbnail_path = ? WHERE id = ?",
                      [mainKey, thumbKeyForDb, newId],
                      (e: Error | null) => (e ? reject(e) : resolve())
                    );
                  });
                  scheduleTicketPhotoIntersectionRecompute(c, db, orgId, {
                    newPoints: [{ lat: ix.lat, lng: ix.lng, hasGps: ix.hasGps === 1 }],
                  });
                  scheduleJunctionSyncForMedia(c, db, orgId, newId, metaObj, {
                    lat: ix.lat,
                    lng: ix.lng,
                    hasGps: ix.hasGps === 1,
                  });
                  const uploadAssocId =
                    metaObj.associatedTicketId != null ? Number(metaObj.associatedTicketId) : null;
                  if (Number.isFinite(uploadAssocId) && uploadAssocId > 0) {
                    const assocTask = recomputeTicketIds(db, orgId, [uploadAssocId]).catch((e: unknown) => {
                      console.warn("[ticketPhotoIntersection] upload association recompute:", (e as Error).message || e);
                    });
                    const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
                    if (ctx && typeof ctx.waitUntil === "function") {
                      ctx.waitUntil(assocTask);
                    } else {
                      void assocTask;
                    }
                  }
                  sendUploadJson(thumbKeyForDb, mainKey);
                } catch (r2Err) {
                  console.error("R2 upload error:", r2Err);
                  if (uploadedMain) await r2.deleteObjectKey(mainKey).catch(() => {});
                  if (uploadedThumb) await r2.deleteObjectKey(thumbKey).catch(() => {});
                  await new Promise<void>((resolve, reject) => {
                    db.run("DELETE FROM media_files WHERE id = ?", [newId], (e: Error | null) =>
                      e ? reject(e) : resolve()
                    );
                  });
                  await new Promise<void>((resolve, reject) => {
                    db.run(
                      "UPDATE organizations SET storage_used = storage_used - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                      [req.file.size, orgId],
                      (e: Error | null) => (e ? reject(e) : resolve())
                    );
                  });
                  res.status(500).json({ error: "Failed to store media file" });
                }
              })();
            }
          );
        }
      );
    }
  
    if (bodyOrgId != null) {
      if (!canAccessOrganization(req.user, bodyOrgId)) return res.status(403).json({ error: "You do not have access to that organization" });
      doUpload(bodyOrgId);
    } else {
      doUpload(req.user.organizationId!);
    }
  });
  
  data.get("/media/:id/access-token", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const viewerOrg = await resolveDataOrgIdRead(req, res);
    if (viewerOrg == null) return await res.getResponse();
    const db = getDatabase();
    const fileId = parseInt(req.params.id, 10);
    try {
      const row = await getRow(db, "SELECT id, organization_id, is_public FROM media_files WHERE id = ?", [fileId]);
      if (!row) return res.status(404).json({ error: "File not found" });
      if (!(await canViewerReadMediaFile(db, req.user, viewerOrg, row))) {
        return res.status(403).json({ error: "Access denied" });
      }
      const token = randomBytes(24).toString("hex");
      await insertMediaAccessToken(db, token, fileId, Date.now() + MEDIA_TOKEN_TTL_MS);
      res.json({ token });
    } catch (e) {
      console.error("access-token:", e);
      res.status(500).json({ error: "Failed to verify access" });
    }
  });
  
  data.get(
    "/media",
    async (c) => {
      const req = buildExpressReq(c);
      const res = c.get("expressRes") as ResShim;
      const db = getDatabase();
      const queryOrgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : null;
      const userId = req.user.id;
  
      async function returnMedia(orgId: number) {
        if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
        }
        if (await isPublicCatalogOrgId(db, orgId)) {
          return res.json([]);
        }
        const fileType = req.query.type;
        const notThumbFileSql = `AND NOT (LOWER(REPLACE(m.file_path, '\\', '/')) GLOB '*_thumb.jpg')`;
        let query = `
          SELECT 
              m.id,
              m.user_id,
              m.file_name,
              m.file_type,
              m.file_size,
              m.file_path,
              m.thumbnail_path,
              m.mime_type,
              m.metadata,
              m.created_at,
              m.is_public,
              COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) as uploaded_by
          FROM media_files m
          LEFT JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ?
          ${notThumbFileSql}
      `;
        const params: unknown[] = [orgId];
        if (fileType) {
          query += " AND m.file_type = ?";
          params.push(fileType);
        }
        query += " ORDER BY m.created_at DESC";
        db.all(query, params, async (err: Error | null, rows: Record<string, unknown>[]) => {
          if (err) {
            console.error("Error fetching media files:", err);
            return res.status(500).json({ error: "Failed to fetch media files" });
          }
          const mapFile = (row: Record<string, unknown>) => ({
            id: row.id,
            uploadedByUserId: row.user_id != null ? Number(row.user_id) : null,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            filePath: row.file_path,
            thumbnailPath: row.thumbnail_path,
            url: `/api/data/media/${row.id}/file`,
            thumbnailUrl: row.thumbnail_path ? `/api/data/media/${row.id}/thumbnail` : undefined,
            mimeType: row.mime_type,
            metadata: row.metadata ? safeParseJSON(String(row.metadata), {}) : {},
            createdAt: row.created_at,
            uploadedBy: row.uploaded_by,
            isPublic: Number(row.is_public) === 1,
          });
          const files = (rows || []).map((row) => mapFile(row));
          res.json(files);
        });
      }
  
      if (queryOrgId != null) {
        if (Number.isNaN(queryOrgId)) {
          return res.status(400).json({ error: "Invalid organizationId" });
        }
        if (!(await canReadOrgData(req.user, queryOrgId))) {
          return res.status(403).json({ error: "You do not have access to that organization" });
        }
        await returnMedia(queryOrgId);
      } else {
        await returnMedia(req.user.organizationId!);
      }
    }
  );
}

export function registerDataMediaAnnotationRoutes(data: DataApp) {
  data.get("/media/:id/annotations", requireOrganizationMiddleware, (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = req.orgId!;
    const fileId = parseInt(req.params.id, 10);
    db.get(
      `
          SELECT da.annotations_json, da.updated_at
          FROM document_annotations da
          INNER JOIN media_files m ON m.id = da.media_file_id AND m.organization_id = da.organization_id
          WHERE da.media_file_id = ? AND da.organization_id = ?
      `,
      [fileId, orgId],
      (err: Error | null, row: { annotations_json?: string; updated_at?: string } | undefined) => {
        if (err) {
          console.error("Error fetching document annotations:", err);
          return res.status(500).json({ error: "Failed to fetch annotations" });
        }
        if (!row) {
          return res.json({ annotations: [], updatedAt: null });
        }
        try {
          const annotations = JSON.parse(row.annotations_json || "[]");
          res.json({ annotations, updatedAt: row.updated_at });
        } catch (_) {
          res.json({ annotations: [], updatedAt: row.updated_at });
        }
      }
    );
  });
  
  data.put("/media/:id/annotations", requireOrganizationMiddleware, async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = req.orgId!;
    const fileId = parseInt(req.params.id, 10);
    const { annotations } = (req.body || {}) as { annotations?: unknown };
    if (!Array.isArray(annotations)) {
      return res.status(400).json({ error: "annotations array is required" });
    }
    const ownerRow = await getRow(db, "SELECT id, organization_id, user_id FROM media_files WHERE id = ? AND organization_id = ?", [
      fileId,
      orgId,
    ]);
    if (!ownerRow) {
      return res.status(404).json({ error: "File not found" });
    }
    if (!(await assertOrgDataEditAllowed(req, res, db, orgId, ownerRow.user_id != null ? Number(ownerRow.user_id) : null))) {
      return;
    }
    const annotationsJson = JSON.stringify(annotations);
    try {
      await runDb(
        db,
        `
              INSERT INTO document_annotations (media_file_id, organization_id, annotations_json, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(media_file_id) DO UPDATE SET
                  annotations_json = excluded.annotations_json,
                  updated_at = CURRENT_TIMESTAMP
          `,
        [fileId, orgId, annotationsJson]
      );
      res.json({ message: "Annotations saved", updatedAt: new Date().toISOString() });
    } catch (runErr) {
      console.error("Error saving document annotations:", runErr);
      res.status(500).json({ error: "Failed to save annotations" });
    }
  });
}

export function registerDataMediaCrudRoutes(data: DataApp) {
  data.get("/media/photo-tags", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    const db = getDatabase();
    try {
      if (await isPublicCatalogOrgId(db, orgId)) {
        return res.json(mergePhotoTagVocabulary([]));
      }
      const notThumbFileSql = `AND NOT (LOWER(REPLACE(m.file_path, '\\', '/')) GLOB '*_thumb.jpg')`;
      const rows = await allRows(
        db,
        `SELECT m.metadata FROM media_files m
         WHERE m.organization_id = ? AND m.file_type = 'photo' ${notThumbFileSql}`,
        [orgId]
      );
      const metas = (rows || []).map((row: Record<string, unknown>) => {
        const parsed = safeParseJSON(row.metadata, {});
        return parsed != null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      });
      const orgTags = collectTagsFromMediaMetas(metas);
      return res.json(mergePhotoTagVocabulary(orgTags));
    } catch (err) {
      console.error("Error fetching photo tags:", err);
      return res.status(500).json({ error: "Failed to fetch photo tags" });
    }
  });
  
  data.get("/media/:id", requireOrganizationMiddleware, (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = req.orgId!;
    const fileId = parseInt(req.params.id, 10);
  
    db.get(
      `
          SELECT 
              m.id,
              m.file_name,
              m.file_type,
              m.file_size,
              m.file_path,
              m.thumbnail_path,
              m.mime_type,
              m.metadata,
              m.created_at,
              COALESCE(NULLIF(TRIM(u.full_name), ''), u.username, u.email) as uploaded_by
          FROM media_files m
          LEFT JOIN users u ON u.id = m.user_id
          WHERE m.id = ? AND m.organization_id = ?
      `,
      [fileId, orgId],
      (err: Error | null, row: Record<string, unknown> | undefined) => {
        if (err) {
          console.error("Error fetching media file:", err);
          return res.status(500).json({ error: "Failed to fetch media file" });
        }
  
        if (!row) {
          return res.status(404).json({ error: "File not found" });
        }
  
        const file = {
          id: row.id,
          fileName: row.file_name,
          fileType: row.file_type,
          fileSize: row.file_size,
          filePath: row.file_path,
          mimeType: row.mime_type,
          metadata: safeParseJSON(String(row.metadata || ""), null),
          createdAt: row.created_at,
          uploadedBy: row.uploaded_by,
          url: `/api/data/media/${row.id}/file`,
          thumbnailUrl: row.thumbnail_path ? `/api/data/media/${row.id}/thumbnail` : undefined,
        };
  
        res.json(file);
      }
    );
  });
  
  data.patch("/media/:id", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const fileId = parseInt(req.params.id, 10);
    const queryOrgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : null;
    const orgId = queryOrgId != null ? queryOrgId : req.user.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canAccessOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have access to that organization" });
    }
    const ownerRow = await getRow(db, "SELECT user_id FROM media_files WHERE id = ? AND organization_id = ?", [
      fileId,
      orgId,
    ]);
    if (!ownerRow) {
      return res.status(404).json({ error: "File not found" });
    }
    if (!(await assertOrgDataEditAllowed(req, res, db, orgId, ownerRow.user_id != null ? Number(ownerRow.user_id) : null))) {
      return;
    }
    const body = req.body as Record<string, unknown>;
    const hasNote = body && Object.prototype.hasOwnProperty.call(body, "note");
    const hasBatchName = body && Object.prototype.hasOwnProperty.call(body, "batchName");
    const hasLat = body && Object.prototype.hasOwnProperty.call(body, "lat");
    const hasLng = body && Object.prototype.hasOwnProperty.call(body, "lng");
    const hasHasGPS = body && Object.prototype.hasOwnProperty.call(body, "hasGPS");
    const hasGpsUpdate = hasLat || hasLng || hasHasGPS;
    const hasAssociatedTicketId = body && Object.prototype.hasOwnProperty.call(body, "associatedTicketId");
    const hasAssociationSource = body && Object.prototype.hasOwnProperty.call(body, "associationSource");
    const hasDirtEventId = body && Object.prototype.hasOwnProperty.call(body, "dirtEventId");
    const hasHasWhitePaintMark = body && Object.prototype.hasOwnProperty.call(body, "hasWhitePaintMark");
    const hasTags = body && Object.prototype.hasOwnProperty.call(body, "tags");
    const hasGeometry = body && Object.prototype.hasOwnProperty.call(body, "geometry");
    if (!hasNote && !hasBatchName && !hasGpsUpdate && !hasAssociatedTicketId && !hasAssociationSource && !hasDirtEventId && !hasHasWhitePaintMark && !hasTags && !hasGeometry) {
      return res.status(400).json({ error: "No updates provided" });
    }
    if (hasNote && typeof body.note !== "string") {
      return res.status(400).json({ error: "note must be a string" });
    }
    if (hasBatchName && typeof body.batchName !== "string") {
      return res.status(400).json({ error: "batchName must be a string" });
    }
    if ((hasLat && !hasLng) || (!hasLat && hasLng)) {
      return res.status(400).json({ error: "lat and lng must be provided together" });
    }
    if (hasLat || hasLng) {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lat/lng must be valid coordinates" });
      }
    }
    if (hasHasGPS && typeof body.hasGPS !== "boolean") {
      return res.status(400).json({ error: "hasGPS must be a boolean" });
    }
    if (hasAssociatedTicketId && body.associatedTicketId != null) {
      const tid = Number(body.associatedTicketId);
      if (!Number.isFinite(tid) || tid <= 0) {
        return res.status(400).json({ error: "associatedTicketId must be a positive number or null" });
      }
    }
    if (hasHasWhitePaintMark && typeof body.hasWhitePaintMark !== "boolean") {
      return res.status(400).json({ error: "hasWhitePaintMark must be a boolean" });
    }
    if (hasTags && !Array.isArray(body.tags)) {
      return res.status(400).json({ error: "tags must be an array of strings" });
    }
    if (hasTags) {
      for (const t of body.tags as unknown[]) {
        if (typeof t !== "string") {
          return res.status(400).json({ error: "tags must be an array of strings" });
        }
      }
    }
    let parsedGeometry: object | null = null;
    if (hasGeometry) {
      if (body.geometry == null) {
        parsedGeometry = null;
      } else {
        const g =
          typeof body.geometry === "object" && body.geometry !== null
            ? (body.geometry as object)
            : parseGeometryJson(body.geometry);
        if (!g || typeof g !== "object") {
          return res.status(400).json({ error: "geometry must be a GeoJSON geometry object or null" });
        }
        const gType = String((g as { type?: unknown }).type || "");
        if (gType !== "Point" && gType !== "LineString" && gType !== "Polygon") {
          return res.status(400).json({
            error: "geometry.type must be Point, LineString, or Polygon",
          });
        }
        if (!computeGeomAabbAndType(g)) {
          return res.status(400).json({ error: "geometry must include valid coordinates" });
        }
        parsedGeometry = g;
      }
    }
  
    try {
      const row = await getRow(
        db,
        "SELECT metadata, latitude, longitude, has_gps FROM media_files WHERE id = ? AND organization_id = ?",
        [fileId, orgId]
      );
      if (!row) {
        return res.status(404).json({ error: "File not found" });
      }
      const oldPoint = mediaPointFromRow(row as Record<string, unknown>);
      let meta = safeParseJSON(row.metadata, {});
      if (meta == null || typeof meta !== "object") {
        meta = {};
      }
      const metaRec = meta as Record<string, unknown>;
      const priorAssociatedTicketId =
        metaRec.associatedTicketId != null ? Number(metaRec.associatedTicketId) : null;
  
      if (hasBatchName) {
        metaRec.batchName = body.batchName;
      }
  
      if (hasAssociatedTicketId) {
        if (body.associatedTicketId == null || body.associatedTicketId === "") {
          delete metaRec.associatedTicketId;
          delete metaRec.associationSource;
          delete metaRec.associatedAt;
        } else {
          metaRec.associatedTicketId = Number(body.associatedTicketId);
          metaRec.associatedAt = new Date().toISOString();
          if (hasAssociationSource && typeof body.associationSource === "string" && body.associationSource.trim()) {
            metaRec.associationSource = body.associationSource.trim();
          } else if (!metaRec.associationSource) {
            metaRec.associationSource = "manual";
          }
        }
      } else if (hasAssociationSource && typeof body.associationSource === "string" && body.associationSource.trim()) {
        metaRec.associationSource = body.associationSource.trim();
      }
  
      if (hasDirtEventId) {
        if (body.dirtEventId == null || body.dirtEventId === "") {
          delete metaRec.dirtEventId;
        } else {
          metaRec.dirtEventId = String(body.dirtEventId);
        }
      }
  
      if (hasTags) {
        metaRec.tags = normalizePhotoTags(body.tags);
        metaRec.hasWhitePaintMark = photoTagsIncludeWhitePaint(metaRec.tags);
      } else if (hasHasWhitePaintMark) {
        metaRec.hasWhitePaintMark = body.hasWhitePaintMark === true;
      }
  
      if (hasGpsUpdate) {
        const gpsEnabled = hasHasGPS ? body.hasGPS === true : hasLat && hasLng;
        const priorSource = gpsSourceFromMediaMeta(metaRec, row as { latitude?: number; longitude?: number });
        const priorLat =
          metaRec.lat != null
            ? Number(metaRec.lat)
            : row.latitude != null
              ? Number(row.latitude)
              : NaN;
        const priorLng =
          metaRec.lng != null
            ? Number(metaRec.lng)
            : row.longitude != null
              ? Number(row.longitude)
              : NaN;
        const hadManualGps =
          priorSource === "Manual" && Number.isFinite(priorLat) && Number.isFinite(priorLng);
  
        if (gpsEnabled && hasLat && hasLng) {
          const newLat = Number(body.lat);
          const newLng = Number(body.lng);
          const coordsChanged =
            hadManualGps &&
            (Math.abs(newLat - priorLat) > 1e-7 || Math.abs(newLng - priorLng) > 1e-7);
          if (coordsChanged) {
            const password = body.password != null ? String(body.password) : "";
            if (!password.trim()) {
              return res.status(400).json({
                error: "Account password is required to change manual GPS coordinates",
              });
            }
            const pwdRow = await getRow(db, "SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
            if (!pwdRow || !pwdRow.password_hash) {
              return res.status(500).json({ error: "Account password not available" });
            }
            if (!verifyPassword(password, String(pwdRow.password_hash))) {
              return res.status(403).json({ error: "Invalid password" });
            }
          }
          const editorLabel = await loadMediaEditorDisplayName(db, req.user);
          const gpsSource =
            typeof body.gpsSource === "string" && body.gpsSource.trim()
              ? body.gpsSource.trim()
              : "Manual";
          applyGpsToMediaMeta(metaRec, newLat, newLng, gpsSource, editorLabel);
        } else if (!gpsEnabled) {
          clearGpsFromMediaMeta(metaRec);
        }
      }
  
      if (hasNote) {
        metaRec.note = body.note;
        metaRec.noteLastEditedAt = new Date().toISOString();
        metaRec.noteLastEditedBy = await loadMediaEditorDisplayName(db, req.user);
      }
  
      if (hasGeometry) {
        if (parsedGeometry == null) {
          delete metaRec.geometry;
        } else {
          metaRec.geometry = parsedGeometry;
        }
      }
  
      const metadataStr = JSON.stringify(metaRec);
      const ix = indexedFieldsFromMediaMeta(metaRec);
      const updateResult = await runDb(
        db,
        `UPDATE media_files SET metadata = ?,
                   note_text = ?, note_last_edited_by = ?, note_last_edited_at = ?,
                   batch_id = ?, batch_name = ?, latitude = ?, longitude = ?, has_gps = ?
                   WHERE id = ? AND organization_id = ?`,
        [
          metadataStr,
          ix.note,
          ix.nBy,
          ix.nAt,
          ix.bid,
          ix.bname,
          ix.lat,
          ix.lng,
          ix.hasGps,
          fileId,
          orgId,
        ]
      );
      if (!updateResult.changes) {
        return res.status(404).json({ error: "File not found" });
      }
      scheduleTicketPhotoIntersectionRecompute(c, db, orgId, {
        oldPoints: oldPoint ? [oldPoint] : [],
        newPoints: [{ lat: ix.lat, lng: ix.lng, hasGps: ix.hasGps === 1 }],
      });
      scheduleJunctionSyncForMedia(c, db, orgId, fileId, metaRec, {
        lat: ix.lat,
        lng: ix.lng,
        hasGps: ix.hasGps === 1,
      });
      const newAssociatedTicketId =
        metaRec.associatedTicketId != null ? Number(metaRec.associatedTicketId) : null;
      const ticketIdsToRecompute = new Set<number>();
      if (Number.isFinite(priorAssociatedTicketId as number) && (priorAssociatedTicketId as number) > 0) {
        ticketIdsToRecompute.add(priorAssociatedTicketId as number);
      }
      if (Number.isFinite(newAssociatedTicketId as number) && (newAssociatedTicketId as number) > 0) {
        ticketIdsToRecompute.add(newAssociatedTicketId as number);
      }
      if (ticketIdsToRecompute.size > 0) {
        const task = recomputeTicketIds(db, orgId, Array.from(ticketIdsToRecompute)).catch((e: unknown) => {
          console.warn("[ticketPhotoIntersection] association recompute:", (e as Error).message || e);
        });
        const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(task);
        } else {
          void task;
        }
      }
      return res.json({ id: fileId, metadata: metaRec });
    } catch (err) {
      console.error("Error updating media metadata:", err);
      return res.status(500).json({ error: "Failed to update media" });
    }
  });
  
  data.delete("/media/:id", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const queryOrgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : null;
    const userId = req.user.id;
    const fileId = parseInt(req.params.id, 10);
    const orgId = queryOrgId != null ? queryOrgId : req.user.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canAccessOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have access to that organization" });
    }
    if (!(await assertOrgDataDeleteAllowed(req, res, db, orgId))) return;

    function doDelete(deleteOrgId: number) {
      db.get(
        "SELECT file_size, file_path, thumbnail_path, latitude, longitude, has_gps, metadata FROM media_files WHERE id = ? AND organization_id = ?",
        [fileId, deleteOrgId],
        (err: Error | null, file: { file_size?: number; file_path?: string; thumbnail_path?: string; latitude?: number; longitude?: number; has_gps?: number; metadata?: string } | undefined) => {
          if (err) {
            console.error("Error fetching file:", err);
            return res.status(500).json({ error: "Failed to fetch file" });
          }
  
          if (!file) {
            return res.status(404).json({ error: "File not found" });
          }
          const oldPoint = mediaPointFromRow(file as Record<string, unknown>);
  
          // Delete R2 objects first and only remove the DB row once storage is clean.
          // Failing here returns 500 so the client keeps the photo visible and can retry;
          // otherwise a thrown R2 delete would silently orphan the blob.
          void (async () => {
            let affectedTicketIds: number[] = [];
            try {
              affectedTicketIds = await resolveAffectedTicketIdsForMediaDelete(db, deleteOrgId, {
                id: fileId,
                ...(file as Record<string, unknown>),
              });
            } catch (e) {
              console.warn("[mediaTicketJunction] delete resolve:", (e as Error).message || e);
            }
            const mainKey = String(file.file_path || "").replace(/\\/g, "/");
            if (r2.isR2ObjectKey(mainKey)) {
              await r2.deleteObjectKey(mainKey);
            }
            const thumbKeys = new Set<string>();
            if (file.thumbnail_path) {
              thumbKeys.add(String(file.thumbnail_path).replace(/\\/g, "/"));
            }
            thumbKeys.add(r2.objectKeyThumb(orgId, fileId));
            for (const tk of thumbKeys) {
              if (!r2.isR2ObjectKey(tk)) continue;
              await r2.deleteObjectKey(tk);
            }
  
            db.run(
              "DELETE FROM media_files WHERE id = ? AND organization_id = ?",
              [fileId, deleteOrgId],
              function (delErr: Error | null) {
                if (delErr) {
                  console.error("Error deleting file:", delErr);
                  return res.status(500).json({ error: "Failed to delete file" });
                }
  
                db.run(
                  `
                  UPDATE organizations 
                  SET storage_used = storage_used - ?,
                      updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?
              `,
                  [file.file_size, deleteOrgId]
                );
                scheduleTicketPhotoIntersectionRecompute(c, db, deleteOrgId, {
                  oldPoints: oldPoint ? [oldPoint] : [],
                });
                if (affectedTicketIds.length) {
                  scheduleTicketIdsRecompute(c, db, deleteOrgId, affectedTicketIds);
                }
                res.json({ message: "Media file deleted successfully" });
              }
            );
          })().catch((e) => {
            console.error("Error deleting media file from R2:", e);
            res.status(500).json({ error: "Failed to delete media file from storage" });
          });
        }
      );
    }
  
    doDelete(orgId);
  });
}

export function registerDataMediaPublicRoutes(data: DataApp) {
  data.patch("/media/:id/public", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const fileId = parseInt(req.params.id, 10);
    const orgId =
      req.body.organizationId != null ? parseInt(String(req.body.organizationId), 10) : req.user.organizationId;
    if (!orgId || Number.isNaN(orgId)) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canAdminOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "Only organization admins can change public sharing for media" });
    }
    const row = await getRow(db, "SELECT id, organization_id FROM media_files WHERE id = ?", [fileId]);
    if (!row || Number(row.organization_id) !== Number(orgId)) {
      return res.status(404).json({ error: "File not found" });
    }
    const isPublic = !!(req.body && req.body.isPublic);
    try {
      await runDb(db, "UPDATE media_files SET is_public = ? WHERE id = ?", [isPublic ? 1 : 0, fileId]);
      res.json({ id: fileId, isPublic });
    } catch (e) {
      console.error("PATCH /media/:id/public:", e);
      res.status(500).json({ error: "Failed to update media public flag" });
    }
  });
}
