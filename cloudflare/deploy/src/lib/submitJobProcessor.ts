import { getRow, allRows, runDb } from '../lib/db.cjs';
import { verifyPassword } from '../auth.js';
import { getNgenCredentialsForPoll, validateNgenPollCanRun } from '../lib/pacPollNgenCredentials.cjs';
import { pacwebEstablishSession } from '../lib/pacwebClient.cjs';
import { createAppError } from '../lib/appErrors.cjs';
import { withNgenAuthRetry, fetchEnquirySearch } from '../lib/ngenClient.cjs';
import {
    buildRenewalPayload,
    fetchComputedDateValuesForRenewal,
    submitRenewalEnquiryPaced,
    truthyRenewalFlag,
} from '../lib/ngenRenewal.cjs';
import {
    buildClonedNewTicketFromEnquiry,
    fetchComputedDatesForCloneNewFromEnquiry,
    submitRejectedHttpResult,
    submitRejectedStepResult,
    truthyRemarkFlag,
} from '../lib/ngenNewTicket.cjs';
import { fetchComputedDateValuesForRemark, buildRemarkPayload, submitRemarkEnquiryPaced } from '../lib/ngenRemark.cjs';
import {
    fetchComputedDateValuesForAmendment,
    buildAmendmentPayload,
    submitAmendmentEnquiryPaced,
    truthyAmendmentFlag,
} from '../lib/ngenAmendment.cjs';
import {
    buildOperatorSubmitPayload,
    fetchComputedDateValuesForOperatorSubmit,
    getOperatorSubmitConfig,
    submitOperatorSubmitEnquiryPaced,
    truthyCanBeFlag,
    validateAuthorityIds,
} from '../lib/ngenOperatorSubmit.cjs';
import { validateCommencementDateTime, commencesPayloadToYmdHm, ticketTypeFromPurposeId } from '../lib/ticketCommencementDates.cjs';
import { validateIdempotencyKey, withUsanSubmitIdempotency, reclaimUsanSubmitIdempotencyPending } from '../lib/usanSubmitIdempotency.js';
import { buildTicketResponseForClient, findFullTicketRowForOrg } from '../routes/ticketRowHelpers.js';
import { resolveNgenJobNumberForTicket } from '../routes/tickets/refresh.js';
import * as ticketShared from '../routes/tickets/shared.js';

export const JOB_STALE_MS = 90_000;
/** Failed/completed submit jobs retained for Needs attention + audit. */
export const JOB_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
/** Align idempotency pending reclaim with job stale window (not 10 min). */
export const SUBMIT_ITEM_IDEMPOTENCY_RECLAIM_MS = JOB_STALE_MS;
/** Matches live USAN submit pacing (NGEN_SUBMIT_MIN_GAP_MS) so dry runs feel realistic. */
export const DRY_RUN_STEP_MS = 11_000;

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed']);

function nowIso() {
    return new Date().toISOString();
}

function sleepMs(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function safeJsonParse(text) {
    if (text == null || String(text).trim() === '') return null;
    try {
        return JSON.parse(String(text));
    } catch {
        return null;
    }
}

/** Structured Workers Observability logs for submit jobs (no secrets). */
export function logSubmitJob(event, fields = {}) {
    try {
        console.log(
            JSON.stringify({
                scope: 'submitJob',
                event: String(event || ''),
                ts: nowIso(),
                ...fields,
            })
        );
    } catch {
        console.log('[submitJob]', event, fields);
    }
}

function itemLogLabel(it) {
    if (!it) return null;
    const tn = it.ticket_number != null && String(it.ticket_number).trim() !== '' ? String(it.ticket_number) : null;
    const label = it.label != null && String(it.label).trim() !== '' ? String(it.label) : null;
    return tn || label || null;
}

function summarizePendingItems(items) {
    return (items || [])
        .filter((it) => it.status === 'pending')
        .map((it) => ({
            itemIndex: Number(it.item_index),
            ticketNumber: it.ticket_number != null ? String(it.ticket_number) : null,
            label: it.label != null ? String(it.label) : null,
        }));
}

function generateJobId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
}

export async function getUserDisplayName(db, userId) {
    const row = await getRow(
        db,
        `SELECT COALESCE(NULLIF(TRIM(full_name), ''), username, email) AS display_name FROM users WHERE id = ?`,
        [userId]
    );
    return row && row.display_name ? String(row.display_name) : 'User';
}

export function validateCreatePayload(payload) {
    if (!payload || typeof payload !== 'object') return 'payload object is required';
    const payloadStr = JSON.stringify(payload);
    if (payloadStr.length > 120000) return 'payload is too large';
    if (String(payload.ticketCreationMethod) !== 'New') return 'payload.ticketCreationMethod must be New';
    if (Number(payload.clonedFromEnquiryID) !== 0) return 'payload.clonedFromEnquiryID must be 0 for wizard create';
    if (!payload.spatialObjectNativeDescription || !payload.activityId || !payload.categoryId) {
        return 'payload missing required spatial/work fields';
    }
    if (!payload.principalContactName || !payload.principalContactMobile) {
        return 'payload missing principal contact fields';
    }
    if (!payload.commencesOnDate || !payload.commencesOnTime) {
        return 'payload missing commencesOnDate or commencesOnTime';
    }
    const commencesYmdHm = commencesPayloadToYmdHm(payload.commencesOnDate, payload.commencesOnTime);
    if (!commencesYmdHm) return 'payload commencesOnDate or commencesOnTime is invalid';
    const ticketType = ticketTypeFromPurposeId(payload.purposeId);
    const commenceValidation = validateCommencementDateTime(
        commencesYmdHm.ymd,
        commencesYmdHm.hm,
        undefined,
        ticketType
    );
    if (!commenceValidation.ok) {
        return commenceValidation.message || 'Invalid planned work start date/time';
    }
    const nearestCrossStreet =
        payload.nearestCrossStreet != null ? String(payload.nearestCrossStreet).trim() : '';
    if (
        !nearestCrossStreet ||
        !/^[A-Za-z0-9 .'-]+$/.test(nearestCrossStreet) ||
        !/[A-Za-z]/.test(nearestCrossStreet)
    ) {
        return 'payload.nearestCrossStreet is required and must not contain special characters';
    }
    return null;
}

async function touchJob(db, jobId, patch) {
    const fields = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = ?`);
        vals.push(v);
    }
    fields.push('updated_at = ?');
    vals.push(nowIso());
    vals.push(jobId);
    await runDb(db, `UPDATE ticket_submit_jobs SET ${fields.join(', ')} WHERE id = ?`, vals);
}

async function touchItem(db, itemId, patch) {
    const fields = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = ?`);
        vals.push(v);
    }
    fields.push('updated_at = ?');
    vals.push(nowIso());
    vals.push(itemId);
    await runDb(db, `UPDATE ticket_submit_job_items SET ${fields.join(', ')} WHERE id = ?`, vals);
}

async function loadJobBundle(db, jobId) {
    const job = await getRow(db, `SELECT * FROM ticket_submit_jobs WHERE id = ?`, [jobId]);
    if (!job) return null;
    const items = await allRows(
        db,
        `SELECT * FROM ticket_submit_job_items WHERE job_id = ? ORDER BY item_index ASC`,
        [jobId]
    );
    return { job, items: items || [] };
}

function itemCounts(items) {
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const it of items) {
        const st = String(it.status || '');
        if (st === 'succeeded') {
            completed++;
            succeeded++;
        } else if (st === 'failed' || st === 'skipped') {
            completed++;
            failed++;
        }
    }
    return { completed, succeeded, failed };
}

function deriveJobStatus(items) {
    const pending = items.some((it) => it.status === 'pending' || it.status === 'running');
    if (pending) return 'running';
    const { succeeded, failed } = itemCounts(items);
    if (succeeded > 0 && failed === 0) return 'completed';
    if (succeeded > 0 && failed > 0) return 'partial';
    return 'failed';
}

/** True when every item has a terminal status. Empty jobs are not settled (insert may still be writing rows). */
export function submitJobItemsAreSettled(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return false;
    return !list.some((it) => {
        const st = String((it && it.status) || '');
        return st === 'pending' || st === 'running';
    });
}

export function serializeJobForClient(job, items, currentUserId) {
    const total = Number(job.total_count) || items.length;
    const counts = itemCounts(items);
    const remaining = Math.max(0, total - counts.completed);
    const isOwn = currentUserId != null && Number(job.submitted_by_user_id) === Number(currentUserId);
    const jobOptions = safeJsonParse(job.job_options_json) || {};
    return {
        jobId: job.id,
        organizationId: job.organization_id,
        submittedByUserId: job.submitted_by_user_id,
        submittedByDisplayName: job.submitted_by_display_name || '',
        operation: job.operation,
        status: job.status,
        dryRun: jobOptions.dryRun === true,
        total,
        completed: counts.completed,
        succeeded: counts.succeeded,
        failed: counts.failed,
        remaining,
        isOwn,
        summary: safeJsonParse(job.summary_json),
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        finishedAt: job.finished_at,
        items: items.map((it) => ({
            itemIndex: it.item_index,
            label: it.label || '',
            ticketNumber: it.ticket_number || null,
            operationDetail: it.operation_detail || null,
            status: it.status,
            errorMessage: it.error_message || null,
            result: safeJsonParse(it.result_json),
        })),
    };
}

async function failAllPendingSubmitItems(db, jobId, items, errorMessage) {
    for (const it of items) {
        if (it.status === 'pending') {
            await touchItem(db, it.id, {
                status: 'failed',
                error_message: errorMessage,
            });
        }
    }
    await finalizeJob(db, jobId);
}

/**
 * Validate org master credentials and decrypt password (shared by live submit + dry-run).
 * @returns {Promise<{ svc: { user: string, pass: string } } | { error: string }>}
 */
export async function resolveOrgNgenCredentialsForJob(db, orgId) {
    try {
        const credErr = await validateNgenPollCanRun(db, orgId);
        if (credErr) {
            return { error: (credErr as any).message || 'Credentials not configured' };
        }
        const svc = await getNgenCredentialsForPoll(db, orgId);
        if (!svc || !svc.user || !svc.pass) {
            return { error: 'No nGen master credentials configured for this organization.' };
        }
        return { svc };
    } catch (e) {
        return {
            error: e && (e as Error).message ? String((e as Error).message) : 'Unable to decrypt stored ngen password',
        };
    }
}

/**
 * Dry-run only: verify decrypted credentials can establish a PAC session (no submit).
 */
export async function verifyDryRunNgenLogin(svc) {
    try {
        await pacwebEstablishSession(globalThis.fetch, { username: svc.user, password: svc.pass });
    } catch (e) {
        const loginErr = createAppError('PAC_ACCOUNT_LOGIN_FAILED', {
            internalMessage: e && (e as Error).message ? String((e as Error).message) : String(e),
            cause: e,
        });
        return { error: loginErr.customerMessage || loginErr.message };
    }
    return { ok: true };
}

async function finalizeJob(db, jobId) {
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) return;
    const { job, items } = bundle;
    const status = deriveJobStatus(items);
    const counts = itemCounts(items);
    const summary = {
        total: Number(job.total_count) || items.length,
        succeeded: counts.succeeded,
        failed: counts.failed,
        failures: items
            .filter((it) => it.status === 'failed' || it.status === 'skipped')
            .map((it) => ({
                label: it.label || it.ticket_number || '',
                ticketNumber: it.ticket_number || null,
                error: it.error_message || 'failed',
            })),
    };
    await touchJob(db, jobId, {
        status,
        completed_count: counts.completed,
        succeeded_count: counts.succeeded,
        failed_count: counts.failed,
        summary_json: JSON.stringify(summary),
        finished_at: nowIso(),
    });
    logSubmitJob('job_finalize', {
        jobId,
        operation: job.operation,
        organizationId: Number(job.organization_id) || null,
        status,
        total: summary.total,
        succeeded: summary.succeeded,
        failed: summary.failed,
        failureLabels: summary.failures.map((f) => f.ticketNumber || f.label).filter(Boolean).slice(0, 20),
    });
}

/** Reset crash-stranded item rows and reclaim stale idempotency pending keys. */
export async function resetStuckRunningSubmitItems(db, jobId) {
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) return { resetCount: 0 };
    const { job, items } = bundle;
    const running = items.filter((it) => String(it.status) === 'running');
    if (!running.length) return { resetCount: 0 };
    const keys = [];
    for (const it of running) {
        await touchItem(db, it.id, { status: 'pending', error_message: null });
        if (it.idempotency_key) keys.push(String(it.idempotency_key));
    }
    const userId = Number(job.submitted_by_user_id);
    if (keys.length && Number.isFinite(userId)) {
        await reclaimUsanSubmitIdempotencyPending(db, userId, keys, SUBMIT_ITEM_IDEMPOTENCY_RECLAIM_MS);
    }
    return { resetCount: running.length };
}

export async function finalizeSubmitJob(jobId, dbIn) {
    const db = dbIn || getDb();
    await finalizeJob(db, jobId);
}

/**
 * If USAN already recorded a result but the item row is still open, copy that result onto the item.
 * Covers a crash after the submit committed and before the item status was saved.
 */
async function promoteOpenItemsFromIdempotency(db, job, items) {
    const userId = Number(job && job.submitted_by_user_id);
    if (!Number.isFinite(userId)) return;
    for (const it of items || []) {
        const st = String(it && it.status ? it.status : '');
        if (st !== 'pending' && st !== 'running') continue;
        const key = it.idempotency_key != null ? String(it.idempotency_key).trim() : '';
        if (!key) continue;
        try {
            const existing = await getRow(
                db,
                `SELECT status, response_json, error_message FROM usan_submit_idempotency
                 WHERE user_id = ? AND idempotency_key = ?`,
                [userId, key]
            );
            if (!existing) continue;
            const idemStatus = String(existing.status || '');
            if (idemStatus !== 'success' && idemStatus !== 'failed') continue;
            const resultJson =
                existing.response_json != null && String(existing.response_json).trim() !== ''
                    ? String(existing.response_json)
                    : null;
            if (idemStatus === 'success') {
                await touchItem(db, it.id, {
                    status: 'succeeded',
                    error_message: null,
                    result_json: resultJson,
                });
                it.status = 'succeeded';
                it.error_message = null;
                it.result_json = resultJson;
            } else {
                const errorMessage =
                    existing.error_message != null && String(existing.error_message).trim() !== ''
                        ? String(existing.error_message)
                        : 'Submit failed';
                await touchItem(db, it.id, {
                    status: 'failed',
                    error_message: errorMessage,
                    result_json: resultJson,
                });
                it.status = 'failed';
                it.error_message = errorMessage;
                it.result_json = resultJson;
            }
            logSubmitJob('item_reconcile_idempotency', {
                jobId: job.id,
                itemIndex: it.item_index,
                ticketNumber: itemLogLabel(it),
                itemStatus: it.status,
            });
        } catch (e) {
            console.warn('[submitJobProcessor] promote idempotency item', job && job.id, e);
        }
    }
}

/**
 * Close a queued/running job whose items are already finished.
 * The activity indicator stays busy while the job row is still active, even after USAN accepted the tickets.
 * @returns {Promise<boolean>} true when this call finalized the job
 */
async function maybeFinalizeSettledJob(db, job, items) {
    if (!job || !ACTIVE_STATUSES.has(String(job.status))) return false;
    const list = items || [];
    await promoteOpenItemsFromIdempotency(db, job, list);
    if (!submitJobItemsAreSettled(list)) return false;
    await finalizeJob(db, job.id);
    logSubmitJob('job_reconcile_settled', {
        jobId: job.id,
        previousStatus: String(job.status),
        itemCount: list.length,
    });
    return true;
}

/** Load a job and finalize it when every item is already done. Safe to call on each status poll. */
export async function finalizeSettledActiveJob(db, jobId) {
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) return false;
    return maybeFinalizeSettledJob(db, bundle.job, bundle.items);
}

/**
 * Prepare job for processing; returns pending item indexes (after resetting stranded running).
 * @returns {Promise<{
 *   jobId: string,
 *   dryRun: boolean,
 *   pendingIndexes: number[],
 *   done: boolean,
 *   operation?: string|null,
 *   organizationId?: number|null,
 *   totalCount?: number,
 *   skipReason?: string|null,
 *   pendingItems?: Array<{ itemIndex: number, ticketNumber: string|null, label: string|null }>
 * }>}
 */
export async function prepareSubmitJob(jobId, dbIn) {
    const db = dbIn || getDb();
    const reset = await resetStuckRunningSubmitItems(db, jobId);
    if (reset && reset.resetCount > 0) {
        logSubmitJob('job_reset_stuck_items', { jobId, resetCount: reset.resetCount });
    }
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) {
        logSubmitJob('job_prepare_skip', { jobId, skipReason: 'missing_job' });
        return {
            jobId,
            dryRun: false,
            pendingIndexes: [],
            done: true,
            operation: null,
            organizationId: null,
            totalCount: 0,
            skipReason: 'missing_job',
            pendingItems: [],
        };
    }
    const { job, items } = bundle;
    const orgId = Number(job.organization_id);
    const operation = job.operation != null ? String(job.operation) : null;
    const totalCount = Number(job.total_count) || items.length;
    if (TERMINAL_STATUSES.has(String(job.status))) {
        logSubmitJob('job_prepare_skip', {
            jobId,
            operation,
            organizationId: orgId,
            skipReason: 'already_terminal',
            jobStatus: job.status,
            totalCount,
        });
        return {
            jobId,
            dryRun: false,
            pendingIndexes: [],
            done: true,
            operation,
            organizationId: orgId,
            totalCount,
            skipReason: 'already_terminal',
            pendingItems: [],
        };
    }
    await touchJob(db, jobId, { status: 'running' });
    const jobOptions = safeJsonParse(job.job_options_json) || {};
    const dryRun = jobOptions.dryRun === true;

    const creds = await resolveOrgNgenCredentialsForJob(db, orgId);
    if (creds.error) {
        logSubmitJob('job_prepare_fail', {
            jobId,
            operation,
            organizationId: orgId,
            dryRun,
            skipReason: 'credentials',
            error: creds.error,
            totalCount,
        });
        await failAllPendingSubmitItems(db, jobId, items, creds.error);
        return {
            jobId,
            dryRun,
            pendingIndexes: [],
            done: true,
            operation,
            organizationId: orgId,
            totalCount,
            skipReason: 'credentials',
            pendingItems: [],
        };
    }

    if (dryRun) {
        const login = await verifyDryRunNgenLogin(creds.svc);
        if (login.error) {
            logSubmitJob('job_prepare_fail', {
                jobId,
                operation,
                organizationId: orgId,
                dryRun: true,
                skipReason: 'dry_run_login',
                error: login.error,
                totalCount,
            });
            await failAllPendingSubmitItems(db, jobId, items, login.error);
            return {
                jobId,
                dryRun: true,
                pendingIndexes: [],
                done: true,
                operation,
                organizationId: orgId,
                totalCount,
                skipReason: 'dry_run_login',
                pendingItems: [],
            };
        }
        logSubmitJob('job_dry_run_start', {
            jobId,
            operation,
            organizationId: orgId,
            totalCount,
            itemCount: items.length,
        });
        await processDryRunJob(jobId, db, job, items, { credentialsOk: true, loginOk: true });
        logSubmitJob('job_dry_run_done', {
            jobId,
            operation,
            organizationId: orgId,
            totalCount,
        });
        return {
            jobId,
            dryRun: true,
            pendingIndexes: [],
            done: true,
            operation,
            organizationId: orgId,
            totalCount,
            skipReason: 'dry_run_complete',
            pendingItems: [],
        };
    }

    const pendingItems = summarizePendingItems(items);
    const pendingIndexes = pendingItems.map((it) => it.itemIndex);
    logSubmitJob('job_prepare', {
        jobId,
        operation,
        organizationId: orgId,
        dryRun: false,
        totalCount,
        pendingCount: pendingIndexes.length,
        pendingTickets: pendingItems.map((it) => it.ticketNumber || it.label).filter(Boolean).slice(0, 30),
        done: pendingIndexes.length === 0,
    });
    return {
        jobId,
        dryRun: false,
        pendingIndexes,
        done: pendingIndexes.length === 0,
        operation,
        organizationId: orgId,
        totalCount,
        skipReason: pendingIndexes.length === 0 ? 'no_pending_items' : null,
        pendingItems,
    };
}

async function buildRenewPlanCache(db, job, items, svc) {
    const jobOptions = safeJsonParse(job.job_options_json) || {};
    const autoCloneExhausted = jobOptions.autoCloneExhausted !== false;
    const orgId = Number(job.organization_id);
    const planCache = {};
    if (job.operation !== 'renew') return planCache;
    for (const it of items) {
        if (it.status !== 'pending') continue;
        const rawTn = it.ticket_number || '';
        let plan = await getRenewPlan(db, orgId, rawTn, autoCloneExhausted);
        if (!plan.skipReason) {
            plan = await enrichRenewPlanWithEnquiry(db, orgId, plan, svc, { autoCloneExhausted });
            if (plan.action === 'clone_new' && !autoCloneExhausted) {
                plan.action = 'skip';
                plan.skipReason = ticketShared.formatRenewSkipReason('auto_clone_disabled');
            }
        }
        planCache[rawTn] = plan;
        await touchItem(db, it.id, {
            label: rawTn,
            operation_detail: plan.action,
        });
    }
    return planCache;
}

/** Process a single pending item by index (Workflow step). Idempotent if already terminal. */
export async function processSubmitJobItemByIndex(jobId, itemIndex, dbIn) {
    const db = dbIn || getDb();
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) {
        logSubmitJob('item_skip', { jobId, itemIndex, reason: 'missing_job' });
        return { ok: false, reason: 'missing_job' };
    }
    const { job, items } = bundle;
    const operation = job.operation != null ? String(job.operation) : null;
    const organizationId = Number(job.organization_id) || null;
    if (TERMINAL_STATUSES.has(String(job.status))) {
        logSubmitJob('item_skip', {
            jobId,
            itemIndex,
            operation,
            organizationId,
            reason: 'job_already_terminal',
            jobStatus: job.status,
        });
        return { ok: true, skipped: true, reason: 'job_already_terminal' };
    }
    const it = items.find((row) => Number(row.item_index) === Number(itemIndex));
    if (!it) {
        logSubmitJob('item_skip', { jobId, itemIndex, operation, organizationId, reason: 'missing_item' });
        return { ok: false, reason: 'missing_item' };
    }
    const ticketLabel = itemLogLabel(it);
    if (String(it.status) !== 'pending') {
        logSubmitJob('item_skip', {
            jobId,
            itemIndex,
            operation,
            organizationId,
            ticketNumber: ticketLabel,
            reason: 'item_not_pending',
            itemStatus: it.status,
        });
        return { ok: true, skipped: true, reason: 'item_not_pending', ticketNumber: ticketLabel };
    }

    const orgId = Number(job.organization_id);
    const userId = Number(job.submitted_by_user_id);
    logSubmitJob('item_start', {
        jobId,
        itemIndex: Number(itemIndex),
        operation,
        organizationId: orgId,
        ticketNumber: ticketLabel,
        userId: Number.isFinite(userId) ? userId : null,
    });

    const svc = await getNgenCredentialsForPoll(db, orgId);
    if (!svc || !svc.user || !svc.pass) {
        await touchItem(db, it.id, {
            status: 'failed',
            error_message: 'No nGen master credentials configured for this organization.',
        });
        logSubmitJob('item_fail', {
            jobId,
            itemIndex: Number(itemIndex),
            operation,
            organizationId: orgId,
            ticketNumber: ticketLabel,
            reason: 'no_credentials',
        });
        return { ok: false, reason: 'no_credentials', ticketNumber: ticketLabel };
    }

    let planCache = {};
    if (job.operation === 'renew') {
        planCache = await buildRenewPlanCache(db, job, [it], svc);
    }

    if (job.operation === 'create') {
        await executeCreateItem(db, orgId, userId, it, svc);
    } else if (job.operation === 'renew') {
        await executeRenewItem(db, orgId, userId, it, svc, planCache);
    } else if (job.operation === 'remark') {
        await executeRemarkItem(db, orgId, userId, it, svc);
    } else if (job.operation === 'amendment') {
        await executeAmendmentItem(db, orgId, userId, it, svc);
    } else if (job.operation === 'clone_new') {
        await executeCloneNewFromTicketItem(db, orgId, userId, it, svc);
    } else if (
        job.operation === 'exposed' ||
        job.operation === 'damage' ||
        job.operation === 'follow_up' ||
        job.operation === 'disputed' ||
        job.operation === 'no_response'
    ) {
        await executeOperatorSubmitItem(db, orgId, userId, it, svc, job.operation);
    } else {
        await touchItem(db, it.id, { status: 'failed', error_message: `Unknown operation: ${job.operation}` });
    }

    const freshBundle = await loadJobBundle(db, jobId);
    const freshItems = freshBundle?.items || [];
    const freshItem = freshItems.find((row) => Number(row.item_index) === Number(itemIndex));
    const counts = itemCounts(freshItems);
    await touchJob(db, jobId, {
        completed_count: counts.completed,
        succeeded_count: counts.succeeded,
        failed_count: counts.failed,
    });
    const itemStatus = freshItem ? String(freshItem.status) : 'unknown';
    logSubmitJob('item_done', {
        jobId,
        itemIndex: Number(itemIndex),
        operation,
        organizationId: orgId,
        ticketNumber: itemLogLabel(freshItem) || ticketLabel,
        itemStatus,
        operationDetail: freshItem && freshItem.operation_detail != null ? String(freshItem.operation_detail) : null,
        errorMessage:
            freshItem && (itemStatus === 'failed' || itemStatus === 'skipped')
                ? freshItem.error_message || null
                : null,
        jobProgress: {
            completed: counts.completed,
            succeeded: counts.succeeded,
            failed: counts.failed,
            total: Number(job.total_count) || freshItems.length,
        },
    });
    return {
        ok: true,
        itemIndex: Number(itemIndex),
        ticketNumber: itemLogLabel(freshItem) || ticketLabel,
        itemStatus,
    };
}

export async function processSubmitJob(jobId, dbIn) {
    const db = dbIn || getDb();
    const prep = await prepareSubmitJob(jobId, db);
    if (prep.done) {
        if (!prep.dryRun) {
            const bundle = await loadJobBundle(db, jobId);
            if (bundle && !TERMINAL_STATUSES.has(String(bundle.job.status))) {
                await finalizeJob(db, jobId);
            }
        }
        return;
    }
    for (const itemIndex of prep.pendingIndexes) {
        await processSubmitJobItemByIndex(jobId, itemIndex, db);
    }
    await finalizeJob(db, jobId);
}

let _dbRef = null;
function getDb() {
    if (!_dbRef) throw new Error('submitJobProcessor: database not bound');
    return _dbRef;
}

export function bindSubmitJobDb(db) {
    _dbRef = db;
}

type WorkflowBinding = {
    create: (opts: { id?: string; params?: { jobId: string } }) => Promise<{ id: string; restart?: () => Promise<unknown> }>;
    get: (id: string) => Promise<{ id: string; restart: () => Promise<unknown>; status: () => Promise<{ status: string }> }>;
};

/**
 * Start durable Workflow processing when binding is present; else fall back to waitUntil.
 * @param {object} opts
 * @param {WorkflowBinding|null|undefined} opts.workflow
 * @param {{ waitUntil?: (p: Promise<unknown>) => void }|null|undefined} opts.ctx
 * @param {*} opts.db
 * @param {string} opts.jobId
 */
export async function scheduleSubmitJobProcessing(opts) {
    const workflow = opts && opts.workflow;
    const ctx = opts && opts.ctx;
    const db = opts && opts.db;
    const jobId = opts && opts.jobId;
    if (!jobId) return;

    if (workflow && typeof workflow.create === 'function') {
        try {
            await workflow.create({ id: String(jobId), params: { jobId: String(jobId) } });
            logSubmitJob('workflow_create', { jobId, instanceId: String(jobId) });
            return;
        } catch (e) {
            const msg = e && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e);
            if (/already|exists|in use/i.test(msg)) {
                try {
                    const inst = await workflow.get(String(jobId));
                    if (inst && typeof inst.restart === 'function') {
                        await inst.restart();
                        logSubmitJob('workflow_restart', { jobId, instanceId: String(jobId) });
                        return;
                    }
                } catch (restartErr) {
                    console.warn('[submitJobProcessor] workflow restart failed', jobId, restartErr);
                    logSubmitJob('workflow_restart_failed', {
                        jobId,
                        error:
                            restartErr && (restartErr as Error).message
                                ? String((restartErr as Error).message)
                                : String(restartErr),
                    });
                }
                try {
                    const resumeId = `${jobId}-r-${Date.now()}`;
                    await workflow.create({ id: resumeId, params: { jobId: String(jobId) } });
                    logSubmitJob('workflow_create_resume', { jobId, instanceId: resumeId });
                    return;
                } catch (create2Err) {
                    console.error('[submitJobProcessor] workflow create resume failed', jobId, create2Err);
                    logSubmitJob('workflow_create_resume_failed', {
                        jobId,
                        error:
                            create2Err && (create2Err as Error).message
                                ? String((create2Err as Error).message)
                                : String(create2Err),
                    });
                }
            } else {
                console.error('[submitJobProcessor] workflow create failed', jobId, e);
                logSubmitJob('workflow_create_failed', { jobId, error: msg });
            }
        }
    }

    logSubmitJob('workflow_fallback_waituntil', { jobId });
    const task = processSubmitJob(jobId, db).catch((e) => {
        console.error('[submitJobProcessor]', jobId, e);
        logSubmitJob('job_process_error', {
            jobId,
            error: e && (e as Error).message ? String((e as Error).message) : String(e),
        });
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(task);
    } else {
        void task;
    }
}

export function isJobStale(job) {
    if (!job || String(job.status) !== 'running') return false;
    const t = Date.parse(String(job.updated_at || ''));
    if (!Number.isFinite(t)) return true;
    return Date.now() - t > JOB_STALE_MS;
}

export async function purgeOldSubmitJobs(db) {
    const cutoff = new Date(Date.now() - JOB_RETENTION_MS).toISOString();
    await runDb(
        db,
        `DELETE FROM ticket_submit_job_item_dismissals
         WHERE job_id IN (
           SELECT id FROM ticket_submit_jobs
           WHERE status IN ('completed', 'partial', 'failed') AND finished_at IS NOT NULL AND finished_at < ?
         )`,
        [cutoff]
    );
    await runDb(
        db,
        `DELETE FROM ticket_submit_jobs WHERE status IN ('completed', 'partial', 'failed') AND finished_at IS NOT NULL AND finished_at < ?`,
        [cutoff]
    );
}

export async function insertSubmitJob(db, opts) {
    const {
        orgId,
        userId,
        displayName,
        operation,
        items,
        jobOptions,
    } = opts;
    const jobId = generateJobId();
    const ts = nowIso();
    await runDb(
        db,
        `INSERT INTO ticket_submit_jobs (
            id, organization_id, submitted_by_user_id, submitted_by_display_name,
            operation, status, total_count, job_options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        [
            jobId,
            orgId,
            userId,
            displayName || 'User',
            operation,
            items.length,
            jobOptions ? JSON.stringify(jobOptions) : null,
            ts,
            ts,
        ]
    );
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await runDb(
            db,
            `INSERT INTO ticket_submit_job_items (
                job_id, item_index, label, ticket_number, idempotency_key, payload_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                jobId,
                i,
                it.label != null ? String(it.label) : '',
                it.ticketNumber != null ? String(it.ticketNumber) : null,
                it.idempotencyKey != null ? String(it.idempotencyKey) : null,
                it.payload != null ? JSON.stringify(it.payload) : null,
                ts,
                ts,
            ]
        );
    }
    return jobId;
}

export async function fetchJobForClient(db, jobId, currentUserId) {
    const bundle = await loadJobBundle(db, jobId);
    if (!bundle) return null;
    return serializeJobForClient(bundle.job, bundle.items, currentUserId);
}

export async function fetchActiveJobsForOrg(db, orgId, currentUserId) {
    await purgeOldSubmitJobs(db);
    const rows = await allRows(
        db,
        `SELECT * FROM ticket_submit_jobs
         WHERE organization_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at ASC`,
        [orgId]
    );
    const out = [];
    for (const job of rows || []) {
        const items = await allRows(
            db,
            `SELECT * FROM ticket_submit_job_items WHERE job_id = ? ORDER BY item_index ASC`,
            [job.id]
        );
        const list = items || [];
        const finalized = await maybeFinalizeSettledJob(db, job, list);
        if (finalized) continue;
        out.push(serializeJobForClient(job, list, currentUserId));
    }
    return out;
}

function mapPreviewFromPayload(operation, payload, ticketNumber) {
    if (operation === 'create' || operation === 'clone_new') {
        const wkt =
            payload && payload.spatialObjectNativeDescription != null
                ? String(payload.spatialObjectNativeDescription)
                : null;
        return { kind: 'wkt', wkt, ticketNumber: ticketNumber || null };
    }
    return { kind: 'ticket', ticketNumber: ticketNumber || null, wkt: null };
}

/** Own-user failed/skipped items within retention, excluding dismissals. */
export async function fetchFailedSubmitItemsForUser(db, userId) {
    await purgeOldSubmitJobs(db);
    const cutoff = new Date(Date.now() - JOB_RETENTION_MS).toISOString();
    const rows = await allRows(
        db,
        `SELECT j.id AS job_id, j.organization_id, j.operation, j.created_at AS job_created_at,
                j.finished_at, j.job_options_json,
                i.id AS item_id, i.item_index, i.label, i.ticket_number, i.status,
                i.error_message, i.payload_json, i.result_json
         FROM ticket_submit_job_items i
         INNER JOIN ticket_submit_jobs j ON j.id = i.job_id
         WHERE j.submitted_by_user_id = ?
           AND i.status IN ('failed', 'skipped')
           AND j.status IN ('completed', 'partial', 'failed')
           AND j.finished_at IS NOT NULL
           AND j.finished_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM ticket_submit_job_item_dismissals d
             WHERE d.user_id = ? AND d.job_id = j.id AND d.item_index = i.item_index
           )
         ORDER BY j.finished_at DESC, i.item_index ASC
         LIMIT 100`,
        [userId, cutoff, userId]
    );
    return (rows || []).map((row) => {
        const payload = safeJsonParse(row.payload_json);
        const jobOptions = safeJsonParse(row.job_options_json) || {};
        return {
            jobId: row.job_id,
            organizationId: row.organization_id,
            operation: row.operation,
            dryRun: jobOptions.dryRun === true,
            itemIndex: row.item_index,
            itemId: row.item_id,
            label: row.label || '',
            ticketNumber: row.ticket_number || null,
            status: row.status,
            errorMessage: row.error_message || null,
            finishedAt: row.finished_at,
            mapPreview: mapPreviewFromPayload(row.operation, payload, row.ticket_number),
            payload: row.operation === 'create' || row.operation === 'clone_new' ? payload : null,
        };
    });
}

export async function dismissSubmitJobFailures(db, userId, entries) {
    const ts = nowIso();
    let n = 0;
    for (const ent of entries || []) {
        const jobId = ent.jobId != null ? String(ent.jobId) : '';
        const itemIndex = Number(ent.itemIndex);
        if (!jobId || !Number.isFinite(itemIndex)) continue;
        const job = await getRow(
            db,
            `SELECT id FROM ticket_submit_jobs WHERE id = ? AND submitted_by_user_id = ?`,
            [jobId, userId]
        );
        if (!job) continue;
        try {
            await runDb(
                db,
                `INSERT INTO ticket_submit_job_item_dismissals (user_id, job_id, item_index, dismissed_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, job_id, item_index) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
                [userId, jobId, itemIndex, ts]
            );
            n++;
        } catch (e) {
            console.warn('[dismissSubmitJobFailures]', jobId, itemIndex, e);
        }
    }
    return n;
}

/**
 * Retry selected failed items as a new job (own user). Returns new jobId.
 */
export async function retryFailedSubmitItems(db, userId, sourceJobId, itemIndexes) {
    const bundle = await loadJobBundle(db, sourceJobId);
    if (!bundle) return { error: 'Job not found', status: 404 };
    const { job, items } = bundle;
    if (Number(job.submitted_by_user_id) !== Number(userId)) {
        return { error: 'You can only retry your own submit jobs', status: 403 };
    }
    const want = new Set((itemIndexes || []).map((n) => Number(n)));
    const selected = items.filter(
        (it) => want.has(Number(it.item_index)) && (it.status === 'failed' || it.status === 'skipped')
    );
    if (!selected.length) return { error: 'No matching failed items to retry', status: 400 };

    const jobOptions = safeJsonParse(job.job_options_json) || {};
    if (jobOptions.dryRun === true) {
        return { error: 'Cannot retry dry-run jobs', status: 400 };
    }

    const newItems = selected.map((it) => {
        const payload = safeJsonParse(it.payload_json);
        const newKey =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `retry-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        return {
            label: it.label || '',
            ticketNumber: it.ticket_number || null,
            payload,
            idempotencyKey: newKey,
        };
    });

    const newJobId = await insertSubmitJob(db, {
        orgId: job.organization_id,
        userId,
        displayName: job.submitted_by_display_name || 'User',
        operation: job.operation,
        items: newItems,
        jobOptions: jobOptions.dryRun ? { ...jobOptions, dryRun: false } : jobOptions,
    });

    await dismissSubmitJobFailures(
        db,
        userId,
        selected.map((it) => ({ jobId: sourceJobId, itemIndex: it.item_index }))
    );

    return { jobId: newJobId, status: 202 };
}


async function getRenewPlan(db, orgId, rawTn, autoCloneExhausted) {
    const plan = {
        ticketNumber: rawTn,
        action: 'skip',
        skipReason: null,
        jobKey: null,
        enquiry: null,
        label: rawTn,
    };
    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        plan.skipReason = ticketShared.formatRenewSkipReason('ticket_not_found');
        return plan;
    }
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) {
        plan.skipReason = ticketShared.formatRenewSkipReason('shared_ticket');
        return plan;
    }
    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        plan.skipReason = ticketShared.formatRenewSkipReason('no_job_number');
        return plan;
    }
    plan.jobKey = Number(jobNum);
    return plan;
}

async function enrichRenewPlanWithEnquiry(db, orgId, plan, svc, options) {
    if (plan.action === 'skip' && plan.skipReason) return plan;
    let details = null;
    await withNgenAuthRetry(fetch, svc.user, svc.pass, plan.jobKey, async ({ jar, refererApp }) => {
        const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, plan.jobKey);
        plan.enquiry = enquiry;
        details = enquiry && enquiry.enquiryDetails;
    });
    const classified = ticketShared.classifyRenewActionFromEnquiry(details, options);
    plan.action = classified.action;
    plan.skipReason = classified.skipReason ? ticketShared.formatRenewSkipReason(classified.skipReason) : null;
    return plan;
}

async function executeCreateItem(db, orgId, userId, item, svc) {
    const payload = safeJsonParse(item.payload_json);
    const err = validateCreatePayload(payload);
    if (err) {
        await touchItem(db, item.id, { status: 'failed', error_message: err });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Invalid idempotency key' });
        return;
    }
    try {
        const runSubmit = async () => {
            const submitRes = await withNgenAuthRetry(fetch, svc.user, svc.pass, null, async ({ jar }) =>
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
        };
        let resultBody;
        if (idempotencyKey) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation: 'create',
                    scopeRef: null,
                    dryRun: false,
                },
                runSubmit
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            if (idem.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit failed',
                    result_json: JSON.stringify(idem.body || {}),
                });
                return;
            }
            resultBody = idem.body;
        } else {
            const direct = await runSubmit();
            if (direct.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message:
                        (direct.body && 'error' in direct.body ? direct.body.error : null) || 'Submit failed',
                    result_json: JSON.stringify(direct.body || {}),
                });
                return;
            }
            resultBody = direct.body;
        }
        await touchItem(db, item.id, {
            status: 'succeeded',
            result_json: JSON.stringify(resultBody || {}),
        });
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

async function executeRenewItem(db, orgId, userId, item, svc, planCache) {
    const rawTn = item.ticket_number || '';
    const plan = planCache[rawTn];
    if (!plan || plan.action === 'skip') {
        await touchItem(db, item.id, {
            status: 'skipped',
            error_message: plan?.skipReason || ticketShared.formatRenewSkipReason('skipped'),
            operation_detail: 'skip',
        });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    await touchItem(db, item.id, { operation_detail: plan.action });
    const runRenewPipeline = async () => {
        const jobKey = plan.jobKey;
        return withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
            const enquiry = plan.enquiry || (await fetchEnquirySearch(fetch, jar, refererApp, jobKey));
            const details = enquiry && enquiry.enquiryDetails;
            if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
            if (plan.action === 'clone_new') {
                const computedRes = await fetchComputedDatesForCloneNewFromEnquiry(fetch, jar, details);
                if (!computedRes.ok) {
                    return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                }
                const computedDates = computedRes.data || {};
                const clonePayload = buildClonedNewTicketFromEnquiry(enquiry, { computedDates });
                const submitRes = await submitRenewalEnquiryPaced(fetch, jar, clonePayload);
                const { parsed, rejected } = submitRejectedStepResult(
                    submitRes,
                    'Clone-new submit rejected or incomplete response'
                );
                if (rejected) return rejected;
                return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId, actionTaken: 'clone_new' };
            }
            if (!truthyRenewalFlag(details.canBeRenewal)) {
                return { step: 'canBeRenewal', ok: false, message: 'Upstream canBeRenewal is false' };
            }
            const computedRes = await fetchComputedDateValuesForRenewal(fetch, jar, details);
            if (!computedRes.ok) {
                return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
            }
            const payload = buildRenewalPayload(enquiry, computedRes.data || {}, jobKey);
            const submitRes = await submitRenewalEnquiryPaced(fetch, jar, payload);
            const { parsed, rejected } = submitRejectedStepResult(
                submitRes,
                'Submit rejected or incomplete response'
            );
            if (rejected) return rejected;
            return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId, actionTaken: 'renew' };
        });
    };
    try {
        let pipelineResult;
        if (idempotencyKey && validateIdempotencyKey(idempotencyKey)) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation: plan.action === 'clone_new' ? 'clone_new' : 'renew',
                    scopeRef: rawTn,
                    dryRun: false,
                },
                async () => {
                    const pr = (await runRenewPipeline()) as any;
                    const rateLimited = !pr.ok && pr.message && String(pr.message).includes('rate limit');
                    const rowOut = pr.ok
                        ? {
                              ticketNumber: rawTn,
                              ok: true,
                              actionTaken: pr.actionTaken || plan.action,
                              newEnquiryId: pr.newEnquiryId,
                          }
                        : {
                              ticketNumber: rawTn,
                              ok: false,
                              error: pr.message || pr.step || 'failed',
                          };
                    return {
                        httpStatus: pr.ok ? 200 : rateLimited ? 429 : 502,
                        body: rowOut,
                        newEnquiryId: pr.newEnquiryId,
                    };
                }
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            pipelineResult = idem.body;
        } else {
            const pr = (await runRenewPipeline()) as any;
            pipelineResult = pr.ok
                ? {
                      ticketNumber: rawTn,
                      ok: true,
                      actionTaken: pr.actionTaken || plan.action,
                      newEnquiryId: pr.newEnquiryId,
                  }
                : { ticketNumber: rawTn, ok: false, error: pr.message || pr.step || 'failed' };
        }
        if (pipelineResult.ok) {
            await touchItem(db, item.id, {
                status: 'succeeded',
                operation_detail: pipelineResult.actionTaken || plan.action,
                result_json: JSON.stringify(pipelineResult),
            });
        } else {
            await touchItem(db, item.id, {
                status: 'failed',
                error_message: pipelineResult.error || 'failed',
                result_json: JSON.stringify(pipelineResult),
            });
        }
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

async function executeRemarkItem(db, orgId, userId, item, svc) {
    const rawTn = item.ticket_number || '';
    const payload = safeJsonParse(item.payload_json) || {};
    const text = payload.text != null ? String(payload.text).trim() : '';
    if (!rawTn) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'ticketNumber is required' });
        return;
    }
    if (!text) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Remark text is required' });
        return;
    }
    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Ticket not found' });
        return;
    }
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Cannot remark on a shared ticket view.' });
        return;
    }
    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'No nGen job number for this ticket.' });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Invalid idempotency key' });
        return;
    }
    const ngenSubmitPacing = { lastSubmitAt: 0 };
    try {
        const runRemark = async () => {
            const jobKey = Number(jobNum);
            const pipelineResult = (await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
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
                const remarkPayload = buildRemarkPayload(enquiry, computedRes.data || {}, jobKey, text);
                if (
                    !Array.isArray(remarkPayload.manuallySelectedUtiliiesFromPreviousTicket) ||
                    remarkPayload.manuallySelectedUtiliiesFromPreviousTicket.length === 0
                ) {
                    return {
                        step: 'utilities',
                        ok: false,
                        message:
                            'No utility operators found on this ticket to retransmit the remark to.',
                    };
                }
                const submitRes = await submitRemarkEnquiryPaced(fetch, jar, remarkPayload, ngenSubmitPacing);
                const { parsed, rejected } = submitRejectedStepResult(
                    submitRes,
                    'Remark submit rejected or incomplete response'
                );
                if (rejected) return rejected;
                return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
            })) as any;
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
            return {
                httpStatus: 200,
                body: { ok: true, newEnquiryId: pipelineResult.newEnquiryId },
                newEnquiryId: pipelineResult.newEnquiryId,
            };
        };
        let resultBody;
        if (idempotencyKey) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation: 'remark',
                    scopeRef: rawTn,
                    dryRun: false,
                },
                runRemark
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            if (idem.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Remark failed',
                    result_json: JSON.stringify(idem.body || {}),
                });
                return;
            }
            resultBody = idem.body;
        } else {
            const direct = await runRemark();
            if (direct.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: direct.body?.error || 'Remark failed',
                    result_json: JSON.stringify(direct.body || {}),
                });
                return;
            }
            resultBody = direct.body;
        }
        await touchItem(db, item.id, {
            status: 'succeeded',
            result_json: JSON.stringify(resultBody || {}),
        });
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

async function executeAmendmentItem(db, orgId, userId, item, svc) {
    const rawTn = item.ticket_number || '';
    const payload = safeJsonParse(item.payload_json) || {};
    const text = payload.text != null ? String(payload.text).trim() : '';
    const fieldOverrides =
        payload.fields != null && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
            ? payload.fields
            : null;
    if (!rawTn) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'ticketNumber is required' });
        return;
    }
    if (!text) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Amendment text is required' });
        return;
    }
    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Ticket not found' });
        return;
    }
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Cannot amend on a shared ticket view.' });
        return;
    }
    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'No nGen job number for this ticket.' });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Invalid idempotency key' });
        return;
    }
    const ngenSubmitPacing = { lastSubmitAt: 0 };
    try {
        const runAmendment = async () => {
            const jobKey = Number(jobNum);
            const pipelineResult = (await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
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
                const amendmentPayload = buildAmendmentPayload(
                    enquiry,
                    computedRes.data || {},
                    jobKey,
                    text,
                    fieldOverrides
                );
                const submitRes = await submitAmendmentEnquiryPaced(fetch, jar, amendmentPayload, ngenSubmitPacing);
                const { parsed, rejected } = submitRejectedStepResult(
                    submitRes,
                    'Amendment submit rejected or incomplete response'
                );
                if (rejected) return rejected;
                return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
            })) as any;
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
            return {
                httpStatus: 200,
                body: { ok: true, newEnquiryId: pipelineResult.newEnquiryId },
                newEnquiryId: pipelineResult.newEnquiryId,
            };
        };
        let resultBody;
        if (idempotencyKey) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation: 'amendment',
                    scopeRef: rawTn,
                    dryRun: false,
                },
                runAmendment
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            if (idem.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Amendment failed',
                    result_json: JSON.stringify(idem.body || {}),
                });
                return;
            }
            resultBody = idem.body;
        } else {
            const direct = await runAmendment();
            if (direct.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: direct.body?.error || 'Amendment failed',
                    result_json: JSON.stringify(direct.body || {}),
                });
                return;
            }
            resultBody = direct.body;
        }
        await touchItem(db, item.id, {
            status: 'succeeded',
            result_json: JSON.stringify(resultBody || {}),
        });
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

async function executeOperatorSubmitItem(db, orgId, userId, item, svc, operation) {
    const config = getOperatorSubmitConfig(operation);
    if (!config) {
        await touchItem(db, item.id, { status: 'failed', error_message: `Unknown operation: ${operation}` });
        return;
    }
    const rawTn = item.ticket_number || '';
    const payload = safeJsonParse(item.payload_json) || {};
    const text = payload.text != null ? String(payload.text).trim() : '';
    const authorityIds = Array.isArray(payload.authorityIds) ? payload.authorityIds : [];
    const isOperatorFault = payload.isOperatorFault === true;
    if (!rawTn) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'ticketNumber is required' });
        return;
    }
    if (!text) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Notification text is required' });
        return;
    }
    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Ticket not found' });
        return;
    }
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Cannot submit on a shared ticket view.' });
        return;
    }
    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'No nGen job number for this ticket.' });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Invalid idempotency key' });
        return;
    }
    const ngenSubmitPacing = { lastSubmitAt: 0 };
    try {
        const runSubmit = async () => {
            const jobKey = Number(jobNum);
            const pipelineResult = (await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                const details = enquiry && enquiry.enquiryDetails;
                if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                if (!truthyCanBeFlag(details, config.canBeFlag)) {
                    return {
                        step: config.canBeFlag,
                        ok: false,
                        message: `Upstream ${config.canBeFlag} is false`,
                    };
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
                const submitRes = await submitOperatorSubmitEnquiryPaced(fetch, jar, submitPayload, ngenSubmitPacing);
                const { parsed, rejected } = submitRejectedStepResult(
                    submitRes,
                    'Operator submit rejected or incomplete response'
                );
                if (rejected) return rejected;
                return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
            })) as any;
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
            return {
                httpStatus: 200,
                body: { ok: true, newEnquiryId: pipelineResult.newEnquiryId },
                newEnquiryId: pipelineResult.newEnquiryId,
            };
        };
        let resultBody;
        if (idempotencyKey) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation,
                    scopeRef: rawTn,
                    dryRun: false,
                },
                runSubmit
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            if (idem.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Operator submit failed',
                    result_json: JSON.stringify(idem.body || {}),
                });
                return;
            }
            resultBody = idem.body;
        } else {
            const direct = await runSubmit();
            if (direct.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: direct.body?.error || 'Operator submit failed',
                    result_json: JSON.stringify(direct.body || {}),
                });
                return;
            }
            resultBody = direct.body;
        }
        await touchItem(db, item.id, {
            status: 'succeeded',
            result_json: JSON.stringify(resultBody || {}),
        });
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

/**
 * Remark unavailable upstream: submit a NEW ticket copied from this locate.
 * Refuses when the ticket can be remarked, amended, or renewed instead.
 */
async function executeCloneNewFromTicketItem(db, orgId, userId, item, svc) {
    const rawTn = item.ticket_number || '';
    if (!rawTn) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'ticketNumber is required' });
        return;
    }
    const row = await findFullTicketRowForOrg(db, orgId, rawTn);
    if (!row) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Ticket not found' });
        return;
    }
    const ticket = await buildTicketResponseForClient(db, orgId, row);
    if ((ticket as any).shared) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Cannot create a new ticket from a shared ticket view.' });
        return;
    }
    const jobNum = await resolveNgenJobNumberForTicket(db, orgId, row.ticket_number, ticket);
    if (jobNum == null || !Number.isFinite(Number(jobNum))) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'No nGen job number for this ticket.' });
        return;
    }
    const idempotencyKey = item.idempotency_key || null;
    if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        await touchItem(db, item.id, { status: 'failed', error_message: 'Invalid idempotency key' });
        return;
    }
    try {
        const runCloneNew = async () => {
            const jobKey = Number(jobNum);
            const pipelineResult = (await withNgenAuthRetry(fetch, svc.user, svc.pass, jobKey, async ({ jar, refererApp }) => {
                const enquiry = await fetchEnquirySearch(fetch, jar, refererApp, jobKey);
                const details = enquiry && enquiry.enquiryDetails;
                if (!details) return { step: 'enquiry', ok: false, message: 'No enquiryDetails from nGen' };
                if (truthyRemarkFlag(details.canBeRemark)) {
                    return { step: 'canBeRemark', ok: false, message: 'This ticket can be remarked — submit a remark instead.' };
                }
                if (truthyAmendmentFlag(details.canBeAmended)) {
                    return { step: 'canBeAmended', ok: false, message: 'This ticket can be amended — submit an amendment instead.' };
                }
                if (truthyRenewalFlag(details.canBeRenewal)) {
                    return { step: 'canBeRenewal', ok: false, message: 'This ticket can be renewed — use Renew instead.' };
                }
                const computedRes = await fetchComputedDatesForCloneNewFromEnquiry(fetch, jar, details);
                if (!computedRes.ok) {
                    return { step: 'computed_dates', ok: false, message: `computed dates HTTP ${computedRes.status}` };
                }
                const computedDates = computedRes.data || {};
                const clonePayload = buildClonedNewTicketFromEnquiry(enquiry, { computedDates });
                const submitRes = await submitRenewalEnquiryPaced(fetch, jar, clonePayload);
                const { parsed, rejected } = submitRejectedStepResult(
                    submitRes,
                    'New ticket submit rejected or incomplete response'
                );
                if (rejected) return rejected;
                return { step: 'submit', ok: true, newEnquiryId: parsed.newEnquiryId };
            })) as any;
            if (!pipelineResult.ok) {
                const rateLimited =
                    pipelineResult.message && String(pipelineResult.message).includes('rate limit');
                return {
                    httpStatus: rateLimited ? 429 : 502,
                    body: {
                        ok: false,
                        error: pipelineResult.message || pipelineResult.step || 'clone_new_failed',
                        usan: pipelineResult.failureLog || null,
                    },
                };
            }
            return {
                httpStatus: 200,
                body: { ok: true, newEnquiryId: pipelineResult.newEnquiryId },
                newEnquiryId: pipelineResult.newEnquiryId,
            };
        };
        let resultBody;
        if (idempotencyKey) {
            const idem = await withUsanSubmitIdempotency(
                {
                    db,
                    userId,
                    orgId,
                    key: idempotencyKey,
                    operation: 'clone_new',
                    scopeRef: rawTn,
                    dryRun: false,
                },
                runCloneNew
            );
            if (idem.httpStatus === 409) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'Submit already in progress',
                });
                return;
            }
            if (idem.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: idem.body?.error || 'New ticket submit failed',
                    result_json: JSON.stringify(idem.body || {}),
                });
                return;
            }
            resultBody = idem.body;
        } else {
            const direct = await runCloneNew();
            if (direct.httpStatus >= 400) {
                await touchItem(db, item.id, {
                    status: 'failed',
                    error_message: direct.body?.error || 'New ticket submit failed',
                    result_json: JSON.stringify(direct.body || {}),
                });
                return;
            }
            resultBody = direct.body;
        }
        await touchItem(db, item.id, {
            status: 'succeeded',
            result_json: JSON.stringify(resultBody || {}),
        });
    } catch (e) {
        await touchItem(db, item.id, {
            status: 'failed',
            error_message: e && e.message ? String(e.message) : String(e),
        });
    }
}

async function processDryRunJob(jobId, db, job, items, dryRunMeta = {}) {
    const pending = items.filter((it) => it.status === 'pending');
    const total = pending.length;
    const failIx = total > 1 ? 1 : -1;
    let itemNum = 0;
    for (const it of pending) {
        const ix = itemNum;
        itemNum++;
        await touchItem(db, it.id, { operation_detail: 'dry_run' });
        await sleepMs(Math.round(DRY_RUN_STEP_MS * 0.15));
        await sleepMs(Math.round(DRY_RUN_STEP_MS * 0.85));
        if (ix === failIx) {
            await touchItem(db, it.id, {
                status: 'failed',
                error_message: 'Simulated failure (dry run only).',
                result_json: JSON.stringify({ ok: false, dryRun: true, code: 'DRY_RUN_FAIL' }),
            });
        } else {
            await touchItem(db, it.id, {
                status: 'succeeded',
                result_json: JSON.stringify({ ok: true, dryRun: true, ...dryRunMeta }),
            });
        }
        const freshItems = (await loadJobBundle(db, jobId))?.items || [];
        const counts = itemCounts(freshItems);
        await touchJob(db, jobId, {
            completed_count: counts.completed,
            succeeded_count: counts.succeeded,
            failed_count: counts.failed,
        });
    }
    await finalizeJob(db, jobId);
}


export { generateJobId };
