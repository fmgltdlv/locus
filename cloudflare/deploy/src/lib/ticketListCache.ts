/**
 * Shared lean active-ticket list snapshot + fill-on-read dig-site polygon cache (APP_KV / D1 app_kv).
 * List and polygon caches are independently invalidated.
 */
import { deleteAppKv, getAppKv, setAppKv } from "./appKv.js";

export const LEAN_ACTIVE_LIST_SCHEMA_V = 3;
export const TICKET_POLYGON_CACHE_SCHEMA_V = 1;
/** Soft TTL safety net; primary invalidation is explicit delete on list-mutating writes. */
export const LEAN_ACTIVE_LIST_TTL_MS = 5 * 60 * 1000;

export function orgActiveLeanListKey(orgId: unknown): string {
  return `org:${String(orgId)}:ticket_list:active_lean_v1`;
}

export function orgTicketPolygonCacheKey(orgId: unknown, normalizedBase: string): string {
  const base = String(normalizedBase || "")
    .trim()
    .toUpperCase();
  return `org:${String(orgId)}:ticket_polygon:v1:${base}`;
}

export type LeanActiveListSnapshot = {
  v: number;
  builtAt: number;
  tickets: unknown[];
};

export type TicketPolygonCacheEntry = {
  v: number;
  builtAt: number;
  polygon: unknown;
  minLng?: number | null;
  minLat?: number | null;
  maxLng?: number | null;
  maxLat?: number | null;
  pinLng?: number | null;
  pinLat?: number | null;
  ticketNumber?: string;
};

export function isLeanActiveListFresh(snapshot: LeanActiveListSnapshot | null, nowMs = Date.now()): boolean {
  if (!snapshot || snapshot.v !== LEAN_ACTIVE_LIST_SCHEMA_V) return false;
  if (!Array.isArray(snapshot.tickets)) return false;
  if (!Number.isFinite(snapshot.builtAt)) return false;
  return nowMs - snapshot.builtAt <= LEAN_ACTIVE_LIST_TTL_MS;
}

export async function getLeanActiveTicketList(
  db: unknown,
  orgId: unknown
): Promise<LeanActiveListSnapshot | null> {
  const raw = await getAppKv(db, orgActiveLeanListKey(orgId));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as LeanActiveListSnapshot;
    if (!o || typeof o !== "object" || !Array.isArray(o.tickets)) return null;
    return o;
  } catch {
    return null;
  }
}

export async function setLeanActiveTicketList(
  db: unknown,
  orgId: unknown,
  tickets: unknown[]
): Promise<void> {
  const payload: LeanActiveListSnapshot = {
    v: LEAN_ACTIVE_LIST_SCHEMA_V,
    builtAt: Date.now(),
    tickets: Array.isArray(tickets) ? tickets : [],
  };
  await setAppKv(db, orgActiveLeanListKey(orgId), JSON.stringify(payload));
}

/** Clears lean list snapshot only — does not touch per-base polygon cache entries. */
export async function invalidateOrgActiveTicketListCache(db: unknown, orgId: unknown): Promise<void> {
  try {
    await deleteAppKv(db, orgActiveLeanListKey(orgId));
  } catch (e) {
    console.warn("[ticketListCache] invalidate lean list:", (e as Error)?.message || e);
  }
}

export async function getTicketPolygonCacheEntry(
  db: unknown,
  orgId: unknown,
  normalizedBase: string
): Promise<TicketPolygonCacheEntry | null> {
  if (!normalizedBase) return null;
  const raw = await getAppKv(db, orgTicketPolygonCacheKey(orgId, normalizedBase));
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as TicketPolygonCacheEntry;
    if (!o || typeof o !== "object" || o.v !== TICKET_POLYGON_CACHE_SCHEMA_V) return null;
    if (o.polygon == null) return null;
    return o;
  } catch {
    return null;
  }
}

export async function setTicketPolygonCacheEntry(
  db: unknown,
  orgId: unknown,
  normalizedBase: string,
  entry: Omit<TicketPolygonCacheEntry, "v" | "builtAt"> & { v?: number; builtAt?: number }
): Promise<void> {
  if (!normalizedBase || entry == null || entry.polygon == null) return;
  const payload: TicketPolygonCacheEntry = {
    v: TICKET_POLYGON_CACHE_SCHEMA_V,
    builtAt: Date.now(),
    polygon: entry.polygon,
    minLng: entry.minLng ?? null,
    minLat: entry.minLat ?? null,
    maxLng: entry.maxLng ?? null,
    maxLat: entry.maxLat ?? null,
    pinLng: entry.pinLng ?? null,
    pinLat: entry.pinLat ?? null,
    ticketNumber: entry.ticketNumber,
  };
  await setAppKv(db, orgTicketPolygonCacheKey(orgId, normalizedBase), JSON.stringify(payload));
}

export async function invalidateTicketPolygonCache(
  db: unknown,
  orgId: unknown,
  normalizedBase: string
): Promise<void> {
  if (!normalizedBase) return;
  try {
    await deleteAppKv(db, orgTicketPolygonCacheKey(orgId, normalizedBase));
  } catch (e) {
    console.warn("[ticketListCache] invalidate polygon:", (e as Error)?.message || e);
  }
}

/**
 * Page a prebuilt ticket array with the same keyset rules as GET /tickets summary
 * (createdAt DESC, id DESC).
 */
export function pageTicketsByCreatedAtIdCursor(
  tickets: unknown[],
  cursor: { createdAt: string; id: number } | null,
  limit: number
): { page: unknown[]; hasMore: boolean; nextCursor: { createdAt: string; id: number } | null } {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  let list = Array.isArray(tickets) ? tickets.slice() : [];
  if (cursor && cursor.createdAt != null && cursor.id != null) {
    const cAt = String(cursor.createdAt);
    const cId = Number(cursor.id);
    list = list.filter((t) => {
      const row = t as { createdAt?: string; id?: number };
      const at = row && row.createdAt != null ? String(row.createdAt) : "";
      const id = row && row.id != null ? Number(row.id) : NaN;
      if (!at || !Number.isFinite(id)) return false;
      if (at < cAt) return true;
      if (at === cAt && id < cId) return true;
      return false;
    });
  }
  const hasMore = list.length > lim;
  const page = hasMore ? list.slice(0, lim) : list;
  const last = page.length > 0 ? (page[page.length - 1] as { createdAt?: string; id?: number }) : null;
  const nextCursor =
    hasMore && last && last.createdAt != null && last.id != null
      ? { createdAt: String(last.createdAt), id: Number(last.id) }
      : null;
  return { page, hasMore, nextCursor };
}
