// Delegated click/change handlers for Manage Data table HTML (no inline onclick/onchange).

function tableDataBtn(action, data, label, opts) {
    const o = opts || {};
    const classes = ['data-action-button'];
    if (o.delete) classes.push('delete');
    if (o.className) classes.push(o.className);
    let attrs = `type="button" class="${classes.join(' ')}" data-action="${escapeHtmlAttr(action)}"`;
    if (data && data.id != null) attrs += ` data-id="${escapeHtmlAttr(String(data.id))}"`;
    if (data && data.view != null) attrs += ` data-view="${escapeHtmlAttr(String(data.view))}"`;
    if (data && data.groupId != null) attrs += ` data-group-id="${escapeHtmlAttr(String(data.groupId))}"`;
    if (data && data.batchId != null) attrs += ` data-batch-id="${escapeHtmlAttr(String(data.batchId))}"`;
    if (data && data.page != null) attrs += ` data-page="${escapeHtmlAttr(String(data.page))}"`;
    if (data && data.confirm != null) attrs += ` data-confirm="${escapeHtmlAttr(String(data.confirm))}"`;
    if (o.title) attrs += ` title="${escapeHtmlAttr(o.title)}"`;
    if (o.ariaLabel) attrs += ` aria-label="${escapeHtmlAttr(o.ariaLabel)}"`;
    if (o.style) attrs += ` style="${escapeHtmlAttr(o.style)}"`;
    if (o.disabled) attrs += ' disabled';
    return `<button ${attrs}>${label}</button>`;
}

function tableDataCheckbox(action, data, checked) {
    let attrs = `data-action="${escapeHtmlAttr(action)}"`;
    if (data && data.id != null) attrs += ` data-id="${escapeHtmlAttr(String(data.id))}"`;
    if (data && data.view != null) attrs += ` data-view="${escapeHtmlAttr(String(data.view))}"`;
    if (data && data.groupId != null) attrs += ` data-group-id="${escapeHtmlAttr(String(data.groupId))}"`;
    if (data && data.batchId != null) attrs += ` data-batch-id="${escapeHtmlAttr(String(data.batchId))}"`;
    if (data && data.fileId != null) attrs += ` data-file-id="${escapeHtmlAttr(String(data.fileId))}"`;
    if (data && data.layerId != null) attrs += ` data-layer-id="${escapeHtmlAttr(String(data.layerId))}"`;
    if (checked) attrs += ' checked';
    const build = window.appCheckboxHtml;
    if (typeof build === 'function') {
        return build(attrs, { wrapperClass: 'app-checkbox--table' });
    }
    return `<input type="checkbox" ${attrs}>`;
}

function tableGroupToggleHtml(view, groupId, collapsed) {
    const title = collapsed ? 'Expand' : 'Collapse';
    return `<span class="data-group-toggle" data-action="toggle-group-collapse" data-view="${escapeHtmlAttr(view)}" data-group-id="${escapeHtmlAttr(groupId)}" title="${escapeHtmlAttr(title)}" style="cursor: pointer; user-select: none;">${collapsed ? '▶' : '▼'}</span>`;
}

function tableDeleteBtn(action, data, label) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        return '';
    }
    return tableDataBtn(action, data, label || 'Delete', { delete: true, title: label || 'Delete' });
}

function tableGroupActionsHtml(view, groupId, deleteConfirm) {
    const data = { view, groupId };
    const deleteGroupBtn = tableDeleteBtn('delete-group', { ...data, confirm: deleteConfirm }, 'Delete group');
    return [
        tableDataBtn('rename-group', data, 'Rename', { title: 'Rename' }),
        tableDataBtn('ungroup-group', data, 'Ungroup', { title: 'Ungroup' }),
        deleteGroupBtn,
    ].join('\n                    ');
}

function tableEditableNameHtml(id, type, displayHtml, title) {
    const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : ' title="Click to rename"';
    return `<span class="editable-name" data-action="edit-name" data-id="${escapeHtmlAttr(id)}" data-type="${escapeHtmlAttr(type)}"${titleAttr} style="cursor: pointer;">${displayHtml}</span>`;
}

/** Quiet label next to a Data Hub item title when the item is publicly shared. */
function tablePublicIndicatorHtml(isPublic) {
    if (!isPublic) return '';
    return '<span class="data-public-indicator" title="Shared publicly">Public</span>';
}

/** Quiet label next to a Reported Event title when the DIRT form is still a draft. */
function tableDraftIndicatorHtml(isDraft) {
    if (!isDraft) return '';
    return '<span class="data-draft-indicator" title="Draft — reopen to finish">Draft</span>';
}

function tableViewPhotoTriggerHtml(id, imgAttrs, alt, opts) {
    const o = opts || {};
    const cls = [o.className, 'data-table-thumb-img'].filter(Boolean).join(' ');
    const style = o.style ? ` style="${escapeHtmlAttr(o.style)}"` : ' style="cursor: pointer;"';
    let attrs = `class="${cls}" ${imgAttrs} alt="${alt}" data-action="view-photo" data-id="${escapeHtmlAttr(id)}" role="button" tabindex="0"`;
    if (o.ariaLabel) attrs += ` aria-label="${escapeHtmlAttr(o.ariaLabel)}"`;
    return `<img ${attrs}${style}>`;
}

const PHOTO_LONG_PRESS_MS = 500;
const PHOTO_LONG_PRESS_MOVE_PX = 12;
let photoThumbPressState = null;
let suppressPhotoViewId = null;
let suppressPhotoViewUntil = 0;

function consumePhotoViewSuppress(photoId) {
    if (!photoId) return false;
    if (suppressPhotoViewId === String(photoId) && Date.now() < suppressPhotoViewUntil) {
        suppressPhotoViewId = null;
        suppressPhotoViewUntil = 0;
        return true;
    }
    return false;
}

function togglePhotoThumbSelection(photoId) {
    if (!photoId) return;
    callIfFn(window.toggleDataSelection, photoId);
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function isMobilePhotoSelectThumb(target) {
    return target && target.closest('.data-table-photo-select-thumb');
}

function isPhotoThumbSelectionMode() {
    const sel = window.dataSelectionModule && window.dataSelectionModule.selectedDataIds;
    return !!(sel && sel.size > 0);
}

function clearPhotoThumbPressState() {
    if (photoThumbPressState && photoThumbPressState.timer) {
        clearTimeout(photoThumbPressState.timer);
    }
    photoThumbPressState = null;
}

function handlePhotoThumbTouchStart(event) {
    const img = event.target.closest('.data-table-photo-select-thumb');
    if (!img) return;
    const inLegacyRow = img.closest('.data-table--photos-view tr[data-type="photo"]');
    const inGalleryCard = img.closest('.data-table--photos-view .photos-gallery-card');
    if (!inLegacyRow && !inGalleryCard) return;
    const id = img.getAttribute('data-id');
    if (!id) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    clearPhotoThumbPressState();
    photoThumbPressState = {
        id: String(id),
        startX: touch.clientX,
        startY: touch.clientY,
        fired: false,
        timer: setTimeout(function () {
            if (!photoThumbPressState || photoThumbPressState.id !== String(id)) return;
            photoThumbPressState.fired = true;
            togglePhotoThumbSelection(id);
            suppressPhotoViewId = String(id);
            suppressPhotoViewUntil = Date.now() + 800;
            if (navigator.vibrate) {
                try { navigator.vibrate(10); } catch (_) { /* ignore */ }
            }
        }, PHOTO_LONG_PRESS_MS),
    };
}

function handlePhotoThumbTouchMove(event) {
    if (!photoThumbPressState) return;
    const touch = event.touches && event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - photoThumbPressState.startX;
    const dy = touch.clientY - photoThumbPressState.startY;
    if (Math.hypot(dx, dy) > PHOTO_LONG_PRESS_MOVE_PX) {
        clearPhotoThumbPressState();
    }
}

function handlePhotoThumbTouchEnd(event) {
    if (!photoThumbPressState) return;
    const fired = photoThumbPressState.fired;
    clearPhotoThumbPressState();
    if (fired) {
        event.preventDefault();
    }
}

function handlePhotoThumbContextMenu(event) {
    if (event.target.closest('.data-table-photo-select-thumb')) {
        event.preventDefault();
    }
}

function callIfFn(fn, ...args) {
    if (typeof fn === 'function') fn(...args);
}

function handleDataTableClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id;
    const view = target.dataset.view;
    const groupId = target.dataset.groupId;
    const batchId = target.dataset.batchId;
    const page = target.dataset.page;
    const confirm = target.dataset.confirm;

    switch (action) {
        case 'edit-name':
            if (id && target.dataset.type) callIfFn(window.editDataItemName, id, target.dataset.type);
            break;
        case 'toggle-group-collapse':
            if (view && groupId) callIfFn(window.toggleDataGroupCollapsed, view, groupId);
            break;
        case 'rename-group':
            if (view && groupId) callIfFn(window.renameDataGroup, view, groupId);
            break;
        case 'ungroup-group':
            if (view && groupId) callIfFn(window.ungroupDataGroup, view, groupId);
            break;
        case 'delete-group':
            if (view && groupId) {
                callIfFn(window.confirmDeleteDataGroup, view, groupId, confirm || 'Delete this group?');
            }
            break;
        case 'view-document':
            if (id) callIfFn(window.viewDocument, id);
            break;
        case 'delete-document':
            if (id) callIfFn(window.deleteDocument, id);
            break;
        case 'set-document-location':
            if (id) callIfFn(window.startDocumentLocationDrawing, id);
            break;
        case 'remove-document-location':
            if (id) callIfFn(window.removeDocumentLocation, id);
            break;
        case 'view-event':
            if (id) callIfFn(window.viewEvent, id);
            break;
        case 'export-event':
            if (id && window.dirtReportModule && typeof window.dirtReportModule.exportDirtReportForEvent === 'function') {
                void window.dirtReportModule.exportDirtReportForEvent(id);
            } else if (id) {
                callIfFn(window.exportDirtReportForEvent, id);
            }
            break;
        case 'explain-missing-ticket':
            if (id && window.dirtReportModule && typeof window.dirtReportModule.explainMissingDirtReportTicketForEvent === 'function') {
                void window.dirtReportModule.explainMissingDirtReportTicketForEvent(id);
            }
            break;
        case 'delete-event':
            if (id) callIfFn(window.deleteEvent, id);
            break;
        case 'zoom-to-event':
            if (id) callIfFn(window.zoomToEvent, id);
            break;
        case 'remove-event-location':
            if (id) callIfFn(window.removeEventLocation, id);
            break;
        case 'set-event-location':
            if (id) callIfFn(window.startEventLocationDrawing, id);
            break;
        case 'view-layer':
            if (id) callIfFn(window.viewDataLayer, id);
            break;
        case 'load-layer':
            if (id) callIfFn(window.loadDataLayer, id);
            break;
        case 'delete-layer':
            if (id) callIfFn(window.deleteDataLayer, id);
            break;
        case 'view-annotation':
            if (id) callIfFn(window.viewDataItem, id);
            break;
        case 'delete-annotation':
            if (id) callIfFn(window.deleteDataItem, id);
            break;
        case 'restore-annotations':
            callIfFn(window.restoreAnnotations);
            break;
        case 'view-aerial-map':
            if (id) callIfFn(window.viewAerialMap, id);
            break;
        case 'fly-to-aerial-map':
            if (id) callIfFn(window.flyToAerialMapFavorite, id);
            break;
        case 'delete-aerial-map':
            if (id) callIfFn(window.deleteAerialMap, id);
            break;
        case 'view-photo':
            if (consumePhotoViewSuppress(id)) break;
            if (id && isMobilePhotoSelectThumb(target) && isPhotoThumbSelectionMode()) {
                togglePhotoThumbSelection(id);
                break;
            }
            if (id) callIfFn(window.viewPhoto, id, { fromManageDataPhotosGallery: true });
            break;
        case 'delete-photo':
            if (id) callIfFn(window.deletePhoto, id);
            break;
        case 'zoom-to-photo':
            if (id) callIfFn(window.zoomToPhoto, id);
            break;
        case 'tag-photo':
            if (id) callIfFn(window.tagPhotoLocation, id);
            break;
        case 'photo-location-menu':
            if (id) callIfFn(window.openPhotoLocationMenu, id, target);
            break;
        case 'associate-photo-ticket':
            if (id) callIfFn(window.associatePhotoFromManageData, id);
            break;
        case 'edit-photo-gps':
            if (id) callIfFn(window.editPhotoManualLocation, id);
            break;
        case 'data-hub-page':
            if (view && page != null) callIfFn(window.setDataHubPage, view, Number(page));
            break;
        case 'photos-page':
            if (page) callIfFn(window.setDataHubPage, 'photos', Number(page));
            break;
        case 'aerial-accessible-page':
            if (page != null && window.aerialMapsModule?.setAccessibleCatalogPage) {
                void window.aerialMapsModule.setAccessibleCatalogPage(Number(page));
            }
            break;
        case 'toggle-batch-collapse': {
            if (!batchId) break;
            if (event.target.closest('.data-table-no-batch-toggle, [data-stop-batch-toggle]')) break;
            if (event.target.closest('input[type="checkbox"]')) break;
            callIfFn(window.toggleBatchCollapse, batchId, event);
            break;
        }
        case 'rename-batch':
            if (batchId) callIfFn(window.renamePhotoBatch, batchId);
            break;
        case 'toggle-group-selection':
            if (view && groupId) callIfFn(window.toggleGroupSelection, view, groupId);
            break;
        case 'toggle-batch-selection':
            if (batchId) callIfFn(window.toggleBatchSelection, batchId);
            break;
        case 'manage-info':
            callIfFn(window.openManageDataRowInfoFromDataset, target);
            break;
        default:
            break;
    }
}

function handleDataTableChange(event) {
    const target = event.target;
    if (!target || !target.dataset || !target.dataset.action) return;
    const { action, id, view, groupId, batchId } = target.dataset;
    switch (action) {
        case 'toggle-selection':
            if (id) callIfFn(window.toggleDataSelection, id);
            break;
        case 'toggle-group-selection':
            if (view && groupId) callIfFn(window.toggleGroupSelection, view, groupId);
            break;
        case 'toggle-batch-selection':
            if (batchId) callIfFn(window.toggleBatchSelection, batchId);
            break;
        case 'update-layer-utility':
            if (id) callIfFn(window.updateDataLayerUtilityType, id, target.value);
            break;
        case 'toggle-photo-public':
            if (id) {
                callIfFn(
                    window.togglePhotoPublic,
                    id,
                    target.dataset.fileId,
                    target.checked,
                    target
                );
            }
            break;
        case 'toggle-layer-public':
            if (id) callIfFn(window.toggleLayerPublic, id, target.checked, target);
            break;
        default:
            break;
    }
}

function handleDataTableKeydown(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const action = target.dataset.action;
    if (action === 'view-photo' || action === 'edit-name' || action === 'rename-batch' || action === 'toggle-group-collapse' || action === 'toggle-group-selection' || action === 'toggle-batch-selection') {
        event.preventDefault();
        target.click();
    }
}

function initDataTableDelegation() {
    const root = document.getElementById('dataWindow');
    if (!root || root.dataset.tableDelegationBound === '1') return;
    root.dataset.tableDelegationBound = '1';
    root.addEventListener('click', handleDataTableClick);
    root.addEventListener('change', handleDataTableChange);
    root.addEventListener('keydown', handleDataTableKeydown);
    root.addEventListener('touchstart', handlePhotoThumbTouchStart, { passive: true });
    root.addEventListener('touchmove', handlePhotoThumbTouchMove, { passive: true });
    root.addEventListener('touchend', handlePhotoThumbTouchEnd);
    root.addEventListener('touchcancel', handlePhotoThumbTouchEnd);
    root.addEventListener('contextmenu', handlePhotoThumbContextMenu);
}

window.tableActionHtml = {
    btn: tableDataBtn,
    deleteBtn: tableDeleteBtn,
    checkbox: tableDataCheckbox,
    groupToggle: tableGroupToggleHtml,
    groupActions: tableGroupActionsHtml,
    editableName: tableEditableNameHtml,
    publicIndicator: tablePublicIndicatorHtml,
    draftIndicator: tableDraftIndicatorHtml,
    viewPhotoTrigger: tableViewPhotoTriggerHtml,
};
window.initDataTableDelegation = initDataTableDelegation;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDataTableDelegation);
} else {
    initDataTableDelegation();
}
