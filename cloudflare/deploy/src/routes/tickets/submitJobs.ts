import type { TicketsApp } from './types.js';
import * as ticketShared from './shared.js';
import { getDatabase } from '../../database.js';
import { canAccessOrganization, verifyPassword } from '../../auth.js';
import { buildExpressReq } from '../../expressCompat.js';
import { getRow, allRows } from '../../lib/db.cjs';
import { getNgenCredentialsForPoll, validateNgenPollCanRun } from '../../lib/pacPollNgenCredentials.cjs';
import {
    dismissSubmitJobFailures,
    fetchActiveJobsForOrg,
    fetchFailedSubmitItemsForUser,
    fetchJobForClient,
    finalizeSettledActiveJob,
    getUserDisplayName,
    insertSubmitJob,
    isJobStale,
    resetStuckRunningSubmitItems,
    retryFailedSubmitItems,
    scheduleSubmitJobProcessing,
    validateCreatePayload,
} from '../../lib/submitJobProcessor.js';
import type { Env } from '../../types.js';
import { parseIdempotencyKeysMap, validateIdempotencyKey } from '../../lib/usanSubmitIdempotency.js';
import { withNgenAuthRetry, fetchEnquirySearch } from '../../lib/ngenClient.cjs';
import { buildTicketResponseForClient, findFullTicketRowForOrg } from '../ticketRowHelpers.js';
import { resolveNgenJobNumberForTicket } from './refresh.js';

function getExecutionCtx(c) {
    return (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
}

function getWorkflow(c) {
    const env = c.env as Env;
    return env && env.SUBMIT_JOB_WORKFLOW ? env.SUBMIT_JOB_WORKFLOW : null;
}

async function kickSubmitJob(c, db, jobId) {
    await scheduleSubmitJobProcessing({
        workflow: getWorkflow(c),
        ctx: getExecutionCtx(c),
        db,
        jobId,
    });
}

function parseOrgId(req) {
    return req.body.organizationId != null ? parseInt(req.body.organizationId, 10) : req.user.organizationId;
}

function parseItemsArray(body) {
    const raw = body.items;
    if (!Array.isArray(raw) || raw.length === 0) return { error: 'items array is required', items: [] };
    return { error: null, items: raw };
}

const OPERATOR_SUBMIT_OPERATIONS = new Set(['exposed', 'damage', 'follow_up', 'disputed', 'no_response']);

function parseOperatorSubmitJobItems(body, dryRun) {
    const { error, items } = parseItemsArray(body);
    if (error) return { error, jobItems: [] };
    if (items.length !== 1) {
        return { error: 'operator submit jobs require exactly one item', jobItems: [] };
    }
    const it = items[0] || {};
    const ticketNumber = it.ticketNumber != null ? String(it.ticketNumber).trim() : '';
    const text = it.text != null ? String(it.text).trim() : '';
    const authorityIds = Array.isArray(it.authorityIds) ? it.authorityIds : [];
    if (!ticketNumber) return { error: 'ticketNumber is required', jobItems: [] };
    if (!text && !dryRun) return { error: 'text is required', jobItems: [] };
    if (!authorityIds.length && !dryRun) return { error: 'authorityIds is required', jobItems: [] };
    const idempotencyKey = it.idempotencyKey != null ? String(it.idempotencyKey).trim() : null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        return { error: 'invalid idempotencyKey', jobItems: [] };
    }
    const payload: Record<string, unknown> = {
        text: text || (dryRun ? '<enter notification text>' : ''),
        authorityIds,
    };
    if (it.isOperatorFault === true) payload.isOperatorFault = true;
    return {
        error: null,
        jobItems: [
            {
                label: ticketNumber,
                ticketNumber,
                payload,
                idempotencyKey,
            },
        ],
    };
}

export function registerTicketsSubmitJobRoutes(tickets: TicketsApp) {
    /**
     * POST /api/tickets/submit-jobs
     * Body: { organizationId?, operation: create|renew|remark, dryRun?, items?, ticketNumbers?, idempotencyKeys?, password?, autoCloneExhausted? }
     */
    tickets.post('/submit-jobs', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const orgId = parseOrgId(req);
        const operation = req.body.operation != null ? String(req.body.operation).trim() : '';
        const dryRun = req.body.dryRun === true || String(req.body.dryRun || '').trim() === '1';
        if (!['create', 'renew', 'remark', 'amendment', 'clone_new', 'exposed', 'damage', 'follow_up', 'disputed', 'no_response'].includes(operation)) {
            return res.status(400).json({
                error: 'operation must be create, renew, remark, amendment, clone_new, exposed, damage, follow_up, disputed, or no_response',
            });
        }
        if (!(await ticketShared.assertTicketRenewalOrgAdmin(req, db, orgId, res))) return;

        const displayName = await getUserDisplayName(db, req.user.id);
        let jobItems = [];
        let jobOptions: Record<string, unknown> = dryRun ? { dryRun: true } : {};

        if (operation === 'create') {
            const { error, items } = parseItemsArray(req.body);
            if (error) return res.status(400).json({ error });
            if (items.length > ticketShared.RENEW_TICKET_BATCH_MAX) {
                return res.status(400).json({ error: `At most ${ticketShared.RENEW_TICKET_BATCH_MAX} items per job` });
            }
            for (let i = 0; i < items.length; i++) {
                const it = items[i] || {};
                const payload = it.payload;
                const err = validateCreatePayload(payload);
                if (err) return res.status(400).json({ error: `Item ${i + 1}: ${err}` });
                const idempotencyKey = it.idempotencyKey != null ? String(it.idempotencyKey).trim() : null;
                if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
                    return res.status(400).json({ error: `Item ${i + 1}: invalid idempotencyKey` });
                }
                jobItems.push({
                    label: it.label != null ? String(it.label) : `Dig site ${i + 1}`,
                    payload,
                    idempotencyKey,
                });
            }
        } else if (operation === 'renew') {
            const rawList = req.body.ticketNumbers;
            const autoCloneExhausted =
                req.body.autoCloneExhausted !== false && String(req.body.autoCloneExhausted || '').trim() !== '0';
            const password = req.body.password != null ? String(req.body.password) : '';
            const { error, uniq } = ticketShared.parseRenewTicketNumberList(rawList);
            if (error) return res.status(400).json({ error });
            const idempotencyKeys = parseIdempotencyKeysMap(req.body);

            jobOptions = dryRun ? { dryRun: true, autoCloneExhausted } : { autoCloneExhausted };

            if (!dryRun) {
                const passwordCheck = await renewJobNeedsClonePassword(db, orgId, uniq, autoCloneExhausted);
                if (passwordCheck.needsPassword && !password) {
                    return res.status(400).json({
                        error: 'Account password is required to submit new tickets copied from exhausted locates.',
                    });
                }
                if (passwordCheck.needsPassword) {
                    const pwdRow = await getRow(db, 'SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
                    if (!pwdRow || !pwdRow.password_hash) {
                        return res.status(500).json({ error: 'Account password not available' });
                    }
                    if (!verifyPassword(password, pwdRow.password_hash)) {
                        return res.status(403).json({ error: 'Invalid password' });
                    }
                    jobOptions.passwordVerified = true;
                }
            }

            for (const tn of uniq) {
                jobItems.push({
                    label: tn,
                    ticketNumber: tn,
                    idempotencyKey: idempotencyKeys[tn] || null,
                });
            }
        } else if (operation === 'remark') {
            const { error, items } = parseItemsArray(req.body);
            if (error) return res.status(400).json({ error });
            if (items.length < 1) return res.status(400).json({ error: 'remark jobs require at least one item' });
            if (items.length > ticketShared.RENEW_TICKET_BATCH_MAX) {
                return res.status(400).json({ error: `At most ${ticketShared.RENEW_TICKET_BATCH_MAX} remark items per job` });
            }
            for (let i = 0; i < items.length; i++) {
                const it = items[i] || {};
                const ticketNumber = it.ticketNumber != null ? String(it.ticketNumber).trim() : '';
                const text = it.text != null ? String(it.text).trim() : '';
                if (!ticketNumber) return res.status(400).json({ error: `Item ${i + 1}: ticketNumber is required` });
                if (!text && !dryRun) return res.status(400).json({ error: `Item ${i + 1}: Remark text is required` });
                const idempotencyKey = it.idempotencyKey != null ? String(it.idempotencyKey).trim() : null;
                if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
                    return res.status(400).json({ error: `Item ${i + 1}: invalid idempotencyKey` });
                }
                jobItems.push({
                    label: ticketNumber,
                    ticketNumber,
                    payload: { text: text || (dryRun ? '<enter remark>' : '') },
                    idempotencyKey,
                });
            }
        } else if (operation === 'amendment') {
            const { error, items } = parseItemsArray(req.body);
            if (error) return res.status(400).json({ error });
            if (items.length !== 1) return res.status(400).json({ error: 'amendment jobs require exactly one item' });
            const it = items[0] || {};
            const ticketNumber = it.ticketNumber != null ? String(it.ticketNumber).trim() : '';
            const text = it.text != null ? String(it.text).trim() : '';
            if (!ticketNumber) return res.status(400).json({ error: 'ticketNumber is required' });
            if (!text && !dryRun) return res.status(400).json({ error: 'Amendment text is required' });
            const idempotencyKey = it.idempotencyKey != null ? String(it.idempotencyKey).trim() : null;
            if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
                return res.status(400).json({ error: 'invalid idempotencyKey' });
            }
            const fields = it.fields != null && typeof it.fields === 'object' && !Array.isArray(it.fields) ? it.fields : null;
            jobItems.push({
                label: ticketNumber,
                ticketNumber,
                payload: {
                    text: text || (dryRun ? '<enter amendment reason>' : ''),
                    fields: fields || undefined,
                },
                idempotencyKey,
            });
        } else if (operation === 'clone_new') {
            const { error, items } = parseItemsArray(req.body);
            if (error) return res.status(400).json({ error });
            if (items.length !== 1) return res.status(400).json({ error: 'clone_new jobs require exactly one item' });
            const it = items[0] || {};
            const ticketNumber = it.ticketNumber != null ? String(it.ticketNumber).trim() : '';
            if (!ticketNumber) return res.status(400).json({ error: 'ticketNumber is required' });
            const idempotencyKey = it.idempotencyKey != null ? String(it.idempotencyKey).trim() : null;
            if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
                return res.status(400).json({ error: 'invalid idempotencyKey' });
            }

            if (!dryRun) {
                const password = req.body.password != null ? String(req.body.password) : '';
                if (!password) {
                    return res.status(400).json({
                        error: 'Account password is required to create a new ticket copied from this locate.',
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

            jobItems.push({
                label: ticketNumber,
                ticketNumber,
                idempotencyKey,
            });
        } else if (OPERATOR_SUBMIT_OPERATIONS.has(operation)) {
            const parsed = parseOperatorSubmitJobItems(req.body, dryRun);
            if (parsed.error) return res.status(400).json({ error: parsed.error });
            jobItems = parsed.jobItems;
        }

        if (jobItems.length === 0) {
            return res.status(400).json({ error: 'No items to submit' });
        }

        const jobId = await insertSubmitJob(db, {
            orgId,
            userId: req.user.id,
            displayName,
            operation,
            items: jobItems,
            jobOptions,
        });

        await kickSubmitJob(c, db, jobId);

        return res.status(202).json({ ok: true, jobId, dryRun: dryRun || undefined });
    });

    tickets.get('/submit-jobs/failed', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const items = await fetchFailedSubmitItemsForUser(db, req.user.id);
        return res.json({ items });
    });

    tickets.post('/submit-jobs/failures/dismiss', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const raw = req.body && Array.isArray(req.body.items) ? req.body.items : [];
        const entries = raw.map((it) => ({
            jobId: it && it.jobId != null ? String(it.jobId) : '',
            itemIndex: it && it.itemIndex != null ? Number(it.itemIndex) : NaN,
        }));
        const dismissed = await dismissSubmitJobFailures(db, req.user.id, entries);
        return res.json({ ok: true, dismissed });
    });

    tickets.get('/submit-jobs/active', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const qOrg = c.req.query('organizationId');
        const orgId =
            qOrg != null && String(qOrg).trim() !== ''
                ? parseInt(String(qOrg), 10)
                : req.user.organizationId;
        if (!orgId || !Number.isFinite(orgId)) {
            return res.status(400).json({ error: 'organizationId is required' });
        }
        if (!canAccessOrganization(req.user, orgId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        const jobs = await fetchActiveJobsForOrg(db, orgId, req.user.id);
        return res.json({ jobs });
    });

    tickets.get('/submit-jobs/:id', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const jobId = c.req.param('id');
        let job = await fetchJobForClient(db, jobId, req.user.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        if (!canAccessOrganization(req.user, job.organizationId)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (job.status === 'queued' || job.status === 'running') {
            const finalized = await finalizeSettledActiveJob(db, jobId);
            if (finalized) {
                const fresh = await fetchJobForClient(db, jobId, req.user.id);
                if (fresh) job = fresh;
            }
        }
        return res.json({ job });
    });

    tickets.post('/submit-jobs/:id/retry', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const jobId = c.req.param('id');
        const indexes = Array.isArray(req.body.itemIndexes)
            ? req.body.itemIndexes.map((n) => Number(n)).filter((n) => Number.isFinite(n))
            : [];
        const result = await retryFailedSubmitItems(db, req.user.id, jobId, indexes);
        if (result.error) {
            return res.status(result.status || 400).json({ error: result.error });
        }
        await kickSubmitJob(c, db, result.jobId);
        return res.status(202).json({ ok: true, jobId: result.jobId });
    });

    tickets.post('/submit-jobs/:id/resume', async (c) => {
        const req = buildExpressReq(c);
        const res = c.get('expressRes');
        const db = getDatabase();
        const jobId = c.req.param('id');
        const row = await getRow(db, `SELECT * FROM ticket_submit_jobs WHERE id = ?`, [jobId]);
        if (!row) return res.status(404).json({ error: 'Job not found' });
        if (!canAccessOrganization(req.user, row.organization_id)) {
            return res.status(403).json({ error: 'You do not have access to that organization' });
        }
        if (Number(row.submitted_by_user_id) !== Number(req.user.id)) {
            return res.status(403).json({ error: 'You can only resume your own submit jobs' });
        }
        if (await finalizeSettledActiveJob(db, jobId)) {
            return res.json({ ok: true, resumed: false, finalized: true });
        }
        if (String(row.status) === 'running' && isJobStale(row)) {
            const reset = await resetStuckRunningSubmitItems(db, jobId);
            await kickSubmitJob(c, db, jobId);
            return res.json({ ok: true, resumed: true, resetRunningItems: reset.resetCount });
        }
        if (String(row.status) === 'queued') {
            await kickSubmitJob(c, db, jobId);
            return res.json({ ok: true, resumed: true });
        }
        return res.json({ ok: true, resumed: false, status: row.status });
    });
}

async function renewJobNeedsClonePassword(db, orgId, ticketNumbers, autoCloneExhausted) {
    if (!autoCloneExhausted || !ticketNumbers.length) return { needsPassword: false };
    const credErr = await validateNgenPollCanRun(db, orgId);
    if (credErr) return { needsPassword: false };
    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) return { needsPassword: false };
    for (const rawTn of ticketNumbers) {
        try {
            const row = await findFullTicketRowForOrg(db, orgId, rawTn);
            if (!row) continue;
            const ticket = (await buildTicketResponseForClient(db, orgId, row)) as Record<string, unknown>;
            if (ticket.shared) continue;
            const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
            if (jobNum == null || !Number.isFinite(Number(jobNum))) continue;
            let details = null;
            await withNgenAuthRetry(fetch, svc.user, svc.pass, Number(jobNum), async ({ jar, refererApp }) => {
                const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, Number(jobNum));
                details = enquiry && enquiry.enquiryDetails;
            });
            const classified = ticketShared.classifyRenewActionFromEnquiry(details, { autoCloneExhausted: true });
            if (classified.action === 'clone_new') return { needsPassword: true };
        } catch {
            /* skip ticket on preview error */
        }
    }
    return { needsPassword: false };
}
