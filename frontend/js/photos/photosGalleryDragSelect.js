/**
 * Desktop-only marquee drag-select for Manage Data Photos gallery.
 */
(function () {
    'use strict';

    const DRAG_THRESHOLD_PX = 6;
    let boundRoot = null;
    let state = null;
    let marqueeEl = null;
    let suppressNextPhotoClickUntil = 0;

    function isDesktop() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 769px)').matches;
    }

    function ensureMarquee() {
        if (marqueeEl && marqueeEl.isConnected) return marqueeEl;
        marqueeEl = document.createElement('div');
        marqueeEl.className = 'photos-gallery-marquee';
        marqueeEl.setAttribute('aria-hidden', 'true');
        // Inline critical visibility — Manage Data sits at z-index ~60k+.
        marqueeEl.style.cssText =
            'position:fixed;z-index:100100;pointer-events:none;box-sizing:border-box;' +
            'border:2px solid var(--app-accent,#2563eb);' +
            'background:rgba(37,99,235,0.18);display:none;left:0;top:0;width:0;height:0;';
        document.body.appendChild(marqueeEl);
        return marqueeEl;
    }

    function hideMarquee() {
        if (!marqueeEl) return;
        marqueeEl.style.display = 'none';
        marqueeEl.style.width = '0px';
        marqueeEl.style.height = '0px';
    }

    function showMarquee(left, top, width, height) {
        const box = ensureMarquee();
        box.style.display = 'block';
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = Math.max(1, width) + 'px';
        box.style.height = Math.max(1, height) + 'px';
    }

    function clearState() {
        state = null;
        hideMarquee();
        if (boundRoot) {
            boundRoot.querySelectorAll('.photos-gallery-card.is-marquee-hit').forEach((card) => {
                card.classList.remove('is-marquee-hit');
            });
        }
    }

    function rectsIntersect(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    function selectionHasId(sel, id) {
        return sel.has(id) || sel.has(String(id));
    }

    function applySelectionUi(root) {
        const sel = window.dataSelectionModule?.selectedDataIds;
        if (!sel || !root) return;
        root.querySelectorAll('.photos-gallery-card[data-id]').forEach((card) => {
            const id = card.getAttribute('data-id');
            const on = selectionHasId(sel, id);
            card.classList.toggle('is-selected', on);
            const cb = card.querySelector('input[type="checkbox"][data-action="toggle-selection"]');
            if (cb) {
                cb.checked = on;
                cb.indeterminate = false;
            }
        });
        if (window.dataSelectionModule?.syncSelectAllDataCheckbox) {
            window.dataSelectionModule.syncSelectAllDataCheckbox();
        }
        if (window.dataSelectionModule?.updateBulkActionsVisibility) {
            window.dataSelectionModule.updateBulkActionsVisibility();
        }
    }

    function highlightMarqueeHits(root, marqueeRect) {
        root.querySelectorAll('.photos-gallery-card[data-id]').forEach((card) => {
            const r = card.getBoundingClientRect();
            card.classList.toggle('is-marquee-hit', rectsIntersect(marqueeRect, r));
        });
    }

    function onPointerDown(e) {
        if (!isDesktop() || e.button !== 0) return;
        if (
            e.target.closest(
                'button, a, input, label, .photos-gallery-card__select, .photos-gallery-card__actions, .photos-gallery-card__img, [data-action="view-photo"]'
            )
        ) {
            return;
        }
        const root = boundRoot;
        if (!root || !root.contains(e.target)) return;

        state = {
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            pointerId: e.pointerId,
        };
        try {
            root.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    }

    function onPointerMove(e) {
        if (!state || state.pointerId !== e.pointerId) return;
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (!state.dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            state.dragging = true;
        }
        const left = Math.min(state.startX, e.clientX);
        const top = Math.min(state.startY, e.clientY);
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        showMarquee(left, top, width, height);
        if (boundRoot) {
            highlightMarqueeHits(boundRoot, {
                left,
                top,
                right: left + width,
                bottom: top + height,
            });
        }
    }

    function onPointerUp(e) {
        if (!state || state.pointerId !== e.pointerId) return;
        const root = boundRoot;
        const wasDragging = state.dragging;
        const marqueeRect = wasDragging
            ? {
                  left: Math.min(state.startX, e.clientX),
                  top: Math.min(state.startY, e.clientY),
                  right: Math.max(state.startX, e.clientX),
                  bottom: Math.max(state.startY, e.clientY),
              }
            : null;
        clearState();
        try {
            if (root) root.releasePointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        if (!wasDragging || !marqueeRect || !root) return;

        suppressNextPhotoClickUntil = Date.now() + 400;
        const sel = window.dataSelectionModule?.selectedDataIds;
        if (!sel) return;
        let changed = false;
        root.querySelectorAll('.photos-gallery-card[data-id]').forEach((card) => {
            const r = card.getBoundingClientRect();
            if (rectsIntersect(marqueeRect, r)) {
                const id = card.getAttribute('data-id');
                if (id && !selectionHasId(sel, id)) {
                    sel.add(String(id));
                    changed = true;
                }
            }
        });
        if (changed) {
            // Update cards/checkboxes in place — avoid full table re-render flicker.
            applySelectionUi(root);
        }
    }

    function onClickCapture(e) {
        if (Date.now() > suppressNextPhotoClickUntil) return;
        if (e.target.closest('[data-action="view-photo"], .photos-gallery-card__img')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function unbind() {
        if (!boundRoot) return;
        boundRoot.removeEventListener('pointerdown', onPointerDown);
        boundRoot.removeEventListener('pointermove', onPointerMove);
        boundRoot.removeEventListener('pointerup', onPointerUp);
        boundRoot.removeEventListener('pointercancel', onPointerUp);
        boundRoot.removeEventListener('click', onClickCapture, true);
        boundRoot = null;
        clearState();
    }

    function bind(root) {
        unbind();
        if (!root) return;
        boundRoot = root;
        ensureMarquee();
        boundRoot.addEventListener('pointerdown', onPointerDown);
        boundRoot.addEventListener('pointermove', onPointerMove);
        boundRoot.addEventListener('pointerup', onPointerUp);
        boundRoot.addEventListener('pointercancel', onPointerUp);
        boundRoot.addEventListener('click', onClickCapture, true);
    }

    window.photosGalleryDragSelectModule = {
        bind,
        unbind,
    };
})();
