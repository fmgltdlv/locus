import { canMutateOrganization } from '../../auth.js';
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import * as ticketSyncLane from "../../lib/ticketSyncLane.cjs";
import { INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams, applyIndexedColumnsToTicketShape } from '../../lib/ticketIndexedColumns.cjs';
import { persistTicketRowAfterDataChange } from '../../lib/ticketPersist.cjs';
import { mergeEnquirySearchIntoTicket, buildTicketDataFromNgenSearchListItem, mergePollSearchMetadataIntoTicket } from '../../lib/ngenEnquiryMerge.cjs';
import { collapseLatestRevisionPerBaseFromSearchItems } from '../../lib/usanRefreshTier.js';
import { collectNotificationRowsForPhoneDirectory, notificationsToOperatorResponses, upsertStationOperatorPhonesFromNotifications } from '../../lib/ngenNotificationsMerge.cjs';
import { pickCreatedByFromPacJobRow } from '../../lib/pacwebTicketFields.cjs';
import { runDb, getRow, allRows } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { isPosrStackEnabled, MAP_URL_BASE, POSR_API_BASE } from '../ticketProxyRoutes.js';
import { resolveNgenMapRequestNumber, fetchNgenMapPageParsed } from '../../lib/ngenMapPolygon.cjs';
import { TICKET_ROW_SELECT, buildTicketResponseForClient, buildTicketShapeForListPollMerge, findFullTicketRowForOrg, getWrittenTicketId, resolveTicketRowForOrg } from '../ticketRowHelpers.js';
import { upsertPacwebEnrichmentJobNumber, resolveJobNumberFromTicketData } from './refresh.js';
import { findOrganizationIdsForLodgedByUserName } from '../../lib/pacwebJobOrgResolve.cjs';

export function syntheticPacJobFromNgenSearchItem(item) {
    if (!item || typeof item !== "object") return null;
    const ed = item.enquiryDetails;
    if (!ed || typeof ed !== "object") return null;
    const rn = ed.requestNumber != null ? String(ed.requestNumber).trim() : "";
    if (!rn) return null;
    const jn = ed.jobNumber != null ? Number(ed.jobNumber) : null;
    const row: Record<string, unknown> = {
        RequestNumber: rn,
        LodgedByUserName: ed.lodgedByUserName != null ? String(ed.lodgedByUserName) : undefined,
    };
    if (jn != null && Number.isFinite(jn)) row.JobNumber = jn;
    if (ed.enquiryId != null) row.EnquiryId = ed.enquiryId;
    else if (ed.id != null) row.EnquiryId = ed.id;
    return row;
}

/**
 * nGen enquiry ids from recent succeeded app create submit jobs (for direct GetCurrentUserEnquiry import).
 * @param {import('sqlite3').Database|object} db
 * @param {number} orgId
 * @param {number} [daysBack]
 * @returns {Promise<number[]>}
 */
export async function loadPendingCreateEnquiryIds(db, orgId, daysBack = 14) {
    const oid = parseInt(String(orgId), 10);
    if (!Number.isFinite(oid)) return [];
    const days = Math.max(1, Math.min(90, parseInt(String(daysBack), 10) || 14));
    const rows = await allRows(
        db,
        `SELECT i.result_json
         FROM ticket_submit_job_items i
         INNER JOIN ticket_submit_jobs j ON j.id = i.job_id
         WHERE j.organization_id = ?
           AND j.operation = 'create'
           AND j.status IN ('completed', 'partial')
           AND i.status = 'succeeded'
           AND i.result_json IS NOT NULL
           AND datetime(COALESCE(j.finished_at, j.updated_at, j.created_at)) >= datetime('now', '-' || ? || ' days')`,
        [oid, days]
    );
    const ids = new Set();
    for (const row of rows || []) {
        try {
            const parsed = JSON.parse(String(row.result_json || ''));
            const raw =
                parsed && parsed.newEnquiryId != null
                    ? parsed.newEnquiryId
                    : parsed && parsed.body && parsed.body.newEnquiryId != null
                      ? parsed.body.newEnquiryId
                      : null;
            const n = raw != null ? Number(raw) : NaN;
            if (Number.isFinite(n) && n > 0) ids.add(n);
        } catch (_) {
            /* ignore malformed result_json */
        }
    }
    return [...ids];
}

const USAN_POLL_EXISTENCE_IN_CHUNK = 99;
const USAN_POLL_EXISTENCE_BASE_CHUNK = 35;

/**
 * In-memory index of ticket rows used during USAN list poll to avoid per-RN D1 round trips.
 */
export function createUsanPollExistenceIndex(rows) {
    const list = rows || [];
    return {
        ticketStoredForOrg(orgId, requestNumber) {
            const rn = String(requestNumber || "").trim();
            if (!rn) return false;
            const base = ticketBuilder.normalizeTicketBase(rn) || rn.split("-")[0];
            const oid = Number(orgId);
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                if (!r || Number(r.organization_id) !== oid) continue;
                const tn = String(r.ticket_number || "");
                if (tn === rn || tn === base || tn.startsWith(`${base}-`)) return true;
            }
            return false;
        },
        organizationIdsForRequestNumber(requestNumber) {
            const raw = String(requestNumber || "").trim();
            if (!raw) return [];
            const base = ticketBuilder.normalizeTicketBase(raw) || raw.split("-")[0];
            if (!base) return [];
            const set = new Set();
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                if (!r) continue;
                const tn = String(r.ticket_number || "");
                if (tn === raw || tn === base || tn.startsWith(`${base}-`)) {
                    const id = r.organization_id != null ? Number(r.organization_id) : NaN;
                    if (Number.isFinite(id)) set.add(id);
                }
            }
            return [...set];
        },
        existsInAnyOrganization(requestNumber) {
            const raw = String(requestNumber || "").trim();
            if (!raw) return false;
            const base = ticketBuilder.normalizeTicketBase(raw) || raw.split("-")[0];
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                if (!r) continue;
                const tn = String(r.ticket_number || "");
                if (tn === raw || tn === base || tn.startsWith(`${base}-`)) return true;
            }
            return false;
        },
    };
}

export async function preloadUsanPollTicketExistence(db, uniqueRn) {
    const rawKeys = new Set();
    const bases = new Set();
    for (let i = 0; i < uniqueRn.length; i++) {
        const rn = String(uniqueRn[i] || "").trim();
        if (!rn) continue;
        rawKeys.add(rn);
        const b = ticketBuilder.normalizeTicketBase(rn) || rn.split("-")[0];
        if (b) bases.add(b);
    }
    const collected = [];
    const rawList = [...rawKeys];
    for (let i = 0; i < rawList.length; i += USAN_POLL_EXISTENCE_IN_CHUNK) {
        const chunk = rawList.slice(i, i + USAN_POLL_EXISTENCE_IN_CHUNK);
        if (chunk.length === 0) continue;
        const ph = chunk.map(() => "?").join(",");
        const part = await allRows(
            db,
            `SELECT organization_id, ticket_number FROM tickets WHERE ticket_number IN (${ph})`,
            chunk
        );
        if (part && part.length) collected.push(...part);
    }
    const baseList = [...bases];
    for (let i = 0; i < baseList.length; i += USAN_POLL_EXISTENCE_BASE_CHUNK) {
        const chunk = baseList.slice(i, i + USAN_POLL_EXISTENCE_BASE_CHUNK);
        if (chunk.length === 0) continue;
        const ors = chunk.map(() => "(ticket_number = ? OR ticket_number LIKE ?)").join(" OR ");
        const params = chunk.flatMap((b) => [b, `${b}-%`]);
        const part = await allRows(db, `SELECT organization_id, ticket_number FROM tickets WHERE ${ors}`, params);
        if (part && part.length) collected.push(...part);
    }
    const seen = new Set();
    const deduped = [];
    for (let i = 0; i < collected.length; i++) {
        const r = collected[i];
        if (!r) continue;
        const k = `${r.organization_id}|${r.ticket_number}`;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(r);
    }
    return createUsanPollExistenceIndex(deduped);
}

/**
 * @returns {Promise<boolean>}
 */
export async function ticketAlreadyStoredForOrg(db, orgId, requestNumber) {
    const rn = String(requestNumber || '').trim();
    if (!rn) return false;
    const base = ticketBuilder.normalizeTicketBase(rn) || rn.split('-')[0];
    const row = await getRow(
        db,
        `SELECT id FROM tickets WHERE organization_id = ? AND (
            ticket_number = ? OR ticket_number = ? OR ticket_number LIKE ?
        ) LIMIT 1`,
        [orgId, rn, base, `${base}-%`]
    );
    return Boolean(row);
}

/**
 * True if any ticket row exists for this request number (any org).
 */
export async function ticketExistsInAnyOrganization(db, rn) {
    const base = String(rn).split('-')[0];
    const row = await getRow(
        db,
        `SELECT id FROM tickets WHERE ticket_number = ? OR ticket_number = ? OR ticket_number LIKE ? LIMIT 1`,
        [rn, base, `${base}-%`]
    );
    return Boolean(row);
}

/**
 * Find organizations that already contain this ticket/request family.
 * Used to route follow-up revisions when lodgedBy user changes.
 * @returns {Promise<number[]>}
 */
export async function findOrganizationIdsWithTicket(db, rn) {
    const raw = String(rn || '').trim();
    if (!raw) return [];
    const base = ticketBuilder.normalizeTicketBase(raw) || raw.split('-')[0];
    if (!base) return [];
    const rows = await allRows(
        db,
        `SELECT DISTINCT organization_id
         FROM tickets
         WHERE ticket_number = ? OR ticket_number = ? OR ticket_number LIKE ?`,
        [raw, base, `${base}-%`]
    );
    return (rows || [])
        .map((r) => (r && r.organization_id != null ? Number(r.organization_id) : NaN))
        .filter((v) => Number.isFinite(v));
}

/**
 * Best-effort cached ticket lookup across all organizations (exact, base, latest base-*).
 * @returns {Promise<object | null>}
 */
export async function findAnyTicketRowForRequestNumber(db, requestNumber) {
    const rn = String(requestNumber || '').trim();
    if (!rn) return null;
    const base = ticketBuilder.normalizeTicketBase(rn) || rn.split('-')[0];
    if (!base) return null;
    return getRow(
        db,
        `SELECT ${TICKET_ROW_SELECT}
         FROM tickets
         WHERE ticket_number = ? OR ticket_number = ? OR ticket_number LIKE ?
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT 1`,
        [rn, base, `${base}-%`]
    );
}

/**
 * Hydrated stored ticket -> POSR-safe projection for manual import responses.
 * Intentionally omits org-internal fields (assignees, override metadata, sharing flags, etc.).
 */
function sourceRowIsNgenPrimary(sourceRow: { sync_lane?: unknown } | null | undefined, storedTicketData: Record<string, unknown>) {
    const lane =
        sourceRow && sourceRow.sync_lane != null ? String(sourceRow.sync_lane).trim().toLowerCase() : '';
    if (lane === ticketSyncLane.SYNC_LANE_NGEN_PRIMARY) return true;
    const dataLane =
        storedTicketData.syncLane != null ? String(storedTicketData.syncLane).trim().toLowerCase() : '';
    if (dataLane === ticketSyncLane.SYNC_LANE_NGEN_PRIMARY) return true;
    const jn = storedTicketData.ngenJobNumber;
    if (jn != null && String(jn).trim() !== '') return true;
    return false;
}

export function buildPosrSafeProjectionFromStoredTicketData(
    storedTicketData,
    storageTicketNumber,
    sourceRow?: { sync_lane?: unknown } | null
) {
    if (!storedTicketData || typeof storedTicketData !== 'object') return null;
    const stored = storedTicketData as Record<string, unknown>;
    const parsed = ticketBuilder.parseTicketNumberParts(storageTicketNumber || storedTicketData.ticketNumber || '');
    const baseNumber = parsed.baseNumber || ticketBuilder.normalizeTicketBase(storageTicketNumber || storedTicketData.ticketNumber || '') || null;
    const revisionSuffix = parsed.revisionSuffix != null ? String(parsed.revisionSuffix).trim() : null;
    const ticketNumberFull =
        parsed.displayFull && String(parsed.displayFull).trim() !== ''
            ? String(parsed.displayFull).trim()
            : `${baseNumber || ''}${revisionSuffix ? `-${revisionSuffix}` : ''}`.trim();
    const out = {
        ticketNumber: baseNumber || (storedTicketData.ticketNumber ? String(storedTicketData.ticketNumber).trim() : null),
        ticketRevision: revisionSuffix || null,
        ticketNumberFull: ticketNumberFull || null,
        locationSummary:
            storedTicketData.locationSummary != null
                ? storedTicketData.locationSummary
                : storedTicketData.address != null
                  ? storedTicketData.address
                  : null,
        workDescription:
            storedTicketData.workDescription != null
                ? storedTicketData.workDescription
                : storedTicketData.workActivity != null
                  ? storedTicketData.workActivity
                  : storedTicketData.workType != null
                    ? storedTicketData.workType
                    : null,
        startTime: storedTicketData.startTime || null,
        legalStartDate: storedTicketData.legalStartDate || storedTicketData.startTime || null,
        endTime:
            storedTicketData.endTime ||
            storedTicketData.ticketExpirationDate ||
            storedTicketData.dueDate ||
            storedTicketData.workExpirationDate ||
            null,
        workExpirationDate: storedTicketData.workExpirationDate || storedTicketData.dueDate || null,
        dueDate: storedTicketData.dueDate || storedTicketData.workExpirationDate || null,
        ticketExpirationDate:
            storedTicketData.ticketExpirationDate ||
            storedTicketData.endTime ||
            storedTicketData.dueDate ||
            storedTicketData.workExpirationDate ||
            null,
        workType: storedTicketData.workType || null,
        workActivity: storedTicketData.workActivity || storedTicketData.workType || null,
        createdBy: storedTicketData.createdBy || null,
        createdBySource: storedTicketData.createdBySource || null,
        stationCodes: Array.isArray(storedTicketData.stationCodes) ? storedTicketData.stationCodes : [],
        stationDetails: Array.isArray(storedTicketData.stationDetails) ? storedTicketData.stationDetails : [],
        address: storedTicketData.address || null,
        ticketScope: storedTicketData.ticketScope || null,
        excavationMethod: storedTicketData.excavationMethod || null,
        history: Array.isArray(storedTicketData.history) ? storedTicketData.history : [],
        operatorResponses: Array.isArray(storedTicketData.operatorResponses) ? storedTicketData.operatorResponses : [],
        polygon: storedTicketData.polygon || null,
        importedAt: new Date().toISOString(),
        source: 'nv_api_cache',
        syncLane: ticketSyncLane.SYNC_LANE_POSR_PUBLIC,
    };
    if (sourceRowIsNgenPrimary(sourceRow, stored)) {
        out.syncLane = ticketSyncLane.SYNC_LANE_NGEN_PRIMARY;
        (out as Record<string, unknown>).crossOrgCacheFromNgenPrimary = true;
        if (stored.ngenJobNumber != null) (out as Record<string, unknown>).ngenJobNumber = stored.ngenJobNumber;
        if (stored.ngenRequiredResponseCount != null) {
            (out as Record<string, unknown>).ngenRequiredResponseCount = stored.ngenRequiredResponseCount;
        }
        if (stored.ngenReceivedResponseCount != null) {
            (out as Record<string, unknown>).ngenReceivedResponseCount = stored.ngenReceivedResponseCount;
        }
        if (stored.ticketDetailsSource != null) {
            (out as Record<string, unknown>).ticketDetailsSource = stored.ticketDetailsSource;
        }
    }
    if (stored.posrPortalDetailsOnly === true) {
        (out as Record<string, unknown>).posrPortalDetailsOnly = true;
    }
    if (stored.hasFullDetail === true) {
        (out as Record<string, unknown>).hasFullDetail = true;
    }
    ticketBuilder.applyPosrDerivedResponseCounts(out);
    return out;
}

/**
 * @returns {Promise<boolean>} true if a new row was inserted
 */
export async function insertPacUnassignedQueueRow(db, { requestNumber, jobRow, enquiry, userId }) {
    const jobJson = jobRow && typeof jobRow === 'object' ? JSON.stringify(jobRow) : null;
    const enqJson = enquiry && typeof enquiry === 'object' ? JSON.stringify(enquiry) : null;
    let lodgedByHint = null;
    const ed = enquiry && enquiry.enquiryDetails;
    if (ed && ed.lodgedByUserName != null && String(ed.lodgedByUserName).trim() !== '') {
        lodgedByHint = String(ed.lodgedByUserName).trim().toLowerCase();
    }
    const runResult = await runDb(
        db,
        `INSERT OR IGNORE INTO pac_unassigned_import_queue (request_number, job_row_json, enquiry_json, lodged_by_hint, created_by_user_id) VALUES (?, ?, ?, ?, ?)`,
        [requestNumber, jobJson, enqJson, lodgedByHint, userId]
    );
    return !!(runResult && runResult.changes > 0);
}

/**
 * Whether the caller may land poll/import writes in `orgId`.
 * Tech is blocked by default (manual import / queue / secondary poll targets).
 * USAN list poll may pass `allowTechForOrgId` so tech can sync only the hub org
 * they triggered the poll for — not other orgs they also belong to.
 * Explicit POST `/import` remains blocked by `assertNotTechWrite` on that route.
 * @param {{ allowTechForOrgId?: number }|null|undefined} [options]
 * @returns {Promise<boolean>}
 */
export async function userCanImportTicketToOrg(
    req,
    db,
    orgId,
    options?: { allowTechForOrgId?: number } | null
) {
    if (req.user.role === 'dev') return true;
    if (!canMutateOrganization(req.user, orgId)) return false;
    const role = await getMembershipRole(db, req.user.id, orgId);
    if (!isTechMembership(role)) return true;
    const allowFor =
        options && options.allowTechForOrgId != null ? Number(options.allowTechForOrgId) : NaN;
    return Number.isFinite(allowFor) && Number(orgId) === allowFor;
}

/**
 * Fetch NV public POSR JSON + map page, parse, and build a canonical ticket (no DB writes).
 * @returns {Promise<{ ok: boolean, ticket?: object, error?: string }>}
 */
export async function fetchNvPosrBuiltTicketForRequestNumber(rawTicketNumber: string) {
    const ticketNumber = String(rawTicketNumber || "").trim();
    if (!ticketNumber) {
        return { ok: false, error: "empty ticket number" };
    }
    if (!isPosrStackEnabled()) {
        return { ok: false, error: "public_posr_import_disabled_set_ENABLE_POSR_STACK=1" };
    }
    const base = ticketNumber.split("-")[0];
    try {
        const cacheBust = Date.now();
        const [posrRes, mapRes] = await Promise.all([
            fetch(`${POSR_API_BASE}${encodeURIComponent(ticketNumber)}&_=${cacheBust}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
                cache: "no-store",
            } as RequestInit),
            fetch(`${MAP_URL_BASE}${base}-000&_=${cacheBust}`, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                },
                cache: "no-store",
            } as RequestInit),
        ]);
        if (!posrRes.ok) {
            return { ok: false, error: `POSR fetch failed: ${posrRes.status}` };
        }
        const posrJson = await posrRes.json();
        const posrData = ticketBuilder.parsePosrData(posrJson);
        let mapData: { coords: number[][] | null; history: object[] } = { coords: null, history: [] };
        if (mapRes.ok) {
            const mapHtml = await mapRes.text();
            mapData = ticketBuilder.parseMapPageHtml(mapHtml);
        }
        const ticket = ticketBuilder.buildFromPosr(posrData, mapData);
        return { ok: true, ticket };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}

/**
 * Build ticket from public nGen map page only (polygon + optional history). No POSR JSON.
 * @returns {Promise<{ ok: boolean, ticket?: object, error?: string }>}
 */
export async function fetchNvNgenMapOnlyBuiltTicketForRequestNumber(rawTicketNumber: string) {
    const ticketNumber = String(rawTicketNumber || '').trim();
    if (!ticketNumber) {
        return { ok: false, error: 'empty ticket number' };
    }
    const reqNum = resolveNgenMapRequestNumber(ticketNumber);
    if (!reqNum) {
        return { ok: false, error: 'invalid ticket number' };
    }
    const parsed = await fetchNgenMapPageParsed(reqNum);
    if (!parsed.ok || !parsed.polygon) {
        return {
            ok: false,
            error: parsed.error || 'Could not load dig site polygon from USAN map',
        };
    }
    const ticket = ticketBuilder.buildFromNgenMapOnly(ticketNumber, parsed.polygon, parsed.mapData);
    return { ok: true, ticket };
}

/** True for tickets imported from NV public POSR/map (`nv_api`) or cross-org cache projection (`nv_api_cache`). */
export function isNvPublicImportTicketSource(source: unknown): boolean {
    return source === "nv_api" || source === "nv_api_cache";
}

/** POSR-owned fields merged on refresh for NV public import tickets (see {@link isNvPublicImportTicketSource}). */
const NV_POSR_REFRESH_FIELD_KEYS = [
    "operatorResponses",
    "stationDetails",
    "stationCodes",
    "history",
    "startTime",
    "legalStartDate",
    "endTime",
    "workExpirationDate",
    "dueDate",
    "ticketExpirationDate",
    "workType",
    "workActivity",
    "workDescription",
    "createdBy",
    "createdBySource",
    "address",
    "ticketScope",
    "locationSummary",
    "nearbyCrossStreet",
    "portalTicketType",
    "zipcode",
    "city",
    "county",
    "state",
    "customerPhone",
    "customerMobile",
    "customerEmail",
    "streetSidewalkOrParkstrip",
    "excavationMethod",
    "polygon",
    "ticketRevision",
    "ticketNumberFull",
    "syncLane",
] as const;

export function mergeNvPosrRefreshSnapshotIntoTicketData(
    prev: Record<string, unknown> | null | undefined,
    fresh: Record<string, unknown> | null | undefined
): Record<string, unknown> | null | undefined {
    if (!prev || typeof prev !== "object" || !fresh || typeof fresh !== "object") {
        return prev as Record<string, unknown> | null | undefined;
    }
    const out: Record<string, unknown> = { ...prev };
    for (const k of NV_POSR_REFRESH_FIELD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(fresh, k)) {
            out[k] = fresh[k];
        }
    }
    out.source = "nv_api";
    ticketBuilder.applyPosrDerivedResponseCounts(out);
    return out;
}

function posrResponseCountsMissing(ticket: Record<string, unknown> | null | undefined): boolean {
    if (!ticket || typeof ticket !== "object") return true;
    const req = ticket.ngenRequiredResponseCount;
    const rec = ticket.ngenReceivedResponseCount;
    const reqMissing = req == null || String(req).trim() === "" || !Number.isFinite(Number(req));
    const recMissing = rec == null || String(rec).trim() === "" || !Number.isFinite(Number(rec));
    return reqMissing || recMissing;
}

function isPosrTicketForResponseCounts(
    ticket: Record<string, unknown> | null | undefined,
    row: { sync_lane?: unknown } | null | undefined = null
): boolean {
    if (!ticket || typeof ticket !== "object") return false;
    const laneFromTicket =
        ticket.syncLane != null && String(ticket.syncLane).trim() !== ""
            ? String(ticket.syncLane).trim().toLowerCase()
            : "";
    if (laneFromTicket === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) return true;
    const laneFromRow =
        row && row.sync_lane != null && String(row.sync_lane).trim() !== ""
            ? String(row.sync_lane).trim().toLowerCase()
            : "";
    if (laneFromRow === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) return true;
    return isNvPublicImportTicketSource(ticket.source);
}

function ensurePosrLaneForDerivedCounts(
    ticket: Record<string, unknown>,
    row: { sync_lane?: unknown } | null | undefined = null
): void {
    if (
        ticket.syncLane != null &&
        String(ticket.syncLane).trim().toLowerCase() === ticketSyncLane.SYNC_LANE_POSR_PUBLIC
    ) {
        return;
    }
    const laneFromRow =
        row && row.sync_lane != null && String(row.sync_lane).trim() !== ""
            ? String(row.sync_lane).trim()
            : "";
    if (laneFromRow === ticketSyncLane.SYNC_LANE_POSR_PUBLIC) {
        ticket.syncLane = ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
        return;
    }
    if (isNvPublicImportTicketSource(ticket.source)) {
        ticket.syncLane = ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
    }
}

/**
 * When POSR operator rows exist but indexed required/received counts are missing, derive and persist.
 * @returns {Promise<boolean>} true when counts were written to D1
 */
export async function maybeEnsurePosrResponseCountsPersisted(
    db,
    orgId,
    row,
    ticket,
    opts: { userId?: number | null } = {}
): Promise<boolean> {
    if (!db || !row || !ticket || typeof ticket !== "object") return false;
    if (!isPosrTicketForResponseCounts(ticket as Record<string, unknown>, row)) return false;
    if (!posrResponseCountsMissing(ticket as Record<string, unknown>)) return false;

    const existing = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    if (existing.length === 0) return false;

    ensurePosrLaneForDerivedCounts(ticket as Record<string, unknown>, row);
    const prev = { ...(ticket as Record<string, unknown>) };
    ticketBuilder.applyPosrDerivedResponseCounts(ticket as Record<string, unknown>);
    if (posrResponseCountsMissing(ticket as Record<string, unknown>)) return false;

    const stripped = ticketBuilder.stripDerivedTicketUiFields(ticket as Record<string, unknown>);
    await persistTicketRowAfterDataChange(db, {
        ticketId: row.id,
        orgId,
        ticketNumber: row.ticket_number,
        stripped,
        prev,
        next: ticket,
        skipGeometry: true,
        userId: opts.userId != null ? opts.userId : null,
    });
    return true;
}

/**
 * When D1 has no operator rows for a POSR-lane ticket, fetch public POSR and persist so
 * db-detail / popup open does not require a separate manual refresh.
 * @returns {Promise<boolean>} true when a POSR snapshot was merged and persisted
 */
export async function maybeBackfillPosrOperatorResponsesOnOpen(
    db,
    orgId,
    row,
    ticket,
    opts: { userId?: number | null } = {}
): Promise<boolean> {
    if (!db || !row || !ticket || typeof ticket !== "object") return false;
    if (!isPosrStackEnabled()) return false;
    const lane =
        ticket.syncLane != null ? String(ticket.syncLane).trim().toLowerCase() : "";
    const isPosrLane = lane === ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
    const isPosrSource = isNvPublicImportTicketSource(ticket.source);
    if (!isPosrLane && !isPosrSource) return false;
    const existing = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    if (existing.length > 0) return false;

    const reqNum = resolvePosrFetchRequestNumberFromTicketData(ticket as Record<string, unknown>);
    if (!reqNum) return false;

    const posrBuilt = await fetchNvPosrBuiltTicketForRequestNumber(reqNum);
    if (!posrBuilt.ok || !posrBuilt.ticket) return false;

    const merged = mergeNvPosrRefreshSnapshotIntoTicketData(
        ticket as Record<string, unknown>,
        posrBuilt.ticket as Record<string, unknown>
    );
    if (!merged) return false;

    const freshOps = Array.isArray(merged.operatorResponses) ? merged.operatorResponses : [];
    const stationDetails = Array.isArray(merged.stationDetails) ? merged.stationDetails : [];
    const stationCodes = Array.isArray(merged.stationCodes) ? merged.stationCodes : [];
    if (freshOps.length === 0 && stationDetails.length === 0 && stationCodes.length === 0) return false;

    const prev = { ...(ticket as Record<string, unknown>) };
    const stripped = ticketBuilder.stripDerivedTicketUiFields(merged);
    const stampAt = new Date().toISOString();
    await persistTicketRowAfterDataChange(db, {
        ticketId: row.id,
        orgId,
        ticketNumber: row.ticket_number,
        stripped,
        prev,
        next: merged,
        stampFullDetailRefreshedAt: stampAt,
        userId: opts.userId != null ? opts.userId : null,
    });

    for (const k of NV_POSR_REFRESH_FIELD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(merged, k)) {
            (ticket as Record<string, unknown>)[k] = merged[k];
        }
    }
    if (merged.source != null) ticket.source = merged.source;
    if (merged.ngenRequiredResponseCount != null) {
        ticket.ngenRequiredResponseCount = merged.ngenRequiredResponseCount;
    }
    if (merged.ngenReceivedResponseCount != null) {
        ticket.ngenReceivedResponseCount = merged.ngenReceivedResponseCount;
    }
    ticket.ngenFullDetailRefreshedAt = stampAt;
    return true;
}

export function resolvePosrFetchRequestNumberFromTicketData(td: Record<string, unknown> | null | undefined): string | null {
    if (!td || typeof td !== "object") return null;
    const full =
        td.ticketNumberFull != null && String(td.ticketNumberFull).trim() !== ""
            ? String(td.ticketNumberFull).trim()
            : null;
    if (full) return full;
    const base =
        td.ticketNumber != null && String(td.ticketNumber).trim() !== "" ? String(td.ticketNumber).trim() : null;
    if (!base) return null;
    const rev =
        td.ticketRevision != null && String(td.ticketRevision).trim() !== ""
            ? String(td.ticketRevision).trim()
            : null;
    if (rev) return `${base}-${rev}`;
    return `${base}-000`;
}

/**
 * After INSERT/upsert of the tickets row, sync structured children/geometry.
 * Failures here must not mark the import as failed — the ticket is already stored.
 */
async function persistImportedTicketRowBestEffort(
    db,
    opts: {
        ticketId: number | string | null;
        orgId: number;
        ticketNumber: string;
        stripped: object;
        userId: number | string | null;
    }
) {
    let ticketId = opts.ticketId;
    if (ticketId == null) {
        ticketId = await getWrittenTicketId(db, opts.orgId, opts.ticketNumber);
    }
    if (ticketId == null) return;
    try {
        await persistTicketRowAfterDataChange(db, {
            ticketId,
            orgId: opts.orgId,
            ticketNumber: opts.ticketNumber,
            stripped: opts.stripped,
            skipRowUpdate: true,
            userId: opts.userId,
        });
    } catch (e: unknown) {
        console.error(
            '[import] post-write persist failed (ticket kept):',
            opts.ticketNumber,
            e instanceof Error ? e.message : String(e)
        );
    }
}

/**
 * Same NV public POSR + map import as POST /import (single ticket).
 * @returns {Promise<{ ok: boolean, ticket?: object, ticketNumber?: string, error?: string }>}
 */
export async function importOneTicketFromNvPublicApis(
    db,
    orgId,
    userId,
    rawTicketNumber,
    pacJobRow,
    forceExternalForOrg = false
) {
    const ticketNumber = String(rawTicketNumber || '').trim();
    if (!ticketNumber) {
        return { ok: false, ticketNumber: '', error: 'empty ticket number' };
    }
    try {
        const cachedRow = await findAnyTicketRowForRequestNumber(db, ticketNumber);
        if (cachedRow) {
            const cachedTicketData = (await buildTicketResponseForClient(
                db,
                cachedRow.organization_id != null ? Number(cachedRow.organization_id) : orgId,
                cachedRow
            )) as Record<string, unknown>;
            const projectedTicket = buildPosrSafeProjectionFromStoredTicketData(
                cachedTicketData,
                cachedRow.ticket_number || ticketNumber,
                cachedRow
            ) as Record<string, unknown> | null;
            if (projectedTicket) {
                if (forceExternalForOrg) projectedTicket.externalImportedToOrg = true;
                const responseBase =
                    (projectedTicket.ticketNumber && String(projectedTicket.ticketNumber).trim()) ||
                    ticketBuilder.normalizeTicketBase(ticketNumber) ||
                    ticketNumber.split("-")[0];
                const existingForOrg = await resolveTicketRowForOrg(db, orgId, ticketNumber);
                let rowId = existingForOrg ? existingForOrg.id : null;
                let createdAt = existingForOrg ? existingForOrg.created_at : null;
                let updatedAt = existingForOrg ? existingForOrg.updated_at : null;
                if (existingForOrg && forceExternalForOrg) {
                    try {
                        const existingTicketData = (await buildTicketResponseForClient(db, orgId, existingForOrg)) as Record<string, unknown>;
                        if (!existingTicketData.externalImportedToOrg) {
                            const prevExisting = { ...existingTicketData };
                            existingTicketData.externalImportedToOrg = true;
                            const strippedExisting = ticketBuilder.stripDerivedTicketUiFields(existingTicketData);
                            await persistTicketRowAfterDataChange(db, {
                                ticketId: existingForOrg.id,
                                orgId,
                                ticketNumber,
                                stripped: strippedExisting,
                                prev: prevExisting,
                                next: existingTicketData,
                            });
                        }
                    } catch (_) {
                        /* ignore parse errors; keep import response flow resilient */
                    }
                } else if (!existingForOrg) {
                    const strippedProjected = ticketBuilder.stripDerivedTicketUiFields(projectedTicket);
                    await runDb(
                        db,
                        INSERT_OR_REPLACE_SQL,
                        buildInsertOrReplaceParams(orgId, userId, responseBase, strippedProjected)
                    );
                    rowId = await getWrittenTicketId(db, orgId, responseBase);
                    // Ticket row is already written; structured/geometry sync must not fail the import response.
                    await persistImportedTicketRowBestEffort(db, {
                        ticketId: rowId,
                        orgId,
                        ticketNumber: responseBase,
                        stripped: strippedProjected,
                        userId,
                    });
                    if (rowId == null) {
                        rowId = await getWrittenTicketId(db, orgId, responseBase);
                    }
                }
                return {
                    ok: true,
                    ticket: {
                        ...projectedTicket,
                        ticketNumber: projectedTicket.ticketNumber || responseBase,
                        id: rowId,
                        createdAt: createdAt || new Date().toISOString(),
                        updatedAt: updatedAt || new Date().toISOString(),
                    },
                    ticketNumber: responseBase,
                };
            }
        }

        let ticket: Record<string, unknown>;
        if (isPosrStackEnabled()) {
            const posrBuilt = await fetchNvPosrBuiltTicketForRequestNumber(ticketNumber);
            if (!posrBuilt.ok || !posrBuilt.ticket) {
                return { ok: false, ticketNumber, error: posrBuilt.error || 'POSR build failed' };
            }
            ticket = posrBuilt.ticket as Record<string, unknown>;
        } else {
            const mapBuilt = await fetchNvNgenMapOnlyBuiltTicketForRequestNumber(ticketNumber);
            if (!mapBuilt.ok || !mapBuilt.ticket) {
                return {
                    ok: false,
                    ticketNumber,
                    error: mapBuilt.error || 'Could not load dig site from USAN map',
                };
            }
            ticket = mapBuilt.ticket as Record<string, unknown>;
        }
        const base = ticketNumber.split("-")[0];
        if (forceExternalForOrg) {
            ticket.externalImportedToOrg = true;
        }
        if (pacJobRow && typeof pacJobRow === 'object') {
            const cb = pickCreatedByFromPacJobRow(pacJobRow);
            if (cb) {
                ticket.createdBy = cb;
                ticket.createdBySource = 'pacweb';
            }
        }
        const stripped = ticketBuilder.stripDerivedTicketUiFields(ticket);
        const storageKeyBase =
            (ticket.ticketNumber && String(ticket.ticketNumber).trim()) ||
            ticketBuilder.normalizeTicketBase(ticketNumber) ||
            base;
        await runDb(db, INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams(orgId, userId, storageKeyBase, stripped));
        const rowId = await getWrittenTicketId(db, orgId, storageKeyBase);
        // Ticket row is already written; structured/geometry sync must not fail the import response.
        await persistImportedTicketRowBestEffort(db, {
            ticketId: rowId,
            orgId,
            ticketNumber: storageKeyBase,
            stripped,
            userId,
        });
        const writtenId = rowId != null ? rowId : await getWrittenTicketId(db, orgId, storageKeyBase);
        return {
            ok: true,
            ticket: {
                ...ticket,
                ticketNumber: ticket.ticketNumber || storageKeyBase,
                id: writtenId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            ticketNumber: storageKeyBase,
        };
    } catch (e: unknown) {
        return { ok: false, ticketNumber, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * PAC poll import: merge nGen enquiry (EnquirySearch / poll payload) into a ticket row keyed by **base** request number.
 * PAC poll path uses nGen enquiry only. Explicit public NV POSR/map import uses `ENABLE_POSR_STACK=1` + POST `/api/tickets/import` (separate from refresh).
 * @returns {Promise<{ ok: boolean, ticket?: object, ticketNumber?: string, error?: string }>}
 */
export async function importOneTicketPacPollNgenFirst(
    db,
    orgId,
    userId,
    rawTicketNumber,
    pacJobRow,
    enquiry
) {
    const rawFull = String(rawTicketNumber || "").trim();
    if (!rawFull) {
        return { ok: false, ticketNumber: "", error: "empty ticket number" };
    }
    if (!enquiry || !enquiry.enquiryDetails) {
        return {
            ok: false,
            ticketNumber: rawFull,
            error: "nGen enquiry details required for PAC poll import",
        };
    }
    try {
        const storageKeyBase = ticketBuilder.normalizeTicketBase(rawFull) || rawFull.split("-")[0];
        const seed = {
            ticketNumber: storageKeyBase,
            importedAt: new Date().toISOString(),
            source: "nv_api",
            syncLane: ticketSyncLane.SYNC_LANE_NGEN_PRIMARY,
        };
        let ticket = mergeEnquirySearchIntoTicket(seed, enquiry);
        try {
            await upsertStationOperatorPhonesFromNotifications(db, collectNotificationRowsForPhoneDirectory(enquiry));
        } catch (e) {
            console.warn("[usan-poll] station_operator_phones upsert:", e.message || e);
        }

        const stripped = ticketBuilder.stripDerivedTicketUiFields(ticket);
        await runDb(db, INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams(orgId, userId, storageKeyBase, stripped));
        const rowId = await getWrittenTicketId(db, orgId, storageKeyBase);
        await persistTicketRowAfterDataChange(db, {
            ticketId: rowId,
            orgId,
            ticketNumber: storageKeyBase,
            stripped,
            skipRowUpdate: true,
            userId,
        });
        return {
            ok: true,
            ticket: {
                ...ticket,
                ticketNumber: ticket.ticketNumber || storageKeyBase,
                id: rowId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            ticketNumber: storageKeyBase,
        };
    } catch (e) {
        return { ok: false, ticketNumber: rawFull, error: e.message || String(e) };
    }
}

/**
 * Lazy list sync: persist SearchCurrentUserEnquiries row only (no GetCurrentUserEnquiry / POSR).
 * Stubs use enquiryDetails from the list item only; full notifications and authority ids require GetCurrentUserEnquiryAsync on open/refresh.
 * @returns {Promise<{ ok: boolean, ticket?: object, ticketNumber?: string, error?: string }>}
 */
export async function upsertNgenSearchStubTicket(db, orgId, userId, rn, searchItem) {
    const rnHint = String(rn || "").trim();
    if (!rnHint) {
        return { ok: false, ticketNumber: "", error: "empty ticket number" };
    }
    const ticketData = buildTicketDataFromNgenSearchListItem(searchItem);
    if (!ticketData) {
        return { ok: false, ticketNumber: rnHint, error: "invalid_search_item" };
    }
    ticketData.syncLane = ticketSyncLane.SYNC_LANE_NGEN_PRIMARY;
    const storageKey = String(ticketData.ticketNumber || "").trim();
    if (!storageKey) {
        return { ok: false, ticketNumber: rnHint, error: "missing_base_ticket_number" };
    }
    try {
        const stripped = ticketBuilder.stripDerivedTicketUiFields(ticketData);
        await runDb(db, INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams(orgId, userId, storageKey, stripped));
        const rowId = await getWrittenTicketId(db, orgId, storageKey);
        await persistTicketRowAfterDataChange(db, {
            ticketId: rowId,
            orgId,
            ticketNumber: storageKey,
            stripped,
            skipRowUpdate: true,
            userId,
        });
        await upsertPacwebEnrichmentJobNumber(db, orgId, storageKey, resolveJobNumberFromTicketData(stripped));
        return {
            ok: true,
            ticket: {
                ...ticketData,
                ticketNumber: storageKey,
                id: rowId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            ticketNumber: storageKey,
        };
    } catch (e) {
        return { ok: false, ticketNumber: storageKey || rnHint, error: e.message || String(e) };
    }
}

/**
 * Phase 2: merge list metadata for sibling tickets discovered during revision hunt (background only).
 */
export async function mergeBackgroundSiblingSearchItemsFromHunt(db, orgId, userId, openedTicketBase, collectedSearchItems) {
    const openedBase = ticketBuilder.normalizeTicketBase(openedTicketBase) || String(openedTicketBase || '').split('-')[0];
    const latestByBase = collapseLatestRevisionPerBaseFromSearchItems(collectedSearchItems);
    let backgroundSiblingMergeCount = 0;
    let backgroundSiblingStubCount = 0;
    let backgroundSiblingSkippedOpenTicket = 0;
    const errors = [];

    for (const [base, { rn, searchItem }] of latestByBase) {
        if (base === openedBase) {
            backgroundSiblingSkippedOpenTicket++;
            continue;
        }
        const existing = await findFullTicketRowForOrg(db, orgId, rn);
        if (existing) {
            const rr = await mergePollSearchMetadataIntoExistingTicketRowLean(db, orgId, userId, rn, searchItem);
            if (rr.ok) backgroundSiblingMergeCount++;
            else errors.push({ ticketNumber: rn, error: rr.error || rr.reason || 'merge_failed' });
            continue;
        }
        const stub = await upsertNgenSearchStubTicket(db, orgId, userId, rn, searchItem);
        if (stub.ok) backgroundSiblingStubCount++;
        else errors.push({ ticketNumber: rn, error: stub.error || 'stub_failed' });
    }

    return {
        backgroundSiblingMergeCount,
        backgroundSiblingStubCount,
        backgroundSiblingSkippedOpenTicket,
        backgroundSiblingErrors: errors,
    };
}

/**
 * @returns {Promise<{ ok: boolean, ticketNumber?: string, reason?: string, error?: string }>}
 */
export async function mergePollSearchMetadataIntoExistingTicketRow(db, orgId, userId, rawTicketNumber, searchItem) {
    const row = await findFullTicketRowForOrg(db, orgId, rawTicketNumber);
    if (!row) {
        return { ok: false, reason: 'ticket_not_found', ticketNumber: rawTicketNumber };
    }
    try {
        const prev = await buildTicketShapeForListPollMerge(db, orgId, row);
        const next = mergePollSearchMetadataIntoTicket(prev, searchItem);
        const stripped = ticketBuilder.stripDerivedTicketUiFields(next);
        await persistTicketRowAfterDataChange(db, {
            ticketId: row.id,
            orgId,
            ticketNumber: row.ticket_number,
            stripped,
            prev,
            next,
            userId,
        });
        const ticketBase =
            ticketBuilder.normalizeTicketBase(row.ticket_number) || String(row.ticket_number || '').split('-')[0];
        await upsertPacwebEnrichmentJobNumber(db, orgId, ticketBase, resolveJobNumberFromTicketData(stripped));
        return { ok: true, ticketNumber: row.ticket_number || rawTicketNumber };
    } catch (e) {
        return { ok: false, ticketNumber: rawTicketNumber, error: e.message || String(e) };
    }
}

/**
 * List-sync metadata merge that avoids full structured hydration (operators/history).
 * Starts from indexed ticket columns (including polygon_json) so list poll cannot wipe dig-site geometry.
 */
export async function mergePollSearchMetadataIntoExistingTicketRowLean(db, orgId, userId, rawTicketNumber, searchItem) {
    const row = await findFullTicketRowForOrg(db, orgId, rawTicketNumber);
    if (!row) {
        return { ok: false, reason: 'ticket_not_found', ticketNumber: rawTicketNumber };
    }
    try {
        let prev = applyIndexedColumnsToTicketShape({}, row) as Record<string, unknown>;
        if (!prev || typeof prev !== 'object') prev = {};
        if (!prev.ticketNumber) prev.ticketNumber = ticketBuilder.normalizeTicketBase(row.ticket_number) || row.ticket_number;
        if (!prev.ticketNumberFull) prev.ticketNumberFull = row.ticket_number;

        const next = mergePollSearchMetadataIntoTicket(prev, searchItem);
        const stripped = ticketBuilder.stripDerivedTicketUiFields(next);
        await persistTicketRowAfterDataChange(db, {
            ticketId: row.id,
            orgId,
            ticketNumber: row.ticket_number,
            stripped,
            prev,
            next,
            userId,
        });
        const ticketBase =
            ticketBuilder.normalizeTicketBase(row.ticket_number) || String(row.ticket_number || '').split('-')[0];
        await upsertPacwebEnrichmentJobNumber(db, orgId, ticketBase, resolveJobNumberFromTicketData(stripped));
        return { ok: true, ticketNumber: row.ticket_number || rawTicketNumber };
    } catch (e) {
        return { ok: false, ticketNumber: rawTicketNumber, error: e.message || String(e) };
    }
}

export function getEnquiryNotifications(enquiry) {
    if (enquiry && Array.isArray(enquiry.notifications)) return enquiry.notifications;
    if (enquiry && Array.isArray(enquiry.Notifications)) return enquiry.Notifications;
    return [];
}

/**
 * Existing-ticket list sync update: pull current nGen notifications from the
 * already-fetched enquiry payload and replace only operator-derived fields.
 * This intentionally does not rebuild broader ticket detail from nGen and does
 * not fetch POSR/map.
 */
export async function refreshExistingTicketOperatorResponsesFromNgen(db, orgId, userId, rawTicketNumber, enquiry) {
    const notifications = getEnquiryNotifications(enquiry);
    if (!Array.isArray(notifications) || notifications.length === 0) {
        return { ok: false, reason: 'no_notifications', ticketNumber: rawTicketNumber };
    }
    const row = await findFullTicketRowForOrg(db, orgId, rawTicketNumber);
    if (!row) {
        return { ok: false, reason: 'ticket_not_found', ticketNumber: rawTicketNumber };
    }
    const prev = (await buildTicketResponseForClient(db, orgId, row)) as Record<string, unknown>;

    const parsed = ticketBuilder.parseTicketNumberParts(
        prev.ticketNumberFull || row.ticket_number || rawTicketNumber || ''
    );
    const ticketRevision =
        prev.ticketRevision != null
            ? String(prev.ticketRevision).trim()
            : parsed.revisionSuffix != null
              ? String(parsed.revisionSuffix).trim()
              : null;
    const ticketNumberFull =
        prev.ticketNumberFull != null && String(prev.ticketNumberFull).trim() !== ''
            ? String(prev.ticketNumberFull).trim()
            : parsed.displayFull || row.ticket_number || rawTicketNumber || null;
    const operatorResponses = notificationsToOperatorResponses(notifications, ticketRevision, ticketNumberFull);
    if (!operatorResponses.length) {
        return { ok: false, reason: 'no_operator_responses', ticketNumber: rawTicketNumber };
    }

    const next = {
        ...prev,
        operatorResponses,
        stationCodes: [...new Set(operatorResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean))],
        stationDetails: operatorResponses.map((r) => ({
            code: r.stationCode || r.operatorCode,
            name: r.operatorName,
            responseDate: r.respondedAt,
            responseCode: r.statusCode,
            comment: r.comment,
        })),
        operatorResponsesSource: 'ngen_notification',
        operatorResponsesRefreshedAt: new Date().toISOString(),
    };

    await upsertStationOperatorPhonesFromNotifications(db, notifications);
    const stripped = ticketBuilder.stripDerivedTicketUiFields(next);
    await persistTicketRowAfterDataChange(db, {
        ticketId: row.id,
        orgId,
        ticketNumber: row.ticket_number,
        stripped,
        prev,
        next,
        userId,
    });
    return { ok: true, ticketNumber: row.ticket_number || rawTicketNumber, operatorResponseCount: operatorResponses.length };
}

/**
 * @param {string[]} uniqueRn
 * @param {Map<string, string>} fingerprintByRequestNumber
 * @param {Record<string, string>} hubMap
 */
export function allHubFingerprintsMatch(uniqueRn, fingerprintByRequestNumber, hubMap) {
    if (!Array.isArray(uniqueRn) || uniqueRn.length === 0) return true;
    const m = hubMap && typeof hubMap === 'object' ? hubMap : {};
    for (let i = 0; i < uniqueRn.length; i++) {
        const rn = String(uniqueRn[i] || '').trim();
        if (!rn) continue;
        const fp = fingerprintByRequestNumber.get(rn);
        if (!fp || m[rn] !== fp) return false;
    }
    return true;
}

/**
 * After existence preload: true when every org/rn pair the import loop would touch is fingerprint-skipped.
 */
export async function importLoopWouldSkipAllByFingerprint({
    uniqueRn,
    fingerprintByRequestNumber,
    requestNumberToSearchItem,
    hubOrgId,
    pacAccounts,
    existenceIdx,
    ensureOrgListFingerprintMapLoaded,
    listWriteSkippedByFingerprint,
}) {
    let skipCount = 0;
    for (let i = 0; i < uniqueRn.length; i++) {
        const rn = String(uniqueRn[i] || '').trim();
        if (!rn) continue;
        const listFp = fingerprintByRequestNumber.get(rn) || null;
        if (!listFp) return { skipAll: false, skipCount: 0 };

        const searchItem = requestNumberToSearchItem.get(rn);
        const ed = searchItem && searchItem.enquiryDetails ? searchItem.enquiryDetails : null;
        const lodgedName = ed && ed.lodgedByUserName != null ? String(ed.lodgedByUserName) : '';
        const orgIds = findOrganizationIdsForLodgedByUserName(pacAccounts, lodgedName);
        const existingOrgIds = existenceIdx.organizationIdsForRequestNumber(rn);

        const toTry = new Set();
        toTry.add(hubOrgId);
        for (let j = 0; j < orgIds.length; j++) {
            if (orgIds[j] !== hubOrgId) toTry.add(orgIds[j]);
        }
        for (let j = 0; j < existingOrgIds.length; j++) {
            if (existingOrgIds[j] !== hubOrgId) toTry.add(existingOrgIds[j]);
        }

        for (const tid of toTry) {
            const exists = existenceIdx.ticketStoredForOrg(tid, rn);
            if (!exists) {
                if (pacAccounts.length > 0 && orgIds.length === 0 && existingOrgIds.length === 0) {
                    return { skipAll: false, skipCount: 0 };
                }
                await ensureOrgListFingerprintMapLoaded(tid);
                if (!listWriteSkippedByFingerprint(tid, rn, listFp)) {
                    return { skipAll: false, skipCount: 0 };
                }
                skipCount++;
                continue;
            }
            await ensureOrgListFingerprintMapLoaded(tid);
            if (!listWriteSkippedByFingerprint(tid, rn, listFp)) {
                return { skipAll: false, skipCount: 0 };
            }
            skipCount++;
        }
    }
    return { skipAll: true, skipCount };
}

// Import by ticket number: fetch POSR + map, build ticket via ticketBuilder, save and return
