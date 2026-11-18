/**
 * Photos Batches panel — optional list of saved/upload batches (30 per page).
 * Filtering the gallery by batch; save selection as a named batch.
 */
(function () {
    'use strict';

    const BATCHES_PAGE_SIZE = 30;
    let activeBatchId = null;
    let batchesListPage = 1;
    let panelOpen = false;

    function getActiveBatchId() {
        return activeBatchId;
    }

    function applyActiveBatchFilter(photos) {
        if (!activeBatchId) return photos || [];
        return (photos || []).filter((p) => String(p.batchId) === String(activeBatchId));
    }

    function getBatchLabel(batch) {
        if (window.photosModule?.getPhotoBatchDisplayPrimaryLabel) {
            return window.photosModule.getPhotoBatchDisplayPrimaryLabel(batch);
        }
        if (batch.name && String(batch.name).trim()) return String(batch.name).trim();
        if (window.formatRecordedDate) return window.formatRecordedDate(batch.createdAt, 'Batch', 'Batch');
        return 'Batch';
    }

    function countPhotosInBatch(batchId) {
        const photos = window.photosModule?.savedPhotos || [];
        return photos.filter((p) => String(p.batchId) === String(batchId)).length;
    }

    function listOrgBatches() {
        const batches = window.photosModule?.photoBatches || [];
        return batches
            .slice()
            .filter((batch) => {
                if (activeBatchId && String(activeBatchId) === String(batch.id)) return true;
                return countPhotosInBatch(batch.id) > 0;
            })
            .sort((a, b) => {
                const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                return bt - at;
            });
    }

    function ensurePanelEl() {
        let panel = document.getElementById('photosBatchesPanel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'photosBatchesPanel';
        panel.className = 'photos-batches-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Photo batches');
        document.body.appendChild(panel);
        panel.addEventListener('click', onPanelClick);
        return panel;
    }

    function closePanel() {
        panelOpen = false;
        const panel = document.getElementById('photosBatchesPanel');
        if (panel) panel.hidden = true;
    }

    function openPanel() {
        panelOpen = true;
        batchesListPage = 1;
        const panel = ensurePanelEl();
        renderPanel();
        panel.hidden = false;
        positionPanel();
    }

    function togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
    }

    function positionPanel() {
        const panel = document.getElementById('photosBatchesPanel');
        const btn = document.getElementById('photosBatchesButton');
        if (!panel || !btn) return;
        const rect = btn.getBoundingClientRect();
        panel.style.top = Math.min(window.innerHeight - 20, rect.bottom + 6) + 'px';
        panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
    }

    function renderPanel() {
        const panel = ensurePanelEl();
        const batches = listOrgBatches();
        const total = batches.length;
        const totalPages = Math.max(1, Math.ceil(total / BATCHES_PAGE_SIZE));
        if (batchesListPage > totalPages) batchesListPage = totalPages;
        const start = (batchesListPage - 1) * BATCHES_PAGE_SIZE;
        const pageBatches = batches.slice(start, start + BATCHES_PAGE_SIZE);
        const esc = typeof escapeHtmlText === 'function' ? escapeHtmlText : (s) => String(s);
        const escA = typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr : (s) => String(s);

        let listHtml;
        if (total === 0) {
            listHtml = '<p class="photos-batches-panel__empty">No saved batches yet. Select photos and use Save as batch.</p>';
        } else {
            listHtml = pageBatches
                .map((batch) => {
                    const count = countPhotosInBatch(batch.id);
                    const label = esc(getBatchLabel(batch));
                    const idAttr = escA(batch.id);
                    const active = activeBatchId && String(activeBatchId) === String(batch.id);
                    return `<div class="photos-batches-panel__row${active ? ' is-active' : ''}" data-batch-id="${idAttr}">
                        <button type="button" class="photos-batches-panel__select" data-action="photos-batch-select" data-batch-id="${idAttr}">
                            <span class="photos-batches-panel__name">${label}</span>
                            <span class="photos-batches-panel__count">${count} photo${count !== 1 ? 's' : ''}</span>
                        </button>
                        <button type="button" class="photos-batches-panel__icon-btn" data-action="photos-batch-rename" data-batch-id="${idAttr}" title="Rename">Rename</button>
                        <button type="button" class="photos-batches-panel__icon-btn" data-action="photos-batch-remove" data-batch-id="${idAttr}" title="Remove batch (keeps photos)">Remove</button>
                    </div>`;
                })
                .join('');
        }

        const pager =
            total > BATCHES_PAGE_SIZE
                ? `<div class="photos-batches-panel__pager">
                    <button type="button" data-action="photos-batches-page" data-page="${batchesListPage - 1}" ${batchesListPage <= 1 ? 'disabled' : ''}>Previous</button>
                    <span>Page ${batchesListPage} of ${totalPages}</span>
                    <button type="button" data-action="photos-batches-page" data-page="${batchesListPage + 1}" ${batchesListPage >= totalPages ? 'disabled' : ''}>Next</button>
                   </div>`
                : '';

        panel.innerHTML = `
            <div class="photos-batches-panel__header">
                <strong>Batches</strong>
                <button type="button" class="photos-batches-panel__close" data-action="photos-batches-close" aria-label="Close">×</button>
            </div>
            <div class="photos-batches-panel__list">${listHtml}</div>
            ${pager}
        `;
    }

    function setActiveBatch(batchId) {
        activeBatchId = batchId ? String(batchId) : null;
        if (window.dataHubPaginationModule?.resetDataHubPage) {
            window.dataHubPaginationModule.resetDataHubPage('photos');
        }
        if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
        if (window.dataTableRendererModule?.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
        if (panelOpen) renderPanel();
    }

    function clearActiveBatch() {
        setActiveBatch(null);
    }

    async function removeBatch(batchId) {
        const batches = window.photosModule?.photoBatches;
        if (!batches) return;
        const idx = batches.findIndex((b) => String(b.id) === String(batchId));
        if (idx < 0) return;
        const ok = await appConfirm('Remove this batch from the list? Photos will not be deleted.', {
            title: 'Remove batch',
        });
        if (!ok) return;
        const photos = window.photosModule?.savedPhotos || [];
        photos.forEach((p) => {
            if (String(p.batchId) === String(batchId)) {
                p.batchId = null;
                p.batchName = null;
            }
        });
        batches.splice(idx, 1);
        if (window.photosModule?.savePhotoBatches) window.photosModule.savePhotoBatches();
        if (window.photosModule?.savePhotos) window.photosModule.savePhotos();
        if (activeBatchId && String(activeBatchId) === String(batchId)) {
            activeBatchId = null;
            if (window.syncDataFilterContextBanner) window.syncDataFilterContextBanner();
        }
        renderPanel();
        if (window.dataTableRendererModule?.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    }

    async function onPanelClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const batchId = btn.getAttribute('data-batch-id');
        if (action === 'photos-batches-close') {
            closePanel();
            return;
        }
        if (action === 'photos-batches-page') {
            const page = Number(btn.getAttribute('data-page'));
            if (Number.isFinite(page) && page >= 1) {
                batchesListPage = page;
                renderPanel();
            }
            return;
        }
        if (action === 'photos-batch-select' && batchId) {
            setActiveBatch(batchId);
            closePanel();
            return;
        }
        if (action === 'photos-batch-rename' && batchId) {
            if (typeof window.renamePhotoBatch === 'function') {
                await window.renamePhotoBatch(batchId);
                renderPanel();
            }
            return;
        }
        if (action === 'photos-batch-remove' && batchId) {
            await removeBatch(batchId);
        }
    }

    async function saveSelectionAsBatch() {
        const ids = window.dataSelectionModule?.selectedDataIds;
        if (!ids || ids.size < 1) {
            await appAlert('Select at least one photo to save as a batch.');
            return;
        }
        const name = await appPrompt('Batch name:', '', { title: 'Save as batch' });
        if (name === null) return;
        const trimmed = String(name).trim();
        if (!trimmed) {
            await appAlert('Enter a batch name.');
            return;
        }
        const photos = window.photosModule?.savedPhotos || [];
        const orgId =
            typeof window.getCurrentOrgId === 'function'
                ? window.getCurrentOrgId()
                : window.authModule?.getCurrentUser?.()?.organizationId;
        const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        const photoIds = [];
        ids.forEach((id) => {
            const photo = photos.find((p) => String(p.id) === String(id));
            if (!photo) return;
            photo.batchId = batchId;
            photo.batchName = trimmed;
            photoIds.push(photo.id);
        });
        if (!window.photosModule.photoBatches) {
            /* photoBatches is module-owned via getter — push through photosModule if available */
        }
        const batches = window.photosModule?.photoBatches;
        if (Array.isArray(batches)) {
            batches.push({
                id: batchId,
                name: trimmed,
                photoIds,
                createdAt: new Date().toISOString(),
                organizationId: orgId,
            });
        }
        if (window.photosModule?.savePhotoBatches) window.photosModule.savePhotoBatches();
        if (window.photosModule?.savePhotos) window.photosModule.savePhotos();

        // Batch membership is local; batchName on each media file is optional server metadata.
        // Sync in parallel in the background so Save as batch does not wait on N sequential PATCHes.
        const withFile = photos.filter((p) => String(p.batchId) === String(batchId) && p.fileId);
        const patchFn = window.photosModule?.patchPhotoBatchNameOnServer;
        if (typeof patchFn === 'function' && withFile.length) {
            void Promise.allSettled(
                withFile.map((p) =>
                    patchFn(p.fileId, trimmed).catch((err) => {
                        console.error('Could not sync batch name to server:', err);
                    })
                )
            );
        }

        if (window.dataSelectionModule?.clearSelection) {
            window.dataSelectionModule.clearSelection();
        }
        setActiveBatch(batchId);
        await appAlert(`Saved ${photoIds.length} photo${photoIds.length !== 1 ? 's' : ''} as “${trimmed}”.`);
    }

    function syncBatchesButtonVisibility(view) {
        const btn = document.getElementById('photosBatchesButton');
        if (btn) btn.style.display = view === 'photos' ? '' : 'none';
        if (view !== 'photos') closePanel();
    }

    function getBatchBannerMessage() {
        if (!activeBatchId) return '';
        const batches = window.photosModule?.photoBatches || [];
        const batch = batches.find((b) => String(b.id) === String(activeBatchId));
        const label = batch ? getBatchLabel(batch) : 'Batch';
        return `Batch: ${label}.`;
    }

    document.addEventListener('click', (e) => {
        if (!panelOpen) return;
        const panel = document.getElementById('photosBatchesPanel');
        const btn = document.getElementById('photosBatchesButton');
        if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
            closePanel();
        }
    });

    // Prefer wiring the button ourselves so the opening click cannot race-close the panel,
    // and so missing inline handlers still work after CSP/minify.
    function bindBatchesButton() {
        const btn = document.getElementById('photosBatchesButton');
        if (!btn || btn.dataset.photosBatchesBound === '1') return;
        btn.dataset.photosBatchesBound = '1';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePanel();
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindBatchesButton);
    } else {
        bindBatchesButton();
    }

    window.photosBatchesPanelModule = {
        BATCHES_PAGE_SIZE,
        getActiveBatchId,
        applyActiveBatchFilter,
        setActiveBatch,
        clearActiveBatch,
        togglePanel,
        openPanel,
        closePanel,
        saveSelectionAsBatch,
        syncBatchesButtonVisibility,
        getBatchBannerMessage,
    };

    window.togglePhotosBatchesPanel = togglePanel;
    window.savePhotoSelectionAsBatch = saveSelectionAsBatch;
})();
