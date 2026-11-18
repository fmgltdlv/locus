/**
 * First-run guided tour: spotlight overlay, step navigation, hub choreography.
 */
(function (global) {
    'use strict';

    const STORAGE_PREFIX = 'locus_guided_tour_v1_done:';
    const PADDING = 8;
    const MQ = global.matchMedia('(max-width: 768px)');

    let active = false;
    let currentIndex = 0;
    let rootEl = null;
    let svgEl = null;
    let holeEl = null;
    let cardEl = null;
    let highlightedEl = null;
    let uiSnapshot = null;
    let mapLockState = null;
    let keyHandler = null;

    function isMobile() {
        return MQ.matches;
    }

    /** Opt-in via config-override: `window.LOCUS_ENABLE_GUIDED_TOUR = true`. Off by default. */
    function isGuidedTourEnabled() {
        return global.LOCUS_ENABLE_GUIDED_TOUR === true;
    }

    function getSteps() {
        return Array.isArray(global.guidedTourStepDefinitions) ? global.guidedTourStepDefinitions : [];
    }

    function getUserId() {
        const user = global.authModule && global.authModule.getCurrentUser ? global.authModule.getCurrentUser() : null;
        if (!user) return 'anon';
        return String(user.id != null ? user.id : user.email || 'anon');
    }

    function storageKey() {
        return STORAGE_PREFIX + getUserId();
    }

    function isTourDone() {
        try {
            return localStorage.getItem(storageKey()) === '1';
        } catch (_e) {
            return false;
        }
    }

    function markTourDone() {
        try {
            localStorage.setItem(storageKey(), '1');
        } catch (_e) {
            //
        }
    }

    function isTicketHubOpen() {
        const el = document.getElementById('ticketHubWindow');
        return !!(el && el.classList.contains('show'));
    }

    function isDataHubOpen() {
        const el = document.getElementById('dataWindow');
        return !!(el && el.classList.contains('show'));
    }

    function isAccountMenuOpen() {
        const el = document.getElementById('accountCircleMenu');
        return !!(el && el.classList.contains('map-circle-menu--open'));
    }

    function captureUiSnapshot() {
        return {
            ticketHub: isTicketHubOpen(),
            dataHub: isDataHubOpen(),
            accountMenu: isAccountMenuOpen(),
        };
    }

    function restoreUiSnapshot() {
        if (!uiSnapshot) return;
        if (typeof global.closeAllCircleMenus === 'function') {
            global.closeAllCircleMenus();
        }
        if (typeof global.closeMapTopLeftLauncher === 'function') {
            global.closeMapTopLeftLauncher();
        }
        if (isTicketHubOpen() && !uiSnapshot.ticketHub && typeof global.closeTicketHubWindow === 'function') {
            global.closeTicketHubWindow();
        }
        if (!isTicketHubOpen() && uiSnapshot.ticketHub && typeof global.openTicketHubWindow === 'function') {
            void global.openTicketHubWindow();
        }
        if (isDataHubOpen() && !uiSnapshot.dataHub && typeof global.closeDataWindow === 'function') {
            global.closeDataWindow();
        }
        if (!isDataHubOpen() && uiSnapshot.dataHub && typeof global.openDataWindow === 'function') {
            global.openDataWindow();
        }
        if (!isAccountMenuOpen() && uiSnapshot.accountMenu && typeof global.openAccountMenu === 'function') {
            global.openAccountMenu();
        }
    }

    function lockMap() {
        const map = global.map;
        if (!map) return;
        mapLockState = {
            dragging: map.dragging && map.dragging.enabled(),
            scrollWheelZoom: map.scrollWheelZoom && map.scrollWheelZoom.enabled(),
            touchZoom: map.touchZoom && map.touchZoom.enabled(),
            doubleClickZoom: map.doubleClickZoom && map.doubleClickZoom.enabled(),
            boxZoom: map.boxZoom && map.boxZoom.enabled(),
            keyboard: map.keyboard && map.keyboard.enabled(),
        };
        if (map.dragging && map.dragging.disable) map.dragging.disable();
        if (map.scrollWheelZoom && map.scrollWheelZoom.disable) map.scrollWheelZoom.disable();
        if (map.touchZoom && map.touchZoom.disable) map.touchZoom.disable();
        if (map.doubleClickZoom && map.doubleClickZoom.disable) map.doubleClickZoom.disable();
        if (map.boxZoom && map.boxZoom.disable) map.boxZoom.disable();
        if (map.keyboard && map.keyboard.disable) map.keyboard.disable();
    }

    function unlockMap() {
        const map = global.map;
        if (!map || !mapLockState) {
            mapLockState = null;
            return;
        }
        if (mapLockState.dragging && map.dragging && map.dragging.enable) map.dragging.enable();
        if (mapLockState.scrollWheelZoom && map.scrollWheelZoom && map.scrollWheelZoom.enable) {
            map.scrollWheelZoom.enable();
        }
        if (mapLockState.touchZoom && map.touchZoom && map.touchZoom.enable) map.touchZoom.enable();
        if (mapLockState.doubleClickZoom && map.doubleClickZoom && map.doubleClickZoom.enable) {
            map.doubleClickZoom.enable();
        }
        if (mapLockState.boxZoom && map.boxZoom && map.boxZoom.enable) map.boxZoom.enable();
        if (mapLockState.keyboard && map.keyboard && map.keyboard.enable) map.keyboard.enable();
        mapLockState = null;
    }

    function clearHighlight() {
        if (highlightedEl) {
            highlightedEl.classList.remove('guided-tour-highlight-target');
            highlightedEl = null;
        }
    }

    function resolveElement(step) {
        if (!step || typeof step.resolveTarget !== 'function') return null;
        const target = step.resolveTarget();
        if (!target) return null;
        if (typeof target === 'string') {
            const el = document.querySelector(target);
            if (el && el.hidden) return null;
            return el;
        }
        if (target.nodeType === 1) return target;
        return null;
    }

    function ensureDom() {
        if (rootEl) return;
        rootEl = document.createElement('div');
        rootEl.className = 'guided-tour-root';
        rootEl.setAttribute('role', 'presentation');
        rootEl.innerHTML =
            '<svg class="guided-tour-overlay-svg" aria-hidden="true">' +
            '<defs><mask id="guidedTourSpotMask">' +
            '<rect id="guidedTourMaskFill" x="0" y="0" width="100%" height="100%" fill="white"/>' +
            '<rect id="guidedTourMaskHole" x="0" y="0" width="0" height="0" fill="black" rx="8"/>' +
            '</mask></defs>' +
            '<rect x="0" y="0" width="100%" height="100%" fill="rgba(7, 48, 71, 0.55)" mask="url(#guidedTourSpotMask)"/>' +
            '</svg>';
        document.body.appendChild(rootEl);
        svgEl = rootEl.querySelector('.guided-tour-overlay-svg');
        holeEl = rootEl.querySelector('#guidedTourMaskHole');
        const fillEl = rootEl.querySelector('#guidedTourMaskFill');
        if (fillEl) {
            fillEl.setAttribute('width', String(global.innerWidth));
            fillEl.setAttribute('height', String(global.innerHeight));
        }

        cardEl = document.createElement('div');
        cardEl.className = 'guided-tour-card';
        cardEl.setAttribute('role', 'dialog');
        cardEl.setAttribute('aria-modal', 'true');
        rootEl.appendChild(cardEl);

        svgEl.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
        });
    }

    function updateSpotlight(targetEl) {
        if (!holeEl || !svgEl) return;
        const fillEl = rootEl.querySelector('#guidedTourMaskFill');
        if (fillEl) {
            fillEl.setAttribute('width', String(global.innerWidth));
            fillEl.setAttribute('height', String(global.innerHeight));
        }
        if (!targetEl) {
            holeEl.setAttribute('width', '0');
            holeEl.setAttribute('height', '0');
            return;
        }
        const rect = targetEl.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
            holeEl.setAttribute('width', '0');
            holeEl.setAttribute('height', '0');
            return;
        }
        const x = Math.max(0, rect.left - PADDING);
        const y = Math.max(0, rect.top - PADDING);
        const w = Math.min(global.innerWidth, rect.width + PADDING * 2);
        const h = Math.min(global.innerHeight, rect.height + PADDING * 2);
        holeEl.setAttribute('x', String(x));
        holeEl.setAttribute('y', String(y));
        holeEl.setAttribute('width', String(w));
        holeEl.setAttribute('height', String(h));
        try {
            targetEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch (_e) {
            //
        }
    }

    function positionCard(step, targetEl) {
        if (!cardEl) return;
        cardEl.classList.toggle('guided-tour-card--center', step.placement === 'center' || !targetEl);
        if (step.placement === 'center' || !targetEl) {
            cardEl.style.left = '';
            cardEl.style.top = '';
            cardEl.style.right = '';
            cardEl.style.bottom = '';
            return;
        }
        if (isMobile()) {
            cardEl.style.left = '';
            cardEl.style.top = '';
            cardEl.style.right = '';
            cardEl.style.bottom = '';
            return;
        }
        const rect = targetEl.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        const margin = 12;
        let top = rect.bottom + margin;
        let left = rect.left;
        if (step.placement === 'left') {
            top = rect.top;
            left = rect.left - cardRect.width - margin;
        } else if (step.placement === 'right') {
            top = rect.top;
            left = rect.right + margin;
        } else if (step.placement === 'top') {
            top = rect.top - cardRect.height - margin;
            left = rect.left;
        }
        left = Math.max(12, Math.min(left, global.innerWidth - cardRect.width - 12));
        top = Math.max(12, Math.min(top, global.innerHeight - cardRect.height - 12));
        cardEl.style.left = left + 'px';
        cardEl.style.top = top + 'px';
        cardEl.style.right = '';
        cardEl.style.bottom = '';
    }

    function renderCard(step, index, total) {
        const isFirst = index === 0;
        const isLast = !!step.isFinish;
        const nextLabel = isLast ? 'Finish' : 'Next';
        cardEl.innerHTML =
            '<p class="guided-tour-progress">Step ' +
            (index + 1) +
            ' of ' +
            total +
            '</p>' +
            '<h3 class="guided-tour-title" id="guidedTourTitle">' +
            escapeHtml(step.title) +
            '</h3>' +
            '<p class="guided-tour-body" id="guidedTourBody">' +
            escapeHtml(step.body) +
            '</p>' +
            '<div class="guided-tour-actions">' +
            '<button type="button" class="guided-tour-btn guided-tour-btn--ghost" data-tour-action="skip">Skip tour</button>' +
            (isFirst
                ? ''
                : '<button type="button" class="guided-tour-btn guided-tour-btn--secondary" data-tour-action="back">Back</button>') +
            '<button type="button" class="guided-tour-btn guided-tour-btn--primary" data-tour-action="next">' +
            escapeHtml(nextLabel) +
            '</button>' +
            '</div>';
        cardEl.setAttribute('aria-labelledby', 'guidedTourTitle');
        cardEl.setAttribute('aria-describedby', 'guidedTourBody');

        cardEl.querySelector('[data-tour-action="skip"]').addEventListener('click', function () {
            skip();
        });
        const backBtn = cardEl.querySelector('[data-tour-action="back"]');
        if (backBtn) {
            backBtn.addEventListener('click', function () {
                goBack();
            });
        }
        cardEl.querySelector('[data-tour-action="next"]').addEventListener('click', function () {
            if (isLast) {
                finish(true);
            } else {
                goNext();
            }
        });
        const primary = cardEl.querySelector('[data-tour-action="next"]');
        if (primary) primary.focus();
    }

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function runStepHook(step, hookName) {
        if (!step || typeof step[hookName] !== 'function') return;
        try {
            step[hookName]();
        } catch (e) {
            console.warn('[guided-tour]', hookName, step.id, e);
        }
    }

    function showStep(index) {
        const steps = getSteps();
        if (!steps.length || index < 0 || index >= steps.length) return;
        const prev = steps[currentIndex];
        if (prev && index !== currentIndex) {
            runStepHook(prev, 'after');
        }
        currentIndex = index;
        const step = steps[currentIndex];
        runStepHook(step, 'before');

        clearHighlight();
        const targetEl = resolveElement(step);
        if (targetEl) {
            targetEl.classList.add('guided-tour-highlight-target');
            highlightedEl = targetEl;
        }

        requestAnimationFrame(function () {
            updateSpotlight(targetEl);
            renderCard(step, currentIndex, steps.length);
            requestAnimationFrame(function () {
                positionCard(step, targetEl);
            });
        });
    }

    function bindKeys() {
        unbindKeys();
        keyHandler = function (e) {
            if (!active) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                skip();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target && e.target.tagName) || '';
                if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                e.preventDefault();
                const steps = getSteps();
                const step = steps[currentIndex];
                if (step && step.isFinish) finish(true);
                else goNext();
            }
        };
        document.addEventListener('keydown', keyHandler, true);
    }

    function unbindKeys() {
        if (keyHandler) {
            document.removeEventListener('keydown', keyHandler, true);
            keyHandler = null;
        }
    }

    function onResize() {
        if (!active) return;
        const steps = getSteps();
        const step = steps[currentIndex];
        const targetEl = resolveElement(step);
        updateSpotlight(targetEl);
        positionCard(step, targetEl);
    }

    function teardown() {
        unbindKeys();
        global.removeEventListener('resize', onResize);
        clearHighlight();
        if (rootEl) {
            rootEl.classList.remove('guided-tour-root--active');
            rootEl.remove();
            rootEl = null;
            svgEl = null;
            holeEl = null;
            cardEl = null;
        }
        unlockMap();
        restoreUiSnapshot();
        uiSnapshot = null;
        active = false;
        document.body.style.overflow = '';
    }

    function start(opts) {
        opts = opts || {};
        if (!isGuidedTourEnabled()) return;
        const steps = getSteps();
        if (!steps.length) return;
        if (active) return;
        if (!opts.force && isTourDone()) return;

        active = true;
        uiSnapshot = captureUiSnapshot();
        currentIndex = typeof opts.fromStep === 'number' ? opts.fromStep : 0;
        ensureDom();
        rootEl.classList.add('guided-tour-root--active');
        document.body.style.overflow = 'hidden';
        lockMap();
        bindKeys();
        global.addEventListener('resize', onResize);
        showStep(currentIndex);
    }

    function skip() {
        if (!active) return;
        markTourDone();
        teardown();
    }

    function finish(openGuide) {
        if (!active) return;
        markTourDone();
        teardown();
        if (openGuide && typeof global.openAbout === 'function') {
            global.openAbout('getting-started');
        }
    }

    function goNext() {
        const steps = getSteps();
        if (currentIndex >= steps.length - 1) {
            finish(true);
            return;
        }
        showStep(currentIndex + 1);
    }

    function goBack() {
        if (currentIndex <= 0) return;
        showStep(currentIndex - 1);
    }

    function maybeStartGuidedTour() {
        if (!isGuidedTourEnabled()) return;
        if (!global.authModule || !global.authModule.isAuthenticated()) return;
        if (isTourDone()) return;
        const mapEl = document.getElementById('map');
        const controls = document.getElementById('mapTopLeftControls');
        if (!mapEl || !controls) return;
        global.setTimeout(function () {
            start({ force: false });
        }, 400);
    }

    global.guidedTour = {
        start: start,
        skip: skip,
        finish: finish,
        isDone: isTourDone,
        markDone: markTourDone,
        isEnabled: isGuidedTourEnabled,
    };
    global.maybeStartGuidedTour = maybeStartGuidedTour;
    global.refreshGuidedTourButton = initTakeTourButton;
    global.startGuidedTour = function () {
        if (!isGuidedTourEnabled()) return;
        if (typeof global.closeAbout === 'function') {
            global.closeAbout();
        }
        start({ force: true });
    };

    function initTakeTourButton() {
        const tourBtn = document.getElementById('userGuideTakeTourBtn');
        if (!tourBtn) return;
        if (!isGuidedTourEnabled()) {
            tourBtn.hidden = true;
            return;
        }
        tourBtn.hidden = false;
        if (tourBtn.dataset.tourInit === '1') return;
        tourBtn.dataset.tourInit = '1';
        tourBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            start({ force: true });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTakeTourButton);
    } else {
        initTakeTourButton();
    }
})(typeof window !== 'undefined' ? window : globalThis);
