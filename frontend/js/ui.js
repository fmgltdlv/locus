// UI functions - Sidebar, modals, profile menu

/** App UI designs (must match index.html theme ids and css/app-themes.css) */
const APP_UI_THEMES = ['default', 'glass', 'outline', 'ember', 'slate', 'blueprint', 'contractor', 'console', 'landoffice', 'modern'];

/** Profile text size steps (must match index.html #profileFontSize and app-themes.css data-font-scale). */
const APP_FONT_SCALES = ['compact', 'default', 'large', 'max'];

/** Loader variant per UI theme (must match styles/partials/_12-loading-indicators.css). */
const THEME_LOADER_MAP = {
    default: 'arc',
    glass: 'orbit',
    outline: 'dots-revolve',
    ember: 'bar-bounce',
    slate: 'bar-pulse',
    blueprint: 'dual-ring',
    contractor: 'morph-square',
    console: 'dna',
    landoffice: 'bar-pulse',
    modern: 'dots-revolve'
};

/** Variants that need inner span elements (count per variant). */
const LOADER_VARIANT_SPAN_COUNTS = {
    'bar-pulse': 5,
    'dots-revolve': 8,
    orbit: 3,
    'bar-bounce': 5,
    dna: 6
};

function getCurrentUiThemeName() {
    const prefix = 'app-theme-';
    for (let i = 0; i < APP_UI_THEMES.length; i++) {
        const t = APP_UI_THEMES[i];
        if (document.documentElement.classList.contains(prefix + t)) {
            return t;
        }
    }
    try {
        const stored = localStorage.getItem('appUiTheme');
        if (stored && APP_UI_THEMES.indexOf(stored) !== -1) {
            return stored;
        }
    } catch (e) { /* ignore */ }
    return 'default';
}

function getThemeLoaderVariant(themeName) {
    const theme =
        themeName && APP_UI_THEMES.indexOf(themeName) !== -1 ? themeName : getCurrentUiThemeName();
    return THEME_LOADER_MAP[theme] || THEME_LOADER_MAP.default || 'arc';
}

function normalizeLoaderSize(size) {
    if (size === 'sm' || size === 'lg') {
        return size;
    }
    return 'default';
}

function buildAppLoaderInnerHtml(variant, size) {
    const sizeClass = size === 'default' ? '' : ' ayw-loader--' + size;
    const spanCount = LOADER_VARIANT_SPAN_COUNTS[variant];
    let spans = '';
    if (spanCount) {
        spans = new Array(spanCount).fill('<span></span>').join('');
    }
    return (
        '<div class="ayw-loader ayw-loader--' +
        variant +
        sizeClass +
        '" aria-hidden="true">' +
        spans +
        '</div>'
    );
}

function createAppLoaderElement(options) {
    options = options || {};
    const size = normalizeLoaderSize(options.size);
    const variant = options.variant || getThemeLoaderVariant(options.theme);
    const wrapper = document.createElement('div');
    wrapper.className = 'app-loading-indicator';
    if (size !== 'default') {
        wrapper.classList.add('app-loading-indicator--' + size);
    }
    wrapper.setAttribute('role', 'status');
    wrapper.setAttribute('aria-label', 'Loading');
    wrapper.innerHTML = buildAppLoaderInnerHtml(variant, size);
    return wrapper;
}

function getAppLoaderHtml(options) {
    options = options || {};
    const size = normalizeLoaderSize(options.size);
    const variant = options.variant || getThemeLoaderVariant(options.theme);
    const sizeIndicatorClass = size !== 'default' ? ' app-loading-indicator--' + size : '';
    const decorative = options.decorative === true;
    const a11yAttrs = decorative
        ? ' aria-hidden="true"'
        : ' role="status" aria-label="Loading"';
    return (
        '<div class="app-loading-indicator' +
        sizeIndicatorClass +
        '"' +
        a11yAttrs +
        '>' +
        buildAppLoaderInnerHtml(variant, size) +
        '</div>'
    );
}

function refreshAppLoaders() {
    const variant = getThemeLoaderVariant();
    document.querySelectorAll('.app-loading-indicator').forEach(function (el) {
        if (el.closest('#pwaBootOverlay')) {
            return;
        }
        let size = 'default';
        if (el.classList.contains('app-loading-indicator--sm')) {
            size = 'sm';
        } else if (el.classList.contains('app-loading-indicator--lg')) {
            size = 'lg';
        }
        el.innerHTML = buildAppLoaderInnerHtml(variant, size);
    });
}

function getBasemapIds() {
    const ids = ['default'];
    const mapboxToken =
        typeof window.getMapboxAccessToken === 'function' ? window.getMapboxAccessToken() : '';
    if (mapboxToken) {
        ids.push('mapboxHybrid');
    }
    return ids;
}

function ensureMapboxBasemapSelectOptions() {
    const mapboxToken =
        typeof window.getMapboxAccessToken === 'function' ? window.getMapboxAccessToken() : '';
    if (!mapboxToken) {
        return;
    }
    ['settingsDefaultView'].forEach(function (selectId) {
        const sel = document.getElementById(selectId);
        if (!sel || sel.querySelector('option[value="mapboxHybrid"]')) {
            return;
        }
        const opt = document.createElement('option');
        opt.value = 'mapboxHybrid';
        opt.textContent = window.t ? window.t('Mapbox Hybrid') : 'Mapbox Hybrid';
        sel.appendChild(opt);
    });
}

function normalizeBasemapId(value) {
    let v = value || 'default';
    if (v === 'street') v = 'default';
    if (v === 'clarkCountyAerial') v = 'default';
    if (v === 'dark' || v === 'light' || v === 'esriHybrid') v = 'default';
    if (v === 'opentopo') v = 'default';
    if (v === 'satellite' || v === 'googleHybrid') {
        const mapboxToken =
            typeof window.getMapboxAccessToken === 'function' ? window.getMapboxAccessToken() : '';
        v = mapboxToken ? 'mapboxHybrid' : 'default';
    }
    return getBasemapIds().includes(v) ? v : 'default';
}

function getEffectiveBasemapId(profileData) {
    const p = profileData || {};
    return normalizeBasemapId(p.mapTheme || p.defaultView);
}

/**
 * Apply UI theme class on documentElement (map app chrome; separate from map basemap mapTheme).
 * @param {string} name
 */
function applyAppTheme(name) {
    if (APP_UI_THEMES.indexOf(name) === -1) {
        name = 'default';
    }
    const prefix = 'app-theme-';
    APP_UI_THEMES.forEach(function (t) {
        document.documentElement.classList.remove(prefix + t);
    });
    document.documentElement.classList.add(prefix + name);
    const sel = document.getElementById('profileUiTheme');
    if (sel) sel.value = name;
    try {
        localStorage.setItem('appUiTheme', name);
        const storageKey = getUserStorageKey('userProfile');
        const profile = JSON.parse(localStorage.getItem(storageKey) || '{}');
        profile.uiTheme = name;
        localStorage.setItem(storageKey, JSON.stringify(profile));
    } catch (e) { /* ignore */ }
    schedulePersistUserUiPreferencesToServer();
    refreshAppLoaders();
}

function normalizeFontSizeScale(value) {
    if (value === 'larger') return 'max';
    return APP_FONT_SCALES.indexOf(value) !== -1 ? value : 'default';
}

/**
 * Scale map-app typography via html root font-size (rem-based UI).
 * @param {string} name
 */
function applyAppFontScale(name) {
    const scale = normalizeFontSizeScale(name);
    if (scale === 'default') {
        document.documentElement.removeAttribute('data-font-scale');
    } else {
        document.documentElement.setAttribute('data-font-scale', scale);
    }
    const sel = document.getElementById('profileFontSize');
    if (sel) sel.value = scale;
    try {
        const storageKey = getUserStorageKey('userProfile');
        const profile = JSON.parse(localStorage.getItem(storageKey) || '{}');
        profile.fontSizeScale = scale;
        localStorage.setItem(storageKey, JSON.stringify(profile));
    } catch (e) { /* ignore */ }
    schedulePersistUserUiPreferencesToServer();
    if (window.map && typeof window.map.invalidateSize === 'function') {
        requestAnimationFrame(function () {
            window.map.invalidateSize({ animate: false });
        });
    }
}

function getEffectiveFontSizeScale(profileData) {
    if (profileData && profileData.fontSizeScale) {
        return normalizeFontSizeScale(profileData.fontSizeScale);
    }
    return 'default';
}

function getEffectiveUiTheme(profileData) {
    try {
        const fromUrl = new URLSearchParams(window.location.search).get('theme');
        if (fromUrl && APP_UI_THEMES.indexOf(fromUrl) !== -1) {
            return fromUrl;
        }
    } catch (e) { /* ignore */ }
    if (profileData && profileData.uiTheme && APP_UI_THEMES.indexOf(profileData.uiTheme) !== -1) {
        return profileData.uiTheme;
    }
    return 'default';
}

// Modal functionality
function showModal(title) {
    // Placeholder for modal functionality
}

function closeModal() {
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.style.display = 'none';
        document.body.style.overflow = '';
    }
}

// In-app toast notification (replaces browser alert for success/error messages)
function showToast(message, type) {
    type = type || 'success';
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
    toast.setAttribute('role', 'alert');
    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = message;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.type = 'button';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.onclick = function () {
        toast.remove();
    };
    toast.appendChild(msg);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    const dismissMs = type === 'error' ? 8000 : 5000;
    const t = setTimeout(function () {
        if (toast.parentNode) {
            toast.remove();
        }
        clearTimeout(t);
    }, dismissMs);
}

// Profile menu toggle
// Generate random greeting
function getRandomGreeting() {
    const greetings = [
        'Hey {name}!',
        'Hello {name}!',
        'Howdy {name}!',
        'What\'s Up {name}!',
        'Welcome back {name}!',
        'Good to see you {name}!',
        'Hey there {name}!',
        'Greetings {name}!',
        'Hi {name}!',
        'Nice to see you {name}!'
    ];
    
    // Check if we already have a greeting for this session
    let greeting = sessionStorage.getItem('userGreeting');
    
    // If no greeting exists, pick a random one
    if (!greeting) {
        const randomIndex = Math.floor(Math.random() * greetings.length);
        greeting = greetings[randomIndex];
        sessionStorage.setItem('userGreeting', greeting);
    }
    
    return greeting;
}

// Initialize profile greeting
function initProfileGreeting() {
    const greetingElement = document.getElementById('profileGreeting');
    if (!greetingElement) return;
    
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        const userName = user.fullName || user.username || 'User';
        const greetingTemplate = getRandomGreeting();
        const greeting = greetingTemplate.replace('{name}', userName);
        greetingElement.textContent = greeting;
    } else {
        greetingElement.textContent = 'Hello!';
    }
}

function closeAccountMenu() {
    if (typeof window.closeAllCircleMenus === 'function') {
        window.closeAllCircleMenus();
    }
}

// Helper to get user-specific localStorage key
function getUserStorageKey(baseKey) {
    const currentUser = window.authModule?.getCurrentUser();
    if (currentUser && currentUser.id) {
        return `${baseKey}_user_${currentUser.id}`;
    }
    return baseKey; // Fallback for unauthenticated or missing user ID
}

let _persistUiPrefsTimer = null;

function getTicketPopupDimensionsFromStorage() {
    try {
        const ticketKey = getUserStorageKey('ticketPopupDimensions');
        return JSON.parse(localStorage.getItem(ticketKey) || '{}');
    } catch (e) {
        return {};
    }
}

const CREATE_TICKET_SHARED_PRESETS_STORAGE_BASE = 'createTicketSharedPresets';

function normalizeCreateTicketSharedPresetsBlob(raw) {
    const empty = { version: 1, presets: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const presets = Array.isArray(raw.presets) ? raw.presets : [];
    return {
        version: 1,
        presets: presets.filter(function (p) {
            return p && typeof p === 'object' && !Array.isArray(p) && p.id != null && p.name != null;
        }),
    };
}

function getCreateTicketSharedPresetsFromStorage() {
    try {
        const key = getUserStorageKey(CREATE_TICKET_SHARED_PRESETS_STORAGE_BASE);
        return normalizeCreateTicketSharedPresetsBlob(JSON.parse(localStorage.getItem(key) || '{}'));
    } catch (e) {
        return { version: 1, presets: [] };
    }
}

function setCreateTicketSharedPresetsInStorage(blob) {
    const normalized = normalizeCreateTicketSharedPresetsBlob(blob);
    try {
        localStorage.setItem(
            getUserStorageKey(CREATE_TICKET_SHARED_PRESETS_STORAGE_BASE),
            JSON.stringify(normalized)
        );
    } catch (e) {
        /* ignore quota */
    }
    return normalized;
}

/**
 * Build payload for PUT /users/me/ui-preferences (profile blob + ticket popup sizes + shared presets).
 */
function buildUiPreferencesPayload() {
    return {
        userProfile: getUserProfile(),
        ticketPopupDimensions: getTicketPopupDimensionsFromStorage(),
        createTicketSharedPresets: getCreateTicketSharedPresetsFromStorage(),
    };
}

async function putUserUiPreferencesToServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    const preferences = buildUiPreferencesPayload();
    await window.authModule.apiRequest(`${window.authModule.API_BASE}/users/me/ui-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ preferences: preferences })
    });
}

function schedulePersistUserUiPreferencesToServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    clearTimeout(_persistUiPrefsTimer);
    _persistUiPrefsTimer = setTimeout(function () {
        putUserUiPreferencesToServer().catch(function (err) {
            console.warn('persistUserUiPreferencesToServer:', err.message || err);
        });
    }, 400);
}

/**
 * Load UI preferences from the server into localStorage, then apply theme hooks.
 * Migrates existing local-only data to the DB when the server has no row yet.
 */
async function syncUserUiPreferencesFromServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return;
    try {
        const res = await window.authModule.apiRequest(`${window.authModule.API_BASE}/users/me/ui-preferences`);
        const storageKey = getUserStorageKey('userProfile');
        let localProfile = {};
        try {
            localProfile = JSON.parse(localStorage.getItem(storageKey) || '{}');
        } catch (e) {
            localProfile = {};
        }
        const ticketKey = getUserStorageKey('ticketPopupDimensions');
        let localTicket = {};
        try {
            localTicket = JSON.parse(localStorage.getItem(ticketKey) || '{}');
        } catch (e) {
            localTicket = {};
        }
        const localSharedPresets = getCreateTicketSharedPresetsFromStorage();
        const hasLocalSharedPresets = localSharedPresets.presets.length > 0;

        if (res.preferences == null) {
            if (
                Object.keys(localProfile).length > 0 ||
                Object.keys(localTicket).length > 0 ||
                hasLocalSharedPresets
            ) {
                await putUserUiPreferencesToServer();
            }
            return;
        }

        const p = res.preferences;
        if (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0) {
            if (
                Object.keys(localProfile).length > 0 ||
                Object.keys(localTicket).length > 0 ||
                hasLocalSharedPresets
            ) {
                await putUserUiPreferencesToServer();
            }
            return;
        }
        let up = p.userProfile;
        let tp = p.ticketPopupDimensions;
        if (up == null && (p.mapTheme != null || p.uiTheme != null || p.defaultView != null)) {
            up = p;
            tp = p.ticketPopupDimensions || {};
        }
        if (up && typeof up === 'object') {
            const merged = Object.assign({}, localProfile, up);
            localStorage.setItem(storageKey, JSON.stringify(merged));
            if (merged.uiTheme && APP_UI_THEMES.indexOf(merged.uiTheme) !== -1) {
                try {
                    localStorage.setItem('appUiTheme', merged.uiTheme);
                } catch (e) { /* ignore */ }
            }
        }
        if (tp && typeof tp === 'object' && Object.keys(tp).length > 0) {
            const mergedT = Object.assign({}, localTicket, tp);
            localStorage.setItem(ticketKey, JSON.stringify(mergedT));
        }
        if (p.createTicketSharedPresets != null) {
            setCreateTicketSharedPresetsInStorage(p.createTicketSharedPresets);
        }
        if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.apply === 'function') {
            const mergedProfile = up && typeof up === 'object' ? Object.assign({}, localProfile, up) : localProfile;
            window.mobilePinchZoomGuard.apply(mergedProfile.allowPinchZoom === true);
        }
    } catch (e) {
        console.warn('syncUserUiPreferencesFromServer:', e.message || e);
    }
}

// Profile menu actions — unified Settings modal
const SETTINGS_TAB_IDS = ['profile', 'personalization', 'map', 'tickets'];

function switchSettingsTab(tabId) {
    const tab = SETTINGS_TAB_IDS.includes(tabId) ? tabId : 'profile';
    const tabToPanelId = {
        profile: 'settingsTabProfile',
        personalization: 'settingsTabPersonalization',
        map: 'settingsTabMap',
        tickets: 'settingsTabTickets'
    };
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.querySelectorAll('.settings-tab[data-settings-tab]').forEach(function (btn) {
        const isActive = btn.getAttribute('data-settings-tab') === tab;
        btn.classList.toggle('settings-tab--active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    modal.querySelectorAll('.settings-tab-panel').forEach(function (panel) {
        const active = panel.id === tabToPanelId[tab];
        panel.classList.toggle('settings-tab-panel--active', active);
        panel.hidden = !active;
    });
}

function initSettingsModalTabs() {
    const modal = document.getElementById('settingsModal');
    const tablist = modal && modal.querySelector('.settings-modal-tabs');
    if (!tablist || tablist.dataset.settingsTabsInit === '1') return;
    tablist.dataset.settingsTabsInit = '1';
    tablist.addEventListener('click', function (e) {
        const btn = e.target.closest('.settings-tab[data-settings-tab]');
        if (!btn) return;
        switchSettingsTab(btn.getAttribute('data-settings-tab'));
    });
}

function openProfile(tab) {
    openSettings(tab || 'profile');
}

function openSettings(tab) {
    closeAccountMenu();
    initSettingsModalTabs();

    loadProfile();
    loadSettings();
    switchSettingsTab(tab || 'profile');
    setProfilePasswordFieldsAutofillActive(true);

    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
        settingsModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
}

function closeProfileModal() {
    closeSettingsModal();
}

function setProfilePasswordFieldsAutofillActive(active) {
    const setActive = typeof window.setPasswordFieldAutofillActive === 'function'
        ? window.setPasswordFieldAutofillActive
        : null;
    if (!setActive) return;
    setActive(document.getElementById('profileCurrentPassword'), active, 'current');
    setActive(document.getElementById('profileNewPassword'), active, 'new');
    setActive(document.getElementById('profileConfirmPassword'), active, 'new');
}

function closeSettingsModal() {
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
        settingsModal.style.display = 'none';
        document.body.style.overflow = '';
    }
    setProfilePasswordFieldsAutofillActive(false);
    const p = typeof getUserProfile === 'function' ? getUserProfile() : {};
    if (typeof applyAppTheme === 'function') {
        applyAppTheme(getEffectiveUiTheme(p));
    }
    if (typeof applyAppFontScale === 'function') {
        applyAppFontScale(getEffectiveFontSizeScale(p));
    }
    if (typeof applyMapTheme === 'function') {
        applyMapTheme(getEffectiveBasemapId(p));
    }
}

/** Display role for Settings → Profile: current-org membership, or global Dev. */
function getProfileDisplayRole(user) {
    if (!user) return 'operator';
    if (user.role === 'dev') return 'dev';
    let orgId = null;
    if (typeof window.getCurrentOrgId === 'function') {
        orgId = window.getCurrentOrgId();
    }
    if (orgId == null && window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    }
    if (orgId == null) orgId = user.organizationId;
    if (window.authModule && typeof window.authModule.getOrgRoleForOrg === 'function' && orgId != null) {
        const orgRole = window.authModule.getOrgRoleForOrg(orgId);
        if (orgRole) return orgRole;
    }
    const memberships = user.organizationMemberships;
    if (Array.isArray(memberships) && orgId != null) {
        const row = memberships.find((x) => Number(x.organizationId) === Number(orgId));
        if (row && row.role) return String(row.role);
    }
    return user.role || 'operator';
}

function formatProfileRoleLabel(role) {
    const labels = { operator: 'Operator', user: 'Operator', manager: 'Manager', admin: 'Admin', tech: 'Tech', dev: 'Dev' };
    const label = labels[role] || (role ? String(role).charAt(0).toUpperCase() + String(role).slice(1) : 'User');
    if (window.appI18n && typeof window.appI18n.t === 'function') {
        const translated = window.appI18n.t(label);
        if (translated) return translated;
    }
    return label;
}

function updateProfileOrgRoleDisplay(user) {
    const el = document.getElementById('profileUserType');
    if (!el) return;
    const u = user || (window.authModule && typeof window.authModule.getCurrentUser === 'function'
        ? window.authModule.getCurrentUser()
        : null);
    const role = getProfileDisplayRole(u);
    el.dataset.role = role;
    el.textContent = formatProfileRoleLabel(role);
}

// Load profile data from localStorage and backend
async function loadProfile() {
    try {
        // Load from backend first (if authenticated)
        if (window.authModule && window.authModule.isAuthenticated()) {
            try {
                const user = await window.authModule.refreshUser();
                const nameInput = document.getElementById('profileName');
                const emailInput = document.getElementById('profileEmail');
                const languageInput = document.getElementById('profileLanguage');
                
                if (nameInput) nameInput.value = user.fullName || user.username || '';
                const phoneInput = document.getElementById('profilePhone');
                if (phoneInput) phoneInput.value = user.phone || '';
                if (emailInput) {
                    emailInput.value = user.email || '';
                    // Email is always read-only in profile (can only be changed in admin panel)
                    emailInput.readOnly = true;
                }
                updateProfileOrgRoleDisplay(user);
                if (languageInput) {
                    languageInput.value = (user.preferredLanguage === 'es' || user.preferred_language === 'es') ? 'es' : 'en';
                }
            } catch (error) {
                console.error('Error loading user from backend:', error);
            }
        }
        
        // Also load from localStorage for preferences (user-specific)
        const storageKey = getUserStorageKey('userProfile');
        const profileData = JSON.parse(localStorage.getItem(storageKey) || '{}');
        
        // Clear password fields
        const currentPasswordInput = document.getElementById('profileCurrentPassword');
        const newPasswordInput = document.getElementById('profileNewPassword');
        const confirmPasswordInput = document.getElementById('profileConfirmPassword');
        if (currentPasswordInput) currentPasswordInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (confirmPasswordInput) confirmPasswordInput.value = '';

        // Set personalization preferences
        ensureMapboxBasemapSelectOptions();
        const languageInput = document.getElementById('profileLanguage');
        const uiTheme = document.getElementById('profileUiTheme');
        if (uiTheme) uiTheme.value = profileData.uiTheme || 'default';
        const fontSize = document.getElementById('profileFontSize');
        if (fontSize) fontSize.value = getEffectiveFontSizeScale(profileData);
        const pinchEl = document.getElementById('profileAllowPinchZoom');
        if (pinchEl) {
            pinchEl.checked = profileData.allowPinchZoom === true;
            pinchEl.dataset.loadedFromProfile = '1';
            if (pinchEl.dataset.bound !== '1') {
                pinchEl.dataset.bound = '1';
                pinchEl.addEventListener('change', function () {
                    const enabled = !!pinchEl.checked;
                    try {
                        const storageKey = getUserStorageKey('userProfile');
                        const profile = JSON.parse(localStorage.getItem(storageKey) || '{}');
                        profile.allowPinchZoom = enabled;
                        localStorage.setItem(storageKey, JSON.stringify(profile));
                    } catch (e) { /* ignore */ }
                    if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.apply === 'function') {
                        window.mobilePinchZoomGuard.apply(enabled);
                    }
                    schedulePersistUserUiPreferencesToServer();
                });
            }
        }
        if (languageInput && (!window.authModule || !window.authModule.isAuthenticated())) {
            languageInput.value = profileData.preferredLanguage || (window.appI18n && window.appI18n.getLanguage ? window.appI18n.getLanguage() : 'en');
        }

        const phoneInput = document.getElementById('profilePhone');
        if (phoneInput && phoneInput.dataset.phoneFilterBound !== '1') {
            phoneInput.dataset.phoneFilterBound = '1';
            phoneInput.addEventListener('input', function () {
                const filtered = String(phoneInput.value || '').replace(/\D/g, '').slice(0, 10);
                if (filtered !== phoneInput.value) phoneInput.value = filtered;
            });
        }
    } catch (error) {
        console.error('Error loading profile:', error);
    }
}

// Save all settings (profile, personalization, map + application, tickets)
async function saveSettings() {
    try {
        const currentPassword = document.getElementById('profileCurrentPassword')?.value;
        const newPassword = document.getElementById('profileNewPassword')?.value;
        const confirmPassword = document.getElementById('profileConfirmPassword')?.value;

        if (newPassword || confirmPassword || currentPassword) {
            if (!currentPassword) {
                await appAlert('Please enter your current password to change your password.');
                return;
            }
            if (!newPassword) {
                await appAlert('Please enter a new password.');
                return;
            }
            if (newPassword !== confirmPassword) {
                await appAlert('New passwords do not match.');
                return;
            }
            const policy = window.validatePasswordPolicy
                ? window.validatePasswordPolicy(newPassword)
                : { ok: true };
            if (!policy.ok) {
                await appAlert(policy.error || window.PASSWORD_POLICY_MESSAGE);
                return;
            }

            if (window.authModule && window.authModule.isAuthenticated()) {
                try {
                    const user = window.authModule.getCurrentUser();
                    const passwordResult = await window.authModule.apiRequest(`${window.authModule.API_BASE}/users/${user.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ password: newPassword })
                    });
                    if (passwordResult && passwordResult.token && window.authModule.setAuthToken) {
                        window.authModule.setAuthToken(passwordResult.token);
                    }
                    await appAlert('Password changed successfully!');
                    document.getElementById('profileCurrentPassword').value = '';
                    document.getElementById('profileNewPassword').value = '';
                    document.getElementById('profileConfirmPassword').value = '';
                } catch (error) {
                    await appAlert(`Error changing password: ${error.message}`);
                    return;
                }
            }
        }

        if (window.authModule && window.authModule.isAuthenticated()) {
            try {
                const user = window.authModule.getCurrentUser();
                const name = document.getElementById('profileName')?.value || '';
                const phoneRaw = document.getElementById('profilePhone')?.value || '';
                const phoneDigits = String(phoneRaw).replace(/\D/g, '');
                if (phoneDigits && !/^\d{10}$/.test(phoneDigits)) {
                    await appAlert('Phone number must be exactly 10 digits.');
                    return;
                }
                const preferredLanguage = document.getElementById('profileLanguage')?.value === 'es' ? 'es' : 'en';

                await window.authModule.apiRequest(`${window.authModule.API_BASE}/users/${user.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        fullName: name,
                        phone: phoneDigits || null,
                        preferredLanguage: preferredLanguage
                    })
                });

                const refreshedUser = await window.authModule.refreshUser();
                if (window.appI18n) {
                    window.appI18n.setLanguage(refreshedUser.preferredLanguage || preferredLanguage);
                }
            } catch (error) {
                console.error('Error updating user info:', error);
                await appAlert(`Error updating profile: ${error.message}`);
                return;
            }
        }

        const storageKey = getUserStorageKey('userProfile');
        const existingProfile = JSON.parse(localStorage.getItem(storageKey) || '{}');

        const basemapId = normalizeBasemapId(document.getElementById('settingsDefaultView')?.value);
        const settingsData = {
            ...existingProfile,
            name: document.getElementById('profileName')?.value || '',
            email: document.getElementById('profileEmail')?.value || '',
            userType: document.getElementById('profileUserType')?.dataset?.role || 'operator',
            uiTheme: document.getElementById('profileUiTheme')?.value || 'default',
            fontSizeScale: normalizeFontSizeScale(document.getElementById('profileFontSize')?.value),
            allowPinchZoom: (() => {
                const el = document.getElementById('profileAllowPinchZoom');
                if (el && el.dataset.loadedFromProfile === '1') return !!el.checked;
                return existingProfile.allowPinchZoom === true;
            })(),
            preferredLanguage: document.getElementById('profileLanguage')?.value === 'es' ? 'es' : 'en',
            defaultView: basemapId,
            mapTheme: basemapId,
            units: document.getElementById('settingsUnits')?.value || 'imperial',
            defaultZoom: parseInt(document.getElementById('settingsDefaultZoom')?.value || '12', 10),
            defaultLayerPhotos: !!document.getElementById('settingsDefaultLayerPhotos')?.checked,
            defaultLayerAnnotations: !!document.getElementById('settingsDefaultLayerAnnotations')?.checked,
            defaultFollowMe: !!document.getElementById('settingsDefaultFollowMe')?.checked,
            defaultTicketStatus: document.getElementById('settingsDefaultTicketStatus')?.value || 'ACTIVE',
            ticketDrawOverlayMode: normalizeTicketDrawOverlayMode(
                document.getElementById('settingsTicketDrawOverlayMode')?.value
            ),
            ticketPhotoRecentDays: (() => {
                const el = document.getElementById('settingsTicketPhotoRecentDays');
                const raw = el ? Number(el.value) : 90;
                const mod = window.photoTicketAssociationModule;
                if (mod && typeof mod.normalizeTicketPhotoRecentDays === 'function') {
                    return mod.normalizeTicketPhotoRecentDays(raw);
                }
                if (raw === 0) return 0;
                return raw === 180 || raw === 365 ? raw : 90;
            })(),
            mapRecentPhotosDaysBack: (() => {
                const el = document.getElementById('settingsMapRecentPhotosDaysBack');
                const raw = el ? Number(el.value) : 7;
                const mod = window.mapRecentPhotosPreferenceModule;
                if (mod && typeof mod.normalizeMapRecentPhotosDaysBack === 'function') {
                    return mod.normalizeMapRecentPhotosDaysBack(raw);
                }
                return raw === 0 || raw === 1 || raw === 30 || raw === 90 ? raw : 7;
            })(),
            ticketPopupMobileHeight: normalizeTicketPopupMobileHeight(
                document.getElementById('settingsTicketPopupMobileHeight')?.value
            ),
            ticketHubDetailMobileHeight: normalizeTicketHubDetailMobileHeight(
                document.getElementById('settingsTicketHubDetailMobileHeight')?.value
            ),
            ticketDetailDefaultTab: normalizeTicketDetailDefaultTab(
                document.getElementById('settingsTicketDetailDefaultTab')?.value
            ),
            showTooltips: document.getElementById('settingsShowTooltips')?.checked || false,
            enableAnimations: document.getElementById('settingsEnableAnimations')?.checked || false,
            showMeasureDisplay: document.getElementById('settingsShowMeasureDisplay')?.checked || false,
            lastUpdated: new Date().toISOString()
        };

        delete settingsData.autoSave;
        delete settingsData.ticketResponsesLayoutDesktop;
        delete settingsData.ticketResponsesLayoutMobile;
        delete settingsData.ticketHubResponsesLayout;
        delete settingsData.ticketHubResponsesLayoutDesktop;
        delete settingsData.ticketHubResponsesLayoutMobile;

        localStorage.setItem(storageKey, JSON.stringify(settingsData));

        try {
            if (settingsData.uiTheme && APP_UI_THEMES.indexOf(settingsData.uiTheme) !== -1) {
                localStorage.setItem('appUiTheme', settingsData.uiTheme);
            }
        } catch (e) { /* ignore */ }

        if (window.authModule && window.authModule.isAuthenticated()) {
            try {
                await putUserUiPreferencesToServer();
            } catch (e) {
                console.warn('saveSettings: server preferences sync failed', e.message || e);
            }
        }

        applyProfilePreferences(settingsData);
        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
        if (window.photosModule && typeof window.photosModule.reloadPhotosOnMap === 'function') {
            window.photosModule.reloadPhotosOnMap();
        }
        if (
            window.photoMapLoaderModule &&
            typeof window.photoMapLoaderModule.refetchForPreferenceChange === 'function'
        ) {
            window.photoMapLoaderModule.refetchForPreferenceChange();
        }

        closeSettingsModal();
        await appAlert('Settings saved successfully!');
    } catch (error) {
        console.error('Error saving settings:', error);
        await appAlert('Error saving settings. Please try again.');
    }
}

async function saveProfile() {
    return saveSettings();
}

// Apply map theme
function applyMapTheme(theme) {
    if (typeof window.applyBasemap === 'function') {
        window.applyBasemap(theme);
    }
}

// Apply profile preferences to the app
function applyProfilePreferences(profileData) {
    // Store preferences for use by other modules
    window.userPreferences = profileData;
    
    // Store user type globally for authorization checks
    if (profileData.userType) {
        window.userType = profileData.userType;
    }
    
    // Apply basemap (profile Map Theme or settings Default Map View)
    applyMapTheme(getEffectiveBasemapId(profileData));

    applyAppTheme(getEffectiveUiTheme(profileData));
    applyAppFontScale(getEffectiveFontSizeScale(profileData));
    if (window.mobilePinchZoomGuard && typeof window.mobilePinchZoomGuard.apply === 'function') {
        window.mobilePinchZoomGuard.apply(profileData.allowPinchZoom === true);
    }

    // Apply units preference (can be used by measure tool, etc.)
    if (profileData.units) {
        window.preferredUnits = profileData.units;
    }
    
    // Apply default zoom
    if (profileData.defaultZoom !== undefined) {
        window.defaultZoom = profileData.defaultZoom;
    }
    
    // Apply animation preference
    if (profileData.enableAnimations !== undefined) {
        window.enableAnimations = profileData.enableAnimations;
    }
    if (typeof window.applyLeafletPerformancePreferences === 'function') {
        window.applyLeafletPerformancePreferences();
    }
    
    // Store measure display preference (but display is controlled by measure mode state)
    if (profileData.showMeasureDisplay !== undefined) {
        window.showMeasureDisplay = profileData.showMeasureDisplay;
    }
    
    // Apply default ticket status to ticket list filter (so it's correct on load and after save)
    if (typeof window.applyDefaultTicketStatusFromProfile === 'function') {
        window.applyDefaultTicketStatusFromProfile();
    }
    
    // Refresh data table so unit-dependent columns (e.g. aerial map area) update
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    
    // Ensure measure display is hidden if measure mode is not active
    const measureDisplay = document.getElementById('measureDisplay');
    if (measureDisplay) {
        const isMeasureModeActive = window.measureModule && window.measureModule.measureMode;
        if (!isMeasureModeActive) {
            measureDisplay.style.display = 'none';
        } else if (window.measureModule && window.measureModule.updateMeasureDisplay) {
            // Update display if measure mode is active
            window.measureModule.updateMeasureDisplay();
        }
    }
    
}

// Get user profile data (user-specific)
function getUserProfile() {
    try {
        const storageKey = getUserStorageKey('userProfile');
        return JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch (error) {
        console.error('Error getting user profile:', error);
        return {};
    }
}

function normalizeTicketDrawOverlayMode(value) {
    return value === 'hide' ? 'hide' : 'passthrough';
}

function getTicketDrawOverlayMode() {
    const profile = typeof getUserProfile === 'function' ? getUserProfile() : {};
    return normalizeTicketDrawOverlayMode(profile && profile.ticketDrawOverlayMode);
}

function normalizeTicketDetailDefaultTab(value) {
    const allowed = ['details', 'responses', 'notes'];
    return allowed.includes(value) ? value : 'responses';
}

/** Migrate legacy layout prefs to unified default tab when new key is absent. */
function migrateTicketDetailDefaultTab(profile) {
    const p = profile || {};
    if (p.ticketDetailDefaultTab != null && String(p.ticketDetailDefaultTab).trim() !== '') {
        return normalizeTicketDetailDefaultTab(p.ticketDetailDefaultTab);
    }
    if (
        p.ticketHubResponsesLayout === 'responses_first' ||
        p.ticketResponsesLayoutMobile === 'responses_first'
    ) {
        return 'responses';
    }
    if (p.ticketResponsesLayoutDesktop === 'before') {
        return 'responses';
    }
    return 'responses';
}

function getTicketDetailDefaultTabPreference(profileData) {
    const profile = profileData || getUserProfile();
    return migrateTicketDetailDefaultTab(profile);
}

function normalizeTicketPopupMobileHeight(value) {
    return value === 'full' ? 'full' : 'half';
}

function getTicketPopupMobileHeightPreference(profileData) {
    const profile = profileData || getUserProfile();
    return normalizeTicketPopupMobileHeight(profile.ticketPopupMobileHeight);
}

function normalizeTicketHubDetailMobileHeight(value) {
    return value === 'full' ? 'full' : 'half';
}

function getTicketHubDetailMobileHeightPreference(profileData) {
    const profile = profileData || getUserProfile();
    return normalizeTicketHubDetailMobileHeight(profile.ticketHubDetailMobileHeight);
}

function openAbout(tab) {
    closeAccountMenu();
    initAboutModalTabs();
    initUserGuideNav();
    hydrateUserGuideVisuals();
    resetUserGuideSearch();
    showUserGuideToc();
    switchAboutTab(tab || 'guide');

    const userGuideModal = document.getElementById('userGuideModal');
    if (userGuideModal) {
        userGuideModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
}

function closeAbout() {
    const userGuideModal = document.getElementById('userGuideModal');
    if (userGuideModal) {
        userGuideModal.style.display = 'none';
        document.body.style.overflow = '';
    }
    resetUserGuideSearch();
    showUserGuideToc();
}

const ABOUT_TAB_IDS = ['guide', 'law', 'about'];

function switchAboutTab(tabId) {
    const tab = ABOUT_TAB_IDS.includes(tabId) ? tabId : 'guide';
    const tabToPanelId = {
        guide: 'aboutTabGuide',
        law: 'aboutTabLaw',
        about: 'aboutTabAbout',
    };
    const modal = document.getElementById('userGuideModal');
    if (!modal) return;
    modal.querySelectorAll('.settings-tab[data-about-tab]').forEach(function (btn) {
        const isActive = btn.getAttribute('data-about-tab') === tab;
        btn.classList.toggle('settings-tab--active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    modal.querySelectorAll('.settings-tab-panel').forEach(function (panel) {
        const active = panel.id === tabToPanelId[tab];
        panel.classList.toggle('settings-tab-panel--active', active);
        panel.hidden = !active;
    });
    if (tab === 'guide') {
        showUserGuideToc();
    }
}

function initAboutModalTabs() {
    const tablist = document.querySelector('.about-modal-tabs');
    if (!tablist || tablist.dataset.aboutTabsInit === '1') return;
    tablist.dataset.aboutTabsInit = '1';
    tablist.addEventListener('click', function (e) {
        const btn = e.target.closest('.settings-tab[data-about-tab]');
        if (!btn) return;
        switchAboutTab(btn.getAttribute('data-about-tab'));
    });
}

function showUserGuideToc() {
    const toc = document.getElementById('userGuideToc');
    const articlesWrap = document.getElementById('userGuideArticles');
    if (toc) toc.hidden = false;
    if (articlesWrap) {
        articlesWrap.hidden = true;
        articlesWrap.querySelectorAll('.user-guide-article').forEach(function (article) {
            article.hidden = true;
        });
    }
    filterUserGuideTopics();
}

function showUserGuideSection(sectionId) {
    const toc = document.getElementById('userGuideToc');
    const articlesWrap = document.getElementById('userGuideArticles');
    if (!articlesWrap || !sectionId) return;
    const article = articlesWrap.querySelector('[data-guide-article="' + sectionId + '"]');
    if (!article) return;
    if (toc) toc.hidden = true;
    articlesWrap.hidden = false;
    articlesWrap.querySelectorAll('.user-guide-article').forEach(function (el) {
        el.hidden = el !== article;
    });
    const modalBody = document.querySelector('#userGuideModal .user-guide-modal-body');
    if (modalBody) modalBody.scrollTop = 0;
    const backBtn = document.getElementById('userGuideBackBtn');
    if (backBtn && typeof backBtn.focus === 'function') backBtn.focus();
}

function hydrateUserGuideVisuals() {
    const icons = window.mapIcons;
    const guidePanel = document.getElementById('aboutTabGuide');
    if (!guidePanel) return;

    guidePanel.querySelectorAll('.user-guide-toc-item[data-guide-icon]').forEach(function (item) {
        const iconSlot = item.querySelector('.user-guide-toc-item-icon');
        if (!iconSlot || iconSlot.getAttribute('data-guide-icon-ready') === '1') return;
        const name = item.getAttribute('data-guide-icon');
        let html = '';
        if (icons && typeof icons.icon === 'function' && name) {
            html = icons.icon(name, 18);
        }
        iconSlot.innerHTML = html || '•';
        iconSlot.setAttribute('data-guide-icon-ready', '1');
    });

    guidePanel.querySelectorAll('.user-guide-status-chip[data-guide-pin-status]').forEach(function (chip) {
        if (chip.getAttribute('data-guide-pin-ready') === '1') return;
        const status = chip.getAttribute('data-guide-pin-status');
        const pinSlot = chip.querySelector('.user-guide-status-chip-pin');
        if (!pinSlot || !status) return;
        let color = '';
        let pinHtml = '';
        if (icons && typeof icons.ticketMapPinColor === 'function') {
            color = icons.ticketMapPinColor(status);
        }
        if (icons && typeof icons.ticketMapPin === 'function') {
            pinHtml = icons.ticketMapPin(status, 14);
        }
        if (color) chip.style.setProperty('--user-guide-pin-color', color);
        if (color) pinSlot.style.color = color;
        pinSlot.innerHTML = pinHtml || '';
        chip.setAttribute('data-guide-pin-ready', '1');
    });
}

function normalizeUserGuideSearchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function getUserGuideSearchTokens(value) {
    const normalized = normalizeUserGuideSearchText(value);
    if (!normalized) return [];
    return normalized.split(' ').filter(Boolean);
}

function tokenMatchesUserGuideHaystack(haystack, token) {
    if (!token) return true;
    if (haystack.indexOf(token) !== -1) return true;
    // Light plural/singular: "role" ↔ "roles", "ticket" ↔ "tickets"
    if (token.length > 3 && token.charAt(token.length - 1) === 's') {
        return haystack.indexOf(token.slice(0, -1)) !== -1;
    }
    if (token.length > 2) {
        return haystack.indexOf(token + 's') !== -1;
    }
    return false;
}

/** Match against the visible topic row (title, blurb, keywords) — filter the list, do not rank or auto-open. */
function getUserGuideSearchHaystack(sectionId) {
    const tocItem = document.querySelector(
        '#userGuideToc .user-guide-toc-item[data-guide-section="' + sectionId + '"]'
    );
    if (!tocItem) return '';
    const titleEl = tocItem.querySelector('.user-guide-toc-item-title');
    const blurbEl = tocItem.querySelector('.user-guide-toc-item-blurb');
    const parts = [
        String(sectionId || '').replace(/-/g, ' '),
        titleEl ? titleEl.textContent : '',
        blurbEl ? blurbEl.textContent : '',
        tocItem.getAttribute('data-guide-keywords') || '',
    ];
    return normalizeUserGuideSearchText(parts.join(' '));
}

function userGuideSectionMatchesQuery(sectionId, query) {
    const tokens = getUserGuideSearchTokens(query);
    if (!tokens.length) return true;
    const haystack = getUserGuideSearchHaystack(sectionId);
    return tokens.every(function (token) {
        return tokenMatchesUserGuideHaystack(haystack, token);
    });
}

function filterUserGuideTopics() {
    const toc = document.getElementById('userGuideToc');
    const searchInput = document.getElementById('userGuideSearch');
    const emptyEl = document.getElementById('userGuideSearchEmpty');
    if (!toc || toc.hidden) return;
    const query = searchInput ? searchInput.value : '';
    let visibleCount = 0;
    toc.querySelectorAll('.user-guide-toc-item[data-guide-section]').forEach(function (item) {
        const sectionId = item.getAttribute('data-guide-section');
        const matches = userGuideSectionMatchesQuery(sectionId, query);
        item.hidden = !matches;
        item.setAttribute('aria-hidden', matches ? 'false' : 'true');
        if (matches) visibleCount += 1;
    });
    if (emptyEl) {
        emptyEl.hidden = !(normalizeUserGuideSearchText(query) && visibleCount === 0);
    }
}

function resetUserGuideSearch() {
    const searchInput = document.getElementById('userGuideSearch');
    if (searchInput) searchInput.value = '';
    filterUserGuideTopics();
}

function initUserGuideNav() {
    const guidePanel = document.getElementById('aboutTabGuide');
    if (!guidePanel || guidePanel.dataset.guideNavInit === '1') return;
    guidePanel.dataset.guideNavInit = '1';
    guidePanel.addEventListener('click', function (e) {
        const backBtn = e.target.closest('[data-guide-back]');
        if (backBtn) {
            showUserGuideToc();
            const modalBody = document.querySelector('#userGuideModal .user-guide-modal-body');
            if (modalBody) modalBody.scrollTop = 0;
            return;
        }
        const tocItem = e.target.closest('.user-guide-toc-item[data-guide-section]');
        if (!tocItem || tocItem.hidden) return;
        showUserGuideSection(tocItem.getAttribute('data-guide-section'));
    });
    const searchInput = document.getElementById('userGuideSearch');
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            filterUserGuideTopics();
        });
        // Keep focus in the filter box; do not jump to a "best" topic on Enter.
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') e.preventDefault();
        });
    }
}

// Load settings data from localStorage
function loadSettings() {
    try {
        const storageKey = getUserStorageKey('userProfile');
        const profileData = JSON.parse(localStorage.getItem(storageKey) || '{}');
        
        // Set map settings fields
        ensureMapboxBasemapSelectOptions();
        const defaultView = document.getElementById('settingsDefaultView');
        const units = document.getElementById('settingsUnits');
        const defaultZoom = document.getElementById('settingsDefaultZoom');
        
        if (defaultView) {
            defaultView.value = getEffectiveBasemapId(profileData);
        }
        if (units) units.value = profileData.units || 'imperial';
        if (defaultZoom) defaultZoom.value = profileData.defaultZoom || 12;
        
        const defaultLayerPhotos = document.getElementById('settingsDefaultLayerPhotos');
        const defaultLayerAnnotations = document.getElementById('settingsDefaultLayerAnnotations');
        const defaultFollowMe = document.getElementById('settingsDefaultFollowMe');
        if (defaultLayerPhotos) defaultLayerPhotos.checked = profileData.defaultLayerPhotos !== false;
        if (defaultLayerAnnotations) defaultLayerAnnotations.checked = profileData.defaultLayerAnnotations !== false;
        if (defaultFollowMe) defaultFollowMe.checked = profileData.defaultFollowMe !== false;
        
        const defaultTicketStatus = document.getElementById('settingsDefaultTicketStatus');
        if (defaultTicketStatus) {
            const raw = profileData.defaultTicketStatus || 'ACTIVE';
            const allowed = [
                'ACTIVE',
                'ALL',
                'ASSIGNED',
                'READY',
                'NOT_READY',
                'ACTION_REQUIRED',
                'EXPIRING_SOON',
                'EXTERNAL_ONLY',
                'ACTIVE_INTERNAL'
            ];
            defaultTicketStatus.value =
                typeof window.normalizeSidebarTicketStatusFilter === 'function'
                    ? window.normalizeSidebarTicketStatusFilter(raw)
                    : (allowed.includes(raw) ? raw : 'ACTIVE');
        }

        const ticketDrawOverlayMode = document.getElementById('settingsTicketDrawOverlayMode');
        if (ticketDrawOverlayMode) {
            ticketDrawOverlayMode.value = normalizeTicketDrawOverlayMode(profileData.ticketDrawOverlayMode);
        }

        const ticketPhotoRecentDays = document.getElementById('settingsTicketPhotoRecentDays');
        if (ticketPhotoRecentDays) {
            const mod = window.photoTicketAssociationModule;
            const normalized =
                mod && typeof mod.normalizeTicketPhotoRecentDays === 'function'
                    ? mod.normalizeTicketPhotoRecentDays(profileData.ticketPhotoRecentDays)
                    : 90;
            ticketPhotoRecentDays.value = String(normalized);
        }

        const mapRecentPhotosDaysBack = document.getElementById('settingsMapRecentPhotosDaysBack');
        if (mapRecentPhotosDaysBack) {
            const mapMod = window.mapRecentPhotosPreferenceModule;
            const mapNormalized =
                mapMod && typeof mapMod.normalizeMapRecentPhotosDaysBack === 'function'
                    ? mapMod.normalizeMapRecentPhotosDaysBack(profileData.mapRecentPhotosDaysBack)
                    : 7;
            mapRecentPhotosDaysBack.value = String(mapNormalized);
        }

        const ticketDetailDefaultTab = document.getElementById('settingsTicketDetailDefaultTab');
        if (ticketDetailDefaultTab) {
            ticketDetailDefaultTab.value = getTicketDetailDefaultTabPreference(profileData);
        }

        const ticketPopupMobileHeight = document.getElementById('settingsTicketPopupMobileHeight');
        if (ticketPopupMobileHeight) {
            ticketPopupMobileHeight.value = getTicketPopupMobileHeightPreference(profileData);
        }

        const ticketHubDetailMobileHeight = document.getElementById('settingsTicketHubDetailMobileHeight');
        if (ticketHubDetailMobileHeight) {
            ticketHubDetailMobileHeight.value = getTicketHubDetailMobileHeightPreference(profileData);
        }

        // Set application settings
        const showTooltips = document.getElementById('settingsShowTooltips');
        const enableAnimations = document.getElementById('settingsEnableAnimations');
        const showMeasureDisplay = document.getElementById('settingsShowMeasureDisplay');
        
        if (showTooltips) showTooltips.checked = profileData.showTooltips !== false;
        if (enableAnimations) enableAnimations.checked = profileData.enableAnimations !== false;
        if (showMeasureDisplay) showMeasureDisplay.checked = profileData.showMeasureDisplay !== false;
        
        // Show/hide user management based on user type
        const userManagementSection = document.getElementById('userManagementSection');
        if (userManagementSection) {
            const userType = profileData.userType || 'operator';
            userManagementSection.style.display = userType === 'admin' ? 'flex' : 'none';
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Apply org top-bar / attribution title to map prefix (see map.js, orgSelector applyCurrentOrgTitleBar)
function applyTopBarTitle(title) {
    const display = title || 'Locus';
    if (typeof window.updateMapOrgAttributionTitle === 'function') {
        window.updateMapOrgAttributionTitle(display);
    }
}

// Open user management (placeholder for future implementation)
async function openUserManagement() {
    closeSettingsModal();
    await appAlert('User Management - Coming soon!');
}

// External portal helper functions.
function openOneCallNV() {
    closeAccountMenu();
    const oneCallNVUrl =
        typeof window.EXTERNAL_JOBS_DASHBOARD_URL === 'string' && window.EXTERNAL_JOBS_DASHBOARD_URL.trim() !== ''
            ? window.EXTERNAL_JOBS_DASHBOARD_URL.trim()
            : 'https://onecallnv.undergroundservicealert.org/ngen.web//Account/Login?returnUrl=%2Fngen.web%2F';
    
    // Open in new window/tab (iframe embedding is blocked by X-Frame-Options header)
    // This is the most reliable approach since the site blocks iframe embedding
    window.open(oneCallNVUrl, 'ExternalPortal', 'width=1200,height=800,scrollbars=yes,resizable=yes,location=yes');
}

function closeOneCallNV() {
    const modal = document.getElementById('oneCallNVModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Export functions globally
window.showModal = showModal;
window.closeModal = closeModal;
window.showToast = showToast;
window.openProfile = openProfile;
window.openSettings = openSettings;
window.switchSettingsTab = switchSettingsTab;
window.closeProfileModal = closeProfileModal;
window.closeSettingsModal = closeSettingsModal;
window.openAbout = openAbout;
window.closeAbout = closeAbout;
window.switchAboutTab = switchAboutTab;
window.showUserGuideToc = showUserGuideToc;
window.showUserGuideSection = showUserGuideSection;
window.saveProfile = saveProfile;
window.saveSettings = saveSettings;
window.loadSettings = loadSettings;
window.openUserManagement = openUserManagement;
window.getUserProfile = getUserProfile;
window.getTicketDrawOverlayMode = getTicketDrawOverlayMode;
window.applyTopBarTitle = applyTopBarTitle;
window.applyProfilePreferences = applyProfilePreferences;
window.updateProfileOrgRoleDisplay = updateProfileOrgRoleDisplay;
window.getTicketDetailDefaultTabPreference = getTicketDetailDefaultTabPreference;
window.getTicketPopupMobileHeightPreference = getTicketPopupMobileHeightPreference;
window.getTicketHubDetailMobileHeightPreference = getTicketHubDetailMobileHeightPreference;
window.closeAccountMenu = closeAccountMenu;
window.applyMapTheme = applyMapTheme;
window.applyAppTheme = applyAppTheme;
window.applyAppFontScale = applyAppFontScale;
window.getEffectiveFontSizeScale = getEffectiveFontSizeScale;
window.THEME_LOADER_MAP = THEME_LOADER_MAP;
window.getThemeLoaderVariant = getThemeLoaderVariant;
window.createAppLoaderElement = createAppLoaderElement;
window.getAppLoaderHtml = getAppLoaderHtml;
window.refreshAppLoaders = refreshAppLoaders;
window.APP_UI_THEMES = APP_UI_THEMES;
window.APP_FONT_SCALES = APP_FONT_SCALES;
window.openOneCallNV = openOneCallNV;
window.getUserStorageKey = getUserStorageKey;
window.syncUserUiPreferencesFromServer = syncUserUiPreferencesFromServer;
window.putUserUiPreferencesToServer = putUserUiPreferencesToServer;
window.schedulePersistUserUiPreferencesToServer = schedulePersistUserUiPreferencesToServer;
window.getCreateTicketSharedPresetsFromStorage = getCreateTicketSharedPresetsFromStorage;
window.setCreateTicketSharedPresetsInStorage = setCreateTicketSharedPresetsInStorage;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshAppLoaders);
} else {
    refreshAppLoaders();
}

// Show or hide annotation/photo/document features based on whether user can edit current org
function updateEditPermissionsVisibility() {
    const canEdit = typeof window.canEditCurrentOrg === 'function' && window.canEditCurrentOrg();
    const tech = window.authModule && window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg();
    const showImport = canEdit && !tech;
    const showCreateTicket =
        showImport &&
        (typeof window.canUseCreateTicketWizard === 'function'
            ? window.canUseCreateTicketWizard()
            : !!(
                  window.authModule &&
                  typeof window.authModule.isDev === 'function' &&
                  window.authModule.isDev()
              ));
    const editToolsDisplay = canEdit ? 'flex' : 'none';
    /* Bundled map toolbar: only hide drawing + measure/photo/upload blocks, not basemap/Data */
    ['.drawing-controls', '.map-toolbar-separate-tools'].forEach(function (className) {
        const el = document.querySelector(className);
        if (el) el.style.display = editToolsDisplay;
    });
    if (typeof window.updateMapToolsMobileEditVisibility === 'function') {
        window.updateMapToolsMobileEditVisibility(canEdit);
    }
    if (typeof window.syncMapToolActionVisibility === 'function') {
        window.syncMapToolActionVisibility(canEdit);
    }
    document.querySelectorAll('button[onclick*="openTicketImporter"]').forEach(function (btn) {
        btn.style.display = showImport ? '' : 'none';
    });
    const createTicketBtn = document.getElementById('ticketHubCreateTicketBtn');
    if (createTicketBtn) createTicketBtn.style.display = showCreateTicket ? '' : 'none';
    const publicCatalog =
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer();
    document.documentElement.classList.toggle('app-public-catalog-viewer', !!publicCatalog);
    document.documentElement.classList.toggle('app-tech-ticket-hub', !!tech);
    const hubBtn = document.getElementById('ticketHubOpenButton');
    if (hubBtn) {
        const hideHub = publicCatalog;
        hubBtn.hidden = hideHub;
        hubBtn.style.display = hideHub ? 'none' : '';
    }
    const mapStatusFilters = document.getElementById('mapStatusFilters');
    if (mapStatusFilters) {
        const feedMode =
            (typeof window.isTicketHubFeedMode === 'function' && window.isTicketHubFeedMode()) ||
            (window.orgSelectorModule &&
                typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
                window.orgSelectorModule.canUseCurrentDevTicketHub());
        const hideMapFilters = tech || publicCatalog || !!feedMode;
        mapStatusFilters.hidden = hideMapFilters;
        mapStatusFilters.style.display = hideMapFilters ? 'none' : '';
        if (hideMapFilters) {
            if (typeof window.parkMapStatusActionBtns === 'function') {
                window.parkMapStatusActionBtns();
            }
            const mapStats = document.getElementById('mapStatusFiltersStats');
            if (mapStats) mapStats.innerHTML = '';
            if (typeof window.closeMapStatusDropdowns === 'function') {
                window.closeMapStatusDropdowns();
            }
        }
    }
    if (typeof window.renderMapTopLeftLauncherBubbles === 'function') {
        window.renderMapTopLeftLauncherBubbles();
    }
    if (typeof window.syncMapTopLeftActiveStatBubble === 'function') {
        window.syncMapTopLeftActiveStatBubble();
    }
    if (typeof window.syncDataHubMapFilterIndicator === 'function') {
        window.syncDataHubMapFilterIndicator();
    }
    const techOnlyFilterValues = ['EXTERNAL_ONLY', 'ACTIVE_INTERNAL'];
    function setTicketSettingsOrgFilterOptionsVisible(show) {
        const settings = document.getElementById('settingsDefaultTicketStatus');
        if (!settings) return;
        techOnlyFilterValues.forEach(function (val) {
            const opt = settings.querySelector('option[value="' + val + '"]');
            if (opt) opt.hidden = !show;
        });
        if (!show && techOnlyFilterValues.indexOf(settings.value) !== -1) {
            settings.value = 'ACTIVE';
        }
    }
    setTicketSettingsOrgFilterOptionsVisible(!tech);
    const assigneeFilterField = document.getElementById('ticketHubAssigneeFilter');
    if (assigneeFilterField) {
        const wrap = assigneeFilterField.closest('.ticket-hub-field');
        if (wrap) wrap.hidden = true;
    }
}

window.updateEditPermissionsVisibility = updateEditPermissionsVisibility;
window.ensureMapboxBasemapSelectOptions = ensureMapboxBasemapSelectOptions;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        ensureMapboxBasemapSelectOptions();
        initSettingsModalTabs();
    });
} else {
    ensureMapboxBasemapSelectOptions();
    initSettingsModalTabs();
}
