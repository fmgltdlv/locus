// Documents module - PDF document upload and management

// Stored documents array
let savedDocuments = [];

/** Skip redundant media list GET until Manage Data → Documents (per org). */
let manageDataDocumentsSyncedOrgId = null;

// Document location drawing state
let documentLocationMode = false;
let documentLocationTargetId = null;
let documentLocationPoints = [];
let documentLocationLayer = null;
let documentLocationClickHandler = null;

// Getter for documentLocationMode (will be added to module export)
function getDocumentLocationMode() {
    return documentLocationMode;
}

/** Append ?organizationId= so media routes use the UI org (org selector), not only JWT default — avoids 403 after switching org. */
function mediaFileUrlWithOrg(fileUrl, orgId) {
    if (!fileUrl || orgId == null || orgId === '') return fileUrl;
    try {
        const u = new URL(fileUrl, typeof window !== 'undefined' ? window.location.href : undefined);
        u.searchParams.set('organizationId', String(orgId));
        return u.toString();
    } catch (e) {
        const sep = fileUrl.includes('?') ? '&' : '?';
        return `${fileUrl}${sep}organizationId=${encodeURIComponent(String(orgId))}`;
    }
}

// Helper: resolve current org ID (do not name getCurrentOrgId or we overwrite global and cause recursion)
function resolveCurrentOrgId() {
    if (typeof window.getCurrentOrgId === 'function') {
        return window.getCurrentOrgId() || null;
    }
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        return user.organizationId || user.default_organization_id || null;
    }
    return null;
}

// Load saved documents from localStorage (filtered by organization)
function loadSavedDocuments() {
    const currentOrgId = resolveCurrentOrgId();
    
    try {
        const stored = localStorage.getItem('savedDocuments');
        if (stored) {
            const allDocuments = JSON.parse(stored);
            // Filter by current organization
            savedDocuments = allDocuments.filter(doc => doc.organizationId === currentOrgId);
        }
    } catch (error) {
        console.error('Error loading saved documents:', error);
        savedDocuments = [];
    }
}

// Load documents from server
async function loadDocumentsFromServer() {
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        return;
    }
    
    try {
        const currentOrgId = resolveCurrentOrgId();
        const url = currentOrgId
            ? `${window.authModule.API_BASE}/data/media?type=document&organizationId=${currentOrgId}`
            : `${window.authModule.API_BASE}/data/media?type=document`;
        const response = await fetch(url, {
            headers: (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to load documents: ${response.statusText}`);
        }
        
        const files = await response.json();
        
        // Get base URL for file URLs
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);
        
        // Convert server files to document format.
        // Always build /api/data/media/{id}/file (list may omit `url`; photos do the same).
        const serverDocuments = files.map(file => {
            const relativeUrl = file.url || (file.id != null ? `/api/data/media/${file.id}/file` : null);
            return {
                id: file.id.toString(),
                serverId: file.id,
                fileName: file.fileName,
                originalFileName: file.metadata?.originalFileName || file.fileName,
                fileUrl: relativeUrl ? mediaFileUrlWithOrg(`${baseUrl}${relativeUrl}`, currentOrgId) : null,
                fileSize: file.fileSize,
                geometry: file.metadata?.geometry || null,
                createdAt: file.createdAt,
                uploadedBy: file.uploadedBy != null && file.uploadedBy !== '' ? String(file.uploadedBy) : '',
                organizationId: currentOrgId
            };
        });
        
        // Merge with existing documents (prioritize server documents)
        // Remove documents that exist on server (by serverId)
        const existingServerIds = new Set(serverDocuments.map(doc => doc.serverId));
        savedDocuments = savedDocuments.filter(doc => !doc.serverId || !existingServerIds.has(doc.serverId));
        
        // Add server documents
        savedDocuments = savedDocuments.concat(serverDocuments);
        
        // Sort by creation date (newest first)
        savedDocuments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        // Save merged documents
        saveDocuments();
        
        // Refresh data window if open
        if (window.refreshDataWindow) {
            window.refreshDataWindow();
        }
    } catch (error) {
        console.error('Error loading documents from server:', error);
        // Don't show alert - just log error, fall back to localStorage
    }
}

function invalidateManageDataDocumentsSync() {
    manageDataDocumentsSyncedOrgId = null;
}

async function ensureManageDataDocumentsLoaded() {
    loadSavedDocuments();
    const currentOrgId = resolveCurrentOrgId();
    if (!currentOrgId || !window.authModule || !window.authModule.isAuthenticated()) return;
    if (manageDataDocumentsSyncedOrgId === currentOrgId) return;
    await loadDocumentsFromServer();
    manageDataDocumentsSyncedOrgId = currentOrgId;
    if (typeof renderAllDocumentLocations === 'function') {
        setTimeout(() => renderAllDocumentLocations(), 0);
    }
}

// Save documents to localStorage (merge with other orgs' data)
function saveDocuments() {
    try {
        const currentOrgId = resolveCurrentOrgId();
        // Load all documents
        const stored = localStorage.getItem('savedDocuments');
        let allDocuments = stored ? JSON.parse(stored) : [];
        
        // Remove current org's documents and add updated ones
        allDocuments = allDocuments.filter(doc => doc.organizationId !== currentOrgId);
        // Add current org's documents with orgId
        const documentsWithOrgId = savedDocuments.map(doc => ({
            ...doc,
            organizationId: doc.organizationId || currentOrgId // Ensure orgId is set
        }));
        allDocuments = allDocuments.concat(documentsWithOrgId);
        
        localStorage.setItem('savedDocuments', JSON.stringify(allDocuments));
    } catch (error) {
        console.error('Error saving documents:', error);
    }
}

// Initialize document upload
function initDocumentUpload() {
    // Cancel any active drawing or measuring
    if (window.drawingModule && window.drawingModule.currentDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.photoUploadMode && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    
    // PDF, images, and zip (unpacked; images go to photos, PDFs stay documents)
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.heic,.zip';
    input.multiple = true;
    
    input.onchange = function(event) {
        const files = event.target.files;
        if (files && files.length > 0) {
            if (typeof window.routeSelectedMapFiles === 'function') {
                void window.routeSelectedMapFiles(Array.from(files));
                return;
            }
            Array.from(files).forEach(file => {
                uploadDocument(file);
            });
        }
    };
    
    input.click();
}

// Upload a document (PDF or image). Images (jpg/jpeg/heic) get GPS from EXIF and store as geometry.
async function uploadDocument(file) {
    const isPdf = file.type && file.type.includes('pdf');
    const isImage = file.type && file.type.startsWith('image/');
    const imageExt = /\.(jpe?g|heic)$/i.test(file.name || '');
    if (!isPdf && !isImage && !imageExt) {
        void appAlert('Please upload a PDF or an image (.jpg, .jpeg, .heic).');
        return;
    }
    
    // Check file size (10 MB limit)
    const maxSize = 10 * 1024 * 1024; // 10 MB
    if (file.size > maxSize) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
        void appAlert(`File size (${fileSizeMB} MB) exceeds the 10 MB limit. Please use a smaller file.`);
        return;
    }
    
    // Check authentication
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        void appAlert('You must be logged in to upload documents.');
        return;
    }
    
    // For images: try to get GPS from EXIF (document will get geometry)
    let geometry = null;
    if (isImage || imageExt) {
        const gps = window.photosModule && window.photosModule.getGpsFromImageFile
            ? await window.photosModule.getGpsFromImageFile(file)
            : null;
        if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lng)) {
            geometry = { type: 'Point', coordinates: [gps.lng, gps.lat] }; // GeoJSON: [lng, lat]
        }
    }

    if (window.mapUploadStatusModule && window.mapUploadStatusModule.startDocumentUpload) {
        window.mapUploadStatusModule.startDocumentUpload(file);
    }
    
    try {
        // Create FormData for file upload
        const formData = new FormData();
        formData.append('file', file);
        formData.append('fileType', 'document');
        const currentOrgId = resolveCurrentOrgId();
        if (currentOrgId) formData.append('organizationId', String(currentOrgId));
        
        // Include metadata (originalFileName and geometry if we have GPS from image)
        const metadata = {
            originalFileName: file.name
        };
        if (geometry) metadata.geometry = geometry;
        formData.append('metadata', JSON.stringify(metadata));
        
        // Upload to backend
        const response = await fetch(`${window.authModule.API_BASE}/data/media`, {
            method: 'POST',
            headers: (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') },
            body: formData
        });
        
        if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        const result = await response.json();
        
        // Get the file URL from backend
        const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia)
            ? window.authModule.getApiBaseForMedia()
            : (window.API_BASE_URL || window.location.origin);
        // Backend returns url as "/api/data/media/:id/file", prepend base URL
        const fileUrl = result.url ? mediaFileUrlWithOrg(`${baseUrl}${result.url}`, currentOrgId) : null;
        
        if (!fileUrl) {
            throw new Error('Failed to get file URL from backend');
        }
        
        // Create document data with server URL and geometry (if image had GPS)
        const documentData = {
            id: result.id.toString(), // Use server ID
            serverId: result.id, // Store server ID separately
            fileName: file.name,
            originalFileName: file.name,
            fileUrl: fileUrl, // Server URL instead of base64
            fileSize: file.size,
            geometry: geometry, // Point from EXIF GPS if image had location
            createdAt: result.createdAt || new Date().toISOString(),
            uploadedBy: result.uploadedBy != null && result.uploadedBy !== '' ? String(result.uploadedBy) : '',
            organizationId: currentOrgId
        };
        
        savedDocuments.push(documentData);
        saveDocuments();
        
        // Refresh data window if open
        if (window.refreshDataWindow) {
            window.refreshDataWindow();
        }

        if (window.mapUploadStatusModule && window.mapUploadStatusModule.finishDocumentUpload) {
            window.mapUploadStatusModule.finishDocumentUpload(true);
        }
    } catch (error) {
        console.error('Error uploading document to backend:', error);
        if (window.mapUploadStatusModule && window.mapUploadStatusModule.finishDocumentUpload) {
            window.mapUploadStatusModule.finishDocumentUpload(false);
        }
        if (typeof showPhotoUploadError === 'function') {
            showPhotoUploadError(error.message || 'Document upload failed');
        } else {
            void appAlert(`Error uploading document: ${error.message}`);
        }
    }
}

// Delete a document (from Data tab) - deletes on server when doc has serverId, then removes locally
async function deleteDocument(documentId) {
    const index = savedDocuments.findIndex(doc => doc.id === documentId);
    if (index < 0) return;
    
    const doc = savedDocuments[index];
    
    // Delete on server if this document was loaded from server (has serverId)
    if (doc.serverId && window.authModule && window.authModule.apiRequest) {
        try {
            const currentOrgId = resolveCurrentOrgId();
            const url = currentOrgId
                ? `${window.authModule.API_BASE}/data/media/${doc.serverId}?organizationId=${currentOrgId}`
                : `${window.authModule.API_BASE}/data/media/${doc.serverId}`;
            await window.authModule.apiRequest(url, { method: 'DELETE' });
        } catch (err) {
            console.error('Error deleting document from server:', err);
            void appAlert('Document was removed from this device but could not be deleted from the server: ' + (err.message || err));
        }
    }
    
    savedDocuments.splice(index, 1);
    saveDocuments();
    
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}

// Get document by ID
function getDocument(documentId) {
    return savedDocuments.find(doc => doc.id === documentId);
}

// Rename a document
function renameDocument(documentId, newName) {
    const document = savedDocuments.find(doc => doc.id === documentId);
    if (document) {
        if (!document.originalFileName) {
            document.originalFileName = document.fileName || newName;
        }
        document.fileName = newName.trim();
        saveDocuments();
        
        // Refresh data window if open
        if (window.refreshDataWindow) {
            window.refreshDataWindow();
        }
    }
}

// Start document location drawing mode
function startDocumentLocationDrawing(documentId) {
    const map = window.map;
    if (!map) {
        void appAlert('Map not available');
        return;
    }
    
    // Hide data window if open and save current view
    const dataWindow = document.getElementById('dataWindow');
    const wasDataWindowOpen = dataWindow && dataWindow.classList.contains('show');
    const currentView = wasDataWindowOpen && window.dataWindowModule ? window.dataWindowModule.currentDataView : 'documents';
    if (wasDataWindowOpen) {
        dataWindow.classList.remove('show');
    }
    window.documentLocationDataWindowWasOpen = wasDataWindowOpen;
    window.documentLocationDataWindowView = currentView;
    
    // Cancel any other active modes
    if (window.drawingModule && window.drawingModule.currentDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.cancelPhotoLocationTag) {
        window.photosModule.cancelPhotoLocationTag();
    }
    if (window.photosModule && window.photosModule.photoUploadMode && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    
    // Set up location drawing mode
    documentLocationMode = true;
    documentLocationTargetId = documentId;
    documentLocationPoints = [];
    if (window.ticketsModule?.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
    
    // Clear any existing location layer
    if (documentLocationLayer && map.hasLayer(documentLocationLayer)) {
        map.removeLayer(documentLocationLayer);
    }
    documentLocationLayer = L.layerGroup().addTo(map);
    
    // Set cursor
    map.getContainer().style.cursor = 'crosshair';
    
    // Add click handler
    documentLocationClickHandler = function(e) {
        L.DomEvent.stopPropagation(e);
        
        const point = e.latlng;
        documentLocationPoints.push(point);
        
        // Clear and redraw
        documentLocationLayer.clearLayers();
        
        const lastIndex = documentLocationPoints.length - 1;
        
        if (documentLocationPoints.length === 1) {
            // First point - show as point with green checkmark (only on last point)
            const marker = L.marker(point, {
                icon: L.divIcon({
                    className: 'document-location-marker',
                    html: `
                        <div style="background-color: var(--app-success); width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: 14px; font-weight: bold; cursor: pointer;">
                            ✓
                        </div>
                    `,
                    iconSize: [24, 24],
                    iconAnchor: [12, 12]
                })
            });
            marker.on('click', function() {
                finishDocumentLocation();
            });
            documentLocationLayer.addLayer(marker);
        } else if (documentLocationPoints.length === 2) {
            // Second point - show as line
            const line = L.polyline(documentLocationPoints.map(p => [p.lat, p.lng]), {
                color: 'var(--app-accent)',
                weight: 3
            });
            documentLocationLayer.addLayer(line);
            
            // Add markers for both points - checkmark on last point
            documentLocationPoints.forEach((p, index) => {
                const isLast = index === lastIndex;
                const marker = L.marker(p, {
                    icon: L.divIcon({
                        className: 'document-location-marker',
                        html: `
                            <div style="background-color: ${isLast ? 'var(--app-success)' : 'var(--app-accent)'}; width: ${isLast ? '24' : '16'}px; height: ${isLast ? '24' : '16'}px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${isLast ? '14' : '0'}px; font-weight: bold; cursor: ${isLast ? 'pointer' : 'default'};">
                                ${isLast ? '✓' : ''}
                            </div>
                        `,
                        iconSize: [isLast ? 24 : 16, isLast ? 24 : 16],
                        iconAnchor: [isLast ? 12 : 8, isLast ? 12 : 8]
                    })
                });
                if (isLast) {
                    marker.on('click', function() {
                        finishDocumentLocation();
                    });
                }
                documentLocationLayer.addLayer(marker);
            });
        } else {
            // Third+ point - show as polygon
            const polygon = L.polygon(documentLocationPoints.map(p => [p.lat, p.lng]), {
                color: 'var(--app-accent)',
                weight: 2,
                fillColor: 'var(--app-accent)',
                fillOpacity: 0.3
            });
            documentLocationLayer.addLayer(polygon);
            
            // Add markers for all points - checkmark on last point only
            documentLocationPoints.forEach((p, index) => {
                const isLast = index === lastIndex;
                const marker = L.marker(p, {
                    icon: L.divIcon({
                        className: 'document-location-marker',
                        html: `
                            <div style="background-color: ${isLast ? 'var(--app-success)' : 'var(--app-accent)'}; width: ${isLast ? '24' : '12'}px; height: ${isLast ? '24' : '12'}px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${isLast ? '14' : '0'}px; font-weight: bold; cursor: ${isLast ? 'pointer' : 'default'};">
                                ${isLast ? '✓' : ''}
                            </div>
                        `,
                        iconSize: [isLast ? 24 : 12, isLast ? 24 : 12],
                        iconAnchor: [isLast ? 12 : 6, isLast ? 12 : 6]
                    })
                });
                if (isLast) {
                    marker.on('click', function() {
                        finishDocumentLocation();
                    });
                }
                documentLocationLayer.addLayer(marker);
            });
        }
    };
    
    map.on('click', documentLocationClickHandler);
    
    // Show initial instruction only
    void appAlert('Click on the map to set the document location. First click creates a point, second creates a line, third starts a polygon. Click the checkmark on the last point to finish.');
}

// Show finish button for document location (desktop fallback when toolbar finish control is unavailable)
function showDocumentLocationFinishButton() {
    if (typeof window.isMapToolsMobileLayout === 'function' && window.isMapToolsMobileLayout()) {
        return;
    }
    const map = window.map;
    if (map) {
        const finishControl = L.control({ position: 'topright' });
        finishControl.onAdd = function() {
            const div = L.DomUtil.create('div', 'document-location-finish');
            div.innerHTML = `
                    <button id="finishDocumentLocation" style="background: var(--app-success); color: var(--app-text-inverse); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                        ✓ Finish Location
                    </button>
                `;
            L.DomEvent.disableClickPropagation(div);
            div.querySelector('#finishDocumentLocation').onclick = function() {
                finishDocumentLocation();
            };
            return div;
        };
        finishControl.addTo(map);
        window.documentLocationFinishControl = finishControl;
    }
}

// Finish document location drawing
async function finishDocumentLocation() {
    const map = window.map;
    if (!map || !documentLocationMode || !documentLocationTargetId) return;
    
    if (documentLocationPoints.length === 0) {
        void appAlert('No location points set.');
        cancelDocumentLocationDrawing();
        return;
    }
    
    // Build geometry based on number of points
    let geometry = null;
    
    if (documentLocationPoints.length === 1) {
        // Point
        geometry = {
            type: 'Point',
            coordinates: [documentLocationPoints[0].lng, documentLocationPoints[0].lat]
        };
    } else if (documentLocationPoints.length === 2) {
        // Line
        geometry = {
            type: 'LineString',
            coordinates: documentLocationPoints.map(p => [p.lng, p.lat])
        };
    } else {
        // Polygon (close the ring)
        const coords = documentLocationPoints.map(p => [p.lng, p.lat]);
        coords.push(coords[0]); // Close the polygon
        geometry = {
            type: 'Polygon',
            coordinates: [coords]
        };
    }
    
    const document = savedDocuments.find(doc => doc.id === documentLocationTargetId);
    if (!document) {
        void appAlert('Document not found. Location was not saved.');
        cancelDocumentLocationDrawing();
        return;
    }

    const mediaId = document.serverId != null ? document.serverId : document.id;
    try {
        await patchDocumentGeometryOnServer(mediaId, geometry);
    } catch (err) {
        console.error('Error saving document location:', err);
        await appAlert(
            'Document location could not be saved to the server: ' + (err.message || err)
        );
        return;
    }

    document.geometry = geometry;
    saveDocuments();

    // Don't render document location on map - geometry is just a saved attribute
    // renderDocumentLocation(document); // Removed - geometry should not persist on map

    // Capture reopen flags; clear before cancel so it does not also reopen the hub.
    const wasDataWindowOpen = window.documentLocationDataWindowWasOpen || false;
    const viewToRestore = window.documentLocationDataWindowView || 'documents';
    window.documentLocationDataWindowWasOpen = false;
    window.documentLocationDataWindowView = null;

    cancelDocumentLocationDrawing();

    if (wasDataWindowOpen && window.openDataWindow) {
        setTimeout(() => {
            window.openDataWindow(viewToRestore);
        }, 100);
    } else if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }

    await appAlert('Document location saved successfully!');
}

/**
 * Persist document GeoJSON location on the media file (metadata.geometry).
 * @param {number|string} mediaId
 * @param {object|null} geometry GeoJSON or null to clear
 */
async function patchDocumentGeometryOnServer(mediaId, geometry) {
    if (mediaId == null || mediaId === '') {
        throw new Error('Missing document id');
    }
    if (!window.authModule || !window.authModule.isAuthenticated() || !window.authModule.apiRequest) {
        throw new Error('Not authenticated');
    }
    const currentOrgId = resolveCurrentOrgId();
    const url = currentOrgId
        ? `${window.authModule.API_BASE}/data/media/${mediaId}?organizationId=${encodeURIComponent(String(currentOrgId))}`
        : `${window.authModule.API_BASE}/data/media/${mediaId}`;
    return window.authModule.apiRequest(url, {
        method: 'PATCH',
        body: JSON.stringify({ geometry }),
    });
}

// Cancel document location drawing
function cancelDocumentLocationDrawing() {
    const map = window.map;
    
    documentLocationMode = false;
    documentLocationTargetId = null;
    documentLocationPoints = [];
    if (window.ticketsModule?.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
    
    // Reopen data window if it was open before, restoring to last tab
    const wasDataWindowOpen = window.documentLocationDataWindowWasOpen || false;
    const viewToRestore = window.documentLocationDataWindowView || 'documents';
    if (wasDataWindowOpen && window.openDataWindow) {
        setTimeout(() => {
            window.openDataWindow(viewToRestore);
        }, 100);
    }
    window.documentLocationDataWindowWasOpen = false;
    window.documentLocationDataWindowView = null;
    
    if (map) {
        if (documentLocationClickHandler) {
            map.off('click', documentLocationClickHandler);
            documentLocationClickHandler = null;
        }
        
        if (documentLocationLayer && map.hasLayer(documentLocationLayer)) {
            map.removeLayer(documentLocationLayer);
            documentLocationLayer = null;
        }
        
        map.getContainer().style.cursor = '';
        
        // Remove temporary finish control
        if (window.documentLocationFinishControl) {
            map.removeControl(window.documentLocationFinishControl);
            window.documentLocationFinishControl = null;
        }
    }
}

// Render document location on map
function renderDocumentLocation(document) {
    if (!document.geometry) return;
    
    const map = window.map;
    if (!map) return;
    
    // Remove existing location if any
    if (document.locationLayer && map.hasLayer(document.locationLayer)) {
        map.removeLayer(document.locationLayer);
    }
    
    let layer = null;
    
    if (document.geometry.type === 'Point') {
        const [lng, lat] = document.geometry.coordinates;
        layer = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'document-location-marker',
                html: `
                    <div style="background-color: var(--app-accent); width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: 12px;">
                        📄
                    </div>
                `,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        });
    } else if (document.geometry.type === 'LineString') {
        const coords = document.geometry.coordinates.map(c => [c[1], c[0]]);
        layer = L.polyline(coords, {
            color: 'var(--app-accent)',
            weight: 3
        });
    } else if (document.geometry.type === 'Polygon') {
        const coords = document.geometry.coordinates[0].map(c => [c[1], c[0]]);
        layer = L.polygon(coords, {
            color: 'var(--app-accent)',
            weight: 2,
            fillColor: 'var(--app-accent)',
            fillOpacity: 0.3
        });
    }
    
    if (layer) {
        const buildMapPopupGpsRow = typeof window.buildMapPopupGpsRow === 'function' ? window.buildMapPopupGpsRow : function () { return ''; };
        let gpsRow = '';
        if (document.geometry.type === 'Point') {
            const [lng, lat] = document.geometry.coordinates;
            gpsRow = buildMapPopupGpsRow(lat, lng);
        }
        // Add popup
        layer.bindPopup(`
            <div class="map-leaflet-popup">
                <div class="map-leaflet-popup__title">${document.fileName}</div>
                <div class="map-leaflet-popup__subtitle">Document Location</div>
                ${gpsRow}
            </div>
        `);
        
        layer.addTo(map);
        document.locationLayer = layer;
    }
}

// Clear all document location layers from map (e.g. when switching organization)
function clearDocumentLocationsFromMap() {
    const map = window.map;
    if (!map) return;
    savedDocuments.forEach(doc => {
        if (doc.locationLayer) {
            if (map.hasLayer(doc.locationLayer)) {
                map.removeLayer(doc.locationLayer);
            }
            doc.locationLayer = null;
        }
    });
}

// Render all document locations
function renderAllDocumentLocations() {
    savedDocuments.forEach(doc => {
        if (doc.geometry) {
            // Don't render document location on map - geometry is just a saved attribute
            // renderDocumentLocation(doc);
        }
    });
}

// Remove document location
async function removeDocumentLocation(documentId) {
    const document = savedDocuments.find(doc => doc.id === documentId);
    if (!document) {
        console.error('Document not found:', documentId);
        return;
    }

    const mediaId = document.serverId != null ? document.serverId : document.id;
    try {
        await patchDocumentGeometryOnServer(mediaId, null);
    } catch (err) {
        console.error('Error removing document location:', err);
        await appAlert(
            'Document location could not be removed on the server: ' + (err.message || err)
        );
        return;
    }

    document.geometry = null;

    if (document.locationLayer) {
        const map = window.map;
        if (map && map.hasLayer(document.locationLayer)) {
            map.removeLayer(document.locationLayer);
        }
        document.locationLayer = null;
    }

    saveDocuments();

    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    } else if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
}

// Initialize - load saved documents
loadSavedDocuments();

// Export for use in other modules
window.documentsModule = {
    mediaFileUrlWithOrg,
    get savedDocuments() { return savedDocuments; },
    get documentLocationMode() { return documentLocationMode; },
    loadSavedDocuments,
    loadDocumentsFromServer,
    invalidateManageDataDocumentsSync,
    ensureManageDataDocumentsLoaded,
    saveDocuments,
    initDocumentUpload,
    uploadDocument,
    deleteDocument,
    getDocument,
    renameDocument,
    startDocumentLocationDrawing,
    finishDocumentLocation,
    cancelDocumentLocationDrawing,
    renderDocumentLocation,
    renderAllDocumentLocations,
    removeDocumentLocation,
    clearDocumentLocationsFromMap
};

// Make functions globally available for HTML onclick handlers
window.initDocumentUpload = initDocumentUpload;
window.startDocumentLocationDrawing = startDocumentLocationDrawing;
window.finishDocumentLocation = finishDocumentLocation;
window.removeDocumentLocation = removeDocumentLocation;

