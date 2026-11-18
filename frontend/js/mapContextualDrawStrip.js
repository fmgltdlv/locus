/**
 * Desktop map strip while a draw session is active (create-ticket or hub search area).
 * Hidden on phone (existing finish/cancel chips stay). Not shown as an idle
 * launcher while the create-ticket wizard is open — draw from the wizard itself.
 */
(function () {
    const STRIP_ID = 'mapContextualDrawStrip';
    const DESKTOP_MQ = window.matchMedia ? window.matchMedia('(min-width: 769px)') : null;

    let stripEl = null;

    function isDesktop() {
        return !!(DESKTOP_MQ && DESKTOP_MQ.matches);
    }

    function ensureStrip() {
        if (stripEl && document.body.contains(stripEl)) return stripEl;
        stripEl = document.getElementById(STRIP_ID);
        if (stripEl) return stripEl;
        stripEl = document.createElement('div');
        stripEl.id = STRIP_ID;
        stripEl.className = 'map-contextual-draw-strip';
        stripEl.hidden = true;
        stripEl.setAttribute('role', 'toolbar');
        stripEl.setAttribute('aria-label', 'Map drawing tools');
        stripEl.innerHTML =
            '<span class="map-contextual-draw-strip-label" data-strip-label></span>' +
            '<button type="button" class="map-contextual-draw-strip-btn map-contextual-draw-strip-btn--primary" data-strip-action="finish">Finish</button>' +
            '<button type="button" class="map-contextual-draw-strip-btn map-contextual-draw-strip-btn--muted" data-strip-action="cancel">Cancel</button>';
        stripEl.addEventListener('click', onStripClick);
        const mapRoot = document.body;
        mapRoot.appendChild(stripEl);
        return stripEl;
    }

    function setStripLabel(el, text) {
        const label = el.querySelector('[data-strip-label]');
        if (!label) return;
        if (text) {
            label.hidden = false;
            label.textContent = text;
        } else {
            label.hidden = true;
            label.textContent = '';
        }
    }

    function wizardDrawing() {
        if (typeof window.getCreateTicketWizardMapContext === 'function') {
            const ctx = window.getCreateTicketWizardMapContext();
            return !!(ctx && ctx.active && ctx.drawing);
        }
        return false;
    }

    function hubSearchDrawing() {
        return (
            typeof window.isTicketHubSearchPolygonDrawingActive === 'function' &&
            window.isTicketHubSearchPolygonDrawingActive()
        );
    }

    function syncMapContextualDrawStrip() {
        const el = ensureStrip();
        if (!isDesktop()) {
            el.hidden = true;
            return;
        }

        if (hubSearchDrawing()) {
            el.hidden = false;
            setStripLabel(el, 'Drawing search area');
            return;
        }

        if (wizardDrawing()) {
            el.hidden = false;
            const hint =
                typeof window.getCreateTicketMapDrawStripLabel === 'function'
                    ? window.getCreateTicketMapDrawStripLabel()
                    : '';
            setStripLabel(el, hint || '');
            return;
        }

        el.hidden = true;
    }

    function onStripClick(e) {
        const btn = e.target.closest('[data-strip-action]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const action = btn.getAttribute('data-strip-action');
        if (hubSearchDrawing()) {
            if (action === 'finish' && typeof window.finishTicketHubSearchPolygonDrawingIfActive === 'function') {
                window.finishTicketHubSearchPolygonDrawingIfActive();
            } else if (action === 'cancel' && window.ticketHubModule && typeof window.ticketHubModule.cancelPolygonDrawingIfActive === 'function') {
                window.ticketHubModule.cancelPolygonDrawingIfActive();
            }
            syncMapContextualDrawStrip();
            return;
        }
        if (action === 'finish' && typeof window.finishCreateTicketMapDrawingIfActive === 'function') {
            window.finishCreateTicketMapDrawingIfActive();
        } else if (action === 'cancel' && typeof window.createTicketWizardCancelPolygonDrawingIfActive === 'function') {
            window.createTicketWizardCancelPolygonDrawingIfActive();
        }
        syncMapContextualDrawStrip();
    }

    if (DESKTOP_MQ) {
        if (typeof DESKTOP_MQ.addEventListener === 'function') {
            DESKTOP_MQ.addEventListener('change', syncMapContextualDrawStrip);
        } else if (typeof DESKTOP_MQ.addListener === 'function') {
            DESKTOP_MQ.addListener(syncMapContextualDrawStrip);
        }
    }

    window.syncMapContextualDrawStrip = syncMapContextualDrawStrip;
    window.mapContextualDrawStripModule = { sync: syncMapContextualDrawStrip };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncMapContextualDrawStrip);
    } else {
        syncMapContextualDrawStrip();
    }
})();
