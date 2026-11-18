import { getDatabase } from '../../database.js';
import { canAccessOrganization, canMutateOrganization, canUseDevTicketHub, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import * as ticketSyncLane from "../../lib/ticketSyncLane.cjs";
import { INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams } from '../../lib/ticketIndexedColumns.cjs';
import { persistTicketRowAfterDataChange } from '../../lib/ticketPersist.cjs';
import { allRows } from '../../lib/db.cjs';
import { isPublicCatalogOrgId } from '../../lib/publicShareQuery.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import {
    buildWorkflowAckMapFromDbRows,
    computeWorkflowStatusForTicket,
} from '../computeWorkflowStatus.js';
import {
    TICKET_ROW_SELECT, TICKET_ROW_SELECT_LEAN, assertNotTechWrite, buildTicketResponseForClient, buildTicketExpiredListItemForClient, buildTicketListSummaryFromRow, currentFullRequestNumberFromRow, decodeExpiredListCursor, decodeTicketListCursor, encodeExpiredListCursor, encodeTicketListCursor, parseHubExpiredListDateRange, ticketHubDateRangeSqlPredicate, ticketHubFilterDateSqlExpr, findFullTicketRowForOrg, getWrittenTicketId, loadAssigneesMapForTicketIds, loadEarliestPosr000IsoMap, ticketVisibleToTech, ticketActiveListSqlPredicate, ticketExpiredListSqlPredicate, attachAssigneeSummaryFromList, attachWorkflowAckToSummaryTicket, stripSlimSummaryTicketForClient, loadWorkflowAckContextForOrg, workflowStatusOptionsFromContext } from '../ticketRowHelpers.js';
import {
    getLeanActiveTicketList,
    isLeanActiveListFresh,
    pageTicketsByCreatedAtIdCursor,
    setLeanActiveTicketList,
    invalidateOrgActiveTicketListCache,
} from '../../lib/ticketListCache.js';
import type { TicketsApp } from './types.js';

function scheduleWaitUntil(c: unknown, task: Promise<unknown>) {
    const ctx = (c as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(task);
    } else {
        void task;
    }
}
export function registerTicketsListRoutes(tickets: TicketsApp) {
  tickets.get('/hub-job-fields', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawOrg = req.query.organizationId;
      let orgId = rawOrg != null && rawOrg !== '' ? parseInt(String(rawOrg), 10) : req.user.organizationId;
      if (!Number.isFinite(orgId)) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      try {
          const rows = await allRows(
              db,
              `SELECT ticket_number, user_reference
               FROM tickets
               WHERE organization_id = ?
                 AND user_reference IS NOT NULL
                 AND TRIM(user_reference) != ''`,
              [orgId]
          );
          return res.json({
              jobs: (rows || []).map((row) => ({
                  ticketNumber: row.ticket_number,
                  ngenUserReference: row.user_reference,
              })),
          });
      } catch (e) {
          console.error('GET /tickets/hub-job-fields:', e);
          return res.status(500).json({ error: 'Failed to fetch hub job fields' });
      }
  });

  tickets.post('/', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const { ticketNumber, ticketData, organizationId: bodyOrgId } = req.body;
      const userId = req.user.id;

      async function saveTicket(orgId) {
          if (!orgId) {
              return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
          }
          if (!(await assertNotTechWrite(req, res, orgId))) return;
          if (!ticketNumber || !ticketData) {
              return res.status(400).json({ error: 'Ticket number and ticket data are required' });
          }
          const toStore = ticketBuilder.stripDerivedTicketUiFields(ticketData);
          if (toStore.syncLane == null || String(toStore.syncLane).trim() === "") {
              if (toStore.source === "nv_api" || toStore.source === "nv_api_cache") {
                  toStore.syncLane = ticketSyncLane.SYNC_LANE_POSR_PUBLIC;
              }
          }
          let prev = null;
          try {
              const existingRow = await findFullTicketRowForOrg(db, orgId, ticketNumber);
              if (existingRow && existingRow.ticket_data) {
                  try {
                      prev = JSON.parse(existingRow.ticket_data);
                  } catch (_) {
                      prev = null;
                  }
              }
          } catch (_) {
              prev = null;
          }
          db.run(INSERT_OR_REPLACE_SQL, buildInsertOrReplaceParams(orgId, userId, ticketNumber, toStore), async function(err) {
              if (err) {
                  console.error('Error saving ticket:', err);
                  return res.status(500).json({ error: 'Failed to save ticket' });
              }
              const rowId = await getWrittenTicketId(db, orgId, ticketNumber);
              await persistTicketRowAfterDataChange(db, {
                  ticketId: rowId,
                  orgId,
                  ticketNumber,
                  stripped: toStore,
                  prev,
                  next: toStore,
                  skipRowUpdate: true,
                  userId,
              });
              void invalidateOrgActiveTicketListCache(db, orgId);
              res.json({ id: rowId, message: 'Ticket saved successfully' });
          });
      }

      const resolvedOrgId = bodyOrgId != null ? parseInt(bodyOrgId, 10) : req.user.organizationId;
      if (!resolvedOrgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, resolvedOrgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      await saveTicket(resolvedOrgId);
  });

  // Get tickets for organization (optional query: ?organizationId= for current org)
  tickets.get('/', (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const queryOrgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : null;
      const userId = req.user.id;

      async function rowToClientTicket(row, orgId, extra?: Record<string, unknown>) {
          const ticket = await buildTicketResponseForClient(db, orgId, row);
          return extra ? { ...ticket, ...extra } : ticket;
      }

      async function returnAllOrgTickets() {
          try {
              const rows = await allRows(
                  db,
                  `SELECT ${TICKET_ROW_SELECT}
                   FROM tickets
                   ORDER BY created_at DESC`,
                  []
              );
              console.log(`📋 Found ${rows.length} ticket rows across all organizations for dev ticket hub ${queryOrgId}`);
              const list = (
                  await Promise.all(
                      (rows || []).map(async (row) => {
                          try {
                              const ownerOrgId = row.organization_id != null ? Number(row.organization_id) : null;
                              return await rowToClientTicket(row, ownerOrgId, { devHubAggregated: true });
                          } catch (e) {
                              console.error('Error parsing dev hub ticket row:', row.id, e);
                              return null;
                          }
                      })
                  )
              ).filter((t) => t !== null);
              res.json(list);
          } catch (e) {
              console.error('Error fetching dev hub tickets:', e);
              res.status(500).json({ error: 'Failed to fetch tickets' });
          }
      }

      async function returnTickets(orgId, isTech) {
          if (!orgId) {
              return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
          }
          if (await isPublicCatalogOrgId(db, orgId)) {
              const useSummaryEarly =
                  req.query.summary === '1' ||
                  String(req.query.summary || '').toLowerCase() === 'true' ||
                  req.query.listMode === 'summary';
              if (useSummaryEarly) {
                  return res.json({
                      listMode: 'summary',
                      listScope: 'public',
                      tickets: [],
                      hasMore: false,
                      nextCursor: null,
                      limit: parseInt(String(req.query.limit ?? '200'), 10) || 200,
                  });
              }
              return res.json([]);
          }
          const useSummary =
              req.query.summary === '1' ||
              String(req.query.summary || '').toLowerCase() === 'true' ||
              req.query.listMode === 'summary';

          let pageLimit = parseInt(String(req.query.limit ?? ''), 10);
          if (!Number.isFinite(pageLimit) || pageLimit < 1) pageLimit = useSummary ? 200 : 0;
          if (pageLimit > 500) pageLimit = 500;

          const activeOnly =
              req.query.activeOnly === '1' || String(req.query.activeOnly || '').toLowerCase() === 'true';
          const expiredOnly =
              req.query.expiredOnly === '1' || String(req.query.expiredOnly || '').toLowerCase() === 'true';
          if (activeOnly && expiredOnly) {
              return res.status(400).json({ error: 'activeOnly and expiredOnly cannot be used together' });
          }
          const activeTicketSql = activeOnly ? ` AND ${ticketActiveListSqlPredicate('ticket_expires_at')} ` : '';

          try {
              if (expiredOnly) {
                  const rangeParsed = parseHubExpiredListDateRange(
                      req.query.from,
                      req.query.to,
                      req.query.dateField
                  );
                  if (!rangeParsed.ok) {
                      return res.status(400).json({ error: rangeParsed.error });
                  }
                  const { from, to, dateField } = rangeParsed;
                  const lim = pageLimit || 200;
                  const filterExpr = ticketHubFilterDateSqlExpr(dateField);
                  const filterJd = `julianday(TRIM(${filterExpr}))`;
                  const expiredSql = ticketExpiredListSqlPredicate('ticket_expires_at');
                  const rangeSql = ticketHubDateRangeSqlPredicate(dateField);

                  const workflowContextByOrgId = new Map();
                  const getWorkflowContextForOrg = async (ownerOrgId) => {
                      const id = ownerOrgId != null ? Number(ownerOrgId) : NaN;
                      if (!Number.isFinite(id)) {
                          return { ackMap: buildWorkflowAckMapFromDbRows([]), renewalAckWaivers: false, expiringSoonDays: 5 };
                      }
                      if (!workflowContextByOrgId.has(id)) {
                          workflowContextByOrgId.set(id, loadWorkflowAckContextForOrg(db, id));
                      }
                      return workflowContextByOrgId.get(id);
                  };
                  const attachComputedWorkflowStatus = async (ticket, ownerOrgId) => {
                      const oid =
                          ticket && ticket.organizationId != null && Number.isFinite(Number(ticket.organizationId))
                              ? Number(ticket.organizationId)
                              : ownerOrgId;
                      const ctx = await getWorkflowContextForOrg(oid);
                      ticket.computedWorkflowStatus = computeWorkflowStatusForTicket(
                          ticket,
                          ctx.ackMap,
                          'owner',
                          workflowStatusOptionsFromContext(ctx)
                      );
                      ticket.expiringSoonDays = ctx.expiringSoonDays;
                      attachWorkflowAckToSummaryTicket(ticket, ctx.ackMap);
                  };
                  const finalizeSlimSummaryTicket = (ticket, assignees, ownerOrgId) => {
                      if (assignees && assignees.length > 0) {
                          attachAssigneeSummaryFromList(ticket, assignees);
                      } else {
                          ticket.assigneeCount = 0;
                          ticket.assigneeUserIds = [];
                          delete ticket.assignedToUsers;
                          delete ticket.assignedToUserId;
                          delete ticket.assignedToUserName;
                      }
                      return stripSlimSummaryTicketForClient(ticket);
                  };
                  const buildExpiredListTicket = async (row, ownerOrgId) => {
                      const t = await buildTicketExpiredListItemForClient(db, ownerOrgId, row);
                      await attachComputedWorkflowStatus(t, ownerOrgId);
                      return t;
                  };
                  const stampExpiredListMembership = (ticket) => {
                      if (!ticket || typeof ticket !== 'object') return ticket;
                      // Membership in expiredOnly already means ticket_expires_at is past. Trust that over
                      // workflow recomputation that can miss expiry fields on lean rows and yield NOT_READY.
                      ticket.listScope = 'expired';
                      ticket.computedWorkflowStatus = 'EXPIRED';
                      ticket.status = 'EXPIRED';
                      ticket.workflowStatus = 'EXPIRED';
                      return ticket;
                  };

                  const fetchExpiredPageForOrg = async (ownerOrgId) => {
                      const cur = decodeExpiredListCursor(req.query.cursor != null ? String(req.query.cursor) : '');
                      const args = [ownerOrgId, from, to];
                      let keySql = '';
                      if (cur && cur.filterDate != null && cur.id != null) {
                          keySql = ` AND (${filterJd} < julianday(?) OR (${filterJd} = julianday(?) AND id < ?)) `;
                          args.push(cur.filterDate, cur.filterDate, cur.id);
                      }
                      args.push(lim + 1);
                      return allRows(
                          db,
                          `SELECT ${TICKET_ROW_SELECT}
                           FROM tickets
                           WHERE organization_id = ?
                             AND (${expiredSql})
                             AND (${rangeSql})
                             ${keySql}
                           ORDER BY ${filterJd} DESC, id DESC
                           LIMIT ?`,
                          args
                      );
                  };

                  const rows = await fetchExpiredPageForOrg(orgId);
                  const hasMore = rows.length > lim;
                  const pageRows = hasMore ? rows.slice(0, lim) : rows;
                  const assigneeMap = await loadAssigneesMapForTicketIds(
                      db,
                      pageRows.map((r) => r.id)
                  );
                  let tickets = (
                      await Promise.all(
                          pageRows.map(async (row) => {
                              try {
                                  const t = await buildExpiredListTicket(row, orgId);
                                  const a = assigneeMap.get(Number(row.id));
                                  return stampExpiredListMembership(finalizeSlimSummaryTicket(t, a, orgId));
                              } catch (e) {
                                  console.error('Error parsing expired summary ticket row:', row.id, e);
                                  return null;
                              }
                          })
                      )
                  ).filter((t) => t !== null);

                  if (isTech) {
                      tickets = tickets.filter((t) => ticketVisibleToTech(t, userId));
                  }

                  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
                  const nextCursor = hasMore && lastRow ? encodeExpiredListCursor(lastRow, dateField) : null;
                  return res.json({
                      listMode: 'summary',
                      listScope: 'expired',
                      dateField,
                      from,
                      to,
                      tickets,
                      hasMore,
                      nextCursor,
                      limit: lim,
                  });
              }

              if (useSummary) {
                  /** Per owning org: workflow acks for summary status (shared tickets use source org). */
                  const workflowContextByOrgId = new Map();
                  const getWorkflowContextForOrg = async (ownerOrgId) => {
                      const id = ownerOrgId != null ? Number(ownerOrgId) : NaN;
                      if (!Number.isFinite(id)) {
                          return { ackMap: buildWorkflowAckMapFromDbRows([]), renewalAckWaivers: false, expiringSoonDays: 5 };
                      }
                      if (!workflowContextByOrgId.has(id)) {
                          workflowContextByOrgId.set(id, loadWorkflowAckContextForOrg(db, id));
                      }
                      return workflowContextByOrgId.get(id);
                  };
                  const attachComputedWorkflowStatus = async (ticket, ownerOrgId) => {
                      const oid =
                          ticket && ticket.organizationId != null && Number.isFinite(Number(ticket.organizationId))
                              ? Number(ticket.organizationId)
                              : ownerOrgId;
                      const ctx = await getWorkflowContextForOrg(oid);
                      ticket.computedWorkflowStatus = computeWorkflowStatusForTicket(
                          ticket,
                          ctx.ackMap,
                          'owner',
                          workflowStatusOptionsFromContext(ctx)
                      );
                      ticket.expiringSoonDays = ctx.expiringSoonDays;
                      attachWorkflowAckToSummaryTicket(ticket, ctx.ackMap);
                  };
                  const finalizeSlimSummaryTicket = (ticket, assignees) => {
                      if (assignees && assignees.length > 0) {
                          attachAssigneeSummaryFromList(ticket, assignees);
                      } else {
                          ticket.assigneeCount = 0;
                          ticket.assigneeUserIds = [];
                          delete ticket.assignedToUsers;
                          delete ticket.assignedToUserId;
                          delete ticket.assignedToUserName;
                      }
                      return stripSlimSummaryTicketForClient(ticket);
                  };
                  /** Lean summary: pins/bbox only — no base-geometry overlay / polygon_json. */
                  const buildLeanSummaryTicket = async (row, ownerOrgId, assigneeMap, posr000IsoMap) => {
                      const tid = row && row.id != null ? Number(row.id) : NaN;
                      const opts: { history?: Array<{ statusCode: string; respondedAt: string }> } = {};
                      if (
                          Number.isFinite(tid) &&
                          row &&
                          String(row.sync_lane || '').trim() === 'posr_public' &&
                          posr000IsoMap &&
                          posr000IsoMap.has(tid)
                      ) {
                          opts.history = [{ statusCode: '000', respondedAt: posr000IsoMap.get(tid) }];
                      }
                      let t = buildTicketListSummaryFromRow(ownerOrgId, row, opts);
                      const a = Number.isFinite(tid) ? assigneeMap.get(tid) : null;
                      await attachComputedWorkflowStatus(t, ownerOrgId);
                      return finalizeSlimSummaryTicket(t, a);
                  };
                  const loadPosr000IsoMapForRows = async (rows) => {
                      const posrIds = (rows || [])
                          .filter((r) => r && String(r.sync_lane || '').trim() === 'posr_public')
                          .map((r) => r.id);
                      return loadEarliestPosr000IsoMap(db, posrIds);
                  };
                  const lim = pageLimit || 200;
                  const cur = decodeTicketListCursor(req.query.cursor != null ? String(req.query.cursor) : '');

                  if (activeOnly) {
                      const ACTIVE_BUILD_PAGE = 500;
                      const ACTIVE_BUILD_MAX_PAGES = 40;
                      const buildAllActiveLeanFromD1 = async () => {
                          const accumulated = [];
                          let buildCursor = null;
                          for (let pageNum = 0; pageNum < ACTIVE_BUILD_MAX_PAGES; pageNum++) {
                              const args = [orgId];
                              let keySql = '';
                              if (buildCursor && buildCursor.createdAt != null && buildCursor.id != null) {
                                  keySql =
                                      ' AND (datetime(created_at) < datetime(?) OR (datetime(created_at) = datetime(?) AND id < ?)) ';
                                  args.push(buildCursor.createdAt, buildCursor.createdAt, buildCursor.id);
                              }
                              args.push(ACTIVE_BUILD_PAGE + 1);
                              const rows = await allRows(
                                  db,
                                  `SELECT ${TICKET_ROW_SELECT_LEAN}
                                   FROM tickets
                                   WHERE organization_id = ?
                                   ${keySql} AND ${ticketActiveListSqlPredicate('ticket_expires_at')}
                                   ORDER BY datetime(created_at) DESC, id DESC
                                   LIMIT ?`,
                                  args
                              );
                              const more = rows.length > ACTIVE_BUILD_PAGE;
                              const pageRows = more ? rows.slice(0, ACTIVE_BUILD_PAGE) : rows;
                              if (pageRows.length === 0) break;
                              const ids = pageRows.map((r) => r.id);
                              const assigneeMap = await loadAssigneesMapForTicketIds(db, ids);
                              const posr000IsoMap = await loadPosr000IsoMapForRows(pageRows);
                              const built = (
                                  await Promise.all(
                                      pageRows.map(async (row) => {
                                          try {
                                              return await buildLeanSummaryTicket(row, orgId, assigneeMap, posr000IsoMap);
                                          } catch (e) {
                                              console.error('Error parsing lean summary ticket row:', row.id, e);
                                              return null;
                                          }
                                      })
                                  )
                              ).filter((t) => t !== null);
                              accumulated.push(...built);
                              if (!more) break;
                              const last = pageRows[pageRows.length - 1];
                              buildCursor = {
                                  createdAt: last.created_at != null ? String(last.created_at) : '',
                                  id: Number(last.id),
                              };
                          }
                          return accumulated;
                      };

                      let allLean = null;
                      let listCache = 'miss';
                      const snap = await getLeanActiveTicketList(db, orgId);
                      if (isLeanActiveListFresh(snap)) {
                          allLean = snap.tickets;
                          listCache = 'hit';
                          const beforeStamp = (allLean || []).map((t) =>
                              t
                                  ? `${t.computedWorkflowStatus}|${t.expiringSoonDays}|${t.hasWorkflowAck}`
                                  : ''
                          );
                          await Promise.all(
                              (allLean || []).map((t) => attachComputedWorkflowStatus(t, orgId))
                          );
                          const stampChanged = (allLean || []).some((t, i) => {
                              const after = t
                                  ? `${t.computedWorkflowStatus}|${t.expiringSoonDays}|${t.hasWorkflowAck}`
                                  : '';
                              return after !== beforeStamp[i];
                          });
                          if (stampChanged) {
                              scheduleWaitUntil(
                                  c,
                                  setLeanActiveTicketList(db, orgId, allLean).catch((e) => {
                                      console.warn(
                                          '[tickets] lean list cache restamp:',
                                          e && e.message ? e.message : e
                                      );
                                  })
                              );
                          }
                      } else {
                          allLean = await buildAllActiveLeanFromD1();
                          scheduleWaitUntil(
                              c,
                              setLeanActiveTicketList(db, orgId, allLean).catch((e) => {
                                  console.warn('[tickets] lean list cache write:', e && e.message ? e.message : e);
                              })
                          );
                      }
                      console.log(
                          `📋 Lean active summary for organization ${orgId}: ${allLean.length} rows (cache=${listCache})`
                      );
                      const paged = pageTicketsByCreatedAtIdCursor(allLean, cur, lim);
                      let tickets = paged.page;
                      if (isTech) {
                          tickets = tickets.filter((t) => ticketVisibleToTech(t, userId));
                      }
                      const nextCursor =
                          paged.nextCursor != null
                              ? encodeTicketListCursor({
                                    created_at: paged.nextCursor.createdAt,
                                    id: paged.nextCursor.id,
                                })
                              : null;
                      return res.json({
                          listMode: 'summary',
                          listScope: 'active',
                          tickets,
                          hasMore: paged.hasMore,
                          nextCursor,
                          limit: lim,
                      });
                  }

                  const args = [orgId];
                  let keySql = '';
                  if (cur && cur.createdAt != null && cur.id != null) {
                      keySql =
                          ' AND (datetime(created_at) < datetime(?) OR (datetime(created_at) = datetime(?) AND id < ?)) ';
                      args.push(cur.createdAt, cur.createdAt, cur.id);
                  }
                  args.push(lim + 1);
                  const rows = await allRows(
                      db,
                      `SELECT ${TICKET_ROW_SELECT_LEAN}
                       FROM tickets
                       WHERE organization_id = ?
                       ${keySql}
                       ORDER BY datetime(created_at) DESC, id DESC
                       LIMIT ?`,
                      args
                  );
                  const hasMore = rows.length > lim;
                  const pageRows = hasMore ? rows.slice(0, lim) : rows;
                  console.log(
                      `📋 Summary ticket page for organization ${orgId}: ${pageRows.length} rows (limit=${lim}, hasMore=${hasMore})`
                  );

                  const assigneeMap = await loadAssigneesMapForTicketIds(
                      db,
                      pageRows.map((r) => r.id)
                  );
                  const posr000IsoMap = await loadPosr000IsoMapForRows(pageRows);
                  let tickets = (
                      await Promise.all(
                          pageRows.map(async (row) => {
                              try {
                                  return await buildLeanSummaryTicket(row, orgId, assigneeMap, posr000IsoMap);
                              } catch (e) {
                                  console.error('Error parsing summary ticket row:', row.id, e);
                                  return null;
                              }
                          })
                      )
                  ).filter((t) => t !== null);

                  if (isTech) {
                      tickets = tickets.filter((t) => ticketVisibleToTech(t, userId));
                  }

                  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
                  const nextCursor = hasMore && lastRow ? encodeTicketListCursor(lastRow) : null;
                  return res.json({
                      listMode: 'summary',
                      listScope: 'all',
                      tickets,
                      hasMore,
                      nextCursor,
                      limit: lim,
                  });
              }

              const rows = await allRows(
                  db,
                  `SELECT ${TICKET_ROW_SELECT}
                   FROM tickets
                   WHERE organization_id = ?
                   ${activeTicketSql}
                   ORDER BY datetime(created_at) DESC, id DESC`,
                  [orgId]
              );
              console.log(`📋 Found ${rows.length} ticket rows in database for organization ${orgId}`);
              let tickets = (
                  await Promise.all(
                      rows.map(async (row) => {
                          try {
                              return await rowToClientTicket(row, orgId);
                          } catch (e) {
                              console.error('Error parsing ticket data for row:', row.id, e);
                              return null;
                          }
                      })
                  )
              ).filter((t) => t !== null);
              if (isTech) {
                  tickets = tickets.filter((t) => ticketVisibleToTech(t, userId));
              }
              if (rows.length > 0 && tickets.length === 0) {
                  console.warn('⚠️ Found rows in database but no valid tickets after parsing');
              }
              return res.json(tickets);
          } catch (e) {
              console.error('GET /tickets returnTickets:', e);
              return res.status(500).json({ error: 'Failed to fetch tickets' });
          }
      }

      const run = async () => {
          let orgId = queryOrgId != null ? queryOrgId : req.user.organizationId;
          if (!orgId) {
              return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
          }
          if (!(await canViewOrganization(req.user, orgId))) {
              return res.status(403).json({ error: 'You do not have access to that organization' });
          }
          if (await canUseDevTicketHub(req.user, orgId)) {
              // Documentation feed workspace: queue is service_requests + map-markers, not all tickets.
              return res.json([]);
          }
          let isTech = false;
          if (req.user.role !== 'dev') {
              const role = await getMembershipRole(db, userId, orgId);
              isTech = isTechMembership(role);
          }
          return await returnTickets(orgId, isTech);
      };
      run().catch((e) => {
          console.error('GET /tickets:', e);
          res.status(500).json({ error: 'Failed to fetch tickets' });
      });
  });
}
