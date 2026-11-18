/**
 * Shared UI for auth pages styled like USAN OneCallAccess (password reveal, etc.).
 */
(function () {
    'use strict';

    function initPasswordToggles(root) {
        var scope = root || document;
        scope.querySelectorAll('[data-onecall-password-toggle]').forEach(function (btn) {
            if (btn.dataset.bound === '1') return;
            btn.dataset.bound = '1';
            var inputId = btn.getAttribute('aria-controls');
            var input = inputId ? document.getElementById(inputId) : null;
            if (!input) return;
            btn.addEventListener('click', function () {
                var show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.setAttribute('aria-pressed', show ? 'true' : 'false');
                btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
                btn.textContent = show ? 'Hide' : 'Show';
            });
        });
    }

    window.initAuthOnecallUi = function (root) {
        initPasswordToggles(root);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            initPasswordToggles(document);
        });
    } else {
        initPasswordToggles(document);
    }
})();
