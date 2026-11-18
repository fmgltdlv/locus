/**
 * Reports uncaught client errors to POST /api/client-errors (application_error_incidents).
 * Loaded after config.js and auth.js. Never throws; avoids reporting its own failures.
 */
(function initClientErrorReporter(global) {
    const REPORT_PATH = '/client-errors';
    const CLIENT_MAX_PER_MINUTE = 25;
    const DEDUPE_MS = 60 * 1000;
    const recentKeys = new Map();
    let windowStart = Date.now();
    let windowCount = 0;
    let reporting = false;

    function getApiBase() {
        if (typeof global.normalizeApiBase === 'function' && global.API_BASE) {
            return global.normalizeApiBase(global.API_BASE);
        }
        if (global.API_BASE) return String(global.API_BASE).replace(/\/+$/, '');
        return '';
    }

    function getAuthToken() {
        if (global.authModule && typeof global.authModule.getAuthToken === 'function') {
            const t = global.authModule.getAuthToken();
            if (t) return t;
        }
        try {
            return localStorage.getItem('authToken');
        } catch (_) {
            return null;
        }
    }

    function clip(value, max) {
        if (value == null) return '';
        const s = String(value);
        return s.length > max ? s.slice(0, max) : s;
    }

    function shouldIgnoreMessage(message, filename) {
        const msg = String(message || '');
        const file = String(filename || '');
        if (/ResizeObserver loop/i.test(msg)) return true;
        if (/Loading chunk [\d]+ failed/i.test(msg)) return true;
        if (/ChunkLoadError/i.test(msg)) return true;
        if (file && /^(chrome|moz|safari)-extension:\/\//i.test(file)) return true;
        return false;
    }

    function dedupeKey(payload) {
        return [payload.errorCode, payload.message, payload.filename, payload.line, payload.column].join('|');
    }

    function pruneDedupe(now) {
        for (const [key, ts] of recentKeys) {
            if (now - ts > DEDUPE_MS) recentKeys.delete(key);
        }
    }

    function allowClientSend(now) {
        if (now - windowStart >= 60 * 1000) {
            windowStart = now;
            windowCount = 0;
        }
        if (windowCount >= CLIENT_MAX_PER_MINUTE) return false;
        windowCount += 1;
        return true;
    }

    function buildPayload(fields) {
        return {
            errorCode: fields.errorCode || 'CLIENT_REPORTED',
            message: clip(fields.message, 4000),
            stack: clip(fields.stack, 12000) || null,
            source: clip(fields.source, 120) || 'client',
            pageUrl: clip(global.location && global.location.href, 2000) || null,
            filename: clip(fields.filename, 500) || null,
            line: fields.line != null && Number.isFinite(Number(fields.line)) ? Number(fields.line) : null,
            column: fields.column != null && Number.isFinite(Number(fields.column)) ? Number(fields.column) : null,
            userAgent: clip(global.navigator && global.navigator.userAgent, 500) || null,
            meta: fields.meta && typeof fields.meta === 'object' ? fields.meta : null,
        };
    }

    function sendReport(payload) {
        if (reporting) return;
        const apiBase = getApiBase();
        if (!apiBase) return;
        if (global.navigator && global.navigator.onLine === false) return;

        const now = Date.now();
        pruneDedupe(now);
        const key = dedupeKey(payload);
        if (recentKeys.has(key)) return;
        if (!allowClientSend(now)) return;

        recentKeys.set(key, now);
        reporting = true;

        const url = apiBase + (REPORT_PATH.startsWith('/') ? REPORT_PATH : '/' + REPORT_PATH);
        const headers = { 'Content-Type': 'application/json' };
        const token = getAuthToken();
        if (token) headers.Authorization = 'Bearer ' + token;

        const body = JSON.stringify(payload);
        const done = function () {
            reporting = false;
        };

        try {
            if (global.navigator && typeof global.navigator.sendBeacon === 'function') {
                const blob = new Blob([body], { type: 'application/json' });
                if (global.navigator.sendBeacon(url, blob)) {
                    done();
                    return;
                }
            }
        } catch (_) {
            /* fall through to fetch */
        }

        try {
            void fetch(url, { method: 'POST', headers: headers, body: body, keepalive: true, credentials: 'omit' })
                .catch(function () {})
                .finally(done);
        } catch (_) {
            done();
        }
    }

    function reportClientError(err, context) {
        try {
            const ctx = context && typeof context === 'object' ? context : {};
            const message =
                (err && err.message) ||
                (typeof err === 'string' ? err : '') ||
                'Client error';
            const stack = err && err.stack ? String(err.stack) : null;
            if (shouldIgnoreMessage(message, ctx.filename)) return;
            sendReport(
                buildPayload({
                    errorCode: ctx.errorCode || 'CLIENT_REPORTED',
                    message: message,
                    stack: stack,
                    source: ctx.source || 'manual',
                    filename: ctx.filename,
                    line: ctx.line,
                    column: ctx.column,
                    meta: ctx.meta,
                })
            );
        } catch (_) {
            /* never throw from reporter */
        }
    }

    global.addEventListener(
        'error',
        function (event) {
            try {
                const msg = event.message || (event.error && event.error.message) || 'Script error';
                const filename = event.filename || (event.error && event.error.fileName) || '';
                if (shouldIgnoreMessage(msg, filename)) return;
                sendReport(
                    buildPayload({
                        errorCode: 'CLIENT_JS_ERROR',
                        message: msg,
                        stack: event.error && event.error.stack ? String(event.error.stack) : null,
                        source: 'window.onerror',
                        filename: filename,
                        line: event.lineno,
                        column: event.colno,
                    })
                );
            } catch (_) {
                /* ignore */
            }
        },
        true
    );

    global.addEventListener('unhandledrejection', function (event) {
        try {
            const reason = event.reason;
            const message =
                (reason && reason.message) ||
                (typeof reason === 'string' ? reason : '') ||
                'Unhandled promise rejection';
            const stack = reason && reason.stack ? String(reason.stack) : null;
            if (shouldIgnoreMessage(message, '')) return;
            sendReport(
                buildPayload({
                    errorCode: 'CLIENT_UNHANDLED_REJECTION',
                    message: message,
                    stack: stack,
                    source: 'unhandledrejection',
                })
            );
        } catch (_) {
            /* ignore */
        }
    });

    global.clientErrorReporter = {
        reportClientError: reportClientError,
    };
})(typeof window !== 'undefined' ? window : globalThis);
