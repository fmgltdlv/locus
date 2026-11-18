// Annotation module - Main orchestrator for annotation functionality
// This module coordinates all annotation-related modules

function getCurrentUserDisplayNameForAnnotation() {
    if (!window.authModule || !window.authModule.isAuthenticated()) return '';
    const u = window.authModule.getCurrentUser();
    if (!u) return '';
    const name = (u.fullName && String(u.fullName).trim())
        || (u.username && String(u.username).trim())
        || (u.email && String(u.email).trim());
    return name || '';
}

function escapeHtmlForAnnotation(str) {
    if (str == null || str === '') return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

window.getCurrentUserDisplayNameForAnnotation = getCurrentUserDisplayNameForAnnotation;
window.escapeHtmlForAnnotation = escapeHtmlForAnnotation;

// Keep-annotating (multi-draw) session state
let multiDrawActive = false;
let multiDrawMode = null;
let multiDrawPresets = null;

function updateMultiDrawBanner() {
    const banner = document.getElementById('multiDrawBanner');
    if (!banner) return;
    banner.style.display = multiDrawActive ? 'flex' : 'none';
}

function startMultiDraw(mode, presets) {
    if (!mode) return;
    multiDrawActive = true;
    multiDrawMode = mode;
    multiDrawPresets = presets ? { ...presets } : null;

    updateMultiDrawBanner();

    const drawingModule = window.drawingModule;
    if (drawingModule?.startDrawingMode) {
        drawingModule.startDrawingMode(mode);
    }
}

function stopMultiDraw(options) {
    const opts = options || {};
    if (!opts.internal) {
        multiDrawActive = false;
        multiDrawMode = null;
        multiDrawPresets = null;
        updateMultiDrawBanner();
    }
    if (window.drawingModule?.cancelDrawingMode) {
        window.drawingModule.cancelDrawingMode({ skipStopMultiDraw: true });
    }
}

function buildMultiDrawPresetsFromForm(formValues) {
    return {
        utilityType: formValues.utilityType || '',
        icon: formValues.icon,
        color: formValues.color,
        linePattern: formValues.linePattern,
        documentRef: formValues.documentRef || '',
    };
}

function initMultiDrawBanner() {
    const stopBtn = document.getElementById('multiDrawStopBtn');
    if (stopBtn && !stopBtn.dataset.multiDrawBound) {
        stopBtn.dataset.multiDrawBound = '1';
        stopBtn.addEventListener('click', function () {
            stopMultiDraw();
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMultiDrawBanner);
} else {
    initMultiDrawBanner();
}

function resolveAnnotationStyleFromPresets(presets) {
    const ut = (presets && presets.utilityType) || '';
    const ft = window.featureTypeLibraryModule;
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const lib = ft && typeof ft.getAnnotationFeatureTypeLibraryForOrgId === 'function'
        ? ft.getAnnotationFeatureTypeLibraryForOrgId(orgId)
        : [];
    let color = (presets && presets.color) || 'var(--app-accent)';
    let linePattern = (ft && ft.DEFAULT_LINE_PATTERN) || 'solid';
    if (ft && typeof ft.resolveFeatureTypeStyle === 'function') {
        const r = ft.resolveFeatureTypeStyle(ut, lib);
        color = r.color || color;
        linePattern = r.linePattern || linePattern;
    } else if (window.utilityTypesModule && typeof window.utilityTypesModule.getColorFromUtilityType === 'function') {
        color = window.utilityTypesModule.getColorFromUtilityType(ut) || color;
    }
    const icon = (presets && presets.icon) != null
        ? presets.icon
        : null;
    return { color, linePattern, utilityType: ut, icon, documentRef: (presets && presets.documentRef) || '' };
}

function buildAnnotationRecord(geometry, mode, presets) {
    const style = resolveAnnotationStyleFromPresets(presets);
    const defaultIcon = (mode === 'line' || mode === 'polygon') ? 'none' : 'circle';
    const record = {
        id: 'annotation-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        type: mode,
        geometry: geometry,
        name: '',
        note: '',
        color: style.color,
        icon: style.icon != null ? style.icon : defaultIcon,
        utilityType: style.utilityType,
        documentRef: style.documentRef,
        originalName: '',
        createdAt: new Date().toISOString(),
    };
    if (mode === 'line' || mode === 'polygon') {
        record.linePattern = (presets && presets.linePattern) || style.linePattern || 'solid';
    }
    return record;
}

function pushAnnotationRecord(annotation) {
    const storageModule = window.annotationStorageModule;
    const rendererModule = window.annotationRendererModule;
    const layerModule = window.layerManagerModule;
    if (!storageModule || !rendererModule || !layerModule) {
        return false;
    }

    if (!annotation.organizationId && window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        annotation.organizationId = user.organizationId;
    }

    const authorName = getCurrentUserDisplayNameForAnnotation();
    if (authorName) {
        annotation.createdBy = authorName;
        annotation.lastEditedBy = authorName;
    }

    storageModule.annotations.push(annotation);
    storageModule.saveAnnotations();

    if (layerModule.annotationsLayerCleared) {
        layerModule.annotationsLayerCleared = false;
        layerModule.annotationsLayerGroup = null;
    }
    layerModule.initAnnotationsLayer();
    rendererModule.renderAnnotations();
    layerModule.updateLayerControlOverlays();

    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
    return true;
}

function autoSaveAndResumeMultiDraw(geometry, mode) {
    const drawingModule = window.drawingModule;
    if (!drawingModule) return;

    const record = buildAnnotationRecord(geometry, mode, multiDrawPresets);
    if (!pushAnnotationRecord(record)) {
        console.error('Could not auto-save annotation during keep-annotating mode');
        return;
    }

    drawingModule.cancelDrawingMode({ keepMultiDraw: true });
    drawingModule.startDrawingMode(multiDrawMode || mode);
}

function annotateAtUserLocation(lat, lon, mode) {
    const drawingModule = window.drawingModule;
    if (!drawingModule || lat == null || lon == null) return;
    if (window.offlineModule && window.offlineModule.guardOfflineAction &&
        window.offlineModule.guardOfflineAction('Annotating requires an internet connection.')) {
        return;
    }
    if (mode === 'point') {
        drawingModule.startDrawingMode('point');
        finishAnnotation({
            type: 'Point',
            coordinates: [lon, lat],
        });
        return;
    }
    if (mode === 'line' || mode === 'polygon') {
        drawingModule.startDrawingAtLatLng(mode, L.latLng(lat, lon));
    }
}

// Finish annotation — modal for first shape; auto-save while keep-annotating session is on
function finishAnnotation(geometry) {
    const drawingModule = window.drawingModule;
    if (!drawingModule) {
        console.error('Drawing module not available');
        return;
    }

    const currentDrawingMode = drawingModule.currentDrawingMode;
    if (!currentDrawingMode) {
        console.error('No active drawing mode');
        return;
    }

    if (!multiDrawActive) {
        multiDrawMode = currentDrawingMode;
    }

    if (multiDrawActive) {
        autoSaveAndResumeMultiDraw(geometry, currentDrawingMode);
        return;
    }

    const modalModule = window.annotationModalModule;
    if (!modalModule) {
        console.error('Annotation modal module not available');
        return;
    }

    modalModule.editingAnnotation = {
        id: 'annotation-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        type: currentDrawingMode,
        geometry: geometry,
        name: '',
        note: '',
        color: modalModule.selectedColor,
        createdAt: new Date().toISOString(),
    };

    drawingModule.cancelDrawingMode({ keepMultiDraw: false });
    modalModule.openAnnotationModal();
}

function persistEditingAnnotation() {
    const modalModule = window.annotationModalModule;
    const storageModule = window.annotationStorageModule;
    const rendererModule = window.annotationRendererModule;
    const layerModule = window.layerManagerModule;

    if (!modalModule || !storageModule || !rendererModule || !layerModule) {
        return false;
    }

    const editingAnnotation = modalModule.editingAnnotation;
    if (!editingAnnotation) return false;

    const formValues = modalModule.getAnnotationFormValues();
    editingAnnotation.name = formValues.name;
    editingAnnotation.note = formValues.note;
    editingAnnotation.color = formValues.color;
    editingAnnotation.icon = formValues.icon;
    editingAnnotation.utilityType = formValues.utilityType || '';
    editingAnnotation.documentRef = formValues.documentRef || '';
    const geom = editingAnnotation.type;
    if (geom === 'line' || geom === 'polygon') {
        editingAnnotation.linePattern = formValues.linePattern || 'solid';
    } else {
        delete editingAnnotation.linePattern;
    }
    if (!editingAnnotation.originalName) {
        editingAnnotation.originalName = editingAnnotation.name;
    }

    if (!editingAnnotation.organizationId && window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        editingAnnotation.organizationId = user.organizationId;
    }

    const authorName = getCurrentUserDisplayNameForAnnotation();
    const annotations = storageModule.annotations;
    const existingIndex = annotations.findIndex(a => a.id === editingAnnotation.id);
    if (existingIndex >= 0) {
        const previous = annotations[existingIndex];
        if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canEditAnnotation(previous)) {
            void appAlert('You do not have permission to edit this annotation.');
            return false;
        }
    }
    if (authorName) {
        if (existingIndex < 0) {
            editingAnnotation.createdBy = authorName;
            editingAnnotation.lastEditedBy = authorName;
        } else {
            const previous = annotations[existingIndex];
            if (previous.createdBy) {
                editingAnnotation.createdBy = previous.createdBy;
            }
            editingAnnotation.lastEditedBy = authorName;
        }
    }

    if (existingIndex >= 0) {
        annotations[existingIndex] = editingAnnotation;
    } else {
        annotations.push(editingAnnotation);
    }

    storageModule.saveAnnotations();

    if (layerModule.annotationsLayerCleared) {
        layerModule.annotationsLayerCleared = false;
        layerModule.annotationsLayerGroup = null;
    }
    layerModule.initAnnotationsLayer();
    rendererModule.renderAnnotations();
    layerModule.updateLayerControlOverlays();

    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }

    return { formValues, wasNew: existingIndex < 0 };
}

// Save annotation (internal name avoids collision with window.saveAnnotation onclick handler)
function saveAnnotationImpl(keepAnnotating) {
    const modalModule = window.annotationModalModule;
    if (!modalModule) {
        console.error('Annotation modal module not available');
        return;
    }

    const result = persistEditingAnnotation();
    if (!result) {
        console.error('Required modules not available');
        return;
    }

    const modeToResume = multiDrawMode || modalModule.editingAnnotation?.type;
    const presets = buildMultiDrawPresetsFromForm(result.formValues);

    modalModule.closeAnnotationModal();

    if (keepAnnotating && modeToResume) {
        startMultiDraw(modeToResume, presets);
    } else {
        stopMultiDraw();
    }
}

function saveAnnotationAndKeepAnnotating() {
    saveAnnotationImpl(true);
}

function closeAnnotationModalUser() {
    if (multiDrawActive) {
        stopMultiDraw();
    }
    if (window.annotationModalModule?.closeAnnotationModal) {
        window.annotationModalModule.closeAnnotationModal();
    }
}

// Edit annotation
function editAnnotation(id) {
    stopMultiDraw();

    const storageModule = window.annotationStorageModule;
    const modalModule = window.annotationModalModule;
    
    if (!storageModule || !modalModule) {
        console.error('Required modules not available');
        return;
    }
    
    const annotations = storageModule.annotations;
    const annotation = annotations.find(a => a.id === id);
    if (!annotation) return;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canEditAnnotation(annotation)) {
        void appAlert('You do not have permission to edit this annotation.');
        return;
    }
    
    modalModule.editingAnnotation = { ...annotation };
    // Default to 'none' for lines and polygons, 'circle' for points
    if (annotation.icon) {
        modalModule.selectedIcon = annotation.icon;
    } else {
        modalModule.selectedIcon = (annotation.type === 'line' || annotation.type === 'polygon') ? 'none' : 'circle';
    }
    modalModule.openAnnotationModal();
}

// Delete annotation from the add/edit modal (only for saved annotations)
async function deleteEditingAnnotation() {
    const modalModule = window.annotationModalModule;
    const storageModule = window.annotationStorageModule;
    if (!modalModule?.editingAnnotation || !storageModule) return;
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()) {
        void appAlert('You do not have permission to delete data in this organization.');
        return;
    }
    const id = modalModule.editingAnnotation.id;
    if (!storageModule.annotations.some(a => a.id === id)) return;
    if (await appConfirm('Are you sure you want to delete this annotation?')) {
        storageModule.deleteAnnotationInternal(id);
        closeAnnotationModalUser();
    }
}

// Save current annotations as a data layer
function snapshotAnnotationsForLayerSave(annotations) {
    return (Array.isArray(annotations) ? annotations : []).filter(Boolean).map((ann) => {
        const type = ann.type || 'point';
        const defaultIcon = type === 'line' || type === 'polygon' ? 'none' : 'circle';
        const out = {
            id: ann.id,
            type,
            geometry: ann.geometry
                ? typeof structuredClone === 'function'
                    ? structuredClone(ann.geometry)
                    : JSON.parse(JSON.stringify(ann.geometry))
                : ann.geometry,
            name: ann.name != null ? ann.name : '',
            note: ann.note != null ? ann.note : '',
            color: ann.color != null && String(ann.color).trim() !== '' ? ann.color : 'var(--app-accent)',
            icon: ann.icon != null && String(ann.icon).trim() !== '' ? ann.icon : defaultIcon,
            utilityType: ann.utilityType != null ? ann.utilityType : '',
            documentRef: ann.documentRef != null ? ann.documentRef : '',
            originalName: ann.originalName != null ? ann.originalName : undefined,
            createdAt: ann.createdAt,
            createdBy: ann.createdBy,
            lastEditedBy: ann.lastEditedBy,
            organizationId: ann.organizationId,
        };
        if (type === 'line' || type === 'polygon') {
            out.linePattern =
                ann.linePattern != null && String(ann.linePattern).trim() !== ''
                    ? ann.linePattern
                    : 'solid';
        }
        return out;
    });
}

async function saveAnnotationsAsDataLayer() {
    const storageModule = window.annotationStorageModule;
    const layerModule = window.layerManagerModule;
    const rendererModule = window.annotationRendererModule;
    const modalModule = window.annotationModalModule;
    
    if (!storageModule || !layerModule || !rendererModule) {
        console.error('Required modules not available');
        return;
    }

    if (modalModule && modalModule.editingAnnotation) {
        await appAlert('Finish or close the open annotation editor before saving as a data layer.');
        return;
    }
    
    const annotations = storageModule.annotations;
    if (annotations.length === 0) {
        await appAlert('No annotations to save!');
        return;
    }

    const defaultName = `Annotations - ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const layerName = await appPrompt('Enter a name for this data layer:', defaultName, { title: 'Save data layer' });

    if (layerName === null || layerName.trim() === '') {
        await appAlert('Save cancelled. Layer name cannot be empty.');
        return;
    }

    if (typeof storageModule.ensureSavedDataLayersLoaded === 'function') {
        await storageModule.ensureSavedDataLayersLoaded();
    }

    const savedDataLayers = storageModule.savedDataLayers;
    
    // Get organization ID
    let organizationId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        organizationId = user.organizationId;
    }
    
    const annSnapshot = snapshotAnnotationsForLayerSave(annotations);
    const derivedUtilityType = window.utilityTypesModule?.deriveDataLayerUtilityTypeFromAnnotations
        ? window.utilityTypesModule.deriveDataLayerUtilityTypeFromAnnotations(annSnapshot)
        : '';

    const authorName = getCurrentUserDisplayNameForAnnotation();

    const newLayer = {
        id: `data-layer-${Date.now()}`,
        name: layerName.trim(),
        originalName: layerName.trim(), // Store original name
        annotations: annSnapshot,
        utilityType: derivedUtilityType,
        createdAt: new Date().toISOString(),
        createdBy: authorName || undefined,
        isVisible: true, // Default to visible
        listInLayerPanel: true,
        organizationId: organizationId, // Add organization ID
        source: 'saved' // Distinct from file import ('uploaded'); layer control lists all map data layers
    };

    savedDataLayers.push(newLayer);

    // Clear current annotations and map layers (must happen before persisting, same as clearAnnotations)
    annotations.length = 0;
    const annotationLayers = rendererModule.annotationLayers;
    const map = window.map;
    annotationLayers.forEach(layer => {
        if (map && map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    });
    annotationLayers.length = 0;

    if (layerModule.annotationsLayerGroup) {
        if (map) map.removeLayer(layerModule.annotationsLayerGroup);
        layerModule.annotationsLayerGroup = null;
        layerModule.annotationsLayerName = null;
    }
    rendererModule.renderAnnotations();
    layerModule.updateLayerControlOverlays();

    // Persist new data layer and empty current annotations (localStorage + server)
    storageModule.saveDataLayers();
    storageModule.saveAnnotations();
    
    // Refresh data window if open
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }

    await appAlert(`Annotations saved as data layer: "${layerName}"`);
}

// Clear all annotations
function clearAnnotations() {
    const storageModule = window.annotationStorageModule;
    const rendererModule = window.annotationRendererModule;
    const layerModule = window.layerManagerModule;
    
    if (!storageModule || !rendererModule || !layerModule) {
        console.error('Required modules not available');
        return;
    }
    
    const annotations = storageModule.annotations;
    annotations.length = 0; // Clear array
    
    const annotationLayers = rendererModule.annotationLayers;
    annotationLayers.forEach(layer => {
        if (window.map && window.map.hasLayer(layer)) {
            window.map.removeLayer(layer);
        }
    });
    annotationLayers.length = 0; // Clear array
    
    if (layerModule.annotationsLayerGroup && window.map) {
        window.map.removeLayer(layerModule.annotationsLayerGroup);
        layerModule.annotationsLayerGroup = null;
        layerModule.annotationsLayerName = null;
    }
    storageModule.saveAnnotations();
    rendererModule.renderAnnotations();
    layerModule.updateLayerControlOverlays(); // Update to show/hide save button
}

// Set up callback for drawing module
if (window.drawingModule) {
    window.drawingModule.setFinishAnnotationCallback(finishAnnotation);
}

// Make functions globally available for HTML onclick handlers
window.toggleDrawingMode = window.drawingModule?.toggleDrawingMode || function() {};
window.finishCurrentDrawing = window.drawingModule?.finishCurrentDrawing || function() {};
window.closeAnnotationModal = closeAnnotationModalUser;
window.selectAnnotationColor = window.annotationModalModule?.selectAnnotationColor || function() {};
window.selectAnnotationIcon = window.annotationModalModule?.selectAnnotationIcon || function() {};
window.saveAnnotation = function () { saveAnnotationImpl(false); };
window.saveAnnotationAndKeepAnnotating = saveAnnotationAndKeepAnnotating;
window.deleteAnnotation = window.annotationStorageModule?.deleteAnnotation || function() {};
window.deleteEditingAnnotation = deleteEditingAnnotation;
window.editAnnotation = editAnnotation;
window.saveAnnotationsAsDataLayer = saveAnnotationsAsDataLayer;
window.clearAnnotations = clearAnnotations;
window.initDataUpload = window.fileImportModule?.initDataUpload || function() {};

// Export for use in other modules (backward compatibility)
window.annotationsModule = {
    get annotations() { return window.annotationStorageModule?.annotations || []; },
    set annotations(value) { if (window.annotationStorageModule) window.annotationStorageModule.annotations = value; },
    get annotationLayers() { return window.annotationRendererModule?.annotationLayers || []; },
    get annotationsLayerGroup() { return window.layerManagerModule?.annotationsLayerGroup || null; },
    get savedDataLayers() { return window.annotationStorageModule?.savedDataLayers || []; },
    loadAnnotations: () => window.annotationStorageModule?.loadAnnotations(),
    saveAnnotations: () => window.annotationStorageModule?.saveAnnotations(),
    saveDataLayers: () => window.annotationStorageModule?.saveDataLayers(),
    renderAnnotations: () => window.annotationRendererModule?.renderAnnotations(),
    initAnnotationsLayer: () => window.layerManagerModule?.initAnnotationsLayer(),
    updateLayerControlOverlays: () => window.layerManagerModule?.updateLayerControlOverlays(),
    clearAnnotations,
    renderDataLayer: (layer) => window.layerManagerModule?.renderDataLayer(layer),
    removeDataLayer: (id) => window.layerManagerModule?.removeDataLayer(id),
    addDataLayerToControl: (layer) => window.layerManagerModule?.addDataLayerToControl(layer),
    deleteAnnotationInternal: (id) => window.annotationStorageModule?.deleteAnnotationInternal(id),
    clearAllOverlayLayers: () => window.layerManagerModule?.clearAllOverlayLayers(),
    finishAnnotation,
    annotateAtUserLocation,
    stopMultiDraw,
    get multiDrawActive() { return multiDrawActive; },
    get multiDrawPresets() { return multiDrawPresets; }
};
