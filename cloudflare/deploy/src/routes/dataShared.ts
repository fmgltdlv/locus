// Data Hub routes — split from data.ts (Phase 3)
import { getDatabase } from "../database.js";
import {
  canAccessOrganization,
  canViewOrganization,
  ORG_REQUIRED_MESSAGE,
} from "../auth.js";
import { ResShim } from "../expressCompat.js";
import type { AuthUser } from "../types.js";
import { getRow, runDb } from "../lib/db.cjs";
import { canViewerReadPublicMedia } from "../lib/publicShareQuery.cjs";
import { recomputeForMediaChange, recomputeTicketIds } from "../lib/ticketPhotoIntersection.cjs";
import { syncJunctionForMedia } from "../lib/mediaTicketJunction.cjs";
import type { Context, Next } from "hono";

export type DataApp = any;

export async function canReadOrgData(user: AuthUser, orgId: number) {
  return canViewOrganization(user, orgId);
}

export async function canViewerReadMediaFile(
  db: unknown,
  user: AuthUser,
  viewerOrg: number,
  mediaRow: Record<string, unknown>
) {
  if (Number(viewerOrg) === Number(mediaRow.organization_id)) {
    return canAccessOrganization(user, viewerOrg);
  }
  return canViewerReadPublicMedia(db, user.id, mediaRow);
}

/**
 * For GET: allow viewing public catalog org when user belongs to any org. For default org, uses user's org (must be member).
 */
export async function resolveDataOrgIdRead(
  req: { query: Record<string, string | undefined>; user: AuthUser },
  res: ResShim
) {
  const raw = req.query.organizationId;
  const queryOrgId = raw != null && raw !== "" ? parseInt(String(raw), 10) : null;
  if (raw != null && raw !== "" && Number.isNaN(queryOrgId)) {
    res.status(400).json({ error: "Invalid organizationId" });
    return null;
  }
  if (queryOrgId != null) {
    if (await canReadOrgData(req.user, queryOrgId)) return queryOrgId;
    res.status(403).json({ error: "You do not have access to that organization" });
    return null;
  }
  const orgId = req.user.organizationId;
  if (!orgId) {
    res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    return null;
  }
  return orgId;
}

export const MEDIA_TOKEN_TTL_MS = 2 * 60 * 1000;

export function mediaPointFromRow(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  const lat = row.latitude != null ? Number(row.latitude) : Number((row as { lat?: unknown }).lat);
  const lng = row.longitude != null ? Number(row.longitude) : Number((row as { lng?: unknown }).lng);
  const hasGps = row.has_gps === 1 || row.has_gps === true || (row as { hasGps?: unknown }).hasGps === true;
  if (!hasGps || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, hasGps: true };
}

export function scheduleTicketIdsRecompute(c: Context, db: unknown, orgId: number, ticketIds: number[]) {
  const ids = [...new Set((ticketIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return;
  const task = recomputeTicketIds(db, orgId, ids).catch((e: unknown) => {
    console.warn("[ticketPhotoIntersection] ticket recompute:", (e as Error).message || e);
  });
  const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task);
  } else {
    void task;
  }
}

export function scheduleJunctionSyncForMedia(
  c: Context,
  db: unknown,
  orgId: number,
  mediaId: number,
  meta: Record<string, unknown>,
  point: { lat?: number | null; lng?: number | null; hasGps?: boolean }
) {
  const task = syncJunctionForMedia(db, orgId, mediaId, meta, point).catch((e: unknown) => {
    console.warn("[mediaTicketJunction] sync:", (e as Error).message || e);
  });
  const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task);
  } else {
    void task;
  }
}

export function scheduleTicketPhotoIntersectionRecompute(
  c: Context,
  db: unknown,
  orgId: number,
  change: { oldPoints?: unknown[]; newPoints?: unknown[] }
) {
  const task = (recomputeForMediaChange as (db: unknown, orgId: number, change: { oldPoints?: unknown[]; newPoints?: unknown[] }) => Promise<unknown>)(db, orgId, change).catch((e: unknown) => {
    console.warn("[ticketPhotoIntersection] media change recompute:", (e as Error).message || e);
  });
  const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(task);
  } else {
    void task;
  }
}

export async function insertMediaAccessToken(db: unknown, token: string, mediaId: number, expiresAtMs: number) {
  await runDb(
    db,
    "INSERT OR REPLACE INTO media_access_tokens (token, media_id, expires_at) VALUES (?, ?, ?)",
    [token, mediaId, Math.floor(expiresAtMs)]
  );
}

export async function getMediaAccessTokenRow(db: unknown, token: string) {
  const row = await getRow(
    db,
    "SELECT media_id, expires_at FROM media_access_tokens WHERE token = ?",
    [token]
  );
  if (!row) return null;
  const exp = Number(row.expires_at);
  if (!Number.isFinite(exp) || Date.now() > exp) {
    await runDb(db, "DELETE FROM media_access_tokens WHERE token = ?", [token]).catch(() => {});
    return null;
  }
  return { mediaId: row.media_id, expiresAt: exp };
}

export function indexedFieldsFromMediaMeta(meta: Record<string, unknown>) {
  if (!meta || typeof meta !== "object") meta = {};
  const note = typeof meta.note === "string" ? meta.note : null;
  const nBy = typeof meta.noteLastEditedBy === "string" ? meta.noteLastEditedBy : null;
  const nAt = typeof meta.noteLastEditedAt === "string" ? meta.noteLastEditedAt : null;
  const bid = meta.batchId != null ? String(meta.batchId) : null;
  const bname = typeof meta.batchName === "string" ? meta.batchName : null;
  let lat = meta.lat != null ? Number(meta.lat) : null;
  let lng = meta.lng != null ? Number(meta.lng) : null;
  if (!Number.isFinite(lat)) lat = null;
  if (!Number.isFinite(lng)) lng = null;
  const hasGps = meta.hasGPS === true || (lat != null && lng != null) ? 1 : 0;
  return { note, nBy, nAt, bid, bname, lat, lng, hasGps };
}

export function gpsSourceFromMediaMeta(meta: Record<string, unknown>, row?: { latitude?: number; longitude?: number }) {
  const exif =
    meta.exif && typeof meta.exif === "object" ? (meta.exif as Record<string, unknown>) : {};
  if (typeof exif.gpsSource === "string" && exif.gpsSource.trim()) return exif.gpsSource.trim();
  if (typeof meta.gpsSource === "string" && meta.gpsSource.trim()) return meta.gpsSource.trim();
  let lat = meta.lat != null ? Number(meta.lat) : null;
  let lng = meta.lng != null ? Number(meta.lng) : null;
  if (!Number.isFinite(lat) && row && row.latitude != null) lat = Number(row.latitude);
  if (!Number.isFinite(lng) && row && row.longitude != null) lng = Number(row.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return "EXIF";
  return "None";
}

export function applyGpsToMediaMeta(
  meta: Record<string, unknown>,
  lat: number,
  lng: number,
  gpsSource: string,
  editorLabel: string
) {
  meta.hasGPS = true;
  meta.lat = lat;
  meta.lng = lng;
  meta.gpsSource = gpsSource;
  meta.gpsLastEditedAt = new Date().toISOString();
  meta.gpsLastEditedBy = editorLabel;
  const exif =
    meta.exif && typeof meta.exif === "object" ? (meta.exif as Record<string, unknown>) : {};
  exif.hasGPS = true;
  exif.gpsLat = lat;
  exif.gpsLng = lng;
  exif.gpsSource = gpsSource;
  meta.exif = exif;
}

export function clearGpsFromMediaMeta(meta: Record<string, unknown>) {
  meta.hasGPS = false;
  delete meta.lat;
  delete meta.lng;
  meta.gpsSource = "None";
  if (meta.exif && typeof meta.exif === "object") {
    const exif = meta.exif as Record<string, unknown>;
    exif.hasGPS = false;
    delete exif.gpsLat;
    delete exif.gpsLng;
    exif.gpsSource = "None";
  }
}

export async function loadMediaEditorDisplayName(
  db: ReturnType<typeof getDatabase>,
  user: AuthUser
): Promise<string> {
  const urow = await getRow(
    db,
    `SELECT COALESCE(NULLIF(TRIM(full_name), ''), username, email) as display_name FROM users WHERE id = ?`,
    [user.id]
  );
  if (urow && urow.display_name) return String(urow.display_name);
  return user.username || user.email || "Unknown";
}

export function resolveDataOrgId(req: { query: Record<string, string>; user: AuthUser }, res: ResShim) {
  const raw = req.query.organizationId;
  const queryOrgId = raw != null && raw !== "" ? parseInt(String(raw), 10) : null;
  if (raw != null && raw !== "" && Number.isNaN(queryOrgId)) {
    res.status(400).json({ error: "Invalid organizationId" });
    return null;
  }
  if (queryOrgId != null) {
    if (!canAccessOrganization(req.user, queryOrgId)) {
      res.status(403).json({ error: "You do not have access to that organization" });
      return null;
    }
    return queryOrgId;
  }
  const orgId = req.user.organizationId;
  if (!orgId) {
    res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
    return null;
  }
  return orgId;
}

export async function multipartMediaMiddleware(c: Context, next: Next) {
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    c.set("jsonBody", {});
    await next();
    return;
  }
  const form = await c.req.formData();
  const body: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (k === "file" || k === "thumbnail") continue;
    body[k] = typeof v === "string" ? v : String(v);
  }
  c.set("jsonBody", body);
  const fileEntry = form.get("file");
  if (fileEntry != null && typeof fileEntry !== "string") {
    const uploadFile = fileEntry as File;
    const ab = await uploadFile.arrayBuffer();
    c.set("multerFile", {
      buffer: Buffer.from(ab),
      originalname: uploadFile.name || "upload",
      mimetype: uploadFile.type || "application/octet-stream",
      size: ab.byteLength,
    });
  }
  const thumbEntry = form.get("thumbnail");
  if (thumbEntry != null && typeof thumbEntry !== "string") {
    const uploadThumb = thumbEntry as File;
    const tab = await uploadThumb.arrayBuffer();
    c.set("multerThumb", {
      buffer: Buffer.from(tab),
      mimetype: uploadThumb.type || "image/jpeg",
      size: tab.byteLength,
    });
  }
  await next();
}
