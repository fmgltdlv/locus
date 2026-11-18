/**
 * Applies auth-shell branding from window.CORE_PRODUCT (set in config-override.js).
 * Copy is Locus; Core product mode also applies the night-ops theme.
 */
(function () {
    'use strict';

    var DEFAULT = {
        logoSrc: 'assets/logo-mark.svg',
        logoAlt: 'Locus',
        wordmark: 'LOCUS',
        tagline: '',
        powered: 'Locus',
        productShort: 'Locus',
        signupSubtitle: 'Create your Locus account',
        forgotHint: 'Enter the email on your account.',
    };

    var CORE = {
        logoSrc: '/assets/logo-mark-core.svg',
        logoAlt: 'Locus',
        wordmark: 'LOCUS',
        tagline: '',
        powered: 'Locus',
        productShort: 'Locus',
        signupSubtitle: 'Create your Locus account',
        forgotHint: 'Enter the email on your account.',
        themeColor: '#0b0d10',
    };

    function isCoreProduct() {
        return window.CORE_PRODUCT === true;
    }

    function brand() {
        return isCoreProduct() ? CORE : DEFAULT;
    }

    function setText(el, text) {
        if (!el || text == null) return;
        el.textContent = text;
    }

    function applyCoreProductClass(doc) {
        if (!isCoreProduct()) return;
        doc.documentElement.classList.add('core-product');
        if (doc.body) {
            doc.body.classList.add('core-product', 'auth-page--core');
        }
    }

    function applyPageTitle(doc, b) {
        var title = doc.querySelector('title');
        if (!title) return;
        var raw = title.getAttribute('data-auth-title-base') || title.textContent || '';
        var base = raw.replace(/\s*[—–-]\s*.+$/, '').trim();
        if (!base) return;
        title.textContent = base + ' — ' + b.productShort;
    }

    function applyTagline(scope, b) {
        var el = scope.querySelector('[data-auth-brand="tagline"]');
        if (!el) return;
        var text = b.tagline ? String(b.tagline).trim() : '';
        if (!text) {
            el.hidden = true;
            el.textContent = '';
            return;
        }
        el.hidden = false;
        el.textContent = text;
    }

    function applyAuthBranding(root) {
        var doc = root && root.ownerDocument ? root.ownerDocument : document;
        var scope = root || doc;
        var b = brand();

        applyCoreProductClass(doc);

        scope.querySelectorAll('[data-auth-brand="logo-img"]').forEach(function (img) {
            if (isCoreProduct()) {
                img.hidden = true;
                img.alt = '';
                img.src = b.logoSrc;
                return;
            }
            img.hidden = false;
            img.src = b.logoSrc;
            img.alt = b.logoAlt;
        });

        var favicon = doc.querySelector('link[rel="icon"]');
        if (favicon) favicon.href = b.logoSrc;

        var theme = doc.querySelector('meta[name="theme-color"]');
        if (theme && b.themeColor) theme.setAttribute('content', b.themeColor);

        setText(scope.querySelector('[data-auth-brand="logo-word"]'), b.wordmark);
        applyTagline(scope, b);
        setText(scope.querySelector('[data-auth-brand="powered-name"]'), b.powered);
        setText(scope.querySelector('[data-auth-brand="signup-subtitle"]'), b.signupSubtitle);
        setText(scope.querySelector('[data-auth-brand="forgot-hint"]'), b.forgotHint);

        applyPageTitle(doc, b);
        hideCorePrivacyLinks(scope);
    }

    function hideCorePrivacyLinks(scope) {
        if (!isCoreProduct()) return;
        scope.querySelectorAll('.login-legal-footer, .onecall-terms').forEach(function (el) {
            el.hidden = true;
        });
        var accept = scope.querySelector('#acceptTerms');
        if (accept) {
            accept.required = false;
            accept.removeAttribute('required');
        }
    }

    window.applyAuthBranding = applyAuthBranding;

    function boot() {
        applyAuthBranding(document);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
