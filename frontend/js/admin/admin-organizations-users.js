// View user
function viewUser(id) {
    const user = users.find(u => u.id === id);
    if (user) {
        openEditUserModal(user);
    }
}

// Edit user modal
function openEditUserModal(user) {
    // Create or show edit user modal
    let modal = document.getElementById('editUserModal');
    if (!modal) {
        // Create modal if it doesn't exist
        modal = document.createElement('div');
        modal.id = 'editUserModal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 500px;">
                <div class="modal-header">
                    <h2 class="modal-title">Edit User</h2>
                    <button class="modal-close" onclick="closeEditUserModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form class="admin-form" id="editUserForm">
                        <div class="admin-form-group">
                            <label class="admin-form-label">Username</label>
                            <input type="text" class="admin-form-input" id="editUserUsername" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Email</label>
                            <input type="email" class="admin-form-input" id="editUserEmail" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Full Name</label>
                            <input type="text" class="admin-form-input" id="editUserFullName" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Phone</label>
                            <input type="tel" class="admin-form-input" id="editUserPhone" maxlength="10" inputmode="numeric" pattern="[0-9]{10}" placeholder="10-digit mobile" autocomplete="tel" />
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Language</label>
                            <select class="admin-form-input" id="editUserLanguage">
                                <option value="en">English</option>
                                <option value="es">Spanish</option>
                            </select>
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label" id="editUserRoleLabel">Role</label>
                            <select class="admin-form-input" id="editUserRole">
                                <option value="operator">Operator</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Organizations</label>
                            <div id="editUserOrganizationsList" style="margin-bottom: 0.5rem;"></div>
                            <div style="display: flex; gap: 0.5rem;">
                                <select class="admin-form-input" id="editUserAddOrganization" style="flex: 1;">
                                    <option value="">Select organization to add...</option>
                                </select>
                                <button type="button" class="admin-button admin-button-primary" onclick="addUserToOrganization()">Add</button>
                            </div>
                        </div>
                        <div class="admin-form-group">
                            <label class="admin-form-label">Default Organization</label>
                            <select class="admin-form-input" id="editUserDefaultOrganization">
                                <option value="">None</option>
                            </select>
                            <p style="font-size: 0.75rem; color: var(--app-text-secondary); margin-top: 0.25rem;">The organization this user will see by default</p>
                        </div>
                        <div id="editUserAuthLimits" class="admin-form-group" style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--app-bg-muted); display: none;">
                            <label class="admin-form-label">Sign-in limits</label>
                            <div id="editUserAuthLimitsBody" style="font-size: 0.85rem; color: var(--app-text-secondary);"></div>
                            <p style="font-size: 0.75rem; color: var(--app-text-secondary); margin-top: 0.35rem;">A shared network limit is separate and still expires in 15 minutes.</p>
                            <button type="button" class="admin-button admin-button-secondary" id="editUserClearAuthLimits" style="margin-top: 0.5rem; display: none;">Clear limits</button>
                        </div>
                        <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--app-bg-muted);">
                            <div class="admin-form-group">
                                <label class="admin-form-label">New Password (leave blank to keep current)</label>
                                <input type="password" class="admin-form-input" id="editUserPassword" placeholder="Enter new password" autocomplete="new-password" />
                            </div>
                            <div class="admin-form-group">
                                <label class="admin-form-label">Confirm New Password</label>
                                <input type="password" class="admin-form-input" id="editUserConfirmPassword" placeholder="Confirm new password" autocomplete="new-password" />
                            </div>
                        </div>
                        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
                            <button type="button" class="admin-button admin-button-secondary" onclick="closeEditUserModal()">Cancel</button>
                            <button type="submit" class="admin-button admin-button-primary">Save Changes</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add form submit handler
        document.getElementById('editUserForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            await saveUserChanges(window.currentEditUserId);
        });
        document.getElementById('editUserClearAuthLimits').addEventListener('click', async function () {
            const btn = this;
            const userId = window.currentEditUserId;
            if (!userId || btn.disabled) return;
            btn.disabled = true;
            try {
                const limits = await window.authModule.apiRequest(
                    `${getAdminApiBase()}/users/${userId}/auth-limits/clear`,
                    { method: 'POST' }
                );
                renderEditUserAuthLimits(limits);
            } catch (err) {
                const body = document.getElementById('editUserAuthLimitsBody');
                if (body) body.textContent = 'Could not clear limits. Try again.';
                btn.disabled = false;
            }
        });
    }
    
    window.currentEditUserId = user.id;
    
    // Role dropdown: per-org when an org is selected, global otherwise
    const roleLabel = document.getElementById('editUserRoleLabel');
    const roleSelect = document.getElementById('editUserRole');
    const selectedOrgId = getCurrentAdminOrgId();
    if (selectedOrgId != null) {
        roleLabel.textContent = 'Role (in selected organization)';
        roleSelect.innerHTML = '<option value="operator">Operator</option><option value="manager">Manager</option><option value="tech">Tech</option><option value="admin">Admin</option>';
        roleSelect.disabled = false;
        const orgRole = normalizeOrgRoleValue(user.organizationRole);
        roleSelect.value = VALID_ORG_ROLES.includes(orgRole) ? orgRole : 'operator';
    } else {
        roleLabel.textContent = 'Role';
        roleSelect.innerHTML = '<option value="operator">Operator</option><option value="admin">Admin</option>' + (window.authModule.isDev() ? '<option value="dev">Dev</option>' : '');
        roleSelect.disabled = !window.authModule.isDev();
        roleSelect.value = normalizeOrgRoleValue(user.role || 'operator');
    }
    
    // Populate form with user data
    document.getElementById('editUserUsername').value = user.username || '';
    document.getElementById('editUserEmail').value = user.email || '';
    document.getElementById('editUserFullName').value = user.full_name || '';
    const editPhoneEl = document.getElementById('editUserPhone');
    if (editPhoneEl) {
        editPhoneEl.value = user.phone || '';
        if (editPhoneEl.dataset.phoneFilterBound !== '1') {
            editPhoneEl.dataset.phoneFilterBound = '1';
            editPhoneEl.addEventListener('input', function () {
                const filtered = String(editPhoneEl.value || '').replace(/\D/g, '').slice(0, 10);
                if (filtered !== editPhoneEl.value) editPhoneEl.value = filtered;
            });
        }
    }
    document.getElementById('editUserLanguage').value = (user.preferred_language === 'es' || user.preferredLanguage === 'es') ? 'es' : 'en';
    document.getElementById('editUserPassword').value = '';
    document.getElementById('editUserConfirmPassword').value = '';
    if (typeof window.setPasswordFieldAutofillActive === 'function') {
        window.setPasswordFieldAutofillActive(document.getElementById('editUserPassword'), true, 'new');
        window.setPasswordFieldAutofillActive(document.getElementById('editUserConfirmPassword'), true, 'new');
    }
    
    // Load user's organizations
    loadUserOrganizations(user.id);
    loadEditUserAuthLimits(user.id);
    
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

const VALID_ORG_ROLES = ['operator', 'manager', 'admin', 'tech', 'user'];

function normalizeOrgRoleValue(role) {
    if (window.rolesModule && typeof window.rolesModule.normalizeOrgRole === 'function') {
        return window.rolesModule.normalizeOrgRole(role);
    }
    const r = role != null ? String(role).trim() : '';
    if (!r || r === 'user') return 'operator';
    return r;
}
function authLimitLine(label, bucket) {
    if (bucket && bucket.limited && bucket.resetAt) {
        return label + ': Limited until ' + new Date(bucket.resetAt).toLocaleString();
    }
    return label + ': Not limited';
}

function renderEditUserAuthLimits(limits) {
    const body = document.getElementById('editUserAuthLimitsBody');
    const clearBtn = document.getElementById('editUserClearAuthLimits');
    if (!body || !clearBtn || !limits) return;
    const email = String((document.getElementById('editUserEmail') || {}).value || '').trim().toLowerCase();
    const username = String((document.getElementById('editUserUsername') || {}).value || '').trim().toLowerCase();
    const lines = [
        authLimitLine('Password reset', limits.passwordReset),
        authLimitLine('Sign-in for this email', limits.loginEmail)
    ];
    if (username && username !== email) {
        lines.push(authLimitLine('Sign-in for this username', limits.loginUsername));
    }
    body.textContent = '';
    lines.forEach(function (text) {
        const line = document.createElement('p');
        line.style.margin = '0.15rem 0';
        line.textContent = text;
        body.appendChild(line);
    });
    const buckets = [limits.passwordReset, limits.loginEmail, limits.loginUsername];
    const anyLimited = buckets.some(function (bucket) { return bucket && bucket.limited; });
    clearBtn.style.display = anyLimited ? '' : 'none';
    clearBtn.disabled = false;
}

async function loadEditUserAuthLimits(userId) {
    const section = document.getElementById('editUserAuthLimits');
    const body = document.getElementById('editUserAuthLimitsBody');
    const clearBtn = document.getElementById('editUserClearAuthLimits');
    if (!section || !body || !clearBtn) return;
    if (!window.authModule || typeof window.authModule.isAdmin !== 'function' || !window.authModule.isAdmin()) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';
    body.textContent = 'Checking sign-in limits…';
    clearBtn.style.display = 'none';
    clearBtn.disabled = false;
    try {
        const limits = await window.authModule.apiRequest(`${getAdminApiBase()}/users/${userId}/auth-limits`);
        renderEditUserAuthLimits(limits);
    } catch (err) {
        body.textContent = 'Could not load sign-in limits.';
    }
}

async function loadUserOrganizations(userId) {
    try {
        const userOrgs = await window.authModule.apiRequest(`${getAdminApiBase()}/user-organizations/user/${userId}`);
        const orgsSelect = document.getElementById('editUserAddOrganization');
        const defaultOrgSelect = document.getElementById('editUserDefaultOrganization');
        const orgsList = document.getElementById('editUserOrganizationsList');
        
        // Populate organization dropdowns
        const allOrgs = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations`);
        const userOrgIds = userOrgs.filter(org => org.is_member === 1).map(org => org.id);
        const defaultOrgId = userOrgs.find(org => org.is_default === 1)?.id || null;
        
        // Clear and populate add organization dropdown
        orgsSelect.innerHTML = '<option value="">Select organization to add...</option>';
        allOrgs.forEach(org => {
            if (!userOrgIds.includes(org.id)) {
                const option = document.createElement('option');
                option.value = org.id;
                option.textContent = org.name;
                orgsSelect.appendChild(option);
            }
        });
        
        // Clear and populate default organization dropdown
        defaultOrgSelect.innerHTML = '<option value="">None</option>';
        userOrgs.filter(org => org.is_member === 1).forEach(org => {
            const option = document.createElement('option');
            option.value = org.id;
            option.textContent = org.name + (org.is_default === 1 ? ' (Default)' : '');
            if (org.is_default === 1) {
                option.selected = true;
            }
            defaultOrgSelect.appendChild(option);
        });
        // Remember initial default so we only call default-organization API when it actually changed
        window.currentEditUserDefaultOrgId = defaultOrgSelect.value || '';
        
        // Display current organizations
        orgsList.innerHTML = userOrgs.filter(org => org.is_member === 1).map(org => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background: var(--app-bg-surface); border-radius: 0.25rem; margin-bottom: 0.5rem;">
                <span>${escapeAdminHtml(org.name)}${org.is_default === 1 ? ' <strong style="color: var(--app-accent);">(Default)</strong>' : ''}</span>
                <button type="button" class="admin-button admin-button-danger" onclick="removeUserFromOrganization(${userId}, ${org.id})" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
            </div>
        `).join('');
        
        // When an org is selected in the admin panel, set Role dropdown to this user's role in that org
        const selectedOrgId = getCurrentAdminOrgId();
        if (selectedOrgId != null) {
            const membership = userOrgs.find(o => o.id === selectedOrgId && o.is_member === 1);
            const roleSelect = document.getElementById('editUserRole');
            if (roleSelect && membership && membership.org_role) {
                const orgRole = normalizeOrgRoleValue(membership.org_role);
                roleSelect.value = VALID_ORG_ROLES.includes(orgRole) ? orgRole : 'operator';
            }
        }
        
        // Store current user ID for later use
        window.currentEditUserId = userId;
    } catch (error) {
        console.error('Error loading user organizations:', error);
        await appAlert(`Error loading organizations: ${error.message}`);
    }
}

// Add user to organization
async function addUserToOrganization() {
    const userId = window.currentEditUserId;
    const orgId = parseInt(document.getElementById('editUserAddOrganization').value);
    
    if (!userId || !orgId) {
        await appAlert('Please select an organization to add.');
        return;
    }
    
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/user-organizations/user/${userId}/organization/${orgId}`, {
            method: 'POST'
        });
        
        // Reload user organizations
        await loadUserOrganizations(userId);
        await appAlert('User added to organization successfully');
    } catch (error) {
        await appAlert(`Error adding user to organization: ${error.message}`);
    }
}

// Remove user from organization
async function removeUserFromOrganization(userId, orgId) {
    if (!(await appConfirm('Are you sure you want to remove this user from this organization?'))) {
        return;
    }
    
    try {
        await window.authModule.apiRequest(`${getAdminApiBase()}/user-organizations/user/${userId}/organization/${orgId}`, {
            method: 'DELETE'
        });
        
        // Reload user organizations
        await loadUserOrganizations(userId);
        await appAlert('User removed from organization successfully');
    } catch (error) {
        await appAlert(`Error removing user from organization: ${error.message}`);
    }
}

function closeEditUserModal() {
    const modal = document.getElementById('editUserModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
    const pwd = document.getElementById('editUserPassword');
    const confirmPwd = document.getElementById('editUserConfirmPassword');
    if (pwd) pwd.value = '';
    if (confirmPwd) confirmPwd.value = '';
    if (typeof window.setPasswordFieldAutofillActive === 'function') {
        window.setPasswordFieldAutofillActive(pwd, false);
        window.setPasswordFieldAutofillActive(confirmPwd, false);
    }
}

async function saveUserChanges(userId) {
    const password = document.getElementById('editUserPassword').value;
    const confirmPassword = document.getElementById('editUserConfirmPassword').value;
    
    // Validate password if provided
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            await appAlert('Passwords do not match.');
            return;
        }
        const policy = window.validatePasswordPolicy
            ? window.validatePasswordPolicy(password)
            : { ok: true };
        if (!policy.ok) {
            await appAlert(policy.error || window.PASSWORD_POLICY_MESSAGE);
            return;
        }
    }
    
    const phoneRaw = document.getElementById('editUserPhone') ? document.getElementById('editUserPhone').value : '';
    const phoneDigits = String(phoneRaw || '').replace(/\D/g, '');
    if (phoneDigits && !/^\d{10}$/.test(phoneDigits)) {
        await appAlert('Phone number must be exactly 10 digits.');
        return;
    }

    const updateData = {
        username: (document.getElementById('editUserUsername') && document.getElementById('editUserUsername').value.trim()) || null,
        email: document.getElementById('editUserEmail').value.trim(),
        fullName: document.getElementById('editUserFullName').value.trim() || null,
        phone: phoneDigits || null,
        preferredLanguage: document.getElementById('editUserLanguage').value === 'es' ? 'es' : 'en'
    };
    
    // Only include password if provided
    if (password) {
        updateData.password = password;
    }
    
    const selectedOrgId = getCurrentAdminOrgId();
    const roleInOrgContext = selectedOrgId != null;
    
    // Role: when an org is selected, update per-org role via user-organizations; otherwise (no org selected) only dev can set global role
    if (roleInOrgContext) {
        // Per-org role: call PUT user-organizations/.../role (do not send role to PUT /users)
        const orgRole = document.getElementById('editUserRole').value;
        if (orgRole && VALID_ORG_ROLES.includes(orgRole)) {
            try {
                await window.authModule.apiRequest(`${getAdminApiBase()}/user-organizations/user/${userId}/organization/${selectedOrgId}/role`, {
                    method: 'PUT',
                    body: JSON.stringify({ role: orgRole })
                });
            } catch (error) {
                console.error('Error updating org role:', error);
                await appAlert(`Error updating role: ${error.message}`);
                return;
            }
        }
    } else if (window.authModule.isDev()) {
        updateData.role = document.getElementById('editUserRole').value;
    }
    
    // Default organization: only send if it changed (avoids unnecessary default-organization call and "not a member" error)
    const defaultOrgId = document.getElementById('editUserDefaultOrganization').value;
    const defaultOrgChanged = (defaultOrgId || '') !== (window.currentEditUserDefaultOrgId || '');
    if (defaultOrgChanged && window.authModule.isDev()) {
        // Dev can set default org via main user update (no membership check; avoids role overwrite in default-organization endpoint)
        updateData.organizationId = defaultOrgId ? parseInt(defaultOrgId, 10) : null;
    }
    
    // Call default-organization endpoint only when default changed and we're admin (dev uses main update above)
    if (defaultOrgChanged && !window.authModule.isDev() && defaultOrgId) {
        try {
            await window.authModule.apiRequest(`${getAdminApiBase()}/user-organizations/user/${userId}/default-organization/${defaultOrgId}`, {
                method: 'PUT'
            });
        } catch (error) {
            console.error('Error updating default organization:', error);
            await appAlert(`Error updating default organization: ${error.message}`);
            return;
        }
    }
    
    try {
        const updateResult = await window.authModule.apiRequest(`${getAdminApiBase()}/users/${userId}`, {
            method: 'PUT',
            body: JSON.stringify(updateData)
        });
        const currentUser = window.authModule && window.authModule.getCurrentUser && window.authModule.getCurrentUser();
        if (currentUser && Number(currentUser.id) === Number(userId) && updateResult && updateResult.token && window.authModule.setAuthToken) {
            window.authModule.setAuthToken(updateResult.token);
        }
        if (currentUser && Number(currentUser.id) === Number(userId) && window.authModule.refreshUser) {
            const refreshedUser = await window.authModule.refreshUser();
            if (window.appI18n && refreshedUser && refreshedUser.preferredLanguage) {
                window.appI18n.setLanguage(refreshedUser.preferredLanguage);
            }
        }
        
        closeEditUserModal();
        loadUsers();
        await appAlert('User updated successfully');
    } catch (error) {
        const msg = (error && error.message) ? String(error.message) : 'Request failed';
        const isEmailConflict = /email.*exist|already.*used/i.test(msg);
        const isUsernameConflict = /username.*exist|already.*taken/i.test(msg);
        const displayMsg = isEmailConflict
            ? 'That email is already used by another account. Please choose a different email.'
            : isUsernameConflict
                ? 'That username is already taken. Please choose a different username.'
                : msg;
        await appAlert(`Error updating user: ${displayMsg}`);
        if (isEmailConflict) {
            const emailEl = document.getElementById('editUserEmail');
            if (emailEl) {
                emailEl.focus();
                emailEl.select();
            }
        }
        if (isUsernameConflict) {
            const usernameEl = document.getElementById('editUserUsername');
            if (usernameEl) {
                usernameEl.focus();
                usernameEl.select();
            }
        }
        // Do not close modal so user can correct and retry
    }
}

function openCreateUserModal() {
    // Role options: User / Admin (/ Dev for devs). Tech is org-scoped — shown when an org is selected.
    var roleSelect = document.getElementById('userRole');
    var orgSelect = document.getElementById('userOrganization');
    function refreshCreateUserRoleOptions() {
        if (!roleSelect) return;
        var prev = roleSelect.value;
        var orgSelected = false;
        if (window.authModule.isDev()) {
            orgSelected = !!(orgSelect && orgSelect.value);
        } else {
            // Non-dev admin always creates into an admin org (API default).
            orgSelected = true;
        }
        roleSelect.innerHTML = '<option value="operator">Operator</option>';
        if (orgSelected) {
            roleSelect.innerHTML += '<option value="manager">Manager</option><option value="tech">Tech</option>';
        }
        roleSelect.innerHTML += '<option value="admin">Admin</option>';
        if (window.authModule.isDev()) {
            roleSelect.innerHTML += '<option value="dev">Dev</option>';
        }
        if (prev && [].some.call(roleSelect.options, function (o) { return o.value === prev; })) {
            roleSelect.value = prev;
        } else if ((prev === 'tech' || prev === 'manager') && !orgSelected) {
            roleSelect.value = 'operator';
        }
    }
    refreshCreateUserRoleOptions();
    if (orgSelect && !orgSelect._techRoleListenerBound) {
        orgSelect.addEventListener('change', refreshCreateUserRoleOptions);
        orgSelect._techRoleListenerBound = true;
    }
    // Load organizations for dropdown (if dev)
    if (window.authModule.isDev()) {
        loadOrganizationsForDropdown().then(function () {
            refreshCreateUserRoleOptions();
        });
    } else {
        // Admin can only create users in their org
        document.getElementById('userOrgGroup').style.display = 'none';
    }
    document.getElementById('createUserModal').style.display = 'flex';
    if (typeof window.setPasswordFieldAutofillActive === 'function') {
        window.setPasswordFieldAutofillActive(document.getElementById('userPassword'), true, 'new');
    }
}

async function loadOrganizationsForDropdown() {
    const select = document.getElementById('userOrganization');
    try {
        const orgs = await window.authModule.apiRequest(`${getAdminApiBase()}/organizations`);
        select.innerHTML = '<option value="">None</option>' + orgs.map(org => 
            `<option value="${escapeAdminHtml(org.id)}">${escapeAdminHtml(org.name)}</option>`
        ).join('');
    } catch (error) {
        console.error('Error loading organizations:', error);
    }
}

function closeCreateUserModal() {
    document.getElementById('createUserModal').style.display = 'none';
    document.getElementById('createUserForm').reset();
    document.getElementById('userOrgGroup').style.display = 'flex';
    if (typeof window.setPasswordFieldAutofillActive === 'function') {
        window.setPasswordFieldAutofillActive(document.getElementById('userPassword'), false);
    }
}
