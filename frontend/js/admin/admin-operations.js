function getAdminErrorMessage(error) {
    return window.authModule && typeof window.authModule.getFriendlyErrorMessage === 'function'
        ? window.authModule.getFriendlyErrorMessage(error)
        : (error && error.message) || String(error || 'Something went wrong.');
}

async function loadAdminErrors() {
    if (!window.authModule || !window.authModule.isDev()) return;
    const tbody = document.getElementById('adminErrorsTableBody');
    if (!tbody) return;
    const filter = document.getElementById('adminErrorsStatusFilter');
    const status = filter && filter.value ? filter.value : 'open';
    getAdminListState('errors').page = 1;
    try {
        const rows = await window.authModule.apiRequest(
            `${getAdminApiBase()}/admin/errors?status=${encodeURIComponent(status)}&limit=250`
        );
        adminErrors = Array.isArray(rows) ? rows : [];
        renderAdminErrors();
    } catch (error) {
        console.error('Error loading application errors:', error);
        tbody.innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="7" style="text-align: center; color: var(--app-danger);">${escapeAdminHtml(getAdminErrorMessage(error))}</td>
            </tr>
        `;
        renderAdminListPagination('adminErrorsPagination', 'errors', { total: 0 }, 'setAdminListPage');
        resetAdminErrorsBulkSelection();
    }
}

function renderAdminErrors() {
    const tbody = document.getElementById('adminErrorsTableBody');
    if (!tbody) return;

    const slice = paginateAdminList(adminErrors, 'errors');
    renderAdminListPagination('adminErrorsPagination', 'errors', slice, 'setAdminListPage');

    if (!slice.total) {
        tbody.innerHTML = `
            <tr class="admin-table-row-message">
                <td colspan="7" style="text-align: center; color: #666;">No errors found.</td>
            </tr>
        `;
        resetAdminErrorsBulkSelection();
        return;
    }
    tbody.innerHTML = slice.pageItems
        .map(function (row) {
            const created = row.createdAt
                ? (typeof window.formatRecordedDateTime === 'function'
                      ? window.formatRecordedDateTime(row.createdAt)
                      : row.createdAt)
                : '—';
            const ack = row.acknowledgedAt
                ? `<div style="font-size:0.75rem;color:#666;">Acknowledged ${escapeAdminHtml(typeof window.formatRecordedDateTime === 'function' ? window.formatRecordedDateTime(row.acknowledgedAt) : row.acknowledgedAt)}</div>`
                : '';
            const msgShort = String(row.customerMessage || '').slice(0, 80);
            return `
                <tr class="admin-list-row admin-list-row-static" data-admin-list="errors" onclick="onAdminErrorRowClick(event, ${row.id})">
                    <td class="admin-list-select" data-label="Select" style="text-align: center;">
                        <input type="checkbox" class="admin-error-row-cb" value="${row.id}" aria-label="Select error ${row.id}" onchange="onAdminErrorRowCheckboxChange()" onclick="event.stopPropagation()" />
                    </td>
                    <td class="admin-list-hide-mobile" data-label="ID">${row.id}</td>
                    <td class="admin-list-primary" data-label="Code">
                        <code>${escapeAdminHtml(row.errorCode || '')}</code>
                        <div class="admin-list-meta admin-list-mobile-only">${escapeAdminHtml(msgShort)}${ack}</div>
                    </td>
                    <td class="admin-list-hide-mobile" data-label="Message">${escapeAdminHtml(row.customerMessage || '')}${ack}</td>
                    <td class="admin-list-hide-mobile" data-label="Route">${escapeAdminHtml(row.route || row.requestPath || '—')}</td>
                    <td class="admin-list-status" data-label="Created">${created}</td>
                    <td class="admin-table-actions admin-list-actions" data-label="Actions">
                        <button type="button" class="admin-button admin-button-secondary" onclick="event.stopPropagation(); viewAdminError(${row.id})">View</button>
                        ${row.acknowledgedAt ? '' : `<button type="button" class="admin-button admin-button-primary admin-list-hide-mobile" onclick="event.stopPropagation(); acknowledgeAdminError(${row.id})">Acknowledge</button>`}
                        <button type="button" class="admin-button admin-button-danger admin-list-hide-mobile" onclick="event.stopPropagation(); deleteAdminError(${row.id})">Delete</button>
                    </td>
                </tr>
            `;
        })
        .join('');
    resetAdminErrorsBulkSelection();
}

function onAdminErrorRowClick(event, id) {
    if (!event || event.target.closest('button, input, a, label')) return;
    viewAdminError(id);
}

function getSelectedAdminErrorIds() {
    return Array.prototype.map.call(document.querySelectorAll('.admin-error-row-cb:checked'), function (cb) {
        return Number(cb.value);
    });
}

function updateAdminErrorsSelectPageButton() {
    const btn = document.getElementById('adminErrorsSelectPageBtn');
    if (!btn) return;
    const all = document.querySelectorAll('.admin-error-row-cb');
    const checked = document.querySelectorAll('.admin-error-row-cb:checked');
    const allSelected = all.length > 0 && checked.length === all.length;
    btn.textContent = allSelected ? 'Clear page selection' : 'Select all on page';
    btn.disabled = all.length === 0;
}

function adminErrorsUpdateBulkUI() {
    const ids = getSelectedAdminErrorIds();
    const n = ids.length;
    const ackBtn = document.getElementById('adminErrorsAckSelectedBtn');
    const delBtn = document.getElementById('adminErrorsDelSelectedBtn');
    const hint = document.getElementById('adminErrorsBulkHint');
    if (ackBtn) ackBtn.disabled = n === 0;
    if (delBtn) delBtn.disabled = n === 0;
    if (hint) hint.textContent = n ? `${n} selected` : '';
    updateAdminErrorsSelectPageButton();
}

function resetAdminErrorsBulkSelection() {
    const master = document.getElementById('adminErrorsSelectAll');
    if (master) {
        master.checked = false;
        master.indeterminate = false;
    }
    adminErrorsUpdateBulkUI();
}

function toggleAdminErrorsSelectAll(master) {
    document.querySelectorAll('.admin-error-row-cb').forEach(function (cb) {
        cb.checked = master.checked;
    });
    adminErrorsUpdateBulkUI();
}

function selectAllAdminErrorsOnPage() {
    const all = document.querySelectorAll('.admin-error-row-cb');
    if (!all.length) return;
    const checked = document.querySelectorAll('.admin-error-row-cb:checked');
    const selectAll = checked.length !== all.length;
    all.forEach(function (cb) {
        cb.checked = selectAll;
    });
    const master = document.getElementById('adminErrorsSelectAll');
    if (master) {
        master.checked = selectAll;
        master.indeterminate = false;
    }
    adminErrorsUpdateBulkUI();
}

function onAdminErrorRowCheckboxChange() {
    const all = document.querySelectorAll('.admin-error-row-cb');
    const master = document.getElementById('adminErrorsSelectAll');
    if (master && all.length) {
        const checked = document.querySelectorAll('.admin-error-row-cb:checked').length;
        master.checked = checked === all.length;
        master.indeterminate = checked > 0 && checked < all.length;
    }
    adminErrorsUpdateBulkUI();
}

async function acknowledgeSelectedAdminErrors() {
    const ids = getSelectedAdminErrorIds();
    if (!ids.length) return;
    if (!(await appConfirm(`Acknowledge ${ids.length} selected error record(s)?`))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/admin/errors/bulk-acknowledge`, {
            method: 'POST',
            body: JSON.stringify({ ids: ids }),
        });
        await loadAdminErrors();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

async function deleteSelectedAdminErrors() {
    const ids = getSelectedAdminErrorIds();
    if (!ids.length) return;
    if (!(await appConfirm(`Permanently delete ${ids.length} selected error record(s)? This cannot be undone.`))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/admin/errors/bulk-delete`, {
            method: 'POST',
            body: JSON.stringify({ ids: ids }),
        });
        await loadAdminErrors();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

async function viewAdminError(id) {
    const row = adminErrors.find(function (item) { return Number(item.id) === Number(id); });
    if (!row) return;

    let modal = document.getElementById('viewAdminErrorModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'viewAdminErrorModal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.onclick = function (e) {
            if (e.target === modal) closeViewAdminErrorModal();
        };
        modal.innerHTML = `
            <div class="modal-content admin-error-detail-modal" onclick="event.stopPropagation()" style="max-width: 640px;">
                <div class="modal-header">
                    <h2 class="modal-title">Error Details</h2>
                    <button type="button" class="modal-close" onclick="closeViewAdminErrorModal()" aria-label="Close">&times;</button>
                </div>
                <div class="modal-body admin-error-detail-body">
                    <div class="admin-form-group">
                        <label class="admin-form-label">Code</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailCode"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Support ID</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailId"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Customer message</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailCustomer"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Internal message</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailInternal"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Status</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailStatus"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Route</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailRoute"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Path</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailPath"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">User ID</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailUser"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Organization ID</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailOrg"></div>
                    </div>
                    <div class="admin-form-group">
                        <label class="admin-form-label">Created</label>
                        <div class="admin-error-detail-field" id="adminErrorDetailCreated"></div>
                    </div>
                    <div class="admin-form-group" id="adminErrorDetailMetaGroup" hidden>
                        <label class="admin-form-label">Meta</label>
                        <pre class="admin-error-detail-pre" id="adminErrorDetailMeta"></pre>
                    </div>
                    <div class="admin-form-group" id="adminErrorDetailDetailGroup" hidden>
                        <label class="admin-form-label">Detail</label>
                        <pre class="admin-error-detail-pre" id="adminErrorDetailDetail"></pre>
                    </div>
                    <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap;">
                        <button type="button" class="admin-button admin-button-secondary" onclick="closeViewAdminErrorModal()">Close</button>
                        <span id="adminErrorDetailActions"></span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    const setText = function (elId, value) {
        const el = document.getElementById(elId);
        if (el) el.textContent = value == null || value === '' ? '—' : String(value);
    };
    setText('adminErrorDetailCode', row.errorCode || 'Unknown');
    setText('adminErrorDetailId', row.id);
    setText('adminErrorDetailCustomer', row.customerMessage || '');
    setText('adminErrorDetailInternal', row.internalMessage || '');
    setText('adminErrorDetailStatus', row.status || '');
    setText('adminErrorDetailRoute', row.route || '');
    setText('adminErrorDetailPath', `${row.requestMethod || ''} ${row.requestPath || ''}`.trim());
    setText('adminErrorDetailUser', row.userId || '');
    setText('adminErrorDetailOrg', row.organizationId || '');
    setText(
        'adminErrorDetailCreated',
        row.createdAt
            ? typeof window.formatRecordedDateTime === 'function'
                ? window.formatRecordedDateTime(row.createdAt)
                : row.createdAt
            : ''
    );

    const metaGroup = document.getElementById('adminErrorDetailMetaGroup');
    const metaEl = document.getElementById('adminErrorDetailMeta');
    if (metaGroup && metaEl) {
        if (row.meta) {
            metaEl.textContent = typeof row.meta === 'string' ? row.meta : JSON.stringify(row.meta, null, 2);
            metaGroup.hidden = false;
        } else {
            metaEl.textContent = '';
            metaGroup.hidden = true;
        }
    }
    const detailGroup = document.getElementById('adminErrorDetailDetailGroup');
    const detailEl = document.getElementById('adminErrorDetailDetail');
    if (detailGroup && detailEl) {
        if (row.detail) {
            detailEl.textContent = String(row.detail).slice(0, 8000);
            detailGroup.hidden = false;
        } else {
            detailEl.textContent = '';
            detailGroup.hidden = true;
        }
    }

    const actions = document.getElementById('adminErrorDetailActions');
    if (actions) {
        let buttons = '';
        if (!row.acknowledgedAt) {
            buttons += `<button type="button" class="admin-button admin-button-primary" onclick="acknowledgeAdminError(${row.id}); closeViewAdminErrorModal();">Acknowledge</button> `;
        }
        buttons += `<button type="button" class="admin-button admin-button-danger" onclick="deleteAdminError(${row.id}); closeViewAdminErrorModal();">Delete</button>`;
        actions.innerHTML = buttons;
    }

    modal.dataset.errorId = String(row.id);
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeViewAdminErrorModal() {
    const modal = document.getElementById('viewAdminErrorModal');
    if (modal) {
        modal.style.display = 'none';
        delete modal.dataset.errorId;
        document.body.style.overflow = '';
    }
}

async function acknowledgeAdminError(id) {
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/admin/errors/${id}/acknowledge`, { method: 'PATCH' });
        await loadAdminErrors();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

async function deleteAdminError(id) {
    if (!(await appConfirm('Delete this error record?'))) return;
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/admin/errors/${id}`, { method: 'DELETE' });
        await loadAdminErrors();
        refreshAdminTabBadges();
        if (typeof window.refreshAdminInboxBadge === 'function') window.refreshAdminInboxBadge();
    } catch (error) {
        await appAlert(getAdminErrorMessage(error));
    }
}

function getProviderUsername(acc) {
    if (!acc || typeof acc !== 'object') return '';
    const legacyUsernameKey = 'pac' + 'web_username';
    const raw =
        acc.provider_username != null && String(acc.provider_username).trim() !== ''
            ? acc.provider_username
            : acc[legacyUsernameKey];
    return raw != null ? String(raw).trim() : '';
}

function isMasterSourceAccount(acc) {
    return acc && String(acc.account_type || acc.accountType || '') === 'master';
}

function eligibleSharedServiceAccountOrgs(orgList) {
    return (orgList || []).filter(function (org) {
        return org && !org.isPublicCatalog;
    });
}

async function fetchSourceAccountsForOrg(orgId) {
    const rows = await window.authModule.apiRequest(
        `${getAdminApiBase()}/organizations/${orgId}/source-accounts`
    );
    return Array.isArray(rows) ? rows : [];
}

async function resolveSharedServiceAccountTarget() {
    if (!organizations.length) {
        try {
            const orgs = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations`);
            organizations = Array.isArray(orgs) ? orgs : [];
        } catch (e) {
            organizations = [];
        }
    }
    const candidates = eligibleSharedServiceAccountOrgs(organizations);
    for (let i = 0; i < candidates.length; i++) {
        const org = candidates[i];
        let rows = [];
        try {
            rows = await fetchSourceAccountsForOrg(org.id);
        } catch (e) {
            continue;
        }
        const master = rows.find(isMasterSourceAccount);
        if (master) {
            return { org: org, accounts: rows, master: master };
        }
    }
    const hub = candidates.find(function (org) { return org.isDevTicketHub; });
    const org = hub || candidates[0] || null;
    if (!org) return { org: null, accounts: [], master: null };
    let accounts = [];
    try {
        accounts = await fetchSourceAccountsForOrg(org.id);
    } catch (e) {
        accounts = [];
    }
    return { org: org, accounts: accounts, master: accounts.find(isMasterSourceAccount) || null };
}

function fillSharedServiceAccountForm(target) {
    const orgIdEl = document.getElementById('appSettingsServiceAccountOrgId');
    const idEl = document.getElementById('appSettingsServiceAccountId');
    const labelEl = document.getElementById('appSettingsServiceAccountLabel');
    const userEl = document.getElementById('appSettingsServiceAccountUsername');
    const passEl = document.getElementById('appSettingsServiceAccountPassword');
    const hint = document.getElementById('appSettingsServiceAccountHint');
    const removeBtn = document.getElementById('appSettingsServiceAccountRemoveBtn');
    if (!orgIdEl) return;
    const org = target && target.org;
    const master = target && target.master;
    orgIdEl.value = org ? String(org.id) : '';
    idEl.value = master ? String(master.id) : '';
    if (labelEl) labelEl.value = master && master.label ? master.label : '';
    if (userEl) userEl.value = master ? getProviderUsername(master) : '';
    if (passEl) {
        passEl.value = '';
        passEl.disabled = false;
    }
    if (removeBtn) removeBtn.style.display = master ? '' : 'none';
    if (hint) {
        if (!org) {
            hint.textContent = 'No organization is available to attach the shared service account.';
        } else if (master) {
            hint.textContent = 'Connected as a master USAN account.';
        } else {
            hint.textContent = 'No shared service account is saved yet.';
        }
    }
}

async function loadSharedServiceAccount() {
    const hint = document.getElementById('appSettingsServiceAccountHint');
    if (!document.getElementById('appSettingsServiceAccountForm')) return;
    try {
        const target = await resolveSharedServiceAccountTarget();
        providerAccounts = target.accounts || [];
        fillSharedServiceAccountForm(target);
    } catch (error) {
        console.error('Error loading shared service account:', error);
        if (hint) hint.textContent = getAdminErrorMessage(error);
    }
}

async function saveSharedServiceAccount() {
    const orgIdRaw = document.getElementById('appSettingsServiceAccountOrgId');
    const editIdEl = document.getElementById('appSettingsServiceAccountId');
    const labelEl = document.getElementById('appSettingsServiceAccountLabel');
    const userEl = document.getElementById('appSettingsServiceAccountUsername');
    const passEl = document.getElementById('appSettingsServiceAccountPassword');
    const orgId = orgIdRaw && orgIdRaw.value ? parseInt(orgIdRaw.value, 10) : NaN;
    if (!Number.isFinite(orgId)) {
        await appAlert('No organization is available to save the shared service account.');
        return;
    }
    const providerUser = userEl ? userEl.value.trim() : '';
    if (!providerUser) {
        await appAlert('USAN username is required.');
        return;
    }
    const label = labelEl ? labelEl.value.trim() : '';
    const password = passEl && passEl.value.trim() ? passEl.value.trim() : undefined;
    const editId = editIdEl && editIdEl.value ? editIdEl.value : '';
    if (!editId && !password) {
        await appAlert('Password is required when adding the shared service account.');
        return;
    }
    try {
        if (editId) {
            const body = {
                label: label || null,
                provider_username: providerUser,
                account_type: 'master'
            };
            if (password !== undefined) body.password = password;
            await window.authModule.apiRequest(
                `${getAdminApiBase()}/organizations/${orgId}/source-accounts/${editId}`,
                { method: 'PUT', body: JSON.stringify(body) }
            );
        } else {
            await window.authModule.apiRequest(`${getAdminApiBase()}/organizations/${orgId}/source-accounts`, {
                method: 'POST',
                body: JSON.stringify({
                    label: label || null,
                    provider_username: providerUser,
                    account_type: 'master',
                    password: password
                })
            });
        }
        await loadSharedServiceAccount();
        await appAlert('Service account saved.');
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

async function deleteSharedServiceAccount() {
    const orgIdRaw = document.getElementById('appSettingsServiceAccountOrgId');
    const editIdEl = document.getElementById('appSettingsServiceAccountId');
    const orgId = orgIdRaw && orgIdRaw.value ? parseInt(orgIdRaw.value, 10) : NaN;
    const accountId = editIdEl && editIdEl.value ? parseInt(editIdEl.value, 10) : NaN;
    if (!Number.isFinite(orgId) || !Number.isFinite(accountId)) {
        await appAlert('No shared service account is saved.');
        return;
    }
    const ok = await appConfirm('Remove the shared USAN service account? Ticket sync will stop until a new account is saved.');
    if (!ok) return;
    try {
        await window.authModule.apiRequest(
            `${getAdminApiBase()}/organizations/${orgId}/source-accounts/${accountId}`,
            { method: 'DELETE' }
        );
        await loadSharedServiceAccount();
        await appAlert('Service account removed.');
    } catch (e) {
        await appAlert(getAdminErrorMessage(e));
    }
}

// Create user
async function createUser(userData) {
    try {
        const wantTech = userData && userData.role === 'tech';
        const wantManager = userData && userData.role === 'manager';
        const payload = Object.assign({}, userData);
        if (wantTech || wantManager) {
            // Global users.role has no "tech" or "manager"; create as operator then set org membership role.
            payload.role = 'operator';
            if (payload.organizationId == null && typeof getCurrentAdminOrgId === 'function') {
                const oid = getCurrentAdminOrgId();
                if (oid != null) payload.organizationId = oid;
            }
        }
        if ((wantTech || wantManager) && (payload.organizationId == null || payload.organizationId === '')) {
            await appAlert(wantTech ? 'Select an organization to create a Tech user.' : 'Select an organization to create a Manager user.');
            return;
        }
        const created = await window.authModule.apiRequest(`${getAdminApiBase()}/users`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if (wantTech && created && created.id) {
            const orgId =
                created.defaultOrganizationId != null
                    ? created.defaultOrganizationId
                    : payload.organizationId;
            if (orgId != null && orgId !== '') {
                await window.authModule.apiRequest(
                    `${getAdminApiBase()}/user-organizations/user/${created.id}/organization/${orgId}/role`,
                    { method: 'PUT', body: JSON.stringify({ role: 'tech' }) }
                );
            }
        }
        if (wantManager && created && created.id) {
            const orgId =
                created.defaultOrganizationId != null
                    ? created.defaultOrganizationId
                    : payload.organizationId;
            if (orgId != null && orgId !== '') {
                await window.authModule.apiRequest(
                    `${getAdminApiBase()}/user-organizations/user/${created.id}/organization/${orgId}/role`,
                    { method: 'PUT', body: JSON.stringify({ role: 'manager' }) }
                );
            }
        }
        closeCreateUserModal();
        loadUsers();
        await appAlert('User created successfully');
    } catch (error) {
        const msg = (error && error.message) ? String(error.message) : 'Request failed';
        const isEmailConflict = /email.*exist|already.*used/i.test(msg);
        const displayMsg = isEmailConflict
            ? 'That email is already used by another account. Please choose a different email.'
            : msg;
        await appAlert(`Error creating user: ${displayMsg}`);
        if (isEmailConflict) {
            const emailEl = document.getElementById('userEmail');
            if (emailEl) {
                emailEl.focus();
                emailEl.select();
            }
        }
        // Keep modal open so user can correct and retry
    }
}

// Delete user
async function deleteUser(id) {
    if (!(await appConfirm('Are you sure you want to delete this user?'))) {
        return;
    }

    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/users/${id}`, {
            method: 'DELETE'
        });
        loadUsers();
        await appAlert('User deleted successfully');
    } catch (error) {
        await appAlert(`Error deleting user: ${error.message}`);
    }
}

