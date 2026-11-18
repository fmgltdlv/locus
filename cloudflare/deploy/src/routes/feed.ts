import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { authMiddleware, canUseDevTicketHub } from "../auth.js";
import {
  buildExpressReq,
  expressReqResMiddleware,
  jsonBodyMiddleware,
  ResShim,
} from "../expressCompat.js";
import type { Env } from "../types.js";
import { runDb } from "../lib/db.cjs";
import { computeFeedTicketStatus } from "./computeWorkflowStatus.js";

const feedNote = require("../lib/feedServiceRequestNote.cjs") as {
  FEED_ACTIVE_STATUSES: string[];
  parseFeedServiceRequestNote: (note: unknown) => {
    source: string;
    serviceRequested?: string;
    ticketOrganizationId: number | null;
    ticketNumber: string;
    ticketRevision?: string;
    userNote?: string;
    acknowledgeReason?: string | null;
  } | null;
  mergeAcknowledgeReasonIntoNote: (note: unknown, reason: string | null | undefined) => string;
};

const feedScan = require("../lib/feedScan.cjs") as {
  listActiveFeedServiceRequests: (
    db: unknown,
    opts?: { organizationIds?: number[]; serviceRequestIds?: number[] }
  ) => Promise<Record<string, unknown>[]>;
  countActiveFeedServiceRequests: (db: unknown) => Promise<number>;
  loadOwnerTicketLean: (
    db: unknown,
    organizationId: number,
    ticketNumber: string
  ) => Promise<Record<string, unknown> | null>;
  leanRowToTicketShape: (row: Record<string, unknown>) => Record<string, unknown> | null;
  markerFromLeanTicket: (ticket: Record<string, unknown> | null) => {
    polygon: unknown;
    pin: { lat: number; lng: number } | null;
  };
  scanFeedServiceRequests: (
    db: unknown,
    opts: {
      feedOrgId?: number | null;
      organizationIds?: number[];
      serviceRequestIds?: number[];
    }
  ) => Promise<{ scanned: number; updatedToComplete: number; errors: unknown[] }>;
};

const feed = new Hono<{
  Bindings: Env;
  Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim };
}>() as any;

feed.use("*", jsonBodyMiddleware);
feed.use("*", authMiddleware);
feed.use("*", expressReqResMiddleware);

function resolveFeedOrgId(req: { query: Record<string, string>; user: { organizationId?: number } }): number | null {
  const q = req.query.organizationId != null ? parseInt(String(req.query.organizationId), 10) : NaN;
  if (Number.isFinite(q) && q > 0) return q;
  const u = req.user && req.user.organizationId != null ? Number(req.user.organizationId) : NaN;
  return Number.isFinite(u) && u > 0 ? u : null;
}

function parseIdList(raw: unknown): number[] {
  if (raw == null || raw === "") return [];
  const parts = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  return parts.map((p) => Number(p)).filter((n) => Number.isFinite(n) && n > 0);
}

async function requireFeedAccess(req: {
  query: Record<string, string>;
  user: { organizationId?: number; role?: string };
}): Promise<{ ok: true; orgId: number } | { ok: false; status: number; error: string }> {
  if (!req.user || req.user.role !== "dev") {
    return { ok: false, status: 403, error: "Feed workspace is available to global developers only" };
  }
  const orgId = resolveFeedOrgId(req);
  if (orgId == null) {
    return { ok: false, status: 400, error: "organizationId is required for feed APIs" };
  }
  if (!(await canUseDevTicketHub(req.user as any, orgId))) {
    return { ok: false, status: 403, error: "Selected organization is not a documentation feed workspace" };
  }
  return { ok: true, orgId };
}

function serializeFeedRow(
  sr: Record<string, unknown>,
  feedTicketStatus: string | null
) {
  const meta = feedNote.parseFeedServiceRequestNote(sr.note);
  return {
    id: sr.id != null ? Number(sr.id) : null,
    organizationId: sr.organization_id != null ? Number(sr.organization_id) : null,
    organizationName: sr.organization_name != null ? String(sr.organization_name) : null,
    serviceType: sr.service_type != null ? String(sr.service_type) : null,
    serviceRequested: meta?.serviceRequested || sr.service_type || null,
    status: sr.status != null ? String(sr.status) : null,
    createdAt: sr.created_at != null ? String(sr.created_at) : null,
    userName: sr.user_name != null ? String(sr.user_name) : null,
    userEmail: sr.user_email != null ? String(sr.user_email) : null,
    feed: meta,
    feedTicketStatus,
    ticketSummary: meta
      ? {
          ticketNumber: meta.ticketNumber,
          ticketRevision: meta.ticketRevision || null,
          ticketOrganizationId: meta.ticketOrganizationId,
        }
      : null,
  };
}

feed.get("/open-count", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const db = getDatabase();
  try {
    const count = await feedScan.countActiveFeedServiceRequests(db);
    return c.json({ count, organizationId: access.orgId });
  } catch (err) {
    console.error("GET /api/feed/open-count:", err);
    return c.json({ error: "Failed to count feed items" }, 500);
  }
});

feed.get("/service-requests", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const db = getDatabase();
  const organizationIds = parseIdList(req.query.organizationIds);
  const filterOrgIds = organizationIds.filter((id) => id !== access.orgId);

  try {
    const rows = await feedScan.listActiveFeedServiceRequests(db, {
      organizationIds: filterOrgIds.length ? filterOrgIds : undefined,
    });

    const feedStatsByOrg: Record<string, { ready: number; notReady: number; organizationName?: string }> = {};
    const out = [];

    for (const sr of rows || []) {
      let feedTicketStatus: string | null = null;
      try {
        const meta = feedNote.parseFeedServiceRequestNote(sr.note);
        if (meta && meta.ticketNumber) {
          const ownerOrg = meta.ticketOrganizationId || Number(sr.organization_id);
          const lean = await feedScan.loadOwnerTicketLean(db, ownerOrg, meta.ticketNumber);
          const ticket = lean ? feedScan.leanRowToTicketShape(lean) : null;
          feedTicketStatus = ticket ? computeFeedTicketStatus(ticket) : null;
        }
      } catch (rowErr) {
        console.warn("GET /api/feed/service-requests row:", sr && sr.id, rowErr);
      }

      const orgKey = String(sr.organization_id);
      if (!feedStatsByOrg[orgKey]) {
        feedStatsByOrg[orgKey] = {
          ready: 0,
          notReady: 0,
          organizationName: sr.organization_name != null ? String(sr.organization_name) : undefined,
        };
      }
      if (feedTicketStatus === "READY") feedStatsByOrg[orgKey].ready += 1;
      else if (feedTicketStatus === "NOT_READY") feedStatsByOrg[orgKey].notReady += 1;

      out.push(serializeFeedRow(sr, feedTicketStatus));
    }

    return c.json({
      serviceRequests: out,
      feedStatsByOrg,
      organizationId: access.orgId,
    });
  } catch (err) {
    console.error("GET /api/feed/service-requests:", err);
    return c.json({ error: "Failed to list feed service requests" }, 500);
  }
});

feed.get("/map-markers", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const db = getDatabase();
  const organizationIds = parseIdList(req.query.organizationIds);
  const filterOrgIds = organizationIds.filter((id) => id !== access.orgId);

  try {
    const rows = await feedScan.listActiveFeedServiceRequests(db, {
      organizationIds: filterOrgIds.length ? filterOrgIds : undefined,
    });
    const markers = [];

    for (const sr of rows || []) {
      try {
        const meta = feedNote.parseFeedServiceRequestNote(sr.note);
        if (!meta || !meta.ticketNumber) continue;
        const ownerOrg = meta.ticketOrganizationId || Number(sr.organization_id);
        const lean = await feedScan.loadOwnerTicketLean(db, ownerOrg, meta.ticketNumber);
        const ticket = lean ? feedScan.leanRowToTicketShape(lean) : null;
        const geom = feedScan.markerFromLeanTicket(ticket);
        const feedTicketStatus = ticket ? computeFeedTicketStatus(ticket) : null;
        markers.push({
          serviceRequestId: Number(sr.id),
          organizationId: ownerOrg,
          organizationName: sr.organization_name != null ? String(sr.organization_name) : null,
          ticketNumber: meta.ticketNumber,
          polygon: geom.polygon,
          pin: geom.pin,
          serviceRequestStatus: sr.status != null ? String(sr.status) : null,
          feedTicketStatus,
        });
      } catch (rowErr) {
        console.warn("GET /api/feed/map-markers row:", sr && sr.id, rowErr);
      }
    }

    return c.json({ markers, organizationId: access.orgId });
  } catch (err) {
    console.error("GET /api/feed/map-markers:", err);
    return c.json({ error: "Failed to load feed map markers" }, 500);
  }
});

feed.post("/scan-maps", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const body = req.body || {};
  const organizationIds = parseIdList(body.organizationIds);
  const serviceRequestIds = parseIdList(body.serviceRequestIds);
  const db = getDatabase();

  try {
    const result = await feedScan.scanFeedServiceRequests(db, {
      feedOrgId: access.orgId,
      organizationIds: organizationIds.length ? organizationIds : undefined,
      serviceRequestIds: serviceRequestIds.length ? serviceRequestIds : undefined,
    });
    return c.json(result);
  } catch (err) {
    console.error("POST /api/feed/scan-maps:", err);
    return c.json({ error: "Failed to scan maps for feed items" }, 500);
  }
});

async function acknowledgeRows(
  db: ReturnType<typeof getDatabase>,
  ids: number[],
  reason: string | null | undefined
) {
  let updated = 0;
  for (const id of ids) {
    const row = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
      db.get(`SELECT id, note, status FROM service_requests WHERE id = ?`, [id], (err, r) => {
        if (err) reject(err);
        else resolve((r as Record<string, unknown>) || null);
      });
    });
    if (!row) continue;
    const status = String(row.status || "").toLowerCase();
    if (!["incomplete", "complete", "new"].includes(status)) continue;
    const note = feedNote.mergeAcknowledgeReasonIntoNote(row.note, reason);
    await runDb(db, `UPDATE service_requests SET status = ?, note = ? WHERE id = ?`, [
      "acknowledged",
      note,
      id,
    ]);
    updated += 1;
  }
  return updated;
}

feed.patch("/service-requests/acknowledge", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const ids = parseIdList((req.body && (req.body.ids || req.body.serviceRequestIds)) || []);
  if (!ids.length) return c.json({ error: "ids required" }, 400);
  const reason = req.body && req.body.reason != null ? String(req.body.reason) : null;
  const db = getDatabase();
  try {
    const updated = await acknowledgeRows(db, ids, reason);
    return c.json({ updated });
  } catch (err) {
    console.error("PATCH /api/feed/service-requests/acknowledge:", err);
    return c.json({ error: "Failed to acknowledge service requests" }, 500);
  }
});

feed.patch("/service-requests/:id/acknowledge", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const reason = req.body && req.body.reason != null ? String(req.body.reason) : null;
  const db = getDatabase();
  try {
    const updated = await acknowledgeRows(db, [id], reason);
    if (!updated) return c.json({ error: "Service request not found or not acknowledgeable" }, 404);
    return c.json({ updated: 1 });
  } catch (err) {
    console.error("PATCH /api/feed/service-requests/:id/acknowledge:", err);
    return c.json({ error: "Failed to acknowledge service request" }, 500);
  }
});

feed.patch("/service-requests/:id/reopen", async (c) => {
  const req = buildExpressReq(c);
  const access = await requireFeedAccess(req);
  if (access.ok === false) return c.json({ error: access.error }, access.status as 400 | 403);

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
  const db = getDatabase();
  try {
    const result = await runDb(
      db,
      `UPDATE service_requests SET status = 'incomplete' WHERE id = ? AND status = 'acknowledged'`,
      [id]
    );
    if (!result || !result.changes) {
      return c.json({ error: "Service request not found or not acknowledged" }, 404);
    }
    return c.json({ reopened: 1 });
  } catch (err) {
    console.error("PATCH /api/feed/service-requests/:id/reopen:", err);
    return c.json({ error: "Failed to reopen service request" }, 500);
  }
});

export { feed };
