// Layer Manager module - Layer group management and layer control panel

// Layer state
let annotationsLayerGroup = null; // Layer group for all annotations
let annotationsLayerName = null; // Name of the annotations layer
let annotationsLayerCleared = false; // Flag to track if annotations layer was cleared

/** Annotation overlays (current annotations + saved data layers) only render at zoom >= this. */
const ANNOTATION_MIN_ZOOM = 16;
let annotationZoomListenerAttached = false;
/** User wants the annotations layer on when zoom allows (layer control checkbox / default). */
let annotationsLayerUserWantsVisible = true;
/** While drawing a ticket in "hide" mode, keep annotation overlays off the map without changing saved visibility. */
let annotationOverlaysHiddenForTicketDraw = false;

// Store data layer groups (for uploaded data layers)
let dataLayerGroups = new Map(); // Map of layerId -> L.layerGroup

/**
 * Workspace entries that render as a separate overlay group (file import or Save as Data Layer).
 */
function isSavedMapDataLayer(layer) {
    if (!layer || layer.id == null) return false;
    if (!Array.isArray(layer.annotations)) return false;
    if (layer.source === 'uploaded') return true;
    if (layer.source === 'saved' || layer.source === 'annotations') return true;
    if (layer.source == null || layer.source === '') return true;
    return false;
}

function setAnnotationOverlaysHiddenForTicketDraw(hidden) {
    const next = !!hidden;
    if (annotationOverlaysHiddenForTicketDraw === next) return;
    annotationOverlaysHiddenForTicketDraw = next;
    syncAnnotationLayersForZoom();
}

function defaultAnnotationsLayerVisibleOnLoad() {
    if (typeof window.getUserProfile !== 'function') return true;
    const p = window.getUserProfile();
    return p.defaultLayerAnnotations !== false;
}

function ensureAnnotationZoomListener() {
    const map = window.map;
    if (!map || annotationZoomListenerAttached) return;
    annotationZoomListenerAttached = true;
    map.on('zoomend', syncAnnotationLayersForZoom);
}

function syncAnnotationLayersForZoom() {
    const map = window.map;
    if (!map) return;
    ensureAnnotationZoomListener();
    const zoomOk = map.getZoom() >= ANNOTATION_MIN_ZOOM;

    if (window.dataLayerPreviewModule?.refreshVisibleLayers) {
        const savedDataLayers = (window.annotationStorageModule?.savedDataLayers || []).filter(
            dataLayer => isSavedMapDataLayer(dataLayer) && dataLayer.listInLayerPanel !== false
        );
        window.dataLayerPreviewModule.refreshVisibleLayers(savedDataLayers);
    } else {
        if (annotationsLayerGroup) {
            const annotations = window.annotationStorageModule?.annotations || [];
            const mainEligible = annotations.length > 0 && !annotationsLayerCleared;
            if (mainEligible && zoomOk && annotationsLayerUserWantsVisible && !annotationOverlaysHiddenForTicketDraw) {
                map.addLayer(annotationsLayerGroup);
            } else if (map.hasLayer(annotationsLayerGroup)) {
                map.removeLayer(annotationsLayerGroup);
            }
        }
        const savedDataLayers = window.annotationStorageModule?.savedDataLayers || [];
        savedDataLayers.forEach(dataLayer => {
            if (!isSavedMapDataLayer(dataLayer) || dataLayer.listInLayerPanel === false) return;
            const layerGroup = dataLayerGroups && dataLayerGroups.get(dataLayer.id);
            if (!layerGroup) return;
            if (zoomOk && dataLayer.isVisible !== false && !annotationOverlaysHiddenForTicketDraw) {
                map.addLayer(layerGroup);
            } else if (map.hasLayer(layerGroup)) {
                map.removeLayer(layerGroup);
            }
        });
    }
}

// Initialize or get annotations layer group
function initAnnotationsLayer() {
    const map = window.map;
    if (!annotationsLayerGroup && map) {
        const today = new Date();
        const dateStr = today.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
        });
        annotationsLayerName = `${window.t ? window.t('Annotations') : 'Annotations'} - ${dateStr}`;
        annotationsLayerGroup = L.layerGroup();
        annotationsLayerUserWantsVisible = defaultAnnotationsLayerVisibleOnLoad();
        syncAnnotationLayersForZoom();
        updateLayerControlOverlays();
    }
    return annotationsLayerGroup;
}

// Update layer control to include annotations overlay
function updateLayerControlOverlays() {
    const map = window.map;
    if (!window.layerControlPanel || !map) return;
    
    // Get annotations and savedDataLayers from storage module
    const annotations = window.annotationStorageModule?.annotations || [];
    const savedDataLayers = window.annotationStorageModule?.savedDataLayers || [];
    
    // Check if annotations overlay already exists
    const existingOverlay = window.layerControlPanel.querySelector('.overlay-annotations');
    const existingSaveButton = window.layerControlPanel.querySelector('.save-data-layer-button');
    
    // Check if we have annotations to show and layer wasn't cleared
    const hasAnnotations = annotationsLayerGroup && annotations.length > 0 && !annotationsLayerCleared;
    
    if (hasAnnotations && !existingOverlay) {
        // Add divider if not exists
        let divider = window.layerControlPanel.querySelector('.layer-divider');
        if (!divider) {
            divider = L.DomUtil.create('div', 'layer-divider', window.layerControlPanel);
            divider.style.cssText = 'border-top: 1px solid #ddd; margin: 10px 0;';
        }
        
        // Add overlay section title if not exists
        let overlayTitleContainer = window.layerControlPanel.querySelector('.overlay-title-container');
        if (!overlayTitleContainer) {
            overlayTitleContainer = L.DomUtil.create('div', 'overlay-title-container', window.layerControlPanel);
            overlayTitleContainer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
            
            const overlayTitle = L.DomUtil.create('div', 'overlay-title', overlayTitleContainer);
            overlayTitle.textContent = window.t ? window.t('Overlays') : 'Overlays';
            overlayTitle.style.cssText = 'font-weight: 600; color: #000; font-size: 0.875rem;';
            
            // Add Clear Layers button
            const clearLayersButton = L.DomUtil.create('button', 'clear-layers-button', overlayTitleContainer);
            clearLayersButton.textContent = window.t ? window.t('Clear Layers') : 'Clear Layers';
            clearLayersButton.style.cssText = 'padding: 2px 8px; background: var(--app-danger); color: var(--app-text-inverse); border: none; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: 500;';
            clearLayersButton.title = window.t ? window.t('Clear all overlay layers') : 'Clear all overlay layers';
            
            L.DomEvent.on(clearLayersButton, 'click', function(e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                clearAllOverlayLayers();
            });
            
            L.DomEvent.disableClickPropagation(clearLayersButton);
        }
        
        // Add annotations layer checkbox
        const overlayOption = L.DomUtil.create('div', 'layer-option overlay-annotations', window.layerControlPanel);
        overlayOption.style.cssText = 'padding: 8px; border-radius: 4px; margin-bottom: 4px; color: #000; display: flex; align-items: center; gap: 8px;';
        
        const checkbox = L.DomUtil.create('input', '', overlayOption);
        checkbox.type = 'checkbox';
        checkbox.checked = annotationsLayerUserWantsVisible;
        checkbox.style.cssText = 'margin-right: 8px;';
        
        const label = L.DomUtil.create('label', '', overlayOption);
        label.textContent = annotationsLayerName;
        label.style.cssText = 'cursor: pointer; user-select: none; color: #000; flex-grow: 1;';
        checkbox.id = 'annotations-overlay';
        label.setAttribute('for', 'annotations-overlay');
        
        // Click handler for checkbox to toggle layer visibility
        L.DomEvent.on(checkbox, 'click', function(e) {
            L.DomEvent.stopPropagation(e);
            e.stopImmediatePropagation();
            annotationsLayerUserWantsVisible = checkbox.checked;
            syncAnnotationLayersForZoom();
        });
        
        L.DomEvent.disableClickPropagation(overlayOption);
        
        // Add "Save as Data Layer" button next to annotations layer
        if (!existingSaveButton) {
            const saveButton = L.DomUtil.create('button', 'save-data-layer-button', window.layerControlPanel);
            saveButton.textContent = window.t ? window.t('Save as Data Layer') : 'Save as Data Layer';
            saveButton.style.cssText = 'width: 100%; padding: 6px 8px; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; margin-top: 4px; margin-bottom: 4px;';
            saveButton.title = window.t ? window.t('Save current annotations as a data layer') : 'Save current annotations as a data layer';
            
            L.DomEvent.on(saveButton, 'click', function(e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                if (window.saveAnnotationsAsDataLayer) {
                    window.saveAnnotationsAsDataLayer();
                }
            });
            
            L.DomEvent.disableClickPropagation(saveButton);
        }
    } else if (!hasAnnotations) {
        // Remove annotations overlay and save button if no annotations
        if (existingOverlay) {
            existingOverlay.remove();
        }
        if (existingSaveButton) {
            existingSaveButton.remove();
        }
        
        // Remove divider and title container if no overlays remain
        const remainingOverlays = window.layerControlPanel.querySelectorAll('.layer-option');
        if (remainingOverlays.length === 0) {
            const divider = window.layerControlPanel.querySelector('.layer-divider');
            const overlayTitleContainer = window.layerControlPanel.querySelector('.overlay-title-container');
            if (divider) divider.remove();
            if (overlayTitleContainer) overlayTitleContainer.remove();
        }
    }
    
    // Remove existing data layer overlays (we'll re-add them)
    const existingDataLayerOverlays = window.layerControlPanel.querySelectorAll('.overlay-data-layer');
    existingDataLayerOverlays.forEach(overlay => overlay.remove());
    
    // List saved map data layers in the panel when listInLayerPanel is true (after explicit Load, or until Clear Layers sets false)
    savedDataLayers.forEach(layer => {
        if (isSavedMapDataLayer(layer) && layer.listInLayerPanel !== false) {
            addDataLayerToControl(layer);
        }
    });

    syncAnnotationLayersForZoom();
}

// Add a data layer to the layer control
function addDataLayerToControl(dataLayer) {
    const map = window.map;
    if (!window.layerControlPanel || !map || !dataLayer) return;
    
    // Check if already exists
    const existing = window.layerControlPanel.querySelector(`.overlay-data-layer[data-layer-id="${dataLayer.id}"]`);
    if (existing) return;
    
    // Ensure divider and title exist
    let divider = window.layerControlPanel.querySelector('.layer-divider');
    if (!divider) {
        divider = L.DomUtil.create('div', 'layer-divider', window.layerControlPanel);
        divider.style.cssText = 'border-top: 1px solid #ddd; margin: 10px 0;';
    }
    
    // Ensure overlay title container exists (with Clear Layers button)
    let overlayTitleContainer = window.layerControlPanel.querySelector('.overlay-title-container');
    if (!overlayTitleContainer) {
        overlayTitleContainer = L.DomUtil.create('div', 'overlay-title-container', window.layerControlPanel);
        overlayTitleContainer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
        
        const overlayTitle = L.DomUtil.create('div', 'overlay-title', overlayTitleContainer);
        overlayTitle.textContent = window.t ? window.t('Overlays') : 'Overlays';
        overlayTitle.style.cssText = 'font-weight: 600; color: #000; font-size: 0.875rem;';
        
        // Add Clear Layers button
        const clearLayersButton = L.DomUtil.create('button', 'clear-layers-button', overlayTitleContainer);
        clearLayersButton.textContent = window.t ? window.t('Clear Layers') : 'Clear Layers';
        clearLayersButton.style.cssText = 'padding: 2px 8px; background: var(--app-danger); color: var(--app-text-inverse); border: none; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: 500;';
        clearLayersButton.title = window.t ? window.t('Clear all overlay layers') : 'Clear all overlay layers';
        
        L.DomEvent.on(clearLayersButton, 'click', function(e) {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            clearAllOverlayLayers();
        });
        
        L.DomEvent.disableClickPropagation(clearLayersButton);
    }
    
    // Create overlay option for data layer
    const overlayOption = L.DomUtil.create('div', 'layer-option overlay-data-layer', window.layerControlPanel);
    overlayOption.setAttribute('data-layer-id', dataLayer.id);
    overlayOption.style.cssText = 'padding: 8px; border-radius: 4px; margin-bottom: 4px; color: #000; display: flex; align-items: center; gap: 8px;';
    
    const checkbox = L.DomUtil.create('input', '', overlayOption);
    checkbox.type = 'checkbox';
    checkbox.checked = dataLayer.isVisible !== false;
    checkbox.style.cssText = 'margin-right: 8px;';
    checkbox.id = `data-layer-${dataLayer.id}`;
    
    const label = L.DomUtil.create('label', '', overlayOption);
    label.textContent = dataLayer.name || (window.t ? window.t('Unnamed Layer') : 'Unnamed Layer');
    label.style.cssText = 'cursor: pointer; user-select: none; color: #000; flex-grow: 1;';
    // Don't use 'for' attribute - we'll handle clicks manually

    // Click handler for checkbox to toggle layer visibility
    L.DomEvent.on(checkbox, 'click', function(e) {
        L.DomEvent.stopPropagation(e);
        e.stopImmediatePropagation();
        
        // Ensure dataLayerGroups is initialized
        if (!dataLayerGroups) {
            dataLayerGroups = new Map();
        }
        
        dataLayer.isVisible = checkbox.checked;
        const layerGroup = dataLayerGroups.get(dataLayer.id);
        if (!layerGroup) {
            renderDataLayer(dataLayer);
        } else {
            syncAnnotationLayersForZoom();
        }
        if (window.annotationStorageModule && window.annotationStorageModule.saveDataLayers) {
            window.annotationStorageModule.saveDataLayers();
        }
    });
    
    // Click handler on overlayOption - zoom if not clicking checkbox
    L.DomEvent.on(overlayOption, 'click', function(e) {
        // If clicking the checkbox, let the checkbox handler deal with it
        if (e.target === checkbox || checkbox.contains(e.target)) {
            return;
        }
        
        // Otherwise, zoom to layer
        L.DomEvent.stopPropagation(e);
        e.preventDefault();
        zoomToDataLayer(dataLayer.id);
    });
    
    L.DomEvent.disableClickPropagation(overlayOption);
    
    // Render the layer if it should be visible
    if (dataLayer.isVisible !== false) {
        renderDataLayer(dataLayer);
    }
}

// Render a data layer on the map
function renderDataLayer(dataLayer) {
    const map = window.map;
    if (!map || !dataLayer || !dataLayer.annotations) return;

    if (window.dataLayerPreviewModule?.registerLayer) {
        window.dataLayerPreviewModule.registerLayer(dataLayer);
        return;
    }

    // Ensure dataLayerGroups is initialized
    if (!dataLayerGroups) {
        dataLayerGroups = new Map();
    }

    // Create or get layer group for this data layer
    let layerGroup = dataLayerGroups.get(dataLayer.id);
    if (!layerGroup) {
        layerGroup = L.layerGroup();
        dataLayerGroups.set(dataLayer.id, layerGroup);
    } else {
        // Clear existing layers
        layerGroup.clearLayers();
    }

    // Get createAnnotationPopup from renderer module
    const createAnnotationPopup = window.annotationRendererModule?.createAnnotationPopup || function() { return ''; };

    // Render each annotation in the data layer
    dataLayer.annotations.forEach(annotation => {
        if (annotation.type === 'point') {
            const point = annotation.geometry;
            const basePt = annotation.color || 'var(--app-accent)';
            const ptFill = window.utilityTypesModule?.getAnnotationIconColor
                ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, basePt)
                : basePt;
            const iconType = (annotation.icon && annotation.icon !== 'none') ? annotation.icon : 'circle';
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad, size: 16 };
            const iconsMod = window.iconsModule;
            const ptHtml = iconsMod?.getIconHTML
                ? iconsMod.getIconHTML(iconType, ptFill, iconOpts)
                : `<div style="background-color: ${ptFill}; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`;
            const ptLayout = iconsMod?.getMapIconLayout
                ? iconsMod.getMapIconLayout(iconOpts)
                : { size: 16, anchor: 8 };
            const marker = L.marker([point.coordinates[1], point.coordinates[0]], {
                icon: L.divIcon({
                    className: 'annotation-marker',
                    html: ptHtml,
                    iconSize: [ptLayout.size, ptLayout.size],
                    iconAnchor: [ptLayout.anchor, ptLayout.anchor],
                }),
            });
            marker.addTo(layerGroup);
            const popupContent = createAnnotationPopup(annotation, { readOnly: true });
            marker.bindPopup(popupContent);
        } else if (annotation.type === 'line') {
            const line = annotation.geometry;
            const col = annotation.color || 'var(--app-accent)';
            const lineBase = { color: col, weight: 3 };
            const lineOpts = window.featureTypeLibraryModule?.mergePolylineStyle
                ? window.featureTypeLibraryModule.mergePolylineStyle(lineBase, annotation)
                : lineBase;
            const polyline = L.polyline(
                line.coordinates.map(coord => [coord[1], coord[0]]),
                lineOpts
            );
            polyline.addTo(layerGroup);
            const popupContent = createAnnotationPopup(annotation, { readOnly: true });
            polyline.bindPopup(popupContent);
        } else if (annotation.type === 'polygon') {
            const polygon = annotation.geometry;
            const col = annotation.color || 'var(--app-accent)';
            const polyBase = {
                color: col,
                weight: 3,
                fillColor: col,
                fillOpacity: 0.2
            };
            const polyOpts = window.featureTypeLibraryModule?.mergePolygonStyle
                ? window.featureTypeLibraryModule.mergePolygonStyle(polyBase, annotation)
                : polyBase;
            const poly = L.polygon(
                polygon.coordinates[0].map(coord => [coord[1], coord[0]]),
                polyOpts
            );
            poly.addTo(layerGroup);
            const popupContent = createAnnotationPopup(annotation, { readOnly: true });
            poly.bindPopup(popupContent);
        }
    });
    
    syncAnnotationLayersForZoom();
}

// Remove a data layer from the map
function removeDataLayer(layerId) {
    if (!dataLayerGroups) {
        dataLayerGroups = new Map();
        return;
    }
    
    const layerGroup = dataLayerGroups.get(layerId);
    if (layerGroup && window.map) {
        window.map.removeLayer(layerGroup);
    }
    dataLayerGroups.delete(layerId);
    if (window.dataLayerPreviewModule?.unregisterLayer) {
        window.dataLayerPreviewModule.unregisterLayer(layerId);
    }
}

// Zoom to annotations layer
function zoomToAnnotationsLayer() {
    const map = window.map;
    if (!map) return;
    
    const annotations = window.annotationStorageModule?.annotations || [];
    
    if (!annotationsLayerGroup || annotations.length === 0) return;
    
    // Get bounds from the layer group (works without addTo; avoids showing annotations below min zoom)
    try {
        const bounds = annotationsLayerGroup.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50] });
            return;
        }
    } catch (error) {
        // Use fallback below
    }
    
    // Fallback: calculate bounds from annotations
    const allCoords = [];
    annotations.forEach(annotation => {
        if (annotation.geometry) {
            if (annotation.type === 'point' && annotation.geometry.coordinates) {
                const [lng, lat] = annotation.geometry.coordinates;
                allCoords.push([lat, lng]);
            } else if (annotation.type === 'line' && annotation.geometry.coordinates) {
                annotation.geometry.coordinates.forEach(coord => {
                    allCoords.push([coord[1], coord[0]]);
                });
            } else if (annotation.type === 'polygon' && annotation.geometry.coordinates && annotation.geometry.coordinates[0]) {
                annotation.geometry.coordinates[0].forEach(coord => {
                    allCoords.push([coord[1], coord[0]]);
                });
            }
        }
    });
    
    if (allCoords.length > 0) {
        const bounds = L.latLngBounds(allCoords);
        map.fitBounds(bounds, { padding: [50, 50] });
    }
}

// Zoom to data layer
function zoomToDataLayer(layerId) {
    const map = window.map;
    if (!map) return;
    
    if (!dataLayerGroups) {
        dataLayerGroups = new Map();
    }
    
    const savedDataLayers = window.annotationStorageModule?.savedDataLayers || [];
    const dataLayer = savedDataLayers.find(l => l.id === layerId);

    const previewBounds = dataLayer && window.dataLayerPreviewModule?.getLayerBounds
        ? window.dataLayerPreviewModule.getLayerBounds(dataLayer)
        : null;
    if (previewBounds && previewBounds.isValid && previewBounds.isValid()) {
        map.fitBounds(previewBounds, { padding: [50, 50] });
        return;
    }

    let layerGroup = dataLayerGroups.get(layerId);
    if (!layerGroup) {
        if (dataLayer) {
            renderDataLayer(dataLayer);
            setTimeout(() => {
                zoomToDataLayer(layerId);
            }, 100);
        }
        return;
    }

    try {
        const bounds = layerGroup.getBounds();
        if (bounds && bounds.isValid && bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50] });
            return;
        }
    } catch (error) {
        // Use fallback below
    }
    
    // Fallback: calculate bounds from data layer annotations
    if (dataLayer && dataLayer.annotations) {
        const allCoords = [];
        dataLayer.annotations.forEach(annotation => {
            if (annotation.geometry) {
                if (annotation.type === 'point' && annotation.geometry.coordinates) {
                    const [lng, lat] = annotation.geometry.coordinates;
                    allCoords.push([lat, lng]);
                } else if (annotation.type === 'line' && annotation.geometry.coordinates) {
                    annotation.geometry.coordinates.forEach(coord => {
                        allCoords.push([coord[1], coord[0]]);
                    });
                } else if (annotation.type === 'polygon' && annotation.geometry.coordinates && annotation.geometry.coordinates[0]) {
                    annotation.geometry.coordinates[0].forEach(coord => {
                        allCoords.push([coord[1], coord[0]]);
                    });
                }
            }
        });
        
        if (allCoords.length > 0) {
            const bounds = L.latLngBounds(allCoords);
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }
}

const PUBLIC_SEARCH_LAYER_PREFIX = 'public-search-';

function publicSearchLayerKey(layer) {
    const orgId = layer.organizationId != null ? layer.organizationId : layer.sharedFromOrganizationId;
    return `${PUBLIC_SEARCH_LAYER_PREFIX}${String(orgId)}-${String(layer.id)}`;
}

function clearPublicSearchLayersFromMap() {
    const map = window.map;
    if (!map || !dataLayerGroups) return;
    const toRemove = [];
    dataLayerGroups.forEach((_group, layerId) => {
        if (String(layerId).startsWith(PUBLIC_SEARCH_LAYER_PREFIX)) toRemove.push(layerId);
    });
    toRemove.forEach((layerId) => removeDataLayer(layerId));
}

function normalizePublicSearchAnnotation(annotation, sourceOrgId) {
    if (!annotation || !annotation.geometry) return annotation;
    const geomType = annotation.geometry.type;
    let type = annotation.type;
    if (!type && geomType) {
        if (geomType === 'Point') type = 'point';
        else if (geomType === 'LineString' || geomType === 'MultiLineString') type = 'line';
        else if (geomType === 'Polygon' || geomType === 'MultiPolygon') type = 'polygon';
    }
    const out = { ...annotation, type: type || annotation.type };
    if (sourceOrgId != null && sourceOrgId !== '') {
        out._featureTypeOrgId = sourceOrgId;
        if (out.sharedFromOrganizationId == null) {
            out.sharedFromOrganizationId = sourceOrgId;
        }
    }
    return out;
}

function renderPublicSearchLayersOnMap() {
    clearPublicSearchLayersFromMap();
    const layers = window.PUBLIC_MAP_LAYERS || [];
    layers.forEach((layer) => {
        const sourceOrgId = layer.sharedFromOrganizationId;
        const annotations = (layer.annotations || []).map((ann) =>
            normalizePublicSearchAnnotation(ann, sourceOrgId)
        );
        renderDataLayer({
            ...layer,
            id: publicSearchLayerKey(layer),
            name: layer.sharedSourceLabel ? `${layer.name} (${layer.sharedSourceLabel})` : layer.name,
            annotations,
            isVisible: true,
            listInLayerPanel: false,
            readOnly: true,
        });
        const group = dataLayerGroups && dataLayerGroups.get(publicSearchLayerKey(layer));
        if (group && window.map && !window.map.hasLayer(group)) {
            group.addTo(window.map);
        }
    });
}

// Clear all overlay layers from map when switching organization (no confirm dialog)
function clearMapOverlaysForOrgSwitch() {
    const map = window.map;
    if (!map) return;

    // Clear annotations layer group but keep it on map (empty)
    if (annotationsLayerGroup) {
        annotationsLayerGroup.clearLayers();
        annotationsLayerCleared = false;
    }

    // Remove all data layer groups from map and clear the map
    if (dataLayerGroups && dataLayerGroups.size > 0) {
        dataLayerGroups.forEach((layerGroup) => {
            if (map.hasLayer(layerGroup)) {
                map.removeLayer(layerGroup);
            }
        });
        dataLayerGroups.clear();
    }
    if (window.dataLayerPreviewModule?.clearAllPreviewLayers) {
        window.dataLayerPreviewModule.clearAllPreviewLayers();
    }
}

// Clear all overlay layers
async function clearAllOverlayLayers() {
    if (!(await appConfirm('Are you sure you want to clear all overlay layers from the map? This will remove all annotations and uploaded data layers from the map and layer control, but they will remain saved.'))) {
        return;
    }
    
    const map = window.map;
    if (!map) return;
    
    // Mark annotations layer as cleared
    annotationsLayerCleared = true;
    
    // Remove annotations layer from map
    if (annotationsLayerGroup && map.hasLayer(annotationsLayerGroup)) {
        map.removeLayer(annotationsLayerGroup);
    }
    // Don't set annotationsLayerGroup to null - keep it so we can check if it was cleared
    
    // Remove all saved map data layers from map (file uploads + Save as Data Layer)
    const savedDataLayers = window.annotationStorageModule?.savedDataLayers || [];
    if (savedDataLayers && savedDataLayers.length > 0) {
        savedDataLayers.forEach(layer => {
            if (!isSavedMapDataLayer(layer)) return;
            const layerGroup = dataLayerGroups ? dataLayerGroups.get(layer.id) : null;
            if (layerGroup && map.hasLayer(layerGroup)) {
                map.removeLayer(layerGroup);
            }
            if (dataLayerGroups) {
                dataLayerGroups.delete(layer.id);
            }
            if (window.dataLayerPreviewModule?.unregisterLayer) {
                window.dataLayerPreviewModule.unregisterLayer(layer.id);
            }
            layer.isVisible = false;
            layer.listInLayerPanel = false;
        });

        if (window.dataLayerPreviewModule?.clearAllPreviewLayers) {
            window.dataLayerPreviewModule.clearAllPreviewLayers();
        }

        // Save the updated visibility flags
        if (window.annotationStorageModule && window.annotationStorageModule.saveDataLayers) {
            window.annotationStorageModule.saveDataLayers();
        }
    }
    
    // Remove all overlay options from layer control panel
    if (window.layerControlPanel) {
        // Remove annotations overlay
        const annotationsOverlay = window.layerControlPanel.querySelector('.overlay-annotations');
        if (annotationsOverlay) {
            annotationsOverlay.remove();
        }
        
        // Remove save button
        const saveButton = window.layerControlPanel.querySelector('.save-data-layer-button');
        if (saveButton) {
            saveButton.remove();
        }
        
        // Remove all data layer overlays
        const dataLayerOverlays = window.layerControlPanel.querySelectorAll('.overlay-data-layer');
        dataLayerOverlays.forEach(overlay => overlay.remove());
        
        // Remove divider and title container if no overlays remain
        const remainingOverlays = window.layerControlPanel.querySelectorAll('.layer-option');
        if (remainingOverlays.length === 0) {
            const divider = window.layerControlPanel.querySelector('.layer-divider');
            const overlayTitleContainer = window.layerControlPanel.querySelector('.overlay-title-container');
            if (divider) divider.remove();
            if (overlayTitleContainer) overlayTitleContainer.remove();
        }
    }
    
    // Refresh data window if open
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
    
    await appAlert('All overlay layers have been cleared from the map and layer control. They remain saved; use Data Hub → Layers → Load to show a layer on the map again.');
}

// Add aerial map to layer control in "Aerial Maps" section
function addAerialMapToControl(aerialMap, layer) {
    const map = window.map;
    if (!window.layerControlPanel || !map || !aerialMap || !layer) return;
    
    // Check if already exists
    const existing = window.layerControlPanel.querySelector(`.overlay-aerial-map[data-aerial-map-id="${aerialMap.id}"]`);
    if (existing) return;
    
    // Ensure divider exists
    let divider = window.layerControlPanel.querySelector('.layer-divider');
    if (!divider) {
        divider = L.DomUtil.create('div', 'layer-divider', window.layerControlPanel);
        divider.style.cssText = 'border-top: 1px solid #ddd; margin: 10px 0;';
    }
    
    // Ensure "Aerial Maps" section title exists
    let aerialMapsTitleContainer = window.layerControlPanel.querySelector('.aerial-maps-title-container');
    if (!aerialMapsTitleContainer) {
        aerialMapsTitleContainer = L.DomUtil.create('div', 'aerial-maps-title-container', window.layerControlPanel);
        aerialMapsTitleContainer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; margin-top: 8px;';
        
        const aerialMapsTitle = L.DomUtil.create('div', 'aerial-maps-title', aerialMapsTitleContainer);
        aerialMapsTitle.textContent = 'Aerial Maps';
        aerialMapsTitle.style.cssText = 'font-weight: 600; color: #000; font-size: 0.875rem;';
    }
    
    // Create overlay option for aerial map
    const overlayOption = L.DomUtil.create('div', 'layer-option overlay-aerial-map', window.layerControlPanel);
    overlayOption.setAttribute('data-aerial-map-id', aerialMap.id);
    overlayOption.style.cssText = 'padding: 8px; border-radius: 4px; margin-bottom: 4px; color: #000; display: flex; align-items: center; gap: 8px;';
    
    const checkbox = L.DomUtil.create('input', '', overlayOption);
    checkbox.type = 'checkbox';
    checkbox.checked = true; // Aerial maps are visible by default when loaded
    checkbox.style.cssText = 'margin-right: 8px;';
    checkbox.id = `aerial-map-${aerialMap.id}`;
    
    const label = L.DomUtil.create('label', '', overlayOption);
    label.textContent = aerialMap.name || 'Unnamed Aerial Map';
    label.style.cssText = 'cursor: pointer; user-select: none; color: #000; flex-grow: 1;';
    
    // Click handler for checkbox to toggle layer visibility
    L.DomEvent.on(checkbox, 'click', function(e) {
        L.DomEvent.stopPropagation(e);
        e.stopImmediatePropagation();
        
        const currentLayer = window.aerialMapsModule?.aerialMapLayers?.get(aerialMap.id);
        if (!currentLayer) return;
        if (typeof window.aerialMapsModule?.setAerialLayerDesiredOnMap === 'function') {
            window.aerialMapsModule.setAerialLayerDesiredOnMap(aerialMap.id, checkbox.checked);
        } else if (checkbox.checked && map) {
            map.addLayer(currentLayer);
        } else if (map) {
            map.removeLayer(currentLayer);
        }
    });
    
    // Click handler on overlayOption - zoom if not clicking checkbox
    L.DomEvent.on(overlayOption, 'click', function(e) {
        // If clicking the checkbox, let the checkbox handler deal with it
        if (e.target === checkbox || checkbox.contains(e.target)) {
            return;
        }
        
        // Otherwise, zoom to aerial map bounding box
        L.DomEvent.stopPropagation(e);
        e.preventDefault();
        
        if (aerialMap.boundingBox && aerialMap.boundingBox.coordinates) {
            const coords = aerialMap.boundingBox.coordinates[0];
            const bounds = L.latLngBounds(
                coords.map(coord => [coord[1], coord[0]]) // Convert [lng, lat] to [lat, lng]
            );
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    });
    
    L.DomEvent.disableClickPropagation(overlayOption);
}

// Remove aerial map from layer control
function removeAerialMapFromControl(aerialMapId) {
    if (!window.layerControlPanel) return;
    
    const overlayOption = window.layerControlPanel.querySelector(`.overlay-aerial-map[data-aerial-map-id="${aerialMapId}"]`);
    if (overlayOption) {
        overlayOption.remove();
    }
    
    // Remove "Aerial Maps" section title if no aerial maps remain
    const remainingAerialMaps = window.layerControlPanel.querySelectorAll('.overlay-aerial-map');
    if (remainingAerialMaps.length === 0) {
        const aerialMapsTitleContainer = window.layerControlPanel.querySelector('.aerial-maps-title-container');
        if (aerialMapsTitleContainer) {
            aerialMapsTitleContainer.remove();
        }
    }
}

// Export for use in other modules
window.layerManagerModule = {
    get annotationsLayerGroup() { return annotationsLayerGroup; },
    set annotationsLayerGroup(value) { annotationsLayerGroup = value; },
    get annotationsLayerName() { return annotationsLayerName; },
    set annotationsLayerName(value) { annotationsLayerName = value; },
    get annotationsLayerCleared() { return annotationsLayerCleared; },
    set annotationsLayerCleared(value) { annotationsLayerCleared = value; },
    get annotationsLayerUserWantsVisible() { return annotationsLayerUserWantsVisible; },
    get annotationOverlaysHiddenForTicketDraw() { return annotationOverlaysHiddenForTicketDraw; },
    setAnnotationOverlaysHiddenForTicketDraw,
    set annotationsLayerUserWantsVisible(value) { annotationsLayerUserWantsVisible = value; },
    get dataLayerGroups() { return dataLayerGroups; },
    set dataLayerGroups(value) { dataLayerGroups = value; },
    isSavedMapDataLayer,
    initAnnotationsLayer,
    updateLayerControlOverlays,
    addDataLayerToControl,
    renderDataLayer,
    removeDataLayer,
    zoomToAnnotationsLayer,
    zoomToDataLayer,
    clearAllOverlayLayers,
    clearMapOverlaysForOrgSwitch,
    clearPublicSearchLayersFromMap,
    renderPublicSearchLayersOnMap,
    addAerialMapToControl,
    removeAerialMapFromControl,
    syncAnnotationLayersForZoom,
    ANNOTATION_MIN_ZOOM
};

