const { runDb } = require('./db.cjs');

const ERROR_CATALOG = Object.freeze({
    APP_UNEXPECTED: {
        status: 500,
        message: 'Something went wrong. Please try again. If it continues, contact support.',
    },
    APP_BAD_REQUEST: {
        status: 400,
        message: 'We could not complete that request. Please check the information and try again.',
    },
    APP_FORBIDDEN: {
        status: 403,
        message: 'You do not have permission to do that.',
    },
    APP_NOT_FOUND: {
        status: 404,
        message: 'We could not find the requested item.',
    },
    EXTERNAL_SYNC_FAILED: {
        status: 500,
        message: 'External list sync could not be completed. Please try again.',
    },
    EXTERNAL_SYNC_ORG_REQUIRED: {
        status: 400,
        message: 'Please select an organization before running external sync.',
    },
    NGEN_MASTER_ACCOUNT_MISSING: {
        status: 400,
        message: 'No master account in this organization. Please add a master account.',
    },
    NGEN_POLL_CREDENTIALS_MISSING: {
        status: 400,
        message: 'External sync is not ready for this organization. Please check the master account.',
    },
    NGEN_SERVICE_ACCOUNT_MISSING: {
        status: 400,
        message: 'External sync is not configured yet. Please contact support.',
    },
    NGEN_HISTORY_CREDENTIALS_MISSING: {
        status: 400,
        message: 'Ticket history is unavailable right now. Please contact support.',
    },
    PAC_ACCOUNT_LOGIN_FAILED: {
        status: 400,
        message: 'We could not verify this provider account. Please check the account details and try again.',
    },
    CLIENT_JS_ERROR: {
        status: 500,
        message: 'Something went wrong in the app. Please refresh and try again.',
    },
    CLIENT_UNHANDLED_REJECTION: {
        status: 500,
        message: 'Something went wrong in the app. Please refresh and try again.',
    },
    CLIENT_REPORTED: {
        status: 500,
        message: 'Something went wrong in the app. Please refresh and try again.',
    },
});

function catalogEntry(code) {
    return ERROR_CATALOG[code] || ERROR_CATALOG.APP_UNEXPECTED;
}

function createAppError(code, options) {
    const opts = options || {};
    const entry = catalogEntry(code);
    const err = new Error(opts.internalMessage || opts.message || entry.message);
    err.name = 'AppError';
    err.isAppError = true;
    err.code = code;
    err.errorCode = code;
    err.status = opts.status || entry.status || 500;
    err.customerMessage = opts.customerMessage || entry.message;
    err.internalMessage = opts.internalMessage || opts.message || err.message;
    err.detail = opts.detail;
    err.meta = opts.meta;
    if (opts.cause) err.cause = opts.cause;
    return err;
}

function isAppError(err) {
    return !!(err && (err.isAppError || err.errorCode || err.code));
}

function appErrorFromUnknown(err, fallbackCode) {
    if (isAppError(err)) return err;
    return createAppError(fallbackCode || 'APP_UNEXPECTED', {
        internalMessage: err && err.message ? err.message : String(err || 'Unknown error'),
        cause: err,
    });
}

function safeJsonParseMeta(meta) {
    if (meta == null) return null;
    try {
        return JSON.stringify(meta).slice(0, 10000);
    } catch (_) {
        return null;
    }
}

function buildIncidentContext(input) {
    const ctx = input || {};
    const req = ctx.req || {};
    const user = ctx.user || req.user || {};
    return {
        route: ctx.route || ctx.operation || null,
        requestMethod: ctx.requestMethod || req.method || null,
        requestPath: ctx.requestPath || req.path || req.url || null,
        userId: ctx.userId != null ? ctx.userId : user.id != null ? user.id : null,
        organizationId:
            ctx.organizationId != null
                ? ctx.organizationId
                : req.body && req.body.organizationId != null
                  ? req.body.organizationId
                  : user.organizationId != null
                    ? user.organizationId
                    : null,
        status: ctx.status,
        meta: ctx.meta || null,
    };
}

async function logErrorIncident(db, err, context) {
    const appErr = appErrorFromUnknown(err);
    const ctx = buildIncidentContext(context);
    const status = ctx.status || appErr.status || 500;
    const internalMessage =
        appErr.internalMessage ||
        (appErr.cause && appErr.cause.message) ||
        appErr.message ||
        String(appErr);
    const detail =
        appErr.detail ||
        (appErr.cause && appErr.cause.stack) ||
        appErr.stack ||
        null;

    console.error('[app-error]', {
        code: appErr.errorCode || appErr.code,
        status,
        route: ctx.route,
        path: ctx.requestPath,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        internalMessage,
        detail,
    });

    if (!db || appErr.incidentId) return appErr.incidentId || null;

    try {
        const result = await runDb(
            db,
            `INSERT INTO application_error_incidents (
                error_code, customer_message, internal_message, detail, status, route,
                request_method, request_path, user_id, organization_id, meta_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                appErr.errorCode || appErr.code || 'APP_UNEXPECTED',
                appErr.customerMessage || catalogEntry(appErr.errorCode || appErr.code).message,
                internalMessage ? String(internalMessage).slice(0, 4000) : null,
                detail ? String(detail).slice(0, 12000) : null,
                status,
                ctx.route,
                ctx.requestMethod,
                ctx.requestPath,
                ctx.userId,
                ctx.organizationId,
                safeJsonParseMeta(ctx.meta || appErr.meta),
            ]
        );
        appErr.incidentId = result && result.lastID ? result.lastID : null;
        return appErr.incidentId;
    } catch (e) {
        if (!/no such table/i.test(e && e.message ? e.message : '')) {
            console.error('[app-error] incident log failed:', e);
        }
        return null;
    }
}

function errorResponseBody(err) {
    const appErr = appErrorFromUnknown(err);
    const code = appErr.errorCode || appErr.code || 'APP_UNEXPECTED';
    const body = {
        error: appErr.customerMessage || catalogEntry(code).message,
        errorCode: code,
    };
    if (appErr.incidentId) {
        body.supportId = String(appErr.incidentId);
    }
    return body;
}

async function sendAppError(res, db, err, context) {
    const appErr = appErrorFromUnknown(err);
    await logErrorIncident(db, appErr, context);
    return res.status(appErr.status || 500).json(errorResponseBody(appErr));
}

async function honoAppErrorResponse(c, db, err, context) {
    const appErr = appErrorFromUnknown(err);
    await logErrorIncident(db, appErr, context);
    return c.json(errorResponseBody(appErr), appErr.status || 500);
}

module.exports = {
    ERROR_CATALOG,
    createAppError,
    isAppError,
    appErrorFromUnknown,
    logErrorIncident,
    errorResponseBody,
    sendAppError,
    honoAppErrorResponse,
};
