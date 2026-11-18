
// Form handlers
document.addEventListener('DOMContentLoaded', async function() {
    if (window.__pwaBootReady) {
        await window.__pwaBootReady;
    }

    initAdminThemeToggle();

    // Refresh user from server first so role is current (backend stores role in DB; old JWT may have stale role)
    try {
        if (window.authModule && window.authModule.refreshUser) {
            const user = await window.authModule.refreshUser();
            if (window.appI18n && user && user.preferredLanguage) {
                window.appI18n.setLanguage(user.preferredLanguage);
            }
        }
    } catch (e) {
        // Refresh failed, continue with cached user
    }

    if (!(await checkAdminAccess())) return;

    await syncAdminThemePreferenceFromServer();

    if (window.authModule.isDev()) {
        document.querySelectorAll('.admin-tab-dev-only').forEach(function (el) {
            el.classList.add('admin-dev-visible');
        });
    }
    if (window.CORE_PRODUCT === true) {
        ['aerialCatalog', 'publicSharing', 'serviceRequests'].forEach(function (tab) {
            document.querySelectorAll('.admin-tab[data-tab="' + tab + '"]').forEach(function (el) {
                el.hidden = true;
                el.style.display = 'none';
            });
        });
    }

    var adminTabSelect = document.getElementById('adminTabSelect');
    if (adminTabSelect) {
        var isDev = window.authModule.isDev();
        var tabOpts = [{ v: 'users', l: 'Users' }];
        if (window.CORE_PRODUCT !== true) {
            tabOpts.push({ v: 'publicSharing', l: 'Public sharing' });
        }
        tabOpts.push(
            { v: 'workflow', l: 'Workflow' }
        );
        if (isDev) {
            if (window.CORE_PRODUCT !== true) {
                tabOpts.push({ v: 'serviceRequests', l: 'Service Requests' });
            }
            tabOpts.push({ v: 'errors', l: 'Errors' });
            if (window.CORE_PRODUCT !== true) {
                tabOpts.push({ v: 'aerialCatalog', l: 'Aerial catalog' });
            }
            tabOpts.push({ v: 'appSettings', l: 'App Settings' });
        }
        adminTabSelect.innerHTML = tabOpts
            .map(function (o) {
                return '<option value="' + o.v + '">' + o.l + '</option>';
            })
            .join('');
        adminTabSelect.value = getDefaultAdminTab();
        adminTabSelect.addEventListener('change', function () {
            switchTab(this.value, null);
        });
    }

    var createUserForm = document.getElementById('createUserForm');
    if (createUserForm) {
        createUserForm.addEventListener('submit', function(e) {
            e.preventDefault();
            var userData = {
                username: (document.getElementById('userUsername') && document.getElementById('userUsername').value.trim()) || null,
                email: (document.getElementById('userEmail') && document.getElementById('userEmail').value.trim()) || '',
                password: document.getElementById('userPassword') ? document.getElementById('userPassword').value : '',
                role: document.getElementById('userRole') ? document.getElementById('userRole').value : 'operator',
                organizationId: (function() {
                    var sel = document.getElementById('userOrganization');
                    return sel && sel.value ? parseInt(sel.value, 10) : null;
                })(),
                fullName: (document.getElementById('userFullName') && document.getElementById('userFullName').value.trim()) || null,
                phone: (function() {
                    var raw = document.getElementById('userPhone') ? document.getElementById('userPhone').value : '';
                    var digits = String(raw || '').replace(/\D/g, '');
                    return digits || null;
                })(),
                preferredLanguage: document.getElementById('userLanguage') && document.getElementById('userLanguage').value === 'es' ? 'es' : 'en'
            };
            if (userData.phone && !/^\d{10}$/.test(userData.phone)) {
                window.appAlert('Phone number must be exactly 10 digits.');
                return;
            }
            if (userData.email && userData.password) {
                const policy = window.validatePasswordPolicy
                    ? window.validatePasswordPolicy(userData.password)
                    : { ok: true };
                if (!policy.ok) {
                    window.appAlert(policy.error || window.PASSWORD_POLICY_MESSAGE);
                    return;
                }
                createUser(userData);
            }
        });
    }

    // Load organizations for create-user and org-scoped tabs (org comes from session/auth).
    if (typeof loadAppSettings === 'function') {
        await loadAppSettings();
    }
    await loadOrganizations();
    switchTab(getDefaultAdminTab(), null);
    syncUsanSettingsAccessUi();
    refreshAdminTabBadges();

    if (window.userActivity && typeof window.userActivity.onResume === 'function') {
        window.userActivity.onResume(function () {
            syncAdminTabBadgePoll();
        });
    }
    startAdminTabBadgePoll();
});

// Export functions immediately (before DOMContentLoaded) so onclick handlers can access them
window.switchTab = switchTab;
window.loadAerialCatalog = loadAerialCatalog;
window.setAerialCatalogAccessMode = setAerialCatalogAccessMode;
window.openAerialCatalogOrgsModal = openAerialCatalogOrgsModal;
window.closeAerialCatalogOrgsModal = closeAerialCatalogOrgsModal;
window.submitAerialCatalogOrgsModal = submitAerialCatalogOrgsModal;
window.onAerialCatalogOrgsSearchInput = onAerialCatalogOrgsSearchInput;
window.openAdminAddAerialModal = openAdminAddAerialModal;
window.closeAdminAddAerialModal = closeAdminAddAerialModal;
window.submitAdminAddAerial = submitAdminAddAerial;
window.deleteAerialCatalogMap = deleteAerialCatalogMap;
window.applyAdminListSearch = applyAdminListSearch;
window.clearAdminListSearch = clearAdminListSearch;
window.setAdminListPage = setAdminListPage;
window.onAdminListSearchKeydown = onAdminListSearchKeydown;
window.toggleAdminListRow = toggleAdminListRow;
window.openCreateUserModal = openCreateUserModal;
window.closeCreateUserModal = closeCreateUserModal;
window.deleteUser = deleteUser;
window.viewUser = viewUser;
window.closeEditUserModal = closeEditUserModal;
window.addUserToOrganization = addUserToOrganization;
window.removeUserFromOrganization = removeUserFromOrganization;
window.saveSharedServiceAccount = saveSharedServiceAccount;
window.deleteSharedServiceAccount = deleteSharedServiceAccount;
window.loadSharedServiceAccount = loadSharedServiceAccount;
window.refreshAdminTabBadges = refreshAdminTabBadges;
window.loadUsanSyncSettings = loadUsanSyncSettings;
window.saveUsanSyncSettings = saveUsanSyncSettings;
window.runAdminUsanFullSync = runAdminUsanFullSync;
window.loadPacSyncSettings = loadUsanSyncSettings;
window.savePacSyncSettings = saveUsanSyncSettings;
window.runAdminPacFullSync = runAdminUsanFullSync;
window.loadAdminErrors = loadAdminErrors;
window.viewAdminError = viewAdminError;
window.closeViewAdminErrorModal = closeViewAdminErrorModal;
window.onAdminErrorRowClick = onAdminErrorRowClick;
window.acknowledgeAdminError = acknowledgeAdminError;
window.deleteAdminError = deleteAdminError;
window.toggleAdminErrorsSelectAll = toggleAdminErrorsSelectAll;
window.selectAllAdminErrorsOnPage = selectAllAdminErrorsOnPage;
window.onAdminErrorRowCheckboxChange = onAdminErrorRowCheckboxChange;
window.acknowledgeSelectedAdminErrors = acknowledgeSelectedAdminErrors;
window.deleteSelectedAdminErrors = deleteSelectedAdminErrors;
window.setAdminTheme = setAdminTheme;

