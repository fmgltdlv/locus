import { getDatabase } from '../../database.js';
import { canAccessOrganization, canUseDevTicketHub, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import { getRow, allRows } from '../../lib/db.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildAndQuotedTokenFtsQuery } from '../../lib/ftsSafeQuery.cjs';
import { getOperatorDirRows } from '../../lib/operatorDirectoryKv.js';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { TICKET_ROW_SELECT_T, buildTicketResponseForClient, parseHubExpiredListDateRange, ticketHubDateRangeSqlPredicate, ticketVisibleToTech, ticketExpiredListSqlPredicate, ticketCancelledListSqlPredicate, ticketActiveListSqlPredicate } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
export function registerTicketsHubQueryRoutes(tickets: TicketsApp) {
  tickets.get('/search', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const userId = req.user.id;
      const qRaw = req.query.q != null ? String(req.query.q) : '';
      const ftsQuery = buildAndQuotedTokenFtsQuery(qRaw);
      if (!ftsQuery) {
          return res.status(400).json({ error: 'Query parameter q is required (non-empty work-description search)' });
      }
      let orgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      const useDevTicketHub = await canUseDevTicketHub(req.user, orgId);
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 50;
      if (limit > 100) limit = 100;

      let isTech = false;
      if (!useDevTicketHub && req.user.role !== 'dev') {
          const role = await getMembershipRole(db, userId, orgId);
          isTech = isTechMembership(role);
      }

      try {
          const rows = await allRows(
              db,
              useDevTicketHub
                  ? `SELECT ${TICKET_ROW_SELECT_T}
                     FROM tickets t
                     INNER JOIN tickets_fts fts ON fts.rowid = t.id
                     WHERE fts MATCH ?
                     ORDER BY t.updated_at DESC
                     LIMIT ?`
                  : `SELECT ${TICKET_ROW_SELECT_T}
                     FROM tickets t
                     INNER JOIN tickets_fts fts ON fts.rowid = t.id
                     WHERE fts MATCH ? AND t.organization_id = ?
                     ORDER BY t.updated_at DESC
                     LIMIT ?`,
              useDevTicketHub ? [ftsQuery, limit] : [ftsQuery, orgId, limit]
          );
          let tickets = (
              await Promise.all(
                  (rows || []).map(async (row) => {
                  try {
                      const ownerOrgId = row.organization_id != null ? Number(row.organization_id) : orgId;
                    const t = (await buildTicketResponseForClient(db, ownerOrgId, row)) as Record<string, unknown>;
                    if (useDevTicketHub) t.devHubAggregated = true;
                      return t;
                  } catch (e) {
                      console.error('GET /search parse row:', row.id, e);
                      return null;
                  }
                  })
              )
          )
              .filter((t) => t !== null);
          if (isTech) {
              tickets = tickets.filter((t) => ticketVisibleToTech(t, userId));
          }
          res.json({ tickets, q: qRaw.trim() });
      } catch (e) {
          console.error('GET /tickets/search:', e);
          const msg = e && e.message ? String(e.message) : '';
          if (/fts|match|syntax|tokenize|malformed/i.test(msg)) {
              return res.status(400).json({ error: 'Invalid search text' });
          }
          res.status(500).json({ error: 'Search failed' });
      }
  });

  /**
   * Global operator phone directory (from nGen notifications). Query: ?codes=CODE1,CODE2
   */
  tickets.get('/station-operator-phones', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const raw = req.query.codes != null ? String(req.query.codes) : '';
      const codes = raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 80);
      if (codes.length === 0) {
          return res.json({ entries: [] });
      }
      try {
          const rows = await getOperatorDirRows(db, codes);
          res.json({ entries: rows || [] });
      } catch (e) {
          if (/no such table/i.test((e as Error).message || "")) {
              return res.json({ entries: [] });
          }
          console.error("GET /tickets/station-operator-phones:", e);
          res.status(500).json({ error: "Failed to load operator phones" });
      }
  });

  /** @returns nGen/PAC usernames (lowercased) for the org to interpret `lodgedByUserName` in the ticket hub. */
  tickets.get('/lodged-by-context', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const orgId = req.query.organizationId != null ? parseInt(String(req.query.organizationId), 10) : null;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      try {
          const rows = await allRows(
              db,
              `SELECT LOWER(TRIM(pacweb_username)) AS u
               FROM organization_pacweb_accounts
               WHERE organization_id = ? AND pacweb_username IS NOT NULL AND TRIM(pacweb_username) != ''`,
              [orgId]
          );
          const orgUsernames = (rows || []).map((r) => (r && r.u != null ? String(r.u) : null)).filter(Boolean);
          return res.json({ orgUsernames });
      } catch (e) {
          console.error('GET /tickets/lodged-by-context:', e);
          return res.status(500).json({ error: 'Failed to load context' });
      }
  });

  /** Cheap COUNT of expired tickets for an org (no row payload). */
  tickets.get('/expired-count', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const queryOrgId = req.query.organizationId != null ? parseInt(String(req.query.organizationId), 10) : null;
      let orgId = queryOrgId != null ? queryOrgId : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      let isTech = false;
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          isTech = isTechMembership(role);
      }

      const expSql = ticketExpiredListSqlPredicate('ticket_expires_at');
      const rangeParsed = parseHubExpiredListDateRange(req.query.from, req.query.to, req.query.dateField);
      const useRangeFilter =
          req.query.from != null ||
          req.query.to != null ||
          (req.query.dateField != null && String(req.query.dateField).trim() !== '');
      let rangeSql = '';
      let rangeArgs = [];
      if (useRangeFilter) {
          if (!rangeParsed.ok) {
              return res.status(400).json({ error: rangeParsed.error });
          }
          rangeSql = ` AND (${ticketHubDateRangeSqlPredicate(rangeParsed.dateField)}) `;
          rangeArgs = [rangeParsed.from, rangeParsed.to];
      }

      /** @param {number} oid */
      const countExpiredForOrg = async (oid) => {
          const row = await getRow(
              db,
              `SELECT COUNT(*) AS n FROM tickets WHERE organization_id = ? AND (${expSql})${rangeSql}`,
              [oid, ...rangeArgs]
          );
          return row && row.n != null ? Number(row.n) : 0;
      };

      try {
          const ownExpired = await countExpiredForOrg(orgId);

          return res.json({
              organizationId: orgId,
              expiredCount: ownExpired,
              expiredCountOwnOrganization: ownExpired,
              ...(rangeParsed.ok
                  ? {
                        dateField: rangeParsed.dateField,
                        from: rangeParsed.from,
                        to: rangeParsed.to,
                        ranged: true,
                    }
                  : {}),
          });
      } catch (e) {
          console.error('GET /tickets/expired-count:', e);
          return res.status(500).json({ error: 'Failed to count expired tickets' });
      }
  });

  /** Cheap COUNT of cancelled tickets for an org (no row payload). */
  tickets.get('/cancelled-count', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const queryOrgId = req.query.organizationId != null ? parseInt(String(req.query.organizationId), 10) : null;
      let orgId = queryOrgId != null ? queryOrgId : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }

      const cancelledSql = ticketCancelledListSqlPredicate();
      const activeExpirySql = ticketActiveListSqlPredicate('ticket_expires_at');

      try {
          const row = await getRow(
              db,
              `SELECT COUNT(*) AS n FROM tickets WHERE organization_id = ? AND (${cancelledSql}) AND (${activeExpirySql})`,
              [orgId]
          );
          const cancelledCount = row && row.n != null ? Number(row.n) : 0;

          return res.json({
              organizationId: orgId,
              cancelledCount,
              cancelledCountOwnOrganization: cancelledCount,
          });
      } catch (e) {
          console.error('GET /tickets/cancelled-count:', e);
          return res.status(500).json({ error: 'Failed to count cancelled tickets' });
      }
  });
}
