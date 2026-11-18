const ADMIN_DATA_BASE = () => `${getAdminApiBase()}/data`;

let aerialCatalogMaps = [];
let aerialCatalogOrgPickerMapId = null;
let aerialCatalogAllOrgs = [];
function aerialAccessModeLabel(mode, allowedCount) {
    const m = String(mode || 'global').toLowerCase();
    if (m === 'hidden') return 'Hidden';
    if (m === 'restricted') {
        const n = Number(allowedCount) || 0;
        if (n === 0) return 'Restricted (0 orgs)';
        return `Restricted (${n} org${n === 1 ? '' : 's'})`;
    }
    return 'Global';
}

function aerialAccessWarningBadge(mode, allowedCount) {
    if (String(mode || '').toLowerCase() !== 'restricted') return '';
    const n = Number(allowedCount) || 0;
    if (n > 0) return '';
    return '<span style="display:inline-block;padding:0.1rem 0.4rem;border-radius:4px;font-size:0.75rem;background:#fff3cd;color:#856404;" title="No organizations assigned">No orgs</span>';
}

const ADMIN_USER_SEARCH_FIELDS = [
    function (u) { return u.id; },
    function (u) { return u.username; },
    function (u) { return u.email; },
    function (u) { return u.role; },
    function (u) { return u.organizationRole; }
];
const ADMIN_AERIAL_SEARCH_FIELDS = [
    function (m) { return m.id; },
    function (m) { return m.name; },
    function (m) { return m.url; },
    function (m) { return m.capturedAt; },
    function (m) { return m.createdAt; }
];

function applyAdminListSearch(listKey, inputId) {
    const state = getAdminListState(listKey);
    const input = document.getElementById(inputId);
    state.appliedQuery = input ? String(input.value || '').trim() : '';
    state.page = 1;
    if (listKey === 'users') renderUsers();
    else if (listKey === 'aerialCatalog') renderAerialCatalog();
}

function clearAdminListSearch(listKey, inputId) {
    const input = document.getElementById(inputId);
    if (input) input.value = '';
    const state = getAdminListState(listKey);
    state.appliedQuery = '';
    state.page = 1;
    if (listKey === 'users') renderUsers();
    else if (listKey === 'aerialCatalog') renderAerialCatalog();
}

function setAdminListPage(listKey, page) {
    const state = getAdminListState(listKey);
    state.page = Math.max(1, Math.floor(Number(page) || 1));
    if (listKey === 'users') renderUsers();
    else if (listKey === 'aerialCatalog') renderAerialCatalog();
    else if (listKey === 'errors') renderAdminErrors();
    else if (listKey === 'serviceRequests') renderServiceRequests();
}

function onAdminListSearchKeydown(event, listKey, inputId) {
    if (!event || event.key !== 'Enter') return;
    event.preventDefault();
    applyAdminListSearch(listKey, inputId);
}

async function loadAerialCatalog() {
    const tbody = document.getElementById('aerialCatalogTableBody');
    if (!tbody) return;
    if (!window.authModule || !window.authModule.isDev()) {
        aerialCatalogMaps = [];
        tbody.innerHTML =
            '<tr class="admin-table-row-message"><td colspan="6" style="text-align:center;">Access denied.</td></tr>';
        renderAdminListPagination('aerialCatalogPagination', 'aerialCatalog', { total: 0 }, 'setAdminListPage');
        return;
    }
    try {
        const maps = await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps`);
        aerialCatalogMaps = Array.isArray(maps) ? maps : [];
        renderAerialCatalog();
    } catch (e) {
        aerialCatalogMaps = [];
        tbody.innerHTML = `<tr class="admin-table-row-message"><td colspan="6" style="text-align:center;color:var(--app-danger);">${escapeAdminHtml(getAdminErrorMessage(e))}</td></tr>`;
        renderAdminListPagination('aerialCatalogPagination', 'aerialCatalog', { total: 0 }, 'setAdminListPage');
    }
}

function renderAerialCatalog() {
    const tbody = document.getElementById('aerialCatalogTableBody');
    if (!tbody) return;

    const filtered = filterAdminListItems(aerialCatalogMaps, 'aerialCatalog', ADMIN_AERIAL_SEARCH_FIELDS);
    const slice = paginateAdminList(filtered, 'aerialCatalog');
    renderAdminListPagination('aerialCatalogPagination', 'aerialCatalog', slice, 'setAdminListPage');

    if (slice.total === 0) {
        const hasQuery = !!normalizeAdminSearchQuery(getAdminListState('aerialCatalog').appliedQuery);
        const emptyMsg = aerialCatalogMaps.length === 0
            ? 'No aerial maps.'
            : (hasQuery ? 'No aerial maps match your search.' : 'No aerial maps.');
        tbody.innerHTML =
            `<tr class="admin-table-row-message"><td colspan="6" style="text-align:center;color:#666;">${emptyMsg}</td></tr>`;
        return;
    }

    tbody.innerHTML = slice.pageItems
        .map((m) => {
            const cap = m.capturedAt || m.createdAt || '-';
            const capShort = String(cap).slice(0, 24);
            const u = m.url || '';
            const urlShort = u.length > 48 ? `${u.slice(0, 45)}...` : u;
            const accessMode = String(m.accessMode || (m.hiddenFromUsers ? 'hidden' : 'global')).toLowerCase();
            const allowed = Array.isArray(m.allowedOrganizations) ? m.allowedOrganizations : [];
            const allowedCount = allowed.length;
            const accessLabel = aerialAccessModeLabel(accessMode, allowedCount);
            const warningBadge = aerialAccessWarningBadge(accessMode, allowedCount);
            const manageOrgsBtn =
                accessMode === 'restricted'
                    ? `<button type="button" class="admin-button admin-button-secondary admin-button-compact" onclick="openAerialCatalogOrgsModal(${m.id})">Manage orgs</button>`
                    : '';
            return `<tr class="admin-list-row admin-list-row-static" data-admin-list="aerial">
                    <td class="admin-list-hide-mobile" data-label="ID">${m.id}</td>
                    <td class="admin-list-primary" data-label="Name">
                        ${escapeAdminHtml(m.name)}
                        <div class="admin-list-meta admin-list-mobile-only">${escapeAdminHtml(capShort)}</div>
                    </td>
                    <td class="admin-list-hide-mobile" data-label="Capture">${escapeAdminHtml(capShort)}</td>
                    <td class="admin-list-actions-inline" data-label="Access">
                        <div style="display:flex;flex-wrap:wrap;gap:0.35rem;align-items:center;">
                            <select class="admin-form-input admin-form-input-compact" aria-label="Access mode" onchange="setAerialCatalogAccessMode(${m.id}, this.value)">
                                <option value="global" ${accessMode === 'global' ? 'selected' : ''}>Global</option>
                                <option value="restricted" ${accessMode === 'restricted' ? 'selected' : ''}>Restricted</option>
                                <option value="hidden" ${accessMode === 'hidden' ? 'selected' : ''}>Hidden</option>
                            </select>
                            <span class="admin-aerial-vis-label">${escapeAdminHtml(accessLabel)}</span>
                            ${warningBadge}
                            ${manageOrgsBtn}
                        </div>
                    </td>
                    <td class="admin-list-hide-mobile" data-label="URL" title="${escapeAdminHtml(u)}">${escapeAdminHtml(urlShort)}</td>
                    <td class="admin-table-actions admin-list-actions" data-label="Actions">
                        <button type="button" class="admin-button admin-button-secondary" onclick="deleteAerialCatalogMap(${m.id})">Delete</button>
                    </td>
                </tr>`;
        })
        .join('');
}

async function setAerialCatalogAccessMode(id, accessMode) {
    if (!window.authModule || !window.authModule.isDev()) {
        await appAlert('Access denied.');
        return;
    }
    const mode = String(accessMode || '').toLowerCase();
    const existing = aerialCatalogMaps.find((m) => m.id === id);
    const prevMode = existing ? String(existing.accessMode || 'global').toLowerCase() : 'global';
    if (prevMode === 'global' && mode === 'restricted') {
        if (!(await appConfirm('Switch to Restricted? This map will disappear for most organizations until you assign orgs.'))) {
            await loadAerialCatalog();
            return;
        }
    }
    try {
        await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps/${id}/access`, {
            method: 'PATCH',
            body: JSON.stringify({ accessMode: mode }),
        });
        await loadAerialCatalog();
        if (mode === 'restricted') {
            openAerialCatalogOrgsModal(id);
        }
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
        await loadAerialCatalog();
    }
}

async function ensureAerialCatalogOrgsLoaded() {
    if (aerialCatalogAllOrgs.length > 0) return aerialCatalogAllOrgs;
    const orgs = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations`);
    aerialCatalogAllOrgs = Array.isArray(orgs) ? orgs : [];
    return aerialCatalogAllOrgs;
}

async function openAerialCatalogOrgsModal(mapId) {
    if (!window.authModule || !window.authModule.isDev()) {
        await appAlert('Access denied.');
        return;
    }
    aerialCatalogOrgPickerMapId = mapId;
    const map = aerialCatalogMaps.find((m) => m.id === mapId);
    const overlay = document.getElementById('adminAerialOrgsModal');
    const listEl = document.getElementById('adminAerialOrgsList');
    const titleEl = document.getElementById('adminAerialOrgsModalTitle');
    const searchEl = document.getElementById('adminAerialOrgsSearch');
    if (!overlay || !listEl) return;
    if (titleEl) {
        titleEl.textContent = map && map.name ? `Manage org access — ${map.name}` : 'Manage org access';
    }
    if (searchEl) searchEl.value = '';
    listEl.innerHTML = '<p style="color:#666;">Loading organizations…</p>';
    overlay.style.display = 'flex';
    try {
        const orgs = await ensureAerialCatalogOrgsLoaded();
        const allowedIds = new Set(
            (map && Array.isArray(map.allowedOrganizations) ? map.allowedOrganizations : []).map((o) => Number(o.id))
        );
        renderAerialCatalogOrgsList(orgs, allowedIds, searchEl ? searchEl.value : '');
    } catch (e) {
        listEl.innerHTML = `<p style="color:var(--app-danger);">${escapeAdminHtml(getAdminErrorMessage(e))}</p>`;
    }
}

function renderAerialCatalogOrgsList(orgs, allowedIds, query) {
    const listEl = document.getElementById('adminAerialOrgsList');
    if (!listEl) return;
    const q = normalizeAdminSearchQuery(query);
    const filtered = (orgs || []).filter((org) => {
        if (!q) return true;
        const hay = `${org.id} ${org.name || ''}`.toLowerCase();
        return hay.includes(q);
    });
    if (!filtered.length) {
        listEl.innerHTML = '<p style="color:#666;">No organizations match.</p>';
        return;
    }
    listEl.innerHTML = filtered
        .map((org) => {
            const oid = Number(org.id);
            const checked = allowedIds.has(oid) ? 'checked' : '';
            return `<label class="admin-checkbox-row" style="display:flex;gap:0.5rem;align-items:center;padding:0.25rem 0;">
                <input type="checkbox" class="admin-aerial-org-cb" value="${oid}" ${checked} />
                <span>${escapeAdminHtml(org.name || `Org ${oid}`)} <span style="color:#888;">(#${oid})</span></span>
            </label>`;
        })
        .join('');
}

function closeAerialCatalogOrgsModal() {
    const overlay = document.getElementById('adminAerialOrgsModal');
    if (overlay) overlay.style.display = 'none';
    aerialCatalogOrgPickerMapId = null;
}

async function submitAerialCatalogOrgsModal() {
    if (!window.authModule || !window.authModule.isDev()) {
        await appAlert('Access denied.');
        return;
    }
    const mapId = aerialCatalogOrgPickerMapId;
    if (!mapId) return;
    const boxes = document.querySelectorAll('#adminAerialOrgsList .admin-aerial-org-cb');
    const organizationIds = [];
    boxes.forEach((cb) => {
        if (cb.checked) organizationIds.push(Number(cb.value));
    });
    try {
        await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps/${mapId}/orgs`, {
            method: 'PUT',
            body: JSON.stringify({ organizationIds }),
        });
        closeAerialCatalogOrgsModal();
        await loadAerialCatalog();
        await appAlert('Organization access updated.');
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

function onAerialCatalogOrgsSearchInput() {
    const searchEl = document.getElementById('adminAerialOrgsSearch');
    const checkedNow = new Set();
    document.querySelectorAll('#adminAerialOrgsList .admin-aerial-org-cb').forEach((cb) => {
        if (cb.checked) checkedNow.add(Number(cb.value));
    });
    renderAerialCatalogOrgsList(aerialCatalogAllOrgs, checkedNow, searchEl ? searchEl.value : '');
}

async function toggleAerialCatalogVisibility(id, hiddenFromUsers) {
    if (!window.authModule || !window.authModule.isDev()) {
        await appAlert('Access denied.');
        return;
    }
    try {
        await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps/${id}/visibility`, {
            method: 'PATCH',
            body: JSON.stringify({ hiddenFromUsers: !!hiddenFromUsers }),
        });
        await loadAerialCatalog();
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

function openAdminAddAerialModal() {
    const overlay = document.getElementById('adminAddAerialModal');
    if (overlay) overlay.style.display = 'flex';
}

function closeAdminAddAerialModal() {
    const overlay = document.getElementById('adminAddAerialModal');
    if (overlay) overlay.style.display = 'none';
    const u = document.getElementById('adminAddAerialUrl');
    const c = document.getElementById('adminAddAerialCaptured');
    if (u) u.value = '';
    if (c) c.value = '';
}

async function submitAdminAddAerial() {
    const urlEl = document.getElementById('adminAddAerialUrl');
    const url = urlEl && urlEl.value ? urlEl.value.trim() : '';
    if (!url) return;
    const capEl = document.getElementById('adminAddAerialCaptured');
    const body = { url };
    if (capEl && capEl.value) {
        body.capturedAt = new Date(capEl.value).toISOString();
    }
    try {
        await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
        closeAdminAddAerialModal();
        await loadAerialCatalog();
        await appAlert('Aerial map added');
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

async function deleteAerialCatalogMap(id) {
    if (!(await appConfirm('Delete this aerial map from the global catalog?'))) return;
    try {
        await window.authModule.apiRequest(`${ADMIN_DATA_BASE()}/aerial-maps/${id}`, { method: 'DELETE' });
        await loadAerialCatalog();
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

// Load organizations for create-user and other org-scoped tabs.
async function loadOrganizations() {
    try {
        const orgs = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations`);
        organizations = Array.isArray(orgs) ? orgs : [];
        syncCurrentAdminOrgFromAuth(organizations);
    } catch (error) {
        console.error('Error loading organizations:', error);
        organizations = [];
        syncCurrentAdminOrgFromAuth([]);
    }
}

/** Organization and user id columns are dev-only. */
function showAdminRecordIdColumn() {
    return !!(window.authModule && typeof window.authModule.isDev === 'function' && window.authModule.isDev());
}

function adminRecordTableColspan() {
    return showAdminRecordIdColumn() ? 6 : 5;
}

function syncAdminRecordIdHeader(headerId) {
    const th = document.getElementById(headerId);
    if (!th) return;
    const show = showAdminRecordIdColumn();
    th.hidden = !show;
    th.classList.toggle('admin-dev-id-col-visible', show);
}

function syncUsersIdColumnHeader() {
    syncAdminRecordIdHeader('usersIdHeader');
}

function toggleAdminListRow(btn) {
    const tr = btn && btn.closest ? btn.closest('tr.admin-list-row') : null;
    if (!tr) return;
    const expanded = tr.classList.toggle('is-expanded');
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.textContent = expanded ? 'Collapse' : 'Edit';
}

/** Normalize org ids to integers so number/string profile vs API values compare safely. */
function normalizeAdminOrgIds(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n));
}

/**
 * Org ids a non-dev admin may manage.
 * Per-org admin memberships only — never fall back to all memberships (that inflated privileges in the UI).
 * Legacy: global users.role === 'admin' with no admin rows may use default org only (matches API getAdminOrgIds).
 */
function getNonDevAdminShowOrgIds() {
    const currentUser = window.authModule && window.authModule.getCurrentUser
        ? window.authModule.getCurrentUser()
        : null;
    const adminOrgIds = normalizeAdminOrgIds(currentUser && currentUser.adminOrganizationIds);
    if (adminOrgIds.length > 0) return adminOrgIds;
    if (currentUser && currentUser.role === 'admin') {
        const defaultId = parseInt(
            currentUser.defaultOrganizationId != null
                ? currentUser.defaultOrganizationId
                : currentUser.organizationId,
            10
        );
        return !isNaN(defaultId) ? [defaultId] : [];
    }
    return [];
}

/**
 * Prefer saved session org if still allowed, then the user's default org, then the first allowed id.
 * Returns null only when allowedIds is empty.
 */
function resolveNonDevAdminOrgId(allowedIds) {
    const ids = normalizeAdminOrgIds(allowedIds);
    if (ids.length === 0) return null;

    const inList = (id) => {
        const n = parseInt(id, 10);
        return !isNaN(n) && ids.some((x) => x === n);
    };

    const saved = getCurrentAdminOrgId();
    if (inList(saved)) return parseInt(saved, 10);

    const currentUser = window.authModule && window.authModule.getCurrentUser
        ? window.authModule.getCurrentUser()
        : null;
    const defaultId = currentUser
        ? parseInt(currentUser.defaultOrganizationId != null
            ? currentUser.defaultOrganizationId
            : currentUser.organizationId, 10)
        : NaN;
    if (inList(defaultId)) return defaultId;

    return ids[0];
}

function syncAdminOrgSelectValue(orgId) {
    const select = document.getElementById('adminOrgSelect');
    if (!select || orgId == null) return;
    const value = String(orgId);
    if (Array.from(select.options).some((o) => o.value === value)) {
        select.value = value;
    }
}

function syncCurrentAdminOrgFromAuth(orgList) {
    const isDev = window.authModule && window.authModule.isDev && window.authModule.isDev();
    const showOrgIds = getNonDevAdminShowOrgIds();
    const knownIds = normalizeAdminOrgIds((orgList || organizations).map((o) => o.id));

    if (isDev) {
        const saved = getCurrentAdminOrgId();
        if (saved != null && (knownIds.length === 0 || knownIds.some((id) => id === saved))) {
            setCurrentAdminOrgId(saved);
            return;
        }
        const authOrgId = getAuthUserOrganizationId();
        setCurrentAdminOrgId(authOrgId);
        return;
    }

    const resolved = resolveNonDevAdminOrgId(showOrgIds);
    if (resolved != null) {
        setCurrentAdminOrgId(resolved);
    }
}

// Load users
async function loadUsers() {
    syncUsersIdColumnHeader();
    const usersBody = document.getElementById('usersTableBody');
    const usersLoadingCell = usersBody && usersBody.querySelector('.admin-table-row-message td');
    if (usersLoadingCell) usersLoadingCell.colSpan = adminRecordTableColspan();
    try {
        let orgId = getCurrentAdminOrgId();
        // Always re-validate for non-dev so a stale session org cannot outrank allowed orgs.
        if (window.authModule && !window.authModule.isDev()) {
            orgId = resolveNonDevAdminOrgId(getNonDevAdminShowOrgIds());
            if (orgId != null) {
                setCurrentAdminOrgId(orgId);
                syncAdminOrgSelectValue(orgId);
            }
        }
        const url = orgId != null ? `${getAdminApiBase()}/users?organizationId=${orgId}` : `${getAdminApiBase()}/users`;
        const userList = await window.authModule.apiRequest(url);
        users = Array.isArray(userList) ? userList : [];
        renderUsers();
    } catch (error) {
        console.error('Error loading users:', error);
        users = [];
        document.getElementById('usersTableBody').innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="${adminRecordTableColspan()}" style="text-align: center; color: var(--app-danger);">${escapeAdminHtml(getAdminErrorMessage(error))}</td>
            </tr>
        `;
        renderAdminListPagination('usersPagination', 'users', { total: 0 }, 'setAdminListPage');
    }
}

// Render users table
function renderUsers() {
    const tbody = document.getElementById('usersTableBody');
    const roleHeader = document.getElementById('usersTableRoleHeader');
    if (roleHeader) {
        roleHeader.textContent = getCurrentAdminOrgId() != null ? 'Role (in selected org)' : 'Role';
    }
    syncUsersIdColumnHeader();
    const userColspan = adminRecordTableColspan();

    const filtered = filterAdminListItems(users, 'users', ADMIN_USER_SEARCH_FIELDS);
    const slice = paginateAdminList(filtered, 'users');
    renderAdminListPagination('usersPagination', 'users', slice, 'setAdminListPage');
    
    if (slice.total === 0) {
        const hasQuery = !!normalizeAdminSearchQuery(getAdminListState('users').appliedQuery);
        const emptyMsg = users.length === 0
            ? 'No users found'
            : (hasQuery ? 'No users match your search.' : 'No users found');
        tbody.innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="${userColspan}" style="text-align: center; color: #666;">${emptyMsg}</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = slice.pageItems.map(user => {
        const lastLogin = user.last_login
            ? (typeof window.formatRecordedDateTime === 'function'
                  ? window.formatRecordedDateTime(user.last_login)
                  : user.last_login)
            : 'Never';
        const selectedOrgId = getCurrentAdminOrgId();
        const roleToShow = (selectedOrgId != null && user.organizationRole != null) ? user.organizationRole : user.role;
        const roleColor = roleToShow === 'dev'
            ? 'var(--app-danger)'
            : roleToShow === 'admin'
                ? '#facc15'
                : roleToShow === 'manager'
                    ? '#a78bfa'
                    : roleToShow === 'tech'
                        ? '#38bdf8'
                        : 'var(--app-success)';
        const canDelete = window.authModule.isDev() || (window.authModule.isAdmin() && user.organizationIds && user.organizationIds.includes(window.authModule.getCurrentUser().organizationId));
        return `
            <tr class="admin-list-row" data-admin-list="users">
                ${showAdminRecordIdColumn() ? `<td class="admin-list-detail" data-label="ID">${escapeAdminHtml(user.id)}</td>` : ''}
                <td class="admin-list-primary" data-label="Username">${escapeAdminHtml(user.username)}</td>
                <td class="admin-list-detail" data-label="Email">${escapeAdminHtml(user.email)}</td>
                <td class="admin-list-detail" data-label="Role"><span style="text-transform: capitalize; color: ${roleColor};" title="${selectedOrgId != null && user.organizationRole != null ? 'Role in selected organization' : ''}">${escapeAdminHtml(roleToShow)}</span></td>
                <td class="admin-list-detail" data-label="Last login">${escapeAdminHtml(lastLogin)}</td>
                <td class="admin-table-actions admin-list-actions" data-label="Actions">
                    <button type="button" class="admin-button admin-button-secondary admin-list-expand-btn admin-list-mobile-only" aria-expanded="false" onclick="toggleAdminListRow(this)">Edit</button>
                    <button type="button" class="admin-button admin-button-secondary admin-list-manage-btn admin-list-expand-only" onclick="viewUser(${user.id})" style="margin-right: 0.5rem;">
                        <span class="admin-list-desktop-label">View</span>
                        <span class="admin-list-mobile-label">Manage</span>
                    </button>
                    ${canDelete ? `
                        <button type="button" class="admin-button admin-button-danger admin-list-expand-only" onclick="deleteUser(${user.id})">Delete</button>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

// Load service requests
const SERVICE_REQUEST_TYPE_LABELS = {
    site_documentation: 'Site Documentation',
    private_locating: 'Private Locating',
    technical_support: 'Technical Support',
    multi: 'Multiple services',
    aerial_photos: 'Aerial Photos'
};

function parseServiceRequestNote(note) {
    const raw = note == null ? '' : String(note);
    if (!raw.trim()) {
        return { services: [], userNote: '', ticket: null, raw: '', structured: false };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Number(parsed.v) === 1) {
            const services = Array.isArray(parsed.services)
                ? parsed.services.filter(s => typeof s === 'string' && s.trim())
                : [];
            return {
                services,
                userNote: parsed.userNote != null ? String(parsed.userNote) : '',
                ticket: parsed.ticket && typeof parsed.ticket === 'object' ? parsed.ticket : null,
                raw,
                structured: true
            };
        }
    } catch (_e) {
        // Legacy plain-text note
    }
    return { services: [], userNote: raw, ticket: null, raw, structured: false };
}

function formatServiceRequestTypeLabel(item) {
    const parsed = parseServiceRequestNote(item && item.note);
    if (parsed.structured && parsed.services.length > 0) {
        return parsed.services
            .map(s => SERVICE_REQUEST_TYPE_LABELS[s] || s)
            .join(', ');
    }
    const type = item && item.service_type;
    return SERVICE_REQUEST_TYPE_LABELS[type] || type || '-';
}

function formatServiceRequestTicketBlock(ticket) {
    if (!ticket || typeof ticket !== 'object') return '';
    const rows = [
        ['Ticket #', ticket.ticketNumber],
        ['Ticket ID', ticket.id],
        ['Status', ticket.status],
        ['Job name', ticket.jobName],
        ['Site address', ticket.address],
        ['City', ticket.city],
        ['County', ticket.county],
        ['Work description', ticket.workDescription],
        ['Work start', ticket.workStart],
        ['Ticket expiration', ticket.ticketExpiration]
    ];
    return rows
        .filter(([, value]) => value != null && String(value).trim() !== '')
        .map(([label, value]) => `${label}: ${value}`)
        .join('\n');
}

async function loadServiceRequests() {
    getAdminListState('serviceRequests').page = 1;
    try {
        const orgId = getCurrentAdminOrgId();
        const url = orgId != null ? `${getAdminApiBase()}/service-requests?organizationId=${orgId}` : `${getAdminApiBase()}/service-requests`;
        const requests = await window.authModule.apiRequest(url);
        serviceRequests = Array.isArray(requests) ? requests : [];
        renderServiceRequests();
        syncAdminServiceRequestsMap(serviceRequests);
    } catch (error) {
        console.error('Error loading service requests:', error);
        serviceRequests = [];
        document.getElementById('serviceRequestsTableBody').innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="8" style="text-align: center; color: var(--app-danger);">${escapeAdminHtml(getAdminErrorMessage(error))}</td>
            </tr>
        `;
        renderAdminListPagination('serviceRequestsPagination', 'serviceRequests', { total: 0 }, 'setAdminListPage');
        syncAdminServiceRequestsMap([]);
        resetServiceRequestsBulkSelection();
    }
}

// --- Service request bulk selection helpers ---
function getSelectedServiceRequestIds() {
    return Array.prototype.map.call(document.querySelectorAll('.service-request-row-cb:checked'), function (cb) {
        return Number(cb.value);
    });
}

function updateServiceRequestsSelectPageButton() {
    const btn = document.getElementById('serviceRequestsSelectPageBtn');
    if (!btn) return;
    const all = document.querySelectorAll('.service-request-row-cb');
    const checked = document.querySelectorAll('.service-request-row-cb:checked');
    const allSelected = all.length > 0 && checked.length === all.length;
    btn.textContent = allSelected ? 'Clear page selection' : 'Select all on page';
    btn.disabled = all.length === 0;
}

function serviceRequestsUpdateBulkUI() {
    const n = getSelectedServiceRequestIds().length;
    const readBtn = document.getElementById('serviceRequestsMarkReadSelectedBtn');
    const resolveBtn = document.getElementById('serviceRequestsResolveSelectedBtn');
    const unresolveBtn = document.getElementById('serviceRequestsUnresolveSelectedBtn');
    const delBtn = document.getElementById('serviceRequestsDeleteSelectedBtn');
    const hint = document.getElementById('serviceRequestsBulkHint');
    if (readBtn) readBtn.disabled = n === 0;
    if (resolveBtn) resolveBtn.disabled = n === 0;
    if (unresolveBtn) unresolveBtn.disabled = n === 0;
    if (delBtn) delBtn.disabled = n === 0;
    if (hint) hint.textContent = n ? `${n} selected` : '';
    updateServiceRequestsSelectPageButton();
}

function resetServiceRequestsBulkSelection() {
    const master = document.getElementById('serviceRequestsSelectAll');
    if (master) {
        master.checked = false;
        master.indeterminate = false;
    }
    serviceRequestsUpdateBulkUI();
}

function toggleServiceRequestsSelectAll(master) {
    document.querySelectorAll('.service-request-row-cb').forEach(function (cb) {
        cb.checked = master.checked;
    });
    serviceRequestsUpdateBulkUI();
}

function selectAllServiceRequestsOnPage() {
    const all = document.querySelectorAll('.service-request-row-cb');
    if (!all.length) return;
    const selectAll = document.querySelectorAll('.service-request-row-cb:checked').length !== all.length;
    all.forEach(function (cb) {
        cb.checked = selectAll;
    });
    const master = document.getElementById('serviceRequestsSelectAll');
    if (master) {
        master.checked = selectAll;
        master.indeterminate = false;
    }
    serviceRequestsUpdateBulkUI();
}

function onServiceRequestRowCheckboxChange() {
    const all = document.querySelectorAll('.service-request-row-cb');
    const master = document.getElementById('serviceRequestsSelectAll');
    if (master && all.length) {
        const checked = document.querySelectorAll('.service-request-row-cb:checked').length;
        master.checked = checked === all.length;
        master.indeterminate = checked > 0 && checked < all.length;
    }
    serviceRequestsUpdateBulkUI();
}

async function bulkUpdateServiceRequestStatus(status) {
    const ids = getSelectedServiceRequestIds();
    if (!ids.length) return;
    if (!(await appConfirm(`Update ${ids.length} selected service request(s) to ${status}?`))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/service-requests/bulk-status`, {
            method: 'POST',
            body: JSON.stringify({ ids, status })
        });
        await loadServiceRequests();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

async function bulkUnresolveServiceRequests() {
    const ids = getSelectedServiceRequestIds();
    if (!ids.length) return;
    if (!(await appConfirm(`Unresolve ${ids.length} selected service request(s)? Resolved items return to read; acknowledged/complete items step back on the feed queue.`))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/service-requests/bulk-unresolve`, {
            method: 'POST',
            body: JSON.stringify({ ids })
        });
        await loadServiceRequests();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

async function bulkDeleteServiceRequests() {
    const ids = getSelectedServiceRequestIds();
    if (!ids.length) return;
    if (!(await appConfirm(`Permanently delete ${ids.length} selected service request(s)? This cannot be undone.`))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/service-requests/bulk-delete`, {
            method: 'POST',
            body: JSON.stringify({ ids })
        });
        await loadServiceRequests();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

// Render service requests table
function renderServiceRequests() {
    const tbody = document.getElementById('serviceRequestsTableBody');
    if (!tbody) return;

    const slice = paginateAdminList(serviceRequests, 'serviceRequests');
    renderAdminListPagination('serviceRequestsPagination', 'serviceRequests', slice, 'setAdminListPage');

    if (!slice.total) {
        tbody.innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="8" style="text-align: center; color: #666;">No service requests found</td>
            </tr>
        `;
        applyAdminServiceRequestRowSelection(null);
        resetServiceRequestsBulkSelection();
        return;
    }
    
    tbody.innerHTML = slice.pageItems.map(item => {
        const serviceTypeLabel = formatServiceRequestTypeLabel(item);
        const statusColors = {
            'new': 'var(--app-accent)',
            'read': '#f59e0b',
            'resolved': 'var(--app-success)'
        };
        const statusColor = statusColors[item.status] || '#666';
        const createdDate = new Date(item.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        return `
            <tr class="admin-sr-row" data-sr-id="${escapeAdminHtml(item.id)}" onclick="onAdminServiceRequestRowClick(event, ${item.id})" style="cursor: pointer;">
                <td class="admin-list-select" data-label="Select" style="text-align: center;" onclick="event.stopPropagation()">
                    <input type="checkbox" class="service-request-row-cb" value="${item.id}" aria-label="Select service request ${escapeAdminHtml(item.id)}" onchange="onServiceRequestRowCheckboxChange()" onclick="event.stopPropagation()" />
                </td>
                <td data-label="ID">${escapeAdminHtml(item.id)}</td>
                <td data-label="Type">${escapeAdminHtml(serviceTypeLabel)}</td>
                <td data-label="User">${escapeAdminHtml(item.user_name || item.user_email || 'Unknown')}</td>
                <td data-label="Organization">${escapeAdminHtml(item.organization_name || '-')}</td>
                <td data-label="Status">
                    <span style="color: ${statusColor}; font-weight: 500;">${escapeAdminHtml(String(item.status || '').toUpperCase())}</span>
                </td>
                <td data-label="Date">${escapeAdminHtml(createdDate)}</td>
                <td class="admin-table-actions" data-label="Actions" onclick="event.stopPropagation()">
                    <button type="button" class="admin-button admin-button-primary" onclick="viewServiceRequest(${item.id})" style="margin-right: 0.5rem;">View</button>
                    ${item.status !== 'resolved' ? `
                        <button type="button" class="admin-button admin-button-secondary" onclick="updateServiceRequestStatus(${item.id}, '${item.status === 'new' ? 'read' : 'resolved'}')">
                            Mark as ${item.status === 'new' ? 'Read' : 'Resolved'}
                        </button>
                    ` : ''}
                    ${window.authModule && window.authModule.isDev() ? `
                        <button type="button" class="admin-button admin-button-danger" onclick="deleteServiceRequest(${item.id})" style="margin-left: 0.5rem;">Delete</button>
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');

    const delBtn = document.getElementById('serviceRequestsDeleteSelectedBtn');
    if (delBtn) {
        delBtn.style.display = (window.authModule && window.authModule.isDev()) ? '' : 'none';
    }
    resetServiceRequestsBulkSelection();

    if (typeof refreshAdminServiceRequestRowSelection === 'function') {
        refreshAdminServiceRequestRowSelection();
    }
}

// View service request details
async function viewServiceRequest(id) {
    const item = serviceRequests.find(r => r.id === id);
    if (!item) {
        await appAlert('Service request not found');
        return;
    }
    
    // Create or show service request modal
    let modal = document.getElementById('viewServiceRequestModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'viewServiceRequestModal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.onclick = function(e) {
            if (e.target === modal) closeViewServiceRequestModal();
        };
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 600px;">
                <div class="modal-header">
                    <h2 class="modal-title">Service Request Details</h2>
                    <button class="modal-close" onclick="closeViewServiceRequestModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="admin-form-group">
                        <label class="admin-form-label">Service Type</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse);" id="serviceRequestType"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">User note</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse); min-height: 60px; white-space: pre-wrap;" id="serviceRequestNote"></div>
                    </div>
                    <div class="admin-form-group" id="serviceRequestTicketGroup" hidden>
                        <label class="admin-form-label">Ticket</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse); min-height: 60px; white-space: pre-wrap;" id="serviceRequestTicket"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">From</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse);" id="serviceRequestUser"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Organization</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse);" id="serviceRequestOrg"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Status</label>
                        <div id="serviceRequestStatus"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Submitted</label>
                        <div style="padding: 0.75rem; background: var(--app-bg-surface); border-radius: 0.375rem; color: var(--app-text-inverse);" id="serviceRequestDate"></div>
                    </div>
                    <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
                        <button type="button" class="admin-button admin-button-secondary" onclick="closeViewServiceRequestModal()">Close</button>
                        <span id="serviceRequestActionButtons"></span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    const parsed = parseServiceRequestNote(item.note);
    const serviceTypeLabel = formatServiceRequestTypeLabel(item);
    
    document.getElementById('serviceRequestType').textContent = serviceTypeLabel;
    document.getElementById('serviceRequestNote').textContent =
        parsed.structured
            ? (parsed.userNote && parsed.userNote.trim() ? parsed.userNote : '-')
            : (parsed.raw || '-');

    const ticketGroup = document.getElementById('serviceRequestTicketGroup');
    const ticketEl = document.getElementById('serviceRequestTicket');
    const ticketBlock = formatServiceRequestTicketBlock(parsed.ticket);
    if (ticketGroup && ticketEl) {
        if (ticketBlock) {
            ticketGroup.hidden = false;
            ticketEl.textContent = ticketBlock;
        } else {
            ticketGroup.hidden = true;
            ticketEl.textContent = '';
        }
    }

    document.getElementById('serviceRequestUser').textContent = `${item.user_name || 'Unknown'} (${item.user_email || '-'})`;
    document.getElementById('serviceRequestOrg').textContent = item.organization_name || '-';
    
    const statusColors = {
        'new': 'var(--app-accent)',
        'read': '#f59e0b',
        'resolved': 'var(--app-success)'
    };
    const statusColor = statusColors[item.status] || '#666';
    document.getElementById('serviceRequestStatus').innerHTML = `
        <span style="color: ${statusColor}; font-weight: 500;">${escapeAdminHtml(String(item.status || '').toUpperCase())}</span>
    `;
    
    const createdDate =
        typeof window.formatRecordedDateTime === 'function'
            ? window.formatRecordedDateTime(item.created_at)
            : item.created_at;
    document.getElementById('serviceRequestDate').textContent = createdDate;
    
    const actionButtons = document.getElementById('serviceRequestActionButtons');
    actionButtons.innerHTML = '';
    if (item.status !== 'resolved') {
        const nextStatus = item.status === 'new' ? 'read' : 'resolved';
        const buttonText = item.status === 'new' ? 'Mark as Read' : 'Mark as Resolved';
        actionButtons.innerHTML = `
            <button class="admin-button admin-button-primary" onclick="updateServiceRequestStatus(${item.id}, '${nextStatus}'); closeViewServiceRequestModal();">
                ${buttonText}
            </button>
        `;
    }
    if (window.authModule && window.authModule.isDev()) {
        actionButtons.innerHTML += `
            <button class="admin-button admin-button-danger" onclick="deleteServiceRequest(${item.id}); closeViewServiceRequestModal();" style="margin-left: 0.5rem;">
                Delete
            </button>
        `;
    }
    
    modal.style.display = 'flex';
}

function closeViewServiceRequestModal() {
    const modal = document.getElementById('viewServiceRequestModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

async function updateServiceRequestStatus(id, status) {
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/service-requests/${id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status })
        });
        await loadServiceRequests();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        console.error('Error updating service request status:', error);
        await appAlert(getAdminErrorMessage(error));
    }
}

async function deleteServiceRequest(id) {
    if (!(await appConfirm('Are you sure you want to delete this service request?'))) {
        return;
    }
    
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/service-requests/${id}`, {
            method: 'DELETE'
        });
        await loadServiceRequests();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        console.error('Error deleting service request:', error);
        await appAlert(getAdminErrorMessage(error));
    }
}

// Export functions
window.loadServiceRequests = loadServiceRequests;
window.viewServiceRequest = viewServiceRequest;
window.closeViewServiceRequestModal = closeViewServiceRequestModal;
window.updateServiceRequestStatus = updateServiceRequestStatus;
window.deleteServiceRequest = deleteServiceRequest;
window.toggleServiceRequestsSelectAll = toggleServiceRequestsSelectAll;
window.selectAllServiceRequestsOnPage = selectAllServiceRequestsOnPage;
window.onServiceRequestRowCheckboxChange = onServiceRequestRowCheckboxChange;
window.bulkUpdateServiceRequestStatus = bulkUpdateServiceRequestStatus;
window.bulkUnresolveServiceRequests = bulkUnresolveServiceRequests;
window.bulkDeleteServiceRequests = bulkDeleteServiceRequests;

