// Ticket detail routes — split from detailRoutes.ts (Phase 2)
import { getDatabase } from '../../database.js';
import { canMutateOrganization, canViewOrganization, ORG_REQUIRED_MESSAGE } from '../../auth.js';
import * as ticketBuilder from "../../lib/ticketBuilder.cjs";
import { syncTicketNgenNotificationHistory, syncTicketNgenNotificationHistoryForAuthorities, syncTicketNgenHistoryAuthorityTips } from '../../lib/ticketStructuredRows.cjs';
import { getNgenCredentialsForPoll } from '../../lib/pacPollNgenCredentials.cjs';
import { createAppError, sendAppError } from '../../lib/appErrors.cjs';
import { getMembershipRole, isTechMembership } from '../../lib/orgMembership.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { assertNotTechWrite, buildTicketResponseForClient, resolveTicketRowForOrg, ticketDataAccessibleToTechUser } from '../ticketRowHelpers.js';
import type { TicketsApp } from './types.js';
import { ensureNgenNotificationHistoryForTicket, resolveNgenJobNumberForTicket } from './refresh.js';
import { withNgenAuthRetry, downloadConfirmationPdf, downloadJobPackPdf } from '../../lib/ngenClient.cjs';
import { zipSync } from 'fflate';
import { resolveRequestNumberForTicket, resolveJobNameFromTicketRow, buildUsanDocumentNamePrefix, contentDispositionAttachment } from './detailShared.js';
export function registerDetailNgenRoutes(tickets: TicketsApp) {
  tickets.post('/:ticketNumber/ngen-notification-history', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      let orgId = req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!rawTn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, rawTn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }

      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return sendAppError(res, db, createAppError('NGEN_HISTORY_CREDENTIALS_MISSING', {
              internalMessage:
                  'No nGen credentials for this organization. Add a master organization_pacweb_accounts password, or in local dev set APP_ENV=development and USAN_SERVICE_* when not using per_organization poll mode.',
              meta: { ticketNumber: rawTn, orgId },
          }), {
              req,
              route: 'tickets.ngenNotificationHistory.credentials',
              organizationId: orgId,
          });
      }

      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          const td = (await buildTicketResponseForClient(db, orgId, row)) as Record<string, unknown>;
          const ticketBase = ticketBuilder.normalizeTicketBase(rawTn) || rawTn.split('-')[0];
          let jobNum = await resolveNgenJobNumberForTicket(db, orgId, rawTn, td);
          // Lite refresh may return the job to the client before D1 persist finishes.
          if (jobNum == null && req.body && req.body.ngenJobNumber != null) {
              const n = Number(String(req.body.ngenJobNumber).trim());
              if (Number.isFinite(n)) jobNum = n;
          }
          if (jobNum == null) {
              // Expected not-ready state (not a client bug) — avoid noisy 400s in the browser.
              return res.status(200).json({
                  ok: false,
                  skipped: true,
                  reason: 'no_job',
                  error: 'No nGen job number; refresh the ticket from PAC/nGen first.',
              });
          }

          const authorityIdsRaw = req.body && Array.isArray(req.body.authorityIds) ? req.body.authorityIds : null;
          const authorityIdsToFetch =
              authorityIdsRaw && authorityIdsRaw.length > 0
                  ? authorityIdsRaw
                        .map((aid: unknown) => (aid != null ? String(aid).trim() : ''))
                        .filter((aid: string) => aid !== '')
                  : null;

          const histResult: any = await ensureNgenNotificationHistoryForTicket(
              td,
              jobNum,
              rawTn,
              ticketBase,
              db,
              orgId,
              row.id,
              authorityIdsToFetch && authorityIdsToFetch.length > 0 ? { authorityIdsToFetch } : {}
          );
          if (!histResult.ok) {
              if (histResult.reason === 'no_authorities' || histResult.reason === 'no_job') {
                  return res.status(200).json({
                      ok: false,
                      skipped: true,
                      reason: histResult.reason,
                      error:
                          histResult.reason === 'no_authorities'
                              ? 'No utility authority ids on this ticket; run nGen refresh so notifications are merged.'
                              : 'No nGen job number; refresh the ticket from PAC/nGen first.',
                  });
              }
              if (histResult.reason === 'no_credentials') {
                  return sendAppError(res, db, createAppError('NGEN_HISTORY_CREDENTIALS_MISSING', {
                      internalMessage: 'ensureNgenNotificationHistoryForTicket returned no_credentials.',
                      meta: { ticketNumber: rawTn, orgId },
                  }), {
                      req,
                      route: 'tickets.ngenNotificationHistory.mergeCredentials',
                      organizationId: orgId,
                  });
              }
              return res.status(500).json({ error: 'Failed to load nGen notification history' });
          }

          td.ngenResponseHistory = histResult.history;
          const tips =
              histResult.history && histResult.history.tipByAuthority
                  ? histResult.history.tipByAuthority
                  : {};
          const fetchedAt =
              histResult.history && histResult.history.fetchedAt
                  ? histResult.history.fetchedAt
                  : new Date().toISOString();
          const requestNumber =
              histResult.history && histResult.history.requestNumber
                  ? histResult.history.requestNumber
                  : null;

          if (histResult.persistMode === 'full') {
              await syncTicketNgenNotificationHistory(db, row.id, td);
              await syncTicketNgenHistoryAuthorityTips(db, row.id, tips, requestNumber, fetchedAt, {
                  replaceAll: true,
              });
          } else if (histResult.persistMode === 'partial') {
              const fetchedIds =
                  (histResult.historyFetch && histResult.historyFetch.fetchedAuthorityIds) || [];
              await syncTicketNgenNotificationHistoryForAuthorities(db, row.id, td, fetchedIds);
              await syncTicketNgenHistoryAuthorityTips(db, row.id, tips, requestNumber, fetchedAt, {
                  authorityIds: fetchedIds,
              });
          }

          res.json({
              ok: true,
              ngenResponseHistory: histResult.history,
              historyFetch: histResult.historyFetch || null,
          });
      } catch (e) {
          console.error('POST /tickets/:ticketNumber/ngen-notification-history:', e);
          res.status(500).json({ error: e.message || 'Failed to load nGen notification history' });
      }
  });

  tickets.get('/:ticketNumber/usan-document-pack', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const rawTn = (req.params.ticketNumber || '').trim();
      let orgId = req.query.organizationId != null ? parseInt(req.query.organizationId, 10) : req.user.organizationId;
      const confirmationOnly =
          req.query.confirmationOnly === '1' ||
          String(req.query.confirmationOnly || '').toLowerCase() === 'true';
      const fullHistoryOnly =
          req.query.fullHistoryOnly === '1' ||
          String(req.query.fullHistoryOnly || '').toLowerCase() === 'true';
      const revisionParam =
          req.query.revision != null && String(req.query.revision).trim() !== ''
              ? String(req.query.revision).trim()
              : null;
      if (confirmationOnly && fullHistoryOnly) {
          return res.status(400).json({ error: 'Specify only one of confirmationOnly or fullHistoryOnly' });
      }
      if (!rawTn) {
          return res.status(400).json({ error: 'ticketNumber is required' });
      }
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!(await canViewOrganization(req.user, orgId))) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (req.user.role !== 'dev') {
          const role = await getMembershipRole(db, req.user.id, orgId);
          if (isTechMembership(role)) {
              const ok = await ticketDataAccessibleToTechUser(db, orgId, req.user.id, rawTn);
              if (!ok) {
                  return res.status(403).json({ error: 'You do not have access to this ticket' });
              }
          }
      }

      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return sendAppError(res, db, createAppError('NGEN_HISTORY_CREDENTIALS_MISSING', {
              internalMessage:
                  'No nGen credentials for this organization. Add a master organization_pacweb_accounts password, or in local dev set APP_ENV=development and USAN_SERVICE_* when not using per_organization poll mode.',
              meta: { ticketNumber: rawTn, orgId },
          }), {
              req,
              route: 'tickets.usanDocumentPack.credentials',
              organizationId: orgId,
          });
      }

      try {
          const row = await resolveTicketRowForOrg(db, orgId, rawTn);
          if (!row) {
              return res.status(404).json({ error: 'Ticket not found' });
          }
          const td = (await buildTicketResponseForClient(db, orgId, row)) as Record<string, unknown>;
          const revisionEnquiries = Array.isArray(td.revisionEnquiries) ? td.revisionEnquiries : [];

          let jobNum: number | null = null;
          let requestNumber: string | null = resolveRequestNumberForTicket(td, rawTn);
          let resolvedRevision: string | null = null;

          if (revisionParam && confirmationOnly) {
              const match = revisionEnquiries.find(
                  (e: any) => e && String(e.revision || '').trim() === revisionParam
              );
              if (match && match.jobNumber != null && String(match.jobNumber).trim() !== '') {
                  const n = Number(String(match.jobNumber).trim());
                  if (Number.isFinite(n)) jobNum = n;
                  if (match.requestNumber) requestNumber = String(match.requestNumber).trim();
                  resolvedRevision = revisionParam;
              } else {
                  const currentRev =
                      td.ticketRevision != null
                          ? String(td.ticketRevision).trim()
                          : requestNumber
                            ? String(ticketBuilder.parseTicketNumberParts(requestNumber).revisionSuffix || '')
                            : '';
                  if (currentRev && currentRev === revisionParam) {
                      jobNum = await resolveNgenJobNumberForTicket(db, orgId, rawTn, td);
                      resolvedRevision = revisionParam;
                  } else {
                      return res.status(404).json({
                          error: `No enquiry id on record for revision ${revisionParam}; open/refresh that revision first.`,
                      });
                  }
              }
          } else {
              jobNum = await resolveNgenJobNumberForTicket(db, orgId, rawTn, td);
              const parts = requestNumber
                  ? ticketBuilder.parseTicketNumberParts(requestNumber)
                  : { revisionSuffix: null };
              resolvedRevision =
                  parts.revisionSuffix != null
                      ? String(parts.revisionSuffix)
                      : td.ticketRevision != null
                        ? String(td.ticketRevision)
                        : null;
          }

          if (jobNum == null && !fullHistoryOnly) {
              return res.status(400).json({ error: 'No nGen job number; refresh the ticket from PAC/nGen first.' });
          }
          if (!requestNumber && (fullHistoryOnly || !confirmationOnly)) {
              return res.status(400).json({
                  error: 'No ticket revision on record; refresh the ticket so the full request number (e.g. BASE-001) is available.',
              });
          }
          if (fullHistoryOnly && !requestNumber) {
              return res.status(400).json({
                  error: 'No ticket revision on record; refresh the ticket so the full request number (e.g. BASE-001) is available.',
              });
          }

          const ticketBase =
              ticketBuilder.normalizeTicketBase(requestNumber || rawTn) ||
              String(requestNumber || rawTn).split('-')[0];
          const refererJob = jobNum != null ? jobNum : undefined;
          const jobName =
              resolveJobNameFromTicketRow(row) ||
              (td.ngenUserReference != null ? String(td.ngenUserReference).trim() : '') ||
              null;
          const documentNamePrefix = buildUsanDocumentNamePrefix(requestNumber, jobName);

          if (confirmationOnly) {
              if (jobNum == null) {
                  return res.status(400).json({ error: 'No nGen job number; refresh the ticket from PAC/nGen first.' });
              }
              const confirmationBuf = (await withNgenAuthRetry(
                  fetch,
                  svc.user,
                  svc.pass,
                  jobNum,
                  async ({ jar, refererApp }) => downloadConfirmationPdf(fetch, jar, refererApp, jobNum)
              )) as ArrayBuffer;
              const zipBytes = zipSync({
                  [`${documentNamePrefix} - confirmation-sheet.pdf`]: new Uint8Array(confirmationBuf),
              });
              res.setHeader('Content-Type', 'application/zip');
              res.setHeader(
                  'Content-Disposition',
                  contentDispositionAttachment(`${documentNamePrefix} - confirmation-sheet.zip`)
              );
              res.setHeader('X-Usan-Doc-Kind', 'confirmation');
              if (resolvedRevision) res.setHeader('X-Usan-Revision', resolvedRevision);
              return res.sendBuffer(zipBytes);
          }

          if (fullHistoryOnly) {
              const jobPackBuf = (await withNgenAuthRetry(
                  fetch,
                  svc.user,
                  svc.pass,
                  refererJob,
                  async ({ jar, refererApp }) =>
                      downloadJobPackPdf(fetch, jar, refererApp, requestNumber, {
                          includeFullHistory: true,
                      })
              )) as ArrayBuffer;
              const zipBytes = zipSync({
                  [`${documentNamePrefix} - full-history.pdf`]: new Uint8Array(jobPackBuf),
              });
              res.setHeader('Content-Type', 'application/zip');
              res.setHeader(
                  'Content-Disposition',
                  contentDispositionAttachment(`${documentNamePrefix} - full-history.zip`)
              );
              res.setHeader('X-Usan-Doc-Kind', 'full-history');
              return res.sendBuffer(zipBytes);
          }

          if (jobNum == null) {
              return res.status(400).json({ error: 'No nGen job number; refresh the ticket from PAC/nGen first.' });
          }
          const { confirmationBuf, jobPackBuf } = (await withNgenAuthRetry(
              fetch,
              svc.user,
              svc.pass,
              jobNum,
              async ({ jar, refererApp }) => {
                  const confirmation = await downloadConfirmationPdf(fetch, jar, refererApp, jobNum);
                  const jobPack = await downloadJobPackPdf(fetch, jar, refererApp, requestNumber, {
                      includeFullHistory: true,
                  });
                  return { confirmationBuf: confirmation, jobPackBuf: jobPack };
              }
          )) as { confirmationBuf: unknown; jobPackBuf: unknown };

          const zipBytes = zipSync({
              [`${documentNamePrefix} - confirmation-sheet.pdf`]: new Uint8Array(confirmationBuf as ArrayBuffer),
              [`${documentNamePrefix} - full-history.pdf`]: new Uint8Array(jobPackBuf as ArrayBuffer),
          });

          res.setHeader('Content-Type', 'application/zip');
          res.setHeader(
              'Content-Disposition',
              contentDispositionAttachment(`${documentNamePrefix} - documents.zip`)
          );
          res.setHeader('X-Usan-Doc-Kind', 'pack');
          res.sendBuffer(zipBytes);
      } catch (e) {
          console.error('GET /tickets/:ticketNumber/usan-document-pack:', e);
          res.status(500).json({ error: e.message || 'Failed to download USAN documents' });
      }
  });

  // Ticket hub: who opened this ticket (append-only view log)
}
