import { getRow, runDb } from './db.cjs';

export const IDEMPOTENCY_TTL_MS = 72 * 60 * 60 * 1000;
export const PENDING_STALE_MS = 10 * 60 * 1000;

const UUID_V4_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateIdempotencyKey(key: unknown): boolean {
    if (key == null) return false;
    const s = String(key).trim();
    return s.length > 0 && s.length <= 64 && UUID_V4_RE.test(s);
}

function headerLookup(headers: Record<string, string> | undefined, name: string): string | null {
    if (!headers || typeof headers !== 'object') return null;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower && v != null && String(v).trim() !== '') {
            return String(v).trim();
        }
    }
    return null;
}

/** Parse Idempotency-Key header or body.idempotencyKey. */
export function parseIdempotencyKey(req: {
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
}): string | null {
    const fromHeader = headerLookup(req.headers, 'Idempotency-Key');
    if (fromHeader) return fromHeader;
    const body = req.body;
    if (body && body.idempotencyKey != null && String(body.idempotencyKey).trim() !== '') {
        return String(body.idempotencyKey).trim();
    }
    return null;
}

/** Bulk renew: optional map ticketNumber → UUID. */
export function parseIdempotencyKeysMap(body: unknown): Record<string, string> {
    const raw =
        body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).idempotencyKeys
            : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [tn, key] of Object.entries(raw)) {
        const ticketNumber = tn != null ? String(tn).trim() : '';
        if (!ticketNumber) continue;
        if (!validateIdempotencyKey(key)) continue;
        out[ticketNumber] = String(key).trim();
    }
    return out;
}

function isExpired(expiresAt: unknown): boolean {
    if (expiresAt == null) return true;
    const t = Date.parse(String(expiresAt));
    return !Number.isFinite(t) || t <= Date.now();
}

function parseStoredBody(responseJson: unknown): unknown {
    if (responseJson == null || String(responseJson).trim() === '') return null;
    try {
        return JSON.parse(String(responseJson));
    } catch {
        return null;
    }
}

function expiresAtIso(): string {
    return new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();
}

function isPendingStale(updatedAt: unknown, staleMs = PENDING_STALE_MS): boolean {
    const t = Date.parse(String(updatedAt || ''));
    if (!Number.isFinite(t)) return true;
    return Date.now() - t > staleMs;
}

/** Force-reclaim stale or any pending rows for the given keys so a job retry can proceed. */
export async function reclaimUsanSubmitIdempotencyPending(
    db: unknown,
    userId: number,
    keys: string[],
    staleMs = PENDING_STALE_MS
): Promise<number> {
    let n = 0;
    for (const raw of keys || []) {
        const key = raw != null ? String(raw).trim() : '';
        if (!key || !validateIdempotencyKey(key)) continue;
        const existing = await getRow(
            db,
            `SELECT id, status, updated_at FROM usan_submit_idempotency
             WHERE user_id = ? AND idempotency_key = ?`,
            [userId, key]
        );
        if (!existing || existing.status !== 'pending') continue;
        if (!isPendingStale(existing.updated_at, staleMs)) continue;
        await runDb(
            db,
            `DELETE FROM usan_submit_idempotency WHERE id = ? AND status = 'pending'`,
            [existing.id]
        );
        n++;
    }
    return n;
}

function isUniqueConstraintError(err: unknown): boolean {
    const msg = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
    return /UNIQUE constraint failed/i.test(msg);
}

export type IdempotencyCtx = {
    db: unknown;
    userId: number;
    orgId: number;
    key: string | null;
    operation: string;
    scopeRef?: string | null;
    dryRun?: boolean;
};

export type IdempotencyExecuteResult = {
    httpStatus: number;
    body: Record<string, unknown>;
    newEnquiryId?: number | null;
};

export type IdempotencyOutcome = {
    replayed: boolean;
    httpStatus: number;
    body: Record<string, unknown>;
};

const IN_PROGRESS_BODY = {
    ok: false,
    error: 'Submit already in progress',
    code: 'IDEMPOTENCY_IN_PROGRESS',
};

/**
 * Claim idempotency key, execute USAN submit once, store outcome, replay on duplicate keys.
 * When key is missing or dryRun, calls executeFn directly without recording.
 */
export async function withUsanSubmitIdempotency(
    ctx: IdempotencyCtx,
    executeFn: () => Promise<IdempotencyExecuteResult>
): Promise<IdempotencyOutcome> {
    const key = ctx.key != null ? String(ctx.key).trim() : '';
    if (!key || ctx.dryRun) {
        const fresh = await executeFn();
        return { replayed: false, httpStatus: fresh.httpStatus, body: fresh.body };
    }

    if (!validateIdempotencyKey(key)) {
        return {
            replayed: false,
            httpStatus: 400,
            body: { error: 'idempotencyKey must be a UUID v4 (max 64 characters)' },
        };
    }

    const expiresAt = expiresAtIso();
    const scopeRef = ctx.scopeRef != null ? String(ctx.scopeRef) : null;

    try {
        await runDb(
            ctx.db,
            `INSERT INTO usan_submit_idempotency
             (user_id, organization_id, idempotency_key, operation, scope_ref, status, expires_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
            [ctx.userId, ctx.orgId, key, ctx.operation, scopeRef, expiresAt]
        );
    } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;

        const existing = await getRow(
            ctx.db,
            `SELECT id, status, http_status, response_json, new_enquiry_id, error_message, expires_at, updated_at
             FROM usan_submit_idempotency
             WHERE user_id = ? AND idempotency_key = ?`,
            [ctx.userId, key]
        );

        if (!existing) {
            return { replayed: false, httpStatus: 409, body: IN_PROGRESS_BODY };
        }

        if (isExpired(existing.expires_at)) {
            await runDb(
                ctx.db,
                `UPDATE usan_submit_idempotency
                 SET organization_id = ?, operation = ?, scope_ref = ?, status = 'pending',
                     http_status = NULL, response_json = NULL, new_enquiry_id = NULL, error_message = NULL,
                     updated_at = CURRENT_TIMESTAMP, expires_at = ?
                 WHERE id = ? AND user_id = ? AND idempotency_key = ?`,
                [ctx.orgId, ctx.operation, scopeRef, expiresAt, existing.id, ctx.userId, key]
            );
        } else if (existing.status === 'pending') {
            if (!isPendingStale(existing.updated_at)) {
                return { replayed: false, httpStatus: 409, body: IN_PROGRESS_BODY };
            }
            await runDb(
                ctx.db,
                `UPDATE usan_submit_idempotency
                 SET updated_at = CURRENT_TIMESTAMP, expires_at = ?
                 WHERE id = ? AND status = 'pending'`,
                [expiresAt, existing.id]
            );
        } else if (existing.status === 'success' || existing.status === 'failed') {
            const body = parseStoredBody(existing.response_json);
            return {
                replayed: true,
                httpStatus: existing.http_status != null ? Number(existing.http_status) : 200,
                body:
                    body && typeof body === 'object' && !Array.isArray(body)
                        ? (body as Record<string, unknown>)
                        : { ok: existing.status === 'success' },
            };
        } else {
            return { replayed: false, httpStatus: 409, body: IN_PROGRESS_BODY };
        }
    }

    try {
        const fresh = await executeFn();
        const status = fresh.httpStatus >= 200 && fresh.httpStatus < 300 ? 'success' : 'failed';
        const responseJson = JSON.stringify(fresh.body);
        const newEnquiryId =
            fresh.newEnquiryId != null
                ? fresh.newEnquiryId
                : fresh.body && fresh.body.newEnquiryId != null
                  ? Number(fresh.body.newEnquiryId)
                  : null;
        const errorMessage =
            status === 'failed' && fresh.body && fresh.body.error != null
                ? String(fresh.body.error)
                : null;

        await runDb(
            ctx.db,
            `UPDATE usan_submit_idempotency
             SET status = ?, http_status = ?, response_json = ?, new_enquiry_id = ?, error_message = ?,
                 updated_at = CURRENT_TIMESTAMP, expires_at = ?
             WHERE user_id = ? AND idempotency_key = ?`,
            [
                status,
                fresh.httpStatus,
                responseJson,
                Number.isFinite(newEnquiryId) ? newEnquiryId : null,
                errorMessage,
                expiresAt,
                ctx.userId,
                key,
            ]
        );

        return { replayed: false, httpStatus: fresh.httpStatus, body: fresh.body };
    } catch (err) {
        const msg = err && typeof err === 'object' && 'message' in err ? String((err as Error).message) : String(err);
        const failBody = { error: msg };
        try {
            await runDb(
                ctx.db,
                `UPDATE usan_submit_idempotency
                 SET status = 'failed', http_status = 500, response_json = ?, error_message = ?,
                     updated_at = CURRENT_TIMESTAMP, expires_at = ?
                 WHERE user_id = ? AND idempotency_key = ? AND status = 'pending'`,
                [JSON.stringify(failBody), msg, expiresAt, ctx.userId, key]
            );
        } catch (updateErr) {
            console.warn('[usanSubmitIdempotency] failed to persist error outcome:', updateErr);
        }
        throw err;
    }
}

/** Send idempotency outcome through express res shim; sets Idempotency-Replayed header when replayed. */
export function sendIdempotencyResponse(
    res: { status: (n: number) => { json: (b: unknown) => unknown }; setHeader?: (k: string, v: string) => void },
    outcome: IdempotencyOutcome
): unknown {
    if (outcome.replayed && typeof res.setHeader === 'function') {
        res.setHeader('Idempotency-Replayed', 'true');
    }
    return res.status(outcome.httpStatus).json(outcome.body);
}
