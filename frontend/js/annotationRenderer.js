// Annotation Renderer module - Rendering annotations on the map

// Store annotation layers (viewport-visible leaflet layers at zoom 16+)
let annotationLayers = [];

function iconColorForAnnotation(annotation) {
    const base = annotation.color || 'var(--app-accent)';
    const mod = window.utilityTypesModule;
    if (mod && typeof mod.getAnnotationIconColor === 'function') {
        return mod.getAnnotationIconColor(annotation.utilityType, base);
    }
    return base;
}

function linePathOptions(annotation, extra) {
    const col = annotation.color || 'var(--app-accent)';
    const base = Object.assign({ color: col, weight: 3 }, extra || {});
    const ft = window.featureTypeLibraryModule;
    if (ft && typeof ft.mergePolylineStyle === 'function') {
        return ft.mergePolylineStyle(base, annotation);
    }
    return base;
}

function polygonPathOptions(annotation, extra) {
    const col = annotation.color || 'var(--app-accent)';
    const base = Object.assign({
        color: col,
        weight: 3,
        fillColor: col,
        fillOpacity: 0.2
    }, extra || {});
    const ft = window.featureTypeLibraryModule;
    if (ft && typeof ft.mergePolygonStyle === 'function') {
        return ft.mergePolygonStyle(base, annotation);
    }
    return base;
}

function clearTrackedLayersFromGroup(group) {
    if (!group) return;
    annotationLayers.forEach(layer => {
        if (group.hasLayer(layer)) group.removeLayer(layer);
    });
    annotationLayers = [];
}

function renderOneAnnotation(annotation, group) {
    if (!annotation || !group) return;

    if (annotation.type === 'point') {
        const point = annotation.geometry;
        const iconType = (annotation.icon && annotation.icon !== 'none') ? annotation.icon : 'circle';
        const iconColor = iconColorForAnnotation(annotation);
        const excavationPad = annotation.utilityType === 'Proposed Excavation';
        const iconOpts = { excavationPadding: excavationPad };
        const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
        const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
        const layout = window.iconsModule?.getMapIconLayout
            ? window.iconsModule.getMapIconLayout(iconOpts)
            : { size: 24, anchor: 12 };

        const marker = L.marker([point.coordinates[1], point.coordinates[0]], {
            icon: L.divIcon({
                className: 'annotation-marker',
                html: iconHTML,
                iconSize: [layout.size, layout.size],
                iconAnchor: [layout.anchor, layout.anchor],
            }),
        });
        marker.addTo(group);
        marker._annotationId = annotation.id;
        annotationLayers.push(marker);
        marker.bindPopup(createAnnotationPopup(annotation));
    } else if (annotation.type === 'line') {
        const line = annotation.geometry;
        const polyline = L.polyline(
            line.coordinates.map(coord => [coord[1], coord[0]]),
            linePathOptions(annotation)
        );
        polyline.addTo(group);
        polyline._annotationId = annotation.id;
        annotationLayers.push(polyline);

        if (annotation.icon && annotation.icon !== 'none') {
            const iconType = annotation.icon;
            const iconColor = iconColorForAnnotation(annotation);
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad, size: 20 };
            const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const vLayout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 20, anchor: 10 };

            line.coordinates.forEach(coord => {
                const vertexMarker = L.marker([coord[1], coord[0]], {
                    icon: L.divIcon({
                        className: 'annotation-vertex-marker',
                        html: iconHTML,
                        iconSize: [vLayout.size, vLayout.size],
                        iconAnchor: [vLayout.anchor, vLayout.anchor],
                    }),
                });
                vertexMarker.addTo(group);
                vertexMarker._annotationId = annotation.id;
                annotationLayers.push(vertexMarker);
            });
        }

        polyline.bindPopup(createAnnotationPopup(annotation));
    } else if (annotation.type === 'polygon') {
        const polygon = annotation.geometry;
        const poly = L.polygon(
            polygon.coordinates[0].map(coord => [coord[1], coord[0]]),
            polygonPathOptions(annotation)
        );
        poly.addTo(group);
        poly._annotationId = annotation.id;
        annotationLayers.push(poly);

        if (annotation.icon && annotation.icon !== 'none') {
            const iconType = annotation.icon;
            const iconColor = iconColorForAnnotation(annotation);
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad, size: 20 };
            const getIconHTML = window.iconsModule?.getIconHTML || function () { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const vLayout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 20, anchor: 10 };

            polygon.coordinates[0].forEach(coord => {
                const vertexMarker = L.marker([coord[1], coord[0]], {
                    icon: L.divIcon({
                        className: 'annotation-vertex-marker',
                        html: iconHTML,
                        iconSize: [vLayout.size, vLayout.size],
                        iconAnchor: [vLayout.anchor, vLayout.anchor],
                    }),
                });
                vertexMarker.addTo(group);
                vertexMarker._annotationId = annotation.id;
                annotationLayers.push(vertexMarker);
            });
        }

        poly.bindPopup(createAnnotationPopup(annotation));
    }
}

function getAnnotationsForMapRender() {
    const annotations = window.annotationStorageModule?.annotations || [];
    const hub = window.dataHubFiltersModule;
    if (hub?.hasActiveFilters?.('annotations')) {
        return hub.filterForMap('annotations', annotations);
    }
    return annotations;
}

function renderAnnotationsInViewport(group, annotations) {
    if (!group || !Array.isArray(annotations)) return;
    clearTrackedLayersFromGroup(group);
    annotations.forEach(annotation => renderOneAnnotation(annotation, group));
}

// Render all annotations
function renderAnnotations() {
    const map = window.map;
    if (!map) return;

    if (window.dataLayerPreviewModule?.refreshAnnotationsLayer) {
        window.dataLayerPreviewModule.refreshAnnotationsLayer();
        if (window.layerManagerModule?.updateLayerControlOverlays) {
            window.layerManagerModule.updateLayerControlOverlays();
        }
        return;
    }

    const annotations = getAnnotationsForMapRender();
    if (!window.layerManagerModule) {
        console.error('Layer manager module not available');
        return;
    }
    const layerGroup = window.layerManagerModule.initAnnotationsLayer();
    if (!layerGroup) return;

    clearTrackedLayersFromGroup(layerGroup);
    annotations.forEach(annotation => renderOneAnnotation(annotation, layerGroup));

    if (window.layerManagerModule.updateLayerControlOverlays) {
        window.layerManagerModule.updateLayerControlOverlays();
    }
}

function featureTypeLabelForPopup(annotation) {
    const ut = annotation.utilityType;
    if (ut == null || String(ut).trim() === '') return '';
    const s = String(ut).trim();
    const ft = window.featureTypeLibraryModule;
    if (ft && typeof ft.parseOrgTypeKey === 'function' && ft.parseOrgTypeKey(s)) {
        const customId = ft.parseOrgTypeKey(s);
        const orgId =
            annotation._featureTypeOrgId != null
                ? annotation._featureTypeOrgId
                : annotation.sharedFromOrganizationId != null
                  ? annotation.sharedFromOrganizationId
                  : typeof window.getCurrentOrgId === 'function'
                    ? window.getCurrentOrgId()
                    : null;
        const lib = ft.getAnnotationFeatureTypeLibraryForOrgId
            ? ft.getAnnotationFeatureTypeLibraryForOrgId(orgId)
            : [];
        const entry = ft.findLibraryEntry ? ft.findLibraryEntry(lib, customId) : null;
        if (entry) return entry.label || entry.id;
        return 'Organization type';
    }
    return s;
}

// Create annotation popup content
// options.readOnly: hide Edit (e.g. features from a loaded saved data layer are not editable)
function createAnnotationPopup(annotation, options) {
    const readOnly = options && options.readOnly === true;
    const escapeHtml = typeof window.escapeHtmlForAnnotation === 'function' ? window.escapeHtmlForAnnotation : function (s) { return String(s || '').replace(/</g, '&lt;'); };
    const name = escapeHtml(annotation.name || annotation.type);
    const featureTypeText = featureTypeLabelForPopup(annotation);
    const featureTypeRow = featureTypeText
        ? `<div class="map-leaflet-popup__meta">Feature type: <strong>${escapeHtml(featureTypeText)}</strong></div>`
        : '';
    const formatDateTime = typeof window.formatRecordedDateTime === 'function' ? window.formatRecordedDateTime : function () { return ''; };
    const createdAtText = formatDateTime(annotation.createdAt, '', '');
    const createdAtRow = createdAtText
        ? `<div class="map-leaflet-popup__meta">Created: <strong>${escapeHtml(createdAtText)}</strong></div>`
        : '';
    let gpsRow = '';
    if (annotation.type === 'point' && annotation.geometry && annotation.geometry.coordinates) {
        const buildMapPopupGpsRow = typeof window.buildMapPopupGpsRow === 'function' ? window.buildMapPopupGpsRow : function () { return ''; };
        const [lng, lat] = annotation.geometry.coordinates;
        gpsRow = buildMapPopupGpsRow(lat, lng);
    }
    const note = annotation.note ? `<div class="map-leaflet-popup__note">${escapeHtml(annotation.note)}</div>` : '';
    let attributionSection = '';
    if (annotation.createdBy || annotation.lastEditedBy) {
        const parts = [];
        if (annotation.createdBy) parts.push(`Created by ${escapeHtml(annotation.createdBy)}`);
        if (annotation.lastEditedBy) parts.push(`Last edited by ${escapeHtml(annotation.lastEditedBy)}`);
        attributionSection = `<div class="map-leaflet-popup__attrib">${parts.join('<br>')}</div>`;
    }

    let documentSection = '';
    if (annotation.documentRef) {
        const documentsModule = window.documentsModule;
        const document = documentsModule?.getDocument?.(annotation.documentRef);
        if (document) {
            const fileName = document.fileName || 'Unnamed Document';
            documentSection = `
                <div class="map-leaflet-popup__divider">
                    <div class="map-leaflet-popup__divider-label">Referenced Document:</div>
                    <button class="map-leaflet-popup__btn map-leaflet-popup__btn--success annotation-view-document-btn" data-document-id="${annotation.documentRef}">
                        📄 ${fileName}
                    </button>
                </div>
            `;
        }
    }

    const div = document.createElement('div');
    div.className = 'map-leaflet-popup';
    // Safe for innerHTML: dynamic annotation values are escaped with escapeHtmlForAnnotation above.
    div.innerHTML = `
        <div class="map-leaflet-popup__title map-leaflet-popup__title--capitalize">${name}</div>
        ${featureTypeRow}
        ${createdAtRow}
        ${gpsRow}
        ${note}
        ${attributionSection}
        ${readOnly ? '' : `
        <div class="map-leaflet-popup__actions">
            <button class="map-leaflet-popup__btn annotation-edit-btn" data-id="${annotation.id}">Edit</button>
        </div>
        `}
        ${documentSection}
    `;

    const editBtn = div.querySelector('.annotation-edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (window.editAnnotation) {
                window.editAnnotation(annotation.id);
            }
        });
    }

    const viewDocumentBtn = div.querySelector('.annotation-view-document-btn');
    if (viewDocumentBtn) {
        viewDocumentBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            const documentId = viewDocumentBtn.getAttribute('data-document-id');
            if (documentId && window.viewDocument) {
                window.viewDocument(documentId);
            }
        });
    }

    return div;
}

window.annotationRendererModule = {
    get annotationLayers() { return annotationLayers; },
    renderAnnotations,
    renderAnnotationsInViewport,
    createAnnotationPopup
};
