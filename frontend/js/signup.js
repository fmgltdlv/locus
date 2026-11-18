/**
 * Multi-step self-service signup wizard.
 */
(function () {
  'use strict';

  const state = {
    email: '',
    preview: null,
    usanRequired: false,
    usanValidated: false,
    usanSkipped: false,
    usanFailCount: 0,
    usanUsername: '',
    usanPassword: '',
  };

  function apiBase() {
    if (typeof API_BASE !== 'undefined' && API_BASE) return String(API_BASE);
    if (window.API_BASE) return String(window.API_BASE);
    return `${window.location.origin}/api`;
  }

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Show spinner + label on login/signup primary buttons while async work runs.
   * @param {HTMLButtonElement | null} btn
   * @param {boolean} busy
   * @param {string} [label]
   */
  function setLoginButtonBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.loginBtnDefaultHtml) {
        btn.dataset.loginBtnDefaultHtml = btn.innerHTML;
      }
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('is-busy');
      const text = label || 'Please wait…';
      btn.innerHTML =
        '<span class="login-spinner" aria-hidden="true"></span><span class="login-button-label">' +
        text +
        '</span>';
      return;
    }
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.classList.remove('is-busy');
    if (btn.dataset.loginBtnDefaultHtml) {
      btn.innerHTML = btn.dataset.loginBtnDefaultHtml;
      delete btn.dataset.loginBtnDefaultHtml;
    }
  }

  window.setLoginButtonBusy = setLoginButtonBusy;

  function showError(msg) {
    const el = $('signupError');
    const info = $('signupInfo');
    if (info) {
      info.hidden = true;
      info.textContent = '';
    }
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function showInfo(msg) {
    const el = $('signupInfo');
    const err = $('signupError');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function hideAllSteps() {
    [
      'signupStepEmail',
      'signupStepJoin',
      'signupStepCreate',
      'signupStepUsan',
      'signupStepPassword',
      'signupStepCheckEmail',
      'signupStepThankYou',
      'signupStepVerified',
      'signupClosed',
    ].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = true;
    });
  }

  function showSignupsClosed() {
    hideAllSteps();
    const closed = $('signupClosed');
    if (closed) closed.hidden = false;
    const subtitle = $('signupSubtitle');
    if (subtitle) subtitle.textContent = 'Signups are closed';
  }

  function showStep(id) {
    hideAllSteps();
    const el = $(id);
    if (el) el.hidden = false;
    const footer = $('signupFooterLogin');
    if (footer) {
      footer.hidden = id === 'signupStepCheckEmail' || id === 'signupStepThankYou' || id === 'signupStepVerified';
    }
  }

  async function fetchJson(path, opts) {
    const res = await fetch(`${apiBase()}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts && opts.headers),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function onEmailNext() {
    showError('');
    const email = String(($('signupEmail') && $('signupEmail').value) || '')
      .trim()
      .toLowerCase();
    if (!email || !email.includes('@')) {
      showError('Enter a valid email address.');
      return;
    }
    state.email = email;
    state.preview = null;
    state.usanValidated = false;
    state.usanSkipped = false;
    state.usanFailCount = 0;
    const btn = $('signupEmailNext');
    setLoginButtonBusy(btn, true, 'Checking email…');
    try {
      const { res, data } = await fetchJson(`/auth/signup-preview?email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        if (data && data.path === 'blocked') {
          showSignupsClosed();
          return;
        }
        showError((data && (data.message || data.error)) || 'Could not check this email. Try again.');
        return;
      }
      state.preview = data;
      state.usanRequired = !!data.usanRequired;
      if (data.path === 'rejected' || data.path === 'blocked') {
        showError(data.message || 'Signup is not available for this email.');
        return;
      }
      if (data.path === 'join_org') {
        const names = Array.isArray(data.orgDisplayNames)
          ? data.orgDisplayNames
          : data.orgDisplayName
            ? [data.orgDisplayName]
            : [];
        const copy = $('signupJoinCopy');
        if (copy) {
          if (names.length > 1) {
            copy.textContent = `You'll join: ${names.join(' and ')}.`;
          } else if (names.length === 1) {
            copy.textContent = `You'll join ${names[0]}.`;
          } else {
            copy.textContent = "You'll join your organization.";
          }
        }
        showStep('signupStepJoin');
        return;
      }
      showStep('signupStepCreate');
    } catch (e) {
      showError('Network error. Try again.');
    } finally {
      setLoginButtonBusy(btn, false);
    }
  }

  function goUsanOrPassword() {
    if (state.preview && state.preview.path === 'create_org') {
      const hint = $('signupUsanHint');
      const skip = $('signupUsanSkip');
      if (state.usanRequired) {
        if (hint) {
          hint.textContent =
            'Public email domains must enter valid USAN credentials to create an organization. You cannot skip this step.';
        }
        if (skip) skip.hidden = true;
      } else {
        if (hint) {
          hint.textContent =
            'Optional: enter your company USAN credentials so we can sync tickets (last 45 days). Or skip and add them later in Admin → Service accounts.';
        }
        if (skip) skip.hidden = false;
      }
      showStep('signupStepUsan');
      return;
    }
    showStep('signupStepPassword');
  }

  async function onUsanValidate() {
    showError('');
    const user = String(($('signupUsanUser') && $('signupUsanUser').value) || '').trim();
    const pass = String(($('signupUsanPass') && $('signupUsanPass').value) || '');
    const status = $('signupUsanStatus');
    if (!user || !pass) {
      showError('Enter USAN username and password.');
      return;
    }
    const validateBtn = $('signupUsanValidate');
    setLoginButtonBusy(validateBtn, true, 'Validating…');
    if (status) {
      status.classList.remove('login-help-text--error', 'login-help-text--success');
      status.classList.add('login-help-text');
      status.textContent = 'Validating…';
    }
    try {
      const { res, data } = await fetchJson('/auth/signup-validate-usan', {
        method: 'POST',
        body: JSON.stringify({ username: user, password: pass, email: state.email }),
      });
      if (!res.ok || !data.ok) {
        state.usanValidated = false;
        const taken = data && data.code === 'USAN_USERNAME_TAKEN';
        // Username already linked is not a USAN login failure — don't burn public-domain retries.
        if (!taken) state.usanFailCount += 1;
        const msg =
          (data && data.error) ||
          (taken
            ? 'This USAN username is already linked to another organization.'
            : 'USAN login failed.');
        if (status) {
          status.classList.remove('login-help-text', 'login-help-text--success');
          status.classList.add('login-help-text--error');
          status.textContent = msg;
        }
        showError(msg);
        if (taken && typeof window.appAlert === 'function') {
          void window.appAlert(msg, { title: 'USAN username unavailable' });
        }
        if (!taken && state.usanRequired && state.usanFailCount >= 2) {
          // Allow them to submit once more; final POST will thank-you + burn
          showError('USAN validation failed again. You can try once more on Create account, or contact support.');
        }
        return;
      }
      state.usanValidated = true;
      state.usanSkipped = false;
      state.usanUsername = user;
      state.usanPassword = pass;
      if (status) {
        status.classList.remove('login-help-text', 'login-help-text--error');
        status.classList.add('login-help-text--success');
        status.textContent = 'USAN login verified.';
      }
      showStep('signupStepPassword');
    } catch (_e) {
      if (status) {
        status.classList.remove('login-help-text', 'login-help-text--success');
        status.classList.add('login-help-text--error');
        status.textContent = 'Network error.';
      }
    } finally {
      setLoginButtonBusy(validateBtn, false);
    }
  }

  function onUsanSkip() {
    if (state.usanRequired) return;
    state.usanSkipped = true;
    state.usanValidated = false;
    state.usanUsername = '';
    state.usanPassword = '';
    showStep('signupStepPassword');
  }

  async function onSubmit() {
    showError('');
    const password = String(($('signupPassword') && $('signupPassword').value) || '');
    const password2 = String(($('signupPassword2') && $('signupPassword2').value) || '');
    if (password !== password2) {
      showError('Passwords do not match.');
      if (typeof window.appAlert === 'function') {
        void window.appAlert('Password fields do not match.', { title: 'Password does not match' });
      }
      return;
    }
    if (window.validatePasswordPolicy) {
      const policy = window.validatePasswordPolicy(password);
      if (policy && policy.ok === false) {
        showError(policy.error || 'Password does not meet requirements.');
        return;
      }
    }

    const createPath = state.preview && state.preview.path === 'create_org';
    if (createPath && state.usanRequired && !state.usanValidated) {
      // Second chance at submit if they typed creds but didn't validate
      const user = String(($('signupUsanUser') && $('signupUsanUser').value) || '').trim();
      const pass = String(($('signupUsanPass') && $('signupUsanPass').value) || '');
      if (user && pass) {
        state.usanUsername = user;
        state.usanPassword = pass;
      }
    }

    const body = {
      email: state.email,
      password,
    };
    if (createPath) {
      body.orgName = String(($('signupOrgName') && $('signupOrgName').value) || '');
      body.seedAdmins = String(($('signupSeedAdmins') && $('signupSeedAdmins').value) || '');
      body.seedUsers = String(($('signupSeedUsers') && $('signupSeedUsers').value) || '');
      if (state.usanSkipped) {
        body.usanSkipped = true;
      } else if (state.usanUsername && state.usanPassword) {
        body.usanUsername = state.usanUsername;
        body.usanPassword = state.usanPassword;
      }
    }

    const btn = $('signupSubmit');
    setLoginButtonBusy(btn, true, 'Creating account…');
    try {
      const { res, data } = await fetchJson('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (data && data.thankYou) {
        showStep('signupStepThankYou');
        return;
      }
      if (!res.ok) {
        const msg = (data && data.error) || 'Signup failed.';
        showError(msg);
        if (
          data &&
          (data.code === 'USAN_USERNAME_TAKEN' || data.code === 'ORG_NAME_TAKEN') &&
          typeof window.appAlert === 'function'
        ) {
          void window.appAlert(msg, {
            title:
              data.code === 'ORG_NAME_TAKEN'
                ? 'Organization name unavailable'
                : 'USAN username unavailable',
          });
        }
        return;
      }
      showStep('signupStepCheckEmail');
      showInfo((data && data.message) || 'Check your email.');
    } catch (_e) {
      showError('Network error. Try again.');
    } finally {
      setLoginButtonBusy(btn, false);
    }
  }

  async function onResend() {
    showError('');
    const btn = $('signupResend');
    setLoginButtonBusy(btn, true, 'Sending…');
    try {
      const { res, data } = await fetchJson('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email: state.email }),
      });
      if (!res.ok) {
        if (data && data.path === 'blocked') {
          showSignupsClosed();
          return;
        }
        showError((data && (data.error || data.message)) || 'Could not resend. Try again later.');
        return;
      }
      showInfo((data && data.message) || 'If a pending signup exists, we sent another email.');
    } catch (_e) {
      showError('Could not resend. Try again later.');
    } finally {
      setLoginButtonBusy(btn, false);
    }
  }

  async function handleVerifyToken(token) {
    hideAllSteps();
    showInfo('Verifying your email…');
    try {
      const { res, data } = await fetchJson('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      showInfo('');
      if (!res.ok) {
        showError((data && data.error) || 'Verification failed.');
        if (window.LOCUS_SIGNUPS_CLOSED === true) showSignupsClosed();
        else showStep('signupStepEmail');
        return;
      }
      const copy = $('signupVerifiedCopy');
      if (copy) {
        copy.textContent = data.usanSyncStarted
          ? 'Your email is verified. A 45-day ticket sync has started. You can sign in now.'
          : 'Your email is verified. You can sign in now.';
      }
      showStep('signupStepVerified');
    } catch (_e) {
      showInfo('');
      showError('Verification network error.');
      if (window.LOCUS_SIGNUPS_CLOSED === true) showSignupsClosed();
      else showStep('signupStepEmail');
    }
  }

  async function onCreateNext() {
    showError('');
    const name = String(($('signupOrgName') && $('signupOrgName').value) || '').trim();
    if (!name) {
      showError('Organization name is required.');
      return;
    }
    if (/[^a-zA-Z0-9\s]/.test(name)) {
      showError('Organization name may only contain letters, numbers, and spaces.');
      return;
    }
    const btn = $('signupCreateNext');
    setLoginButtonBusy(btn, true, 'Checking name…');
    try {
      const { res, data } = await fetchJson(
        `/auth/signup-check-org-name?name=${encodeURIComponent(name)}`
      );
      if (!res.ok || data.available === false) {
        const msg =
          (data && data.error) ||
          'That organization name is already taken. Try a different name.';
        showError(msg);
        if (typeof window.appAlert === 'function') {
          void window.appAlert(msg, { title: 'Organization name unavailable' });
        }
        return;
      }
      goUsanOrPassword();
    } catch (_e) {
      showError('Network error. Try again.');
    } finally {
      setLoginButtonBusy(btn, false);
    }
  }

  function wireFormSubmit(formId, handler) {
    const form = $(formId);
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void handler();
    });
  }

  async function wire() {
    if (!$('signupEmail') && !$('signupLayout')) return;
    if (typeof window.loadPublicWorkerConfig === 'function') {
      try {
        await window.loadPublicWorkerConfig();
      } catch (_e) {
        /* signup stays open if config cannot be loaded */
      }
    }
    wireFormSubmit('signupFormEmail', onEmailNext);
    wireFormSubmit('signupFormCreate', onCreateNext);
    wireFormSubmit('signupFormUsan', onUsanValidate);
    wireFormSubmit('signupFormPassword', onSubmit);
    $('signupJoinNext') &&
      $('signupJoinNext').addEventListener('click', () => showStep('signupStepPassword'));
    $('signupJoinBack') && $('signupJoinBack').addEventListener('click', () => showStep('signupStepEmail'));
    $('signupCreateBack') && $('signupCreateBack').addEventListener('click', () => showStep('signupStepEmail'));
    $('signupUsanSkip') && $('signupUsanSkip').addEventListener('click', onUsanSkip);
    $('signupUsanBack') &&
      $('signupUsanBack').addEventListener('click', () => showStep('signupStepCreate'));
    $('signupPasswordBack') &&
      $('signupPasswordBack').addEventListener('click', () => {
        if (state.preview && state.preview.path === 'create_org') goUsanOrPassword();
        else if (state.preview && state.preview.path === 'join_org') showStep('signupStepJoin');
        else showStep('signupStepEmail');
      });
    $('signupResend') && $('signupResend').addEventListener('click', () => void onResend());

    const params = new URLSearchParams(window.location.search);
    // Prefer ?verify=; also accept /signup#verify=… if a proxy mangled the query string.
    let verify = params.get('verify');
    if (!verify && window.location.hash) {
      const hashParams = new URLSearchParams(String(window.location.hash).replace(/^#/, ''));
      verify = hashParams.get('verify');
    }
    if (params.get('verified') === '1') {
      const copy = $('signupVerifiedCopy');
      if (copy) {
        copy.textContent =
          params.get('usanSync') === '1'
            ? 'Your email is verified. A 45-day ticket sync has started. You can sign in now.'
            : 'Your email is verified. You can sign in now.';
      }
      showStep('signupStepVerified');
    } else if (verify) {
      void handleVerifyToken(verify);
    } else if (window.LOCUS_SIGNUPS_CLOSED === true) {
      showSignupsClosed();
    } else {
      showStep('signupStepEmail');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { void wire(); });
  } else {
    void wire();
  }
})();
