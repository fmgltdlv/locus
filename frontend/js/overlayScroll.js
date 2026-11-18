// Custom overlay scrollbar thumb with fade in/out (native ::-webkit-scrollbar transitions are unreliable).

(function () {
    'use strict';

    const IDLE_MS = 900;
    const LEAVE_MS = 350;
    const MIN_THUMB_PX = 28;
    const RAIL_HIT_PX = 24;
    const bound = new WeakMap();

    function getOverlayScrollAxis(el) {
        if (!el || !el.classList) return null;
        if (el.classList.contains('app-overlay-scroll-x')) return 'x';
        if (el.classList.contains('app-overlay-scroll')) return 'y';
        return null;
    }

    function thumbSelector(axis) {
        return ':scope > .app-overlay-scroll-thumb[data-overlay-scroll-axis="' + axis + '"]';
    }

    function cleanupOverlayScrollBindings(el) {
        if (!el) return;
        if (el._overlayScrollAbort) {
            el._overlayScrollAbort.abort();
            el._overlayScrollAbort = null;
        }
        if (el._overlayScrollResizeObserver) {
            el._overlayScrollResizeObserver.disconnect();
            el._overlayScrollResizeObserver = null;
        }
    }

    function attachOverlayScroll(el) {
        const axis = getOverlayScrollAxis(el);
        if (!el || !axis) return;
        if (bound.get(el) === axis) {
            syncOverlayScroll(el);
            return;
        }

        if (bound.has(el)) {
            detachOverlayScroll(el);
        }

        const host = el.parentElement;
        if (!host) return;
        const hostStyle = window.getComputedStyle(host);
        if (hostStyle.position === 'static') {
            host.style.position = 'relative';
        }

        const staleInContentThumb = el.querySelector(':scope > .app-overlay-scroll-thumb');
        if (staleInContentThumb) staleInContentThumb.remove();

        let thumb = host.querySelector(thumbSelector(axis));
        if (!thumb) {
            thumb = document.createElement('div');
            thumb.className =
                'app-overlay-scroll-thumb' +
                (axis === 'x' ? ' app-overlay-scroll-thumb--horizontal' : '');
            thumb.setAttribute('aria-hidden', 'true');
            thumb.setAttribute('data-overlay-scroll-axis', axis);
            host.appendChild(thumb);
        }

        const abort = new AbortController();
        const signal = abort.signal;
        el._overlayScrollAbort = abort;

        let idleTimer = null;
        let leaveTimer = null;
        let visible = false;
        let dragging = false;
        let dragPointerId = null;
        let dragOffset = 0;
        let pointerInRail = false;

        function setVisible(show) {
            if (show === visible) return;
            visible = show;
            thumb.classList.toggle('app-overlay-scroll-thumb--visible', show);
        }

        function clearTimers() {
            clearTimeout(idleTimer);
            clearTimeout(leaveTimer);
        }

        function scheduleHide(ms) {
            if (dragging || pointerInRail) return;
            clearTimeout(leaveTimer);
            leaveTimer = window.setTimeout(function () {
                if (!dragging && !pointerInRail) setVisible(false);
            }, ms);
        }

        function showThumb() {
            clearTimeout(leaveTimer);
            setVisible(true);
            if (dragging || pointerInRail) return;
            clearTimeout(idleTimer);
            idleTimer = window.setTimeout(function () {
                scheduleHide(0);
            }, IDLE_MS);
        }

        function syncThumbGeometry() {
            if (axis === 'x') {
                const scrollWidth = el.scrollWidth;
                const clientWidth = el.clientWidth;
                const maxScroll = scrollWidth - clientWidth;

                if (maxScroll <= 1) {
                    thumb.hidden = true;
                    setVisible(false);
                    return;
                }

                thumb.hidden = false;
                const thumbWidth = Math.max(MIN_THUMB_PX, (clientWidth / scrollWidth) * clientWidth);
                const travel = Math.max(0, clientWidth - thumbWidth);
                const left = maxScroll > 0 ? (el.scrollLeft / maxScroll) * travel : 0;
                thumb.style.width = thumbWidth + 'px';
                thumb.style.height = '';
                const elRect = el.getBoundingClientRect();
                const hostRect = host.getBoundingClientRect();
                const hostOffsetLeft = elRect.left - hostRect.left;
                const hostOffsetBottom = Math.max(0, hostRect.bottom - elRect.bottom);
                thumb.style.left = hostOffsetLeft + left + 'px';
                thumb.style.bottom = hostOffsetBottom + 1 + 'px';
                thumb.style.top = 'auto';
                thumb.style.right = 'auto';
                return;
            }

            const scrollHeight = el.scrollHeight;
            const clientHeight = el.clientHeight;
            const maxScroll = scrollHeight - clientHeight;

            if (maxScroll <= 1) {
                thumb.hidden = true;
                setVisible(false);
                return;
            }

            thumb.hidden = false;
            const thumbHeight = Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * clientHeight);
            const travel = Math.max(0, clientHeight - thumbHeight);
            const top = maxScroll > 0 ? (el.scrollTop / maxScroll) * travel : 0;
            thumb.style.height = thumbHeight + 'px';
            thumb.style.width = '';
            const elRect = el.getBoundingClientRect();
            const hostRect = host.getBoundingClientRect();
            const hostOffsetTop = elRect.top - hostRect.top;
            const hostOffsetRight = Math.max(0, hostRect.right - elRect.right);
            thumb.style.top = hostOffsetTop + top + 'px';
            thumb.style.right = hostOffsetRight + 1 + 'px';
            thumb.style.left = 'auto';
            thumb.style.bottom = 'auto';
        }

        function onScroll() {
            syncThumbGeometry();
            showThumb();
        }

        function dragToClientPos(clientX, clientY) {
            if (axis === 'x') {
                const scrollWidth = el.scrollWidth;
                const clientWidth = el.clientWidth;
                const maxScroll = scrollWidth - clientWidth;
                if (maxScroll <= 1) return;

                const thumbWidth = Math.max(MIN_THUMB_PX, (clientWidth / scrollWidth) * clientWidth);
                const travel = Math.max(1, clientWidth - thumbWidth);
                const elRect = el.getBoundingClientRect();
                const rawLeft = clientX - elRect.left - dragOffset;
                const left = Math.max(0, Math.min(travel, rawLeft));
                const ratio = left / travel;
                el.scrollLeft = ratio * maxScroll;
                return;
            }

            const scrollHeight = el.scrollHeight;
            const clientHeight = el.clientHeight;
            const maxScroll = scrollHeight - clientHeight;
            if (maxScroll <= 1) return;

            const thumbHeight = Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * clientHeight);
            const travel = Math.max(1, clientHeight - thumbHeight);
            const elRect = el.getBoundingClientRect();
            const rawTop = clientY - elRect.top - dragOffset;
            const top = Math.max(0, Math.min(travel, rawTop));
            const ratio = top / travel;
            el.scrollTop = ratio * maxScroll;
        }

        function pointerInScrollRail(e) {
            const rect = el.getBoundingClientRect();
            if (axis === 'x') {
                return e.clientY >= rect.bottom - RAIL_HIT_PX;
            }
            return e.clientX >= rect.right - RAIL_HIT_PX;
        }

        el.addEventListener('scroll', onScroll, { passive: true, signal: signal });
        el.addEventListener(
            'pointerenter',
            function () {
                clearTimeout(leaveTimer);
                syncThumbGeometry();
                showThumb();
            },
            { signal: signal }
        );
        el.addEventListener(
            'pointermove',
            function (e) {
                const inRail = pointerInScrollRail(e);
                if (inRail && !pointerInRail) {
                    pointerInRail = true;
                    clearTimeout(idleTimer);
                    clearTimeout(leaveTimer);
                    showThumb();
                    return;
                }
                if (!inRail && pointerInRail) {
                    pointerInRail = false;
                    scheduleHide(LEAVE_MS);
                }
            },
            { signal: signal }
        );
        el.addEventListener(
            'pointerleave',
            function () {
                if (dragging) return;
                pointerInRail = false;
                scheduleHide(LEAVE_MS);
            },
            { signal: signal }
        );
        thumb.addEventListener(
            'pointerdown',
            function (e) {
                if (thumb.hidden) return;
                dragging = true;
                dragPointerId = e.pointerId;
                const thumbRect = thumb.getBoundingClientRect();
                dragOffset = axis === 'x' ? e.clientX - thumbRect.left : e.clientY - thumbRect.top;
                thumb.setPointerCapture(dragPointerId);
                thumb.classList.add('app-overlay-scroll-thumb--dragging');
                clearTimers();
                setVisible(true);
                e.preventDefault();
            },
            { signal: signal }
        );
        thumb.addEventListener(
            'pointermove',
            function (e) {
                if (!dragging || e.pointerId !== dragPointerId) return;
                dragToClientPos(e.clientX, e.clientY);
                e.preventDefault();
            },
            { signal: signal }
        );
        function endDrag(e) {
            if (!dragging) return;
            if (e && e.pointerId != null && e.pointerId !== dragPointerId) return;
            if (dragPointerId != null && thumb.hasPointerCapture(dragPointerId)) {
                thumb.releasePointerCapture(dragPointerId);
            }
            dragging = false;
            dragPointerId = null;
            thumb.classList.remove('app-overlay-scroll-thumb--dragging');
            showThumb();
            scheduleHide(LEAVE_MS);
        }
        thumb.addEventListener('pointerup', endDrag, { signal: signal });
        thumb.addEventListener('pointercancel', endDrag, { signal: signal });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(function () {
                syncThumbGeometry();
            });
            ro.observe(el);
            ro.observe(host);
            Array.from(el.children).forEach(function (child) {
                ro.observe(child);
            });
            el._overlayScrollResizeObserver = ro;
        }

        bound.set(el, axis);
        syncThumbGeometry();

        el.overlayScrollSync = syncThumbGeometry;
    }

    function detachOverlayScroll(el) {
        if (!el) return;
        const axis = bound.get(el) || getOverlayScrollAxis(el);
        const host = el.parentElement;
        if (host && axis) {
            const thumb = host.querySelector(thumbSelector(axis));
            if (thumb) thumb.remove();
        }
        cleanupOverlayScrollBindings(el);
        if (bound.has(el)) bound.delete(el);
        el.overlayScrollSync = null;
    }

    function syncOverlayScroll(el) {
        if (el && typeof el.overlayScrollSync === 'function') {
            el.overlayScrollSync();
        }
    }

    /** Jump a list to its first row after a page change (keeps custom scrollbar in sync). */
    function scrollToTop(el) {
        if (!el) return;
        function apply() {
            el.scrollTop = 0;
            el.scrollLeft = 0;
            syncOverlayScroll(el);
        }
        apply();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(apply);
        }
    }

    function attachOverlayScrollAll(selector) {
        const sel = selector || '.app-overlay-scroll, .app-overlay-scroll-x';
        document.querySelectorAll(sel).forEach(attachOverlayScroll);
    }

    function ensureOverlayScroll(root) {
        if (!root) return;
        function apply(el) {
            if (!getOverlayScrollAxis(el)) return;
            attachOverlayScroll(el);
            syncOverlayScroll(el);
        }
        apply(root);
        if (typeof root.querySelectorAll === 'function') {
            root.querySelectorAll('.app-overlay-scroll, .app-overlay-scroll-x').forEach(apply);
        }
    }

    window.overlayScrollModule = {
        attachOverlayScroll: attachOverlayScroll,
        attachOverlayScrollAll: attachOverlayScrollAll,
        syncOverlayScroll: syncOverlayScroll,
        scrollToTop: scrollToTop,
        ensureOverlayScroll: ensureOverlayScroll,
        detachOverlayScroll: detachOverlayScroll,
    };
})();
