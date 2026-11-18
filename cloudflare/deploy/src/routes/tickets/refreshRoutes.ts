// Ticket refresh routes (split from former monolithic refresh.ts Phase 1)
import { getDatabase } from '../../database.js';
import { ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { canViewerRefreshSharedTicketFromOrg, parseViewerOrganizationId } from '../../lib/partnerTicketAccess.js';
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import * as ticketSyncLane from "../../lib/ticketSyncLane.cjs";
import { persistTicketRowAfterDataChange } from '../../lib/ticketPersist.cjs';
import { propagateDigSitePolygonToBaseTickets } from '../../lib/ticketBaseGeometry.cjs';
import { getNgenCredentialsForPoll } from '../../lib/pacPollNgenCredentials.cjs';
import { withNgenAuthRetry as withNgenAuthRetryRaw, fetchEnquirySearch } from '../../lib/ngenClient.cjs';
import { runDb, getRow } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { fetchNgenMapPolygonGeoJSON } from '../../lib/ngenMapPolygon.cjs';
import { getTicketDetailCoopLockMs } from '../../lib/timeouts.cjs';
import { markOrgUsanListFreshFromRevisionHunt, tryBeginTicketDetailRefreshForOrg, releaseTicketDetailRefreshForOrg } from '../../lib/appKv.js';
import { getTicketPolygonCacheEntry, setTicketPolygonCacheEntry, invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { isPosrStackEnabled } from '../ticketProxyRoutes.js';
import { assertNotTechWrite, attachComputedWorkflowStatusForOrgTicket, buildTicketResponseForClient, findFullTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
import * as pollHelpers from './pollHelpers.js';
import { fanoutRefreshedTicketToSiblingRows } from './refreshFanout.js';
import { canSkipRevisionFollowForLiteRefresh, finalizeMergedTicketForClient, resolveNgenJobNumberForTicket, runBackgroundOrgSyncAfterTicketRefresh, runBackgroundPersistAfterLiteRefresh, runNgenEnquiryRefreshIfConfiguredWithTimeout } from './refreshNgen.js';

/** CJS helper is untyped — keep return as any until ngenClient is typed. */
async function withNgenAuthRetry(...args: any[]): Promise<any> {
    return (withNgenAuthRetryRaw as (...a: any[]) => Promise<any>)(...args);
}

const POLYGONS_BATCH_MAX = 100;

async function writeThroughTicketPolygonCache(db, orgId, ticketNumber, polygon, bounds, pin) {
    const base = ticketBuilder.normalizeTicketBase(ticketNumber) || String(ticketNumber || '').split('-')[0];
    if (!base || !hasDisplayablePolygonValue(polygon)) return;
    await setTicketPolygonCacheEntry(db, orgId, base, {
        polygon,
        minLng: bounds && bounds.minLng != null ? bounds.minLng : null,
        minLat: bounds && bounds.minLat != null ? bounds.minLat : null,
        maxLng: bounds && bounds.maxLng != null ? bounds.maxLng : null,
        maxLat: bounds && bounds.maxLat != null ? bounds.maxLat : null,
        pinLng: pin && pin.lng != null ? pin.lng : null,
        pinLat: pin && pin.lat != null ? pin.lat : null,
        ticketNumber: String(ticketNumber),
    });
}

/** Per-ticket cooperative lock from `ngenFullDetailRefreshedAt` (see `TICKET_DETAIL_COOP_LOCK_MS`). */
function isTicketFullDetailWithinCoopLock(ticketData) {
    if (!ticketData || typeof ticketData !== 'object' || ticketData.ngenSearchStub) return false;
    const at = ticketData.ngenFullDetailRefreshedAt;
    if (typeof at !== 'string' || !at.trim()) return false;
    const ts = Date.parse(at);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < getTicketDetailCoopLockMs();
}

async function buildCachedTicketRefreshSkippedResponse(
    db,
    orgId,
    row,
    refreshMode,
    refreshStartedAt,
    phaseStartedAt,
    timings,
    c,
    opts
) {
    const result = await buildTicketResponseForClient(db, orgId, row);
    await attachComputedWorkflowStatusForOrgTicket(db, orgId, result);
    timings.finalBuildMs = Date.now() - phaseStartedAt;
    timings.totalMs = Date.now() - refreshStartedAt;
    console.log('[ticketRefresh] timings', {
        orgId,
        ticketNumber: row.ticket_number,
        refreshMode,
        refreshSkipped: true,
        refreshSkipReason: opts && opts.refreshSkipReason,
        ...timings,
    });
    scheduleWorkerBackgroundTask(c, runBackgroundOrgSyncAfterTicketRefresh({
        db,
        orgId,
        userId: opts && opts.userId,
        storageKey: row.ticket_number,
        reqUser: opts && opts.reqUser,
        revisionFollowRan: false,
        collectedSearchItems: [],
    }));
    return {
        ticket: result,
        refreshSkipped: true,
        refreshSkipReason: opts && opts.refreshSkipReason,
        refreshMode,
        timings,
    };
}

function scheduleWorkerBackgroundTask(c, task) {
    const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(task);
        return true;
    }
    void task;
    return false;
}

function workerHasWaitUntil(c) {
    const ctx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
    return !!(ctx && typeof ctx.waitUntil === 'function');
}

function hasDisplayablePolygonValue(polygon) {
    if (!polygon || typeof polygon !== "object") return false;
    if (polygon.type === "Polygon" || polygon.type === "MultiPolygon") return true;
    if (polygon.type === "Feature" && polygon.geometry) return true;
    if (polygon.type === "FeatureCollection" && Array.isArray(polygon.features) && polygon.features.length > 0) {
        return true;
    }
    return Array.isArray((polygon as { coordinates?: unknown }).coordinates);
}

function polygonBoundsForIndexedColumns(polygon) {
    if (!polygon || typeof polygon !== "object") return null;
    const rings =
        polygon.type === "Polygon" && Array.isArray((polygon as { coordinates?: unknown }).coordinates)
            ? [(polygon as { coordinates: unknown[] }).coordinates[0]]
            : polygon.type === "MultiPolygon" && Array.isArray((polygon as { coordinates?: unknown }).coordinates)
              ? (polygon as { coordinates: unknown[] }).coordinates
                    .map((poly) => (Array.isArray(poly) ? poly[0] : null))
                    .filter(Boolean)
              : [];
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const ring of rings) {
        if (!Array.isArray(ring)) continue;
        for (const pt of ring) {
            if (!Array.isArray(pt) || pt.length < 2) continue;
            const lng = Number(pt[0]);
            const lat = Number(pt[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        }
    }
    if (!Number.isFinite(minLng) || minLng === Infinity) return null;
    return { minLng, minLat, maxLng, maxLat };
}

function polygonPatchFromRow(row, orgId, polygonOverride = null) {
    let polygon = polygonOverride;
    if (!hasDisplayablePolygonValue(polygon) && row && row.polygon_json) {
        try {
            polygon = JSON.parse(row.polygon_json);
        } catch (_) {
            polygon = null;
        }
    }
    const patch: Record<string, unknown> = {
        id: row.id,
        ticketNumber: row.ticket_number,
        organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
        polygon: hasDisplayablePolygonValue(polygon) ? polygon : null,
        polygonOnly: true,
    };
    if (row.min_lng != null && row.min_lat != null && row.max_lng != null && row.max_lat != null) {
        patch.bbox = {
            minLng: Number(row.min_lng),
            minLat: Number(row.min_lat),
            maxLng: Number(row.max_lng),
            maxLat: Number(row.max_lat),
        };
    }
    return patch;
}

async function fetchNgenEnquiryPolygonOnly(db, orgId, storageKey) {
    try {
        const jobNum = await resolveNgenJobNumberForTicket(db, orgId, storageKey);
        if (jobNum == null) return { polygon: null, reason: "no_ngen_job_number" };
        const svc = await getNgenCredentialsForPoll(db, orgId);
        if (!svc || !svc.user || !svc.pass) {
            return { polygon: null, reason: "no_ngen_credentials" };
        }
        const enquiry = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobNum, async ({ jar, refererApp }) =>
            fetchEnquirySearch(fetch, jar, refererApp, jobNum)
        );
        const ed = enquiry && (enquiry.enquiryDetails || enquiry.EnquiryDetails);
        const wkt = ed && ed.spatialObjectDescription != null ? String(ed.spatialObjectDescription).trim() : "";
        const polygon = wkt ? ticketBuilder.wktToGeoJSON(wkt) : null;
        return { polygon: hasDisplayablePolygonValue(polygon) ? polygon : null, reason: polygon ? "ngen_detail" : "no_ngen_polygon" };
    } catch (e) {
        return { polygon: null, reason: e && e.message ? e.message : String(e) };
    }
}

/**
 * Manual refresh: merge **additional** ticket detail from nGen; for `source: nv_api` or `nv_api_cache` also re-fetch
 * public POSR + map when `ENABLE_POSR_STACK=1` and merge operator responses and NV portal fields (no schema change).
 * POSR snapshot merge runs on both lite and deep refresh (UI uses lite for the popup refresh button).
 *
 * 1) nGen EnquirySearch when job/enquiry id + USAN service credentials exist (notification history is loaded
 *    only via POST /ngen-notification-history when Ticket History opens — not on refresh).
 * 2) NV POSR + map for NV public import tickets after the above, replacing POSR-derived operator rows and dates.
 *
 * Ticket `source` stays `nv_api` for manual-import rows unless a prior merge set a different `source`.
 */

export function registerTicketsRefreshRoutes(tickets: TicketsApp) {
  /**
   * Batch dig-site polygons: server polygon cache → D1 tickets.polygon_json (any same-base revision) → fill cache.
   * Does not call upstream; use polygon-backfill when needsBackfill.
   */
  tickets.post('/polygons', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const membershipRole =
          req.user.role === 'dev' ? null : await getMembershipRole(db, req.user.id, orgId);
      const membershipRoleViewer =
          viewerOrgId != null && Number(viewerOrgId) !== Number(orgId) && req.user.role !== 'dev'
              ? await getMembershipRole(db, req.user.id, viewerOrgId)
              : membershipRole;
      const isTechViewer = isTechMembership(membershipRole) || isTechMembership(membershipRoleViewer);
      if (!isTechViewer) {
          const may = await canViewerRefreshSharedTicketFromOrg(db, req.user, orgId, viewerOrgId);
          if (!may) {
              return res.status(403).json({ error: 'You do not have access to that organization' });
          }
      }

      const rawList = Array.isArray(req.body.ticketNumbers) ? req.body.ticketNumbers : [];
      const ticketNumbers = [
          ...new Set(
              rawList
                  .map((t) => (t != null ? String(t).trim() : ''))
                  .filter(Boolean)
          ),
      ].slice(0, POLYGONS_BATCH_MAX);

      const polygons = [];
      const needsBackfill = [];

      for (const tn of ticketNumbers) {
          if (isTechViewer) {
              if (!(await ticketDataAccessibleToTechUser(db, orgId, req.user.id, tn))) {
                  continue;
              }
          }
          const base = ticketBuilder.normalizeTicketBase(tn) || String(tn).split('-')[0];
          const cached = await getTicketPolygonCacheEntry(db, orgId, base);
          if (cached && hasDisplayablePolygonValue(cached.polygon)) {
              polygons.push({
                  ticketNumber: tn,
                  ticketBase: base,
                  polygon: cached.polygon,
                  bbox:
                      cached.minLng != null && cached.minLat != null && cached.maxLng != null && cached.maxLat != null
                          ? {
                                minLng: cached.minLng,
                                minLat: cached.minLat,
                                maxLng: cached.maxLng,
                                maxLat: cached.maxLat,
                            }
                          : undefined,
                  pin:
                      cached.pinLng != null && cached.pinLat != null
                          ? { lng: cached.pinLng, lat: cached.pinLat }
                          : undefined,
                  cache: 'hit',
              });
              continue;
          }

          const row = await getRow(
              db,
              `SELECT id, organization_id, ticket_number, polygon_json, min_lng, min_lat, max_lng, max_lat, pin_lng, pin_lat
               FROM tickets
               WHERE organization_id = ? AND (ticket_number = ? OR ticket_number LIKE ?)
               ORDER BY
                 CASE WHEN polygon_json IS NOT NULL AND TRIM(polygon_json) != '' THEN 0 ELSE 1 END,
                 CASE WHEN ticket_number = ? THEN 0 ELSE 1 END,
                 id DESC
               LIMIT 1`,
              [orgId, tn, `${base}-%`, tn]
          );
          let polygon = null;
          let bounds = null;
          let pin = null;
          if (row) {
              if (row.polygon_json) {
                  try {
                      polygon = JSON.parse(row.polygon_json);
                  } catch (_) {
                      polygon = null;
                  }
              }
              if (hasDisplayablePolygonValue(polygon)) {
                  bounds = {
                      minLng: row.min_lng,
                      minLat: row.min_lat,
                      maxLng: row.max_lng,
                      maxLat: row.max_lat,
                  };
              }
          }
          // Prefer pin from the requested ticket number (not the polygon-source sibling).
          const pinRow = await getRow(
              db,
              `SELECT pin_lng, pin_lat
               FROM tickets
               WHERE organization_id = ? AND (ticket_number = ? OR ticket_number LIKE ?)
               ORDER BY CASE WHEN ticket_number = ? THEN 0 ELSE 1 END, id DESC
               LIMIT 1`,
              [orgId, tn, `${base}-%`, tn]
          );
          if (pinRow && pinRow.pin_lng != null && pinRow.pin_lat != null) {
              pin = { lng: Number(pinRow.pin_lng), lat: Number(pinRow.pin_lat) };
          } else if (row && row.pin_lng != null && row.pin_lat != null) {
              pin = { lng: Number(row.pin_lng), lat: Number(row.pin_lat) };
          }

          if (hasDisplayablePolygonValue(polygon)) {
              if (!bounds) {
                  bounds = polygonBoundsForIndexedColumns(polygon);
              }
              await writeThroughTicketPolygonCache(db, orgId, tn, polygon, bounds, pin);
              polygons.push({
                  ticketNumber: tn,
                  ticketBase: base,
                  polygon,
                  bbox: bounds || undefined,
                  pin: pin || undefined,
                  cache: 'miss',
              });
          } else {
              needsBackfill.push(tn);
          }
      }

      return res.json({ polygons, needsBackfill });
  });

  tickets.post('/polygon-backfill', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      const ticketNumber = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : null;
      if (!ticketNumber) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const membershipRole =
          req.user.role === 'dev' ? null : await getMembershipRole(db, req.user.id, orgId);
      const membershipRoleViewer =
          viewerOrgId != null && Number(viewerOrgId) !== Number(orgId) && req.user.role !== 'dev'
              ? await getMembershipRole(db, req.user.id, viewerOrgId)
              : membershipRole;
      const isTechViewer = isTechMembership(membershipRole) || isTechMembership(membershipRoleViewer);
      if (isTechViewer) {
          if (!(await ticketDataAccessibleToTechUser(db, orgId, req.user.id, ticketNumber))) {
              return res.status(403).json({ error: 'You do not have access to this ticket' });
          }
      } else {
          const mayRefresh = await canViewerRefreshSharedTicketFromOrg(db, req.user, orgId, viewerOrgId);
          if (!mayRefresh) {
              return res.status(403).json({ error: 'You do not have access to that organization' });
          }
      }

      try {
          const startedAt = Date.now();
          const row = await getRow(
              db,
              `SELECT id, organization_id, ticket_number, polygon_json, min_lng, min_lat, max_lng, max_lat, sync_lane
               FROM tickets
               WHERE organization_id = ? AND (ticket_number = ? OR ticket_number LIKE ?)
               ORDER BY CASE WHEN ticket_number = ? THEN 0 ELSE 1 END, id DESC
               LIMIT 1`,
              [orgId, ticketNumber, `${ticketBuilder.normalizeTicketBase(ticketNumber) || ticketNumber.split("-")[0]}-%`, ticketNumber]
          );
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }

          if (row.polygon_json) {
              const patch = polygonPatchFromRow(row, orgId);
              if (hasDisplayablePolygonValue(patch.polygon)) {
                  await writeThroughTicketPolygonCache(
                      db,
                      orgId,
                      row.ticket_number,
                      patch.polygon,
                      patch.bbox,
                      null
                  );
              }
              return res.json({
                  ticket: patch,
                  polygonBackfillSkipped: true,
                  reason: 'already_stored',
                  timings: { totalMs: Date.now() - startedAt },
              });
          }
          const base =
              ticketBuilder.normalizeTicketBase(row.ticket_number) ||
              String(row.ticket_number || '').split('-')[0];
          const siblingWithPolygon = await getRow(
              db,
              `SELECT id, organization_id, ticket_number, polygon_json, min_lng, min_lat, max_lng, max_lat, sync_lane
               FROM tickets
               WHERE organization_id = ?
                 AND (ticket_number = ? OR ticket_number LIKE ?)
                 AND polygon_json IS NOT NULL
                 AND TRIM(polygon_json) != ''
               ORDER BY id DESC
               LIMIT 1`,
              [orgId, base, `${base}-%`]
          );
          if (siblingWithPolygon && siblingWithPolygon.polygon_json) {
              let siblingPolygon = null;
              try {
                  siblingPolygon = JSON.parse(siblingWithPolygon.polygon_json);
              } catch (_) {
                  siblingPolygon = null;
              }
              if (hasDisplayablePolygonValue(siblingPolygon)) {
                  await propagateDigSitePolygonToBaseTickets(db, orgId, row.ticket_number, siblingPolygon);
                  const patch = polygonPatchFromRow(row, orgId, siblingPolygon);
                  const siblingBounds = {
                      minLng: siblingWithPolygon.min_lng,
                      minLat: siblingWithPolygon.min_lat,
                      maxLng: siblingWithPolygon.max_lng,
                      maxLat: siblingWithPolygon.max_lat,
                  };
                  await writeThroughTicketPolygonCache(
                      db,
                      orgId,
                      row.ticket_number,
                      siblingPolygon,
                      patch.bbox || siblingBounds,
                      null
                  );
                  return res.json({
                      ticket: patch,
                      polygonBackfillSkipped: true,
                      reason: 'already_stored',
                      timings: { totalMs: Date.now() - startedAt },
                  });
              }
          }
          const reqNum = pollHelpers.resolvePosrFetchRequestNumberFromTicketData({
              ticketNumber: row.ticket_number,
              ticketNumberFull: row.ticket_number,
          });
          let polygon = null;
          let source = null;
          let skipReason = reqNum ? "map_no_polygon" : "no_request_number";

          if (reqNum) {
              try {
                  polygon = await fetchNgenMapPolygonGeoJSON(reqNum, fetch);
                  if (hasDisplayablePolygonValue(polygon)) {
                      source = "ngen_map";
                  }
              } catch (mapErr) {
                  skipReason = mapErr && mapErr.message ? mapErr.message : String(mapErr);
              }
          }

          if (!hasDisplayablePolygonValue(polygon)) {
              const fallback = await fetchNgenEnquiryPolygonOnly(db, orgId, row.ticket_number);
              if (fallback && hasDisplayablePolygonValue(fallback.polygon)) {
                  polygon = fallback.polygon;
                  source = "ngen_detail";
              } else {
                  skipReason = fallback && fallback.reason ? fallback.reason : skipReason;
              }
          }

          if (!hasDisplayablePolygonValue(polygon)) {
              return res.json({
                  ticket: polygonPatchFromRow(row, orgId),
                  polygonBackfillSkipped: true,
                  reason: skipReason,
                  timings: { totalMs: Date.now() - startedAt },
              });
          }

          const bounds = polygonBoundsForIndexedColumns(polygon);
          await propagateDigSitePolygonToBaseTickets(db, orgId, row.ticket_number, polygon);
          if (userId != null) {
              await runDb(db, `UPDATE tickets SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
                  userId,
                  row.id,
              ]);
          }

          await writeThroughTicketPolygonCache(db, orgId, row.ticket_number, polygon, bounds, null);
          void invalidateOrgActiveTicketListCache(db, orgId);

          return res.json({
              ticket: {
                  id: row.id,
                  ticketNumber: row.ticket_number,
                  organizationId: row.organization_id != null ? Number(row.organization_id) : orgId,
                  polygon,
                  polygonOnly: true,
                  ...(bounds ? { bbox: bounds } : {}),
              },
              polygonBackfilled: true,
              source,
              timings: { totalMs: Date.now() - startedAt },
          });
      } catch (e) {
          console.error('Error polygon-backfill ticket:', e);
          return res.status(500).json({ error: e.message || String(e) });
      }
  });

  tickets.post('/refresh', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      const ticketNumber = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : null;
      if (!ticketNumber) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      const viewerOrgId = parseViewerOrganizationId(req.body, req.query, req.user);
      const membershipRole =
          req.user.role === 'dev' ? null : await getMembershipRole(db, req.user.id, orgId);
      const membershipRoleViewer =
          viewerOrgId != null && Number(viewerOrgId) !== Number(orgId) && req.user.role !== 'dev'
              ? await getMembershipRole(db, req.user.id, viewerOrgId)
              : membershipRole;
      if (isTechMembership(membershipRole) || isTechMembership(membershipRoleViewer)) {
          if (!(await ticketDataAccessibleToTechUser(db, orgId, req.user.id, ticketNumber))) {
              return res.status(403).json({ error: 'You do not have access to refresh this ticket' });
          }
      } else {
          const mayRefresh = await canViewerRefreshSharedTicketFromOrg(db, req.user, orgId, viewerOrgId);
          if (!mayRefresh) {
              return res.status(403).json({ error: 'You do not have access to that organization' });
          }
          const techOrgId =
              viewerOrgId != null && Number(viewerOrgId) !== Number(orgId) ? viewerOrgId : orgId;
          if (!(await assertNotTechWrite(req, res, techOrgId))) return;
      }
      let ticketRefreshLeaseHeld = false;
      let storageKey = ticketNumber;
      try {
          const refreshStartedAt = Date.now();
          const timings: Record<string, any> = {};
          const markTiming = (key, startedAt) => {
              timings[key] = Date.now() - startedAt;
              return Date.now();
          };
          let phaseStartedAt = Date.now();
          const row = await findFullTicketRowForOrg(db, orgId, ticketNumber);
          phaseStartedAt = markTiming('initialRowReadMs', phaseStartedAt);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          storageKey = row.ticket_number;

          let source = null;
          let ticketDetailsSourceBefore = null;
          let ticketDataBefore = null;
          const requestedRefreshMode =
              req.body && req.body.refreshMode != null ? String(req.body.refreshMode).trim().toLowerCase() : '';
          const refreshMode = requestedRefreshMode === 'deep' ? 'deep' : 'lite';
          const isLiteRefresh = refreshMode !== 'deep';
          try {
              ticketDataBefore = await buildTicketResponseForClient(db, orgId, row);
              if (ticketDataBefore && ticketDataBefore.source) source = ticketDataBefore.source;
              if (ticketDataBefore && ticketDataBefore.ticketDetailsSource != null) {
                  ticketDetailsSourceBefore = ticketDataBefore.ticketDetailsSource;
              }
          } catch (_) {
              ticketDataBefore = null;
          }
          phaseStartedAt = markTiming('initialTicketBuildMs', phaseStartedAt);

          const skipPacEnrichment = req.body && req.body.skipPacEnrichment === true;
          const forceRefresh = req.body && req.body.forceRefresh === true;

          if (!forceRefresh && ticketDataBefore && isTicketFullDetailWithinCoopLock(ticketDataBefore)) {
              console.log('[ticketRefresh] refresh skipped (per-ticket cooperative lock)', {
                  ticketNumber,
                  lockMs: getTicketDetailCoopLockMs(),
              });
              const skipped = await buildCachedTicketRefreshSkippedResponse(
                  db,
                  orgId,
                  row,
                  refreshMode,
                  refreshStartedAt,
                  phaseStartedAt,
                  timings,
                  c,
                  { refreshSkipReason: 'cooperative_lock', userId, reqUser: req.user }
              );
              return res.json(skipped);
          }

          // Always take in-flight lease (including forceRefresh). Force only bypasses time-based coop lock.
          const beginRefresh = await tryBeginTicketDetailRefreshForOrg(db, orgId, storageKey);
          if (!beginRefresh.ok) {
              console.log('[ticketRefresh] refresh skipped (ticket refresh in progress)', {
                  ticketNumber,
                  reason: beginRefresh.reason,
                  forceRefresh,
              });
              const skipped = await buildCachedTicketRefreshSkippedResponse(
                  db,
                  orgId,
                  row,
                  refreshMode,
                  refreshStartedAt,
                  phaseStartedAt,
                  timings,
                  c,
                  { refreshSkipReason: beginRefresh.reason || 'ticket_refresh_in_progress', userId, reqUser: req.user }
              );
              return res.json(skipped);
          }
          ticketRefreshLeaseHeld = true;

          console.log('[ticketRefresh] POST /tickets/refresh', {
              orgId,
              ticketNumber,
              storageKey,
              source,
              ticketDetailsSourceBefore,
              skipPacEnrichment,
              forceRefresh,
              refreshMode,
          });

          if (skipPacEnrichment) {
              console.log('[ticketRefresh] skipPacEnrichment: selection refresh (lite path; cooperative lock may skip nGen work)');
          }
          console.log('[ticketRefresh] step 1: runNgenEnquiryRefreshIfConfigured (timeout via OPERATION_TIMEOUT_MS)', {
              ticketSource: source,
              refreshMode,
          });
          let revisionFollowSkipped = false;
          let revisionFollowSkipReason = null;
          let skipRevisionFollow = false;
          if (isLiteRefresh) {
              const tierB = await canSkipRevisionFollowForLiteRefresh(db, orgId, ticketDataBefore, storageKey, {
                  isLiteRefresh,
                  forceRefresh,
                  isDeep: false,
              });
              skipRevisionFollow = tierB.skip;
              revisionFollowSkipped = tierB.skip;
              revisionFollowSkipReason = tierB.reason;
              if (tierB.skip) {
                  console.log('[ticketRefresh] tier B: skipping revision hunt (org list fresh)', {
                      orgId,
                      ticketNumber,
                      reason: tierB.reason,
                  });
              }
          }
          const refreshCompletedAt = new Date().toISOString();
          const refreshArtifacts = {
              revisionFollowRan: false,
              revisionFollowSkipped,
              revisionFollowSkipReason,
              collectedSearchItems: [],
          };
          const ngenResult: any = await runNgenEnquiryRefreshIfConfiguredWithTimeout(db, orgId, userId, storageKey, {
              includeSearchFallback: !isLiteRefresh,
              includeHistory: false,
              includeRevisionFollow: isLiteRefresh ? !skipRevisionFollow : true,
              leanPrev: isLiteRefresh,
              timings,
              refreshArtifacts,
              stampFullDetailRefreshedAt: refreshCompletedAt,
              deferPersist: isLiteRefresh,
          });
          const ngenMergedOk = !!(ngenResult && ngenResult.ok);
          if (ngenMergedOk) {
              console.log('[ticketRefresh] nGen EnquirySearch merged successfully', {
                  deferPersist: isLiteRefresh,
              });
          } else {
              console.log('[ticketRefresh] nGen EnquirySearch did not merge (no credentials, timeout, or upstream error); nv_api tickets may still refresh from public POSR when ENABLE_POSR_STACK=1');
          }

          // Lite + nGen success: return in-memory Core ticket before D1 persist.
          if (isLiteRefresh && ngenMergedOk && ngenResult.merged && ngenResult.row) {
              // Schedule persist before workflow attach so a throw cannot drop the merge.
              const persistTask = runBackgroundPersistAfterLiteRefresh({
                  db,
                  orgId,
                  userId,
                  storageKey,
                  merged: ngenResult.merged,
                  row: ngenResult.row,
                  prev: ngenResult.prev,
                  jobNum: ngenResult.jobNum,
                  enquiry: ngenResult.enquiry,
                  ticketBase: ngenResult.ticketBase,
                  stampFullDetailRefreshedAt: refreshCompletedAt,
                  releaseLease: true,
                  revisionFollowRan: refreshArtifacts.revisionFollowRan,
              });
              if (workerHasWaitUntil(c)) {
                  scheduleWorkerBackgroundTask(c, persistTask);
                  ticketRefreshLeaseHeld = false; // released in background finally
              } else {
                  await persistTask;
                  ticketRefreshLeaseHeld = false;
              }

              const result = finalizeMergedTicketForClient(ngenResult.merged, ngenResult.row, refreshCompletedAt);
              try {
                  await attachComputedWorkflowStatusForOrgTicket(db, orgId, result);
              } catch (wfErr) {
                  console.warn(
                      '[ticketRefresh] attachComputedWorkflowStatus after early merge (persist already scheduled):',
                      wfErr && wfErr.message ? wfErr.message : wfErr
                  );
              }
              timings.totalMs = Date.now() - refreshStartedAt;
              timings.persistDeferred = true;
              console.log('[ticketRefresh] timings', {
                  orgId,
                  ticketNumber,
                  refreshMode,
                  earlyReturn: true,
                  revisionFollowSkipped: refreshArtifacts.revisionFollowSkipped,
                  revisionFollowSkipReason: refreshArtifacts.revisionFollowSkipReason,
                  revisionFollowRan: refreshArtifacts.revisionFollowRan,
                  revisionHuntRowCount: refreshArtifacts.collectedSearchItems.length,
                  ...timings,
              });

              scheduleWorkerBackgroundTask(c, runBackgroundOrgSyncAfterTicketRefresh({
                  db,
                  orgId,
                  userId,
                  storageKey,
                  reqUser: req.user,
                  revisionFollowRan: refreshArtifacts.revisionFollowRan,
                  collectedSearchItems: refreshArtifacts.collectedSearchItems,
              }));
              return res.json({
                  ticket: result,
                  refreshMode,
                  timings,
                  persistDeferred: true,
                  revisionFollowSkipped: refreshArtifacts.revisionFollowSkipped,
                  revisionFollowSkipReason: refreshArtifacts.revisionFollowSkipReason,
              });
          }

          if (refreshArtifacts.revisionFollowRan) {
              try {
                  await markOrgUsanListFreshFromRevisionHunt(db, orgId);
                  console.log('[ticketRefresh] org list freshness stamped after revision hunt (tier B for next open)', {
                      orgId,
                      storageKey,
                  });
              } catch (stampErr) {
                  console.warn(
                      '[ticketRefresh] markOrgUsanListFreshFromRevisionHunt:',
                      stampErr && stampErr.message ? stampErr.message : stampErr
                  );
              }
          }

          phaseStartedAt = Date.now();
          const rowAfter = await findFullTicketRowForOrg(db, orgId, storageKey);
          phaseStartedAt = markTiming('postNgenRowReadMs', phaseStartedAt);
          if (!rowAfter) {
              return res.status(500).json({ error: 'Failed to read ticket after refresh' });
          }
          let tdAfter = null;
          try {
              tdAfter = await buildTicketResponseForClient(db, orgId, rowAfter);
          } catch (_) {
              /* ignore */
          }
          phaseStartedAt = markTiming('postNgenTicketBuildMs', phaseStartedAt);

          const syncLaneAfterNgen = ticketSyncLane.syncLaneFromTicketRow(rowAfter);
          const rowHasNgenJob =
              rowAfter &&
              ((rowAfter.ngen_job_number != null && String(rowAfter.ngen_job_number).trim() !== '') ||
                  (rowAfter.job_number != null && String(rowAfter.job_number).trim() !== ''));
          const ticketHasNgenJob =
              tdAfter &&
              typeof tdAfter === "object" &&
              (((tdAfter as { ngenJobNumber?: unknown }).ngenJobNumber != null &&
                  String((tdAfter as { ngenJobNumber?: unknown }).ngenJobNumber).trim() !== '') ||
                  ((tdAfter as { jobNumber?: unknown }).jobNumber != null &&
                      String((tdAfter as { jobNumber?: unknown }).jobNumber).trim() !== ''));
          const sourceLooksPosr =
              tdAfter &&
              typeof tdAfter === "object" &&
              pollHelpers.isNvPublicImportTicketSource((tdAfter as { source?: string }).source);
          const sourceMissing =
              !tdAfter ||
              typeof tdAfter !== "object" ||
              (tdAfter as { source?: unknown }).source == null ||
              String((tdAfter as { source?: unknown }).source).trim() === "";
          const sourcelessNoNgenJobPosrCandidate =
              sourceMissing && !rowHasNgenJob && !ticketHasNgenJob;
          const shouldMergePosrSnapshot =
              isPosrStackEnabled() &&
              (syncLaneAfterNgen === ticketSyncLane.SYNC_LANE_POSR_PUBLIC ||
                  sourceLooksPosr ||
                  sourcelessNoNgenJobPosrCandidate);

          let posrMerged = false;
          const tdBeforePosr =
              tdAfter && typeof tdAfter === "object" ? { ...(tdAfter as Record<string, unknown>) } : null;

          // POSR on critical path when nGen did not merge (need responses for paint).
          // When nGen already succeeded we early-returned above for lite; deep may still POSR after await-persist.
          if (tdAfter && typeof tdAfter === "object" && shouldMergePosrSnapshot) {
              const reqNum = pollHelpers.resolvePosrFetchRequestNumberFromTicketData(tdAfter as Record<string, unknown>);
              if (reqNum) {
                  const posrBuilt = await pollHelpers.fetchNvPosrBuiltTicketForRequestNumber(reqNum);
                  if (posrBuilt.ok && posrBuilt.ticket) {
                      const merged = pollHelpers.mergeNvPosrRefreshSnapshotIntoTicketData(
                          tdAfter as Record<string, unknown>,
                          posrBuilt.ticket as Record<string, unknown>
                      );
                      if (merged) {
                          tdAfter = merged as typeof tdAfter;
                          posrMerged = true;
                      }
                      console.log("[ticketRefresh] merged fresh NV POSR snapshot for nv public import", {
                          storageKey,
                          reqNum,
                          syncLane: syncLaneAfterNgen,
                          source: tdAfter && typeof tdAfter === "object" ? (tdAfter as { source?: string }).source : undefined,
                          sourcelessNoNgenJobCandidate: sourcelessNoNgenJobPosrCandidate,
                      });
                  } else {
                      console.log("[ticketRefresh] NV POSR refresh skipped (fetch or build failed)", {
                          storageKey,
                          reqNum,
                          error: posrBuilt.error,
                          syncLane: syncLaneAfterNgen,
                          source: tdAfter && typeof tdAfter === "object" ? (tdAfter as { source?: string }).source : undefined,
                          sourcelessNoNgenJobCandidate: sourcelessNoNgenJobPosrCandidate,
                      });
                  }
              }
          } else if (tdAfter && typeof tdAfter === "object" && !shouldMergePosrSnapshot && !isPosrStackEnabled()) {
              const wouldBePosr =
                  syncLaneAfterNgen === ticketSyncLane.SYNC_LANE_POSR_PUBLIC ||
                  pollHelpers.isNvPublicImportTicketSource((tdAfter as { source?: string }).source);
              if (wouldBePosr) {
                  console.log(
                      "[ticketRefresh] POSR lane / nv_api ticket: ENABLE_POSR_STACK is not 1; operator responses are not refreshed from public POSR"
                  );
              }
          }

          console.log('[ticketRefresh] POST /tickets/refresh done', {
              storageKey,
              ticketDetailsSourceAfter: tdAfter && tdAfter.ticketDetailsSource,
              sourceAfter: tdAfter && tdAfter.source,
          });

          // Cooperative lock timestamp: only when we actually refreshed from nGen or POSR.
          if (tdAfter && typeof tdAfter === "object" && (ngenMergedOk || posrMerged)) {
              tdAfter.ngenFullDetailRefreshedAt = refreshCompletedAt;
          }

          let rowOut = rowAfter;
          let didPersistAfterRefresh = false;
          // Deep path: nGen already persisted when !deferPersist. Lite nGen-miss falls through here.
          const skipStampPersist = ngenMergedOk && !posrMerged && !isLiteRefresh;

          if (tdAfter && tdAfter.ngenSearchStub) {
              const hasOps = Array.isArray(tdAfter.operatorResponses) && tdAfter.operatorResponses.length > 0;
              if (hasOps) {
                  delete tdAfter.ngenSearchStub;
                  // Keep stubMapPin for lean list / map markers.
                  try {
                      const stampStartedAt = Date.now();
                      const strippedClear = ticketBuilder.stripDerivedTicketUiFields(tdAfter);
                      const prevStub = tdBeforePosr || ticketDataBefore;
                      await persistTicketRowAfterDataChange(db, {
                          ticketId: rowAfter.id,
                          orgId,
                          ticketNumber: storageKey,
                          stripped: strippedClear,
                          prev: prevStub,
                          next: tdAfter,
                          stampFullDetailRefreshedAt: refreshCompletedAt,
                          userId,
                      });
                      markTiming('stampPersistMs', stampStartedAt);
                      rowOut = rowAfter;
                      didPersistAfterRefresh = true;
                  } catch (persistErr) {
                      console.warn('[ticketRefresh] clear ngenSearchStub:', persistErr.message || persistErr);
                  }
              }
          }
          if (tdAfter && typeof tdAfter === "object" && !didPersistAfterRefresh && !skipStampPersist) {
              try {
                  if (
                      pollHelpers.isNvPublicImportTicketSource((tdAfter as { source?: string }).source) &&
                      ((tdAfter as { syncLane?: string }).syncLane == null ||
                          String((tdAfter as { syncLane?: string }).syncLane).trim() === "")
                  ) {
                      (tdAfter as { syncLane?: string }).syncLane = ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
                  }
                  await pollHelpers.maybeEnsurePosrResponseCountsPersisted(db, orgId, rowOut, tdAfter, {
                      userId,
                  });
                  const stampStartedAt = Date.now();
                  const strippedStamp = ticketBuilder.stripDerivedTicketUiFields(tdAfter);
                  const prevForStamp = posrMerged && tdBeforePosr ? tdBeforePosr : tdBeforePosr || ticketDataBefore;
                  await persistTicketRowAfterDataChange(db, {
                      ticketId: rowOut.id,
                      orgId,
                      ticketNumber: storageKey,
                      stripped: strippedStamp,
                      prev: prevForStamp,
                      next: tdAfter,
                      stampFullDetailRefreshedAt: refreshCompletedAt,
                      userId,
                  });
                  markTiming('stampPersistMs', stampStartedAt);
                  rowOut = rowAfter;
              } catch (persistErr) {
                  console.warn('[ticketRefresh] persist ticket refresh timestamp:', persistErr.message || persistErr);
              }
          } else if (skipStampPersist) {
              timings.stampPersistMs = 0;
          }
          if (!isLiteRefresh) {
              try {
                  const fanoutStartedAt = Date.now();
                  const finalTicketData = rowOut ? await buildTicketResponseForClient(db, orgId, rowOut) : null;
                  const fanout = await fanoutRefreshedTicketToSiblingRows(db, rowOut, finalTicketData);
                  markTiming('siblingFanoutMs', fanoutStartedAt);
                  if (fanout.updated > 0 || fanout.errors > 0 || (fanout.skippedLaneMismatch || 0) > 0) {
                      console.log('[ticketRefresh] sibling fanout complete', {
                          storageKey,
                          updated: fanout.updated,
                          errors: fanout.errors,
                          skippedLaneMismatch: fanout.skippedLaneMismatch || 0,
                      });
                  }
              } catch (fanoutErr) {
                  console.warn('[ticketRefresh] sibling fanout skipped:', fanoutErr.message || fanoutErr);
              }
          }
          const skipFinalBuild =
              isLiteRefresh && posrMerged && !didPersistAfterRefresh && tdAfter && typeof tdAfter === "object";
          let result = null;
          if (skipFinalBuild) {
              result = tdAfter;
              timings.finalBuildMs = 0;
          } else if (isLiteRefresh && tdAfter && typeof tdAfter === "object" && (posrMerged || didPersistAfterRefresh)) {
              result = finalizeMergedTicketForClient(tdAfter, rowOut, refreshCompletedAt);
              timings.finalBuildMs = 0;
          } else {
              const finalBuildStartedAt = Date.now();
              result = await buildTicketResponseForClient(db, orgId, rowOut);
              markTiming('finalBuildMs', finalBuildStartedAt);
          }
          if (result && typeof result === 'object') {
              await attachComputedWorkflowStatusForOrgTicket(db, orgId, result);
          }
          if (!isLiteRefresh) {
              // ticket_photo_stats removed — workflow ack uses inline count at acknowledge time only
          }
          timings.totalMs = Date.now() - refreshStartedAt;
          console.log('[ticketRefresh] timings', {
              orgId,
              ticketNumber,
              refreshMode,
              revisionFollowSkipped: refreshArtifacts.revisionFollowSkipped,
              revisionFollowSkipReason: refreshArtifacts.revisionFollowSkipReason,
              revisionFollowRan: refreshArtifacts.revisionFollowRan,
              revisionHuntRowCount: refreshArtifacts.collectedSearchItems.length,
              ...timings,
          });
          scheduleWorkerBackgroundTask(c, runBackgroundOrgSyncAfterTicketRefresh({
              db,
              orgId,
              userId,
              storageKey,
              reqUser: req.user,
              revisionFollowRan: refreshArtifacts.revisionFollowRan,
              collectedSearchItems: refreshArtifacts.collectedSearchItems,
          }));
          return res.json({
              ticket: result,
              refreshMode,
              timings,
              revisionFollowSkipped: refreshArtifacts.revisionFollowSkipped,
              revisionFollowSkipReason: refreshArtifacts.revisionFollowSkipReason,
          });
      } catch (e) {
          console.error('Error refreshing ticket:', e);
          const code = e.statusCode === 502 ? 502 : 500;
          return res.status(code).json({ error: e.message || String(e) });
      } finally {
          if (ticketRefreshLeaseHeld) {
              await releaseTicketDetailRefreshForOrg(db, orgId, storageKey);
          }
      }
  });
}

