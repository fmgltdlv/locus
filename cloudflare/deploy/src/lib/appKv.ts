import { getWorkerKv } from "../envContext.js";
import { runDb, getRow } from "./db.cjs";
import { getPacPollActiveLeaseMs, getCooperativeLockMs } from "./timeouts.cjs";

const KV_PREFIX = "appkv:v1:";

export const KEYS = {
  LAST_PACWEB_POLL_AT: "last_pacweb_poll_at",
  PAC_AUTO_POLL_LOCK_UNTIL: "pacweb_auto_poll_lock_until",
  PAC_AUTO_POLL_ACTIVE_UNTIL: "pacweb_auto_poll_active_until",
} as const;

export function orgUsanListLastSyncKey(orgId: unknown): string {
  return `org:${String(orgId)}:usan_list:last_sync_at`;
}

/**
 * Per-org map: request number → SHA-256 of last synced SearchCurrentUserEnquiries list row.
 * Stored JSON: `{ v: 1, entries: Record<string, string> }`. Bump **v** (or change key namespace)
 * if merge/stub logic changes so stale entries cannot skip needed D1 writes.
 */
export function orgUsanListSearchFingerprintMapKey(orgId: unknown): string {
  return `org:${String(orgId)}:usan_list:search_fp_map`;
}

export async function getUsanListSearchFingerprintMap(
  db: unknown,
  orgId: unknown
): Promise<Record<string, string>> {
  const raw = await getAppKv(db, orgUsanListSearchFingerprintMapKey(orgId));
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as { v?: number; entries?: Record<string, string> };
    if (o && typeof o === "object" && o.entries && typeof o.entries === "object" && !Array.isArray(o.entries)) {
      return o.entries;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export async function setUsanListSearchFingerprintMap(
  db: unknown,
  orgId: unknown,
  entries: Record<string, string>
): Promise<void> {
  await setAppKv(db, orgUsanListSearchFingerprintMapKey(orgId), JSON.stringify({ v: 1, entries }));
}

function orgUsanListLockKey(orgId: unknown): string {
  return `org:${String(orgId)}:usan_list:lock_until`;
}

function orgUsanListActiveKey(orgId: unknown): string {
  return `org:${String(orgId)}:usan_list:active_until`;
}

/** Prefer Workers KV; fall back to D1 `app_kv` when `APP_KV` is not bound (tests / legacy). */
export async function getAppKv(db: unknown, key: string): Promise<string | null> {
  const kv = getWorkerKv();
  if (kv) {
    const v = await kv.get(KV_PREFIX + key, "text");
    return v != null && v !== "" ? v : null;
  }
  const row = (await getRow(
    db,
    "SELECT value FROM app_kv WHERE key = ?",
    [key]
  )) as { value?: string } | null;
  return row && row.value != null ? String(row.value) : null;
}

/**
 * @param options.expirationTtl Seconds until KV hard-deletes the key (Cloudflare min 60). Ignored on D1 fallback.
 */
export async function setAppKv(
  db: unknown,
  key: string,
  value: string,
  options?: { expirationTtl?: number }
): Promise<void> {
  const kv = getWorkerKv();
  if (kv) {
    const ttl = options?.expirationTtl;
    if (ttl != null && Number.isFinite(ttl) && ttl >= 60) {
      await kv.put(KV_PREFIX + key, value, { expirationTtl: Math.floor(ttl) });
    } else {
      await kv.put(KV_PREFIX + key, value);
    }
    return;
  }
  await runDb(
    db,
    `INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

export async function deleteAppKv(db: unknown, key: string): Promise<void> {
  const kv = getWorkerKv();
  if (kv) {
    await kv.delete(KV_PREFIX + key);
    return;
  }
  await runDb(db, "DELETE FROM app_kv WHERE key = ?", [key]);
}

/**
 * Automatic PAC poll: check cool-down and in-flight; reserve active lease if allowed.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function tryBeginAutomaticPacPoll(db: unknown): Promise<{ ok: boolean; reason?: string }> {
  const now = Date.now();
  const leaseMs = getPacPollActiveLeaseMs();
  const activeUntil = now + leaseMs;

  const lockStr = await getAppKv(db, KEYS.PAC_AUTO_POLL_LOCK_UNTIL);
  if (lockStr) {
    const t = Date.parse(lockStr);
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "cooperative_lock" };
    }
  }

  const activeStr = await getAppKv(db, KEYS.PAC_AUTO_POLL_ACTIVE_UNTIL);
  if (activeStr) {
    const t = Date.parse(activeStr);
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "poll_in_progress" };
    }
  }

  await setAppKv(db, KEYS.PAC_AUTO_POLL_ACTIVE_UNTIL, new Date(activeUntil).toISOString());
  return { ok: true };
}

export async function releasePacPollActive(db: unknown): Promise<void> {
  await deleteAppKv(db, KEYS.PAC_AUTO_POLL_ACTIVE_UNTIL);
}

export async function markAutomaticPacPollSucceeded(db: unknown): Promise<void> {
  const now = Date.now();
  await deleteAppKv(db, KEYS.PAC_AUTO_POLL_ACTIVE_UNTIL);
  await setAppKv(db, KEYS.LAST_PACWEB_POLL_AT, new Date(now).toISOString());
  await setAppKv(db, KEYS.PAC_AUTO_POLL_LOCK_UNTIL, new Date(now + getCooperativeLockMs()).toISOString());
}

export async function markAutomaticPacPollFailed(db: unknown): Promise<void> {
  await releasePacPollActive(db);
}

export async function markPacPollManualSucceeded(db: unknown): Promise<void> {
  await setAppKv(db, KEYS.LAST_PACWEB_POLL_AT, new Date().toISOString());
}

export async function setUsanListLastSyncForOrg(db: unknown, orgId: unknown, at: Date = new Date()): Promise<void> {
  await setAppKv(db, orgUsanListLastSyncKey(orgId), at.toISOString());
}

/**
 * ISO timestamp of the last successful org-scoped USAN list poll, or null when unknown.
 */
export async function getUsanListLastSyncAtForOrg(db: unknown, orgId: unknown): Promise<string | null> {
  const raw = await getAppKv(db, orgUsanListLastSyncKey(orgId));
  if (!raw || String(raw).trim() === "") return null;
  const ts = Date.parse(String(raw).trim());
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

/**
 * True when a recent org list poll succeeded or the post-poll cooperative lock is still active.
 * Covers incremental poll returning `skipped: cooperative_lock` right after a successful sync.
 */
export async function isOrgUsanListFreshForOrg(db: unknown, orgId: unknown): Promise<boolean> {
  const now = Date.now();
  const lockMs = getCooperativeLockMs();

  const lastSyncRaw = await getAppKv(db, orgUsanListLastSyncKey(orgId));
  if (lastSyncRaw) {
    const lastSyncTs = Date.parse(String(lastSyncRaw).trim());
    if (Number.isFinite(lastSyncTs) && now - lastSyncTs < lockMs) {
      return true;
    }
  }

  const lockStr = await getAppKv(db, orgUsanListLockKey(orgId));
  if (lockStr) {
    const lockUntil = Date.parse(String(lockStr).trim());
    if (Number.isFinite(lockUntil) && now < lockUntil) {
      return true;
    }
  }

  return false;
}

/**
 * Org-scoped list poll guard. Unlike the legacy PAC poll keys above, this lets
 * different organizations poll concurrently while still de-duping same-org runs.
 */
export async function tryBeginAutomaticUsanListPollForOrg(
  db: unknown,
  orgId: unknown
): Promise<{ ok: boolean; reason?: string }> {
  const now = Date.now();
  const activeUntil = now + getPacPollActiveLeaseMs();

  const lockStr = await getAppKv(db, orgUsanListLockKey(orgId));
  if (lockStr) {
    const t = Date.parse(lockStr);
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "cooperative_lock" };
    }
  }

  const activeStr = await getAppKv(db, orgUsanListActiveKey(orgId));
  if (activeStr) {
    const t = Date.parse(activeStr);
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "poll_in_progress" };
    }
  }

  await setAppKv(db, orgUsanListActiveKey(orgId), new Date(activeUntil).toISOString());
  return { ok: true };
}

export async function tryBeginManualUsanListPollForOrg(
  db: unknown,
  orgId: unknown
): Promise<{ ok: boolean; reason?: string }> {
  const now = Date.now();
  const activeUntil = now + getPacPollActiveLeaseMs();

  const activeStr = await getAppKv(db, orgUsanListActiveKey(orgId));
  if (activeStr) {
    const t = Date.parse(activeStr);
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "poll_in_progress" };
    }
  }

  await setAppKv(db, orgUsanListActiveKey(orgId), new Date(activeUntil).toISOString());
  return { ok: true };
}

export async function releaseUsanListPollActiveForOrg(db: unknown, orgId: unknown): Promise<void> {
  await deleteAppKv(db, orgUsanListActiveKey(orgId));
}

export async function markUsanListPollSucceededForOrg(db: unknown, orgId: unknown): Promise<void> {
  const now = Date.now();
  await releaseUsanListPollActiveForOrg(db, orgId);
  await setUsanListLastSyncForOrg(db, orgId, new Date(now));
  await setAppKv(db, orgUsanListLockKey(orgId), new Date(now + getCooperativeLockMs()).toISOString());
}

export async function markUsanListPollManualSucceededForOrg(db: unknown, orgId: unknown): Promise<void> {
  const now = Date.now();
  await releaseUsanListPollActiveForOrg(db, orgId);
  await setUsanListLastSyncForOrg(db, orgId, new Date(now));
  await setAppKv(db, orgUsanListLockKey(orgId), new Date(now + getCooperativeLockMs()).toISOString());
}

/**
 * After a tier-C revision hunt, treat the org list as fresh for subsequent lite refreshes (tier B)
 * without requiring a separate usan-poll run.
 */
export async function markOrgUsanListFreshFromRevisionHunt(db: unknown, orgId: unknown): Promise<void> {
  const now = Date.now();
  await setUsanListLastSyncForOrg(db, orgId, new Date(now));
  await setAppKv(db, orgUsanListLockKey(orgId), new Date(now + getCooperativeLockMs()).toISOString());
}

export async function markUsanListPollFailedForOrg(db: unknown, orgId: unknown): Promise<void> {
  await releaseUsanListPollActiveForOrg(db, orgId);
}

function orgTicketDetailRefreshActiveKey(orgId: unknown, ticketNumber: unknown): string {
  const tn = ticketNumber != null ? String(ticketNumber).trim() : "";
  return `org:${String(orgId)}:ticket_refresh:active:${tn}`;
}

/** In-flight lease while POST /tickets/refresh runs for one ticket (popup-open dedupe). */
const TICKET_DETAIL_REFRESH_ACTIVE_LEASE_MS = 3 * 60 * 1000;

/**
 * Reserve a per-ticket refresh slot so concurrent popup-open refreshes do not stack nGen calls.
 * Manual `forceRefresh` bypasses this lease.
 */
export async function tryBeginTicketDetailRefreshForOrg(
  db: unknown,
  orgId: unknown,
  ticketNumber: unknown
): Promise<{ ok: boolean; reason?: string }> {
  const tn = ticketNumber != null ? String(ticketNumber).trim() : "";
  if (!tn) return { ok: false, reason: "missing_ticket_number" };
  const now = Date.now();
  const activeUntil = now + TICKET_DETAIL_REFRESH_ACTIVE_LEASE_MS;
  const key = orgTicketDetailRefreshActiveKey(orgId, tn);
  const existing = await getAppKv(db, key);
  if (existing) {
    const t = Date.parse(String(existing));
    if (Number.isFinite(t) && now < t) {
      return { ok: false, reason: "ticket_refresh_in_progress" };
    }
  }
  await setAppKv(db, key, new Date(activeUntil).toISOString());
  return { ok: true };
}

export async function releaseTicketDetailRefreshForOrg(
  db: unknown,
  orgId: unknown,
  ticketNumber: unknown
): Promise<void> {
  const tn = ticketNumber != null ? String(ticketNumber).trim() : "";
  if (!tn) return;
  await deleteAppKv(db, orgTicketDetailRefreshActiveKey(orgId, tn));
}
