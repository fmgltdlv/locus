// PDF Editor module - view and annotate PDFs with PDF.js
// Depends: PDF.js (pdfjsLib) loaded globally; authModule for API base and token

(function () {
    'use strict';

    let currentDoc = null;
    let currentMode = 'view'; // 'view' | 'annotate'
    let pdfDoc = null;
    let annotations = [];
    let dirty = false;
    let scale = 1.2;
    let pageContainers = [];
    let currentTool = 'highlight'; // 'highlight' | 'note' | 'eraser'
    let dragStart = null;
    let blobUrlForCleanup = null;

    function getMediaFileId() {
        if (!currentDoc) return null;
        const id = currentDoc.serverId != null ? currentDoc.serverId : currentDoc.id;
        return typeof id === 'number' ? id : parseInt(String(id), 10);
    }

    function getAuthHeaders() {
        return (window.authModule && window.authModule.getAuthHeaders) ? window.authModule.getAuthHeaders() : {};
    }

    async function fetchPdfBlob() {
        if (!currentDoc) return null;
        if (currentDoc.fileUrl) {
            const baseUrl = (window.authModule && window.authModule.getApiBaseForMedia) ? window.authModule.getApiBaseForMedia() : '';
            const url = currentDoc.fileUrl.indexOf('http') === 0 ? currentDoc.fileUrl : baseUrl + currentDoc.fileUrl;
            const viewerOrgId = typeof window.getCurrentOrgId === 'function'
                ? window.getCurrentOrgId()
                : (window.authModule && window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
            const urlWithOrg = (window.documentsModule && window.documentsModule.mediaFileUrlWithOrg)
                ? window.documentsModule.mediaFileUrlWithOrg(url, viewerOrgId)
                : url;
            const res = await fetch(urlWithOrg, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error('Failed to fetch PDF');
            return await res.blob();
        }
        if (currentDoc.fileData && currentDoc.fileData.startsWith('data:')) {
            const res = await fetch(currentDoc.fileData);
            return await res.blob();
        }
        return null;
    }

    async function loadAnnotations() {
        const mediaId = getMediaFileId();
        if (mediaId == null || !window.authModule || !window.authModule.isAuthenticated()) {
            annotations = [];
            return;
        }
        try {
            const apiBase = (window.authModule && window.authModule.API_BASE) || window.API_BASE;
            if (!apiBase) throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
            const url = apiBase + '/data/media/' + mediaId + '/annotations';
            const res = await fetch(url, { headers: getAuthHeaders() });
            const data = await res.json();
            annotations = Array.isArray(data.annotations) ? data.annotations : [];
        } catch (e) {
            annotations = [];
        }
    }

    async function saveAnnotations() {
        const mediaId = getMediaFileId();
        if (mediaId == null || !window.authModule || !window.authModule.isAuthenticated()) {
            if (typeof window.appAlert === 'function') await window.appAlert('You must be signed in to save annotations.');
            return;
        }
        try {
            const apiBase = (window.authModule && window.authModule.API_BASE) || window.API_BASE;
            if (!apiBase) throw new Error('API base is not configured. Set window.API_BASE_URL in config-override.js.');
            const url = apiBase + '/data/media/' + mediaId + '/annotations';
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                body: JSON.stringify({ annotations })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const msg = body.error || res.statusText || 'Failed to save annotations';
                if (typeof window.appAlert === 'function') await window.appAlert(msg);
                return;
            }
            dirty = false;
        } catch (e) {
            console.error('Failed to save annotations:', e);
            if (typeof window.appAlert === 'function') await window.appAlert('Failed to save annotations. Check your connection and try again.');
            throw e;
        }
    }

    function generateId() {
        return 'ann-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    }

    function addAnnotation(ann) {
        annotations.push(ann);
        dirty = true;
    }

    function removeAnnotation(id) {
        annotations = annotations.filter(a => a.id !== id);
        dirty = true;
    }

    let noteModalResolve = null;

    function requestNoteText() {
        return new Promise(function (resolve) {
            const modal = document.getElementById('documentNoteModal');
            const input = document.getElementById('documentNoteInput');
            const btnCancel = document.getElementById('documentNoteCancel');
            const btnSubmit = document.getElementById('documentNoteSubmit');
            const btnClose = document.getElementById('documentNoteModalClose');
            if (!modal || !input) {
                resolve(null);
                return;
            }
            noteModalResolve = resolve;
            input.value = '';
            modal.style.display = 'flex';
            input.focus();

            function finish(value) {
                if (noteModalResolve === null) return;
                modal.style.display = 'none';
                noteModalResolve(value);
                noteModalResolve = null;
                if (btnCancel) btnCancel.removeEventListener('click', onCancel);
                if (btnSubmit) btnSubmit.removeEventListener('click', onSubmit);
                if (btnClose) btnClose.removeEventListener('click', onCancel);
                if (input) input.removeEventListener('keydown', onKeydown);
                if (modal) modal.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onKeydown);
            }

            function onSubmit() {
                finish((input.value || '').trim() || 'Note');
            }
            function onCancel() {
                finish(null);
            }
            function onKeydown(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSubmit();
                }
            }
            function onOverlayClick(e) {
                if (e.target === modal) onCancel();
            }

            if (btnCancel) btnCancel.addEventListener('click', onCancel);
            if (btnSubmit) btnSubmit.addEventListener('click', onSubmit);
            if (btnClose) btnClose.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKeydown);
            modal.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKeydown);
        });
    }

    function getPdfLib() {
        return window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    }

    async function renderAnnotateMode(container) {
        if (!container) return;
        const pdfjsLib = getPdfLib();
        if (!pdfjsLib) {
            container.innerHTML = '<p style="padding: 1rem; color: var(--app-danger);">PDF.js not loaded. Add script tag for pdf.js and pdf.worker.js.</p>';
            return;
        }

        container.innerHTML = '<div class="pdf-editor-loading" style="padding: 2rem; text-align: center;">Loading PDF...</div>';
        let blob;
        try {
            blob = await fetchPdfBlob();
        } catch (e) {
            container.innerHTML = '<p style="padding: 1rem; color: var(--app-danger);">Failed to load PDF.</p>';
            return;
        }
        if (!blob) {
            container.innerHTML = '<p style="padding: 1rem; color: var(--app-danger);">Could not load document.</p>';
            return;
        }
        const isPdfByFilename = currentDoc.fileName && currentDoc.fileName.toLowerCase().endsWith('.pdf');
        if (!blob.type.includes('pdf') && !isPdfByFilename) {
            container.innerHTML = '<p style="padding: 1rem; color: var(--app-danger);">Document is not a PDF. Annotate mode is for PDFs only.</p>';
            return;
        }
        if (!blob.type.includes('pdf') && isPdfByFilename) {
            blob = new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
        }

        const arrayBuffer = await blob.arrayBuffer();
        try {
            pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        } catch (e) {
            container.innerHTML = '<p style="padding: 1rem; color: var(--app-danger);">Failed to parse PDF.</p>';
            return;
        }

        const numPages = pdfDoc.numPages;
        container.innerHTML = '';
        container.style.overflow = 'auto';
        container.style.padding = '8px';
        container.style.background = 'var(--app-border-muted)';

        pageContainers = [];
        for (let i = 1; i <= numPages; i++) {
            const pageWrapper = document.createElement('div');
            pageWrapper.className = 'pdf-page-wrapper';
            pageWrapper.style.position = 'relative';
            pageWrapper.style.marginBottom = '16px';
            pageWrapper.style.display = 'inline-block';
            pageWrapper.dataset.pageIndex = String(i - 1);

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const page = await pdfDoc.getPage(i);
            const viewport = page.getViewport({ scale });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            canvas.style.display = 'block';
            canvas.style.background = 'white';
            pageWrapper.appendChild(canvas);

            const overlay = document.createElement('div');
            overlay.className = 'pdf-annotation-overlay';
            overlay.style.position = 'absolute';
            overlay.style.left = '0';
            overlay.style.top = '0';
            overlay.style.width = viewport.width + 'px';
            overlay.style.height = viewport.height + 'px';
            overlay.style.pointerEvents = 'none';
            pageWrapper.appendChild(overlay);

            const interactiveLayer = document.createElement('div');
            interactiveLayer.className = 'pdf-annotation-interactive';
            interactiveLayer.style.position = 'absolute';
            interactiveLayer.style.left = '0';
            interactiveLayer.style.top = '0';
            interactiveLayer.style.width = viewport.width + 'px';
            interactiveLayer.style.height = viewport.height + 'px';
            interactiveLayer.style.cursor = currentTool === 'highlight' ? 'crosshair' : (currentTool === 'eraser' ? 'pointer' : 'text');
            pageWrapper.appendChild(interactiveLayer);

            await page.render({
                canvasContext: ctx,
                viewport: viewport
            }).promise;

            pageWrapper._viewport = viewport;
            pageWrapper._pageIndex = i - 1;
            pageContainers.push(pageWrapper);
            container.appendChild(pageWrapper);

            setupPageInteraction(interactiveLayer, pageWrapper, viewport);
        }

        renderAnnotationsOntoOverlays();
    }

    function renderAnnotationsOntoOverlays() {
        pageContainers.forEach(wrapper => {
            const overlay = wrapper.querySelector('.pdf-annotation-overlay');
            if (!overlay) return;
            overlay.innerHTML = '';
            overlay.style.pointerEvents = 'none';
            const pageIndex = wrapper._pageIndex;
            const vp = wrapper._viewport;
            const pageAnnotations = annotations.filter(a => a.pageIndex === pageIndex);
            pageAnnotations.forEach(ann => {
                if (ann.type === 'highlight' && ann.bbox) {
                    const [x, y, w, h] = ann.bbox;
                    const div = document.createElement('div');
                    div.className = 'pdf-ann-highlight';
                    div.style.position = 'absolute';
                    div.style.left = (x * vp.width) + 'px';
                    div.style.top = (y * vp.height) + 'px';
                    div.style.width = (w * vp.width) + 'px';
                    div.style.height = (h * vp.height) + 'px';
                    div.style.background = ann.color || 'rgba(255,235,0,0.4)';
                    div.style.pointerEvents = 'none';
                    overlay.appendChild(div);
                } else if (ann.type === 'note' && ann.bbox) {
                    const [x, y, w, h] = ann.bbox;
                    const div = document.createElement('div');
                    div.className = 'pdf-ann-note';
                    div.style.position = 'absolute';
                    div.style.left = (x * vp.width) + 'px';
                    div.style.top = (y * vp.height) + 'px';
                    div.style.width = Math.max(120, (w || 0.15) * vp.width) + 'px';
                    div.style.minHeight = Math.max(60, (h || 0.1) * vp.height) + 'px';
                    div.style.background = '#fef08a';
                    div.style.border = '1px solid #ca8a04';
                    div.style.borderRadius = '4px';
                    div.style.padding = '6px';
                    div.style.fontSize = '12px';
                    div.style.color = '#1c1917';
                    div.style.boxSizing = 'border-box';
                    div.style.pointerEvents = 'none';
                    div.textContent = ann.text || 'Note';
                    overlay.appendChild(div);
                }
            });
        });
    }

    function setupPageInteraction(interactiveLayer, pageWrapper, viewport) {
        const pageIndex = pageWrapper._pageIndex;

        interactiveLayer.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            const rect = interactiveLayer.getBoundingClientRect();
            const x = (e.clientX - rect.left) / viewport.width;
            const y = (e.clientY - rect.top) / viewport.height;
            if (currentTool === 'eraser') {
                const pageAnnotations = annotations.filter(a => a.pageIndex === pageIndex);
                for (let i = pageAnnotations.length - 1; i >= 0; i--) {
                    const ann = pageAnnotations[i];
                    if (!ann.bbox || ann.bbox.length < 4) continue;
                    let [x0, y0, w, h] = ann.bbox;
                    if (ann.type === 'note') {
                        w = Math.max(w || 0.15, 120 / viewport.width);
                        h = Math.max(h || 0.1, 60 / viewport.height);
                    }
                    if (x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h) {
                        removeAnnotation(ann.id);
                        renderAnnotationsOntoOverlays();
                        return;
                    }
                }
                return;
            }
            if (currentTool === 'highlight') {
                dragStart = { x, y, pageIndex };
            } else if (currentTool === 'note') {
                requestNoteText().then(function (text) {
                    if (text != null) {
                        addAnnotation({
                            id: generateId(),
                            pageIndex,
                            type: 'note',
                            bbox: [x, y, 0.15, 0.1],
                            text: text || 'Note',
                            color: '#fef08a'
                        });
                        renderAnnotationsOntoOverlays();
                    }
                });
            }
        });

        interactiveLayer.addEventListener('mousemove', function (e) {
            if (currentTool !== 'highlight' || !dragStart || dragStart.pageIndex !== pageIndex) return;
            e.preventDefault();
        });

        interactiveLayer.addEventListener('mouseup', function (e) {
            if (e.button !== 0 || !dragStart || dragStart.pageIndex !== pageIndex) return;
            const rect = interactiveLayer.getBoundingClientRect();
            const x = (e.clientX - rect.left) / viewport.width;
            const y = (e.clientY - rect.top) / viewport.height;
            const x0 = Math.min(dragStart.x, x);
            const y0 = Math.min(dragStart.y, y);
            const w = Math.abs(x - dragStart.x);
            const h = Math.abs(y - dragStart.y);
            if (w > 0.01 && h > 0.01) {
                addAnnotation({
                    id: generateId(),
                    pageIndex,
                    type: 'highlight',
                    bbox: [x0, y0, w, h],
                    color: 'rgba(255,235,0,0.4)'
                });
                renderAnnotationsOntoOverlays();
            }
            dragStart = null;
        });

        interactiveLayer.addEventListener('mouseleave', function () {
            dragStart = null;
        });
    }

    function setTool(tool) {
        currentTool = tool;
        pageContainers.forEach(wrapper => {
            const layer = wrapper.querySelector('.pdf-annotation-interactive');
            if (layer) {
                layer.style.cursor = tool === 'highlight' ? 'crosshair' : (tool === 'eraser' ? 'pointer' : 'text');
            }
        });
        updateToolButtons();
    }

    function getTool() {
        return currentTool;
    }

    function updateToolButtons() {
        const highlightBtn = document.getElementById('pdfToolHighlight');
        const noteBtn = document.getElementById('pdfToolNote');
        const eraserBtn = document.getElementById('pdfToolEraser');
        const activeBg = 'var(--app-accent)';
        const inactiveBg = 'var(--app-bg-tool)';
        if (highlightBtn) highlightBtn.style.background = currentTool === 'highlight' ? activeBg : inactiveBg;
        if (noteBtn) noteBtn.style.background = currentTool === 'note' ? activeBg : inactiveBg;
        if (eraserBtn) eraserBtn.style.background = currentTool === 'eraser' ? activeBg : inactiveBg;
    }

    function setScale(s) {
        scale = Math.max(0.5, Math.min(3, s));
        if (typeof window !== 'undefined') window._pdfEditorScale = scale;
        const container = document.getElementById('documentEditorContent');
        if (container && pdfDoc && currentMode === 'annotate') {
            renderAnnotateMode(container);
        }
    }

    function showViewMode(iframeEl, contentArea) {
        if (contentArea) {
            const editorEl = document.getElementById('documentEditorContent');
            if (editorEl) editorEl.style.display = 'none';
            if (contentArea) contentArea.style.display = 'block';
        }
        if (iframeEl) iframeEl.style.display = 'block';
    }

    function showAnnotateMode(contentArea) {
        const editorEl = document.getElementById('documentEditorContent');
        const iframeEl = document.getElementById('documentViewerIframe');
        if (iframeEl) iframeEl.style.display = 'none';
        if (contentArea) contentArea.style.display = 'none';
        if (editorEl) {
            editorEl.style.display = 'block';
            editorEl.style.flex = '1';
            editorEl.style.overflow = 'auto';
            loadAnnotations().then(() => renderAnnotateMode(editorEl));
        }
    }

    function init(doc, options) {
        if (blobUrlForCleanup) {
            URL.revokeObjectURL(blobUrlForCleanup);
            blobUrlForCleanup = null;
        }
        currentDoc = doc;
        currentMode = options.initialMode || 'view';
        annotations = [];
        dirty = false;
        pdfDoc = null;
        pageContainers = [];
        if (options.onModeChange) options.onModeChange(currentMode);
    }

    function setMode(mode, options) {
        currentMode = mode;
        const iframeEl = document.getElementById('documentViewerIframe');
        const contentArea = document.getElementById('documentViewerContent');
        const editorEl = document.getElementById('documentEditorContent');

        if (mode === 'view') {
            showViewMode(iframeEl, contentArea);
            if (editorEl) editorEl.style.display = 'none';
        } else {
            showAnnotateMode(contentArea);
        }
        if (options && options.onModeChange) options.onModeChange(mode);
    }

    async function close(saveBeforeClose) {
        if (saveBeforeClose && dirty && annotations.length > 0) {
            await saveAnnotations();
        }
        currentDoc = null;
        pdfDoc = null;
        pageContainers = [];
        annotations = [];
        dirty = false;
        if (blobUrlForCleanup) {
            URL.revokeObjectURL(blobUrlForCleanup);
            blobUrlForCleanup = null;
        }
    }

    function isDirty() {
        return dirty;
    }

    function getAnnotations() {
        return annotations;
    }

    window.pdfEditorModule = {
        init,
        setMode,
        setTool,
        getTool,
        setScale,
        close,
        saveAnnotations,
        loadAnnotations,
        isDirty,
        getAnnotations,
        getMediaFileId,
        renderAnnotationsOntoOverlays,
        updateToolButtons
    };
})();
