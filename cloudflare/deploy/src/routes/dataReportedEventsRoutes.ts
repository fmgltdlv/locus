// Data Hub routes — split from data.ts (Phase 3)
import { getDatabase } from "../database.js";
import { canMutateOrganization, ORG_REQUIRED_MESSAGE, verifyPassword } from "../auth.js";
import { buildExpressReq, ResShim } from "../expressCompat.js";
import { getRow, allRows, runDb } from "../lib/db.cjs";
import { assertOrgDataDeleteAllowed, assertOrgDataEditAllowed } from "../lib/orgDataPermissions.js";
import { resolveDataOrgIdRead, type DataApp } from "./dataShared.js";

function dirtRowToClient(row: Record<string, unknown>) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row.payload_json || "{}"));
  } catch {
    payload = {};
  }
  const sid = row.id != null ? String(row.id) : "";
  const loc =
    row.lat != null &&
    row.lng != null &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lng))
      ? { lat: Number(row.lat), lng: Number(row.lng) }
      : ((payload.location as { lat?: number; lng?: number }) || null);
  return {
    ...payload,
    id: sid,
    serverId: row.id != null ? Number(row.id) : null,
    createdByUserId: row.created_by_user_id != null ? Number(row.created_by_user_id) : null,
    organizationId: row.organization_id,
    ticketId: row.ticket_id != null ? row.ticket_id : payload.ticketId,
    ticketNumber: row.ticket_number != null ? row.ticket_number : payload.ticketNumber,
    location: loc,
    createdAt: row.created_at || payload.createdAt,
    updatedAt: row.updated_at,
    clientLegacyId: row.client_legacy_id != null ? row.client_legacy_id : payload.id,
  };
}

function stripPasswordFromReportBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  delete out.password;
  return out;
}

function payloadIsDraftFromRow(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return true;
  try {
    const payload = JSON.parse(String(row.payload_json || "{}")) as Record<string, unknown>;
    return payload.isDraft === true;
  } catch {
    return true;
  }
}

async function assertReportSubmitPassword(
  req: { user: { id: number } },
  res: ResShim,
  db: ReturnType<typeof getDatabase>,
  body: Record<string, unknown>,
  existingRow?: Record<string, unknown> | null
): Promise<boolean> {
  const wasSubmitted = existingRow ? !payloadIsDraftFromRow(existingRow) : false;
  const isSubmitting = body.isDraft !== true;
  if (!isSubmitting && !wasSubmitted) {
    return true;
  }
  const password = body.password != null ? String(body.password).trim() : "";
  if (!password) {
    res.status(400).json({ error: "Account password is required to submit or update this report" });
    return false;
  }
  const pwdRow = await getRow(db, "SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
  if (!pwdRow || !pwdRow.password_hash) {
    res.status(500).json({ error: "Account password not available" });
    return false;
  }
  if (!verifyPassword(password, String(pwdRow.password_hash))) {
    res.status(403).json({ error: "Invalid password" });
    return false;
  }
  return true;
}

export function registerDataReportedEventsRoutes(data: DataApp) {
  data.get("/reported-events", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const orgId = await resolveDataOrgIdRead(req, res);
    if (orgId == null) return await res.getResponse();
    try {
      const rows = await allRows(
        db,
        `SELECT id, organization_id, created_by_user_id, client_legacy_id, ticket_id, ticket_number, payload_json, lat, lng, created_at, updated_at
         FROM dirt_reported_events WHERE organization_id = ? ORDER BY datetime(created_at) DESC`,
        [orgId]
      );
      res.json({ events: rows.map((r) => dirtRowToClient(r as Record<string, unknown>)) });
    } catch (e) {
      console.error("reported-events list:", e);
      res.status(500).json({ error: "Failed to load reported events" });
    }
  });
  
  data.post("/reported-events", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const body = (req.body || {}) as Record<string, unknown>;
    const orgId =
      body.organizationId != null ? parseInt(String(body.organizationId), 10) : req.user.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canMutateOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have permission to add events for this organization" });
    }
    if (!(await assertReportSubmitPassword(req, res, db, body))) {
      return await res.getResponse();
    }
    const payloadBody = stripPasswordFromReportBody(body);
    const userId = req.user.id;
    const clientLegacyId =
      payloadBody.clientLegacyId != null && String(payloadBody.clientLegacyId).trim() !== ""
        ? String(payloadBody.clientLegacyId)
        : payloadBody.id != null && String(payloadBody.id).startsWith("event-")
          ? String(payloadBody.id)
          : null;
    if (clientLegacyId) {
      const existing = await getRow(
        db,
        `SELECT id FROM dirt_reported_events WHERE organization_id = ? AND client_legacy_id = ?`,
        [orgId, clientLegacyId]
      );
      if (existing) {
        return res.status(409).json({ error: "Event already exists", id: existing.id });
      }
    }
    const ticketIdNum =
      payloadBody.ticketId != null && payloadBody.ticketId !== ""
        ? parseInt(String(payloadBody.ticketId), 10)
        : null;
    const ticketIdForDb = Number.isFinite(ticketIdNum) ? ticketIdNum : null;
    const ticketNumber = payloadBody.ticketNumber != null ? String(payloadBody.ticketNumber) : null;
    const loc =
      payloadBody.location && typeof payloadBody.location === "object"
        ? (payloadBody.location as Record<string, unknown>)
        : null;
    let lat = loc && loc.lat != null ? Number(loc.lat) : null;
    let lng = loc && loc.lng != null ? Number(loc.lng) : null;
    if (!Number.isFinite(lat)) lat = null;
    if (!Number.isFinite(lng)) lng = null;
    const payloadJson = JSON.stringify(payloadBody);
    try {
      const r = await runDb(
        db,
        `INSERT INTO dirt_reported_events (organization_id, created_by_user_id, client_legacy_id, ticket_id, ticket_number, payload_json, lat, lng, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [orgId, userId, clientLegacyId, ticketIdForDb, ticketNumber, payloadJson, lat, lng]
      );
      const row = await getRow(
        db,
        `SELECT id, organization_id, created_by_user_id, client_legacy_id, ticket_id, ticket_number, payload_json, lat, lng, created_at, updated_at FROM dirt_reported_events WHERE id = ?`,
        [r.lastID]
      );
      res.status(201).json({ event: dirtRowToClient(row as Record<string, unknown>) });
    } catch (e: unknown) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
      console.error("reported-events insert:", e);
      res.status(500).json({ error: msg || "Failed to save reported event" });
    }
  });
  
  data.put("/reported-events/:eventId", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const eventId = parseInt(String(c.req.param("eventId") || ""), 10);
    if (!Number.isFinite(eventId)) {
      return res.status(400).json({ error: "Invalid event id" });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const orgId =
      body.organizationId != null ? parseInt(String(body.organizationId), 10) : req.user.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canMutateOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have permission to update events for this organization" });
    }
    const row = await getRow(
      db,
      `SELECT * FROM dirt_reported_events WHERE id = ? AND organization_id = ?`,
      [eventId, orgId]
    );
    if (!row) {
      return res.status(404).json({ error: "Event not found" });
    }
    if (
      !(await assertOrgDataEditAllowed(
        req,
        res,
        db,
        orgId,
        row.created_by_user_id != null ? Number(row.created_by_user_id) : null
      ))
    ) {
      return;
    }
    if (!(await assertReportSubmitPassword(req, res, db, body, row))) {
      return await res.getResponse();
    }
    const payloadBody = stripPasswordFromReportBody(body);
    const ticketIdNum =
      payloadBody.ticketId != null && payloadBody.ticketId !== ""
        ? parseInt(String(payloadBody.ticketId), 10)
        : null;
    const ticketIdForDb = Number.isFinite(ticketIdNum) ? ticketIdNum : null;
    const ticketNumber = payloadBody.ticketNumber != null ? String(payloadBody.ticketNumber) : null;
    const loc =
      payloadBody.location && typeof payloadBody.location === "object"
        ? (payloadBody.location as Record<string, unknown>)
        : null;
    let lat = loc && loc.lat != null ? Number(loc.lat) : null;
    let lng = loc && loc.lng != null ? Number(loc.lng) : null;
    if (!Number.isFinite(lat)) lat = null;
    if (!Number.isFinite(lng)) lng = null;
    const payloadJson = JSON.stringify(payloadBody);
    try {
      await runDb(
        db,
        `UPDATE dirt_reported_events SET ticket_id = ?, ticket_number = ?, payload_json = ?, lat = ?, lng = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`,
        [ticketIdForDb, ticketNumber, payloadJson, lat, lng, eventId, orgId]
      );
      const updated = await getRow(
        db,
        `SELECT id, organization_id, created_by_user_id, client_legacy_id, ticket_id, ticket_number, payload_json, lat, lng, created_at, updated_at FROM dirt_reported_events WHERE id = ?`,
        [eventId]
      );
      res.json({ event: dirtRowToClient(updated as Record<string, unknown>) });
    } catch (e) {
      console.error("reported-events update:", e);
      res.status(500).json({ error: "Failed to update reported event" });
    }
  });
  
  data.delete("/reported-events/:eventId", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const eventId = parseInt(String(c.req.param("eventId") || ""), 10);
    if (!Number.isFinite(eventId)) {
      return res.status(400).json({ error: "Invalid event id" });
    }
    const rawOrg = req.query?.organizationId;
    const orgId =
      rawOrg != null && rawOrg !== "" ? parseInt(String(rawOrg), 10) : req.user.organizationId;
    if (!orgId) {
      return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    }
    if (!canMutateOrganization(req.user, orgId)) {
      return res.status(403).json({ error: "You do not have permission to delete events for this organization" });
    }
    if (!(await assertOrgDataDeleteAllowed(req, res, db, orgId))) return;
    try {
      const r = await runDb(db, `DELETE FROM dirt_reported_events WHERE id = ? AND organization_id = ?`, [eventId, orgId]);
      if (!r.changes) {
        return res.status(404).json({ error: "Event not found" });
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("reported-events delete:", e);
      res.status(500).json({ error: "Failed to delete reported event" });
    }
  });
}
