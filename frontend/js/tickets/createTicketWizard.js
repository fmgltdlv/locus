/**
 * Create ticket wizard (default Ticket Hub entry). Shared fields once; per dig site:
 * polygon, address, nearest cross street, description of work. Submits via POST tickets/create.
 */
(function (global) {
    'use strict';

    const OVERLAY_ID = 'createTicketWizardOverlay';
    const MAX_DIG_SITES = 10;
    const INITIAL_DIG_SITES = 1;

    function canPreviewUsanPayload() {
        return !!(
            global.authModule &&
            typeof global.authModule.isDev === 'function' &&
            global.authModule.isDev()
        );
    }

    /** @type {object[]} */
    let digSites = [];
    let siteIdSeq = 0;
    /** @type {object|null} */
    let wizardLookupsRef = null;
    let activeDrawSiteIndex = -1;
    /** @type {'dig-sites'|'shared'|'finalize'} */
    let activeBulkStep = 'dig-sites';
    /** Banner hint when opened via Clone Ticket */
    let cloneSourceLabel = null;
    const BULK_WIZARD_STEPS = [
        { id: 'dig-sites', label: 'Dig sites', num: 1 },
        { id: 'shared', label: 'Shared details', num: 2 },
        { id: 'finalize', label: 'Submit', num: 3 },
    ];
    const WIZARD_INFO = {
        'dig-sites-step': {
            title: 'Dig sites',
            message:
                'Search once to center the map, then for each ticket add a dig polygon, confirm the address (filled in after map lookup), enter a nearest cross street, and a description of work.\n\nUse Add dig site for more tickets at the same location. Shared contact and work type are on step 2.\n\nOn desktop, drag this panel by the title bar to see the map while you enter cross streets.',
        },
        'map-location': {
            title: 'Map location',
            message:
                'Search for an address or intersection to center the map (tap Search on your phone or press Enter on desktop), then draw each dig site polygon on the map.\n\nYou can also tap Use my location when you are on site.',
        },
        'shared-step': {
            title: 'Shared details',
            message: 'These fields apply to every ticket in this batch.',
        },
        finalize: {
            title: 'Submit',
            message:
                'Review acknowledgments before submitting. Each dig site becomes its own ticket with the shared details from step 2.',
        },
    };
    /** @type {object|null} */
    let lastSharedFormSnapshot = null;
    let mapCenterSearchQuery = '';
    let mapCenterSearchStatus = '';
    const MAP_CENTER_CONNECT_USAN_STATUS =
        "Connect your organization's USAN master account in organization settings to search Nevada addresses statewide.";

    let bulkCreatePanelDragging = false;
    let bulkCreatePanelDragOffset = { x: 0, y: 0 };
    let bulkCreatePanelResizing = false;
    /** @type {'right'|'bottom'|'corner'|null} */
    let bulkCreatePanelResizeType = null;
    let bulkCreatePanelResizeStart = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0 };
    let bulkCreatePanelFloatDocBound = false;
    let hubWasOpenBeforeCreateTicket = false;
    let createTicketSubmitFlowCompleted = false;
    let createTicketWizardSessionActive = false;
    let createTicketWizardMinimized = false;
    /** @type {{ ticketType: string, earliest: { ymd: string, hm: string }, latest: { ymd: string, hm: string }|null }|null} */
    let lastUsanCommencementBounds = null;
    let commencementResolveSeq = 0;

    function overlayRoot() {
        return document.getElementById(OVERLAY_ID);
    }

    function closeTicketHubForCreateTicketWizard() {
        hubWasOpenBeforeCreateTicket = false;
        const hubWin = document.getElementById('ticketHubWindow');
        if (hubWin && hubWin.classList.contains('show')) {
            hubWasOpenBeforeCreateTicket = true;
            if (typeof global.closeTicketHubWindow === 'function') {
                global.closeTicketHubWindow();
            }
        }
    }

    async function reopenTicketHubAfterCreateTicketWizard(opts) {
        opts = opts || {};
        if (!hubWasOpenBeforeCreateTicket) return;
        hubWasOpenBeforeCreateTicket = false;
        if (typeof global.openTicketHubWindow !== 'function') return;
        try {
            await global.openTicketHubWindow({
                skipPacPoll: true,
                skipServerTicketLoad: opts.refreshTickets !== true,
                reopenFromPolygonDraw: true,
            });
        } catch (e) {
            console.warn('[createTicketWizard] reopen ticket hub', e);
        }
    }

    function removeCreateTicketOverlayDom() {
        const x = overlayRoot();
        if (x) x.remove();
        activeDrawSiteIndex = -1;
        createTicketWizardMinimized = false;
        if (global.createTicketWizardBulkApi && typeof global.createTicketWizardBulkApi.syncBulkCreatePolygonsOnMap === 'function') {
            global.createTicketWizardBulkApi.syncBulkCreatePolygonsOnMap([]);
        }
        if (typeof global.createTicketWizardCancelPolygonDrawingIfActive === 'function') {
            global.createTicketWizardCancelPolygonDrawingIfActive();
        }
    }

    function closeOverlay() {
        const refreshTickets = createTicketSubmitFlowCompleted;
        createTicketSubmitFlowCompleted = false;
        const shouldReopenHub = createTicketWizardSessionActive;
        createTicketWizardSessionActive = false;
        cloneSourceLabel = null;
        if (
            global.createTicketAssessorOverlayModule &&
            typeof global.createTicketAssessorOverlayModule.setActive === 'function'
        ) {
            global.createTicketAssessorOverlayModule.setActive(false);
        }
        clearCreateTicketSearchPin();
        removeCreateTicketOverlayDom();
        syncCreateTicketWizardMapTools();
        if (shouldReopenHub) {
            void reopenTicketHubAfterCreateTicketWizard({ refreshTickets: refreshTickets });
        }
    }

    function isCreateTicketWizardSessionActive() {
        return !!createTicketWizardSessionActive;
    }

    function getCreateTicketWizardMapContext() {
        return {
            active: createTicketWizardSessionActive,
            step: activeBulkStep,
            drawing:
                typeof global.isCreateTicketMapDrawingActive === 'function' &&
                global.isCreateTicketMapDrawingActive(),
        };
    }

    function syncCreateTicketWizardMapTools() {
        if (typeof global.syncMapToolActionVisibility === 'function') {
            global.syncMapToolActionVisibility();
        } else if (typeof global.syncMapContextualDrawStrip === 'function') {
            global.syncMapContextualDrawStrip();
        }
    }

    function cancelAnnotationToolsForCreateTicketWizard() {
        if (global.drawingModule && typeof global.drawingModule.cancelDrawingMode === 'function') {
            global.drawingModule.cancelDrawingMode();
        }
        if (global.photosModule && typeof global.photosModule.cancelPhotoUpload === 'function') {
            global.photosModule.cancelPhotoUpload();
        }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function wizardInfoButtonMarkup(infoId) {
        const info = WIZARD_INFO[infoId];
        if (!info) return '';
        return (
            '<button type="button" class="create-ticket-wizard-info-btn" data-wizard-info-id="' +
            esc(infoId) +
            '" aria-label="' +
            esc(info.title + ' help') +
            '" title="' +
            esc(info.title) +
            '"><span aria-hidden="true">i</span></button>'
        );
    }

    function wizardBlockHeadMarkup(label, infoId) {
        return (
            '<div class="create-ticket-wizard-block-head">' +
            '<span class="create-ticket-wizard-block-label">' +
            esc(label) +
            '</span>' +
            (infoId ? wizardInfoButtonMarkup(infoId) : '') +
            '</div>'
        );
    }

    function wizardStepHeadMarkup(infoId) {
        if (!infoId || !WIZARD_INFO[infoId]) return '';
        return '<div class="bulk-create-mock-step-head">' + wizardInfoButtonMarkup(infoId) + '</div>';
    }

    function bindWizardInfoButtons(root) {
        const panel = qs('.ticket-hub-mock-panel', root) || root;
        if (!panel || panel.dataset.wizardInfoBound === '1') return;
        panel.dataset.wizardInfoBound = '1';
        panel.addEventListener('click', function (ev) {
            const btn = ev.target.closest('[data-wizard-info-id]');
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            const info = WIZARD_INFO[String(btn.getAttribute('data-wizard-info-id') || '')];
            if (!info) return;
            if (typeof global.appAlert === 'function') {
                void global.appAlert(info.message, { title: info.title });
            }
        });
    }

    function qs(sel, root) {
        return (root || document).querySelector(sel);
    }

    function qsa(sel, root) {
        return Array.from((root || document).querySelectorAll(sel));
    }

    function delayMs(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    function closeMobileSidebarForMapView() {
        /* sidebar removed */
    }

    function trapFocus(panel) {
        const focusables = qsa(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            panel
        ).filter(function (el) {
            try {
                return el.offsetParent !== null;
            } catch (_) {
                return false;
            }
        });
        if (focusables.length) focusables[0].focus();
    }

    function bindDismissHandlers(wrap) {
        qsa('[data-bulk-create-dismiss], .ticket-hub-mock-close', wrap).forEach(function (btn) {
            btn.addEventListener('click', closeOverlay);
        });
    }

    function createTicketWizardHeaderActionsMarkup() {
        return (
            '<div class="ticket-hub-mock-header-actions">' +
            '<button type="button" class="ticket-hub-mock-minimize" data-bulk-create-minimize aria-label="Minimize to show map" title="Minimize"><span aria-hidden="true">▼</span></button>' +
            '<button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>' +
            '</div>'
        );
    }

    function createTicketWizardHeaderMarkup(title) {
        return (
            '<div class="ticket-hub-mock-header">' +
            '<h3 class="ticket-hub-mock-title">' +
            esc(title) +
            '</h3>' +
            createTicketWizardHeaderActionsMarkup() +
            '</div>'
        );
    }

    function syncCreateWizardMinimizedUi(wrap) {
        if (!wrap) return;
        const panel = qs('.ticket-hub-mock-panel', wrap);
        if (panel) panel.classList.toggle('bulk-create-mock-panel--minimized', createTicketWizardMinimized);
        wrap.classList.toggle('bulk-create-mock-overlay--minimized', createTicketWizardMinimized);
        const btn = qs('[data-bulk-create-minimize]', wrap);
        if (btn) {
            const expanded = !createTicketWizardMinimized;
            btn.setAttribute('aria-label', expanded ? 'Minimize to show map' : 'Show create ticket form');
            btn.setAttribute('title', expanded ? 'Minimize' : 'Show form');
            const icon = btn.querySelector('[aria-hidden="true"]');
            if (icon) icon.textContent = expanded ? '▼' : '▲';
        }
    }

    function setCreateWizardMinimized(wrap, minimized) {
        createTicketWizardMinimized = !!minimized;
        syncCreateWizardMinimizedUi(wrap);
    }

    function toggleCreateWizardMinimized(wrap) {
        setCreateWizardMinimized(wrap, !createTicketWizardMinimized);
    }

    function bindCreateWizardMinimizeHandler(wrap) {
        if (!wrap || wrap.dataset.bulkCreateMinimizeBound === '1') return;
        wrap.dataset.bulkCreateMinimizeBound = '1';
        // Capture: panel click handler stops bubble, so minimize must run on the way down.
        wrap.addEventListener(
            'click',
            function (ev) {
                if (ev.target.closest('[data-bulk-create-minimize]')) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    toggleCreateWizardMinimized(wrap);
                    return;
                }
                if (!createTicketWizardMinimized) return;
                const header = ev.target.closest('.ticket-hub-mock-header');
                if (header && !ev.target.closest('.ticket-hub-mock-header-actions')) {
                    setCreateWizardMinimized(wrap, false);
                }
            },
            true
        );
    }

    function isDesktopCreatePanelViewport() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 769px)').matches;
    }

    function bulkCreatePanelViewportLimits() {
        const gutter = 12;
        return {
            gutter: gutter,
            minWidth: 320,
            minHeight: 280,
            maxWidth: Math.max(320, window.innerWidth - gutter * 2),
            maxHeight: Math.max(280, window.innerHeight - gutter * 2),
        };
    }

    const CREATE_WIZARD_FLOAT_PANEL_WIDTH_PX = 580;

    function applyDefaultFloatingCreatePanelGeometry(panel) {
        const limits = bulkCreatePanelViewportLimits();
        const width = Math.min(
            CREATE_WIZARD_FLOAT_PANEL_WIDTH_PX,
            limits.maxWidth,
            Math.max(limits.minWidth, Math.round(window.innerWidth * 0.38))
        );
        const height = Math.min(
            limits.maxHeight,
            Math.max(limits.minHeight, Math.round(window.innerHeight * 0.82))
        );
        panel.style.width = width + 'px';
        panel.style.height = height + 'px';
        panel.style.left = limits.gutter + 'px';
        panel.style.top = limits.gutter + 'px';
    }

    function ensureFloatingCreatePanelResizeHandles(panel) {
        if (!panel || panel.querySelector('.bulk-create-mock-resize-corner')) return;
        const right = document.createElement('div');
        right.className = 'bulk-create-mock-resize-handle bulk-create-mock-resize-right';
        right.setAttribute('aria-hidden', 'true');
        const bottom = document.createElement('div');
        bottom.className = 'bulk-create-mock-resize-handle bulk-create-mock-resize-bottom';
        bottom.setAttribute('aria-hidden', 'true');
        const corner = document.createElement('div');
        corner.className = 'bulk-create-mock-resize-handle bulk-create-mock-resize-corner';
        corner.setAttribute('aria-hidden', 'true');
        panel.appendChild(right);
        panel.appendChild(bottom);
        panel.appendChild(corner);
    }

    function bindFloatingCreatePanelDocumentHandlers() {
        if (bulkCreatePanelFloatDocBound) return;
        bulkCreatePanelFloatDocBound = true;
        document.addEventListener('mousemove', function (e) {
            const wrap = overlayRoot();
            const panel = wrap && qs('.bulk-create-mock-panel--float', wrap);
            if (!panel) return;
            if (bulkCreatePanelDragging) {
                const limits = bulkCreatePanelViewportLimits();
                const rect = panel.getBoundingClientRect();
                const maxLeft = Math.max(limits.gutter, window.innerWidth - rect.width - limits.gutter);
                const maxTop = Math.max(limits.gutter, window.innerHeight - rect.height - limits.gutter);
                panel.style.left =
                    Math.max(limits.gutter, Math.min(maxLeft, e.clientX - bulkCreatePanelDragOffset.x)) + 'px';
                panel.style.top =
                    Math.max(limits.gutter, Math.min(maxTop, e.clientY - bulkCreatePanelDragOffset.y)) + 'px';
            }
            if (bulkCreatePanelResizing && bulkCreatePanelResizeType) {
                const limits = bulkCreatePanelViewportLimits();
                const deltaX = e.clientX - bulkCreatePanelResizeStart.x;
                const deltaY = e.clientY - bulkCreatePanelResizeStart.y;
                let w = bulkCreatePanelResizeStart.width;
                let h = bulkCreatePanelResizeStart.height;
                if (bulkCreatePanelResizeType === 'right' || bulkCreatePanelResizeType === 'corner') {
                    w = Math.max(limits.minWidth, Math.min(limits.maxWidth, bulkCreatePanelResizeStart.width + deltaX));
                }
                if (bulkCreatePanelResizeType === 'bottom' || bulkCreatePanelResizeType === 'corner') {
                    h = Math.max(
                        limits.minHeight,
                        Math.min(limits.maxHeight, bulkCreatePanelResizeStart.height + deltaY)
                    );
                }
                panel.style.width = w + 'px';
                panel.style.height = h + 'px';
            }
        });
        document.addEventListener('mouseup', function () {
            if (bulkCreatePanelDragging) {
                bulkCreatePanelDragging = false;
                const wrap = overlayRoot();
                const panel = wrap && qs('.bulk-create-mock-panel--float', wrap);
                if (panel) panel.classList.remove('is-dragging');
            }
            if (bulkCreatePanelResizing) {
                bulkCreatePanelResizing = false;
                bulkCreatePanelResizeType = null;
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
            }
        });
    }

    function initFloatingCreatePanel(wrap) {
        if (!wrap || !isDesktopCreatePanelViewport()) return;
        const panel = qs('.ticket-hub-mock-panel', wrap);
        if (!panel) return;
        wrap.classList.add('bulk-create-mock-overlay--float');
        panel.classList.add('bulk-create-mock-panel--float');
        if (!panel.style.left || !panel.style.top || !panel.style.width || !panel.style.height) {
            applyDefaultFloatingCreatePanelGeometry(panel);
        }
        ensureFloatingCreatePanelResizeHandles(panel);
        bindFloatingCreatePanelDocumentHandlers();
        if (panel.dataset.bulkCreateFloatInit) return;
        panel.dataset.bulkCreateFloatInit = '1';
        panel.addEventListener('mousedown', function (e) {
            if (!isDesktopCreatePanelViewport()) return;
            const resizeEl = e.target.closest('.bulk-create-mock-resize-handle');
            if (resizeEl && panel.contains(resizeEl)) {
                e.preventDefault();
                e.stopPropagation();
                bulkCreatePanelResizing = true;
                bulkCreatePanelResizeType = resizeEl.classList.contains('bulk-create-mock-resize-corner')
                    ? 'corner'
                    : resizeEl.classList.contains('bulk-create-mock-resize-bottom')
                      ? 'bottom'
                      : 'right';
                const rect = panel.getBoundingClientRect();
                bulkCreatePanelResizeStart = {
                    x: e.clientX,
                    y: e.clientY,
                    width: rect.width,
                    height: rect.height,
                    left: rect.left,
                    top: rect.top,
                };
                document.body.style.userSelect = 'none';
                document.body.style.cursor =
                    bulkCreatePanelResizeType === 'right'
                        ? 'ew-resize'
                        : bulkCreatePanelResizeType === 'bottom'
                          ? 'ns-resize'
                          : 'nwse-resize';
                return;
            }
            const header = e.target.closest('.ticket-hub-mock-header');
            if (!header || !panel.contains(header)) return;
            if (e.target.closest('.ticket-hub-mock-close')) return;
            if (e.target.closest('[data-bulk-create-minimize]')) return;
            if (panel.classList.contains('bulk-create-mock-panel--minimized')) return;
            e.preventDefault();
            bulkCreatePanelDragging = true;
            const rect = panel.getBoundingClientRect();
            bulkCreatePanelDragOffset.x = e.clientX - rect.left;
            bulkCreatePanelDragOffset.y = e.clientY - rect.top;
            panel.classList.add('is-dragging');
        });
    }

    function openOverlay(panelInnerHtml, opts) {
        removeCreateTicketOverlayDom();
        opts = opts || {};
        const wrap = document.createElement('div');
        wrap.id = OVERLAY_ID;
        wrap.className = 'ticket-hub-mock-modal-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', opts.title || 'Create ticket');
        const wideCls = opts.widePanel !== false ? ' bulk-create-mock-panel--wide' : '';
        wrap.innerHTML =
            '<div class="ticket-hub-mock-panel bulk-create-mock-panel' +
            wideCls +
            '">' +
            panelInnerHtml +
            '</div>';
        document.body.appendChild(wrap);
        const panel = wrap.querySelector('.ticket-hub-mock-panel');
        bindDismissHandlers(wrap);
        bindCreateWizardMinimizeHandler(wrap);
        syncCreateWizardMinimizedUi(wrap);
        if (!isDesktopCreatePanelViewport()) {
            wrap.addEventListener('click', function (ev) {
                if (ev.target === wrap) closeOverlay();
            });
        }
        if (panel) {
            panel.addEventListener('click', function (e) {
                e.stopPropagation();
            });
            initFloatingCreatePanel(wrap);
            trapFocus(panel);
        }
        return wrap;
    }

    function emptySiteAddress() {
        return { street: '', city: '', state: '', zip: '', county: '' };
    }

    function stateCodeFromGeocodeState(val) {
        if (val == null) return '';
        if (typeof val === 'string') return val.trim();
        if (typeof val === 'object') {
            const c = val.code != null ? String(val.code).trim() : '';
            if (c) return c;
            const v = val.value != null ? String(val.value).trim() : '';
            return v;
        }
        return '';
    }

    function applySiteAddressFromGeocodeRow(site, row) {
        if (!site) return;
        const addr = row && row.geocodedAddress;
        if (!addr || typeof addr !== 'object') {
            site.address = emptySiteAddress();
            return;
        }
        site.address = {
            street: addr.street != null ? String(addr.street).trim() : '',
            city: addr.suburb != null ? String(addr.suburb).trim() : '',
            county: addr.county != null ? String(addr.county).trim() : '',
            zip: addr.postcode != null ? String(addr.postcode).trim() : '',
            state: stateCodeFromGeocodeState(addr.state),
        };
        site.geocodeSummary = siteAddressSummary(site);
    }

    function siteAddressSummary(site) {
        const a = site && site.address;
        if (!a) return '';
        const bits = [a.street, a.city, a.state, a.zip].filter(Boolean);
        return bits.length ? bits.join(', ') : '';
    }

    function mergeAddressIntoReverseGeocodeRow(row, address) {
        if (!row || typeof row !== 'object') return row;
        const a = address || {};
        const geo =
            row.geocodedAddress && typeof row.geocodedAddress === 'object' ? row.geocodedAddress : {};
        geo.street = String(a.street != null ? a.street : '').trim();
        geo.suburb = String(a.city != null ? a.city : '').trim();
        geo.postcode = String(a.zip != null ? a.zip : '').trim();
        geo.county = String(a.county != null ? a.county : '').trim();
        geo.state = String(a.state != null ? a.state : '').trim();
        row.geocodedAddress = geo;
        return row;
    }

    function newDigSite(opts) {
        opts = opts || {};
        siteIdSeq += 1;
        return {
            id: 'site-' + siteIdSeq,
            polygonGeoJson: null,
            scope: '',
            geocodeSummary: '',
            geocodeMeta: '',
            geocodeStatusText: '',
            geocodeStatusError: false,
            nearestCrossStreet: '',
            reverseGeocodeRow: null,
            address: emptySiteAddress(),
            uiCollapsed: opts.uiCollapsed === true,
        };
    }

    function resetDigSites() {
        siteIdSeq = 0;
        digSites = [];
        for (let i = 0; i < INITIAL_DIG_SITES; i++) {
            digSites.push(newDigSite());
        }
    }

    function resolveCreateTicketOrgId() {
        if (typeof global.resolveCreateTicketOrgId === 'function') {
            return global.resolveCreateTicketOrgId();
        }
        if (typeof global.getCurrentOrgId === 'function') {
            const id = global.getCurrentOrgId();
            if (id != null && String(id).trim() !== '') {
                const n = parseInt(String(id), 10);
                if (Number.isFinite(n)) return n;
            }
        }
        return null;
    }

    function sortLookupByName(a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    }

    function defaultPrincipalContactName() {
        const u =
            global.authModule && typeof global.authModule.getCurrentUser === 'function'
                ? global.authModule.getCurrentUser()
                : null;
        const raw =
            u && u.fullName != null && String(u.fullName).trim()
                ? String(u.fullName).trim()
                : '';
        if (!raw) return '';
        const validateName = principalNameValidator();
        if (validateName) {
            const result = validateName(raw);
            return result.ok && result.value ? result.value : '';
        }
        return /^[A-Za-z ]+$/.test(raw) ? raw.slice(0, 40) : '';
    }

    function defaultPrincipalContactMobile() {
        const u =
            global.authModule && typeof global.authModule.getCurrentUser === 'function'
                ? global.authModule.getCurrentUser()
                : null;
        const raw = u && u.phone != null ? String(u.phone).trim() : '';
        if (!raw) return '';
        const validateMobile = principalMobileValidator();
        if (validateMobile) {
            const result = validateMobile(raw);
            return result.ok && result.value ? result.value : '';
        }
        const digits = raw.replace(/\D/g, '');
        return /^\d{10}$/.test(digits) ? digits : '';
    }

    function normalizeTicketTypeValue(ticketType) {
        const api = commencementDatesApi();
        if (api && typeof api.normalizeTicketType === 'function') {
            return api.normalizeTicketType(ticketType);
        }
        const t = String(ticketType || 'Normal').trim();
        return t === 'Short' || t === 'Emergency' ? t : 'Normal';
    }

    function syncTicketTypeAckVisibility(root) {
        const shared = collectSharedFromForm(root);
        const ticketType = normalizeTicketTypeValue(shared.ticketType);
        const shortWrap = qs('#bcwShortAckWrap', root);
        const emergencyWrap = qs('#bcwEmergencyAckWrap', root);
        if (shortWrap) {
            if (ticketType === 'Short') {
                shortWrap.removeAttribute('hidden');
            } else {
                shortWrap.setAttribute('hidden', '');
                const shortCk = qs('#bcwAckShort', root);
                if (shortCk) shortCk.checked = false;
            }
        }
        if (emergencyWrap) {
            if (ticketType === 'Emergency') {
                emergencyWrap.removeAttribute('hidden');
            } else {
                emergencyWrap.setAttribute('hidden', '');
                const emergencyCk = qs('#bcwAckEmergency', root);
                if (emergencyCk) emergencyCk.checked = false;
            }
        }
        updateAcknowledgmentReadinessIndicator(root);
    }

    function applyDefaultSharedFormValues(root) {
        const ticketTypeEl = qs('#bcwTicketType', root);
        if (ticketTypeEl && !String(ticketTypeEl.value || '').trim()) {
            ticketTypeEl.value = 'Normal';
        }
        const nameEl = qs('#bcwPrincipalName', root);
        if (nameEl && !String(nameEl.value || '').trim()) {
            const defaultName = defaultPrincipalContactName();
            if (defaultName) nameEl.value = defaultName;
        }
        const mobileEl = qs('#bcwPrincipalMobile', root);
        if (mobileEl && !String(mobileEl.value || '').trim()) {
            const defaultMobile = defaultPrincipalContactMobile();
            if (defaultMobile) mobileEl.value = defaultMobile;
        }
    }

    async function reloadLookupsForTicketType(root, ticketType) {
        const api = global.newTicketPayloadApi;
        const type = normalizeTicketTypeValue(ticketType);
        clearUsanCommencementBounds();
        applyCommencementDateConstraints(root);
        void refreshCommencementDatesFromUsan(root);
        syncTicketTypeAckVisibility(root);
        updateSharedReadinessIndicator(root);
        if (!api || typeof api.loadNewTicketLookups !== 'function') return;
        try {
            wizardLookupsRef = await api.loadNewTicketLookups(type);
        } catch (e) {
            console.warn('[createTicketWizard] lookups for ' + type, e);
            return;
        }
        const wt = qs('#bcwWorkType', root);
        const act = qs('#bcwWorkActivity', root);
        if (wt) {
            wt.innerHTML = workTypeOptionsHtml();
            wt.value = '';
        }
        if (act) {
            act.innerHTML = workActivityOptionsHtml('');
            act.disabled = true;
            act.value = '';
        }
        updateSharedReadinessIndicator(root);
    }


    function workTypeOptionsHtml() {
        if (!wizardLookupsRef || !Array.isArray(wizardLookupsRef.enquiryCategories)) {
            return '<option value="">Select…</option>';
        }
        let html = '<option value="">Select…</option>';
        wizardLookupsRef.enquiryCategories
            .slice()
            .sort(sortLookupByName)
            .forEach(function (c) {
                if (!c || c.isActive === false) return;
                html += '<option value="' + esc(String(c.id)) + '">' + esc(c.name) + '</option>';
            });
        return html;
    }

    function workActivityOptionsHtml(categoryId) {
        const catId = parseInt(String(categoryId || ''), 10);
        if (!wizardLookupsRef || !Number.isFinite(catId) || catId <= 0) {
            return '<option value="">Select type of work first…</option>';
        }
        const cat = (wizardLookupsRef.enquiryCategories || []).find(function (c) {
            return c && Number(c.id) === catId;
        });
        const activities = (cat && Array.isArray(cat.activities) ? cat.activities : []).slice().sort(sortLookupByName);
        if (!activities.length) return '<option value="">Select…</option>';
        let html = '<option value="">Select…</option>';
        activities.forEach(function (a) {
            if (!a || a.isActive === false) return;
            html += '<option value="' + esc(String(a.id)) + '">' + esc(a.name) + '</option>';
        });
        return html;
    }

    function excavationOptionsHtml() {
        if (!wizardLookupsRef || !Array.isArray(wizardLookupsRef.excavationMethodList)) {
            return '<option value="">Select…</option>';
        }
        let html = '<option value="">Select…</option>';
        wizardLookupsRef.excavationMethodList
            .slice()
            .filter(function (r) {
                return r && r.isActive !== false;
            })
            .sort(function (a, b) {
                return Number(a.id) - Number(b.id);
            })
            .forEach(function (r) {
                html += '<option value="' + esc(String(r.name)) + '">' + esc(r.name) + '</option>';
            });
        return html;
    }

    function permitExcavationOptionsHtml() {
        if (!wizardLookupsRef || !Array.isArray(wizardLookupsRef.hasPermitForList)) {
            return '<option value="">Select…</option>';
        }
        let html = '<option value="">Select…</option>';
        wizardLookupsRef.hasPermitForList
            .slice()
            .filter(function (r) {
                return r && r.isActive !== false;
            })
            .sort(function (a, b) {
                return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
            })
            .forEach(function (r) {
                html += '<option value="' + esc(String(r.name)) + '">' + esc(r.name) + '</option>';
            });
        return html;
    }

    function areaPreMarkedOptionsHtml() {
        if (!wizardLookupsRef || !Array.isArray(wizardLookupsRef.areaPreMakedOptions)) {
            return '<option value="">Select…</option>';
        }
        let html = '<option value="">Select…</option>';
        wizardLookupsRef.areaPreMakedOptions
            .slice()
            .filter(function (r) {
                return r && r.isActive !== false;
            })
            .sort(function (a, b) {
                return String(a.description || '').localeCompare(String(b.description || ''), undefined, {
                    sensitivity: 'base',
                });
            })
            .forEach(function (r) {
                html +=
                    '<option value="' + esc(String(r.description)) + '">' + esc(r.description) + '</option>';
            });
        return html;
    }

    function projectOwnerTypeOptionsHtml() {
        if (!wizardLookupsRef || !Array.isArray(wizardLookupsRef.workingOnBehalfOfList)) {
            return '<option value="">Select…</option>';
        }
        let html = '<option value="">Select…</option>';
        wizardLookupsRef.workingOnBehalfOfList
            .slice()
            .filter(function (r) {
                return r && r.isActive !== false;
            })
            .sort(sortLookupByName)
            .forEach(function (r) {
                html += '<option value="' + esc(String(r.id)) + '">' + esc(r.name) + '</option>';
            });
        return html;
    }

    function projectOwnerNameOptionsHtml(ownerTypeId) {
        const typeId = parseInt(String(ownerTypeId || ''), 10);
        if (!wizardLookupsRef || !Number.isFinite(typeId) || typeId <= 0) {
            return '<option value="">Select project owner type first…</option>';
        }
        const authorities = (wizardLookupsRef.workingOnBehalfAuthorityOfList || [])
            .filter(function (a) {
                return a && a.isActive !== false && Number(a.workingOfBehalfOfId) === typeId;
            })
            .slice()
            .sort(sortLookupByName);
        if (!authorities.length) {
            return '<option value="">No options available</option>';
        }
        let html = '<option value="">Select…</option>';
        authorities.forEach(function (a) {
            html += '<option value="' + esc(String(a.id)) + '">' + esc(a.name) + '</option>';
        });
        return html;
    }

    function yesNoRadios(name) {
        return (
            '<label class="create-ticket-yesno-option"><input type="radio" name="' +
            esc(name) +
            '" value="yes" /> Yes</label>' +
            '<label class="create-ticket-yesno-option"><input type="radio" name="' +
            esc(name) +
            '" value="no" /> No</label>'
        );
    }

    function digSiteAddressFieldsMarkup(site, index) {
        const a = site.address || emptySiteAddress();
        const panelHidden = site.polygonGeoJson && site.polygonGeoJson.type === 'Polygon' ? '' : ' hidden';
        const statusCls = site.geocodeStatusError ? ' create-ticket-geocode-status--error' : '';
        const statusText = site.geocodeStatusText
            ? esc(site.geocodeStatusText)
            : site.polygonGeoJson
              ? 'Edit the address below if the map lookup needs correction.'
              : '';
        return (
            '<div class="create-ticket-geocode-panel bulk-create-mock-address-panel"' +
            panelHidden +
            ' data-dig-site-address-panel="' +
            index +
            '">' +
            '<div class="create-ticket-geocode-panel-head">' +
            wizardBlockHeadMarkup('Address from map', null) +
            (statusText
                ? '<p class="create-ticket-geocode-status' +
                  statusCls +
                  '" aria-live="polite">' +
                  statusText +
                  '</p>'
                : '') +
            '</div>' +
            (site.geocodeMeta ? '<p class="create-ticket-geocode-meta">' + esc(site.geocodeMeta) + '</p>' : '') +
            '<div class="create-ticket-field">' +
            '<label for="bcwAddrStreet-' +
            esc(site.id) +
            '">Street address</label>' +
            '<input type="text" id="bcwAddrStreet-' +
            esc(site.id) +
            '" class="bulk-create-mock-addr-street" data-dig-site-addr-street="' +
            index +
            '" value="' +
            esc(a.street) +
            '" placeholder="From map lookup" autocomplete="street-address" />' +
            '</div>' +
            '<div class="create-ticket-field">' +
            '<label for="bcwAddrCity-' +
            esc(site.id) +
            '">City</label>' +
            '<input type="text" id="bcwAddrCity-' +
            esc(site.id) +
            '" class="bulk-create-mock-addr-city" data-dig-site-addr-city="' +
            index +
            '" value="' +
            esc(a.city) +
            '" autocomplete="address-level2" />' +
            '</div>' +
            '<div class="create-ticket-field">' +
            '<label for="bcwAddrState-' +
            esc(site.id) +
            '">State</label>' +
            '<input type="text" id="bcwAddrState-' +
            esc(site.id) +
            '" class="bulk-create-mock-addr-state" data-dig-site-addr-state="' +
            index +
            '" value="' +
            esc(a.state) +
            '" maxlength="2" placeholder="NV" autocomplete="address-level1" />' +
            '</div>' +
            '<div class="create-ticket-field">' +
            '<label for="bcwAddrZip-' +
            esc(site.id) +
            '">ZIP</label>' +
            '<input type="text" id="bcwAddrZip-' +
            esc(site.id) +
            '" class="bulk-create-mock-addr-zip" data-dig-site-addr-zip="' +
            index +
            '" value="' +
            esc(a.zip) +
            '" autocomplete="postal-code" />' +
            '</div>' +
            '<div class="create-ticket-field">' +
            '<label for="bcwAddrCounty-' +
            esc(site.id) +
            '">County</label>' +
            '<input type="text" id="bcwAddrCounty-' +
            esc(site.id) +
            '" class="bulk-create-mock-addr-county" data-dig-site-addr-county="' +
            index +
            '" value="' +
            esc(a.county) +
            '" placeholder="Optional" autocomplete="off" />' +
            '</div>' +
            '</div>'
        );
    }

    function crossStreetValidator() {
        return global.newTicketPayloadApi &&
            typeof global.newTicketPayloadApi.validateNearestCrossStreet === 'function'
            ? global.newTicketPayloadApi.validateNearestCrossStreet
            : null;
    }

    function principalNameValidator() {
        return global.newTicketPayloadApi &&
            typeof global.newTicketPayloadApi.validatePrincipalContactName === 'function'
            ? global.newTicketPayloadApi.validatePrincipalContactName
            : null;
    }

    function principalMobileValidator() {
        return global.newTicketPayloadApi &&
            typeof global.newTicketPayloadApi.validatePrincipalContactMobile === 'function'
            ? global.newTicketPayloadApi.validatePrincipalContactMobile
            : null;
    }

    /** @returns {{ ok: boolean, hint: string }} */
    function evaluateDigSiteReadiness(site) {
        const crossValidate = crossStreetValidator();
        if (!site.polygonGeoJson || site.polygonGeoJson.type !== 'Polygon') {
            return { ok: false, hint: 'Draw dig site polygon' };
        }
        if (!String((site.address && site.address.street) || '').trim()) {
            return { ok: false, hint: 'Enter street address' };
        }
        if (!site.reverseGeocodeRow) {
            return { ok: false, hint: 'Complete address lookup (draw polygon on map)' };
        }
        if (site.reverseGeocodeRow.isWktValid !== true) {
            return { ok: false, hint: 'Polygon not accepted by USAN — adjust dig area' };
        }
        const digLim =
            typeof window !== 'undefined' && window.digSiteLimitsModule
                ? window.digSiteLimitsModule
                : null;
        if (digLim && window.map && digLim.exceedsMaxAreaSqFeet(window.map, site.polygonGeoJson)) {
            return {
                ok: false,
                hint:
                    'Dig area exceeds USAN maximum (' +
                    digLim.formatAreaSqFt(digLim.MAX_AREA_SQ_FT) +
                    ')',
            };
        }
        if (!String(site.nearestCrossStreet || '').trim()) {
            return { ok: false, hint: 'Enter nearest cross street' };
        }
        if (crossValidate) {
            const cross = crossValidate(site.nearestCrossStreet);
            if (!cross.ok) {
                return { ok: false, hint: cross.message || 'Invalid nearest cross street' };
            }
        }
        if (!String(site.scope || '').trim()) {
            return { ok: false, hint: 'Enter description of work' };
        }
        return { ok: true, hint: 'Ready' };
    }

    function digSiteCardMarkup(site, index) {
        const activeCls = activeDrawSiteIndex === index ? ' is-active-draw' : '';
        const collapsedCls = site.uiCollapsed ? ' is-collapsed' : '';
        const canRemove = digSites.length > 1;
        const readiness = evaluateDigSiteReadiness(site);
        const statusCls = readiness.ok
            ? ' bulk-create-mock-dig-site-status--ready'
            : ' bulk-create-mock-dig-site-status--not-ready';
        const summaryText = readiness.ok
            ? siteAddressSummary(site) || 'Ready'
            : readiness.hint;
        const expanded = !site.uiCollapsed;
        return (
            '<article class="bulk-create-mock-dig-site-card' +
            activeCls +
            collapsedCls +
            '" data-dig-site-index="' +
            index +
            '" data-dig-site-id="' +
            esc(site.id) +
            '">' +
            '<div class="bulk-create-mock-dig-site-card-head">' +
            '<button type="button" class="bulk-create-mock-dig-site-toggle" data-dig-site-toggle="' +
            index +
            '" aria-expanded="' +
            (expanded ? 'true' : 'false') +
            '">' +
            '<span class="bulk-create-mock-dig-site-status' +
            statusCls +
            '" data-dig-site-status="' +
            index +
            '" title="' +
            esc(readiness.hint) +
            '" aria-label="' +
            esc(readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint) +
            '"></span>' +
            '<span class="bulk-create-mock-dig-site-toggle-text">' +
            '<span class="bulk-create-mock-dig-site-label">Dig site ' +
            (index + 1) +
            '</span>' +
            '<span class="bulk-create-mock-dig-site-summary" data-dig-site-summary="' +
            index +
            '">' +
            esc(summaryText) +
            '</span>' +
            '</span>' +
            '<span class="bulk-create-mock-dig-site-chevron" aria-hidden="true"></span>' +
            '</button>' +
            (canRemove
                ? '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bulk-create-remove-site="' +
                  index +
                  '">Remove</button>'
                : '') +
            '</div>' +
            '<div class="bulk-create-mock-dig-site-body"' +
            (expanded ? '' : ' hidden') +
            '>' +
            '<div class="create-ticket-field create-ticket-field--map-polygon">' +
            '<div class="create-ticket-polygon-actions">' +
            '<button type="button" class="ticket-hub-tool-btn" data-bulk-create-draw="' +
            index +
            '">Draw polygon</button>' +
            '<button type="button" class="ticket-hub-tool-btn" data-bulk-create-draw-circle="' +
            index +
            '">Draw circle</button>' +
            '<button type="button" class="ticket-hub-tool-btn" data-bulk-create-draw-line="' +
            index +
            '">Draw line</button>' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bulk-create-clear-polygon="' +
            index +
            '"' +
            (site.polygonGeoJson ? '' : ' disabled') +
            '>Clear area</button>' +
            '</div>' +
            '<p class="create-ticket-polygon-status" aria-live="polite">' +
            '</p>' +
            '</div>' +
            digSiteAddressFieldsMarkup(site, index) +
            '<div class="create-ticket-field">' +
            '<label for="bcwCross-' +
            esc(site.id) +
            '">Nearest cross street</label>' +
            '<input type="text" id="bcwCross-' +
            esc(site.id) +
            '" class="bulk-create-mock-cross" data-dig-site-cross="' +
            index +
            '" value="' +
            esc(site.nearestCrossStreet) +
            '" placeholder="e.g. Oak Ave" autocomplete="off" />' +
            '</div>' +
            '<div class="create-ticket-field">' +
            '<label for="bcwScope-' +
            esc(site.id) +
            '">Scope of work</label>' +
            '<textarea id="bcwScope-' +
            esc(site.id) +
            '" class="bulk-create-mock-scope" data-dig-site-scope="' +
            index +
            '" rows="4" placeholder="Enter your scope of work for this dig site…">' +
            esc(site.scope) +
            '</textarea>' +
            '</div>' +
            '</div>' +
            '</article>'
        );
    }

    function stepNavMarkup() {
        return (
            '<nav class="create-ticket-wizard-nav-wrap bulk-create-mock-nav" aria-label="Create ticket steps">' +
            '<div class="create-ticket-wizard-nav">' +
            BULK_WIZARD_STEPS.map(function (s) {
                const active = activeBulkStep === s.id;
                return (
                    '<button type="button" class="create-ticket-wizard-nav-btn' +
                    (active ? ' is-active' : '') +
                    '" data-bulk-create-step="' +
                    esc(s.id) +
                    '"><span class="create-ticket-wizard-nav-num">' +
                    s.num +
                    '</span> ' +
                    esc(s.label) +
                    '</button>'
                );
            }).join('') +
            '</div></nav>'
        );
    }

    function mapLocationSearchMarkup() {
        return (
            '<div class="create-ticket-wizard-block bulk-create-mock-map-location">' +
            wizardBlockHeadMarkup('Map location', 'map-location') +
            '<div class="create-ticket-field create-ticket-field--map-search">' +
            '<label for="bcwMapCenterSearch">Address to center the map</label>' +
            '<div class="create-ticket-address-search-wrap">' +
            '<input type="search" id="bcwMapCenterSearch" class="address-input create-ticket-address-search" data-create-ticket-map-search placeholder="Address or intersection…" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="search" enterkeyhint="search" value="' +
            esc(mapCenterSearchQuery) +
            '" />' +
            '<div class="location-loading-indicator create-ticket-map-search-loading" data-create-ticket-map-search-loading hidden>' +
            '<span class="location-loading-spinner" aria-hidden="true"></span>' +
            '<span>Searching for address…</span>' +
            '</div>' +
            '<div class="address-suggestions create-ticket-address-suggestions" data-create-ticket-map-suggestions></div>' +
            '</div>' +
            '<div class="create-ticket-map-center-actions">' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-create-ticket-map-my-location>Use my location</button>' +
            '</div>' +
            '<p class="create-ticket-map-center-status" aria-live="polite">' +
            esc(mapCenterSearchStatus) +
            '</p>' +
            '</div></div>'
        );
    }

    function mapLocationOutsideFormMarkup() {
        const hidden = activeBulkStep !== 'dig-sites' ? ' hidden' : '';
        return (
            '<div class="bulk-create-mock-step bulk-create-mock-map-location-outside-form"' +
            hidden +
            ' data-bulk-create-step-panel="dig-sites">' +
            mapLocationSearchMarkup() +
            '</div>'
        );
    }

    function digSitesSectionMarkup() {
        const cards = digSites
            .map(function (site, i) {
                return digSiteCardMarkup(site, i);
            })
            .join('');
        const hidden = activeBulkStep !== 'dig-sites' ? ' hidden' : '';
        return (
            '<section id="bulkCreateStepDigSites" class="bulk-create-mock-step"' +
            hidden +
            ' data-bulk-create-step-panel="dig-sites">' +
            wizardStepHeadMarkup('dig-sites-step') +
            '<div class="bulk-create-mock-dig-sites-head">' +
            '<h4 class="bulk-create-mock-dig-sites-title">Dig sites (' +
            digSites.length +
            ')</h4>' +
            '<button type="button" class="ticket-hub-tool-btn" data-bulk-create-add-site' +
            (digSites.length >= MAX_DIG_SITES ? ' disabled' : '') +
            '>Add dig site</button>' +
            '</div>' +
            '<div id="bulkCreateDigSitesList">' +
            cards +
            '</div>' +
            '</section>'
        );
    }

    function sharedBlockHeadMarkup(readiness) {
        readiness = readiness || { ok: false, hint: 'Complete shared ticket details' };
        const statusCls = readiness.ok
            ? ' bulk-create-mock-dig-site-status--ready'
            : ' bulk-create-mock-dig-site-status--not-ready';
        const summaryText = readiness.ok ? 'Ready' : readiness.hint;
        return (
            '<div class="create-ticket-wizard-block-head bulk-create-mock-shared-block-head">' +
            '<span class="bulk-create-mock-dig-site-status' +
            statusCls +
            '" data-shared-step-status title="' +
            esc(readiness.hint) +
            '" aria-label="' +
            esc(readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint) +
            '"></span>' +
            '<div class="bulk-create-mock-shared-step-head-text">' +
            '<span class="create-ticket-wizard-block-label">Shared ticket details</span>' +
            '<span class="bulk-create-mock-dig-site-summary" data-shared-step-summary>' +
            esc(summaryText) +
            '</span>' +
            '</div>' +
            wizardInfoButtonMarkup('shared-step') +
            '</div>'
        );
    }

    function sharedPresetsOptionsHtml(selectedId) {
        const api = global.createTicketWizardPresetsApi;
        let html = '<option value="">Apply preset…</option>';
        if (!api || typeof api.listPresets !== 'function') return html;
        const selected = selectedId != null ? String(selectedId) : '';
        api.listPresets().forEach(function (p) {
            if (!p || p.id == null) return;
            const id = String(p.id);
            html +=
                '<option value="' +
                esc(id) +
                '"' +
                (id === selected ? ' selected' : '') +
                '>' +
                esc(p.name || 'Untitled') +
                '</option>';
        });
        return html;
    }

    function sharedPresetsBarMarkup(selectedId) {
        return (
            '<div class="create-ticket-presets-bar" data-create-ticket-presets-bar>' +
            '<div class="create-ticket-presets-field">' +
            '<label class="create-ticket-presets-label" for="bcwSharedPreset">Saved preset</label>' +
            '<div class="create-ticket-presets-bar-row">' +
            '<div class="create-ticket-presets-select-wrap">' +
            '<select id="bcwSharedPreset" name="bcwSharedPreset" class="create-ticket-presets-select">' +
            sharedPresetsOptionsHtml(selectedId) +
            '</select>' +
            '</div>' +
            '<button type="button" class="ticket-hub-tool-btn" data-bcw-preset-apply>Apply</button>' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bcw-preset-save>Save as…</button>' +
            '</div>' +
            '</div>' +
            '<div class="create-ticket-presets-bar-row create-ticket-presets-bar-row--manage" data-bcw-preset-manage hidden>' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bcw-preset-update>Update</button>' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bcw-preset-rename>Rename…</button>' +
            '<button type="button" class="ticket-hub-tool-btn ticket-hub-tool-btn-muted" data-bcw-preset-delete>Delete</button>' +
            '</div>' +
            '</div>'
        );
    }

    function syncSharedPresetsUi(root, keepSelectedId) {
        if (!root) return;
        const select = qs('#bcwSharedPreset', root);
        if (!select) return;
        const selected =
            keepSelectedId != null ? String(keepSelectedId) : String(select.value || '');
        select.innerHTML = sharedPresetsOptionsHtml(selected);
        let hasSelected = false;
        for (let i = 0; i < select.options.length; i++) {
            if (String(select.options[i].value) === selected) {
                hasSelected = true;
                break;
            }
        }
        select.value = hasSelected ? selected : '';
        const manage = qs('[data-bcw-preset-manage]', root);
        if (manage) {
            if (select.value) manage.removeAttribute('hidden');
            else manage.setAttribute('hidden', '');
        }
        const saveBtn = qs('[data-bcw-preset-save]', root);
        const api = global.createTicketWizardPresetsApi;
        if (saveBtn && api && typeof api.atCapacity === 'function') {
            const full = api.atCapacity();
            saveBtn.disabled = full;
            saveBtn.title = full
                ? 'Maximum of ' + api.MAX_PRESETS + ' presets reached. Delete one to save another.'
                : 'Save current shared details as a new preset';
        }
    }

    function bindSharedPresetsHandlers(root) {
        const bar = qs('[data-create-ticket-presets-bar]', root);
        if (!bar || bar.dataset.presetsBound === '1') return;
        bar.dataset.presetsBound = '1';
        const api = global.createTicketWizardPresetsApi;
        const select = qs('#bcwSharedPreset', root);

        function selectedId() {
            return select && select.value ? String(select.value) : '';
        }

        function alertErr(e, fallback) {
            const msg = e && e.message ? String(e.message) : fallback || 'Something went wrong.';
            if (typeof global.appAlert === 'function') global.appAlert(msg);
            else window.alert(msg);
        }

        if (select) {
            select.addEventListener('change', function () {
                syncSharedPresetsUi(root, select.value);
            });
        }

        const applyBtn = qs('[data-bcw-preset-apply]', root);
        if (applyBtn) {
            applyBtn.addEventListener('click', function () {
                const id = selectedId();
                if (!id) {
                    alertErr(null, 'Select a preset to apply.');
                    return;
                }
                void applySharedPresetToForm(root, id).catch(function (e) {
                    alertErr(e, 'Could not apply preset.');
                });
            });
        }

        const saveBtn = qs('[data-bcw-preset-save]', root);
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                void (async function () {
                    if (!api || typeof api.saveNew !== 'function') {
                        alertErr(null, 'Presets are not available.');
                        return;
                    }
                    if (api.atCapacity && api.atCapacity()) {
                        alertErr(null, 'You can save up to ' + api.MAX_PRESETS + ' presets. Delete one before saving another.');
                        return;
                    }
                    const name =
                        typeof global.appPrompt === 'function'
                            ? await global.appPrompt('Name for this preset', '', {
                                  title: 'Save preset',
                                  confirmText: 'Save',
                              })
                            : window.prompt('Name for this preset', '');
                    if (name == null) return;
                    try {
                        const shared = collectSharedFromForm(root);
                        const preset = await api.saveNew(name, shared);
                        syncSharedPresetsUi(root, preset && preset.id);
                        if (typeof global.appAlert === 'function') {
                            global.appAlert('Preset saved.');
                        }
                    } catch (e) {
                        alertErr(e, 'Could not save preset.');
                    }
                })();
            });
        }

        const updateBtn = qs('[data-bcw-preset-update]', root);
        if (updateBtn) {
            updateBtn.addEventListener('click', function () {
                void (async function () {
                    const id = selectedId();
                    if (!id || !api || typeof api.updateFields !== 'function') {
                        alertErr(null, 'Select a preset to update.');
                        return;
                    }
                    const existing = api.getById(id);
                    const label = existing && existing.name ? existing.name : 'this preset';
                    const ok =
                        typeof global.appConfirm === 'function'
                            ? await global.appConfirm(
                                  'Overwrite "' + label + '" with the current shared details?',
                                  { title: 'Update preset', confirmText: 'Update' }
                              )
                            : window.confirm('Overwrite "' + label + '" with the current shared details?');
                    if (!ok) return;
                    try {
                        await api.updateFields(id, collectSharedFromForm(root));
                        syncSharedPresetsUi(root, id);
                        if (typeof global.appAlert === 'function') {
                            global.appAlert('Preset updated.');
                        }
                    } catch (e) {
                        alertErr(e, 'Could not update preset.');
                    }
                })();
            });
        }

        const renameBtn = qs('[data-bcw-preset-rename]', root);
        if (renameBtn) {
            renameBtn.addEventListener('click', function () {
                void (async function () {
                    const id = selectedId();
                    if (!id || !api || typeof api.rename !== 'function') {
                        alertErr(null, 'Select a preset to rename.');
                        return;
                    }
                    const existing = api.getById(id);
                    const currentName = existing && existing.name ? String(existing.name) : '';
                    const name =
                        typeof global.appPrompt === 'function'
                            ? await global.appPrompt('New name for this preset', currentName, {
                                  title: 'Rename preset',
                                  confirmText: 'Rename',
                              })
                            : window.prompt('New name for this preset', currentName);
                    if (name == null) return;
                    try {
                        await api.rename(id, name);
                        syncSharedPresetsUi(root, id);
                    } catch (e) {
                        alertErr(e, 'Could not rename preset.');
                    }
                })();
            });
        }

        const deleteBtn = qs('[data-bcw-preset-delete]', root);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function () {
                void (async function () {
                    const id = selectedId();
                    if (!id || !api || typeof api.remove !== 'function') {
                        alertErr(null, 'Select a preset to delete.');
                        return;
                    }
                    const existing = api.getById(id);
                    const label = existing && existing.name ? existing.name : 'this preset';
                    const ok =
                        typeof global.appConfirm === 'function'
                            ? await global.appConfirm('Delete preset "' + label + '"?', {
                                  title: 'Delete preset',
                                  confirmText: 'Delete',
                              })
                            : window.confirm('Delete preset "' + label + '"?');
                    if (!ok) return;
                    try {
                        await api.remove(id);
                        syncSharedPresetsUi(root, '');
                    } catch (e) {
                        alertErr(e, 'Could not delete preset.');
                    }
                })();
            });
        }

        syncSharedPresetsUi(root, select ? select.value : '');
    }

    async function applySharedPresetToForm(root, presetId) {
        const api = global.createTicketWizardPresetsApi;
        if (!api || typeof api.getById !== 'function') {
            if (typeof global.appAlert === 'function') global.appAlert('Presets are not available.');
            return;
        }
        const preset = api.getById(presetId);
        if (!preset || !preset.fields) {
            if (typeof global.appAlert === 'function') global.appAlert('Preset not found.');
            return;
        }
        const fields = api.cloneFields ? api.cloneFields(preset.fields) : preset.fields;
        const ticketTypeEl = qs('#bcwTicketType', root);
        const currentType = normalizeTicketTypeValue(ticketTypeEl && ticketTypeEl.value);
        const nextType = normalizeTicketTypeValue(fields.ticketType || 'Normal');
        if (currentType !== nextType || !wizardLookupsRef) {
            await reloadLookupsForTicketType(root, nextType);
        }
        const ackAcc = qs('#bcwAckAccuracy', root);
        const ackPriv = qs('#bcwAckPrivateLines', root);
        const ackShort = qs('#bcwAckShort', root);
        const ackEmergency = qs('#bcwAckEmergency', root);
        lastSharedFormSnapshot = Object.assign({}, fields, {
            ackAccuracy: !!(ackAcc && ackAcc.checked),
            ackPrivateLines: !!(ackPriv && ackPriv.checked),
            ackShort: !!(ackShort && ackShort.checked),
            ackEmergency: !!(ackEmergency && ackEmergency.checked),
        });
        applySharedFormSnapshot(root);
        syncSharedPresetsUi(root, presetId);
    }

    function sharedFieldsMarkup() {
        const root = overlayRoot();
        const readiness = root
            ? evaluateSharedReadiness(root)
            : { ok: false, hint: 'Complete shared ticket details', errors: [] };
        return (
            '<div class="create-ticket-wizard-block bulk-create-mock-shared-block">' +
            sharedBlockHeadMarkup(readiness) +
            sharedPresetsBarMarkup('') +
            '<div class="create-ticket-field"><label for="bcwJobName">Job / project name</label>' +
            '<input type="text" id="bcwJobName" name="bcwJobName" placeholder="e.g. Main St fiber install" autocomplete="off" /></div>' +
            '<div class="create-ticket-field"><label for="bcwPrincipalName">Principal contact name</label>' +
            '<input type="text" id="bcwPrincipalName" name="bcwPrincipalName" maxlength="40" autocomplete="name" /></div>' +
            '<div class="create-ticket-field"><label for="bcwPrincipalMobile">Principal contact mobile</label>' +
            '<input type="tel" id="bcwPrincipalMobile" name="bcwPrincipalMobile" maxlength="10" inputmode="numeric" pattern="[0-9]{10}" autocomplete="tel" /></div>' +
            '<div class="create-ticket-field"><label for="bcwTicketType">Ticket Type</label>' +
            '<select id="bcwTicketType" name="bcwTicketType">' +
            '<option value="Normal" selected>Normal</option>' +
            '<option value="Short">Short</option>' +
            '<option value="Emergency">Emergency</option>' +
            '</select></div>' +
            '<div class="create-ticket-field"><label for="bcwWorkType">Type of Work</label>' +
            '<select id="bcwWorkType" name="bcwWorkType">' +
            workTypeOptionsHtml() +
            '</select></div>' +
            '<div class="create-ticket-field"><label for="bcwWorkActivity">Work Activity</label>' +
            '<select id="bcwWorkActivity" name="bcwWorkActivity" disabled data-search-placeholder="Search work activity…"><option value="">Select type of work first…</option></select></div>' +
            '<div class="create-ticket-field"><label for="bcwExcavationMethod">Excavation Method</label>' +
            '<select id="bcwExcavationMethod" name="bcwExcavationMethod">' +
            excavationOptionsHtml() +
            '</select></div>' +
            '<div class="create-ticket-field create-ticket-field--yesno" role="group"><div class="create-ticket-yesno-inner">' +
            '<span class="create-ticket-yesno-legend">Will you be performing horizontal/directional boring?</span>' +
            '<div class="create-ticket-yesno-row">' +
            yesNoRadios('bcwHorizontalBoring') +
            '</div></div></div>' +
            '<div class="create-ticket-field create-ticket-field--yesno" role="group"><div class="create-ticket-yesno-inner">' +
            '<span class="create-ticket-yesno-legend">Will explosives/blasting be used?</span>' +
            '<div class="create-ticket-yesno-row">' +
            yesNoRadios('bcwExplosives') +
            '</div></div></div>' +
            '<div class="create-ticket-field create-ticket-field--yesno" role="group"><div class="create-ticket-yesno-inner">' +
            '<span class="create-ticket-yesno-legend">Will excavation occur in the street, sidewalk, or parkstrip?</span>' +
            '<div class="create-ticket-yesno-row">' +
            yesNoRadios('bcwStreetSidewalkParkstrip') +
            '</div></div></div>' +
            '<div class="create-ticket-field"><label for="bcwPermitExcavation">Do you have a permit for excavation?</label>' +
            '<select id="bcwPermitExcavation" name="bcwPermitExcavation">' +
            permitExcavationOptionsHtml() +
            '</select></div>' +
            '<div class="create-ticket-field"><label for="bcwAreaPreMarked">How is the area pre-marked (delineated)?</label>' +
            '<select id="bcwAreaPreMarked" name="bcwAreaPreMarked">' +
            areaPreMarkedOptionsHtml() +
            '</select></div>' +
            '<div class="create-ticket-field"><label for="bcwStartDate">Planned work start date</label>' +
            '<input type="date" id="bcwStartDate" name="bcwStartDate" required />' +
            '<p class="create-ticket-field-hint" id="bcwStartDateHint"></p></div>' +
            '<div class="create-ticket-field"><label for="bcwStartTime">Work start time</label>' +
            '<input type="time" id="bcwStartTime" name="bcwStartTime" value="07:00" step="60" required /></div>' +
            '<div class="create-ticket-field"><label for="bcwProjectOwnerType">Project Owner Type</label>' +
            '<select id="bcwProjectOwnerType" name="bcwProjectOwnerType">' +
            projectOwnerTypeOptionsHtml() +
            '</select></div>' +
            '<div class="create-ticket-field"><label for="bcwProjectOwnerName">Project owner name</label>' +
            '<select id="bcwProjectOwnerName" name="bcwProjectOwnerName" disabled data-search-placeholder="Search project owner…">' +
            '<option value="">Select project owner type first…</option></select></div>' +
            '</div>'
        );
    }

    function sharedSectionMarkup() {
        const hidden = activeBulkStep !== 'shared' ? ' hidden' : '';
        return (
            '<section id="bulkCreateStepShared" class="bulk-create-mock-step"' +
            hidden +
            ' data-bulk-create-step-panel="shared">' +
            sharedFieldsMarkup() +
            '</section>'
        );
    }

    function acknowledgmentBlockHeadMarkup(readiness) {
        readiness = readiness || { ok: false, hint: 'Check both acknowledgment boxes' };
        const statusCls = readiness.ok
            ? ' bulk-create-mock-dig-site-status--ready'
            : ' bulk-create-mock-dig-site-status--not-ready';
        const summaryText = readiness.ok ? 'Ready' : readiness.hint;
        return (
            '<div class="create-ticket-wizard-block-head bulk-create-mock-ack-block-head">' +
            '<span class="bulk-create-mock-dig-site-status' +
            statusCls +
            '" data-ack-step-status title="' +
            esc(readiness.hint) +
            '" aria-label="' +
            esc(readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint) +
            '"></span>' +
            '<div class="bulk-create-mock-shared-step-head-text">' +
            '<span class="create-ticket-ack-legend">Acknowledgments</span>' +
            '<span class="bulk-create-mock-dig-site-summary" data-ack-step-summary>' +
            esc(summaryText) +
            '</span>' +
            '</div>' +
            wizardInfoButtonMarkup('finalize') +
            '</div>'
        );
    }

    function finalizeSectionMarkup() {
        const hidden = activeBulkStep !== 'finalize' ? ' hidden' : '';
        const root = overlayRoot();
        const readiness = root
            ? evaluateAcknowledgmentReadiness(root)
            : { ok: false, hint: 'Check both acknowledgment boxes', errors: [] };
        return (
            '<section id="bulkCreateStepFinalize" class="bulk-create-mock-step"' +
            hidden +
            ' data-bulk-create-step-panel="finalize">' +
            '<div class="create-ticket-wizard-block">' +
            acknowledgmentBlockHeadMarkup(readiness) +
            '<div class="create-ticket-field create-ticket-field--ack" role="group">' +
            '<div class="create-ticket-ack-row">' +
            '<input type="checkbox" id="bcwAckAccuracy" name="bcwAckAccuracy" value="yes" />' +
            '<label for="bcwAckAccuracy" class="create-ticket-ack-label">By checking this box I confirm that the dig site location, drawn dig site’s shape and dimensions, description of work, and all other details provided on this ticket are accurate and complete. Additionally I understand that it is my responsibility to receive a positive response from each utility member listed on my ticket before beginning my excavation work.</label>' +
            '</div></div>' +
            '<div class="create-ticket-field create-ticket-field--ack" role="group">' +
            '<div class="create-ticket-ack-row">' +
            '<input type="checkbox" id="bcwAckPrivateLines" name="bcwAckPrivateLines" value="yes" />' +
            '<label for="bcwAckPrivateLines" class="create-ticket-ack-label">By checking this box I understand that only utility operators who are members of Underground Service Alert are going to be notified on this ticket. Those utility members are only responsible for facilities that they own and operate in the area of the dig. Any other lines or services not owned and operated by a utility member (irrigation lines, power to a detached shed or garage, water/sewer laterals, etc) would be considered a private line, and would require the services of a private line locator to be identified.</label>' +
            '</div></div>' +
            '<div id="bcwShortAckWrap" class="create-ticket-field create-ticket-field--ack" role="group" hidden>' +
            '<span class="create-ticket-ack-subtitle">Short</span>' +
            '<div class="create-ticket-ack-row">' +
            '<input type="checkbox" id="bcwAckShort" name="bcwAckShort" value="yes" />' +
            '<label for="bcwAckShort" class="create-ticket-ack-label">By checking this box I confirm that I understand that I have given less notice than the legal requirement. As a result, I understand that if I begin excavation prior to all utility members responding to my ticket that I may be liable for damages caused during the excavation. Underground Service Alert advises you to alter you start time to give a minimum of the legal required notice, if possible, and wait until you have a positive response from all utility members before proceeding with your dig.</label>' +
            '</div></div>' +
            '<div id="bcwEmergencyAckWrap" class="create-ticket-field create-ticket-field--ack" role="group" hidden>' +
            '<span class="create-ticket-ack-subtitle">Emergency</span>' +
            '<div class="create-ticket-ack-row">' +
            '<input type="checkbox" id="bcwAckEmergency" name="bcwAckEmergency" value="yes" />' +
            '<label for="bcwAckEmergency" class="create-ticket-ack-label">By checking this box I confirm that the work being performed on this ticket meets the definition for emergency work as outlined by NRS 455.090: &quot;Emergency&quot; means a sudden, unexpected occurrence that involves clear and imminent danger and requires immediate action to prevent or mitigate loss of life or damage to health, property or essential public services.</label>' +
            '</div></div></div>' +
            '</section>'
        );
    }

    function footerMarkupForStep() {
        let inner = '';
        if (activeBulkStep === 'dig-sites') {
            inner +=
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-bulk-create-next="shared">Next: shared details</button>';
        } else if (activeBulkStep === 'shared') {
            inner +=
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-bulk-create-back="dig-sites">Back</button>' +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-bulk-create-next="finalize">Next: acknowledgments</button>';
        } else {
            inner +=
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-bulk-create-back="shared">Back</button>' +
                (canPreviewUsanPayload()
                    ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-bulk-create-dry-run>Dry run</button>'
                    : '') +
                '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-bulk-create-submit>Submit ' +
                digSites.length +
                ' ticket' +
                (digSites.length === 1 ? '' : 's') +
                ' to USAN</button>';
        }
        return '<div class="ticket-hub-mock-footer">' + inner + '</div>';
    }

    function formStepMarkup() {
        const title = cloneSourceLabel ? 'Clone ticket' : 'Create ticket';
        const banner = cloneSourceLabel
            ? '<p class="ticket-hub-mock-hint create-ticket-clone-banner">' + esc(cloneSourceLabel) + '</p>'
            : '';
        return (
            createTicketWizardHeaderMarkup(title) +
            banner +
            stepNavMarkup() +
            '<div class="bulk-create-mock-body">' +
            mapLocationOutsideFormMarkup() +
            '<form id="bulkCreateTicketsMockForm" onsubmit="return false;">' +
            digSitesSectionMarkup() +
            sharedSectionMarkup() +
            finalizeSectionMarkup() +
            '</form></div>' +
            footerMarkupForStep()
        );
    }

    /** @returns {{ ok: boolean, siteRows: { index: number, label: string, ok: boolean, hint: string }[] }} */
    function validateDigSitesStep(root) {
        readDigSitesFromDom(root);
        const siteRows = digSites.map(function (site, index) {
            const readiness = evaluateDigSiteReadiness(site);
            return {
                index: index,
                label: 'Dig site ' + (index + 1),
                ok: readiness.ok,
                hint: readiness.hint,
            };
        });
        return {
            ok: siteRows.every(function (r) {
                return r.ok;
            }),
            siteRows: siteRows,
        };
    }

    function showDigSitesStepBlockedMessage(root, validation) {
        const notReady = (validation.siteRows || []).filter(function (r) {
            return !r.ok;
        });
        const lines = notReady.map(function (r) {
            return r.label + ': ' + r.hint;
        });
        const msg = lines.length
            ? 'Complete every dig site before continuing:\n\n' + lines.join('\n')
            : 'Complete every dig site before continuing.';
        if (typeof global.appAlert === 'function') {
            void global.appAlert(msg, { title: 'Dig sites not ready' });
        }
        notReady.forEach(function (r) {
            setDigSiteCollapsed(root, r.index, false);
        });
        updateDigSiteReadinessIndicators(root);
        if (notReady.length) {
            const card = qs('[data-dig-site-index="' + notReady[0].index + '"]', root);
            if (card && typeof card.scrollIntoView === 'function') {
                try {
                    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } catch (_) {
                    /* ignore */
                }
            }
        }
    }

    function bulkStepOrder(stepId) {
        const order = { 'dig-sites': 0, shared: 1, finalize: 2 };
        return order[stepId] != null ? order[stepId] : -1;
    }

    function showSharedStepBlockedMessage(root, validation) {
        const errors = validation.errors || [];
        const msg = errors.length
            ? 'Complete shared ticket details before continuing:\n\n' + errors.join('\n')
            : 'Complete shared ticket details before continuing.';
        if (typeof global.appAlert === 'function') {
            void global.appAlert(msg, { title: 'Shared details not ready' });
        }
        updateSharedReadinessIndicator(root);
        const head = qs('.bulk-create-mock-shared-block-head', root);
        if (head && typeof head.scrollIntoView === 'function') {
            try {
                head.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (_) {
                /* ignore */
            }
        }
    }

    /** @returns {boolean} */
    function tryAdvanceBulkStep(root, targetStepId) {
        const currentOrder = bulkStepOrder(activeBulkStep);
        const targetOrder = bulkStepOrder(targetStepId);
        if (targetOrder < 0) return false;
        if (targetOrder > currentOrder && targetOrder >= 1) {
            const digValidation = validateDigSitesStep(root);
            if (!digValidation.ok) {
                showDigSitesStepBlockedMessage(root, digValidation);
                return false;
            }
        }
        if (targetOrder > currentOrder && targetOrder >= 2) {
            const sharedValidation = validateSharedStep(root);
            if (!sharedValidation.ok) {
                showSharedStepBlockedMessage(root, sharedValidation);
                if (activeBulkStep !== 'shared') {
                    applyBulkStepToDom(root, 'shared');
                }
                return false;
            }
        }
        if (activeBulkStep === 'shared') snapshotSharedForm(root);
        applyBulkStepToDom(root, targetStepId);
        return true;
    }

    function applyBulkStepToDom(root, stepId) {
        activeBulkStep = stepId;
        BULK_WIZARD_STEPS.forEach(function (s) {
            const panels = root.querySelectorAll('[data-bulk-create-step-panel="' + s.id + '"]');
            for (let pi = 0; pi < panels.length; pi++) {
                const panel = panels[pi];
                if (s.id === stepId) {
                    panel.removeAttribute('hidden');
                    panel.classList.remove('hidden');
                } else {
                    panel.setAttribute('hidden', '');
                    panel.classList.add('hidden');
                }
            }
            const navBtn = qs('[data-bulk-create-step="' + s.id + '"]', root);
            if (navBtn) {
                if (s.id === stepId) navBtn.classList.add('is-active');
                else navBtn.classList.remove('is-active');
            }
        });
        const footer = qs('.ticket-hub-mock-footer', root);
        if (footer) {
            const tmp = document.createElement('div');
            tmp.innerHTML = footerMarkupForStep();
            const nextFooter = tmp.firstElementChild;
            if (nextFooter) footer.replaceWith(nextFooter);
        }
        const body = qs('.bulk-create-mock-body', root);
        if (body) body.scrollTop = 0;
        if (stepId === 'shared') {
            if (lastSharedFormSnapshot) {
                applySharedFormSnapshot(root);
            } else {
                applyDefaultSharedFormValues(root);
            }
            applyCommencementDateConstraints(root);
            void refreshCommencementDatesFromUsan(root);
            updateSharedReadinessIndicator(root);
            syncSharedPresetsUi(root);
        }
        if (stepId === 'finalize') {
            syncTicketTypeAckVisibility(root);
            updateAcknowledgmentReadinessIndicator(root);
        }
        syncCreateTicketWizardMapTools();
    }

    function updateAcknowledgmentReadinessIndicator(root) {
        const readiness = evaluateAcknowledgmentReadiness(root);
        const bubble = qs('[data-ack-step-status]', root);
        const summary = qs('[data-ack-step-summary]', root);
        if (bubble) {
            bubble.classList.toggle('bulk-create-mock-dig-site-status--ready', readiness.ok);
            bubble.classList.toggle('bulk-create-mock-dig-site-status--not-ready', !readiness.ok);
            bubble.setAttribute('title', readiness.hint);
            bubble.setAttribute(
                'aria-label',
                readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint
            );
        }
        if (summary) {
            summary.textContent = readiness.ok ? 'Ready' : readiness.hint;
        }
    }

    function bindAcknowledgmentReadinessHandlers(root) {
        const panel = qs('#bulkCreateStepFinalize', root);
        if (!panel || panel.dataset.ackReadinessBound === '1') return;
        panel.dataset.ackReadinessBound = '1';
        panel.addEventListener('change', function (ev) {
            if (
                !ev.target ||
                (ev.target.id !== 'bcwAckAccuracy' &&
                    ev.target.id !== 'bcwAckPrivateLines' &&
                    ev.target.id !== 'bcwAckShort' &&
                    ev.target.id !== 'bcwAckEmergency')
            ) {
                return;
            }
            updateAcknowledgmentReadinessIndicator(root);
        });
    }

    function showAcknowledgmentBlockedMessage(root, validation) {
        const errors = validation.errors || [];
        const msg = errors.length
            ? errors.join('\n')
            : 'Check both acknowledgment boxes before submitting.';
        if (typeof global.appAlert === 'function') {
            void global.appAlert(msg, { title: 'Acknowledgments required' });
        }
        updateAcknowledgmentReadinessIndicator(root);
        const head = qs('.bulk-create-mock-ack-block-head', root);
        if (head && typeof head.scrollIntoView === 'function') {
            try {
                head.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } catch (_) {
                /* ignore */
            }
        }
    }

    function showSubmitBlockedMessage(root, validation) {
        const lines = (validation.sharedErrors || []).slice();
        (validation.siteRows || []).forEach(function (r) {
            if (!r.ok) lines.push(r.label + ': ' + r.hint);
        });
        const msg = lines.length
            ? 'Complete the following before submitting:\n\n' + lines.join('\n')
            : 'Complete all steps before submitting.';
        if (typeof global.appAlert === 'function') {
            void global.appAlert(msg, { title: 'Cannot submit yet' });
        }
    }

    function updateSharedReadinessIndicator(root) {
        const readiness = evaluateSharedReadiness(root);
        const bubble = qs('[data-shared-step-status]', root);
        const summary = qs('[data-shared-step-summary]', root);
        if (bubble) {
            bubble.classList.toggle('bulk-create-mock-dig-site-status--ready', readiness.ok);
            bubble.classList.toggle('bulk-create-mock-dig-site-status--not-ready', !readiness.ok);
            bubble.setAttribute('title', readiness.hint);
            bubble.setAttribute(
                'aria-label',
                readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint
            );
        }
        if (summary) {
            summary.textContent = readiness.ok ? 'Ready' : readiness.hint;
        }
    }

    function bindPrincipalContactInputFilters(root) {
        const nameEl = qs('#bcwPrincipalName', root);
        if (nameEl && nameEl.dataset.principalFilterBound !== '1') {
            nameEl.dataset.principalFilterBound = '1';
            nameEl.addEventListener('input', function () {
                const filtered = String(nameEl.value || '')
                    .replace(/[^A-Za-z ]/g, '')
                    .slice(0, 40);
                if (filtered !== nameEl.value) nameEl.value = filtered;
            });
        }
        const mobileEl = qs('#bcwPrincipalMobile', root);
        if (mobileEl && mobileEl.dataset.principalFilterBound !== '1') {
            mobileEl.dataset.principalFilterBound = '1';
            mobileEl.addEventListener('input', function () {
                const filtered = String(mobileEl.value || '')
                    .replace(/\D/g, '')
                    .slice(0, 10);
                if (filtered !== mobileEl.value) mobileEl.value = filtered;
            });
        }
    }

    function bindSharedReadinessHandlers(root) {
        const panel = qs('#bulkCreateStepShared', root);
        if (!panel || panel.dataset.sharedReadinessBound === '1') return;
        panel.dataset.sharedReadinessBound = '1';
        bindPrincipalContactInputFilters(root);
        const refresh = function () {
            updateSharedReadinessIndicator(root);
        };
        panel.addEventListener('input', refresh);
        panel.addEventListener('change', refresh);
    }

    function updateDigSiteReadinessIndicators(root) {
        readDigSitesFromDom(root);
        digSites.forEach(function (site, index) {
            const card = qs('[data-dig-site-index="' + index + '"]', root);
            if (!card) return;
            const bubble = qs('[data-dig-site-status="' + index + '"]', root);
            const summary = qs('[data-dig-site-summary="' + index + '"]', root);
            const readiness = evaluateDigSiteReadiness(site);
            if (bubble) {
                bubble.classList.toggle('bulk-create-mock-dig-site-status--ready', readiness.ok);
                bubble.classList.toggle('bulk-create-mock-dig-site-status--not-ready', !readiness.ok);
                bubble.setAttribute('title', readiness.hint);
                bubble.setAttribute(
                    'aria-label',
                    readiness.ok ? 'Ready' : 'Not ready: ' + readiness.hint
                );
            }
            if (summary) {
                summary.textContent = readiness.ok
                    ? siteAddressSummary(site) || 'Ready'
                    : readiness.hint;
            }
        });
    }

    function setDigSiteCollapsed(root, index, collapsed) {
        const site = digSites[index];
        if (!site) return;
        site.uiCollapsed = !!collapsed;
        const card = qs('[data-dig-site-index="' + index + '"]', root);
        if (!card) return;
        const body = qs('.bulk-create-mock-dig-site-body', card);
        const toggle = qs('[data-dig-site-toggle="' + index + '"]', card);
        if (collapsed) {
            card.classList.add('is-collapsed');
            if (body) body.setAttribute('hidden', '');
        } else {
            card.classList.remove('is-collapsed');
            if (body) body.removeAttribute('hidden');
        }
        if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function syncDigSitesListInDom(root) {
        const list = qs('#bulkCreateDigSitesList', root);
        if (!list) return;
        list.innerHTML = digSites
            .map(function (site, i) {
                return digSiteCardMarkup(site, i);
            })
            .join('');
        bindDigSiteHandlers(root);
        updateDigSiteReadinessIndicators(root);
        syncMapPolygons();
    }

    function syncMapPolygons() {
        if (global.createTicketWizardBulkApi && typeof global.createTicketWizardBulkApi.syncBulkCreatePolygonsOnMap === 'function') {
            global.createTicketWizardBulkApi.syncBulkCreatePolygonsOnMap(digSites);
        }
    }

    function readDigSitesFromDom(root) {
        digSites.forEach(function (site, index) {
            const ta = qs('[data-dig-site-scope="' + index + '"]', root);
            if (ta) site.scope = String(ta.value || '');
            const cross = qs('[data-dig-site-cross="' + index + '"]', root);
            if (cross) site.nearestCrossStreet = String(cross.value || '');
            const street = qs('[data-dig-site-addr-street="' + index + '"]', root);
            const city = qs('[data-dig-site-addr-city="' + index + '"]', root);
            const state = qs('[data-dig-site-addr-state="' + index + '"]', root);
            const zip = qs('[data-dig-site-addr-zip="' + index + '"]', root);
            const county = qs('[data-dig-site-addr-county="' + index + '"]', root);
            site.address = {
                street: street ? String(street.value || '') : site.address ? site.address.street : '',
                city: city ? String(city.value || '') : site.address ? site.address.city : '',
                state: state ? String(state.value || '') : site.address ? site.address.state : '',
                zip: zip ? String(zip.value || '') : site.address ? site.address.zip : '',
                county: county ? String(county.value || '') : site.address ? site.address.county : '',
            };
            site.geocodeSummary = siteAddressSummary(site);
        });
    }

    function snapshotSharedForm(root) {
        const shared = collectSharedFromForm(root);
        const ackAcc = qs('#bcwAckAccuracy', root);
        const ackPriv = qs('#bcwAckPrivateLines', root);
        lastSharedFormSnapshot = Object.assign({}, shared, {
            ackAccuracy: !!(ackAcc && ackAcc.checked),
            ackPrivateLines: !!(ackPriv && ackPriv.checked),
            ackShort: !!(qs('#bcwAckShort', root) && qs('#bcwAckShort', root).checked),
            ackEmergency: !!(qs('#bcwAckEmergency', root) && qs('#bcwAckEmergency', root).checked),
        });
    }

    function applySharedFormSnapshot(root) {
        if (!lastSharedFormSnapshot) return;
        const s = lastSharedFormSnapshot;
        const setVal = function (id, val) {
            const el = qs('#' + id, root);
            if (el) el.value = val != null ? String(val) : '';
        };
        setVal('bcwJobName', s.jobName);
        setVal('bcwPrincipalName', s.principalName);
        setVal('bcwPrincipalMobile', s.principalMobile);
        setVal('bcwTicketType', s.ticketType);
        setVal('bcwWorkType', s.workCategoryId);
        const act = qs('#bcwWorkActivity', root);
        if (act) {
            act.innerHTML = workActivityOptionsHtml(s.workCategoryId);
            act.disabled = !s.workCategoryId;
            syncWizardSearchableSelectValue(act, s.workActivityId);
        }
        setVal('bcwExcavationMethod', s.excavationMethod);
        setVal('bcwPermitExcavation', s.permitExcavation);
        setVal('bcwAreaPreMarked', s.areaPreMarked);
        setVal('bcwStartDate', s.startDateYmd);
        setVal('bcwStartTime', s.startTimeHm);
        setVal('bcwProjectOwnerType', s.projectOwnerTypeId);
        const ownerNameEl = qs('#bcwProjectOwnerName', root);
        if (ownerNameEl) {
            ownerNameEl.innerHTML = projectOwnerNameOptionsHtml(s.projectOwnerTypeId);
            ownerNameEl.disabled = !s.projectOwnerTypeId;
            syncWizardSearchableSelectValue(ownerNameEl, s.projectOwnerAuthId);
        }
        ['bcwHorizontalBoring', 'bcwExplosives', 'bcwStreetSidewalkParkstrip'].forEach(function (name) {
            const key =
                name === 'bcwHorizontalBoring'
                    ? 'horizontalBoring'
                    : name === 'bcwExplosives'
                      ? 'explosives'
                      : 'streetSidewalkParkstrip';
            const val = s[key];
            if (!val) return;
            const radio = qs('input[name="' + name + '"][value="' + val + '"]', root);
            if (radio) radio.checked = true;
        });
        const ackAcc = qs('#bcwAckAccuracy', root);
        const ackPriv = qs('#bcwAckPrivateLines', root);
        const ackShort = qs('#bcwAckShort', root);
        const ackEmergency = qs('#bcwAckEmergency', root);
        if (ackAcc) ackAcc.checked = !!s.ackAccuracy;
        if (ackPriv) ackPriv.checked = !!s.ackPrivateLines;
        if (ackShort) ackShort.checked = !!s.ackShort;
        if (ackEmergency) ackEmergency.checked = !!s.ackEmergency;
        syncTicketTypeAckVisibility(root);
        applyCommencementDateConstraints(root);
        void refreshCommencementDatesFromUsan(root);
        updateSharedReadinessIndicator(root);
        updateAcknowledgmentReadinessIndicator(root);
    }

    function collectSharedFromForm(root) {
        const form = qs('#bulkCreateTicketsMockForm', root);
        const fd = form ? new FormData(form) : new FormData();
        return {
            jobName: fd.get('bcwJobName') || '',
            ticketType: fd.get('bcwTicketType') || '',
            workCategoryId: fd.get('bcwWorkType') || '',
            workActivityId: fd.get('bcwWorkActivity') || '',
            excavationMethod: fd.get('bcwExcavationMethod') || '',
            horizontalBoring: fd.get('bcwHorizontalBoring') || '',
            explosives: fd.get('bcwExplosives') || '',
            streetSidewalkParkstrip: fd.get('bcwStreetSidewalkParkstrip') || '',
            permitExcavation: fd.get('bcwPermitExcavation') || '',
            areaPreMarked: fd.get('bcwAreaPreMarked') || '',
            startDateYmd: fd.get('bcwStartDate') || '',
            startTimeHm: fd.get('bcwStartTime') || '',
            projectOwnerTypeId: fd.get('bcwProjectOwnerType') || '',
            projectOwnerAuthId: fd.get('bcwProjectOwnerName') || '',
            principalName: fd.get('bcwPrincipalName') || '',
            principalMobile: fd.get('bcwPrincipalMobile') || '',
        };
    }

    function collectSharedValidationErrors(shared, root) {
        const errors = [];
        const validateName = principalNameValidator();
        const validateMobile = principalMobileValidator();
        const nameResult = validateName
            ? validateName(shared.principalName)
            : String(shared.principalName || '').trim()
              ? { ok: true }
              : { ok: false, message: 'Enter principal contact name' };
        if (!nameResult.ok && nameResult.message) errors.push(nameResult.message);
        const mobileResult = validateMobile
            ? validateMobile(shared.principalMobile)
            : String(shared.principalMobile || '').trim()
              ? { ok: true }
              : { ok: false, message: 'Enter principal contact mobile' };
        if (!mobileResult.ok && mobileResult.message) errors.push(mobileResult.message);
        if (!shared.workCategoryId) errors.push('Select type of work');
        if (!shared.workActivityId) errors.push('Select work activity');
        if (!shared.projectOwnerTypeId) errors.push('Select project owner type');
        if (!shared.projectOwnerAuthId) errors.push('Select project owner name');
        if (!shared.startDateYmd) errors.push('Select planned work start date');
        else if (!shared.startTimeHm) errors.push('Select work start time');
        else if (
            global.ticketCommencementDatesApi &&
            typeof global.ticketCommencementDatesApi.validateCommencementDateTime === 'function'
        ) {
            const commence = global.ticketCommencementDatesApi.validateCommencementDateTime(
                shared.startDateYmd,
                shared.startTimeHm,
                undefined,
                shared.ticketType
            );
            if (!commence.ok && commence.message) errors.push(commence.message);
        }
        return errors;
    }

    /** @returns {{ ok: boolean, hint: string, errors: string[] }} */
    function evaluateSharedReadiness(root) {
        const shared = collectSharedFromForm(root);
        const errors = collectSharedValidationErrors(shared, root);
        return {
            ok: errors.length === 0,
            hint: errors.length === 0 ? 'Ready' : errors[0],
            errors: errors,
        };
    }

    /** @returns {{ ok: boolean, hint: string, errors: string[] }} */
    function validateSharedStep(root) {
        return evaluateSharedReadiness(root);
    }

    function buildTicketStateForSite(shared, site) {
        let reverseGeocodeRow = null;
        if (site.reverseGeocodeRow) {
            try {
                reverseGeocodeRow = JSON.parse(JSON.stringify(site.reverseGeocodeRow));
            } catch (e) {
                reverseGeocodeRow = site.reverseGeocodeRow;
            }
            reverseGeocodeRow = mergeAddressIntoReverseGeocodeRow(reverseGeocodeRow, site.address);
        }
        return Object.assign({}, shared, {
            polygonGeoJson: site.polygonGeoJson,
            scope: site.scope,
            nearestCrossStreet: site.nearestCrossStreet || '',
            reverseGeocodeRow: reverseGeocodeRow,
        });
    }

    function collectAcknowledgmentErrors(root) {
        const errors = [];
        const ackAcc = qs('#bcwAckAccuracy', root);
        const ackPriv = qs('#bcwAckPrivateLines', root);
        if (!ackAcc || !ackAcc.checked) errors.push('Check accuracy acknowledgment');
        if (!ackPriv || !ackPriv.checked) errors.push('Check private lines acknowledgment');
        const shared = collectSharedFromForm(root);
        const ticketType = normalizeTicketTypeValue(shared.ticketType);
        if (ticketType === 'Short') {
            const ackShort = qs('#bcwAckShort', root);
            if (!ackShort || !ackShort.checked) errors.push('Check short-notice acknowledgment');
        }
        if (ticketType === 'Emergency') {
            const ackEmergency = qs('#bcwAckEmergency', root);
            if (!ackEmergency || !ackEmergency.checked) errors.push('Check emergency acknowledgment');
        }
        return errors;
    }

    /** @returns {{ ok: boolean, hint: string, errors: string[] }} */
    function evaluateAcknowledgmentReadiness(root) {
        const errors = collectAcknowledgmentErrors(root);
        return {
            ok: errors.length === 0,
            hint: errors.length === 0 ? 'Ready' : errors[0],
            errors: errors,
        };
    }

    /** @returns {{ ok: boolean, hint: string, errors: string[] }} */
    function validateAcknowledgmentsStep(root) {
        return evaluateAcknowledgmentReadiness(root);
    }

    /**
     * @returns {{ ok: boolean, sharedErrors: string[], siteRows: { index: number, label: string, ok: boolean, hint: string }[] }}
     */
    function validateBatch(root) {
        readDigSitesFromDom(root);
        const shared = collectSharedFromForm(root);
        const sharedErrors = collectSharedValidationErrors(shared, root);
        sharedErrors.push.apply(sharedErrors, collectAcknowledgmentErrors(root));

        const siteRows = digSites.map(function (site, index) {
            const readiness = evaluateDigSiteReadiness(site);
                return {
                index: index,
                label: 'Dig site ' + (index + 1),
                ok: readiness.ok,
                hint: readiness.hint,
                scopeSnippet: String(site.scope || '').trim().slice(0, 48),
                crossStreetSnippet: String(site.nearestCrossStreet || '').trim().slice(0, 32),
                addressLine: siteAddressSummary(site) || site.geocodeSummary || '—',
            };
        });

        const allSitesOk = siteRows.every(function (r) {
            return r.ok;
        });
        return {
            ok: sharedErrors.length === 0 && allSitesOk,
            sharedErrors: sharedErrors,
            siteRows: siteRows,
        };
    }

    function reviewMarkup(validation) {
        const sharedWarn =
            validation.sharedErrors.length > 0
                ? '<p class="ticket-hub-mock-hint" style="color:#fca5a5">' +
                  esc(validation.sharedErrors.join(' · ')) +
                  '</p>'
                : '';
        const tbody = validation.siteRows
            .map(function (r) {
                return (
                    '<tr class="' +
                    (r.ok ? '' : 'bulk-create-mock-review-row--warn') +
                    '"><td>' +
                    esc(r.label) +
                    '</td><td>' +
                    esc(r.scopeSnippet || '—') +
                    '</td><td>' +
                    esc(r.crossStreetSnippet || '—') +
                    '</td><td>' +
                    esc(r.addressLine) +
                    '</td><td>' +
                    esc(r.hint) +
                    '</td></tr>'
                );
            })
            .join('');
        const dis = validation.ok ? '' : ' disabled';
        return (
            createTicketWizardHeaderMarkup('Review and submit') +
            sharedWarn +
            '<p class="ticket-hub-mock-hint">' +
            digSites.length +
            ' ticket(s) will be submitted to USAN one at a time. Shared contact and work details apply to each.</p>' +
            '<div class="bulk-create-mock-review-table-wrap">' +
            '<table class="bulk-create-mock-review-table">' +
            '<thead><tr><th>Site</th><th>Description</th><th>Cross street</th><th>Address</th><th>Status</th></tr></thead>' +
            '<tbody>' +
            tbody +
            '</tbody></table></div>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-bulk-create-review-back>Back</button>' +
            (canPreviewUsanPayload()
                ? '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-bulk-create-dry-run>Dry run</button>'
                : '') +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary"' +
            dis +
            ' data-bulk-create-proceed>Submit to USAN</button>' +
            '</div>'
        );
    }

    function bulkCreateSiteLabels() {
        const labels = [];
        for (let i = 0; i < digSites.length; i++) {
            labels.push('Dig site ' + (i + 1));
        }
        return labels;
    }

    function rollupMarkup(stats, opts) {
        const dryRun = opts && opts.dryRun === true;
        const title = dryRun ? 'Dry run complete' : 'Create tickets complete';
        const pollNote = dryRun
            ? 'This was a simulated submit for UX preview only.'
            : 'Submitted to USAN — syncing tickets now…';
        const bsp = global.bulkSubmitProgress;
        const statStrip =
            bsp && typeof bsp.buildStatStrip === 'function'
                ? bsp.buildStatStrip(stats.ok, stats.fail)
                : '<ul class="renewal-mock-stat-strip"><li><strong>' +
                  stats.ok +
                  '</strong> succeeded</li><li><strong>' +
                  stats.fail +
                  '</strong> failed</li></ul>';
        const failureRows = (stats.failures || []).map(function (f) {
            const plain =
                bsp && typeof bsp.plainCreateFailureMessage === 'function'
                    ? bsp.plainCreateFailureMessage(f)
                    : f.msg;
            return { label: f.t, msg: plain };
        });
        const failureMarkup =
            failureRows.length && bsp && typeof bsp.buildFailureReasonsMarkup === 'function'
                ? bsp.buildFailureReasonsMarkup(failureRows)
                : '';
        return (
            createTicketWizardHeaderMarkup(title) +
            statStrip +
            failureMarkup +
            '<p class="ticket-hub-mock-hint renewal-mock-poll-note">' +
            esc(pollNote) +
            '</p>' +
            '<div class="ticket-hub-mock-footer">' +
            '<button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-bulk-create-dismiss>Close</button>' +
            '</div>'
        );
    }

    function bindTicketTypeHandler(root) {
        const ticketTypeEl = qs('#bcwTicketType', root);
        if (!ticketTypeEl || ticketTypeEl.dataset.ticketTypeBound === '1') return;
        ticketTypeEl.dataset.ticketTypeBound = '1';
        ticketTypeEl.addEventListener('change', function () {
            void reloadLookupsForTicketType(root, ticketTypeEl.value);
        });
    }

    function enhanceWizardSearchableSelects(root) {
        const mod = window.searchableSelectModule;
        if (!mod || typeof mod.bindSearchableSelect !== 'function') return;
        const onChange = function () {
            updateSharedReadinessIndicator(root);
        };
        const act = qs('#bcwWorkActivity', root);
        const owner = qs('#bcwProjectOwnerName', root);
        if (act) mod.bindSearchableSelect(act, { onChange: onChange, title: 'Work Activity' });
        if (owner) mod.bindSearchableSelect(owner, { onChange: onChange, title: 'Project owner name' });
    }

    function syncWizardSearchableSelectValue(el, value) {
        if (!el) return;
        el.value = value != null ? String(value) : '';
        const mod = window.searchableSelectModule;
        if (mod && typeof mod.setSearchableSelectValue === 'function') {
            mod.setSearchableSelectValue(el, value);
        }
    }

    function bindWorkTypeActivity(root) {
        const wt = qs('#bcwWorkType', root);
        const act = qs('#bcwWorkActivity', root);
        if (!wt || !act) return;
        wt.addEventListener('change', function () {
            act.innerHTML = workActivityOptionsHtml(wt.value);
            act.disabled = !wt.value;
            const mod = window.searchableSelectModule;
            if (mod && typeof mod.syncSearchableSelectDisabled === 'function') {
                mod.syncSearchableSelectDisabled(act, act.disabled);
            }
            enhanceWizardSearchableSelects(root);
            updateSharedReadinessIndicator(root);
        });
    }

    function bindProjectOwnerTypeHandler(root) {
        const typeEl = qs('#bcwProjectOwnerType', root);
        const nameEl = qs('#bcwProjectOwnerName', root);
        if (!typeEl || !nameEl) return;
        typeEl.addEventListener('change', function () {
            nameEl.innerHTML = projectOwnerNameOptionsHtml(typeEl.value);
            nameEl.disabled = !typeEl.value;
            const mod = window.searchableSelectModule;
            if (mod && typeof mod.syncSearchableSelectDisabled === 'function') {
                mod.syncSearchableSelectDisabled(nameEl, nameEl.disabled);
            }
            enhanceWizardSearchableSelects(root);
            updateSharedReadinessIndicator(root);
        });
    }

    function buildDrawHandlersForSite(index, root) {
        const site = digSites[index];
        if (!site) return null;
        const wt = qs('#bcwWorkType', root);
        return {
            existingPolygon: site.polygonGeoJson,
            beforeDraw: function () {
                closeMobileSidebarForMapView();
                readDigSitesFromDom(root);
                const o = overlayRoot();
                if (o) o.style.display = 'none';
            },
            getActivityId: function () {
                const v = wt && wt.value ? String(wt.value).trim() : '';
                const n = parseInt(v, 10);
                return Number.isFinite(n) && n > 0 ? n : 1;
            },
            onComplete: async function (siteIndex, geo, geocode) {
                const s = digSites[siteIndex];
                if (!s) return;
                s.uiCollapsed = false;
                s.polygonGeoJson = geo;
                if (geocode) {
                    s.geocodeMeta = geocode.meta || '';
                    s.geocodeStatusText = geocode.statusText || '';
                    s.geocodeStatusError = !!geocode.statusError;
                    if (geocode.nearestCrossStreet && !String(s.nearestCrossStreet || '').trim()) {
                        s.nearestCrossStreet = geocode.nearestCrossStreet;
                    }
                    if (geocode.row) {
                        try {
                            s.reverseGeocodeRow = JSON.parse(JSON.stringify(geocode.row));
                        } catch (e) {
                            s.reverseGeocodeRow = geocode.row;
                        }
                        applySiteAddressFromGeocodeRow(s, s.reverseGeocodeRow);
                    } else {
                        s.geocodeSummary = geocode.summaryLine || '';
                    }
                }
                activeDrawSiteIndex = -1;
                clearCreateTicketSearchPin();
                syncMapPolygons();
            },
            resumeOverlay: async function () {
                const o = overlayRoot();
                if (o) {
                    o.style.display = '';
                    activeBulkStep = 'dig-sites';
                    syncDigSitesListInDom(o);
                    applyBulkStepToDom(o, 'dig-sites');
                }
                activeDrawSiteIndex = -1;
            },
        };
    }

    function startDrawForSite(index, root) {
        const bulkApi = global.createTicketWizardBulkApi;
        if (!bulkApi || typeof bulkApi.startBulkCreatePolygonDrawing !== 'function') {
            if (typeof global.appAlert === 'function') global.appAlert('Map polygon drawing is not available.');
            return;
        }
        readDigSitesFromDom(root);
        activeDrawSiteIndex = index;
        const site = digSites[index];
        if (!site) return;
        site.uiCollapsed = false;
        const handlers = buildDrawHandlersForSite(index, root);
        if (!handlers) return;
        bulkApi.startBulkCreatePolygonDrawing(index, handlers);
        syncCreateTicketWizardMapTools();
    }

    function startDrawCircleForSite(index, root) {
        const bulkApi = global.createTicketWizardBulkApi;
        if (!bulkApi || typeof bulkApi.startBulkCreateCircleDrawing !== 'function') {
            if (typeof global.appAlert === 'function') global.appAlert('Map circle drawing is not available.');
            return;
        }
        readDigSitesFromDom(root);
        activeDrawSiteIndex = index;
        const site = digSites[index];
        if (!site) return;
        site.uiCollapsed = false;
        const handlers = buildDrawHandlersForSite(index, root);
        if (!handlers) return;
        bulkApi.startBulkCreateCircleDrawing(index, handlers);
        syncCreateTicketWizardMapTools();
    }

    function startDrawLineForSite(index, root) {
        const bulkApi = global.createTicketWizardBulkApi;
        if (!bulkApi || typeof bulkApi.startBulkCreateLineDrawing !== 'function') {
            if (typeof global.appAlert === 'function') global.appAlert('Map line drawing is not available.');
            return;
        }
        readDigSitesFromDom(root);
        activeDrawSiteIndex = index;
        const site = digSites[index];
        if (!site) return;
        site.uiCollapsed = false;
        const handlers = buildDrawHandlersForSite(index, root);
        if (!handlers) return;
        bulkApi.startBulkCreateLineDrawing(index, handlers);
        syncCreateTicketWizardMapTools();
    }

    let createTicketSearchPin = null;

    function clearCreateTicketSearchPin() {
        const map = global.map;
        if (createTicketSearchPin && map && map.hasLayer(createTicketSearchPin)) {
            map.removeLayer(createTicketSearchPin);
        }
        createTicketSearchPin = null;
    }

    /** Center the underlying map on a geocode result and drop a temporary, non-dig search pin. */
    function centerCreateTicketMapOnResult(lat, lon) {
        const map = global.map;
        if (!map || !global.L || !isFinite(lat) || !isFinite(lon)) return;
        clearCreateTicketSearchPin();
        createTicketSearchPin = global.L.marker([lat, lon], {
            icon: global.L.divIcon({
                className: 'search-marker',
                html: '<div style="background-color: var(--app-accent); width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
        }).addTo(map);
        const animOpts =
            typeof global.getMapSetViewAnimationOptions === 'function'
                ? global.getMapSetViewAnimationOptions(0.5)
                : { animate: true, duration: 0.5 };
        map.setView([lat, lon], 17, animOpts);
    }

    function setMapCenterSearchStatus(root, message) {
        mapCenterSearchStatus = message || '';
        const status = qs('.create-ticket-map-center-status', root);
        if (status) status.textContent = mapCenterSearchStatus;
    }

    function setMapCenterSearchLoading(root, loading) {
        const input = qs('[data-create-ticket-map-search]', root);
        const loadingEl = qs('[data-create-ticket-map-search-loading]', root);
        if (input) {
            input.disabled = !!loading;
            if (loading) input.setAttribute('aria-busy', 'true');
            else input.removeAttribute('aria-busy');
        }
        if (loadingEl) {
            if (loading) loadingEl.removeAttribute('hidden');
            else loadingEl.setAttribute('hidden', '');
        }
    }

    let mapCenterSearchDocClickBound = false;

    function bindMapCenterSearch(root) {
        const geo = global.geocodeSearchModule;
        const input = qs('[data-create-ticket-map-search]', root);
        const suggestions = qs('[data-create-ticket-map-suggestions]', root);
        if (!input || !geo || !suggestions || input.dataset.mapSearchBound === '1') return;
        input.dataset.mapSearchBound = '1';

        let mapCenterSearchInFlight = false;

        function applyMapCenterSelection(sel) {
            input.value = sel.displayName;
            mapCenterSearchQuery = sel.displayName;
            suggestions.classList.remove('show');
            centerCreateTicketMapOnResult(sel.lat, sel.lon);
            setMapCenterSearchStatus(
                root,
                'Map centered. Choose a dig site and draw its polygon on the map.'
            );
        }

        function fetchMapCenterSuggestions(q, limit) {
            const orgId = resolveCreateTicketOrgId();
            function tryClark() {
                return geo.fetchClarkCountyAddressSuggestions(q, limit);
            }
            function tryUsanThenClark() {
                return geo
                    .fetchUsanStreetSuggestions(orgId, q, limit)
                    .then(function (rows) {
                        if (rows && rows.length) return rows;
                        return tryClark();
                    })
                    .catch(function (err) {
                        if (geo.isUsanGeoSearchCredError && geo.isUsanGeoSearchCredError(err)) {
                            setMapCenterSearchStatus(root, MAP_CENTER_CONNECT_USAN_STATUS);
                        }
                        return tryClark();
                    });
            }
            const chain =
                orgId && typeof geo.fetchUsanStreetSuggestions === 'function'
                    ? tryUsanThenClark()
                    : tryClark();
            return chain.then(function (rows) {
                if (!rows || !rows.length) {
                    const noResults = new Error('No locations found');
                    noResults.code = 'NO_GEO_RESULTS';
                    throw noResults;
                }
                return rows;
            });
        }

        function runSearch() {
            const q = String(input.value || '').trim();
            mapCenterSearchQuery = String(input.value || '');
            if (!q) {
                return;
            }
            if (q.length < geo.MIN_QUERY_LENGTH) {
                suggestions.classList.remove('show');
                setMapCenterSearchStatus(
                    root,
                    'Enter at least ' +
                        geo.MIN_QUERY_LENGTH +
                        ' characters, then tap Search on the keyboard.'
                );
                return;
            }
            if (mapCenterSearchInFlight) return;
            mapCenterSearchInFlight = true;
            setMapCenterSearchLoading(root, true);
            setMapCenterSearchStatus(root, 'Searching for address…');
            suggestions.classList.remove('show');
            fetchMapCenterSuggestions(q, 5)
                .then(function (results) {
                    if (results && results.length === 1) {
                        const item = results[0];
                        const displayName = geo.geocodeResultDisplayName(item);
                        const lat = parseFloat(item.lat);
                        const lon = parseFloat(item.lon);
                        if (Number.isFinite(lat) && Number.isFinite(lon)) {
                            applyMapCenterSelection({ displayName: displayName, lat: lat, lon: lon, raw: item });
                            if (typeof input.blur === 'function') input.blur();
                            return;
                        }
                    }
                    geo.renderGeocodeSuggestionList(suggestions, results, applyMapCenterSelection);
                })
                .catch(function (err) {
                    if (err && err.code === 'NO_GEO_RESULTS') {
                        geo.showGeocodeMessage(
                            suggestions,
                            'No locations found. Try a different address or intersection.',
                            'var(--app-text-secondary)'
                        );
                        setMapCenterSearchStatus(
                            root,
                            'No locations found. Try a different address or intersection.'
                        );
                        return;
                    }
                    geo.showGeocodeMessage(
                        suggestions,
                        'Error searching for address. Please try again.',
                        'var(--app-danger)'
                    );
                })
                .finally(function () {
                    mapCenterSearchInFlight = false;
                    setMapCenterSearchLoading(root, false);
                });
        }

        input.addEventListener('input', function () {
            mapCenterSearchQuery = String(input.value || '');
            suggestions.classList.remove('show');
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                runSearch();
            }
        });
        input.addEventListener('search', function (e) {
            e.preventDefault();
            runSearch();
        });
        if (!mapCenterSearchDocClickBound) {
            mapCenterSearchDocClickBound = true;
            document.addEventListener('click', function (e) {
                const wrap = overlayRoot();
                if (!wrap) return;
                const panelSuggestions = qs('[data-create-ticket-map-suggestions]', wrap);
                if (!panelSuggestions) return;
                if (e.target.closest && e.target.closest('[data-create-ticket-map-suggestions]')) return;
                if (e.target.closest && e.target.closest('[data-create-ticket-map-search]')) return;
                panelSuggestions.classList.remove('show');
            });
        }

        const myLocationBtn = qs('[data-create-ticket-map-my-location]', root);
        if (myLocationBtn && myLocationBtn.dataset.mapMyLocationBound !== '1') {
            myLocationBtn.dataset.mapMyLocationBound = '1';
            myLocationBtn.addEventListener('click', function () {
                const centerOnce =
                    typeof global.centerMapOnCurrentLocationOnce === 'function'
                        ? global.centerMapOnCurrentLocationOnce
                        : null;
                if (!centerOnce) {
                    setMapCenterSearchStatus(root, 'Location is not available in this browser.');
                    return;
                }
                myLocationBtn.disabled = true;
                myLocationBtn.setAttribute('aria-busy', 'true');
                setMapCenterSearchStatus(root, 'Getting your location…');
                centerOnce({
                    skipMapPan: true,
                    onSuccess: function (fix) {
                        myLocationBtn.disabled = false;
                        myLocationBtn.removeAttribute('aria-busy');
                        centerCreateTicketMapOnResult(fix.lat, fix.lon);
                        setMapCenterSearchStatus(
                            root,
                            'Map centered on your location. Choose a dig site and draw its polygon on the map.'
                        );
                    },
                    onError: function (err) {
                        myLocationBtn.disabled = false;
                        myLocationBtn.removeAttribute('aria-busy');
                        const msg =
                            err && err.message
                                ? String(err.message)
                                : 'Unable to get your location.';
                        setMapCenterSearchStatus(root, msg);
                    },
                });
            });
        }
    }

    function bindDigSiteHandlers(root) {
        qsa('[data-dig-site-toggle]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-dig-site-toggle') || ''), 10);
                if (!Number.isFinite(idx) || !digSites[idx]) return;
                setDigSiteCollapsed(root, idx, !digSites[idx].uiCollapsed);
            });
        });
        qsa('[data-bulk-create-draw]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-bulk-create-draw') || ''), 10);
                if (Number.isFinite(idx)) startDrawForSite(idx, root);
            });
        });
        qsa('[data-bulk-create-draw-circle]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-bulk-create-draw-circle') || ''), 10);
                if (Number.isFinite(idx)) startDrawCircleForSite(idx, root);
            });
        });
        qsa('[data-bulk-create-draw-line]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-bulk-create-draw-line') || ''), 10);
                if (Number.isFinite(idx)) startDrawLineForSite(idx, root);
            });
        });
        qsa('[data-bulk-create-clear-polygon]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-bulk-create-clear-polygon') || ''), 10);
                const s = digSites[idx];
                if (!s) return;
                s.polygonGeoJson = null;
                s.geocodeSummary = '';
                s.geocodeMeta = '';
                s.geocodeStatusText = '';
                s.geocodeStatusError = false;
                s.nearestCrossStreet = '';
                s.reverseGeocodeRow = null;
                s.address = emptySiteAddress();
                syncDigSitesListInDom(root);
            });
        });
        qsa('[data-bulk-create-remove-site]', root).forEach(function (btn) {
            btn.addEventListener('click', function () {
                const idx = parseInt(String(btn.getAttribute('data-bulk-create-remove-site') || ''), 10);
                if (digSites.length <= 1) return;
                readDigSitesFromDom(root);
                digSites.splice(idx, 1);
                syncDigSitesListInDom(root);
                const submitLbl = qs('[data-bulk-create-submit]', root);
                if (submitLbl) {
                    submitLbl.textContent =
                        'Submit ' + digSites.length + ' ticket' + (digSites.length === 1 ? '' : 's') + ' to USAN';
                }
            });
        });
        qsa('.bulk-create-mock-scope', root).forEach(function (ta) {
            ta.addEventListener('input', function () {
                const idx = parseInt(String(ta.getAttribute('data-dig-site-scope') || ''), 10);
                if (digSites[idx]) digSites[idx].scope = String(ta.value || '');
                updateDigSiteReadinessIndicators(root);
            });
        });
        qsa('.bulk-create-mock-cross', root).forEach(function (inp) {
            inp.addEventListener('input', function () {
                const idx = parseInt(String(inp.getAttribute('data-dig-site-cross') || ''), 10);
                if (digSites[idx]) digSites[idx].nearestCrossStreet = String(inp.value || '');
                updateDigSiteReadinessIndicators(root);
            });
        });
        [
            { attr: 'data-dig-site-addr-street', key: 'street' },
            { attr: 'data-dig-site-addr-city', key: 'city' },
            { attr: 'data-dig-site-addr-state', key: 'state' },
            { attr: 'data-dig-site-addr-zip', key: 'zip' },
            { attr: 'data-dig-site-addr-county', key: 'county' },
        ].forEach(function (spec) {
            qsa('[' + spec.attr + ']', root).forEach(function (inp) {
                inp.addEventListener('input', function () {
                    const idx = parseInt(String(inp.getAttribute(spec.attr) || ''), 10);
                    const s = digSites[idx];
                    if (!s) return;
                    if (!s.address) s.address = emptySiteAddress();
                    s.address[spec.key] = String(inp.value || '');
                    s.geocodeSummary = siteAddressSummary(s);
                    updateDigSiteReadinessIndicators(root);
                });
            });
        });
    }

    function commencementDatesApi() {
        return global.ticketCommencementDatesApi || null;
    }

    function clearUsanCommencementBounds() {
        lastUsanCommencementBounds = null;
    }

    function resolveCommencementBounds(ticketType, opts) {
        const api = commencementDatesApi();
        const type = normalizeTicketTypeValue(ticketType);
        if (opts && opts.earliest && opts.earliest.ymd) {
            return {
                earliest: opts.earliest,
                latest: opts.latest && opts.latest.ymd ? opts.latest : null,
                source: opts.source === 'usan' ? 'usan' : 'local',
            };
        }
        if (
            lastUsanCommencementBounds &&
            lastUsanCommencementBounds.ticketType === type &&
            lastUsanCommencementBounds.earliest &&
            lastUsanCommencementBounds.earliest.ymd
        ) {
            return {
                earliest: lastUsanCommencementBounds.earliest,
                latest:
                    lastUsanCommencementBounds.latest && lastUsanCommencementBounds.latest.ymd
                        ? lastUsanCommencementBounds.latest
                        : null,
                source: 'usan',
            };
        }
        if (!api || typeof api.getEarliestAllowedCommencement !== 'function') {
            return null;
        }
        const earliest = api.getEarliestAllowedCommencement(undefined, type);
        const latest =
            typeof api.getLatestAllowedCommencement === 'function'
                ? api.getLatestAllowedCommencement(undefined, type)
                : null;
        return {
            earliest: earliest,
            latest: latest && latest.ymd ? latest : null,
            source: 'local',
        };
    }

    function commencementOutsideWindow(ymd, hm, earliest, latest, api) {
        if (!ymd || !earliest || !earliest.ymd) return true;
        const time =
            (api && typeof api.normalizeHm === 'function' ? api.normalizeHm(hm) : null) ||
            String(hm || '').trim() ||
            '00:00';
        if (typeof api.compareYmdHm !== 'function') {
            if (ymd < earliest.ymd) return true;
            if (latest && latest.ymd && ymd > latest.ymd) return true;
            return false;
        }
        if (api.compareYmdHm(ymd, time, earliest.ymd, earliest.hm) < 0) return true;
        if (latest && latest.ymd && api.compareYmdHm(ymd, time, latest.ymd, latest.hm) > 0) {
            return true;
        }
        return false;
    }

    /**
     * @param {ParentNode} root
     * @param {{ earliest?: { ymd: string, hm: string }, latest?: { ymd: string, hm: string }|null, source?: string, pending?: boolean }=} opts
     */
    function applyCommencementDateConstraints(root, opts) {
        const api = commencementDatesApi();
        if (!api || typeof api.getEarliestAllowedCommencement !== 'function') return;
        const shared = collectSharedFromForm(root);
        const ticketType = normalizeTicketTypeValue(shared.ticketType);
        const bounds = resolveCommencementBounds(ticketType, opts || {});
        if (!bounds || !bounds.earliest) return;
        const earliest = bounds.earliest;
        const latest = bounds.latest;
        const source = (opts && opts.pending ? 'pending' : null) || bounds.source || 'local';
        const dateEl = qs('#bcwStartDate', root);
        const timeEl = qs('#bcwStartTime', root);
        const hintEl = qs('#bcwStartDateHint', root);

        if (hintEl) {
            if (source === 'pending') {
                hintEl.textContent = 'Resolving legal start…';
            } else if (typeof api.formatEarliestCommencementHint === 'function') {
                let hint =
                    (source === 'usan' ? 'Earliest Legal Start Date: ' : 'Earliest allowed: ') +
                    api.formatEarliestCommencementHint(earliest, ticketType, { source: source });
                if (latest && typeof api.formatLatestCommencementHint === 'function') {
                    const latestHint = api.formatLatestCommencementHint(latest, ticketType);
                    if (latestHint) hint += '. Latest: ' + latestHint;
                } else if (ticketType === 'Normal' && source !== 'usan') {
                    hint += ' (2 business days).';
                } else {
                    hint += '.';
                }
                hintEl.textContent = hint;
            }
        }

        if (dateEl) {
            dateEl.min = earliest.ymd;
            if (latest && latest.ymd) dateEl.max = latest.ymd;
            else dateEl.removeAttribute('max');
        }
        if (!dateEl || !timeEl) return;

        let selectedDate = String(dateEl.value || '').trim();
        let selectedHm = String(timeEl.value || '').trim();
        if (commencementOutsideWindow(selectedDate, selectedHm, earliest, latest, api)) {
            dateEl.value = earliest.ymd;
            timeEl.value = earliest.hm;
            selectedDate = earliest.ymd;
            selectedHm = earliest.hm;
        }

        if (ticketType === 'Normal' && selectedDate === earliest.ymd) {
            timeEl.min = earliest.hm || api.BUSINESS_DAY_END_HM || '17:00';
            const hm = String(timeEl.value || '').trim();
            if (
                !hm ||
                (typeof api.compareYmdHm === 'function' &&
                    api.compareYmdHm(selectedDate, hm, earliest.ymd, earliest.hm) < 0)
            ) {
                timeEl.value = earliest.hm;
            }
        } else if (selectedDate === earliest.ymd) {
            timeEl.min = earliest.hm;
            const hm = String(timeEl.value || '').trim();
            if (
                !hm ||
                (typeof api.compareYmdHm === 'function' &&
                    api.compareYmdHm(selectedDate, hm, earliest.ymd, earliest.hm) < 0)
            ) {
                timeEl.value = earliest.hm;
            }
        } else {
            timeEl.removeAttribute('min');
        }
        if (latest && selectedDate === latest.ymd) {
            timeEl.max = latest.hm;
            const hm = String(timeEl.value || '').trim();
            if (
                hm &&
                typeof api.compareYmdHm === 'function' &&
                api.compareYmdHm(selectedDate, hm, latest.ymd, latest.hm) > 0
            ) {
                timeEl.value = latest.hm;
            }
        } else {
            timeEl.removeAttribute('max');
        }
    }

    /**
     * Probe USAN GetCurrentUserEnquiryComputedDateValues (via computed-dates-new) and
     * autofill / constrain planned start from enquiryEarliestDate (+ latestStartDate).
     * Falls back to local weekend rules on failure.
     * @param {ParentNode} root
     */
    async function refreshCommencementDatesFromUsan(root) {
        const api = commencementDatesApi();
        if (!api || typeof api.getEarliestAllowedCommencement !== 'function') return;
        if (!root) return;

        const seq = ++commencementResolveSeq;
        const shared = collectSharedFromForm(root);
        const ticketType = normalizeTicketTypeValue(shared.ticketType);
        clearUsanCommencementBounds();
        applyCommencementDateConstraints(root, { pending: true });

        const orgId = resolveCreateTicketOrgId();
        if (
            !orgId ||
            !global.authModule ||
            typeof global.authModule.apiRequest !== 'function' ||
            typeof api.purposeIdFromTicketType !== 'function' ||
            typeof api.isoToUsanYmdHm !== 'function'
        ) {
            if (seq !== commencementResolveSeq) return;
            applyCommencementDateConstraints(root);
            return;
        }

        const purposeId = api.purposeIdFromTicketType(ticketType);
        // Early seed so USAN returns the real earliest (holiday-aware).
        const seed = api.getEarliestAllowedCommencement(undefined, 'Emergency');

        try {
            const res = await global.authModule.apiRequest('tickets/computed-dates-new', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: Number(orgId),
                    enquiryPurposeId: purposeId,
                    startDateYmd: seed.ymd,
                    startTimeHm: seed.hm,
                }),
            });
            if (seq !== commencementResolveSeq) return;
            const data = res && res.data != null ? res.data : res;
            const earliest = api.isoToUsanYmdHm(data && data.enquiryEarliestDate);
            if (!earliest) {
                applyCommencementDateConstraints(root);
                return;
            }
            const latest = api.isoToUsanYmdHm(data && data.latestStartDate);
            lastUsanCommencementBounds = {
                ticketType: ticketType,
                earliest: earliest,
                latest: latest,
            };
            applyCommencementDateConstraints(root, {
                earliest: earliest,
                latest: latest,
                source: 'usan',
            });
            updateSharedReadinessIndicator(root);
        } catch (e) {
            if (seq !== commencementResolveSeq) return;
            console.warn('[createTicketWizard] computed-dates-new', e);
            clearUsanCommencementBounds();
            applyCommencementDateConstraints(root);
            updateSharedReadinessIndicator(root);
        }
    }

    function bindCommencementDateHandlers(root) {
        const dateEl = qs('#bcwStartDate', root);
        const timeEl = qs('#bcwStartTime', root);
        if (!dateEl || dateEl.dataset.commencementBound === '1') return;
        dateEl.dataset.commencementBound = '1';
        const onChange = function () {
            applyCommencementDateConstraints(root);
            updateSharedReadinessIndicator(root);
        };
        dateEl.addEventListener('change', onChange);
        if (timeEl) timeEl.addEventListener('change', onChange);
    }

    function bindFormStepHandlers(wrap) {
        const panel = qs('.ticket-hub-mock-panel', wrap);
        const delegateRoot = panel || wrap;
        if (delegateRoot.dataset.bulkCreateHandlersBound === '1') return;
        delegateRoot.dataset.bulkCreateHandlersBound = '1';

        delegateRoot.addEventListener('click', function (ev) {
            const stepBtn = ev.target.closest('[data-bulk-create-step]');
            if (stepBtn) {
                readDigSitesFromDom(wrap);
                tryAdvanceBulkStep(wrap, stepBtn.getAttribute('data-bulk-create-step'));
                return;
            }
            const nextBtn = ev.target.closest('[data-bulk-create-next]');
            if (nextBtn) {
                readDigSitesFromDom(wrap);
                tryAdvanceBulkStep(wrap, nextBtn.getAttribute('data-bulk-create-next'));
                return;
            }
            const backBtn = ev.target.closest('[data-bulk-create-back]');
            if (backBtn) {
                readDigSitesFromDom(wrap);
                tryAdvanceBulkStep(wrap, backBtn.getAttribute('data-bulk-create-back'));
                return;
            }
            const dryRunFromFinalize = ev.target.closest('[data-bulk-create-dry-run]');
            if (dryRunFromFinalize) {
                // Review step reuses the same attribute and binds its own handler.
                if (!qs('[data-bulk-create-submit]', wrap)) return;
                if (!canPreviewUsanPayload()) return;
                snapshotSharedForm(wrap);
                const ackValidation = validateAcknowledgmentsStep(wrap);
                if (!ackValidation.ok) {
                    showAcknowledgmentBlockedMessage(wrap, ackValidation);
                    return;
                }
                const v = validateBatch(wrap);
                if (!v.ok) {
                    showSubmitBlockedMessage(wrap, v);
                    return;
                }
                const panelEl = qs('.ticket-hub-mock-panel', wrap);
                if (!panelEl) return;
                dryRunFromFinalize.disabled = true;
                const submitBtnEl = qs('[data-bulk-create-submit]', wrap);
                if (submitBtnEl) submitBtnEl.disabled = true;
                void runBulkCreateDryRun(panelEl);
                return;
            }
            const submitBtn = ev.target.closest('[data-bulk-create-submit]');
            if (submitBtn) {
                snapshotSharedForm(wrap);
                const ackValidation = validateAcknowledgmentsStep(wrap);
                if (!ackValidation.ok) {
                    showAcknowledgmentBlockedMessage(wrap, ackValidation);
                    return;
                }
                const v = validateBatch(wrap);
                if (!v.ok) {
                    showSubmitBlockedMessage(wrap, v);
                    return;
                }
                const panelEl = qs('.ticket-hub-mock-panel', wrap);
                if (!panelEl) return;
                panelEl.innerHTML = reviewMarkup(v);
                bindDismissHandlers(wrap);
                bindCreateWizardMinimizeHandler(wrap);
                syncCreateWizardMinimizedUi(wrap);
                initFloatingCreatePanel(wrap);
                trapFocus(panelEl);
                delegateRoot.dataset.bulkCreateHandlersBound = '';
                const back = qs('[data-bulk-create-review-back]', wrap);
                if (back) {
                    back.addEventListener('click', function () {
                        renderFormStep('finalize');
                        const o = overlayRoot();
                        if (o) applySharedFormSnapshot(o);
                    });
                }
                const proceed = qs('[data-bulk-create-proceed]', wrap);
                if (proceed && v.ok) {
                    proceed.addEventListener(
                        'click',
                        function () {
                            proceed.disabled = true;
                            const dryRunBtn = qs('[data-bulk-create-dry-run]', wrap);
                            if (dryRunBtn) dryRunBtn.disabled = true;
                            void runBulkSubmitToUsan(panelEl);
                        },
                        { once: true }
                    );
                }
                const dryRunBtn = qs('[data-bulk-create-dry-run]', wrap);
                if (dryRunBtn && canPreviewUsanPayload()) {
                    dryRunBtn.addEventListener(
                        'click',
                        function () {
                            dryRunBtn.disabled = true;
                            if (proceed) proceed.disabled = true;
                            void runBulkCreateDryRun(panelEl);
                        },
                        { once: true }
                    );
                }
            }
        });

        bindWorkTypeActivity(wrap);
        bindTicketTypeHandler(wrap);
        bindProjectOwnerTypeHandler(wrap);
        enhanceWizardSearchableSelects(wrap);
        bindSharedPresetsHandlers(wrap);
        bindWizardInfoButtons(wrap);
        bindSharedReadinessHandlers(wrap);
        bindAcknowledgmentReadinessHandlers(wrap);
        bindMapCenterSearch(wrap);
        bindDigSiteHandlers(wrap);
        bindCommencementDateHandlers(wrap);
        applyDefaultSharedFormValues(wrap);
        clearUsanCommencementBounds();
        applyCommencementDateConstraints(wrap);
        void refreshCommencementDatesFromUsan(wrap);
        syncSharedPresetsUi(wrap);

        const addBtn = qs('[data-bulk-create-add-site]', wrap);
        if (addBtn) {
            addBtn.addEventListener('click', function () {
                if (digSites.length >= MAX_DIG_SITES) return;
                readDigSitesFromDom(wrap);
                digSites.forEach(function (s) {
                    s.uiCollapsed = true;
                });
                digSites.push(newDigSite({ uiCollapsed: false }));
                syncDigSitesListInDom(wrap);
                const submitLbl = qs('[data-bulk-create-submit]', wrap);
                if (submitLbl) submitLbl.textContent = 'Submit ' + digSites.length + ' tickets (mock)';
                const head = qs('.bulk-create-mock-dig-sites-title', wrap);
                if (head) head.textContent = 'Dig sites (' + digSites.length + ')';
                if (digSites.length >= MAX_DIG_SITES) addBtn.disabled = true;
                applyBulkStepToDom(wrap, 'dig-sites');
            });
        }
    }

    async function buildPayloadForSiteIndex(shared, siteIndex) {
        const api = global.newTicketPayloadApi;
        if (!api || typeof api.buildNewTicketPayload !== 'function') {
            throw new Error('Payload builder not loaded. Rebuild frontend bundles and hard-refresh.');
        }
        let lookups = wizardLookupsRef;
        const ticketType = normalizeTicketTypeValue(shared.ticketType);
        if (!lookups && typeof api.loadNewTicketLookups === 'function') {
            lookups = await api.loadNewTicketLookups(ticketType);
            wizardLookupsRef = lookups;
        }
        if (!lookups) throw new Error('Could not load ticket lookups.');
        const site = digSites[siteIndex];
        if (!site) throw new Error('Dig site not found.');
        const state = buildTicketStateForSite(shared, site);
        if (!state.reverseGeocodeRow || state.reverseGeocodeRow.isWktValid !== true) {
            throw new Error('Polygon not accepted by USAN — adjust dig area on map.');
        }
        return api.buildNewTicketPayload(state, lookups);
    }

    function submitErrorFromException(e) {
        const bsp = global.bulkSubmitProgress;
        if (bsp && typeof bsp.normalizeFailure === 'function') {
            return bsp.normalizeFailure(e);
        }
        const msg = e && e.message ? String(e.message) : String(e);
        let code = 'SUBMIT_FAILED';
        if (e && e.code != null && String(e.code).trim()) code = String(e.code).trim();
        return { code: code, msg: msg };
    }

    function beginCreateSubmitFeedback(label) {
        if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
            global.submitJobPoller.beginEnqueueFeedback(label || 'Submitting…');
        }
        if (typeof global.showToast === 'function') {
            global.showToast('Submitting', 'success');
        }
    }

    function endCreateSubmitFeedback() {
        if (global.submitJobPoller && typeof global.submitJobPoller.endEnqueueFeedback === 'function') {
            global.submitJobPoller.endEnqueueFeedback();
        }
    }

    /**
     * @param {HTMLElement|null|undefined} panel
     * @param {string[]} labels
     * @param {number} total
     * @param {string} title
     * @returns {object|null}
     */
    function mountCreatePrepareProgress(panel, labels, total, title) {
        const bsp = global.bulkSubmitProgress;
        if (!panel || !bsp || typeof bsp.mount !== 'function') return null;
        return bsp.mount(panel, {
            title: title || 'Preparing tickets…',
            total: total,
            items: labels,
        });
    }

    /**
     * @param {object|null} progress
     * @param {number} ix
     * @param {number} total
     */
    function updateCreatePrepareProgress(progress, ix, total) {
        if (!progress) return;
        const bsp = global.bulkSubmitProgress;
        if (progress.els && progress.els.count) {
            progress.els.count.textContent = 'Preparing ' + (ix + 1) + ' of ' + total + '…';
        }
        if (bsp && typeof bsp.startInFlight === 'function') bsp.startInFlight(progress);
    }

    /**
     * @param {object|null} progress
     * @param {number} ix
     */
    function completeCreatePrepareStep(progress, ix) {
        if (!progress) return;
        const bsp = global.bulkSubmitProgress;
        if (bsp && typeof bsp.stopInFlight === 'function') bsp.stopInFlight(progress);
        if (bsp && typeof bsp.markComplete === 'function') bsp.markComplete(progress, ix, true);
    }

    function restoreCreateWizardAfterFailedSubmit() {
        if (!overlayRoot()) return;
        renderFormStep('finalize');
        const o = overlayRoot();
        if (o) applySharedFormSnapshot(o);
    }

    async function runBulkCreateDryRun(panel) {
        const total = digSites.length;
        const orgId = resolveCreateTicketOrgId();
        if (!orgId) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('Select an organization first.');
            }
            restoreCreateWizardAfterFailedSubmit();
            return;
        }
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('Sign in to run a dry run.');
            }
            restoreCreateWizardAfterFailedSubmit();
            return;
        }

        const shared = lastSharedFormSnapshot || collectSharedFromForm(overlayRoot() || document);

        const labels = bulkCreateSiteLabels();
        const items = [];
        const wrapBusy = overlayRoot();
        if (wrapBusy) wrapBusy.setAttribute('aria-busy', 'true');

        beginCreateSubmitFeedback('Preparing tickets…');
        const progress = mountCreatePrepareProgress(panel, labels, total, 'Preparing tickets…');

        try {
            for (let ix = 0; ix < total; ix++) {
                updateCreatePrepareProgress(progress, ix, total);
                const payload = await buildPayloadForSiteIndex(shared, ix);
                items.push({
                    label: labels[ix] || 'Dig site ' + (ix + 1),
                    payload: payload,
                });
                completeCreatePrepareStep(progress, ix);
            }
            if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                global.submitJobPoller.beginEnqueueFeedback('Submitting…');
            }
            if (progress && progress.panel) {
                const titleEl = progress.panel.querySelector('[data-bulk-submit-title]');
                if (titleEl) titleEl.textContent = 'Submitting…';
            }
            const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: Number(orgId),
                    operation: 'create',
                    dryRun: true,
                    items: items,
                }),
            });
            createTicketSubmitFlowCompleted = true;
            if (wrapBusy) wrapBusy.removeAttribute('aria-busy');
            closeOverlay();
            // Draft polygons were cleared by closeOverlay(); do not repaint them.
            if (global.submitJobPoller && typeof global.submitJobPoller.registerJob === 'function') {
                global.submitJobPoller.registerJob(data && data.jobId);
            } else {
                endCreateSubmitFeedback();
            }
        } catch (e) {
            if (wrapBusy) wrapBusy.removeAttribute('aria-busy');
            endCreateSubmitFeedback();
            const err = submitErrorFromException(e);
            if (typeof global.appAlert === 'function') {
                await global.appAlert(err.msg || 'Could not start dry run.', { title: 'Dry run failed' });
            }
            restoreCreateWizardAfterFailedSubmit();
        }
    }

    async function runBulkSubmitToUsan(panel) {
        const total = digSites.length;

        const orgId = resolveCreateTicketOrgId();
        if (!orgId) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('Select an organization first.');
            }
            return;
        }
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('Sign in to submit tickets.');
            }
            return;
        }

        const shared = lastSharedFormSnapshot || collectSharedFromForm(overlayRoot() || document);

        const confirmMsg =
            total === 1
                ? 'Submit this new locate to USAN? Submission runs in the background and tickets sync automatically when done.'
                : 'Submit ' +
                  total +
                  ' new locates to USAN in the background? They will sync automatically when submission completes.';
        const confirmed =
            typeof global.appConfirm === 'function'
                ? await global.appConfirm(confirmMsg, {
                      title: 'Submit to USAN',
                      confirmText: 'Submit',
                      cancelText: 'Cancel',
                  })
                : true;
        if (!confirmed) {
            if (overlayRoot()) {
                renderFormStep('finalize');
                const o = overlayRoot();
                if (o) applySharedFormSnapshot(o);
            }
            return;
        }

        beginCreateSubmitFeedback('Preparing tickets…');

        const idempotencyKeys = [];
        for (let k = 0; k < total; k++) {
            idempotencyKeys.push(
                typeof global.newIdempotencyKey === 'function' ? global.newIdempotencyKey() : String(Date.now()) + '-' + k
            );
        }

        const labels = bulkCreateSiteLabels();
        const items = [];
        const wrapBusy = overlayRoot();
        if (wrapBusy) wrapBusy.setAttribute('aria-busy', 'true');
        const progress = mountCreatePrepareProgress(panel, labels, total, 'Preparing tickets…');

        try {
            for (let ix = 0; ix < total; ix++) {
                updateCreatePrepareProgress(progress, ix, total);
                const payload = await buildPayloadForSiteIndex(shared, ix);
                items.push({
                    label: labels[ix] || 'Dig site ' + (ix + 1),
                    payload: payload,
                    idempotencyKey: idempotencyKeys[ix],
                });
                completeCreatePrepareStep(progress, ix);
            }
            if (global.submitJobPoller && typeof global.submitJobPoller.beginEnqueueFeedback === 'function') {
                global.submitJobPoller.beginEnqueueFeedback('Submitting…');
            }
            if (progress && progress.panel) {
                const titleEl = progress.panel.querySelector('[data-bulk-submit-title]');
                if (titleEl) titleEl.textContent = 'Submitting…';
            }
            const data = await global.authModule.apiRequest('tickets/submit-jobs', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: Number(orgId),
                    operation: 'create',
                    items: items,
                }),
            });
            createTicketSubmitFlowCompleted = true;
            if (wrapBusy) wrapBusy.removeAttribute('aria-busy');
            closeOverlay();
            // Draft polygons were cleared by closeOverlay(); do not repaint them.
            if (global.submitJobPoller && typeof global.submitJobPoller.registerJob === 'function') {
                global.submitJobPoller.registerJob(data && data.jobId);
            } else {
                endCreateSubmitFeedback();
            }
        } catch (e) {
            if (wrapBusy) wrapBusy.removeAttribute('aria-busy');
            endCreateSubmitFeedback();
            const err = submitErrorFromException(e);
            const bsp = global.bulkSubmitProgress;
            if (bsp && typeof bsp.logSubmitFailures === 'function') {
                bsp.logSubmitFailures(
                    'ticket-create',
                    [{ code: err.code, msg: err.msg, supportId: err.supportId, label: 'Submit job' }],
                    { organizationId: orgId, total: total }
                );
            }
            if (typeof global.appAlert === 'function') {
                await global.appAlert(err.msg || 'Could not start submit job.', { title: 'Submit failed' });
            }
            restoreCreateWizardAfterFailedSubmit();
        }
    }

    /**
     * @param {'dig-sites'|'shared'|'finalize'} [optStep]
     */
    function renderFormStep(optStep) {
        if (optStep) activeBulkStep = optStep;
        else activeBulkStep = 'dig-sites';
        const wrap = openOverlay(formStepMarkup(), { title: 'Create ticket', widePanel: true });
        bindFormStepHandlers(wrap);
        syncMapPolygons();
        requestAnimationFrame(function () {
            const list = qs('#bulkCreateDigSitesList', wrap);
            if (list && typeof list.scrollIntoView === 'function') {
                try {
                    list.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } catch (e) {
                    /* ignore */
                }
            }
        });
    }

    async function prepareLookups(ticketType) {
        if (global.newTicketPayloadApi && typeof global.newTicketPayloadApi.loadNewTicketLookups === 'function') {
            try {
                wizardLookupsRef = await global.newTicketPayloadApi.loadNewTicketLookups(ticketType || 'Normal');
            } catch (e) {
                console.warn('[createTicketWizard] lookups', e);
            }
        }
    }

    async function maybeReverseGeocodeCloneDigSites() {
        const bulkApi = global.createTicketWizardBulkApi;
        if (!bulkApi || typeof bulkApi.reverseGeocodePolygonGeoJson !== 'function') return;
        const activityRaw =
            lastSharedFormSnapshot && lastSharedFormSnapshot.workCategoryId != null
                ? parseInt(String(lastSharedFormSnapshot.workCategoryId), 10)
                : NaN;
        const actId = Number.isFinite(activityRaw) && activityRaw > 0 ? activityRaw : 1;
        let changed = false;
        for (let i = 0; i < digSites.length; i += 1) {
            const site = digSites[i];
            if (
                !site ||
                !site.polygonGeoJson ||
                site.polygonGeoJson.type !== 'Polygon' ||
                site.reverseGeocodeRow
            ) {
                continue;
            }
            const geocode = await bulkApi.reverseGeocodePolygonGeoJson(site.polygonGeoJson, actId);
            if (!geocode) continue;
            site.geocodeMeta = geocode.meta || '';
            site.geocodeStatusText = geocode.statusText || '';
            site.geocodeStatusError = !!geocode.statusError;
            if (geocode.nearestCrossStreet && !String(site.nearestCrossStreet || '').trim()) {
                site.nearestCrossStreet = geocode.nearestCrossStreet;
            }
            if (geocode.row) {
                try {
                    site.reverseGeocodeRow = JSON.parse(JSON.stringify(geocode.row));
                } catch (e) {
                    site.reverseGeocodeRow = geocode.row;
                }
                applySiteAddressFromGeocodeRow(site, site.reverseGeocodeRow);
            } else if (geocode.summaryLine) {
                site.geocodeSummary = geocode.summaryLine;
            }
            changed = true;
        }
        if (!changed) return;
        const root = overlayRoot();
        if (root) {
            syncDigSitesListInDom(root);
            updateDigSiteReadinessIndicators(root);
        }
        syncMapPolygons();
    }

    async function openCloneFromTicket(sourceTicket, opts) {
        opts = opts || {};
        const currentOrgId = resolveCreateTicketOrgId();
        const canEdit = typeof global.canEditCurrentOrg === 'function' && global.canEditCurrentOrg();
        if (!currentOrgId || !canEdit) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert(
                    'Please select an organization you belong to (from the organization selector) before creating tickets.'
                );
            }
            return;
        }
        if (global.authModule && global.authModule.isTechInCurrentOrg && global.authModule.isTechInCurrentOrg()) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('You do not have permission to create tickets.');
            }
            return;
        }
        if (typeof global.canUseCreateTicketWizard === 'function' && !global.canUseCreateTicketWizard()) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert(
                    'Create ticket is available to dev users, or to organization admins and managers when ticket renewal is enabled on the server (ENABLE_TICKET_RENEWAL).',
                    { title: 'Create ticket unavailable' }
                );
            }
            return;
        }

        cloneSourceLabel =
            opts.sourceLabel != null && String(opts.sourceLabel).trim() !== ''
                ? String(opts.sourceLabel).trim()
                : sourceTicket && sourceTicket.ticketNumber
                  ? 'Cloned from ticket ' +
                    String(sourceTicket.ticketNumber).trim() +
                    ' — review all steps before submitting a new ticket.'
                  : 'Review copied fields before submitting a new ticket.';

        resetDigSites();
        activeDrawSiteIndex = -1;
        mapCenterSearchQuery = '';
        mapCenterSearchStatus = '';
        lastSharedFormSnapshot = null;
        createTicketSubmitFlowCompleted = false;
        createTicketWizardSessionActive = true;
        createTicketWizardMinimized = false;

        const prefill = opts.prefill || {};
        if (opts.copyPolygon && prefill.digSites && prefill.digSites.length) {
            digSites = prefill.digSites.map(function (site) {
                return Object.assign(newDigSite(), site || {});
            });
        }
        if (prefill.shared && typeof prefill.shared === 'object') {
            lastSharedFormSnapshot = Object.assign({}, prefill.shared);
        }

        if (
            global.createTicketAssessorOverlayModule &&
            typeof global.createTicketAssessorOverlayModule.setActive === 'function'
        ) {
            global.createTicketAssessorOverlayModule.setActive(true);
        }
        closeTicketHubForCreateTicketWizard();
        closeMobileSidebarForMapView();
        cancelAnnotationToolsForCreateTicketWizard();
        syncCreateTicketWizardMapTools();
        await prepareLookups(
            lastSharedFormSnapshot && lastSharedFormSnapshot.ticketType
                ? lastSharedFormSnapshot.ticketType
                : 'Normal'
        );
        renderFormStep('dig-sites');
        void maybeReverseGeocodeCloneDigSites();
    }

    async function open() {
        const currentOrgId = resolveCreateTicketOrgId();
        const canEdit = typeof global.canEditCurrentOrg === 'function' && global.canEditCurrentOrg();
        if (!currentOrgId || !canEdit) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert(
                    'Please select an organization you belong to (from the organization selector) before creating tickets.'
                );
            }
            return;
        }
        if (global.authModule && global.authModule.isTechInCurrentOrg && global.authModule.isTechInCurrentOrg()) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert('You do not have permission to create tickets.');
            }
            return;
        }
        if (typeof global.canUseCreateTicketWizard === 'function' && !global.canUseCreateTicketWizard()) {
            if (typeof global.appAlert === 'function') {
                await global.appAlert(
                    'Create ticket is available to dev users, or to organization admins and managers when ticket renewal is enabled on the server (ENABLE_TICKET_RENEWAL).',
                    { title: 'Create ticket unavailable' }
                );
            }
            return;
        }
        resetDigSites();
        activeDrawSiteIndex = -1;
        mapCenterSearchQuery = '';
        mapCenterSearchStatus = '';
        lastSharedFormSnapshot = null;
        cloneSourceLabel = null;
        createTicketSubmitFlowCompleted = false;
        createTicketWizardSessionActive = true;
        createTicketWizardMinimized = false;
        if (
            global.createTicketAssessorOverlayModule &&
            typeof global.createTicketAssessorOverlayModule.setActive === 'function'
        ) {
            global.createTicketAssessorOverlayModule.setActive(true);
        }
        closeTicketHubForCreateTicketWizard();
        closeMobileSidebarForMapView();
        cancelAnnotationToolsForCreateTicketWizard();
        syncCreateTicketWizardMapTools();
        await prepareLookups();
        renderFormStep();
    }

    global.isCreateTicketWizardSessionActive = isCreateTicketWizardSessionActive;
    global.getCreateTicketWizardMapContext = getCreateTicketWizardMapContext;

    global.createTicketWizardModule = {
        open: open,
        openCloneFromTicket: openCloneFromTicket,
        closeOverlay: closeOverlay,
        isSessionActive: isCreateTicketWizardSessionActive,
        getMapContext: getCreateTicketWizardMapContext,
    };
    /** Ticket Hub and map UI entry for the create-ticket wizard. */
    global.openCreateTicketWizard = function () {
        return open();
    };
})(typeof window !== 'undefined' ? window : globalThis);
