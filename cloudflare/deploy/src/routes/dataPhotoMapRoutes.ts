// Data Hub routes — split from data.ts (Phase 3)
import { getDatabase } from "../database.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import {
  parseBboxParam,
  getPhotoMapPayload,
  getPhotoPointsInBbox,
  getClusterPage,
  getPaginatedTicketPhotos,
  PHOTO_MAP_MIN_ZOOM,
} from "../lib/photoMapQuery.cjs";
import { resolveDataOrgIdRead, type DataApp } from "./dataShared.js";

export function registerDataPhotoMapRoutes(data: DataApp) {
  data.get("/media/photos/map", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    const bbox = parseBboxParam(req.query.bbox);
    const zoom = req.query.zoom != null ? Number(req.query.zoom) : NaN;
    if (!bbox) {
      return res.status(400).json({ error: "bbox is required (west,south,east,north)" });
    }
    if (!Number.isFinite(zoom)) {
      return res.status(400).json({ error: "zoom is required" });
    }
    if (zoom < PHOTO_MAP_MIN_ZOOM) {
      return res.json({ mode: "points", items: [], skipReason: "zoom_below_min" });
    }
    const ticketIdsRaw = req.query.ticketIds != null ? String(req.query.ticketIds) : "";
    const ticketIds = ticketIdsRaw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (!ticketIds.length) {
      return res.json({ mode: "points", items: [], skipReason: "no_active_tickets" });
    }
    const tags = req.query.tags != null ? String(req.query.tags) : undefined;
    const uploadedBy = req.query.uploadedBy != null ? String(req.query.uploadedBy) : undefined;
    try {
      const payload = await getPhotoMapPayload(db, {
        orgId,
        ticketIds,
        bbox,
        zoom,
        filters: { tags, uploadedBy },
      });
      res.json(payload);
    } catch (e) {
      console.error("GET /media/photos/map:", e);
      res.status(500).json({ error: "Failed to load map photos" });
    }
  });
  
  data.get("/media/photos/map/cluster", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    const bbox = parseBboxParam(req.query.bbox);
    if (!bbox) {
      return res.status(400).json({ error: "bbox is required (west,south,east,north)" });
    }
    const ticketIdsRaw = req.query.ticketIds != null ? String(req.query.ticketIds) : "";
    const ticketIds = ticketIdsRaw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0);
    try {
      const page = await getClusterPage(db, orgId, {
        bbox,
        ticketIds,
        cellKey: req.query.cellKey != null ? String(req.query.cellKey) : undefined,
        clusterKind: req.query.clusterKind != null ? String(req.query.clusterKind) : undefined,
        ticketBaseNumber: req.query.ticketBaseNumber != null ? String(req.query.ticketBaseNumber) : undefined,
        photoIds: req.query.photoIds != null ? String(req.query.photoIds) : undefined,
        page: req.query.page != null ? Number(req.query.page) : 1,
        limit: req.query.limit != null ? Number(req.query.limit) : 50,
        sort: req.query.sort != null ? String(req.query.sort) : "createdAt",
        order: req.query.order != null ? String(req.query.order) : "desc",
        zoom: req.query.zoom != null ? Number(req.query.zoom) : PHOTO_MAP_MIN_ZOOM,
        filters: {
          tags: req.query.tags != null ? String(req.query.tags) : undefined,
          uploadedBy: req.query.uploadedBy != null ? String(req.query.uploadedBy) : undefined,
        },
      });
      res.json(page);
    } catch (e) {
      console.error("GET /media/photos/map/cluster:", e);
      res.status(500).json({ error: "Failed to load cluster photos" });
    }
  });
  
  data.get("/media/photos/spatial", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    const bbox = parseBboxParam(req.query.bbox);
    if (!bbox) {
      return res.status(400).json({ error: "bbox is required (west,south,east,north)" });
    }
    try {
      const createdFrom =
        req.query.createdFrom != null ? String(req.query.createdFrom).trim() : undefined;
      const createdTo = req.query.createdTo != null ? String(req.query.createdTo).trim() : undefined;
      const result = await getPhotoPointsInBbox(db, {
        orgId,
        bbox,
        filters: { tags: req.query.tags != null ? String(req.query.tags) : undefined },
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
        createdFrom: createdFrom || undefined,
        createdTo: createdTo || undefined,
      });
      res.json({
        mode: "points",
        items: result.points,
        capped: result.capped,
        cap: result.cap,
        totalMatched: result.totalMatched,
      });
    } catch (e) {
      console.error("GET /media/photos/spatial:", e);
      res.status(500).json({ error: "Failed to load spatial photos" });
    }
  });
  
  data.get("/media/photos/for-ticket", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    const ticketId = req.query.ticketId != null ? parseInt(String(req.query.ticketId), 10) : NaN;
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: "ticketId is required" });
    }
    const tab = req.query.tab != null ? String(req.query.tab) : "map";
    try {
      const page = await getPaginatedTicketPhotos(
        db,
        orgId,
        ticketId,
        tab,
        req.query.page != null ? Number(req.query.page) : 1,
        req.query.limit != null ? Number(req.query.limit) : 50
      );
      res.json(page);
    } catch (e) {
      console.error("GET /media/photos/for-ticket:", e);
      res.status(500).json({ error: "Failed to load ticket photos" });
    }
  });
}
