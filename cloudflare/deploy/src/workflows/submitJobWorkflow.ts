import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { getDatabase, runWithDb } from '../database.js';
import { runWithWorkerContext } from '../envContext.js';
import {
    finalizeSubmitJob,
    logSubmitJob,
    prepareSubmitJob,
    processSubmitJobItemByIndex,
} from '../lib/submitJobProcessor.js';

export type SubmitJobWorkflowParams = {
    jobId: string;
};

/**
 * Durable paced USAN submit: one Workflow step per dig site / ticket item.
 * Avoids Cloudflare waitUntil ~30s wall limit after 202 responses.
 *
 * Step names must stay stable (`prepare` / `item-${index}` / `finalize`) so
 * in-flight instances survive deploys. Put descriptive detail in logs only.
 */
export class SubmitJobWorkflow extends WorkflowEntrypoint<Env, SubmitJobWorkflowParams> {
    async run(event: WorkflowEvent<SubmitJobWorkflowParams>, step: WorkflowStep) {
        const jobId = event.payload && event.payload.jobId != null ? String(event.payload.jobId) : '';
        if (!jobId) {
            logSubmitJob('workflow_abort', { reason: 'missing_jobId' });
            return { ok: false, error: 'missing jobId' };
        }

        logSubmitJob('workflow_run_start', {
            jobId,
            instanceId: event.instanceId != null ? String(event.instanceId) : null,
        });

        const prep = await step.do('prepare', async () => {
            return runWithWorkerContext(this.env, () =>
                runWithDb(this.env.DB, async () => {
                    const db = getDatabase();
                    return prepareSubmitJob(jobId, db);
                })
            );
        });

        if (prep.done) {
            // Items can already be finished while the job row is still "running"
            // (previous run died before finalize). Closing here is what lets the indicator stop.
            if (prep.skipReason === 'no_pending_items') {
                await step.do('finalize', async () => {
                    return runWithWorkerContext(this.env, () =>
                        runWithDb(this.env.DB, async () => {
                            const db = getDatabase();
                            await finalizeSubmitJob(jobId, db);
                            return { ok: true, reconciled: true };
                        })
                    );
                });
            }
            logSubmitJob('workflow_run_skip', {
                jobId,
                operation: prep.operation || null,
                organizationId: prep.organizationId ?? null,
                dryRun: !!prep.dryRun,
                skipReason: prep.skipReason || (prep.dryRun ? 'dry_run' : 'done'),
                totalCount: prep.totalCount ?? null,
                finalizedSettled: prep.skipReason === 'no_pending_items',
            });
            return {
                ok: true,
                jobId,
                skipped: true,
                dryRun: !!prep.dryRun,
                operation: prep.operation || null,
                skipReason: prep.skipReason || null,
            };
        }

        const operation = prep.operation || 'unknown';
        type PendingItemMeta = { itemIndex: number; ticketNumber: string | null; label: string | null };
        const pendingItems = (Array.isArray(prep.pendingItems) ? prep.pendingItems : []) as PendingItemMeta[];
        const pendingByIndex = new Map(pendingItems.map((it) => [Number(it.itemIndex), it] as const));

        for (const itemIndex of prep.pendingIndexes || []) {
            const meta = pendingByIndex.get(Number(itemIndex));
            logSubmitJob('workflow_item_step', {
                jobId,
                operation,
                organizationId: prep.organizationId ?? null,
                itemIndex: Number(itemIndex),
                ticketNumber: (meta && (meta.ticketNumber || meta.label)) || null,
                stepName: `item-${itemIndex}`,
            });

            await step.do(
                `item-${itemIndex}`,
                {
                    retries: { limit: 0, delay: '5 seconds' },
                    timeout: '15 minutes',
                },
                async () => {
                    return runWithWorkerContext(this.env, () =>
                        runWithDb(this.env.DB, async () => {
                            const db = getDatabase();
                            return processSubmitJobItemByIndex(jobId, itemIndex, db);
                        })
                    );
                }
            );
        }

        await step.do('finalize', async () => {
            return runWithWorkerContext(this.env, () =>
                runWithDb(this.env.DB, async () => {
                    const db = getDatabase();
                    await finalizeSubmitJob(jobId, db);
                    return { ok: true };
                })
            );
        });

        logSubmitJob('workflow_run_complete', {
            jobId,
            operation,
            organizationId: prep.organizationId ?? null,
            itemCount: (prep.pendingIndexes || []).length,
            totalCount: prep.totalCount ?? null,
        });

        return {
            ok: true,
            jobId,
            operation,
            itemCount: (prep.pendingIndexes || []).length,
        };
    }
}
