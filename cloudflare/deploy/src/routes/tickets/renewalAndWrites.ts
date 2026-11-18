import type { TicketsApp } from './types.js';
import * as ticketShared from './shared.js';
import { getDatabase } from '../../database.js';
import { canMutateOrganization, ORG_REQUIRED_MESSAGE, verifyPassword } from '../../auth.js';
import { getNgenCredentialsForPoll, validateNgenPollCanRun } from '../../lib/pacPollNgenCredentials.cjs';
import {
    withNgenAuthRetry,
    fetchEnquirySearch,
    postReverseGeocodeCurrentUserAsync,
    getGeoSearchByStreetAsync,
} from '../../lib/ngenClient.cjs';
import { getRow, allRows } from '../../lib/db.cjs';
import { errorResponseBody, logErrorIncident } from '../../lib/appErrors.cjs';
import { buildExpressReq, ResShim } from '../../expressCompat.js';
import { computeWorkflowStatusForTicket } from '../computeWorkflowStatus.js';
import { buildRenewalPayload, fetchComputedDateValuesForRenewal, fetchComputedDateValuesForNew, formatNgenComputedDateParamFromYmd, formatNgenExpirationEndOfDayFromYmd, submitRenewalEnquiry, submitRenewalEnquiryPaced, truthyRenewalFlag } from '../../lib/ngenRenewal.cjs';
import {
    buildClonedNewTicketFromEnquiry,
    buildDigSiteWizardFieldsFromEnquiry,
    buildSharedWizardFieldsFromEnquiry,
    fetchComputedDatesForCloneNewFromEnquiry,
    submitRejectedHttpResult,
    submitRejectedStepResult,
    truthyRemarkFlag,
} from '../../lib/ngenNewTicket.cjs';
import { fetchComputedDateValuesForRemark, buildRemarkPayload, submitRemarkEnquiryPaced } from '../../lib/ngenRemark.cjs';
import {
    fetchComputedDateValuesForAmendment,
    buildAmendmentPayload,
    submitAmendmentEnquiryPaced,
    truthyAmendmentFlag,
} from '../../lib/ngenAmendment.cjs';
import {
    buildOperatorSubmitPayload,
    fetchComputedDateValuesForOperatorSubmit,
    getOperatorSubmitConfig,
    truthyCanBeFlag,
    validateAuthorityIds,
} from '../../lib/ngenOperatorSubmit.cjs';
import { validateCommencementDateTime, commencesPayloadToYmdHm } from '../../lib/ticketCommencementDates.cjs';
import { pacificOffsetForYmd } from '../../lib/pacificTime.cjs';
import { invalidateOrgActiveTicketListCache } from '../../lib/ticketListCache.js';
import {
    parseIdempotencyKey,
    parseIdempotencyKeysMap,
    validateIdempotencyKey,
    withUsanSubmitIdempotency,
    sendIdempotencyResponse,
} from '../../lib/usanSubmitIdempotency.js';
import { assertNotTechWrite, buildTicketResponseForClient, findFullTicketRowForOrg, loadWorkflowAckContextForOrg, workflowStatusOptionsFromContext } from '../ticketRowHelpers.js';
import { resolveNgenJobNumberForTicket } from './refresh.js';

async function handleOperatorSubmitRoute(req: any, res: any, db: any, operation: any, routePath: any) {
    const orgId =
        req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
    if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

    const config = getOperatorSubmitConfig(operation);
    if (!config) return res.status(400).json({ error: 'invalid operator submit operation' });

    const rawTn = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : '';
    const textRaw = req.body.text != null ? String(req.body.text).trim() : '';
    const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';
    const text = textRaw || (dryRun ? '<enter notification text>' : '');
    const authorityIds = Array.isArray(req.body.authorityIds) ? req.body.authorityIds : [];
    const isOperatorFault = req.body.isOperatorFault === true;

    if (!rawTn) return res.status(400).json({ error: 'ticketNumber is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (!authorityIds.length && !dryRun) return res.status(400).json({ error: 'authorityIds is required' });

    const credErr = await validateNgenPollCanRun(db, orgId);
    if (credErr) return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) {
        return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
    }

    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) return res.status(403).json({ error: 'Cannot submit on a shared ticket view.' });

    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        return res.status(400).json({ error: 'No nGen job number for this ticket.' });
    }

    const idempotencyKey = parseIdempotencyKey(req);
    if (idempotencyKey && !dryRun && !validateIdempotencyKey(idempotencyKey)) {
        return res.status(400).json({ error: 'idempotencyKey must be a UUID v4 (max 64 characters)' });
    }

    try {
        const idem = await withUsanSubmitIdempotency(
            {
                db,
                userId: req.user.id,
                orgId,
                key: idempotencyKey,
                operation,
                scopeRef: rawTn,
                dryRun,
            },
            async () => {
                const jobKey = Number(jobNum);
                const pipelineResult: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                    const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                    const details = enquiry && enquiry.enquiryDetails;
                    if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                    if (!truthyCanBeFlag(details, config.canBeFlag)) {
                        return { step: config.canBeFlag, ok: false, message: `Upstream ${config.canBeFlag} is false` };
                    }
                    const authCheck = validateAuthorityIds(authorityIds, enquiry);
                    if (!authCheck.ok) {
                        return { step: 'authorityIds', ok: false, message: authCheck.message || 'Invalid authorityIds' };
                    }
                    const computedRes = await fetchComputedDateValuesForOperatorSubmit(
                        fetch,
                        jar,
                        details,
                        config.ticketCreationMethod
                    );
                    if (!computedRes.ok) {
                        return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                    }
                    const submitPayload = buildOperatorSubmitPayload(enquiry, computedRes.data || {}, jobKey, {
                        method: config.ticketCreationMethod,
                        text,
                        authorityIds: (authCheck as any).authorityIds,
                        isOperatorFault,
                    });
                    if (dryRun) return { step: 'dry_run', ok: true, dryRun: true, submitPayload };
                    const ngenSubmitPacing = { lastSubmitAt: 0 };
                    const submitRes = await submitRemarkEnquiryPaced(fetch, jar, submitPayload, ngenSubmitPacing);
                    const { parsed, rejected } = submitRejectedStepResult(
                        submitRes,
                        'Operator submit rejected or incomplete response'
                    );
                    if (rejected) return rejected;
                    return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
                });

                if (!pipelineResult.ok) {
                    const rateLimited =
                        pipelineResult.message && String(pipelineResult.message).includes('rate limit');
                    return {
                        httpStatus: rateLimited ? 429 : 502,
                        body: {
                            ok: false,
                            error: pipelineResult.message || pipelineResult.step || `${operation}_failed`,
                            usan: pipelineResult.failureLog || null,
                        },
                    };
                }

                const out: any = { ok: true };
                if (pipelineResult.dryRun) out.dryRun = true;
                if (pipelineResult.submitPayload != null) out.submitPayload = pipelineResult.submitPayload;
                if (pipelineResult.newEnquiryId != null) out.newEnquiryId = pipelineResult.newEnquiryId;
                return {
                    httpStatus: 200,
                    body: out,
                    newEnquiryId: pipelineResult.newEnquiryId,
                };
            }
        );

        return sendIdempotencyResponse(res, idem);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        console.warn(`[tickets/${routePath}]`, msg);
        return res.status(500).json({ error: msg });
    }
}

export function registerTicketsRenewalAndWriteRoutes(tickets: TicketsApp) {
  const app = tickets as any;
  app.post('/renew/preview', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

      const { error, uniq } = ticketShared.parseRenewTicketNumberList(req.body.ticketNumbers);
      if (error) return res.status(400).json({ error });

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      const workflowCtx = await loadWorkflowAckContextForOrg(db, orgId);
      const ackMap = workflowCtx.ackMap;
      const workflowOpts = workflowStatusOptionsFromContext(workflowCtx);

      const ticketsOut = [];
      const summary = { renew: 0, clone_new: 0, skip: 0 };

      for (const rawTn of uniq) {
          const entry = {
              ticketNumber: rawTn,
              workflowStatus: null,
              action: 'skip',
              skipReason: null,
              canBeRenewal: null,
              canBeRemark: null,
          };
          try {
              const row = await findFullTicketRowForOrg(db, orgId, rawTn);
              if (!row) {
                  entry.skipReason = ticketShared.formatRenewSkipReason('ticket_not_found');
                  summary.skip++;
                  ticketsOut.push(entry);
                  continue;
              }
              const ticket = await buildTicketResponseForClient(db, orgId, row);
              if ((ticket as any).shared) {
                  entry.skipReason = ticketShared.formatRenewSkipReason('shared_ticket');
                  summary.skip++;
                  ticketsOut.push(entry);
                  continue;
              }
              const wf = computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts);
              entry.workflowStatus = wf;
              const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
              if (jobNum == null || !Number.isFinite(Number(jobNum))) {
                  entry.skipReason = ticketShared.formatRenewSkipReason('no_job_number');
                  summary.skip++;
                  ticketsOut.push(entry);
                  continue;
              }
              const jobKey = Number(jobNum);
              let details = null;
              await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                  const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                  details = enquiry && enquiry.enquiryDetails;
              });
              const classified = ticketShared.classifyRenewActionFromEnquiry(details, { autoCloneExhausted: true });
              entry.action = classified.action;
              entry.skipReason = classified.skipReason
                  ? ticketShared.formatRenewSkipReason(classified.skipReason)
                  : null;
              if (details) {
                  entry.canBeRenewal = details.canBeRenewal;
                  entry.canBeRemark = details.canBeRemark;
              }
              summary[classified.action] = (summary[classified.action] || 0) + 1;
          } catch (e) {
              entry.skipReason = e && e.message ? String(e.message) : String(e);
              summary.skip++;
          }
          ticketsOut.push(entry);
      }

      return res.json({ tickets: ticketsOut, summary });
  });

  /**
   * Bulk ticket renewal / auto-clone (nGen): org admins only, feature-flagged.
   * Body: { organizationId?, ticketNumbers, dryRun?, password?, autoCloneExhausted? }
   */
  app.post('/renew', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

      const rawList = req.body.ticketNumbers;
      const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';
      const autoCloneExhausted =
          req.body.autoCloneExhausted !== false && String(req.body.autoCloneExhausted || '').trim() !== '0';
      const password = req.body.password != null ? String(req.body.password) : '';

      const { error, uniq } = ticketShared.parseRenewTicketNumberList(rawList);
      if (error) return res.status(400).json({ error });

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          await logErrorIncident(db, credErr, {
              req,
              route: 'tickets.renew.validateCredentials',
              organizationId: orgId,
          });
          return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      const workflowCtx = await loadWorkflowAckContextForOrg(db, orgId);
      const ackMap = workflowCtx.ackMap;
      const workflowOpts = workflowStatusOptionsFromContext(workflowCtx);

      const plans = [];
      let needsClonePassword = false;

      for (const rawTn of uniq) {
          const plan: any = { ticketNumber: rawTn, action: 'skip', skipReason: null, row: null, ticket: null, jobKey: null };
          try {
              const row = await findFullTicketRowForOrg(db, orgId, rawTn);
              if (!row) {
                  plan.skipReason = ticketShared.formatRenewSkipReason('ticket_not_found');
                  plans.push(plan);
                  continue;
              }
              const ticket = await buildTicketResponseForClient(db, orgId, row);
              if ((ticket as any).shared) {
                  plan.skipReason = ticketShared.formatRenewSkipReason('shared_ticket');
                  plans.push(plan);
                  continue;
              }
              const wf = computeWorkflowStatusForTicket(ticket, ackMap, 'owner', workflowOpts);
              plan.workflowStatus = wf;
              const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
              if (jobNum == null || !Number.isFinite(Number(jobNum))) {
                  plan.skipReason = ticketShared.formatRenewSkipReason('no_job_number');
                  plans.push(plan);
                  continue;
              }
              plan.row = row;
              plan.ticket = ticket;
              plan.jobKey = Number(jobNum);
              let details = null;
              await withNgenAuthRetry(fetch, svc.user, svc.pass, plan.jobKey, async ({ jar, refererApp }) => {
                  const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, plan.jobKey);
                  plan.enquiry = enquiry;
                  details = enquiry && enquiry.enquiryDetails;
              });
              const classified = ticketShared.classifyRenewActionFromEnquiry(details, { autoCloneExhausted: true });
              plan.action = classified.action;
              plan.skipReason = classified.skipReason
                  ? ticketShared.formatRenewSkipReason(classified.skipReason)
                  : null;
              if (plan.action === 'clone_new' && autoCloneExhausted) needsClonePassword = true;
              if (plan.action === 'clone_new' && !autoCloneExhausted) {
                  plan.action = 'skip';
                  plan.skipReason = ticketShared.formatRenewSkipReason('auto_clone_disabled');
              }
          } catch (e) {
              plan.skipReason = e && e.message ? String(e.message) : String(e);
          }
          plans.push(plan);
      }

      if (needsClonePassword && !dryRun) {
          if (!password) {
              return res.status(400).json({
                  error: 'Account password is required to submit new tickets copied from exhausted locates.',
              });
          }
          const pwdRow = await getRow(db, 'SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
          if (!pwdRow || !pwdRow.password_hash) {
              return res.status(500).json({ error: 'Account password not available' });
          }
          if (!verifyPassword(password, pwdRow.password_hash)) {
              return res.status(403).json({ error: 'Invalid password' });
          }
      }

      const results = [];
      const idempotencyKeys = parseIdempotencyKeysMap(req.body);
      for (const plan of plans) {
          const rawTn = plan.ticketNumber;
          if (plan.action === 'skip') {
              results.push({
                  ticketNumber: rawTn,
                  ok: false,
                  error: plan.skipReason || ticketShared.formatRenewSkipReason('skipped'),
                  actionTaken: 'skip',
              });
              continue;
          }

          const ticketIdempotencyKey = idempotencyKeys[rawTn] || null;

          const runRenewPipeline = async () => {
              const jobKey = plan.jobKey;
              const pipelineResult: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                  const enquiry = plan.enquiry || (await fetchEnquirySearch(fetch, jar, refererApp, jobKey));
                  const details = enquiry && enquiry.enquiryDetails;

                  if (!details) {
                      return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                  }

                  if (plan.action === 'clone_new') {
                      const computedRes = await fetchComputedDatesForCloneNewFromEnquiry(fetch, jar, details);
                      if (!computedRes.ok) {
                          return {
                              step: 'computed_dates',
                              ok: false,
                              message: `computed dates HTTP ${computedRes.status}`,
                          };
                      }
                      const computedDates = computedRes.data || {};
                      const clonePayload = buildClonedNewTicketFromEnquiry(enquiry, { computedDates });
                      if (dryRun) {
                          return {
                              step: 'dry_run',
                              ok: true,
                              dryRun: true,
                              actionTaken: 'clone_new',
                              submitPayload: clonePayload,
                          };
                      }
                      const submitRes = await submitRenewalEnquiryPaced(
                          fetch,
                          jar,
                          clonePayload
                      );
                      const { parsed, rejected } = submitRejectedStepResult(
                          submitRes,
                          'Clone-new submit rejected or incomplete response'
                      );
                      if (rejected) return rejected;
                      return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId, actionTaken: 'clone_new' };
                  }

                  if (!truthyRenewalFlag(details.canBeRenewal)) {
                      return {
                          step: 'canBeRenewal',
                          ok: false,
                          message: 'Upstream canBeRenewal is false',
                      };
                  }

                  const computedRes = await fetchComputedDateValuesForRenewal(fetch, jar, details);
                  if (!computedRes.ok) {
                      return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                  }

                  const payload = buildRenewalPayload(enquiry, computedRes.data || {}, jobKey);

                  if (dryRun) {
                      return {
                          step: 'dry_run',
                          ok: true,
                          dryRun: true,
                          actionTaken: 'renew',
                          submitPayload: payload,
                      };
                  }

                  const submitRes = await submitRenewalEnquiryPaced(fetch, jar, payload);
                  const { parsed, rejected } = submitRejectedStepResult(
                      submitRes,
                      'Submit rejected or incomplete response'
                  );
                  if (rejected) return rejected;
                  return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId, actionTaken: 'renew' };
              });
              return pipelineResult;
          };

          const pipelineResultToRow = (pipelineResult: any) => {
              if (pipelineResult.ok) {
                  const rowOut: any = {
                      ticketNumber: rawTn,
                      ok: true,
                      actionTaken: pipelineResult.actionTaken || plan.action,
                  };
                  if (pipelineResult.dryRun) rowOut.dryRun = true;
                  if (pipelineResult.submitPayload != null) rowOut.submitPayload = pipelineResult.submitPayload;
                  if (pipelineResult.newEnquiryId != null) rowOut.newEnquiryId = pipelineResult.newEnquiryId;
                  return rowOut;
              }
              return {
                  ticketNumber: rawTn,
                  ok: false,
                  error: pipelineResult.message || pipelineResult.step || 'failed',
                  step: pipelineResult.step,
                  actionTaken: plan.action,
              };
          };

          try {
              if (ticketIdempotencyKey && !dryRun) {
                  const idem = await withUsanSubmitIdempotency(
                      {
                          db,
                          userId: req.user.id,
                          orgId,
                          key: ticketIdempotencyKey,
                          operation: plan.action === 'clone_new' ? 'clone_new' : 'renew',
                          scopeRef: rawTn,
                          dryRun,
                      },
                      async () => {
                          const pipelineResult = await runRenewPipeline();
                          const rowOut = pipelineResultToRow(pipelineResult);
                          const rateLimited =
                              !pipelineResult.ok &&
                              pipelineResult.message &&
                              String(pipelineResult.message).includes('rate limit');
                          return {
                              httpStatus: pipelineResult.ok ? 200 : rateLimited ? 429 : 502,
                              body: rowOut,
                              newEnquiryId: pipelineResult.newEnquiryId,
                          };
                      }
                  );

                  if (idem.httpStatus === 400) {
                      results.push({
                          ticketNumber: rawTn,
                          ok: false,
                          error: idem.body.error || 'Invalid idempotency key',
                          actionTaken: plan.action,
                      });
                      continue;
                  }

                  if (idem.httpStatus === 409) {
                      results.push({
                          ticketNumber: rawTn,
                          ok: false,
                          error: idem.body.error || 'Submit already in progress',
                          code: idem.body.code || 'IDEMPOTENCY_IN_PROGRESS',
                          actionTaken: plan.action,
                      });
                      continue;
                  }

                  results.push(idem.body);
                  continue;
              }

              const pipelineResult = await runRenewPipeline();

              results.push(pipelineResultToRow(pipelineResult));
          } catch (e) {
              const msg = e && e.message ? String(e.message) : String(e);
              results.push({ ticketNumber: rawTn, ok: false, error: msg, actionTaken: plan.action });
          }
      }

      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      if (okCount > 0) {
          void invalidateOrgActiveTicketListCache(db, orgId);
      }
      return res.json({
          ok: failCount === 0,
          results,
          summary: { total: results.length, succeeded: okCount, failed: failCount },
      });
  });

  /**
   * POST /api/tickets/reverse-geocode — nGen ReverseGeocodeCurrentUserAsync using org USAN master credentials.
   * Body: { organizationId?, wkt: string, activityId?, purposeName?, searchRegionId? }
   */
  app.post('/reverse-geocode', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;

      const wkt = req.body.wkt != null ? String(req.body.wkt).trim() : '';
      if (!wkt || !/^POLYGON\s*\(/i.test(wkt)) {
          return res.status(400).json({ error: 'wkt must be a non-empty POLYGON(...) WKT string' });
      }
      if (wkt.length > 120000) {
          return res.status(400).json({ error: 'wkt is too large' });
      }

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          await logErrorIncident(db, credErr, {
              req,
              route: 'tickets.reverseGeocode.validateCredentials',
              organizationId: orgId,
          });
          return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      let activityId = 1;
      if (req.body.activityId != null && String(req.body.activityId).trim() !== '') {
          const n = parseInt(String(req.body.activityId), 10);
          if (Number.isFinite(n) && n >= 0) activityId = n;
      }
      let purposeNameStr = '0';
      if (req.body.purposeName != null && String(req.body.purposeName).trim() !== '') {
          purposeNameStr = String(req.body.purposeName).trim();
      }
      let searchRegionId = null;
      if (req.body.searchRegionId != null && String(req.body.searchRegionId).trim() !== '') {
          const n = parseInt(String(req.body.searchRegionId), 10);
          if (Number.isFinite(n)) searchRegionId = n;
      }

      const payload = {
          wkt,
          purposeName: purposeNameStr,
          searchRegionId,
          activityId,
          wktList: [wkt],
      };

      try {
          const data = await withNgenAuthRetry(fetch, svc.user, svc.pass, null, async ({ jar, refererApp }) =>
              postReverseGeocodeCurrentUserAsync(fetch, jar, refererApp, payload)
          );
          return res.json({ ok: true, data });
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          console.warn('[tickets/reverse-geocode]', msg);
          return res.status(502).json({ error: msg });
      }
  });

  /**
   * POST /api/tickets/geo-search-street — nGen GeoSearch/SearchByStreetAsync using org USAN master credentials.
   * Body: { organizationId?, streetAddress: string }
   */
  app.post('/geo-search-street', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;

      const streetAddress = req.body.streetAddress != null ? String(req.body.streetAddress).trim() : '';
      if (!streetAddress) {
          return res.status(400).json({ error: 'streetAddress is required' });
      }
      if (streetAddress.length > 500) {
          return res.status(400).json({ error: 'streetAddress is too long' });
      }

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          await logErrorIncident(db, credErr, {
              req,
              route: 'tickets.geoSearchStreet.validateCredentials',
              organizationId: orgId,
          });
          return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      try {
          const data = await withNgenAuthRetry(fetch, svc.user, svc.pass, null, async ({ jar, refererApp }) =>
              getGeoSearchByStreetAsync(fetch, jar, refererApp, streetAddress)
          );
          return res.json({ ok: true, data });
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          console.warn('[tickets/geo-search-street]', msg);
          return res.status(502).json({ error: msg });
      }
  });

  /**
   * POST /api/tickets/computed-dates-new — nGen GetCurrentUserEnquiryComputedDateValues (ticketCreationMethod=New).
   * Body: { organizationId?, enquiryPurposeId?, startDateYmd, startTimeHm?, expirationDays?, offset? }
   */
  app.post('/computed-dates-new', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;

      const startDateYmd = req.body.startDateYmd != null ? String(req.body.startDateYmd).trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateYmd)) {
          return res.status(400).json({ error: 'startDateYmd must be yyyy-mm-dd' });
      }

      let enquiryPurposeId = 0;
      if (req.body.enquiryPurposeId != null && String(req.body.enquiryPurposeId).trim() !== '') {
          const n = parseInt(String(req.body.enquiryPurposeId), 10);
          if (Number.isFinite(n) && n >= 0) enquiryPurposeId = n;
      }

      const startTimeHm =
          req.body.startTimeHm != null && String(req.body.startTimeHm).trim() !== ''
              ? String(req.body.startTimeHm).trim()
              : '17:00';
      let expirationDays = 45;
      if (req.body.expirationDays != null && String(req.body.expirationDays).trim() !== '') {
          const n = parseInt(String(req.body.expirationDays), 10);
          if (Number.isFinite(n) && n >= 1 && n <= 365) expirationDays = n;
      }
      const offset =
          req.body.offset != null && String(req.body.offset).trim() !== ''
              ? String(req.body.offset).trim()
              : pacificOffsetForYmd(startDateYmd);

      const startDateParam = formatNgenComputedDateParamFromYmd(startDateYmd, startTimeHm, offset);
      const expirationTimeParam = formatNgenExpirationEndOfDayFromYmd(startDateYmd, expirationDays);
      if (!startDateParam || !expirationTimeParam) {
          return res.status(400).json({ error: 'Could not build computed-date query parameters' });
      }

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          await logErrorIncident(db, credErr, {
              req,
              route: 'tickets.computedDatesNew.validateCredentials',
              organizationId: orgId,
          });
          return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      try {
          const jsonRes: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, null, async ({ jar }) =>
              fetchComputedDateValuesForNew(fetch, jar, {
                  enquiryPurposeId,
                  startDateParam,
                  expirationTimeParam,
              })
          );
          if (!jsonRes.ok) {
              const snippet = (jsonRes.text || '').slice(0, 500);
              return res.status(502).json({
                  error: `GetCurrentUserEnquiryComputedDateValues failed: ${jsonRes.status} ${snippet}`,
              });
          }
          return res.json({ ok: true, data: jsonRes.data });
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          console.warn('[tickets/computed-dates-new]', msg);
          return res.status(502).json({ error: msg });
      }
  });

  /**
   * POST /api/tickets/clone-wizard-prefill — enrich create-ticket wizard from a source ticket enquiry.
   * Body: { organizationId?, ticketNumber, copyPolygon?: boolean }
   */
  app.post('/clone-wizard-prefill', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes') as ResShim;
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!orgId) {
          return res.status(400).json({ error: ORG_REQUIRED_MESSAGE });
      }
      if (!canMutateOrganization(req.user, orgId)) {
          return res.status(403).json({ error: 'You do not have access to that organization' });
      }
      if (!(await assertNotTechWrite(req, res, orgId))) return;

      const rawTn = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : '';
      if (!rawTn) return res.status(400).json({ error: 'ticketNumber is required' });
      const copyPolygon = req.body.copyPolygon === true || String(req.body.copyPolygon || '').trim() === '1';

      const row = await findFullTicketRowForOrg(db, orgId, rawTn);
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = await buildTicketResponseForClient(db, orgId, row);
      if ((ticket as any).shared) {
          return res.status(403).json({ error: 'Cannot clone from a shared ticket view.' });
      }

      const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
      if (jobNum == null || !Number.isFinite(Number(jobNum))) {
          return res.json({ ok: true, clientOnly: true, shared: null, digSites: null });
      }

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) {
          return res.json({ ok: true, clientOnly: true, shared: null, digSites: null });
      }
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.json({ ok: true, clientOnly: true, shared: null, digSites: null });
      }

      try {
          const jobKey = Number(jobNum);
          const pipelineResult: any = await withNgenAuthRetry(
              fetch,
              svc.user,
              svc.pass,
              jobKey,
              async ({ jar, refererApp }) => {
                  const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                  const details = enquiry && enquiry.enquiryDetails;
                  if (!details) return { ok: false, message: 'No enquiryDetails from nGen' };
                  const computedRes = await fetchComputedDatesForCloneNewFromEnquiry(fetch, jar, details);
                  const computedDates = computedRes.ok ? computedRes.data || {} : {};
                  const shared = buildSharedWizardFieldsFromEnquiry(enquiry, computedDates);
                  const digSites = copyPolygon ? [buildDigSiteWizardFieldsFromEnquiry(enquiry)] : null;
                  return { ok: true, shared, digSites };
              }
          );
          if (!pipelineResult || !pipelineResult.ok) {
              return res.json({ ok: true, clientOnly: true, shared: null, digSites: null });
          }
          return res.json({
              ok: true,
              shared: pipelineResult.shared,
              digSites: pipelineResult.digSites,
          });
      } catch (e) {
          const msg = e && (e as Error).message ? String((e as Error).message) : String(e);
          console.warn('[tickets/clone-wizard-prefill]', msg);
          return res.json({ ok: true, clientOnly: true, shared: null, digSites: null });
      }
  });

  /**
   * POST /api/tickets/remark — single-ticket USAN remark (admin only).
   * Body: { organizationId?, ticketNumber, text, dryRun? }
   */
  app.post('/remark', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

      const rawTn = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : '';
      const textRaw = req.body.text != null ? String(req.body.text).trim() : '';
      const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';
      const text = textRaw || (dryRun ? '<enter remark>' : '');

      if (!rawTn) return res.status(400).json({ error: 'ticketNumber is required' });
      if (!text) return res.status(400).json({ error: 'Remark text is required' });

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      const row = await findFullTicketRowForOrg(db, orgId, rawTn);
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = await buildTicketResponseForClient(db, orgId, row);
      if ((ticket as any).shared) return res.status(403).json({ error: 'Cannot remark on a shared ticket view.' });

      const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
      if (jobNum == null || !Number.isFinite(Number(jobNum))) {
          return res.status(400).json({ error: 'No nGen job number for this ticket.' });
      }

      const idempotencyKey = parseIdempotencyKey(req);
      if (idempotencyKey && !dryRun && !validateIdempotencyKey(idempotencyKey)) {
          return res.status(400).json({ error: 'idempotencyKey must be a UUID v4 (max 64 characters)' });
      }

      const ngenSubmitPacing = { lastSubmitAt: 0 };

      try {
          const idem = await withUsanSubmitIdempotency(
              {
                  db,
                  userId: req.user.id,
                  orgId,
                  key: idempotencyKey,
                  operation: 'remark',
                  scopeRef: rawTn,
                  dryRun,
              },
              async () => {
                  const jobKey = Number(jobNum);
                  const pipelineResult: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                      const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                      const details = enquiry && enquiry.enquiryDetails;
                      if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                      if (!truthyRemarkFlag(details.canBeRemark)) {
                          return { step: 'canBeRemark', ok: false, message: 'Upstream canBeRemark is false' };
                      }
                      const computedRes = await fetchComputedDateValuesForRemark(fetch, jar, details);
                      if (!computedRes.ok) {
                          return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                      }
                      const payload = buildRemarkPayload(enquiry, computedRes.data || {}, jobKey, text);
                      if (
                          !Array.isArray(payload.manuallySelectedUtiliiesFromPreviousTicket) ||
                          payload.manuallySelectedUtiliiesFromPreviousTicket.length === 0
                      ) {
                          return {
                              step: 'utilities',
                              ok: false,
                              message:
                                  'No utility operators found on this ticket to retransmit the remark to.',
                          };
                      }
                      if (dryRun) return { step: 'dry_run', ok: true, dryRun: true, submitPayload: payload };
                      const submitRes = await submitRemarkEnquiryPaced(fetch, jar, payload, ngenSubmitPacing);
                      const { parsed, rejected } = submitRejectedStepResult(
                          submitRes,
                          'Remark submit rejected or incomplete response'
                      );
                      if (rejected) return rejected;
                      return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
                  });

                  if (!pipelineResult.ok) {
                      const rateLimited =
                          pipelineResult.message && String(pipelineResult.message).includes('rate limit');
                      return {
                          httpStatus: rateLimited ? 429 : 502,
                          body: {
                              ok: false,
                              error: pipelineResult.message || pipelineResult.step || 'remark_failed',
                              usan: pipelineResult.failureLog || null,
                          },
                      };
                  }

                  const out: any = { ok: true };
                  if (pipelineResult.dryRun) out.dryRun = true;
                  if (pipelineResult.submitPayload != null) out.submitPayload = pipelineResult.submitPayload;
                  if (pipelineResult.newEnquiryId != null) out.newEnquiryId = pipelineResult.newEnquiryId;
                  return {
                      httpStatus: 200,
                      body: out,
                      newEnquiryId: pipelineResult.newEnquiryId,
                  };
              }
          );

          return sendIdempotencyResponse(res, idem);
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return res.status(500).json({ error: msg });
      }
  });

  /**
   * POST /api/tickets/amendment — single-ticket USAN amendment (admin only).
   * Body: { organizationId?, ticketNumber, text, dryRun? }
   */
  app.post('/amendment', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

      const rawTn = req.body.ticketNumber != null ? String(req.body.ticketNumber).trim() : '';
      const textRaw = req.body.text != null ? String(req.body.text).trim() : '';
      const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';
      const text = textRaw || (dryRun ? '<enter amendment reason>' : '');
      const fieldOverrides =
          req.body.fields != null && typeof req.body.fields === 'object' && !Array.isArray(req.body.fields)
              ? req.body.fields
              : null;

      if (!rawTn) return res.status(400).json({ error: 'ticketNumber is required' });
      if (!text) return res.status(400).json({ error: 'Amendment text is required' });

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      const row = await findFullTicketRowForOrg(db, orgId, rawTn);
      if (!row) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = await buildTicketResponseForClient(db, orgId, row);
      if ((ticket as any).shared) return res.status(403).json({ error: 'Cannot amend on a shared ticket view.' });

      const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
      if (jobNum == null || !Number.isFinite(Number(jobNum))) {
          return res.status(400).json({ error: 'No nGen job number for this ticket.' });
      }

      const idempotencyKey = parseIdempotencyKey(req);
      if (idempotencyKey && !dryRun && !validateIdempotencyKey(idempotencyKey)) {
          return res.status(400).json({ error: 'idempotencyKey must be a UUID v4 (max 64 characters)' });
      }

      const ngenSubmitPacing = { lastSubmitAt: 0 };

      try {
          const idem = await withUsanSubmitIdempotency(
              {
                  db,
                  userId: req.user.id,
                  orgId,
                  key: idempotencyKey,
                  operation: 'amendment',
                  scopeRef: rawTn,
                  dryRun,
              },
              async () => {
                  const jobKey = Number(jobNum);
                  const pipelineResult: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                      const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                      const details = enquiry && enquiry.enquiryDetails;
                      if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                      if (!truthyAmendmentFlag(details.canBeAmended)) {
                          return { step: 'canBeAmended', ok: false, message: 'Upstream canBeAmended is false' };
                      }
                      const computedRes = await fetchComputedDateValuesForAmendment(fetch, jar, details);
                      if (!computedRes.ok) {
                          return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                      }
                      const payload = buildAmendmentPayload(enquiry, computedRes.data || {}, jobKey, text, fieldOverrides);
                      if (dryRun) return { step: 'dry_run', ok: true, dryRun: true, submitPayload: payload };
                      const submitRes = await submitAmendmentEnquiryPaced(fetch, jar, payload, ngenSubmitPacing);
                      const { parsed, rejected } = submitRejectedStepResult(
                          submitRes,
                          'Amendment submit rejected or incomplete response'
                      );
                      if (rejected) return rejected;
                      return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
                  });

                  if (!pipelineResult.ok) {
                      const rateLimited =
                          pipelineResult.message && String(pipelineResult.message).includes('rate limit');
                      return {
                          httpStatus: rateLimited ? 429 : 502,
                          body: {
                              ok: false,
                              error: pipelineResult.message || pipelineResult.step || 'amendment_failed',
                              usan: pipelineResult.failureLog || null,
                          },
                      };
                  }

                  const out: any = { ok: true };
                  if (pipelineResult.dryRun) out.dryRun = true;
                  if (pipelineResult.submitPayload != null) out.submitPayload = pipelineResult.submitPayload;
                  if (pipelineResult.newEnquiryId != null) out.newEnquiryId = pipelineResult.newEnquiryId;
                  return {
                      httpStatus: 200,
                      body: out,
                      newEnquiryId: pipelineResult.newEnquiryId,
                  };
              }
          );

          return sendIdempotencyResponse(res, idem);
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return res.status(500).json({ error: msg });
      }
  });

  /**
   * POST /api/tickets/create — greenfield new ticket submit (admin only).
   * Body: { organizationId?, payload, dryRun? }
   */
  app.post('/create', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      const orgId =
          req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
      if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

      const payload = req.body.payload;
      const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';

      if (!payload || typeof payload !== 'object') {
          return res.status(400).json({ error: 'payload object is required' });
      }
      const payloadStr = JSON.stringify(payload);
      if (payloadStr.length > 120000) {
          return res.status(400).json({ error: 'payload is too large' });
      }
      if (String(payload.ticketCreationMethod) !== 'New') {
          return res.status(400).json({ error: 'payload.ticketCreationMethod must be New' });
      }
      if (Number(payload.clonedFromEnquiryID) !== 0) {
          return res.status(400).json({ error: 'payload.clonedFromEnquiryID must be 0 for wizard create' });
      }
      if (!payload.spatialObjectNativeDescription || !payload.activityId || !payload.categoryId) {
          return res.status(400).json({ error: 'payload missing required spatial/work fields' });
      }
      if (!payload.principalContactName || !payload.principalContactMobile) {
          return res.status(400).json({ error: 'payload missing principal contact fields' });
      }
      if (!payload.commencesOnDate || !payload.commencesOnTime) {
          return res.status(400).json({ error: 'payload missing commencesOnDate or commencesOnTime' });
      }
      const commencesYmdHm = commencesPayloadToYmdHm(payload.commencesOnDate, payload.commencesOnTime);
      if (!commencesYmdHm) {
          return res.status(400).json({ error: 'payload commencesOnDate or commencesOnTime is invalid' });
      }
      const commenceValidation = validateCommencementDateTime(
          commencesYmdHm.ymd,
          commencesYmdHm.hm
      );
      if (!commenceValidation.ok) {
          return res.status(400).json({
              error: commenceValidation.message || 'Invalid planned work start date/time',
          });
      }
      const nearestCrossStreet =
          payload.nearestCrossStreet != null ? String(payload.nearestCrossStreet).trim() : '';
      if (!nearestCrossStreet || !/^[A-Za-z0-9 .'-]+$/.test(nearestCrossStreet) || !/[A-Za-z]/.test(nearestCrossStreet)) {
          return res.status(400).json({
              error: 'payload.nearestCrossStreet is required and must not contain special characters',
          });
      }

      const credErr = await validateNgenPollCanRun(db, orgId);
      if (credErr) return res.status((credErr as any).status || 400).json(errorResponseBody(credErr));
      const svc = await getNgenCredentialsForPoll(db, orgId);
      if (!svc || !svc.user || !svc.pass) {
          return res.status(400).json({ error: 'No nGen master credentials configured for this organization.' });
      }

      const idempotencyKey = parseIdempotencyKey(req);
      if (idempotencyKey && !dryRun && !validateIdempotencyKey(idempotencyKey)) {
          return res.status(400).json({ error: 'idempotencyKey must be a UUID v4 (max 64 characters)' });
      }

      if (dryRun) {
          return res.json({ ok: true, dryRun: true });
      }

      try {
          const idem = await withUsanSubmitIdempotency(
              {
                  db,
                  userId: req.user.id,
                  orgId,
                  key: idempotencyKey,
                  operation: 'create',
                  scopeRef: null,
                  dryRun,
              },
              async () => {
                  const submitRes: any = await withNgenAuthRetry(fetch, svc.user, svc.pass, null, async ({ jar }) =>
                      submitRenewalEnquiryPaced(fetch, jar, payload)
                  );
                  const { parsed, rejected } = submitRejectedHttpResult(
                      submitRes,
                      'Submit rejected or incomplete response'
                  );
                  if (rejected) return rejected;
                  return {
                      httpStatus: 200,
                      body: { ok: true, newEnquiryId: parsed.newEnquiryId },
                      newEnquiryId: parsed.newEnquiryId,
                  };
              }
          );

          if (idem && idem.httpStatus === 200) {
              void invalidateOrgActiveTicketListCache(db, orgId);
          }
          return sendIdempotencyResponse(res, idem);
      } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          return res.status(500).json({ error: msg });
      }
  });

  app.post('/exposed', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      return handleOperatorSubmitRoute(req, res, db, 'exposed', 'exposed');
  });

  app.post('/damage', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      return handleOperatorSubmitRoute(req, res, db, 'damage', 'damage');
  });

  app.post('/follow-up', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      return handleOperatorSubmitRoute(req, res, db, 'follow_up', 'follow-up');
  });

  app.post('/disputed', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      return handleOperatorSubmitRoute(req, res, db, 'disputed', 'disputed');
  });

  app.post('/no-response', async (c) => {
      const req = buildExpressReq(c);
      const res = c.get('expressRes');
      const db = getDatabase();
      return handleOperatorSubmitRoute(req, res, db, 'no_response', 'no-response');
  });

  // Save ticket (when imported) - uses organizationId from body (current org) or user's default
}
