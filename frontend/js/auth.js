// Authentication module - Backend integration
// Note: API_BASE is defined in config.js; normalizeApiBase collapses // in paths (cached bad URLs).
function getApiBase() {
    const raw = window.API_BASE;
    if (!raw) {
        throw new Error('API_BASE is not configured. Set window.API_BASE_URL in config-override.js.');
    }
    return typeof window.normalizeApiBase === "function" ? window.normalizeApiBase(raw) : raw;
}

// Origin for media/file URLs (no /api) - used by pdfEditor, photos, documents
function getApiBaseForMedia() {
    const base = getApiBase();
    return base.replace(/\/api\/?$/, '');
}

// Headers for authenticated fetch (e.g. FormData uploads where Content-Type must be omitted)
function getAuthHeaders() {
    const token = authToken || localStorage.getItem('authToken');
    return token ? { 'Authorization': 'Bearer ' + token } : {};
}

let currentUser = null;
let authToken = null;
let activeOrganizationId = null;

function decorateApiError(message, data) {
    const error = new Error(message || 'Request failed');
    if (data && typeof data === 'object') {
        if (data.errorCode) error.errorCode = String(data.errorCode);
        if (data.code) error.code = String(data.code);
        if (data.jobNameKey) error.jobNameKey = String(data.jobNameKey);
        if (data.supportId) error.supportId = String(data.supportId);
    }
    error.displayMessage =
        error.message +
        (error.errorCode ? ` (Code: ${error.errorCode}${error.supportId ? `, Support ID: ${error.supportId}` : ''})` : '');
    return error;
}

function getFriendlyErrorMessage(error) {
    if (!error) return 'Something went wrong. Please try again.';
    return error.displayMessage || error.message || String(error);
}

// Initialize auth from localStorage
function initAuth() {
    authToken = localStorage.getItem('authToken');
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
        currentUser = JSON.parse(userStr);
    }
}

// Login
async function login(email, password) {
    try {
        const response = await fetch(`${getApiBase()}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email: String(email || '').trim().toLowerCase(), password })
        });

        if (!response.ok) {
            const text = await response.text();
            let msg = response.status + " " + response.statusText;
            let errData = null;
            try {
                errData = JSON.parse(text);
                if (errData && errData.error) msg = errData.error;
            } catch {
                if (text && text.length < 300) msg = text;
            }
            throw decorateApiError(msg, errData);
        }

        const data = JSON.parse(await response.text());
        authToken = data.token;
        activeOrganizationId = null;
        currentUser = data.user;

        // Store in localStorage
        localStorage.setItem('authToken', authToken);
        localStorage.setItem('currentUser', JSON.stringify(currentUser));

        return { success: true, user: currentUser };
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: getFriendlyErrorMessage(error) };
    }
}

async function requestPasswordReset(email) {
    try {
        const response = await fetch(`${getApiBase()}/auth/forgot-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
        });
        const raw = await response.text();
        let data = {};
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch {
                data = {};
            }
        }
        if (!response.ok) {
            throw decorateApiError(data.error || 'Unable to request password reset', data);
        }
        return {
            success: true,
            message: data.message || 'If an account exists for that email, we sent a password reset link.'
        };
    } catch (error) {
        console.error('Password reset request error:', error);
        return { success: false, error: getFriendlyErrorMessage(error) };
    }
}

async function resetPassword(token, password) {
    try {
        const response = await fetch(`${getApiBase()}/auth/reset-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token, password })
        });
        const raw = await response.text();
        let data = {};
        if (raw) {
            try {
                data = JSON.parse(raw);
            } catch {
                data = {};
            }
        }
        if (!response.ok) {
            throw decorateApiError(data.error || 'Unable to reset password', data);
        }
        return { success: true, message: data.message || 'Password reset successfully' };
    } catch (error) {
        console.error('Password reset error:', error);
        return { success: false, error: getFriendlyErrorMessage(error) };
    }
}

function clearAuthStateAndRedirect() {
    authToken = null;
    currentUser = null;
    activeOrganizationId = null;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    // Clear session greeting so it changes on next login
    sessionStorage.removeItem('userGreeting');
    if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.off === 'function') {
        window.mobilePinchZoomGuard.off();
    }
    window.location.href = 'login.html';
}

// Logout
async function logout() {
    const token = authToken || localStorage.getItem('authToken');
    try {
        if (token) {
            await fetch(`${getApiBase()}/auth/logout`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token
                }
            });
        }
    } catch (error) {
        console.warn('Logout request failed; clearing local session anyway:', error);
    } finally {
        clearAuthStateAndRedirect();
    }
}

// Get current user
function getCurrentUser() {
    return currentUser;
}

function getCurrentOrganizationId() {
    if (!currentUser || currentUser.organizationId == null) return null;
    const oid = Number(currentUser.organizationId);
    return Number.isFinite(oid) && oid > 0 ? oid : null;
}

// Track the org selected for this app session without changing the saved default org.
function setActiveOrganizationId(orgId) {
    const parsed = parseInt(orgId, 10);
    activeOrganizationId = Number.isFinite(parsed) ? parsed : null;
    if (currentUser && activeOrganizationId != null) {
        currentUser.organizationId = activeOrganizationId;
    }
}

// Get auth token
function getAuthToken() {
    return authToken;
}

function setAuthToken(token) {
    const next = String(token || '').trim();
    if (!next) return;
    authToken = next;
    localStorage.setItem('authToken', next);
}

// Check if user is authenticated
function isAuthenticated() {
    return !!authToken && !!currentUser;
}

// Check if user has role
function hasRole(...roles) {
    if (!currentUser) return false;
    return roles.includes(currentUser.role);
}

// Check if user is dev
function isDev() {
    return hasRole('dev');
}

// Check if user is admin (global admin role or per-org admin in at least one organization)
function isAdmin() {
    if (!currentUser) return false;
    if (hasRole('admin', 'dev')) return true;
    const adminOrgIds = currentUser.adminOrganizationIds;
    return Array.isArray(adminOrgIds) && adminOrgIds.length > 0;
}

/** Per-org membership role from /auth/me `organizationMemberships` (operator | manager | admin | tech). */
function getOrgRoleForOrg(orgId) {
    if (!currentUser || orgId == null) return null;
    const list = currentUser.organizationMemberships;
    if (!Array.isArray(list)) return null;
    const row = list.find((x) => Number(x.organizationId) === Number(orgId));
    const role = row && row.role ? String(row.role) : null;
    if (window.rolesModule && typeof window.rolesModule.normalizeOrgRole === 'function') {
        return window.rolesModule.normalizeOrgRole(role);
    }
    if (!role || role === 'user') return 'operator';
    return role;
}

/** True when the current selected org membership is Tech (field technicians: limited ticket access). */
function isTechInCurrentOrg() {
    if (!currentUser || currentUser.role === 'dev') return false;
    const oid = currentUser.organizationId;
    if (oid == null) return false;
    return getOrgRoleForOrg(oid) === 'tech';
}

/** True when the current selected org membership is Manager. */
function isManagerInCurrentOrg() {
    if (!currentUser || currentUser.role === 'dev') return false;
    const oid = currentUser.organizationId;
    if (oid == null) return false;
    return getOrgRoleForOrg(oid) === 'manager';
}

/** True when the current user can perform USAN ticket create/renew/remark/amend/submit-jobs in the current org. */
function canWriteTicketsInCurrentOrg() {
    if (!currentUser) return false;
    if (currentUser.role === 'dev') return true;
    const oid = currentUser.organizationId;
    if (oid == null) return false;
    const role = getOrgRoleForOrg(oid);
    if (window.rolesModule && typeof window.rolesModule.isTicketWriteMembership === 'function') {
        return window.rolesModule.isTicketWriteMembership(role);
    }
    return role === 'admin' || role === 'manager';
}

/** Avoid browser/worker overload when many authenticated fetches run at once (each may preflight). */
const API_MAX_IN_FLIGHT = 12;
let apiInFlight = 0;
const apiWaitQueue = [];

function withApiConcurrency(fn) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            apiInFlight += 1;
            try {
                resolve(await fn());
            } catch (e) {
                reject(e);
            } finally {
                apiInFlight -= 1;
                const next = apiWaitQueue.shift();
                if (next) next();
            }
        };
        if (apiInFlight < API_MAX_IN_FLIGHT) {
            void run();
        } else {
            apiWaitQueue.push(run);
        }
    });
}

function isLikelyNetworkOrCorsFetchFailure(err) {
    if (!err) return false;
    if (err instanceof TypeError) return true;
    const msg = String(err.message || err);
    return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}

// Make authenticated API request
async function apiRequest(url, options = {}) {
    if (!authToken) {
        throw new Error('Not authenticated');
    }

    return withApiConcurrency(async () => {
        // Prepend API_BASE if URL is relative
        let fullUrl;
        if (url.startsWith('http://') || url.startsWith('https://')) {
            fullUrl = url;
        } else {
            // Remove leading slash and /api if present (since API_BASE already includes /api)
            let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
            if (cleanUrl.startsWith('api/')) {
                cleanUrl = cleanUrl.substring(4);
            }
            fullUrl = `${getApiBase()}${cleanUrl.startsWith('/') ? cleanUrl : '/' + cleanUrl}`;
        }

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
            ...options.headers
        };

        let response;
        try {
            response = await fetch(fullUrl, {
                ...options,
                headers
            });
        } catch (fetchErr) {
            if (isLikelyNetworkOrCorsFetchFailure(fetchErr)) {
                throw new Error('Could not reach the API. Check your connection or try again in a moment.');
            }
            throw fetchErr;
        }

        if (response.status === 401) {
            // Token expired or invalid
            logout();
            throw new Error('Authentication expired');
        }

        const raw = await response.text();

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            let errData = null;
            if (raw) {
                try {
                    errData = JSON.parse(raw);
                    const m = errData && errData.error != null ? String(errData.error) : 'Request failed';
                    const detail =
                        errData && errData.detail != null && String(errData.detail).trim() !== '' ? String(errData.detail) : '';
                    errMsg = detail ? `${m}: ${detail}` : m;
                } catch {
                    errMsg = `${errMsg} — ${raw.slice(0, 200)}`.trim();
                }
            }
            const apiError = decorateApiError(errMsg, errData);
            apiError.status = response.status;
            throw apiError;
        }

        if (raw == null || raw === '') {
            return null;
        }
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error('Invalid JSON from server: ' + raw.slice(0, 200));
        }
    });
}

/**
 * POST external list poll with SSE progress (`progressStream: true`). Parses `data: {...}` lines; final payload is `{ done: true, result }`.
 * @param {string} path relative e.g. tickets/usan-poll
 * @param {object} body JSON body (progressStream added automatically)
 * @param {(evt: { percent?: number, phase?: string, error?: string }) => void} [onProgress]
 * @returns {Promise<object>} same shape as non-streaming /usan-poll JSON
 */
async function usanPollStream(path, body, onProgress) {
    if (!authToken) {
        throw new Error('Not authenticated');
    }
    return withApiConcurrency(async () => {
        let fullUrl;
        if (path.startsWith('http://') || path.startsWith('https://')) {
            fullUrl = path;
        } else {
            let cleanUrl = path.startsWith('/') ? path.substring(1) : path;
            if (cleanUrl.startsWith('api/')) {
                cleanUrl = cleanUrl.substring(4);
            }
            fullUrl = `${getApiBase()}${cleanUrl.startsWith('/') ? cleanUrl : '/' + cleanUrl}`;
        }
        let response;
        try {
            response = await fetch(fullUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({ ...body, progressStream: true }),
            });
        } catch (fetchErr) {
            if (isLikelyNetworkOrCorsFetchFailure(fetchErr)) {
                throw new Error('Could not reach the API. Check your connection or try again in a moment.');
            }
            throw fetchErr;
        }

        if (response.status === 401) {
            logout();
            throw new Error('Authentication expired');
        }

        const ct = (response.headers.get('content-type') || '').toLowerCase();
        if (!response.ok) {
            if (ct.includes('application/json')) {
                const err = await response.json();
                throw decorateApiError(err.error || 'Request failed', err);
            }
            const text = await response.text();
            throw decorateApiError(text.slice(0, 200) || 'Request failed', null);
        }

    if (!ct.includes('text/event-stream') || !response.body) {
        return response.json();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    /** @type {object|null} */
    let finalResult = null;
    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.replace(/^data:\s?/, '').trim();
            if (!payload) continue;
            let json;
            try {
                json = JSON.parse(payload);
            } catch {
                continue;
            }
            if (json.error) {
                throw decorateApiError(json.error, json);
            }
            if (json.done && json.result != null) {
                finalResult = json.result;
            } else if (onProgress && (json.percent != null || json.phase)) {
                onProgress(json);
            }
        }
        if (done) break;
    }
    if (finalResult == null) {
        throw new Error('External list sync ended without a result');
    }
    return finalResult;
    });
}

// Refresh current user info
async function refreshUser() {
    try {
        const user = await apiRequest(`${getApiBase()}/auth/me`);
        currentUser = activeOrganizationId != null ? { ...user, organizationId: activeOrganizationId } : user;
        localStorage.setItem('currentUser', JSON.stringify(user));
        return currentUser;
    } catch (error) {
        console.error('Error refreshing user:', error);
        throw error;
    }
}

// Initialize on load
initAuth();

// Export functions
window.authModule = {
    login,
    requestPasswordReset,
    resetPassword,
    logout,
    getCurrentUser,
    getCurrentOrganizationId,
    setActiveOrganizationId,
    getAuthToken,
    setAuthToken,
    isAuthenticated,
    hasRole,
    isDev,
    isAdmin,
    getOrgRoleForOrg,
    isTechInCurrentOrg,
    isManagerInCurrentOrg,
    canWriteTicketsInCurrentOrg,
    apiRequest,
    usanPollStream,
    withApiConcurrency,
    refreshUser,
    getApiBaseForMedia,
    getAuthHeaders,
    getFriendlyErrorMessage,
    decorateApiError,
    get API_BASE() { return getApiBase(); }
};
