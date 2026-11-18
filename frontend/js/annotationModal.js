// Annotation Modal module - Modal UI and form handling

// Modal state
let editingAnnotation = null;
let selectedColor = 'var(--app-accent)';
let selectedIcon = 'circle'; // Default icon type
let selectedUtilityType = '';
let selectedDocumentRef = '';

function getAnnotationIconPickerColor() {
    const utilityTypeSelect = document.getElementById('annotationUtilityType');
    const ut = utilityTypeSelect ? utilityTypeSelect.value : selectedUtilityType;
    const base = selectedColor || 'var(--app-accent)';
    const mod = window.utilityTypesModule;
    if (mod && typeof mod.getAnnotationIconColor === 'function') {
        return mod.getAnnotationIconColor(ut || '', base);
    }
    return base;
}

function refreshAnnotationIconPicker() {
    const iconPicker = document.getElementById('iconPicker');
    if (!iconPicker) return;
    const generateIconPickerHTML = window.iconsModule?.generateIconPickerHTML || function() { return ''; };
    iconPicker.innerHTML = generateIconPickerHTML(selectedIcon, getAnnotationIconPickerColor());
}

function escapeOptionLabel(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getFeatureLibraryForModal() {
    const ft = window.featureTypeLibraryModule;
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    if (ft && typeof ft.getAnnotationFeatureTypeLibraryForOrgId === 'function') {
        return ft.getAnnotationFeatureTypeLibraryForOrgId(orgId);
    }
    return [];
}

function applyStyleFromUtilityTypeKey(utilityTypeKey) {
    const ft = window.featureTypeLibraryModule;
    const lib = getFeatureLibraryForModal();
    if (ft && typeof ft.resolveFeatureTypeStyle === 'function') {
        const r = ft.resolveFeatureTypeStyle(utilityTypeKey || '', lib);
        selectedColor = r.color || 'var(--app-accent)';
    } else {
        applyColorFromUtilityTypeFallback(utilityTypeKey);
    }
}

function applyColorFromUtilityTypeFallback(utilityType) {
    const utilityTypesModule = window.utilityTypesModule;
    if (utilityTypesModule && typeof utilityTypesModule.getColorFromUtilityType === 'function') {
        selectedColor = utilityTypesModule.getColorFromUtilityType(utilityType || '');
    } else {
        selectedColor = 'var(--app-accent)';
    }
}

function buildUtilityTypeSelectHtml(selectedValue) {
    const ft = window.featureTypeLibraryModule;
    if (ft && typeof ft.buildUtilityTypeSelectOptionsHtml === 'function') {
        return ft.buildUtilityTypeSelectOptionsHtml(selectedValue, true);
    }
    const utilityTypesModule = window.utilityTypesModule;
    const options = utilityTypesModule?.UTILITY_TYPE_OPTIONS || ['Gas', 'Power', 'Comm', 'Sewer', 'Water', 'Survey', 'Other'];
    let html = '<option value="">Select utility type...</option>';
    html += '<optgroup label="Standard (APWA)">';
    html += options.map(type => {
        const sel = type === selectedValue ? ' selected' : '';
        return `<option value="${escapeOptionLabel(type)}"${sel}>${escapeOptionLabel(type)}</option>`;
    }).join('');
    html += '</optgroup>';
    return html;
}

// Open annotation modal
function openAnnotationModal() {
    const modal = document.getElementById('annotationModal');
    const nameInput = document.getElementById('annotationName');
    const noteInput = document.getElementById('annotationNote');

    if (!editingAnnotation) return;

    // Set current values
    nameInput.value = editingAnnotation.name || '';
    noteInput.value = editingAnnotation.note || '';
    selectedUtilityType = editingAnnotation.utilityType || '';
    selectedDocumentRef = editingAnnotation.documentRef || '';

    const utilityTypesModule = window.utilityTypesModule;
    const inStorage = !!(window.annotationStorageModule && window.annotationStorageModule.annotations &&
        window.annotationStorageModule.annotations.some(a => a.id === editingAnnotation.id));

    const presets = !inStorage && window.annotationsModule?.multiDrawPresets
        ? window.annotationsModule.multiDrawPresets
        : null;
    if (presets) {
        if (presets.utilityType !== undefined) {
            selectedUtilityType = presets.utilityType;
            editingAnnotation.utilityType = presets.utilityType;
        }
        if (presets.icon !== undefined) {
            selectedIcon = presets.icon;
            editingAnnotation.icon = presets.icon;
        }
        if (presets.color !== undefined) {
            selectedColor = presets.color;
            editingAnnotation.color = presets.color;
        }
        if (presets.documentRef !== undefined) {
            selectedDocumentRef = presets.documentRef;
            editingAnnotation.documentRef = presets.documentRef;
        }
        if (presets.linePattern !== undefined) {
            editingAnnotation.linePattern = presets.linePattern;
        }
    }

    // Legacy: saved annotation with color but no utility type — infer APWA type from color only (not org types)
    if (!selectedUtilityType && editingAnnotation.color && utilityTypesModule && inStorage) {
        selectedUtilityType = utilityTypesModule.getUtilityTypeFromColor(editingAnnotation.color);
    }

    applyStyleFromUtilityTypeKey(selectedUtilityType);

    // Default to 'none' for lines and polygons, 'circle' for points
    if (editingAnnotation.icon) {
        selectedIcon = editingAnnotation.icon;
    } else {
        selectedIcon = (editingAnnotation.type === 'line' || editingAnnotation.type === 'polygon') ? 'none' : 'circle';
    }

    // Build utility type selector
    const utilityTypeSelect = document.getElementById('annotationUtilityType');
    if (utilityTypeSelect) {
        utilityTypeSelect.innerHTML = buildUtilityTypeSelectHtml(selectedUtilityType);

        utilityTypeSelect.onchange = function() {
            selectedUtilityType = utilityTypeSelect.value;
            applyStyleFromUtilityTypeKey(selectedUtilityType);
            refreshAnnotationIconPicker();
        };
    }

    // Build document reference selector (point, line, and polygon annotations)
    const documentRefSection = document.getElementById('documentReferenceSection');
    const documentRefSelect = document.getElementById('annotationDocumentRef');
    if (documentRefSection && documentRefSelect) {
        const geomType = editingAnnotation.type;
        const showDocumentRef = geomType === 'point' || geomType === 'line' || geomType === 'polygon';
        documentRefSection.style.display = showDocumentRef ? 'block' : 'none';

        if (showDocumentRef) {
            const documents = window.documentsModule?.savedDocuments || [];
            documentRefSelect.innerHTML = '<option value="">No document</option>' +
                documents.map(doc => `<option value="${doc.id}" ${doc.id === selectedDocumentRef ? 'selected' : ''}>${doc.fileName}</option>`).join('');

            documentRefSelect.onchange = function() {
                selectedDocumentRef = documentRefSelect.value;
            };
        }
    }

    refreshAnnotationIconPicker();

    const attributionEl = document.getElementById('annotationAttribution');
    if (attributionEl) {
        const escapeHtml = typeof window.escapeHtmlForAnnotation === 'function' ? window.escapeHtmlForAnnotation : function (s) { return String(s || ''); };
        const displayName = typeof window.getCurrentUserDisplayNameForAnnotation === 'function' ? window.getCurrentUserDisplayNameForAnnotation() : '';
        const inStorage = !!(window.annotationStorageModule && window.annotationStorageModule.annotations &&
            window.annotationStorageModule.annotations.some(a => a.id === editingAnnotation.id));
        const createdBy = editingAnnotation.createdBy;
        const lastEditedBy = editingAnnotation.lastEditedBy;

        if (inStorage && (createdBy || lastEditedBy)) {
            const lines = [];
            if (createdBy) lines.push(`Created by ${escapeHtml(createdBy)}`);
            if (lastEditedBy) lines.push(`Last edited by ${escapeHtml(lastEditedBy)}`);
            attributionEl.innerHTML = lines.join('<br>');
            attributionEl.style.display = 'block';
        } else if (inStorage) {
            attributionEl.textContent = 'Creator details were not recorded for this annotation (created before this feature).';
            attributionEl.style.display = 'block';
        } else if (displayName) {
            attributionEl.textContent = 'When you save, created by and last edited by will be set to your account name.';
            attributionEl.style.display = 'block';
        } else if (window.authModule && window.authModule.isAuthenticated()) {
            attributionEl.textContent = 'Add a full name or username on your profile so annotations can show who created them.';
            attributionEl.style.display = 'block';
        } else if (!inStorage) {
            attributionEl.textContent = 'Sign in to record created by and last edited by on your annotations.';
            attributionEl.style.display = 'block';
        } else {
            attributionEl.innerHTML = '';
            attributionEl.style.display = 'none';
        }
    }

    const deleteBtn = document.getElementById('annotationDeleteBtn');
    if (deleteBtn) {
        deleteBtn.style.display = inStorage ? 'inline-block' : 'none';
    }

    const keepBtn = document.getElementById('annotationSaveKeepBtn');
    const saveBtn = document.getElementById('annotationSaveBtn');
    if (keepBtn) {
        keepBtn.style.display = !inStorage ? 'inline-block' : 'none';
    }
    if (saveBtn) {
        saveBtn.textContent = 'Save';
    }

    modal.style.display = 'flex';
}

// Close annotation modal
function closeAnnotationModal() {
    const modal = document.getElementById('annotationModal');
    modal.style.display = 'none';
    editingAnnotation = null;
}

// Select annotation icon
function selectAnnotationIcon(iconId) {
    selectedIcon = iconId;
    refreshAnnotationIconPicker();
}

// Legacy hook (no color picker UI); kept for compatibility
function selectAnnotationColor(color) {
    selectedColor = color;
    refreshAnnotationIconPicker();
}

// Get current form values
function getAnnotationFormValues() {
    const nameInput = document.getElementById('annotationName');
    const noteInput = document.getElementById('annotationNote');
    const utilityTypeSelect = document.getElementById('annotationUtilityType');
    const documentRefSelect = document.getElementById('annotationDocumentRef');
    const ut = utilityTypeSelect ? utilityTypeSelect.value : selectedUtilityType;
    const ft = window.featureTypeLibraryModule;
    const lib = getFeatureLibraryForModal();
    let color = selectedColor;
    let linePattern = (window.featureTypeLibraryModule && window.featureTypeLibraryModule.DEFAULT_LINE_PATTERN) || 'solid';
    if (ft && typeof ft.resolveFeatureTypeStyle === 'function') {
        const r = ft.resolveFeatureTypeStyle(ut || '', lib);
        color = r.color;
        linePattern = r.linePattern || linePattern;
    }
    return {
        name: nameInput.value.trim(),
        note: noteInput.value.trim(),
        color,
        linePattern,
        icon: selectedIcon,
        utilityType: ut,
        documentRef: documentRefSelect ? documentRefSelect.value : selectedDocumentRef
    };
}

// Export for use in other modules
window.annotationModalModule = {
    get editingAnnotation() { return editingAnnotation; },
    set editingAnnotation(value) { editingAnnotation = value; },
    get selectedColor() { return selectedColor; },
    set selectedColor(value) { selectedColor = value; },
    get selectedIcon() { return selectedIcon; },
    set selectedIcon(value) { selectedIcon = value; },
    openAnnotationModal,
    closeAnnotationModal,
    selectAnnotationIcon,
    selectAnnotationColor,
    getAnnotationFormValues,
    get selectedUtilityType() { return selectedUtilityType; },
    get selectedDocumentRef() { return selectedDocumentRef; }
};

// Make functions globally available for HTML onclick handlers (closeAnnotationModal overridden in annotations.js)
window.selectAnnotationColor = selectAnnotationColor;
window.selectAnnotationIcon = selectAnnotationIcon;
