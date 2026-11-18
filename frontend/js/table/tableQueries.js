// Table queries module - Polygon querying functionality

// Point-in-polygon test using ray casting algorithm
function isPointInPolygon(point, polygon) {
    const latlngs = polygon.getLatLngs()[0]; // Get first ring of polygon
    let inside = false;
    
    for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
        const xi = latlngs[i].lng;
        const yi = latlngs[i].lat;
        const xj = latlngs[j].lng;
        const yj = latlngs[j].lat;
        
        const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
            (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
        
        if (intersect) inside = !inside;
    }
    
    return inside;
}

/** Photos linked to a ticket include any within this distance of the ticket polygon edge (not only inside). */
const TICKET_PHOTO_SEARCH_BUFFER_FEET = 180;
const TICKET_PHOTO_SEARCH_BUFFER_METERS = TICKET_PHOTO_SEARCH_BUFFER_FEET * 0.3048;

/**
 * @param {L.LatLng} p
 * @param {L.LatLng} a
 * @param {L.LatLng} b
 * @returns {number}
 */
function distancePointToSegmentMeters(p, a, b) {
    const ax = a.lng;
    const ay = a.lat;
    const bx = b.lng;
    const by = b.lat;
    const px = p.lng;
    const py = p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return p.distanceTo(a);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cLat = ay + t * dy;
    const cLng = ax + t * dx;
    return p.distanceTo(L.latLng(cLat, cLng));
}

/**
 * Shortest distance from a point to the polygon ring (meters), when the point is outside the polygon.
 * @param {L.LatLng} point
 * @param {L.Polygon} leafletPolygon
 * @returns {number}
 */
function minDistancePointToPolygonBoundaryMeters(point, leafletPolygon) {
    const latlngs = leafletPolygon.getLatLngs()[0];
    let minD = Infinity;
    for (let i = 0; i < latlngs.length; i++) {
        const j = (i + 1) % latlngs.length;
        const d = distancePointToSegmentMeters(point, latlngs[i], latlngs[j]);
        if (d < minD) minD = d;
    }
    return minD;
}

/**
 * True if the point lies inside the polygon bounds expanded by bufferMeters (cheap prefilter).
 * @param {L.Polygon} leafletPolygon
 * @param {L.LatLng} point
 * @param {number} bufferMeters
 */
function polygonBoundsContainsPointWithBuffer(leafletPolygon, point, bufferMeters) {
    const bounds = leafletPolygon.getBounds();
    const latRad = ((bounds.getNorth() + bounds.getSouth()) / 2) * (Math.PI / 180);
    const latPad = bufferMeters / 111320;
    const cosLat = Math.cos(latRad);
    const lngPad = cosLat > 1e-6 ? bufferMeters / (111320 * cosLat) : latPad;
    const southWest = L.latLng(bounds.getSouth() - latPad, bounds.getWest() - lngPad);
    const northEast = L.latLng(bounds.getNorth() + latPad, bounds.getEast() + lngPad);
    return L.latLngBounds(southWest, northEast).contains(point);
}

/**
 * Photo counts for tickets: inside the polygon or within TICKET_PHOTO_SEARCH_BUFFER_METERS of its edge.
 * @param {L.LatLng} point
 * @param {L.Polygon} leafletPolygon
 */
function isPointInOrNearTicketPolygon(point, leafletPolygon) {
    const bufferM = TICKET_PHOTO_SEARCH_BUFFER_METERS;
    if (!polygonBoundsContainsPointWithBuffer(leafletPolygon, point, bufferM)) return false;
    if (isPointInPolygon(point, leafletPolygon)) return true;
    return minDistancePointToPolygonBoundaryMeters(point, leafletPolygon) <= bufferM;
}

function queryResultLineStyle(annotation) {
    const col = annotation.color || 'var(--app-accent)';
    const base = { color: col, weight: 2 };
    const ft = window.featureTypeLibraryModule;
    return ft && typeof ft.mergePolylineStyle === 'function'
        ? ft.mergePolylineStyle(base, annotation)
        : base;
}

function queryResultPolygonStyle(annotation) {
    const col = annotation.color || 'var(--app-accent)';
    const base = {
        color: col,
        weight: 2,
        fillColor: col,
        fillOpacity: 0.2
    };
    const ft = window.featureTypeLibraryModule;
    return ft && typeof ft.mergePolygonStyle === 'function'
        ? ft.mergePolygonStyle(base, annotation)
        : base;
}

/** True if an annotation's geometry intersects a Leaflet query polygon. */
function annotationIntersectsPolygon(annotation, queryPolygon) {
    if (!annotation || !queryPolygon) return false;
    if (annotation.type === 'point' && annotation.geometry && annotation.geometry.coordinates) {
        const [lng, lat] = annotation.geometry.coordinates;
        const point = L.latLng(lat, lng);
        return queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon);
    }
    if (annotation.type === 'line' && annotation.geometry && annotation.geometry.coordinates) {
        const coords = annotation.geometry.coordinates.map((c) => L.latLng(c[1], c[0]));
        return coords.some(
            (point) => queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon)
        );
    }
    if (
        annotation.type === 'polygon' &&
        annotation.geometry &&
        annotation.geometry.coordinates &&
        annotation.geometry.coordinates[0]
    ) {
        const coords = annotation.geometry.coordinates[0].map((c) => L.latLng(c[1], c[0]));
        return coords.some(
            (point) => queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon)
        );
    }
    return false;
}

// Check if a document geometry intersects with a query polygon
function documentIntersectsPolygon(docGeometry, queryPolygon) {
    if (!docGeometry || !queryPolygon) return false;
    
    try {
        if (docGeometry.type === 'Point') {
            // Check if point is inside polygon
            const [lng, lat] = docGeometry.coordinates;
            const point = L.latLng(lat, lng);
            return queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon);
        } else if (docGeometry.type === 'LineString') {
            // Check if any point of the line is inside the polygon
            const coords = docGeometry.coordinates.map(c => L.latLng(c[1], c[0]));
            return coords.some(point => 
                queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon)
            );
        } else if (docGeometry.type === 'Polygon') {
            // Check if any vertex of the polygon is inside the query polygon
            const coords = docGeometry.coordinates[0].map(c => L.latLng(c[1], c[0]));
            return coords.some(point => 
                queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon)
            );
        }
    } catch (error) {
        console.error('Error checking document intersection:', error);
        return false;
    }
    
    return false;
}

// Combine multiple ticket polygons into one geometry
function combineTicketPolygons(tickets) {
    if (tickets.length === 0) return null;
    
    // For now, just use the first ticket's polygon
    // In a full implementation, you'd union all polygons
    const firstTicket = tickets[0];
    if (firstTicket.polygon) {
        return firstTicket.polygon;
    }
    if (firstTicket.geometry && firstTicket.geometry.type === 'Polygon') {
        return firstTicket.geometry;
    }
    
    return null;
}

// Add temporary layer to layer control
function addTempLayerToControl(layerId, layerName, layerGroup) {
    const map = window.map;
    if (!window.layerControlPanel || !map || !layerGroup) return;
    
    // Check if already exists
    const existing = window.layerControlPanel.querySelector(`.overlay-temp-layer[data-layer-id="${layerId}"]`);
    if (existing) return;
    
    // Ensure divider and title container exist
    let divider = window.layerControlPanel.querySelector('.layer-divider');
    if (!divider) {
        divider = L.DomUtil.create('div', 'layer-divider', window.layerControlPanel);
        divider.style.cssText = 'border-top: 1px solid #ddd; margin: 10px 0;';
    }
    
    let overlayTitleContainer = window.layerControlPanel.querySelector('.overlay-title-container');
    if (!overlayTitleContainer) {
        overlayTitleContainer = L.DomUtil.create('div', 'overlay-title-container', window.layerControlPanel);
        overlayTitleContainer.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
        
        const overlayTitle = L.DomUtil.create('div', 'overlay-title', overlayTitleContainer);
        overlayTitle.textContent = 'Overlays';
        overlayTitle.style.cssText = 'font-weight: 600; color: #000; font-size: 0.875rem;';
        
        const clearLayersButton = L.DomUtil.create('button', 'clear-layers-button', overlayTitleContainer);
        clearLayersButton.textContent = 'Clear Layers';
        clearLayersButton.style.cssText = 'padding: 2px 8px; background: var(--app-danger); color: var(--app-text-inverse); border: none; border-radius: 4px; cursor: pointer; font-size: 0.7rem; font-weight: 500;';
        clearLayersButton.title = 'Clear all overlay layers';
        
        L.DomEvent.on(clearLayersButton, 'click', function(e) {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            if (window.annotationsModule && window.annotationsModule.clearAllOverlayLayers) {
                window.annotationsModule.clearAllOverlayLayers();
            }
        });
        
        L.DomEvent.disableClickPropagation(clearLayersButton);
    }
    
    // Create overlay option for temp layer
    const overlayOption = L.DomUtil.create('div', 'layer-option overlay-temp-layer', window.layerControlPanel);
    overlayOption.setAttribute('data-layer-id', layerId);
    overlayOption.style.cssText = 'padding: 8px; border-radius: 4px; margin-bottom: 4px; color: #000; display: flex; align-items: center; gap: 8px;';
    
    const checkbox = L.DomUtil.create('input', '', overlayOption);
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.style.cssText = 'margin-right: 8px;';
    
    const label = L.DomUtil.create('label', '', overlayOption);
    label.textContent = layerName;
    label.style.cssText = 'cursor: pointer; user-select: none; color: #000; flex-grow: 1;';
    
    // Click handler for checkbox
    L.DomEvent.on(checkbox, 'click', function(e) {
        L.DomEvent.stopPropagation(e);
        e.stopImmediatePropagation();
        
        if (checkbox.checked && map) {
            map.addLayer(layerGroup);
        } else if (map) {
            map.removeLayer(layerGroup);
        }
    });
    
    // Click handler on overlayOption - zoom if not clicking checkbox
    L.DomEvent.on(overlayOption, 'click', function(e) {
        if (e.target === checkbox || checkbox.contains(e.target)) {
            return;
        }
        
        L.DomEvent.stopPropagation(e);
        e.preventDefault();
        
        if (layerGroup.getLayers().length > 0) {
            const bounds = layerGroup.getBounds();
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        }
    });
    
    L.DomEvent.disableClickPropagation(overlayOption);
}

function removeTempLayerFromControl(layerId, layerGroup) {
    const map = window.map;
    if (layerGroup && map) {
        try {
            map.removeLayer(layerGroup);
        } catch (_) {
            /* ignore */
        }
    }
    if (!window.layerControlPanel) return;
    const existing = window.layerControlPanel.querySelector(`.overlay-temp-layer[data-layer-id="${layerId}"]`);
    if (existing) existing.remove();
}

function getPhotoLatLngFromRecord(photo) {
    if (!photo) return null;
    if (photo.exifData?.gpsLat != null && photo.exifData?.gpsLng != null) {
        return { lat: photo.exifData.gpsLat, lng: photo.exifData.gpsLng };
    }
    if (photo.latlng?.lat != null && photo.latlng?.lng != null) {
        return { lat: photo.latlng.lat, lng: photo.latlng.lng };
    }
    if (photo.lat != null && photo.lng != null) {
        return { lat: photo.lat, lng: photo.lng };
    }
    return null;
}

function addPhotoMarkerToLayerGroup(photo, layerGroup) {
    const coords = getPhotoLatLngFromRecord(photo);
    const photosMod = window.photosModule;
    if (!coords || !layerGroup || !photosMod || typeof photosMod.createPhotoMarkerWithPopup !== 'function') {
        return null;
    }
    return photosMod.createPhotoMarkerWithPopup(photo, coords.lat, coords.lng, {
        layerGroup,
        setPhotoMarkerRef: false,
    });
}

// Show popup list of documents found in query
function showDocumentQueryResults(documents) {
    const utils = window.tableUtilsModule || {};
    
    // Create modal overlay
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display: flex; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.7); z-index: 60001; align-items: center; justify-content: center;';
    modal.onclick = function(e) {
        if (e.target === modal) {
            closeDocumentQueryResults();
        }
    };
    
    // Create modal content
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.cssText = 'background: var(--app-bg-page); border: 1px solid var(--app-bg-muted); border-radius: 0.5rem; max-width: 600px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);';
    content.onclick = function(e) {
        e.stopPropagation();
    };
    
    // Create header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 1rem; border-bottom: 1px solid var(--app-bg-muted);';
    
    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.style.cssText = 'font-size: 1.25rem; font-weight: 600; color: var(--app-text-inverse); margin: 0;';
    title.textContent = `Found ${documents.length} Document${documents.length === 1 ? '' : 's'}`;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.style.cssText = 'background: none; border: none; color: var(--app-text-primary); font-size: 1.5rem; cursor: pointer; padding: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = closeDocumentQueryResults;
    
    header.appendChild(title);
    header.appendChild(closeBtn);
    
    // Create body with scrollable list
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.cssText = 'padding: 1rem; overflow-y: auto; flex: 1;';
    
    // Create document list
    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
    
    documents.forEach((doc, index) => {
        const item = document.createElement('div');
        item.style.cssText = 'padding: 0.75rem; background: var(--app-bg-surface-2); border: 1px solid var(--app-border); border-radius: 0.375rem; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background-color 0.2s;';
        item.onmouseenter = function() {
            item.style.background = 'var(--app-bg-muted)';
        };
        item.onmouseleave = function() {
            item.style.background = 'var(--app-bg-surface-2)';
        };
        
        const info = document.createElement('div');
        info.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 0.25rem;';
        
        const name = document.createElement('div');
        name.style.cssText = 'color: var(--app-text-inverse); font-weight: 500; font-size: 0.875rem;';
        name.textContent = doc.fileName || 'Unnamed Document';
        
        const details = document.createElement('div');
        details.style.cssText = 'color: var(--app-text-secondary); font-size: 0.75rem;';
        const fileSize = doc.fileSize ? (utils.formatFileSize ? utils.formatFileSize(doc.fileSize) : `${doc.fileSize} B`) : '—';
        const createdDate = window.formatRecordedDateTime(doc.createdAt);
        details.textContent = `${fileSize} • ${createdDate}`;
        if (doc.geometry) {
            details.textContent += ` • ${doc.geometry.type}`;
        }
        
        info.appendChild(name);
        info.appendChild(details);
        
        const viewBtn = document.createElement('button');
        viewBtn.style.cssText = 'padding: 0.5rem 1rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 0.25rem; cursor: pointer; font-size: 0.875rem; margin-left: 0.5rem;';
        viewBtn.textContent = 'View';
        viewBtn.onclick = function(e) {
            e.stopPropagation();
            // Don't close the query results window - keep it open so user can view multiple documents
            if (window.viewDocument) {
                window.viewDocument(doc.id);
            }
        };
        
        item.appendChild(info);
        item.appendChild(viewBtn);
        
        // Make entire item clickable to view
        item.onclick = function() {
            // Don't close the query results window - keep it open so user can view multiple documents
            if (window.viewDocument) {
                window.viewDocument(doc.id);
            }
        };
        
        list.appendChild(item);
    });
    
    body.appendChild(list);
    
    // Assemble modal
    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(content);
    
    // Add to document
    document.body.appendChild(modal);
    
    // Store reference for closing
    window.documentQueryResultsModal = modal;
}

// Close document query results modal
function closeDocumentQueryResults() {
    if (window.documentQueryResultsModal) {
        document.body.removeChild(window.documentQueryResultsModal);
        window.documentQueryResultsModal = null;
    }
}

// Query annotations within a polygon
function queryAnnotationsInPolygon(queryPolygonGeometry) {
    const map = window.map;
    if (!map) return;
    
    // Convert geometry to Leaflet polygon for intersection checks
    let queryPolygon = null;
    if (queryPolygonGeometry.type === 'Polygon' && queryPolygonGeometry.coordinates && queryPolygonGeometry.coordinates[0]) {
        const coords = queryPolygonGeometry.coordinates[0].map(c => [c[1], c[0]]);
        queryPolygon = L.polygon(coords);
    } else {
        console.error('Invalid polygon geometry for query');
        return;
    }
    
    // Get all annotations
    const annotations = window.annotationStorageModule?.annotations || [];
    const matchingAnnotations = [];
    
    annotations.forEach((annotation) => {
        if (annotationIntersectsPolygon(annotation, queryPolygon)) {
            matchingAnnotations.push(annotation);
        }
    });
    
    if (matchingAnnotations.length === 0) {
        appAlert('No annotations found in the selected area.');
        return;
    }
    
    // Create temporary layer group for query results
    const tempLayerId = `query-annotations-${Date.now()}`;
    const tempLayerGroup = L.layerGroup().addTo(map);
    
    // Render matching annotations
    const createAnnotationPopup = window.annotationRendererModule?.createAnnotationPopup || function() { return ''; };
    
    matchingAnnotations.forEach(annotation => {
        if (annotation.type === 'point' && annotation.geometry && annotation.geometry.coordinates) {
            const [lng, lat] = annotation.geometry.coordinates;
            const iconType = (annotation.icon && annotation.icon !== 'none') ? annotation.icon : 'circle';
            const baseIconColor = annotation.color || 'var(--app-accent)';
            const iconColor = window.utilityTypesModule?.getAnnotationIconColor
                ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, baseIconColor)
                : baseIconColor;
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad };
            const getIconHTML = window.iconsModule?.getIconHTML || function() { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const layout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 24, anchor: 12 };
            
            const marker = L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'annotation-marker',
                    html: iconHTML,
                    iconSize: [layout.size, layout.size],
                    iconAnchor: [layout.anchor, layout.anchor],
                }),
            });
            const popupContent = createAnnotationPopup(annotation);
            marker.bindPopup(popupContent);
            marker.addTo(tempLayerGroup);
        } else if (annotation.type === 'line' && annotation.geometry && annotation.geometry.coordinates) {
            const coords = annotation.geometry.coordinates.map(c => [c[1], c[0]]);
            const polyline = L.polyline(coords, queryResultLineStyle(annotation));
            const popupContent = createAnnotationPopup(annotation);
            polyline.bindPopup(popupContent);
            polyline.addTo(tempLayerGroup);
        } else if (annotation.type === 'polygon' && annotation.geometry && annotation.geometry.coordinates && annotation.geometry.coordinates[0]) {
            const coords = annotation.geometry.coordinates[0].map(c => [c[1], c[0]]);
            const polygon = L.polygon(coords, queryResultPolygonStyle(annotation));
            const popupContent = createAnnotationPopup(annotation);
            polygon.bindPopup(popupContent);
            polygon.addTo(tempLayerGroup);
        }
    });
    
    // Add to layer control as temporary layer
    addTempLayerToControl(tempLayerId, 'Query Results: Annotations', tempLayerGroup);
    
    // Zoom to results
    if (tempLayerGroup && tempLayerGroup.getLayers && tempLayerGroup.getLayers().length > 0) {
        try {
            const bounds = tempLayerGroup.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        } catch (error) {
            // Bounds unavailable, continue without fitBounds
        }
    }
    
    appAlert(`Found ${matchingAnnotations.length} annotation(s) in the selected area.`);
}

// Query saved data layers within a polygon
async function queryDataLayersInPolygon(queryPolygonGeometry) {
    if (window.annotationStorageModule && typeof window.annotationStorageModule.ensureSavedDataLayersLoaded === 'function') {
        await window.annotationStorageModule.ensureSavedDataLayersLoaded();
    }
    const map = window.map;
    if (!map) return;
    
    // Convert geometry to Leaflet polygon
    let queryPolygon = null;
    if (queryPolygonGeometry.type === 'Polygon' && queryPolygonGeometry.coordinates && queryPolygonGeometry.coordinates[0]) {
        const coords = queryPolygonGeometry.coordinates[0].map(c => [c[1], c[0]]);
        queryPolygon = L.polygon(coords);
    } else {
        console.error('Invalid polygon geometry for query');
        return;
    }
    
    // Get all saved data layers
    const savedLayers = window.annotationStorageModule?.savedDataLayers || [];
    const matchingAnnotations = [];
    
    // Filter annotations from all layers that intersect the polygon
    savedLayers.forEach(layer => {
        if (!layer.annotations || layer.annotations.length === 0) return;
        
        layer.annotations.forEach(annotation => {
            if (annotationIntersectsPolygon(annotation, queryPolygon)) {
                matchingAnnotations.push(annotation);
            }
        });
    });
    
    if (matchingAnnotations.length === 0) {
        appAlert('No annotations from data layers found in the selected area.');
        return;
    }
    
    // Create temporary layer group for matching annotations only
    const tempLayerId = `query-layers-${Date.now()}`;
    const tempLayerGroup = L.layerGroup().addTo(map);
    
    // Render only the matching annotations
    const createAnnotationPopup = window.annotationRendererModule?.createAnnotationPopup || function() { return ''; };
    const dlPopupOpts = { readOnly: true };
    
    matchingAnnotations.forEach(annotation => {
        if (annotation.type === 'point' && annotation.geometry && annotation.geometry.coordinates) {
            const [lng, lat] = annotation.geometry.coordinates;
            const iconType = (annotation.icon && annotation.icon !== 'none') ? annotation.icon : 'circle';
            const baseIconColor = annotation.color || 'var(--app-accent)';
            const iconColor = window.utilityTypesModule?.getAnnotationIconColor
                ? window.utilityTypesModule.getAnnotationIconColor(annotation.utilityType, baseIconColor)
                : baseIconColor;
            const excavationPad = annotation.utilityType === 'Proposed Excavation';
            const iconOpts = { excavationPadding: excavationPad };
            const getIconHTML = window.iconsModule?.getIconHTML || function() { return ''; };
            const iconHTML = getIconHTML(iconType, iconColor, iconOpts);
            const layout = window.iconsModule?.getMapIconLayout
                ? window.iconsModule.getMapIconLayout(iconOpts)
                : { size: 24, anchor: 12 };
            
            const marker = L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'annotation-marker',
                    html: iconHTML,
                    iconSize: [layout.size, layout.size],
                    iconAnchor: [layout.anchor, layout.anchor],
                }),
            });
            const popupContent = createAnnotationPopup(annotation, dlPopupOpts);
            marker.bindPopup(popupContent);
            marker.addTo(tempLayerGroup);
        } else if (annotation.type === 'line' && annotation.geometry && annotation.geometry.coordinates) {
            const coords = annotation.geometry.coordinates.map(c => [c[1], c[0]]);
            const polyline = L.polyline(coords, queryResultLineStyle(annotation));
            const popupContent = createAnnotationPopup(annotation, dlPopupOpts);
            polyline.bindPopup(popupContent);
            polyline.addTo(tempLayerGroup);
        } else if (annotation.type === 'polygon' && annotation.geometry && annotation.geometry.coordinates && annotation.geometry.coordinates[0]) {
            const coords = annotation.geometry.coordinates[0].map(c => [c[1], c[0]]);
            const polygon = L.polygon(coords, queryResultPolygonStyle(annotation));
            const popupContent = createAnnotationPopup(annotation, dlPopupOpts);
            polygon.bindPopup(popupContent);
            polygon.addTo(tempLayerGroup);
        }
    });
    
    // Add to layer control as temporary layer
    addTempLayerToControl(tempLayerId, 'Query Results: Data Layers', tempLayerGroup);
    
    // Zoom to results
    if (tempLayerGroup && tempLayerGroup.getLayers && tempLayerGroup.getLayers().length > 0) {
        try {
            const bounds = tempLayerGroup.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        } catch (error) {
            // Bounds unavailable, continue without fitBounds
        }
    }
    
    appAlert(`Found ${matchingAnnotations.length} annotation(s) from data layers in the selected area.`);
}

// Query photos within a polygon
function queryPhotosInPolygon(queryPolygonGeometry) {
    const map = window.map;
    if (!map) return;
    
    // Convert geometry to Leaflet polygon
    let queryPolygon = null;
    if (queryPolygonGeometry.type === 'Polygon' && queryPolygonGeometry.coordinates && queryPolygonGeometry.coordinates[0]) {
        const coords = queryPolygonGeometry.coordinates[0].map(c => [c[1], c[0]]);
        queryPolygon = L.polygon(coords);
    } else {
        console.error('Invalid polygon geometry for query');
        return;
    }
    
    // Get all photos
    const photos = window.photosModule?.savedPhotos || [];
    const matchingPhotos = [];
    
    photos.forEach(photo => {
        const coords = getPhotoLatLngFromRecord(photo);
        if (!coords) return;
        const point = L.latLng(coords.lat, coords.lng);
        if (queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon)) {
            matchingPhotos.push(photo);
        }
    });
    
    if (matchingPhotos.length === 0) {
        appAlert('No photos with location data found in the selected area.');
        return;
    }
    
    // Create temporary photos layer group
    const tempLayerId = `query-photos-${Date.now()}`;
    const tempLayerGroup = L.layerGroup().addTo(map);
    
    // Render matching photos
    matchingPhotos.forEach(photo => {
        addPhotoMarkerToLayerGroup(photo, tempLayerGroup);
    });
    
    // Add to layer control as temporary layer
    addTempLayerToControl(tempLayerId, 'Query Results: Photos', tempLayerGroup);
    
    // Zoom to results
    if (tempLayerGroup && tempLayerGroup.getLayers && tempLayerGroup.getLayers().length > 0) {
        try {
            const bounds = tempLayerGroup.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        } catch (error) {
            // Bounds unavailable, continue without fitBounds
        }
    }
    
    appAlert(`Found ${matchingPhotos.length} photo(s) with location data in the selected area.`);
}

// Query reported events within a polygon
function queryReportedEventsInPolygon(queryPolygonGeometry) {
    const map = window.map;
    if (!map) return;
    
    // Convert geometry to Leaflet polygon
    let queryPolygon = null;
    if (queryPolygonGeometry.type === 'Polygon' && queryPolygonGeometry.coordinates && queryPolygonGeometry.coordinates[0]) {
        const coords = queryPolygonGeometry.coordinates[0].map(c => [c[1], c[0]]);
        queryPolygon = L.polygon(coords);
    } else {
        console.error('Invalid polygon geometry for query');
        return;
    }
    
    // Get current organization ID
    let currentOrgId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        currentOrgId = user.organizationId;
    }
    
    // Get all reported events (filtered by organization)
    let reports = [];
    try {
        if (window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg) {
            reports = window.reportedEventsStore.getReportsForCurrentOrg();
        }
        if (!reports.length) {
            const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            reports = allReports.filter((report) => report.organizationId === currentOrgId);
        }
    } catch (error) {
        console.error('Error loading DIRT reports:', error);
        return;
    }
    
    // Filter events that have location points
    const matchingEvents = reports.filter(report => {
        if (!report.location || !report.location.lat || !report.location.lng) {
            return false;
        }
        
        const point = L.latLng(report.location.lat, report.location.lng);
        return queryPolygon.getBounds().contains(point) && isPointInPolygon(point, queryPolygon);
    });
    
    if (matchingEvents.length === 0) {
        appAlert('No reported events with location data found in the selected area.');
        return;
    }
    
    // Create temporary layer group for events
    const tempLayerId = `query-events-${Date.now()}`;
    const tempLayerGroup = L.layerGroup().addTo(map);
    
    // Render matching events with warning icon
    matchingEvents.forEach(report => {
        const markerIcon =
            window.mapIcons && typeof window.mapIcons.buildEventMapDivIconOptions === 'function'
                ? L.divIcon(window.mapIcons.buildEventMapDivIconOptions())
                : L.divIcon({
                      className: 'event-marker',
                      html: '<div style="background-color: var(--app-danger); width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: 14px; font-weight: bold;">⚠</div>',
                      iconSize: [24, 24],
                      iconAnchor: [12, 12],
                  });
        const marker = L.marker([report.location.lat, report.location.lng], { icon: markerIcon });

        if (typeof window.wireEventMapMarkerPopup === 'function') {
            window.wireEventMapMarkerPopup(marker, report);
        } else {
            const reportId = report.id || `event-${reports.indexOf(report)}`;
            const buildMapPopupGpsRow =
                typeof window.buildMapPopupGpsRow === 'function' ? window.buildMapPopupGpsRow : function () { return ''; };
            const gpsRow = report.location ? buildMapPopupGpsRow(report.location.lat, report.location.lng) : '';
            const popupContent = `
            <div class="map-leaflet-popup">
                <div class="map-leaflet-popup__title">Event Report</div>
                <div class="map-leaflet-popup__meta">Ticket: <strong>${report.ticketNumber || '—'}</strong></div>
                <div class="map-leaflet-popup__meta">Date: <strong>${report.incidentDate || '—'}</strong></div>
                <div class="map-leaflet-popup__meta">Severity: <strong>${report.severity || '—'}</strong></div>
                ${gpsRow}
                <div class="map-leaflet-popup__actions">
                    <button type="button" class="map-leaflet-popup__btn" onclick="viewEvent('${reportId}')">View Details</button>
                </div>
            </div>
        `;
            marker.bindPopup(popupContent);
        }
        marker.addTo(tempLayerGroup);
    });
    
    // Add to layer control as temporary layer
    addTempLayerToControl(tempLayerId, 'Query Results: Reported Events', tempLayerGroup);
    
    // Zoom to results
    if (tempLayerGroup && tempLayerGroup.getLayers && tempLayerGroup.getLayers().length > 0) {
        try {
            const bounds = tempLayerGroup.getBounds();
            if (bounds && bounds.isValid && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        } catch (error) {
            // Bounds unavailable, continue without fitBounds
        }
    }
    
    appAlert(`Found ${matchingEvents.length} reported event(s) with location data in the selected area.`);
}

// Query documents within a polygon
function queryDocumentsInPolygon(queryPolygonGeometry) {
    const map = window.map;
    if (!map) return;
    
    // Create Leaflet polygon from geometry
    const polygonCoords = queryPolygonGeometry.coordinates[0].map(coord => [coord[1], coord[0]]); // Convert [lng, lat] to [lat, lng]
    const queryPolygon = L.polygon(polygonCoords);
    
    // Get all documents
    const allDocuments = window.documentsModule?.savedDocuments || [];
    
    // Filter documents that intersect with the query polygon
    const matchingDocuments = allDocuments.filter(doc => {
        if (!doc.geometry) return false;
        
        return documentIntersectsPolygon(doc.geometry, queryPolygon);
    });
    
    // Store query results for filtering
    window.documentQueryResults = matchingDocuments.map(doc => doc.id);
    
    // Show results
    const count = matchingDocuments.length;
    if (count === 0) {
        appAlert('No documents found within the selected polygon.');
    } else {
        // Show popup list of found documents
        showDocumentQueryResults(matchingDocuments);
    }
    
    // Refresh the data table to show filtered results
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    } else if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

// Process data query for all data in the current tab
function processDataQueryForTab(geometry, currentView) {
    const viewName = {
        'annotations': 'Current Annotations',
        'layers': 'Saved Data Layers',
        'photos': 'Photos',
        'documents': 'Uploaded Documents',
        'aerialmaps': 'Aerial Maps',
        'events': 'Reported Events',
        'reportedEvents': 'Reported Events'
    }[currentView] || 'Current Tab';
    
    // Handle document queries specifically
    if (currentView === 'documents') {
        queryDocumentsInPolygon(geometry);
        return;
    }
    
    // Handle annotations queries
    if (currentView === 'annotations') {
        queryAnnotationsInPolygon(geometry);
        return;
    }
    
    // Handle saved data layers queries
    if (currentView === 'layers') {
        queryDataLayersInPolygon(geometry);
        return;
    }
    
    // Handle photos queries
    if (currentView === 'photos') {
        queryPhotosInPolygon(geometry);
        return;
    }
    
    // Handle reported events queries
    if (currentView === 'reportedEvents' || currentView === 'events') {
        queryReportedEventsInPolygon(geometry);
        return;
    }
    
    appAlert(`Querying for data in the selected area for ${viewName}...\n\nThis feature is not yet implemented for this tab.`);
}

// Start temporary polygon drawing for query (doesn't create annotation)
function startQueryPolygonDrawing(currentView, wasOpen) {
    const map = window.map;
    if (!map) return;
    
    // Cancel any active modes
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    
    // Create temporary drawing state for query
    let queryPoints = [];
    let queryLayer = L.layerGroup().addTo(map);
        window.mapQueryPolygonDrawing = true;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
    
    // Set cursor
    map.getContainer().style.cursor = 'crosshair';
    
    // Click handler for query polygon
    const queryClickHandler = function(e) {
        L.DomEvent.stopPropagation(e);
        queryPoints.push(e.latlng);
        
        // Clear and redraw
        queryLayer.clearLayers();
        
        // Add markers for all points
        queryPoints.forEach((point, index) => {
            const isLast = index === queryPoints.length - 1;
            const marker = L.marker(point, {
                icon: L.divIcon({
                    className: 'query-marker',
                    html: `
                        <div style="background-color: ${isLast ? 'var(--app-success)' : 'var(--app-accent)'}; width: ${isLast ? '20' : '12'}px; height: ${isLast ? '20' : '12'}px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${isLast ? '12' : '0'}px; font-weight: bold; cursor: ${isLast ? 'pointer' : 'default'};">
                            ${isLast ? '✓' : ''}
                        </div>
                    `,
                    iconSize: [isLast ? 20 : 12, isLast ? 20 : 12],
                    iconAnchor: [isLast ? 10 : 6, isLast ? 10 : 6]
                })
            });
            if (isLast) {
                marker.on('click', function() {
                    finishQueryPolygon();
                });
            }
            queryLayer.addLayer(marker);
        });
        
        // Draw polygon preview if we have 2+ points
        if (queryPoints.length >= 2) {
            const polygon = L.polygon(queryPoints.map(p => [p.lat, p.lng]), {
                color: 'var(--app-accent)',
                weight: 3,
                fillColor: 'var(--app-accent)',
                fillOpacity: 0.2,
                dashArray: '5, 5'
            });
            queryLayer.addLayer(polygon);
        }
    };
    
    // Finish query polygon
    function finishQueryPolygon() {
        if (queryPoints.length < 3) {
            appAlert('A polygon needs at least 3 points.');
            return;
        }
        
        // Build geometry
        const coords = queryPoints.map(p => [p.lng, p.lat]);
        coords.push(coords[0]); // Close the polygon
        const geometry = {
            type: 'Polygon',
            coordinates: [coords]
        };
        
        // Clean up
        map.off('click', queryClickHandler);
        map.removeLayer(queryLayer);
        map.getContainer().style.cursor = '';
        window.mapQueryPolygonDrawing = false;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
        
        // Process the query
        processDataQueryForTab(geometry, currentView);
        
        // Reopen data window if it was open, restoring to last tab
        if (wasOpen) {
            setTimeout(() => {
                if (window.openDataWindow) {
                    window.openDataWindow(currentView);
                }
            }, 100);
        }
    }
    
    // Cancel handler
    const cancelHandler = function(e) {
        if (e.key === 'Escape') {
            map.off('click', queryClickHandler);
            window.removeEventListener('keydown', cancelHandler);
            map.removeLayer(queryLayer);
            map.getContainer().style.cursor = '';
            window.mapQueryPolygonDrawing = false;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
            if (wasOpen && window.openDataWindow) {
                window.openDataWindow(currentView);
            }
        }
    };
    
    map.on('click', queryClickHandler);
    window.addEventListener('keydown', cancelHandler);
}

/** Draw a polygon on the map to set Data Hub filter bounds (does not run location search). */
function startDataHubFilterBoundsDrawing(view, wasOpen) {
    const map = window.map;
    if (!map) return;

    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }

    let queryPoints = [];
    const queryLayer = L.layerGroup().addTo(map);
        window.mapQueryPolygonDrawing = true;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
    map.getContainer().style.cursor = 'crosshair';

    const queryClickHandler = function (e) {
        L.DomEvent.stopPropagation(e);
        queryPoints.push(e.latlng);
        queryLayer.clearLayers();
        queryPoints.forEach((point, index) => {
            const isLast = index === queryPoints.length - 1;
            const marker = L.marker(point, {
                icon: L.divIcon({
                    className: 'query-marker',
                    html: `
                        <div style="background-color: ${isLast ? 'var(--app-success)' : 'var(--app-accent)'}; width: ${isLast ? '20' : '12'}px; height: ${isLast ? '20' : '12'}px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${isLast ? '12' : '0'}px; font-weight: bold; cursor: ${isLast ? 'pointer' : 'default'};">
                            ${isLast ? '✓' : ''}
                        </div>
                    `,
                    iconSize: [isLast ? 20 : 12, isLast ? 20 : 12],
                    iconAnchor: [isLast ? 10 : 6, isLast ? 10 : 6],
                }),
            });
            if (isLast) {
                marker.on('click', finishFilterBoundsPolygon);
            }
            queryLayer.addLayer(marker);
        });
        if (queryPoints.length >= 2) {
            const polygon = L.polygon(
                queryPoints.map((p) => [p.lat, p.lng]),
                {
                    color: 'var(--app-accent)',
                    weight: 3,
                    fillColor: 'var(--app-accent)',
                    fillOpacity: 0.2,
                    dashArray: '5, 5',
                }
            );
            queryLayer.addLayer(polygon);
        }
    };

    function finishFilterBoundsPolygon() {
        if (queryPoints.length < 3) {
            appAlert('A polygon needs at least 3 points.');
            return;
        }
        const coords = queryPoints.map((p) => [p.lng, p.lat]);
        coords.push(coords[0]);
        const geometry = { type: 'Polygon', coordinates: [coords] };

        map.off('click', queryClickHandler);
        window.removeEventListener('keydown', cancelHandler);
        map.removeLayer(queryLayer);
        map.getContainer().style.cursor = '';
        window.mapQueryPolygonDrawing = false;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();

        if (window.dataHubFiltersModule?.setBounds) {
            window.dataHubFiltersModule.setBounds(view, geometry);
        }

        if (wasOpen) {
            setTimeout(() => {
                if (window.openDataWindow) {
                    window.openDataWindow(view);
                }
            }, 100);
        }
    }

    function cancelHandler(e) {
        if (e.key !== 'Escape') return;
        map.off('click', queryClickHandler);
        window.removeEventListener('keydown', cancelHandler);
        map.removeLayer(queryLayer);
        map.getContainer().style.cursor = '';
        window.mapQueryPolygonDrawing = false;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
        if (wasOpen && window.openDataWindow) {
            window.openDataWindow(view);
        }
    }

    map.on('click', queryClickHandler);
    window.addEventListener('keydown', cancelHandler);
}

// Select tickets for query by clicking on ticket polygons
function selectTicketsForQuery(currentView, wasOpen) {
    const map = window.map;
    if (!map) return;
    
    const tickets = window.ORG_TICKETS || [];
    if (tickets.length === 0) {
        appAlert('No tickets available on the map.');
        if (wasOpen && window.openDataWindow) {
            window.openDataWindow(currentView);
        }
        return;
    }
    
    window.queryByTicketMode = true;
    window.queryByTicketCurrentView = currentView;
    window.queryByTicketWasOpen = wasOpen;
    window.queryByTicketOnPick = function (ticket) {
        if (!ticket || !ticket.polygon) {
            appAlert('Ticket polygon not found.');
            cleanupQueryByTicketMode();
            return;
        }
        processDataQueryForTab(ticket.polygon, currentView);
        cleanupQueryByTicketMode();
        if (wasOpen && window.openDataWindow) {
            setTimeout(() => {
                window.openDataWindow(currentView);
            }, 100);
        }
    };

    if (window.ticketsModule && typeof window.ticketsModule.highlightTicketPolygonsForQueryMode === 'function') {
        window.ticketsModule.highlightTicketPolygonsForQueryMode();
    }
    
    const escapeHandler = function(e) {
        if (e.key === 'Escape' && window.queryByTicketMode) {
            cleanupQueryByTicketMode();
            window.removeEventListener('keydown', escapeHandler);
            if (wasOpen && window.openDataWindow) {
                window.openDataWindow(currentView);
            }
        }
    };
    window.addEventListener('keydown', escapeHandler);
    window.queryByTicketEscapeHandler = escapeHandler;
    
    // Show instruction
    const instruction = document.createElement('div');
    instruction.id = 'queryTicketInstruction';
    instruction.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(26, 26, 26, 0.95);
        border: 1px solid var(--app-bg-muted);
        border-radius: 0.5rem;
        padding: 1rem 1.5rem;
        color: var(--app-text-inverse);
        font-size: 0.875rem;
        z-index: 100000;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        pointer-events: none;
    `;
    instruction.textContent = 'Click on a ticket polygon to query for data. Press Escape to cancel.';
    document.body.appendChild(instruction);
    
    // Auto-remove instruction after 5 seconds
    setTimeout(() => {
        if (instruction.parentNode) {
            instruction.parentNode.removeChild(instruction);
        }
    }, 5000);
}

// Clean up query by ticket mode
function cleanupQueryByTicketMode() {
    window.queryByTicketMode = false;
    window.queryByTicketOnPick = null;
    window.queryByTicketCurrentView = null;
    window.queryByTicketWasOpen = null;
    
    const instruction = document.getElementById('queryTicketInstruction');
    if (instruction) {
        instruction.parentNode.removeChild(instruction);
    }

    if (window.ticketsModule && typeof window.ticketsModule.restoreTicketMapPolygonStyles === 'function') {
        window.ticketsModule.restoreTicketMapPolygonStyles();
    }
    
    if (window.queryByTicketEscapeHandler) {
        window.removeEventListener('keydown', window.queryByTicketEscapeHandler);
        window.queryByTicketEscapeHandler = null;
    }
}

// Query all data in the current tab (similar to queryDataForLayer but for current view)
function queryAllDataInTab() {
    const map = window.map;
    if (!map) return;
    
    // Get current data view
    const windowModule = window.dataWindowModule;
    const currentView = windowModule?.currentDataView || 'layers';
    
    // Close data window temporarily (save current view)
    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = dataWindow && dataWindow.classList.contains('show');
    if (wasOpen) {
        dataWindow.classList.remove('show');
    }
    
    // Show proper dialog box for selection method
    const dialog = document.createElement('div');
    dialog.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--app-bg-surface);
        border: 1px solid #404040;
        border-radius: 8px;
        padding: 1.5rem;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        min-width: 300px;
    `;
    dialog.innerHTML = `
        <h3 style="margin: 0 0 1rem 0; color: var(--app-text-inverse); font-size: 1.125rem;">Location Search</h3>
        <p style="margin: 0 0 1rem 0; color: var(--app-text-secondary); font-size: 0.875rem;">How would you like to define the query area?</p>
        <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
            <button id="queryDrawPolygon" style="flex: 1; padding: 0.75rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
                Drawn Polygon
            </button>
            <button id="querySelectTicket" style="flex: 1; padding: 0.75rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
                Ticket
            </button>
            <button id="queryCancel" style="padding: 0.75rem 1rem; background: #4a4a4a; color: var(--app-text-inverse); border: none; border-radius: 4px; cursor: pointer;">
                Cancel
            </button>
        </div>
    `;
    document.body.appendChild(dialog);
    
    // Handle dialog button clicks
    dialog.querySelector('#queryDrawPolygon').onclick = function() {
        document.body.removeChild(dialog);
        startQueryPolygonDrawing(currentView, wasOpen);
    };
    
    dialog.querySelector('#querySelectTicket').onclick = function() {
        document.body.removeChild(dialog);
        selectTicketsForQuery(currentView, wasOpen);
    };
    
    dialog.querySelector('#queryCancel').onclick = function() {
        document.body.removeChild(dialog);
        if (wasOpen && window.openDataWindow) {
            window.openDataWindow(currentView);
        }
    };
    
    // Close on outside click
    dialog.onclick = function(e) {
        if (e.target === dialog) {
            document.body.removeChild(dialog);
            if (wasOpen && window.openDataWindow) {
                window.openDataWindow(currentView);
            }
        }
    };
}

// Query for data in a polygon (draw or select from tickets)
async function queryDataForLayer(layerId) {
    const map = window.map;
    if (!map) return;
    
    // Close data window temporarily and save current view
    const dataWindow = document.getElementById('dataWindow');
    const wasOpen = dataWindow && dataWindow.classList.contains('show');
    const currentView = wasOpen && window.dataWindowModule ? window.dataWindowModule.currentDataView : 'layers';
    if (wasOpen) {
        dataWindow.classList.remove('show');
    }
    
    // Ask user how they want to define the polygon
    const method = await appConfirm('Click OK to draw a polygon on the map, or Cancel to select from tickets.');
    
    if (method) {
        // Draw polygon mode
        if (window.drawingModule && window.drawingModule.toggleDrawingMode) {
            // Cancel any active modes
            if (window.measureModule && window.measureModule.cancelMeasureMode) {
                window.measureModule.cancelMeasureMode();
            }
            if (window.photosModule && window.photosModule.cancelPhotoUpload) {
                window.photosModule.cancelPhotoUpload();
            }
            
            // Enable polygon drawing
            window.drawingModule.toggleDrawingMode('polygon');
            
            // Store callback for when polygon is finished
            const originalFinishCallback = window.drawingModule.finishAnnotationCallback;
            window.drawingModule.finishAnnotationCallback = function(geometry) {
                // Restore original callback
                window.drawingModule.finishAnnotationCallback = originalFinishCallback;
                
                // Process the query
                processDataQuery(geometry, layerId);
                
                // Reopen data window if it was open, restoring to last tab
                if (wasOpen) {
                    setTimeout(() => {
                        if (window.openDataWindow) {
                            window.openDataWindow(currentView);
                        }
                    }, 100);
                }
            };
            
            await appAlert('Draw a polygon on the map to query for data. Click the checkmark when done.');
        }
    } else {
        // Select from tickets
        const tickets = window.ticketsModule?.tickets || [];
        if (tickets.length === 0) {
            await appAlert('No tickets available to select from.');
            if (wasOpen && window.openDataWindow) {
                window.openDataWindow(currentView);
            }
            return;
        }
        
        // Show ticket selection dialog
        const ticketOptions = tickets.map((ticket, index) => 
            `${index + 1}. ${ticket.name || ticket.id}`
        ).join('\n');
        
        const selection = await appPrompt(
            `Select tickets (comma-separated numbers):\n\n${ticketOptions}\n\nExample: 1,2,3`,
            '',
            { title: 'Select tickets' }
        );
        
        if (selection) {
            const selectedIndices = selection.split(',').map(s => parseInt(s.trim()) - 1).filter(i => !isNaN(i) && i >= 0 && i < tickets.length);
            
            if (selectedIndices.length > 0) {
                // Combine ticket polygons into one geometry
                const selectedTickets = selectedIndices.map(i => tickets[i]);
                const combinedGeometry = combineTicketPolygons(selectedTickets);
                
                if (combinedGeometry) {
                    processDataQuery(combinedGeometry, layerId);
                } else {
                    await appAlert('Could not combine ticket polygons.');
                }
            } else {
                await appAlert('No valid tickets selected.');
            }
        }
        
        // Reopen data window if it was open
        if (wasOpen && window.openDataWindow) {
            setTimeout(() => {
                window.openDataWindow();
            }, 100);
        }
    }
}

// Legacy function for backward compatibility
function processDataQuery(geometry, layerId) {
    const windowModule = window.dataWindowModule;
    const currentView = windowModule?.currentDataView || 'layers';
    processDataQueryForTab(geometry, currentView);
}

// Export module
window.tableQueriesModule = {
    queryDataForLayer,
    queryAllDataInTab,
    processDataQueryForTab,
    queryAnnotationsInPolygon,
    queryDataLayersInPolygon,
    queryPhotosInPolygon,
    queryReportedEventsInPolygon,
    queryDocumentsInPolygon,
    addTempLayerToControl,
    removeTempLayerFromControl,
    addPhotoMarkerToLayerGroup,
    getPhotoLatLngFromRecord,
    showDocumentQueryResults,
    closeDocumentQueryResults,
    TICKET_PHOTO_SEARCH_BUFFER_FEET,
    TICKET_PHOTO_SEARCH_BUFFER_METERS,
    polygonBoundsContainsPointWithBuffer,
    isPointInOrNearTicketPolygon,
    isPointInPolygon,
    annotationIntersectsPolygon,
    documentIntersectsPolygon,
    combineTicketPolygons,
    startQueryPolygonDrawing,
    startDataHubFilterBoundsDrawing,
    selectTicketsForQuery,
    cleanupQueryByTicketMode,
    processDataQuery
};

// Make functions globally available for HTML onclick handlers
window.queryDataForLayer = queryDataForLayer;
window.queryAllDataInTab = queryAllDataInTab;
window.processDataQueryForTab = processDataQueryForTab;
window.queryAnnotationsInPolygon = queryAnnotationsInPolygon;
window.queryDataLayersInPolygon = queryDataLayersInPolygon;
window.queryPhotosInPolygon = queryPhotosInPolygon;
window.queryReportedEventsInPolygon = queryReportedEventsInPolygon;
window.queryDocumentsInPolygon = queryDocumentsInPolygon;
window.addTempLayerToControl = addTempLayerToControl;
window.showDocumentQueryResults = showDocumentQueryResults;
window.closeDocumentQueryResults = closeDocumentQueryResults;

