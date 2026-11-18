// Photo stake overlay: faded reference image on in-page camera for "Match this shot".
(function () {
    var DEFAULT_OPACITY = 0.4;
    var activeContext = null;
    var ghostDataUrl = null;

    function tr(msg, vars) {
        return typeof window.t === 'function' ? window.t(msg, vars) : msg;
    }

    function getEl(id) {
        return document.getElementById(id);
    }

    function isActive() {
        return !!(activeContext && activeContext.referencePhotoId != null);
    }

    function getActiveStakeContext() {
        return activeContext;
    }

    function getStakeOpacity() {
        const slider = getEl('inPageCameraStakeOpacity');
        if (!slider) return DEFAULT_OPACITY;
        const raw = Number(slider.value);
        if (!Number.isFinite(raw)) return DEFAULT_OPACITY;
        return Math.max(0.15, Math.min(0.85, raw / 100));
    }

    function applyOpacity(opacity) {
        const ghost = getEl('inPageCameraStakeGhost');
        if (ghost) ghost.style.opacity = String(opacity);
    }

    function setCameraStakeModeActive(active) {
        const overlay = getEl('inPageCameraOverlay');
        if (!overlay) return;
        if (active) {
            overlay.setAttribute('data-stake-mode', 'true');
        } else {
            overlay.removeAttribute('data-stake-mode');
        }
    }

    function setStakeUiVisible(visible) {
        const layer = getEl('inPageCameraStakeLayer');
        const wrap = getEl('inPageCameraStakeOpacityWrap');
        const label = getEl('inPageCameraStakeLabel');
        if (layer) {
            layer.hidden = !visible;
            layer.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        if (wrap) {
            wrap.hidden = !visible;
            wrap.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        if (label) {
            label.hidden = !visible;
            label.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
    }

    function onFacingModeChanged(facingMode) {
        if (!isActive()) return;
        const layer = getEl('inPageCameraStakeLayer');
        const wrap = getEl('inPageCameraStakeOpacityWrap');
        const label = getEl('inPageCameraStakeLabel');
        const isEnvironment = facingMode === 'environment';
        if (layer) layer.hidden = !isEnvironment;
        if (wrap) wrap.hidden = !isEnvironment;
        if (label) label.hidden = false;
        if (!isEnvironment && label) {
            label.textContent = tr('Switch to the rear camera to match this shot');
        } else if (isEnvironment && activeContext && label) {
            const name = activeContext.referenceFileName || tr('reference photo');
            label.textContent = tr('Matching: {name}', { name: name });
        }
    }

    function bindOpacitySlider() {
        const slider = getEl('inPageCameraStakeOpacity');
        if (!slider || slider.dataset.stakeBound === '1') return;
        slider.dataset.stakeBound = '1';
        slider.addEventListener('input', function () {
            applyOpacity(getStakeOpacity());
        });
    }

    function showPreparedContext(context) {
        activeContext = context;
        ghostDataUrl = context.ghostDataUrl || null;
        const ghost = getEl('inPageCameraStakeGhost');
        const slider = getEl('inPageCameraStakeOpacity');
        const label = getEl('inPageCameraStakeLabel');
        if (ghost) {
            ghost.src = ghostDataUrl || '';
            ghost.style.opacity = String(context.initialOpacity != null ? context.initialOpacity : DEFAULT_OPACITY);
        }
        if (slider) {
            slider.value = String(
                Math.round((context.initialOpacity != null ? context.initialOpacity : DEFAULT_OPACITY) * 100)
            );
        }
        if (label) {
            const name = context.referenceFileName || tr('reference photo');
            label.textContent = tr('Matching: {name}', { name: name });
        }
        bindOpacitySlider();
        setStakeUiVisible(true);
        setCameraStakeModeActive(true);
        onFacingModeChanged(
            typeof window.ipcGetFacingMode === 'function' ? window.ipcGetFacingMode() : 'environment'
        );
    }

    function teardownStakeOverlay() {
        activeContext = null;
        ghostDataUrl = null;
        const ghost = getEl('inPageCameraStakeGhost');
        if (ghost) {
            ghost.removeAttribute('src');
            ghost.style.opacity = '';
        }
        setStakeUiVisible(false);
        setCameraStakeModeActive(false);
        const label = getEl('inPageCameraStakeLabel');
        if (label) label.textContent = '';
    }

    async function fetchReferenceBlob(fileId) {
        const mod = window.photosModule;
        if (!mod || !Number.isFinite(Number(fileId))) return null;
        const id = Number(fileId);
        if (typeof mod.getPhotoFullBlobCached === 'function') {
            try {
                const full = await mod.getPhotoFullBlobCached(id);
                if (full) return full;
            } catch (_) {
                /* try thumbnail */
            }
        }
        if (typeof mod.getPhotoThumbnailBlobCached === 'function') {
            try {
                return await mod.getPhotoThumbnailBlobCached(id);
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    async function blobToOrientedDataUrl(blob) {
        const canvasUtils = window.photoCanvasUtils;
        if (!canvasUtils || typeof canvasUtils.decodeImageForCanvas !== 'function') {
            return URL.createObjectURL(blob);
        }
        const decoded = await canvasUtils.decodeImageForCanvas(blob);
        const drawable = decoded.drawable;
        const isBitmap = decoded.isBitmap;
        const dims =
            typeof canvasUtils.drawableWidthHeight === 'function'
                ? canvasUtils.drawableWidthHeight(drawable, isBitmap)
                : { w: drawable.width || drawable.naturalWidth, h: drawable.height || drawable.naturalHeight };
        const canvas = document.createElement('canvas');
        canvas.width = dims.w;
        canvas.height = dims.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas');
        ctx.drawImage(drawable, 0, 0, dims.w, dims.h);
        if (isBitmap && typeof drawable.close === 'function') {
            try {
                drawable.close();
            } catch (_) {
                /* ignore */
            }
        }
        return canvas.toDataURL('image/jpeg', 0.92);
    }

    async function prepareStakeOverlayForPhoto(photo) {
        if (!photo) return null;
        const fileId = photo.fileId != null ? Number(photo.fileId) : null;
        if (!Number.isFinite(fileId)) return null;
        const blob = await fetchReferenceBlob(fileId);
        if (!blob) return null;
        let orientedUrl = null;
        try {
            orientedUrl = await blobToOrientedDataUrl(blob);
        } catch (err) {
            console.warn('[photoStakeOverlay] orient ghost failed:', err);
            orientedUrl = URL.createObjectURL(blob);
        }
        const assocMod = window.photoTicketAssociationModule;
        let sourceAssociatedTicketId = null;
        if (assocMod && typeof assocMod.getPhotoAssociatedTicketId === 'function') {
            sourceAssociatedTicketId = assocMod.getPhotoAssociatedTicketId(photo);
        } else if (photo.associatedTicketId != null && Number.isFinite(Number(photo.associatedTicketId))) {
            sourceAssociatedTicketId = Number(photo.associatedTicketId);
        }
        return {
            referencePhotoId: fileId,
            referenceFileName: photo.fileName || photo.originalFileName || '',
            sourceAssociatedTicketId: sourceAssociatedTicketId,
            ghostDataUrl: orientedUrl,
            initialOpacity: DEFAULT_OPACITY,
        };
    }

    window.photoStakeOverlay = {
        isActive: isActive,
        getActiveStakeContext: getActiveStakeContext,
        getStakeOpacity: getStakeOpacity,
        prepareStakeOverlayForPhoto: prepareStakeOverlayForPhoto,
        showPreparedContext: showPreparedContext,
        teardownStakeOverlay: teardownStakeOverlay,
        onFacingModeChanged: onFacingModeChanged,
    };
})();
