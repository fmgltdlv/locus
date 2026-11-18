/**
 * tableDocumentActions.js — split from tableActions.js (Phase F4).
 * Document viewer, annotate mode, fullscreen, delete.
 */
// View document
async function viewDocument(documentId) {
    const doc = window.documentsModule?.getDocument(documentId);
    if (!doc) {
        console.error('Document not found:', documentId);
        await appAlert('Document not found. Please try again.');
        return;
    }
    
    // Get modal elements
    const modal = document.getElementById('documentViewerModal');
    const iframe = document.getElementById('documentViewerIframe');
    const title = document.getElementById('documentViewerTitle');
    
    if (!modal || !iframe || !title) {
        console.error('Document viewer modal not found', { modal: !!modal, iframe: !!iframe, title: !!title });
        await appAlert('Document viewer not available. Please refresh the page.');
        return;
    }
    
    // Set document title
    title.textContent = doc.fileName || 'Document Viewer';
    
    // Check if fileUrl (server URL) or fileData (legacy base64) exists
    if (!doc.fileUrl && !doc.fileData) {
        console.error('Document fileUrl and fileData are both missing:', doc);
        await appAlert('Document data not found. Please try uploading the document again.');
        return;
    }
    
    // Clear iframe first to ensure it reloads
    iframe.src = '';
    
    // Init PDF editor module for View/Annotate and save-on-close
    if (window.pdfEditorModule) {
        window.pdfEditorModule.init(doc, { initialMode: 'view' });
        window.pdfEditorModule.setMode('view');
    }
    setDocumentViewerModeUI('view');
    
    // Show modal first - make sure it's visible
    modal.style.display = 'flex';
    modal.style.zIndex = '70000'; // Ensure it's above data window and query results modal
    document.body.style.overflow = 'hidden';
    
    // Force modal to be visible (in case CSS is overriding)
    modal.classList.add('show');
    
    // Small delay to ensure iframe is cleared before loading new document
    setTimeout(async () => {
        try {
            // Prefer fileUrl (server URL) over fileData (legacy base64)
            if (doc.fileUrl) {
                try {
                    const authToken = localStorage.getItem('authToken');
                    const viewerOrgId = typeof window.getCurrentOrgId === 'function'
                        ? window.getCurrentOrgId()
                        : (window.authModule && window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
                    const fetchUrl = (window.documentsModule && window.documentsModule.mediaFileUrlWithOrg)
                        ? window.documentsModule.mediaFileUrlWithOrg(doc.fileUrl, viewerOrgId)
                        : doc.fileUrl;
                    const response = await fetch(fetchUrl, {
                        headers: {
                            'Authorization': `Bearer ${authToken}`
                        }
                    });
                    
                    if (!response.ok) {
                        throw new Error(`Failed to fetch document: ${response.statusText} (${response.status})`);
                    }
                    
                    const blob = await response.blob();
                    // Ensure PDFs use application/pdf so the iframe displays inline instead of downloading
                    let blobToUse = blob;
                    const isPdf = doc.fileName && doc.fileName.toLowerCase().endsWith('.pdf');
                    if (isPdf && blob.type !== 'application/pdf') {
                        blobToUse = new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
                    }
                    const blobUrl = URL.createObjectURL(blobToUse);
                    
                    if (documentViewerBlobUrl) {
                        URL.revokeObjectURL(documentViewerBlobUrl);
                    }
                    documentViewerBlobUrl = blobUrl;
                    
                    iframe.src = blobUrl;
                    
                    iframe.onload = function() { };
                    
                    iframe.onerror = function() {
                        console.error('Error loading PDF in iframe');
                        appAlert('Error loading document. Please try again.');
                    };
                } catch (fetchError) {
                    console.error('Error fetching document:', fetchError);
                    await appAlert('Error loading document. Please check the console for details.');
                }
            } else if (doc.fileData) {
                // Legacy: Convert base64 data URL to blob URL for better browser compatibility
                // fileData is a base64 data URL (e.g., "data:application/pdf;base64,...")
                if (doc.fileData.startsWith('data:')) {
                    // Create a blob from the data URL
                    const byteString = atob(doc.fileData.split(',')[1]);
                    const mimeString = doc.fileData.split(',')[0].split(':')[1].split(';')[0];
                    const ab = new ArrayBuffer(byteString.length);
                    const ia = new Uint8Array(ab);
                    for (let i = 0; i < byteString.length; i++) {
                        ia[i] = byteString.charCodeAt(i);
                    }
                    const blob = new Blob([ab], { type: mimeString || 'application/pdf' });
                    const blobUrl = URL.createObjectURL(blob);
                    
                    // Clean up previous blob URL if exists
                    if (documentViewerBlobUrl) {
                        URL.revokeObjectURL(documentViewerBlobUrl);
                    }
                    documentViewerBlobUrl = blobUrl;
                    
                    // Set iframe src to blob URL
                    iframe.src = blobUrl;
                    
                    // Clean up blob URL when iframe loads or modal closes
                    iframe.onload = function() { };
                    
                    iframe.onerror = function() {
                        console.error('Error loading PDF in iframe');
                        appAlert('Error loading document. Please try again.');
                    };
                } else {
                    // Fallback: use data URL directly
                    iframe.src = doc.fileData;
                }
            }
        } catch (error) {
            console.error('Error processing document data:', error);
            await appAlert('Error loading document. Please try again.');
        }
    }, 100);
}

// Store blob URLs to clean them up when closing
let documentViewerBlobUrl = null;

// Set document viewer mode (View or Annotate) and update toolbar UI
function setDocumentViewerMode(mode) {
    if (window.pdfEditorModule) {
        window.pdfEditorModule.setMode(mode);
    }
    setDocumentViewerModeUI(mode);
}

function setDocumentViewerModeUI(mode) {
    const viewBtn = document.getElementById('documentViewModeBtn');
    const annotateBtn = document.getElementById('documentAnnotateModeBtn');
    const annotateTools = document.getElementById('documentAnnotateTools');
    const contentArea = document.getElementById('documentViewerContent');
    const editorEl = document.getElementById('documentEditorContent');
    const iframe = document.getElementById('documentViewerIframe');
    if (viewBtn) viewBtn.style.background = mode === 'view' ? 'var(--app-accent)' : 'var(--app-bg-tool)';
    if (annotateBtn) annotateBtn.style.background = mode === 'annotate' ? 'var(--app-accent)' : 'var(--app-bg-tool)';
    if (annotateTools) annotateTools.style.display = mode === 'annotate' ? 'flex' : 'none';
    if (contentArea) contentArea.style.display = mode === 'view' ? 'block' : 'none';
    if (editorEl) editorEl.style.display = mode === 'annotate' ? 'block' : 'none';
    if (iframe) iframe.style.display = mode === 'view' ? 'block' : 'none';
    if (mode === 'annotate' && window.pdfEditorModule && window.pdfEditorModule.updateToolButtons) {
        window.pdfEditorModule.updateToolButtons();
    }
}

// Close document viewer
function closeDocumentViewer() {
    (async function () {
        const modal = document.getElementById('documentViewerModal');
        const iframe = document.getElementById('documentViewerIframe');
        
        if (window.pdfEditorModule && window.pdfEditorModule.isDirty()) {
            const save = await appConfirm('Save annotations before closing?');
            await window.pdfEditorModule.close(save);
        } else if (window.pdfEditorModule) {
            await window.pdfEditorModule.close(false);
        }
        
        setDocumentViewerModeUI('view');
        
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
        
        if (iframe) {
            if (documentViewerBlobUrl) {
                URL.revokeObjectURL(documentViewerBlobUrl);
                documentViewerBlobUrl = null;
            }
            iframe.src = '';
            iframe.onload = null;
            iframe.onerror = null;
        }
        
        const editorEl = document.getElementById('documentEditorContent');
        if (editorEl) editorEl.innerHTML = '';
    })();
}

// Add click handler to document viewer modal overlay to close on outside click
document.addEventListener('DOMContentLoaded', function() {
    const documentViewerModal = document.getElementById('documentViewerModal');
    if (documentViewerModal) {
        documentViewerModal.addEventListener('click', function(e) {
            // Close if clicking on the overlay (not the content)
            if (e.target === documentViewerModal) {
                closeDocumentViewer();
            }
        });
    }
    initDocumentFullscreenListener();
});

// Toggle document fullscreen
function updateDocumentFullscreenButtonText() {
    const btn = document.getElementById('documentFullscreenBtn');
    if (!btn) return;
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    btn.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
}

function toggleDocumentFullscreen() {
    const modal = document.getElementById('documentViewerModal');
    if (!modal) return;
    
    if (!document.fullscreenElement && !document.webkitFullscreenElement && !document.mozFullScreenElement && !document.msFullscreenElement) {
        // Enter fullscreen
        const requestFs = modal.requestFullscreen || modal.webkitRequestFullscreen || modal.mozRequestFullScreen || modal.msRequestFullscreen;
        if (requestFs) {
            const p = requestFs.call(modal);
            if (p && typeof p.then === 'function') {
                p.then(updateDocumentFullscreenButtonText).catch(function () {});
            } else {
                updateDocumentFullscreenButtonText();
            }
        }
    } else {
        // Exit fullscreen
        const exitFs = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (exitFs) {
            const p = exitFs.call(document);
            if (p && typeof p.then === 'function') {
                p.then(updateDocumentFullscreenButtonText).catch(function () {});
            } else {
                updateDocumentFullscreenButtonText();
            }
        }
    }
}

function initDocumentFullscreenListener() {
    document.addEventListener('fullscreenchange', updateDocumentFullscreenButtonText);
    document.addEventListener('webkitfullscreenchange', updateDocumentFullscreenButtonText);
    document.addEventListener('mozfullscreenchange', updateDocumentFullscreenButtonText);
    document.addEventListener('MSFullscreenChange', updateDocumentFullscreenButtonText);
}

// Delete document
async function deleteDocument(documentId) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.guardDeleteOrgData()) {
        return;
    }
    const windowModule = window.dataWindowModule;
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    
    if (!(await appConfirm('Are you sure you want to delete this document?'))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    if (window.documentsModule && window.documentsModule.deleteDocument) {
        window.documentsModule.deleteDocument(documentId);
    }
    
    if (window.dataSelectionModule) {
        window.dataSelectionModule.selectedDataIds.delete(documentId);
        window.dataSelectionModule.updateBulkActionsVisibility();
    }
    
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    
    // Reset flag after a short delay
    setTimeout(() => {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
    }, 100);
}
