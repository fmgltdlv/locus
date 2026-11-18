/**
 * Unified map tool action registry — shared handlers for desktop toolbar and mobile chrome.
 */
(function () {
    const MAP_TOOL_ACTIONS = {
        openCamera: {
            id: 'openCamera',
            label: 'Take photo',
            fabLabel: 'Open camera',
            title: 'Take photo',
            icon: 'camera',
            toolbarIcon: 'camera',
            editOnly: true,
            requiresGetUserMedia: true,
            run: function () {
                if (typeof window.initPhotoUploadFromInPageCamera === 'function') {
                    window.initPhotoUploadFromInPageCamera();
                }
            },
        },
        importPhotos: {
            id: 'importPhotos',
            label: 'Upload photos',
            title: 'Upload photos',
            icon: 'document',
            editOnly: true,
            run: function (options) {
                options = options || {};
                if (options.fromInPageCamera) {
                    if (typeof window.importPhotosFromInPageCamera === 'function') {
                        void window.importPhotosFromInPageCamera();
                    }
                    return;
                }
                if (typeof window.initPhotoUploadFromGallery === 'function') {
                    window.initPhotoUploadFromGallery();
                }
            },
        },
        importFiles: {
            id: 'importFiles',
            label: 'Upload docs',
            title: 'Upload docs (images, PDF, GeoJSON/KML/etc)',
            icon: 'upload',
            toolbarIcon: 'upload',
            editOnly: true,
            run: function () {
                if (typeof window.openUnifiedMapFilePicker === 'function') {
                    window.openUnifiedMapFilePicker();
                } else {
                    console.error('openUnifiedMapFilePicker is not available');
                }
            },
        },
        drawPoint: {
            id: 'drawPoint',
            label: 'Point',
            title: 'Add point',
            icon: 'mapPoint',
            editOnly: true,
            run: function () {
                if (window.drawingModule && typeof window.drawingModule.toggleDrawingMode === 'function') {
                    window.drawingModule.toggleDrawingMode('point');
                }
            },
        },
        drawLine: {
            id: 'drawLine',
            label: 'Line',
            title: 'Add line',
            icon: 'mapLine',
            editOnly: true,
            run: function () {
                if (window.drawingModule && typeof window.drawingModule.toggleDrawingMode === 'function') {
                    window.drawingModule.toggleDrawingMode('line');
                }
            },
        },
        drawPolygon: {
            id: 'drawPolygon',
            label: 'Polygon',
            title: 'Add polygon',
            icon: 'mapPolygon',
            editOnly: true,
            run: function () {
                if (window.drawingModule && typeof window.drawingModule.toggleDrawingMode === 'function') {
                    window.drawingModule.toggleDrawingMode('polygon');
                }
            },
        },
        measure: {
            id: 'measure',
            label: 'Measure',
            title: 'Measure: line by default; with 3+ points, click the first point to close a polygon',
            icon: 'measure',
            toolbarIcon: 'measure',
            editOnly: true,
            run: function () {
                if (typeof window.toggleMeasureMode === 'function') {
                    window.toggleMeasureMode();
                }
            },
        },
        createTicket: {
            id: 'createTicket',
            label: 'Create ticket',
            fabLabel: 'Create ticket',
            title: 'Create ticket',
            icon: 'createTicket',
            toolbarIcon: 'createTicket',
            requiresCreateTicketWizard: true,
            run: function () {
                if (typeof window.openCreateTicketWizard === 'function') {
                    void window.openCreateTicketWizard();
                }
            },
        },
    };

    const MAP_TOOL_LAYOUT = window.CORE_PRODUCT === true
        ? {
              desktopSeparateTools: [],
              mobileStandalone: [],
              mobileFabBubbles: [],
          }
        : {
              desktopSeparateTools: ['measure', 'openCamera', 'importFiles'],
              mobileStandalone: ['openCamera'],
              mobileFabBubbles: ['importFiles', 'measure', 'drawPolygon', 'drawLine', 'drawPoint'],
          };

    /** Annotation + upload ids hidden/blocked during create-ticket or query-polygon draw. Measure stays unless wizard is open. */
    const ANNOTATION_SUPPRESS_ACTION_IDS = {
        drawPoint: true,
        drawLine: true,
        drawPolygon: true,
        importFiles: true,
        openCamera: true,
        importPhotos: true,
        createTicket: true,
    };

    function isCreateTicketWizardSessionOpen() {
        return (
            typeof window.isCreateTicketWizardSessionActive === 'function' &&
            window.isCreateTicketWizardSessionActive()
        );
    }

    function shouldSuppressAnnotationMapTools() {
        if (isCreateTicketWizardSessionOpen()) {
            return true;
        }
        return !!window.mapQueryPolygonDrawing;
    }

    function shouldHideMapToolsForCreateTicketWizard() {
        return isCreateTicketWizardSessionOpen();
    }

    function isAnnotationMapToolSuppressed(actionId) {
        return !!(ANNOTATION_SUPPRESS_ACTION_IDS[actionId] && shouldSuppressAnnotationMapTools());
    }

    function getMapToolAction(actionId) {
        return MAP_TOOL_ACTIONS[actionId] || null;
    }

    function runMapToolAction(actionId, options) {
        if (isAnnotationMapToolSuppressed(actionId)) return false;
        const action = getMapToolAction(actionId);
        if (!action || typeof action.run !== 'function') return false;
        action.run(options || {});
        return true;
    }

    function canUseInPageCamera() {
        return (
            typeof window !== 'undefined' &&
            window.isSecureContext &&
            navigator.mediaDevices &&
            typeof navigator.mediaDevices.getUserMedia === 'function'
        );
    }

    function setMapToolElementVisible(el, show) {
        if (!el) return;
        el.classList.toggle('map-tool-action-hidden', !show);
        if (show) {
            el.removeAttribute('aria-hidden');
        } else {
            el.setAttribute('aria-hidden', 'true');
        }
    }

    function syncMapToolActionVisibility(canEdit) {
        if (canEdit === undefined && typeof window.canEditCurrentOrg === 'function') {
            canEdit = window.canEditCurrentOrg();
        }
        if (canEdit === undefined) canEdit = true;

        const hasMedia = canUseInPageCamera();
        const suppressAnnotation = shouldSuppressAnnotationMapTools();
        const hideForWizard = shouldHideMapToolsForCreateTicketWizard();

        document.body.classList.toggle('create-ticket-wizard-session-active', hideForWizard);

        document.querySelectorAll('[data-map-tool-action]').forEach(function (el) {
            const id = el.getAttribute('data-map-tool-action');
            const def = getMapToolAction(id);
            if (!def) return;
            let show = true;
            if (def.editOnly && !canEdit) show = false;
            else if (def.requiresGetUserMedia && !hasMedia) show = false;
            else if (ANNOTATION_SUPPRESS_ACTION_IDS[id] && suppressAnnotation) show = false;
            else if (def.requiresCreateTicketWizard) {
                show =
                    typeof window.canUseCreateTicketWizard === 'function' &&
                    window.canUseCreateTicketWizard();
            }
            if (hideForWizard && def.id === 'createTicket') show = false;
            setMapToolElementVisible(el, show);
        });

        document.querySelectorAll('[data-map-tools-edit-only]').forEach(function (el) {
            if (el.hasAttribute('data-map-tool-action')) return;
            setMapToolElementVisible(el, canEdit && !hideForWizard);
        });

        const mobileFab = document.getElementById('mapToolsMobileFab');
        const showMobileFab =
            window.CORE_PRODUCT !== true && canEdit && (!hideForWizard || suppressAnnotation);
        setMapToolElementVisible(mobileFab, showMobileFab);

        const mobileMeasureTopBtn = document.getElementById('mobileMeasureButton');
        if (mobileMeasureTopBtn) {
            const showMobileMeasure =
                canEdit &&
                hideForWizard &&
                typeof window.isMapToolsMobileLayout === 'function' &&
                window.isMapToolsMobileLayout();
            setMapToolElementVisible(mobileMeasureTopBtn, showMobileMeasure);
        }

        if (
            (!canEdit || suppressAnnotation) &&
            typeof window.closeMapToolsMobileMenu === 'function'
        ) {
            window.closeMapToolsMobileMenu();
        }

        if (typeof window.syncMapContextualDrawStrip === 'function') {
            window.syncMapContextualDrawStrip();
        }
    }

    function bindDesktopToolbarButton(btn, actionId) {
        const def = getMapToolAction(actionId);
        if (!btn || !def) return;
        btn.type = 'button';
        btn.setAttribute('data-map-tool-action', actionId);
        btn.setAttribute('data-map-tool-label', def.label);
        if (def.editOnly) btn.setAttribute('data-map-tools-edit-only', '');
        btn.title = def.title || def.label;
        btn.setAttribute('aria-label', def.label);
        btn.onclick = function () {
            runMapToolAction(actionId);
        };
    }

    window.mapToolActionsModule = {
        MAP_TOOL_ACTIONS: MAP_TOOL_ACTIONS,
        MAP_TOOL_LAYOUT: MAP_TOOL_LAYOUT,
        getMapToolAction: getMapToolAction,
        run: runMapToolAction,
        syncMapToolActionVisibility: syncMapToolActionVisibility,
        shouldSuppressAnnotationMapTools: shouldSuppressAnnotationMapTools,
        shouldHideMapToolsForCreateTicketWizard: shouldHideMapToolsForCreateTicketWizard,
        isAnnotationMapToolSuppressed: isAnnotationMapToolSuppressed,
        canUseInPageCamera: canUseInPageCamera,
        bindDesktopToolbarButton: bindDesktopToolbarButton,
    };
    window.runMapToolAction = runMapToolAction;
    window.syncMapToolActionVisibility = syncMapToolActionVisibility;
    window.shouldSuppressAnnotationMapTools = shouldSuppressAnnotationMapTools;
    window.shouldHideMapToolsForCreateTicketWizard = shouldHideMapToolsForCreateTicketWizard;
})();
