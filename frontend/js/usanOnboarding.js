/**
 * Welcome popup for org admins when the current org has no master USAN/service account.
 */
(function (global) {
  'use strict';

  const SESSION_KEY = 'locus_usan_welcome_dismissed_session';

  function canAdminCurrentOrg() {
    if (!global.authModule) return false;
    if (typeof global.authModule.isDev === 'function' && global.authModule.isDev()) return true;
    const orgId =
      global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
        ? global.orgSelectorModule.getCurrentOrgId()
        : null;
    if (orgId == null) return false;
    const user = global.authModule.getCurrentUser && global.authModule.getCurrentUser();
    if (!user) return false;
    if (user.role === 'admin' || user.role === 'dev') return true;
    const adminIds = (user.adminOrganizationIds || []).map(Number);
    return adminIds.includes(Number(orgId));
  }

  function sessionDismissed() {
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  function markSessionDismissed() {
    try {
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch (_e) {
      //
    }
  }

  async function orgHasMasterUsan(orgId) {
    if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return true;
    try {
      const rows = await global.authModule.apiRequest(`/api/organizations/${orgId}/source-accounts`);
      const list = Array.isArray(rows) ? rows : [];
      return list.some((a) => a && String(a.account_type || a.accountType || '') === 'master');
    } catch (_e) {
      return true;
    }
  }

  function ensureModal() {
    let el = document.getElementById('usanWelcomeModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'usanWelcomeModal';
    el.className = 'modal-overlay';
    el.style.display = 'none';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="modal-content" style="max-width: 520px;" onclick="event.stopPropagation()">' +
      '<div class="modal-header">' +
      '<h2 class="modal-title">Welcome to Locus</h2>' +
      '<button type="button" class="modal-close" data-usan-welcome-later aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="modal-body" style="line-height: 1.5;">' +
      '<p>Hey! Welcome to Locus! To get the most out of this program, enter your company\'s USAN credentials so that we can automatically sync your tickets to get the most out of the program. This can be done under the Service accounts tab in the Admin Panel found under the menu icon at the top left.</p>' +
      '<div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;">' +
      '<button type="button" class="btn btn-secondary" data-usan-welcome-later style="padding: 0.5rem 0.85rem; border-radius: 0.35rem; border: 1px solid #cbd5e1; background: #f8fafc; cursor: pointer;">Later</button>' +
      '<button type="button" class="btn btn-primary" data-usan-welcome-admin style="padding: 0.5rem 0.85rem; border-radius: 0.35rem; border: 0; background: #073047; color: #fff; cursor: pointer;">Open Admin</button>' +
      '</div></div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target === el) dismiss();
    });
    el.querySelectorAll('[data-usan-welcome-later]').forEach((btn) => {
      btn.addEventListener('click', dismiss);
    });
    const adminBtn = el.querySelector('[data-usan-welcome-admin]');
    if (adminBtn) {
      adminBtn.addEventListener('click', () => {
        markSessionDismissed();
        el.style.display = 'none';
        window.location.href = 'admin.html?tab=providerAccounts';
      });
    }
    return el;
  }

  function dismiss() {
    markSessionDismissed();
    const el = document.getElementById('usanWelcomeModal');
    if (el) el.style.display = 'none';
  }

  async function maybeShowUsanWelcomePopup() {
    if (sessionDismissed()) return;
    if (!canAdminCurrentOrg()) return;
    const orgId =
      global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
        ? global.orgSelectorModule.getCurrentOrgId()
        : null;
    if (orgId == null) return;
    if (await orgHasMasterUsan(orgId)) return;
    const el = ensureModal();
    el.style.display = 'flex';
  }

  global.usanOnboarding = {
    maybeShowUsanWelcomePopup,
  };
})(typeof window !== 'undefined' ? window : globalThis);
