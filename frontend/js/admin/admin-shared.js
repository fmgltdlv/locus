// Admin panel management
// Use API_BASE from authModule (auth.js also defines getApiBase; use a different name here)
function getAdminApiBase() {
    const apiBase = window.authModule?.API_BASE || window.API_BASE;
    if (!apiBase) {
        throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
    }
    return apiBase;
}

let organizations = [];
let users = [];
let serviceRequests = [];
let providerAccounts = [];
let adminErrors = [];

function escapeAdminHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function adminClassSuffix(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

const ADMIN_ORG_STORAGE_KEY = 'adminPanelSelectedOrgId';
const ADMIN_THEME_STORAGE_KEY = 'adminPanelTheme';
let adminThemePersistTimer = null;

function normalizeAdminTheme(value) {
    return value === 'light' || value === 'dark' ? value : null;
}

function getAdminUserStorageKey(baseKey) {
    const currentUser = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
    if (currentUser && currentUser.id) {
        return baseKey + '_user_' + currentUser.id;
    }
    return baseKey;
}

function readAdminUserProfile() {
    try {
        const raw = localStorage.getItem(getAdminUserStorageKey('userProfile'));
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function writeAdminUserProfile(profile) {
    try {
        localStorage.setItem(getAdminUserStorageKey('userProfile'), JSON.stringify(profile || {}));
    } catch (e) {
        /* ignore local preference write failures */
    }
}

function getStoredAdminTheme() {
    const profileTheme = normalizeAdminTheme(readAdminUserProfile().adminTheme);
    if (profileTheme) return profileTheme;
    try {
        const storedTheme = normalizeAdminTheme(localStorage.getItem(ADMIN_THEME_STORAGE_KEY));
        if (storedTheme) return storedTheme;
    } catch (e) {
        /* ignore */
    }
    return normalizeAdminTheme(document.documentElement.getAttribute('data-admin-theme')) || 'dark';
}

function applyAdminTheme(theme) {
    const nextTheme = normalizeAdminTheme(theme) || 'dark';
    document.documentElement.setAttribute('data-admin-theme', nextTheme);

    const toggle = document.getElementById('adminThemeToggle');
    if (toggle) {
        const targetTheme = nextTheme === 'dark' ? 'light' : 'dark';
        toggle.textContent = targetTheme === 'light' ? 'Light mode' : 'Dark mode';
        toggle.setAttribute('aria-label', 'Switch admin panel to ' + targetTheme + ' mode');
        toggle.setAttribute('aria-pressed', nextTheme === 'light' ? 'true' : 'false');
        toggle.title = 'Switch admin panel to ' + targetTheme + ' mode';
    }
}

function saveAdminThemeLocally(theme) {
    const nextTheme = normalizeAdminTheme(theme) || 'dark';
    try {
        localStorage.setItem(ADMIN_THEME_STORAGE_KEY, nextTheme);
    } catch (e) {
        /* ignore */
    }
    const profile = readAdminUserProfile();
    profile.adminTheme = nextTheme;
    profile.adminThemeUpdatedAt = new Date().toISOString();
    writeAdminUserProfile(profile);
}

async function loadAdminUiPreferencesFromServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return {};
    const res = await window.authModule.apiRequest(getAdminApiBase() + '/users/me/ui-preferences');
    const prefs = res && res.preferences;
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
}

async function persistAdminThemePreference(theme) {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    const nextTheme = normalizeAdminTheme(theme) || 'dark';
    const prefs = await loadAdminUiPreferencesFromServer();
    const serverProfile = prefs.userProfile && typeof prefs.userProfile === 'object' && !Array.isArray(prefs.userProfile)
        ? prefs.userProfile
        : {};
    prefs.userProfile = {
        ...serverProfile,
        ...readAdminUserProfile(),
        adminTheme: nextTheme,
        adminThemeUpdatedAt: new Date().toISOString()
    };
    if (
        prefs.createTicketSharedPresets == null &&
        typeof window.getCreateTicketSharedPresetsFromStorage === 'function'
    ) {
        prefs.createTicketSharedPresets = window.getCreateTicketSharedPresetsFromStorage();
    }
    await window.authModule.apiRequest(getAdminApiBase() + '/users/me/ui-preferences', {
        method: 'PUT',
        body: JSON.stringify({ preferences: prefs })
    });
}

function schedulePersistAdminThemePreference(theme) {
    clearTimeout(adminThemePersistTimer);
    adminThemePersistTimer = setTimeout(function () {
        persistAdminThemePreference(theme).catch(function (err) {
            console.warn('persistAdminThemePreference:', err.message || err);
        });
    }, 400);
}

function setAdminTheme(theme, options) {
    const nextTheme = normalizeAdminTheme(theme) || 'dark';
    applyAdminTheme(nextTheme);
    saveAdminThemeLocally(nextTheme);
    if (!options || options.persist !== false) {
        schedulePersistAdminThemePreference(nextTheme);
    }
}

function initAdminThemeToggle() {
    applyAdminTheme(getStoredAdminTheme());
    const toggle = document.getElementById('adminThemeToggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
        const currentTheme = normalizeAdminTheme(document.documentElement.getAttribute('data-admin-theme')) || 'dark';
        setAdminTheme(currentTheme === 'dark' ? 'light' : 'dark');
    });
}

async function syncAdminThemePreferenceFromServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    try {
        const prefs = await loadAdminUiPreferencesFromServer();
        const serverProfile = prefs.userProfile && typeof prefs.userProfile === 'object' && !Array.isArray(prefs.userProfile)
            ? prefs.userProfile
            : {};
        if (Object.keys(serverProfile).length === 0) return;
        const mergedProfile = {
            ...readAdminUserProfile(),
            ...serverProfile
        };
        writeAdminUserProfile(mergedProfile);
        const serverTheme = normalizeAdminTheme(mergedProfile.adminTheme);
        if (serverTheme) {
            try {
                localStorage.setItem(ADMIN_THEME_STORAGE_KEY, serverTheme);
            } catch (e) {
                /* ignore */
            }
            applyAdminTheme(serverTheme);
        }
        if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.apply === 'function') {
            window.mobilePinchZoomGuard.apply(mergedProfile.allowPinchZoom === true);
        }
    } catch (e) {
        console.warn('syncAdminThemePreferenceFromServer:', e.message || e);
    }
}

function getAuthUserOrganizationId() {
    const currentUser = window.authModule && window.authModule.getCurrentUser
        ? window.authModule.getCurrentUser()
        : null;
    if (!currentUser) return null;
    const id = parseInt(
        currentUser.defaultOrganizationId != null
            ? currentUser.defaultOrganizationId
            : currentUser.organizationId,
        10
    );
    return isNaN(id) ? null : id;
}

function getCurrentAdminOrgId() {
    const raw = sessionStorage.getItem(ADMIN_ORG_STORAGE_KEY);
    if (raw !== '' && raw !== null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n)) return n;
    }
    return getAuthUserOrganizationId();
}

function setCurrentAdminOrgId(orgId) {
    if (orgId == null || orgId === '') {
        sessionStorage.removeItem(ADMIN_ORG_STORAGE_KEY);
    } else {
        sessionStorage.setItem(ADMIN_ORG_STORAGE_KEY, String(orgId));
    }
}

const ADMIN_LIST_PAGE_SIZE = 30;
const adminListState = {
    users: { page: 1, appliedQuery: '' },
    aerialCatalog: { page: 1, appliedQuery: '' },
    errors: { page: 1, appliedQuery: '' },
    serviceRequests: { page: 1, appliedQuery: '' }
};

function getAdminListState(listKey) {
    if (!adminListState[listKey]) {
        adminListState[listKey] = { page: 1, appliedQuery: '' };
    }
    return adminListState[listKey];
}

function normalizeAdminSearchQuery(value) {
    return String(value || '').trim().toLowerCase();
}

function adminListItemMatchesQuery(item, query, fields) {
    if (!query) return true;
    for (let i = 0; i < fields.length; i++) {
        const raw = fields[i](item);
        if (raw == null || raw === '') continue;
        if (String(raw).toLowerCase().includes(query)) return true;
    }
    return false;
}

function filterAdminListItems(items, listKey, fields) {
    const state = getAdminListState(listKey);
    const query = normalizeAdminSearchQuery(state.appliedQuery);
    const list = Array.isArray(items) ? items : [];
    if (!query) return list.slice();
    return list.filter(function (item) {
        return adminListItemMatchesQuery(item, query, fields);
    });
}

function paginateAdminList(items, listKey) {
    const state = getAdminListState(listKey);
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / ADMIN_LIST_PAGE_SIZE) || 1);
    let page = Math.max(1, Math.floor(Number(state.page) || 1));
    if (page > totalPages) page = totalPages;
    state.page = page;
    const start = total === 0 ? 0 : (page - 1) * ADMIN_LIST_PAGE_SIZE;
    const pageItems = list.slice(start, start + ADMIN_LIST_PAGE_SIZE);
    return {
        pageItems: pageItems,
        total: total,
        page: page,
        totalPages: totalPages,
        rangeStart: total === 0 ? 0 : start + 1,
        rangeEnd: total === 0 ? 0 : start + pageItems.length
    };
}

function renderAdminListPagination(containerId, listKey, slice, onPageChangeName) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!slice || slice.total === 0) {
        el.innerHTML = '';
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const prevDisabled = slice.page <= 1 ? ' disabled' : '';
    const nextDisabled = slice.page >= slice.totalPages ? ' disabled' : '';
    el.innerHTML =
        '<span class="admin-list-pagination-summary">Showing ' +
        slice.rangeStart +
        '–' +
        slice.rangeEnd +
        ' of ' +
        slice.total +
        '</span>' +
        '<span class="admin-list-pagination-controls">' +
        '<button type="button" class="admin-button admin-button-secondary admin-button-compact"' +
        prevDisabled +
        ' onclick="' +
        onPageChangeName +
        '(\'' +
        listKey +
        '\', ' +
        (slice.page - 1) +
        ')">Previous</button>' +
        '<span class="admin-list-pagination-page-label">Page ' +
        slice.page +
        ' of ' +
        slice.totalPages +
        '</span>' +
        '<button type="button" class="admin-button admin-button-secondary admin-button-compact"' +
        nextDisabled +
        ' onclick="' +
        onPageChangeName +
        '(\'' +
        listKey +
        '\', ' +
        (slice.page + 1) +
        ')">Next</button>' +
        '</span>';
}
