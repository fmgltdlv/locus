(function () {
    'use strict';

    const SHARE_TOKEN_RE = /^[A-Za-z0-9]{10}$/;
    const aerialHelper = () => window.mapAerialTileLayer || null;
    const AERIAL_MIN_RENDER_ZOOM =
        (aerialHelper() && aerialHelper().AERIAL_MIN_RENDER_ZOOM) || 16;
    const PHOTO_MIN_ZOOM =
        (window.mapPhotoMarkers && window.mapPhotoMarkers.PHOTO_MIN_ZOOM_DEFAULT) || 16;
    /** Below this zoom, show ticket pins + project extent bbox instead of full polygons. */
    const TICKET_POLYGON_MIN_ZOOM = 16;

    const state = {
        token: '',
        project: null,
        tickets: [],
        map: null,
        ticketLayers: [],
        ticketPinLayers: [],
        ticketsExtentBboxLayer: null,
        /** 'polygons' | 'pins' — last painted ticket display mode for zoom sync. */
        ticketDisplayMode: null,
        /** Guest-side map layer toggles (client only; data still loads). */
        layersDesired: {
            tickets: true,
            photos: true,
        },
        aerialLayers: new Map(),
        aerialDesired: new Map(),
        aerialCatalog: [],
        photoMarkers: null,
        photos: [],
        selectedTicketNumber: null,
        detailTab: 'details',
        mapHadInitialFit: false,
    };

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getApiBase() {
        if (typeof API_BASE !== 'undefined' && API_BASE) return String(API_BASE);
        if (window.API_BASE) return String(window.API_BASE);
        return `${window.location.origin}/api`;
    }

    function mediaUrl(photoId, kind) {
        const id = encodeURIComponent(String(photoId));
        return `${getApiBase()}/public/project-share/${state.token}/media/${id}/${kind}`;
    }

    function sharePhotoAdapter() {
        return {
            thumbnailUrl: (photo) => (photo && photo.id != null ? mediaUrl(photo.id, 'thumbnail') : ''),
            fileUrl: (photo) => (photo && photo.id != null ? mediaUrl(photo.id, 'file') : ''),
            onOpen: (photo, index, photos) => openSharePhotoViewer(photo, index, photos),
        };
    }

    function openSharePhotoViewer(photo, index, photos) {
        const viewer = window.photoViewerReadOnly;
        if (!viewer || typeof viewer.open !== 'function') return;
        const list = Array.isArray(photos) ? photos : [photo];
        const gallery = list
            .filter((p) => p && p.id != null)
            .map((p) => ({
                url: mediaUrl(p.id, 'file'),
                fileName: p.fileName || p.file_name || 'Photo',
            }));
        const idx = Math.max(
            0,
            list.findIndex((p) => p && photo && p.id === photo.id)
        );
        viewer.open(gallery[idx] || gallery[0], null, {
            gallery,
            galleryIndex: index != null ? index : idx,
        });
    }

    function parseShareTokenFromPath() {
        try {
            const fromQuery = new URLSearchParams(window.location.search).get('token');
            if (fromQuery && SHARE_TOKEN_RE.test(String(fromQuery).trim())) {
                return String(fromQuery).trim();
            }
        } catch (_e) {
            //
        }
        const parts = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        const idx = parts.indexOf('share');
        if (idx >= 0 && parts[idx + 1] && SHARE_TOKEN_RE.test(parts[idx + 1])) {
            return parts[idx + 1];
        }
        const last = parts.length ? parts[parts.length - 1] : '';
        if (last && last !== 'share' && last !== 'share.html' && SHARE_TOKEN_RE.test(last)) {
            return last;
        }
        return '';
    }

    function setStatus(message, isError) {
        const el = document.getElementById('projectShareStatus');
        const main = document.getElementById('projectShareMain');
        if (el) {
            el.hidden = false;
            el.textContent = message;
            el.style.color = isError ? '#b91c1c' : '';
        }
        if (main) main.hidden = true;
    }

    function isMobileShareLayout() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    function invalidateShareMapSize() {
        const map = state.map;
        if (!map || typeof map.invalidateSize !== 'function') return;
        window.setTimeout(() => {
            try {
                map.invalidateSize({ animate: false });
            } catch (_e) {
                //
            }
        }, 220);
    }

    function setSidebarOpen(open) {
        const main = document.getElementById('projectShareMain');
        const toggle = document.getElementById('projectSharePanelToggle');
        const backdrop = document.getElementById('projectShareSidebarBackdrop');
        const closeBtn = document.getElementById('projectShareSidebarClose');
        if (!main) return;
        const want = !!open && isMobileShareLayout();
        main.classList.toggle('is-sidebar-open', want);
        if (toggle) {
            toggle.hidden = !isMobileShareLayout();
            toggle.setAttribute('aria-expanded', want ? 'true' : 'false');
            toggle.textContent = want ? 'Close' : 'Tickets';
        }
        if (backdrop) backdrop.hidden = !want;
        if (closeBtn) closeBtn.hidden = !isMobileShareLayout();
        if (want || isMobileShareLayout()) invalidateShareMapSize();
    }

    function syncMobileChrome() {
        const toggle = document.getElementById('projectSharePanelToggle');
        const closeBtn = document.getElementById('projectShareSidebarClose');
        const mobile = isMobileShareLayout();
        if (toggle) toggle.hidden = !mobile;
        if (closeBtn) closeBtn.hidden = !mobile;
        if (!mobile) {
            const main = document.getElementById('projectShareMain');
            const backdrop = document.getElementById('projectShareSidebarBackdrop');
            if (main) main.classList.remove('is-sidebar-open');
            if (backdrop) backdrop.hidden = true;
            if (toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                toggle.textContent = 'Tickets';
            }
        }
        invalidateShareMapSize();
    }

    function sharePageUrl() {
        return window.location.href;
    }

    function setSharePanelOpen(open) {
        const wrap = document.getElementById('projectShareShareWrap');
        const btn = document.getElementById('projectShareShareBtn');
        const panel = document.getElementById('projectShareSharePanel');
        if (!btn || !panel) return;
        const want = !!open;
        panel.hidden = !want;
        btn.setAttribute('aria-expanded', want ? 'true' : 'false');
        if (wrap) wrap.classList.toggle('is-open', want);
        if (want) void ensureShareQrRendered();
    }

    async function ensureShareQrRendered() {
        const img = document.getElementById('projectShareShareQrImg');
        const status = document.getElementById('projectShareShareQrStatus');
        const urlEl = document.getElementById('projectShareShareUrl');
        const url = sharePageUrl();
        if (urlEl) urlEl.textContent = url;
        if (!img) return;
        if (img.dataset.qrUrl === url && img.getAttribute('src')) {
            img.hidden = false;
            if (status) status.hidden = true;
            return;
        }
        if (status) {
            status.hidden = false;
            status.textContent = 'Loading QR…';
        }
        img.hidden = true;
        const encode =
            typeof window.__shareLinkQrToDataUrl === 'function' ? window.__shareLinkQrToDataUrl : null;
        if (!encode) {
            if (status) status.textContent = 'QR unavailable';
            return;
        }
        try {
            const dataUrl = await encode(url, { width: 220, margin: 2 });
            img.src = dataUrl;
            img.dataset.qrUrl = url;
            img.hidden = false;
            if (status) status.hidden = true;
        } catch (_e) {
            img.removeAttribute('src');
            img.dataset.qrUrl = '';
            img.hidden = true;
            if (status) {
                status.hidden = false;
                status.textContent = 'QR unavailable';
            }
        }
    }

    function computeTicketsLatLngBounds() {
        const bounds = [];
        const pinLatLngs = [];
        state.tickets.forEach((ticket) => {
            if (ticket.polygon) {
                try {
                    const layer = L.geoJSON(ticket.polygon);
                    const b = layer.getBounds();
                    if (b.isValid()) bounds.push(b);
                } catch (_e) {
                    //
                }
            }
            if (
                ticket.stubMapPin &&
                Number.isFinite(Number(ticket.stubMapPin.lat)) &&
                Number.isFinite(Number(ticket.stubMapPin.lng))
            ) {
                pinLatLngs.push([Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng)]);
            }
        });
        if (bounds.length) {
            return bounds.reduce((acc, b) => acc.extend(b), bounds[0]);
        }
        if (pinLatLngs.length === 1) {
            return L.latLngBounds(pinLatLngs[0], pinLatLngs[0]);
        }
        if (pinLatLngs.length > 1) {
            return L.latLngBounds(pinLatLngs);
        }
        if (state.project && state.project.bounds) {
            const b = state.project.bounds;
            if (
                Number.isFinite(Number(b.minLat)) &&
                Number.isFinite(Number(b.minLng)) &&
                Number.isFinite(Number(b.maxLat)) &&
                Number.isFinite(Number(b.maxLng))
            ) {
                return L.latLngBounds(
                    [Number(b.minLat), Number(b.minLng)],
                    [Number(b.maxLat), Number(b.maxLng)]
                );
            }
        }
        return null;
    }

    function clearSharePrintBusy() {
        const el = document.getElementById('projectSharePrintBusy');
        if (el) el.remove();
    }

    function showSharePrintBusy(message, percent) {
        let el = document.getElementById('projectSharePrintBusy');
        if (!el) {
            el = document.createElement('div');
            el.id = 'projectSharePrintBusy';
            el.className = 'project-share-print-busy';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.innerHTML =
                `<div class="project-share-print-busy-card">` +
                `<p class="project-share-print-busy-msg" id="projectSharePrintBusyMsg"></p>` +
                `<div class="project-share-print-busy-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="projectSharePrintBusyTrack">` +
                `<div class="project-share-print-busy-fill" id="projectSharePrintBusyFill"></div>` +
                `</div>` +
                `</div>`;
            document.body.appendChild(el);
        }
        const msg = document.getElementById('projectSharePrintBusyMsg');
        const track = document.getElementById('projectSharePrintBusyTrack');
        const fill = document.getElementById('projectSharePrintBusyFill');
        const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        if (msg) msg.textContent = message || 'Preparing print…';
        if (fill) fill.style.width = pct + '%';
        if (track) track.setAttribute('aria-valuenow', String(pct));
        return el;
    }

    function clearSharePrintSheet() {
        document.body.classList.remove('is-printing-share');
        const existing = document.getElementById('projectSharePrintSheet');
        if (existing) existing.remove();
    }

    function waitForMainMapIdle(map, timeoutMs) {
        const ms = timeoutMs != null ? timeoutMs : 900;
        return new Promise((resolve) => {
            if (!map) {
                resolve();
                return;
            }
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                map.off('moveend', onMoveEnd);
                resolve();
            };
            const onMoveEnd = () => finish();
            const timer = window.setTimeout(finish, ms);
            map.once('moveend', onMoveEnd);
            window.setTimeout(() => {
                try {
                    map.invalidateSize({ animate: false });
                } catch (_e) {
                    //
                }
            }, 50);
        });
    }

    /**
     * html2canvas mishandles Leaflet's translate3d on .leaflet-map-pane.
     * Convert transform → left/top for the capture, then restore.
     */
    async function captureLeafletViewport(map, mapEl) {
        const capture =
            typeof window.__sharePageCaptureToDataUrl === 'function'
                ? window.__sharePageCaptureToDataUrl
                : null;
        if (!capture || !mapEl) throw new Error('Capture unavailable');

        const mapPane = map && map.getPanes && map.getPanes().mapPane;
        const restore = [];
        const flattenTransform = (el) => {
            if (!el || !el.style) return;
            const prev = {
                transform: el.style.transform,
                webkitTransform: el.style.webkitTransform,
                left: el.style.left,
                top: el.style.top,
            };
            restore.push({ el, prev });
            try {
                const matrix = new DOMMatrixReadOnly(window.getComputedStyle(el).transform);
                if (matrix.isIdentity) return;
                el.style.transform = 'none';
                el.style.webkitTransform = 'none';
                const left = (parseFloat(el.style.left) || 0) + matrix.m41;
                const top = (parseFloat(el.style.top) || 0) + matrix.m42;
                el.style.left = `${left}px`;
                el.style.top = `${top}px`;
            } catch (_e) {
                //
            }
        };

        try {
            flattenTransform(mapPane);
            // Tile / overlay zoom wrappers also use CSS transforms.
            mapEl.querySelectorAll('.leaflet-zoom-animated').forEach((el) => {
                if (el === mapPane) return;
                flattenTransform(el);
            });
            return await capture(mapEl, {
                scale: Math.min(2, window.devicePixelRatio || 1),
                backgroundColor: '#ffffff',
            });
        } finally {
            restore.reverse().forEach(({ el, prev }) => {
                el.style.transform = prev.transform;
                el.style.webkitTransform = prev.webkitTransform;
                el.style.left = prev.left;
                el.style.top = prev.top;
            });
        }
    }

    function buildSharePrintSheet(shotDataUrl, qrDataUrl, pageUrl) {
        clearSharePrintSheet();
        const sheet = document.createElement('div');
        sheet.id = 'projectSharePrintSheet';
        sheet.className = 'project-share-print-sheet';
        sheet.setAttribute('aria-hidden', 'true');
        const shot = document.createElement('img');
        shot.className = 'project-share-print-sheet-shot';
        shot.alt = 'Shared project map';
        shot.src = shotDataUrl;
        sheet.appendChild(shot);
        if (qrDataUrl) {
            const qrWrap = document.createElement('div');
            qrWrap.className = 'project-share-print-sheet-qr';
            const qrImg = document.createElement('img');
            qrImg.alt = 'QR code for this share link';
            qrImg.src = qrDataUrl;
            qrWrap.appendChild(qrImg);
            sheet.appendChild(qrWrap);
        }
        if (pageUrl) {
            const meta = document.createElement('p');
            meta.className = 'project-share-print-sheet-meta';
            meta.textContent = pageUrl;
            sheet.appendChild(meta);
        }
        document.body.appendChild(sheet);
        document.body.classList.add('is-printing-share');
        return sheet;
    }

    async function printShareProjectMap() {
        const printBtn = document.getElementById('projectShareSharePrint');
        const mapEl = document.getElementById('projectShareMap');
        const detail = document.getElementById('projectShareDetail');
        const url = sharePageUrl();
        if (printBtn) printBtn.disabled = true;

        const detailWasHidden = !detail || detail.hidden;
        try {
            showSharePrintBusy('Preparing print…', 8);
            await ensureShareQrRendered();
            const qrImg = document.getElementById('projectShareShareQrImg');
            const qrDataUrl =
                qrImg && !qrImg.hidden && qrImg.getAttribute('src') ? qrImg.getAttribute('src') : '';

            showSharePrintBusy('Preparing print…', 25);
            setSharePanelOpen(false);
            if (detail) detail.hidden = true;
            if (isMobileShareLayout()) setSidebarOpen(false);
            invalidateShareMapSize();
            await new Promise((r) => window.requestAnimationFrame(() => window.requestAnimationFrame(r)));

            const map = state.map || initMap();
            fitMapToTickets();
            showSharePrintBusy('Preparing print…', 45);
            await waitForMainMapIdle(map, 1000);
            showSharePrintBusy('Preparing print…', 65);
            await new Promise((r) => window.setTimeout(r, 700));

            showSharePrintBusy('Preparing print…', 85);
            let shotDataUrl = '';
            try {
                shotDataUrl = await captureLeafletViewport(map, mapEl);
            } catch (e) {
                console.warn('[project-share] viewport capture failed:', e);
                clearSharePrintBusy();
                window.print();
                return;
            }

            showSharePrintBusy('Preparing print…', 98);
            buildSharePrintSheet(shotDataUrl, qrDataUrl, url);

            const cleanup = () => {
                window.removeEventListener('afterprint', cleanup);
                clearSharePrintBusy();
                clearSharePrintSheet();
                if (detail && !detailWasHidden) detail.hidden = false;
                invalidateShareMapSize();
                setSharePanelOpen(true);
            };
            window.addEventListener('afterprint', cleanup);
            window.setTimeout(() => {
                clearSharePrintBusy();
                window.print();
            }, 80);
            window.setTimeout(() => {
                if (document.body.classList.contains('is-printing-share')) cleanup();
            }, 120000);
        } catch (e) {
            clearSharePrintBusy();
            throw e;
        } finally {
            if (printBtn) printBtn.disabled = false;
        }
    }

    function wireSharePanelUi() {
        const wrap = document.getElementById('projectShareShareWrap');
        const btn = document.getElementById('projectShareShareBtn');
        const panel = document.getElementById('projectShareSharePanel');
        const printBtn = document.getElementById('projectShareSharePrint');
        if (wrap) wrap.hidden = false;
        if (btn && btn.dataset.wired !== '1') {
            btn.dataset.wired = '1';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = btn.getAttribute('aria-expanded') !== 'true';
                setSharePanelOpen(open);
            });
        }
        if (printBtn && printBtn.dataset.wired !== '1') {
            printBtn.dataset.wired = '1';
            printBtn.addEventListener('click', () => {
                void printShareProjectMap();
            });
        }
        if (!wireSharePanelUi._docBound) {
            wireSharePanelUi._docBound = true;
            document.addEventListener('click', (e) => {
                const w = document.getElementById('projectShareShareWrap');
                if (!w || w.hidden || !w.classList.contains('is-open')) return;
                if (w.contains(e.target)) return;
                setSharePanelOpen(false);
            });
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const w = document.getElementById('projectShareShareWrap');
                if (!w || !w.classList.contains('is-open')) return;
                setSharePanelOpen(false);
            });
        }
    }

    function wireMobilePanelUi() {
        const toggle = document.getElementById('projectSharePanelToggle');
        const closeBtn = document.getElementById('projectShareSidebarClose');
        const backdrop = document.getElementById('projectShareSidebarBackdrop');
        if (toggle && toggle.dataset.wired !== '1') {
            toggle.dataset.wired = '1';
            toggle.addEventListener('click', () => {
                const main = document.getElementById('projectShareMain');
                const open = !(main && main.classList.contains('is-sidebar-open'));
                setSidebarOpen(open);
            });
        }
        if (closeBtn && closeBtn.dataset.wired !== '1') {
            closeBtn.dataset.wired = '1';
            closeBtn.addEventListener('click', () => setSidebarOpen(false));
        }
        if (backdrop && backdrop.dataset.wired !== '1') {
            backdrop.dataset.wired = '1';
            backdrop.addEventListener('click', () => setSidebarOpen(false));
        }
        if (!wireMobilePanelUi._resizeBound) {
            wireMobilePanelUi._resizeBound = true;
            window.addEventListener('resize', () => syncMobileChrome());
            window.addEventListener('orientationchange', () => {
                window.setTimeout(() => syncMobileChrome(), 250);
            });
        }
        syncMobileChrome();
    }

    function showMain() {
        const el = document.getElementById('projectShareStatus');
        const main = document.getElementById('projectShareMain');
        if (el) el.hidden = true;
        if (main) main.hidden = false;
        wireMobilePanelUi();
        wireSharePanelUi();
    }

    async function shareFetch(path) {
        const res = await fetch(`${getApiBase()}/public/project-share/${state.token}${path}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = (data && data.error) || `Request failed (${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    function ensurePhotoClusterGroup() {
        if (state.photoMarkers) return state.photoMarkers;
        const mod = window.mapPhotoMarkers;
        state.photoMarkers =
            mod && typeof mod.createPhotoMarkerClusterGroup === 'function'
                ? mod.createPhotoMarkerClusterGroup()
                : L.layerGroup();
        return state.photoMarkers;
    }

    function wirePhotoClusterDrawer(map) {
        const mod = window.mapPhotoMarkers;
        const group = ensurePhotoClusterGroup();
        if (!mod || typeof mod.bindPhotoClusterClick !== 'function' || !map) return;
        mod.bindPhotoClusterClick(group, map, {
            // Open list once we can't usefully zoom further (co-located / no-GPS stacks).
            drawerMinZoom: Math.min(22, map.getMaxZoom ? map.getMaxZoom() : 22),
            onOpenPhotos: (photos, meta) => {
                const list = window.photoClusterListReadOnly;
                if (!list || typeof list.open !== 'function') return;
                const adapter = sharePhotoAdapter();
                list.open(photos, {
                    thumbnailUrl: adapter.thumbnailUrl,
                    fileUrl: adapter.fileUrl,
                    title:
                        meta && meta.count
                            ? `${meta.count} photos in area`
                            : 'Photos in area',
                });
            },
        });
    }

    function createShareBasemapLayer() {
        const basemapTileOpts = { updateWhenIdle: true, updateWhenZooming: false, zIndex: 0 };
        const mapboxAccessToken =
            typeof window.getMapboxAccessToken === 'function' ? window.getMapboxAccessToken() : '';
        if (mapboxAccessToken) {
            return L.tileLayer(
                'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}@2x?access_token=' +
                    encodeURIComponent(mapboxAccessToken),
                {
                    ...basemapTileOpts,
                    tileSize: 512,
                    zoomOffset: -1,
                    attribution:
                        '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                    maxNativeZoom: 22,
                    maxZoom: 24,
                }
            );
        }
        return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            ...basemapTileOpts,
            attribution: '&copy; OpenStreetMap contributors',
            maxNativeZoom: 19,
            maxZoom: 24,
        });
    }

    function initMap() {
        if (state.map) return state.map;
        const map = L.map('projectShareMap', {
            zoomControl: true,
            maxZoom: 24,
            // Canvas vectors capture correctly with html2canvas; SVG overlays offset.
            preferCanvas: true,
        }).setView([39.5, -98.35], 4);
        createShareBasemapLayer().addTo(map);
        if (!map.getPane('ticketPane')) {
            const pane = map.createPane('ticketPane');
            pane.style.zIndex = '380';
        }
        if (!map.getPane('aerialMapPane')) {
            const pane = map.createPane('aerialMapPane');
            pane.style.zIndex = '350';
        }
        ensurePhotoClusterGroup().addTo(map);
        wirePhotoClusterDrawer(map);
        map.on('zoomend', () => {
            syncPhotoMarkersVisibility();
            syncAerialLayersForZoom();
            syncTicketLayersForZoom();
        });
        state.map = map;
        return map;
    }

    function shouldShowTicketPolygons() {
        const map = state.map;
        return !!(map && map.getZoom() >= TICKET_POLYGON_MIN_ZOOM);
    }

    /** First ring vertex of a GeoJSON Polygon/MultiPolygon as Leaflet latLng. */
    function getFirstPolygonCoordLatLng(geometry) {
        if (!geometry || !geometry.coordinates) return null;
        let ring;
        if (geometry.type === 'Polygon' && geometry.coordinates[0]) {
            ring = geometry.coordinates[0];
        } else if (
            geometry.type === 'MultiPolygon' &&
            geometry.coordinates[0] &&
            geometry.coordinates[0][0]
        ) {
            ring = geometry.coordinates[0][0];
        } else {
            return null;
        }
        if (!ring || !ring.length) return null;
        const pt = ring[0];
        if (!pt || pt.length < 2) return null;
        const lat = Number(pt[1]);
        const lng = Number(pt[0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return L.latLng(lat, lng);
    }

    /** Pin position: first polygon coordinate, else stub pin, else bbox center. */
    function getShareTicketPinLatLng(ticket) {
        if (!ticket) return null;
        if (ticket.polygon) {
            const fromPoly = getFirstPolygonCoordLatLng(ticket.polygon);
            if (fromPoly) return fromPoly;
        }
        if (
            ticket.stubMapPin &&
            Number.isFinite(Number(ticket.stubMapPin.lat)) &&
            Number.isFinite(Number(ticket.stubMapPin.lng))
        ) {
            return L.latLng(Number(ticket.stubMapPin.lat), Number(ticket.stubMapPin.lng));
        }
        const box = ticket.bbox && typeof ticket.bbox === 'object' ? ticket.bbox : null;
        if (box) {
            const minLat = Number(box.minLat);
            const maxLat = Number(box.maxLat);
            const minLng = Number(box.minLng);
            const maxLng = Number(box.maxLng);
            if (
                Number.isFinite(minLat) &&
                Number.isFinite(maxLat) &&
                Number.isFinite(minLng) &&
                Number.isFinite(maxLng)
            ) {
                return L.latLng((minLat + maxLat) / 2, (minLng + maxLng) / 2);
            }
        }
        return null;
    }

    /** Lightweight status → map color (mirrors primary workflowStatusToMapColor without tickets-core). */
    function shareTicketMapColor(ticket) {
        const status = shareTicketWorkflowKey(ticket);
        if (window.mapIcons && typeof window.mapIcons.ticketMapPinColor === 'function') {
            return window.mapIcons.ticketMapPinColor(status);
        }
        switch (status) {
            case 'READY':
                return 'var(--app-success)';
            case 'NOT_READY':
                return 'var(--app-danger)';
            case 'EXPIRING_SOON':
                return '#f59e0b';
            case 'ACTION_REQUIRED':
                return '#facc15';
            case 'EXPIRED':
            case 'CANCELLED':
                return '#6b7280';
            default:
                return '#2563eb';
        }
    }

    function shareTicketWorkflowKey(ticket) {
        const raw =
            (ticket && (ticket.workflowStatus || ticket.status || ticket.ticketStatus)) || '';
        return String(raw)
            .trim()
            .toUpperCase()
            .replace(/\s+/g, '_');
    }

    function sharePolygonStyle(ticket, selected) {
        const fillColor = '#3b82f6';
        const strokeColor = selected ? '#1e40af' : '#2563eb';
        return {
            className: 'ticket-map-polygon',
            color: strokeColor,
            dashArray: null,
            weight: selected ? 4 : 2,
            fillColor,
            fillOpacity: selected ? 0.35 : 0.22,
        };
    }

    function clearTicketsExtentBbox() {
        const map = state.map;
        if (!map || !state.ticketsExtentBboxLayer) return;
        try {
            map.removeLayer(state.ticketsExtentBboxLayer);
        } catch (_e) {
            //
        }
        state.ticketsExtentBboxLayer = null;
    }

    function clearTicketLayers() {
        const map = state.map;
        if (!map) return;
        state.ticketLayers.forEach((layer) => {
            try {
                map.removeLayer(layer);
            } catch (_e) {
                //
            }
        });
        state.ticketLayers = [];
        state.ticketPinLayers.forEach((layer) => {
            try {
                map.removeLayer(layer);
            } catch (_e) {
                //
            }
        });
        state.ticketPinLayers = [];
        clearTicketsExtentBbox();
    }

    function fitMapToTickets() {
        const map = state.map;
        if (!map) return;
        const bounds = computeTicketsLatLngBounds();
        if (!bounds || !bounds.isValid || !bounds.isValid()) return;
        if (bounds.getNorth() === bounds.getSouth() && bounds.getEast() === bounds.getWest()) {
            map.setView(bounds.getCenter(), 20);
            return;
        }
        // Zoom in as far as needed to fill the view; only zoom out when tickets won't fit.
        map.fitBounds(bounds, { padding: [28, 28], maxZoom: 22, animate: false });
    }

    function focusMapOnTicket(ticketNumber) {
        const map = state.map;
        if (!map || ticketNumber == null) return;
        const ticket = state.tickets.find(
            (t) => t && String(t.ticketNumber) === String(ticketNumber)
        );
        if (!ticket) return;
        if (ticket.polygon) {
            try {
                const layer = L.geoJSON(ticket.polygon);
                const b = layer.getBounds();
                if (b.isValid()) {
                    if (b.getNorth() === b.getSouth() && b.getEast() === b.getWest()) {
                        map.setView(b.getCenter(), Math.max(TICKET_POLYGON_MIN_ZOOM, 21), {
                            animate: true,
                        });
                    } else {
                        const clampToPolygonZoom = () => {
                            if (map.getZoom() < TICKET_POLYGON_MIN_ZOOM) {
                                map.setView(b.getCenter(), TICKET_POLYGON_MIN_ZOOM, {
                                    animate: false,
                                });
                            }
                        };
                        map.once('moveend', clampToPolygonZoom);
                        map.fitBounds(b, { padding: [40, 40], maxZoom: 22, animate: true });
                    }
                    return;
                }
            } catch (_e) {
                //
            }
        }
        const pin = getShareTicketPinLatLng(ticket);
        if (pin) {
            map.setView(pin, Math.max(map.getZoom(), TICKET_POLYGON_MIN_ZOOM, 20), {
                animate: true,
            });
        }
    }

    /** Zoom to ticket after detail panel / sidebar layout settles. */
    function focusMapOnTicketAfterLayout(ticketNumber) {
        window.setTimeout(() => {
            try {
                if (state.map) state.map.invalidateSize({ animate: false });
            } catch (_e) {
                //
            }
            focusMapOnTicket(ticketNumber);
        }, 240);
    }

    function ticketPinIcon(ticket, selected) {
        const label = escapeHtml(ticket.ticketNumber || 'Ticket');
        const status = shareTicketWorkflowKey(ticket);
        const borderStyle = selected
            ? '2px solid var(--app-text-inverse, #fff)'
            : '1.5px solid rgba(0,0,0,0.25)';
        const pinHtml =
            window.mapIcons && typeof window.mapIcons.buildTicketMapPinMarkerHtml === 'function'
                ? window.mapIcons.buildTicketMapPinMarkerHtml(status, 18, borderStyle)
                : `<div class="ticket-811-marker-icon" style="color:${shareTicketMapColor(ticket)};border:${borderStyle};"></div>`;
        const iconHtml =
            `<div class="ticket-811-marker-content" title="${label}">` +
            pinHtml +
            `<span class="project-share-ticket-pin-label">${label}</span>` +
            `</div>`;
        return L.divIcon({
            className: 'ticket-811-marker-wrap project-share-ticket-pin',
            html: iconHtml,
            iconSize: [140, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -16],
        });
    }

    function renderTicketPin(ticket) {
        const map = state.map;
        if (!map || !ticket) return;
        const latLng = getShareTicketPinLatLng(ticket);
        if (!latLng) return;
        const selected =
            state.selectedTicketNumber &&
            String(ticket.ticketNumber) === String(state.selectedTicketNumber);
        const marker = L.marker(latLng, {
            pane: 'ticketPane',
            icon: ticketPinIcon(ticket, selected),
            riseOnHover: true,
        });
        marker.bindTooltip(escapeHtml(ticket.ticketNumber || ''), { sticky: true });
        marker.on('click', () => selectTicket(ticket.ticketNumber));
        marker.addTo(map);
        state.ticketPinLayers.push(marker);
    }

    function renderTicketsExtentBbox() {
        const map = state.map;
        if (!map) return;
        clearTicketsExtentBbox();
        const bounds = computeTicketsLatLngBounds();
        if (!bounds || !bounds.isValid || !bounds.isValid()) return;
        if (bounds.getNorth() === bounds.getSouth() && bounds.getEast() === bounds.getWest()) {
            return;
        }
        const rect = L.rectangle(bounds, {
            pane: 'ticketPane',
            className: 'project-share-tickets-extent-bbox',
            color: '#1e40af',
            weight: 2,
            dashArray: '6, 6',
            fillColor: '#3b82f6',
            fillOpacity: 0.06,
            interactive: false,
        });
        rect.addTo(map);
        state.ticketsExtentBboxLayer = rect;
    }

    function paintTicketLayers() {
        const map = state.map;
        if (!map) return;
        clearTicketLayers();
        if (state.layersDesired.tickets === false) {
            state.ticketDisplayMode = null;
            return;
        }
        const showPolygons = shouldShowTicketPolygons();
        state.ticketDisplayMode = showPolygons ? 'polygons' : 'pins';
        if (showPolygons) {
            state.tickets.forEach((ticket) => {
                if (ticket.polygon) {
                    try {
                        const selected =
                            state.selectedTicketNumber &&
                            String(ticket.ticketNumber) === String(state.selectedTicketNumber);
                        const layer = L.geoJSON(ticket.polygon, {
                            pane: 'ticketPane',
                            style: sharePolygonStyle(ticket, selected),
                        });
                        layer.bindTooltip(escapeHtml(ticket.ticketNumber || ''), { sticky: true });
                        layer.on('click', () => selectTicket(ticket.ticketNumber));
                        layer.addTo(map);
                        state.ticketLayers.push(layer);
                    } catch (_e) {
                        //
                    }
                } else {
                    renderTicketPin(ticket);
                }
            });
            return;
        }
        // Overview: pins at first polygon coordinate + bbox around all tickets.
        state.tickets.forEach((ticket) => renderTicketPin(ticket));
        renderTicketsExtentBbox();
    }

    function syncTicketLayersForZoom() {
        if (!state.map || !state.mapHadInitialFit) return;
        const want = shouldShowTicketPolygons() ? 'polygons' : 'pins';
        if (want === state.ticketDisplayMode) return;
        paintTicketLayers();
    }

    function renderTicketPolygons(opts) {
        initMap();
        // Fit first so paint chooses pins+bbox when the project overview lands below zoom 16.
        if (opts && opts.fit) fitMapToTickets();
        paintTicketLayers();
    }

    async function backfillMissingPolygonsFromNv() {
        const missing = state.tickets.filter((t) => !t.polygon);
        if (!missing.length) return;
        const nv = window.projectShareNvPublic;
        if (!nv || typeof nv.fetchNvMapPolygonForShareViewer !== 'function') return;
        await Promise.all(
            missing.map(async (ticket) => {
                try {
                    const data = await nv.fetchNvMapPolygonForShareViewer(
                        getApiBase(),
                        state.token,
                        ticket.ticketNumber
                    );
                    if (data && data.polygon && data.polygon.type === 'Polygon') {
                        ticket.polygon = data.polygon;
                    }
                } catch (e) {
                    console.warn('[project-share] map polygon backfill:', ticket.ticketNumber, e);
                }
            })
        );
        if (state.tickets.some((t) => t.polygon)) {
            renderTicketPolygons();
            await loadAerialMaps();
            syncAerialLayersForZoom();
        }
    }

    function renderTicketList() {
        const list = document.getElementById('projectShareTicketList');
        if (!list) return;
        list.innerHTML = state.tickets
            .map((t) => {
                const tn = t.ticketNumber != null ? String(t.ticketNumber) : '';
                const active = state.selectedTicketNumber === tn ? ' is-active' : '';
                const addr = t.address || t.fullAddress || '';
                return (
                    `<button type="button" class="project-share-ticket-item${active}" data-share-ticket="${escapeHtml(tn)}" role="listitem">` +
                    `<span class="project-share-ticket-num">${escapeHtml(tn)}</span>` +
                    `<span class="project-share-ticket-address">${escapeHtml(addr || '—')}</span>` +
                    '</button>'
                );
            })
            .join('');
        list.querySelectorAll('[data-share-ticket]').forEach((btn) => {
            btn.addEventListener('click', () => selectTicket(btn.getAttribute('data-share-ticket')));
        });
    }

    function loadAerialMapLayer(aerialMap) {
        const map = state.map;
        const helper = aerialHelper();
        if (!map || !aerialMap || !helper || typeof helper.createAerialTileLayer !== 'function') return;
        const mapId = aerialMap.id != null ? String(aerialMap.id) : aerialMap.url;
        if (state.aerialLayers.has(mapId)) return;
        const created = helper.createAerialTileLayer(aerialMap, {});
        if (!created) return;
        if (typeof helper.ensureAerialMapStyles === 'function') helper.ensureAerialMapStyles();
        state.aerialLayers.set(mapId, created.layer);
        if (!state.aerialDesired.has(mapId)) state.aerialDesired.set(mapId, true);
        syncAerialLayersForZoom();
    }

    function syncAerialLayersForZoom() {
        const map = state.map;
        if (!map) return;
        const zoomOk = map.getZoom() >= AERIAL_MIN_RENDER_ZOOM;
        state.aerialLayers.forEach((layer, mapId) => {
            const want = zoomOk && state.aerialDesired.get(mapId) !== false;
            if (want && !map.hasLayer(layer)) layer.addTo(map);
            if (!want && map.hasLayer(layer)) map.removeLayer(layer);
        });
    }

    function renderAerialToggleList() {
        const host = document.getElementById('projectShareAerialList');
        if (!host) return;
        if (!state.aerialCatalog.length) {
            host.innerHTML = '<p class="project-share-aerial-empty">No aerial maps for this project.</p>';
            return;
        }
        host.innerHTML = state.aerialCatalog
            .map((m) => {
                const id = m.id != null ? String(m.id) : '';
                const name = escapeHtml(m.name || `Aerial ${id}`);
                const checked = state.aerialDesired.get(id) !== false ? ' checked' : '';
                return (
                    `<label class="project-share-aerial-item">` +
                    `<input type="checkbox" data-share-aerial-id="${escapeHtml(id)}"${checked}>` +
                    `<span>${name}</span>` +
                    `</label>`
                );
            })
            .join('');
        host.querySelectorAll('[data-share-aerial-id]').forEach((input) => {
            input.addEventListener('change', () => {
                const id = input.getAttribute('data-share-aerial-id');
                state.aerialDesired.set(id, !!input.checked);
                syncAerialLayersForZoom();
            });
        });
    }

    async function loadAerialMaps() {
        try {
            const data = await shareFetch('/aerial-maps');
            const maps = Array.isArray(data.maps) ? data.maps : [];
            state.aerialCatalog = maps;
            maps.forEach((m) => loadAerialMapLayer(m));
            renderAerialToggleList();
        } catch (e) {
            console.warn('[project-share] aerial maps:', e);
        }
    }

    function clearPhotoMarkers() {
        const group = ensurePhotoClusterGroup();
        if (group && typeof group.clearLayers === 'function') group.clearLayers();
    }

    function syncPhotoMarkersVisibility() {
        const map = state.map;
        if (!map) return;
        const group = ensurePhotoClusterGroup();
        const show = state.layersDesired.photos !== false && map.getZoom() >= PHOTO_MIN_ZOOM;
        if (show && !map.hasLayer(group)) group.addTo(map);
        if (!show && map.hasLayer(group)) map.removeLayer(group);
    }

    async function loadPhotosForViewport() {
        const map = state.map;
        if (!map || state.layersDesired.photos === false || map.getZoom() < PHOTO_MIN_ZOOM) {
            clearPhotoMarkers();
            return;
        }
        const b = map.getBounds();
        const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
        try {
            const data = await shareFetch(`/photos?bbox=${encodeURIComponent(bbox)}&limit=500`);
            state.photos = Array.isArray(data.photos) ? data.photos : [];
            const mod = window.mapPhotoMarkers;
            const group = ensurePhotoClusterGroup();
            if (mod && typeof mod.setPhotoMarkersOnGroup === 'function') {
                mod.setPhotoMarkersOnGroup(group, state.photos, sharePhotoAdapter());
            } else {
                clearPhotoMarkers();
            }
            syncPhotoMarkersVisibility();
        } catch (e) {
            console.warn('[project-share] photos:', e);
        }
    }

    function formatTextValue(v) {
        if (v == null || v === '') return '—';
        return String(v);
    }

    function formatDateValue(v) {
        if (v == null || v === '') return '—';
        const nv = window.projectShareNvPublic;
        if (nv && typeof nv.formatShareDateTime === 'function') {
            return nv.formatShareDateTime(v);
        }
        return String(v);
    }

    function renderDetailTab(ticket) {
        const body = document.getElementById('projectShareDetailBody');
        if (!body || !ticket) return;
        if (state.detailTab === 'details') {
            body.innerHTML =
                '<dl class="project-share-detail-dl">' +
                `<dt>Address</dt><dd>${escapeHtml(formatTextValue(ticket.address || ticket.fullAddress))}</dd>` +
                `<dt>Work description</dt><dd>${escapeHtml(formatTextValue(ticket.workDescription))}</dd>` +
                `<dt>Scope</dt><dd>${escapeHtml(formatTextValue(ticket.scopeOfWork))}</dd>` +
                `<dt>Category</dt><dd>${escapeHtml(formatTextValue(ticket.categoryOfWork))}</dd>` +
                `<dt>Status</dt><dd>${escapeHtml(formatTextValue(ticket.workflowStatus))}</dd>` +
                `<dt>Start</dt><dd>${escapeHtml(formatDateValue(ticket.startTime))}</dd>` +
                `<dt>Expires</dt><dd>${escapeHtml(formatDateValue(ticket.ticketExpirationDate))}</dd>` +
                '</dl>';
            updateResponsesTabDot(ticket);
            return;
        }
        if (state.detailTab === 'responses') {
            const rows = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
            if (!rows.length) {
                body.innerHTML = '<p>No operator responses on file.</p>';
                updateResponsesTabDot(ticket);
                return;
            }
            const statusMod = window.shareOperatorResponseStatus;
            body.innerHTML = rows
                .map((r) => {
                    const classified =
                        statusMod && typeof statusMod.classifyShareOperatorResponse === 'function'
                            ? statusMod.classifyShareOperatorResponse(r)
                            : r.operatorStatus || 'READY';
                    const rowClass =
                        statusMod && typeof statusMod.responseRowModifierClass === 'function'
                            ? statusMod.responseRowModifierClass(classified)
                            : 'project-share-response-row--ready';
                    const badgeClass =
                        statusMod && typeof statusMod.badgeModifierClass === 'function'
                            ? statusMod.badgeModifierClass(classified)
                            : 'project-share-status-badge--ready';
                    const statusLabel =
                        statusMod && typeof statusMod.formatWorkflowStatusDisplay === 'function'
                            ? statusMod.formatWorkflowStatusDisplay(classified)
                            : String(classified).replace(/_/g, ' ');
                    const label = [r.operatorName, r.stationCode || r.operatorCode].filter(Boolean).join(' · ');
                    const code =
                        r.statusCode != null && String(r.statusCode).trim() !== ''
                            ? String(r.statusCode).trim()
                            : '';
                    const description =
                        r.responseDescription != null && String(r.responseDescription).trim() !== ''
                            ? String(r.responseDescription).trim()
                            : '';
                    const comment =
                        r.comment != null && String(r.comment).trim() !== '' ? String(r.comment).trim() : '';
                    const when = formatDateValue(r.respondedAt || r.responseReceived || '');
                    const metaParts = [];
                    if (code) metaParts.push(`Code ${escapeHtml(code)}`);
                    if (description) metaParts.push(escapeHtml(description));
                    const metaHtml = metaParts.length
                        ? `<div class="project-share-response-meta">${metaParts.join(' · ')}</div>`
                        : '';
                    const commentHtml = comment
                        ? `<div class="project-share-response-comment">${escapeHtml(comment)}</div>`
                        : '';
                    return (
                        `<div class="project-share-response-row ${rowClass}">` +
                        `<div class="project-share-response-row-header">` +
                        `<strong>${escapeHtml(label || 'Operator')}</strong>` +
                        `<span class="project-share-status-badge ${badgeClass}">${escapeHtml(statusLabel)}</span>` +
                        `</div>` +
                        metaHtml +
                        commentHtml +
                        `<div class="project-share-ticket-address">${escapeHtml(when)}</div>` +
                        '</div>'
                    );
                })
                .join('');
            updateResponsesTabDot(ticket);
            return;
        }
        updateResponsesTabDot(ticket);
    }

    function updateResponsesTabDot(ticket) {
        const dot = document.querySelector('[data-share-responses-tab-dot]');
        const tabBtn = document.querySelector('[data-share-detail-tab="responses"]');
        if (!dot) return;
        const statusMod = window.shareOperatorResponseStatus;
        const rows = ticket && Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
        const worst =
            statusMod && typeof statusMod.worstResponsesTabStatus === 'function'
                ? statusMod.worstResponsesTabStatus(rows)
                : null;
        const dotClass =
            statusMod && typeof statusMod.workflowStatusToDotClass === 'function'
                ? statusMod.workflowStatusToDotClass(worst)
                : null;
        dot.className = 'project-share-detail-tab-dot';
        if (dotClass) {
            dot.classList.add(`project-share-detail-tab-dot--${dotClass}`);
            dot.hidden = false;
            const label =
                worst === 'NOT_READY'
                    ? 'Not ready'
                    : worst === 'ACTION_REQUIRED'
                      ? 'Review required'
                      : '';
            if (tabBtn) {
                tabBtn.setAttribute('aria-label', label ? `Responses: ${label}` : 'Responses');
            }
        } else {
            dot.hidden = true;
            if (tabBtn) tabBtn.setAttribute('aria-label', 'Responses');
        }
    }

    async function openTicketDetail(ticketNumber) {
        const panel = document.getElementById('projectShareDetail');
        const title = document.getElementById('projectShareDetailTitle');
        if (!panel || !ticketNumber) return;
        state.selectedTicketNumber = String(ticketNumber);
        if (isMobileShareLayout()) setSidebarOpen(false);
        renderTicketList();
        renderTicketPolygons();
        if (title) title.textContent = String(ticketNumber);
        panel.hidden = false;
        invalidateShareMapSize();
        focusMapOnTicketAfterLayout(ticketNumber);
        const body = document.getElementById('projectShareDetailBody');
        if (body) body.innerHTML = '<p>Loading ticket from Nevada 811…</p>';
        try {
            const tn = encodeURIComponent(ticketNumber);
            const [localData, posrJson] = await Promise.all([
                shareFetch(`/tickets/${tn}`),
                (async () => {
                    const nv = window.projectShareNvPublic;
                    if (!nv) return null;
                    try {
                        return await nv.fetchNvPosrForShareViewer(getApiBase(), state.token, ticketNumber);
                    } catch (e) {
                        console.warn('[project-share] NV public POSR:', e);
                        return null;
                    }
                })(),
            ]);
            let ticket = localData && localData.ticket ? localData.ticket : null;
            if (!ticket) throw new Error('Ticket not found');
            const nv = window.projectShareNvPublic;
            if (nv && posrJson) {
                const parsed = nv.parsePosrForShareDetail(posrJson);
                ticket = nv.mergeShareTicketWithNvPosr(ticket, parsed);
            }
            renderDetailTab(ticket);
            panel._shareTicket = ticket;
        } catch (e) {
            if (body) body.textContent = e.message || 'Failed to load ticket';
        }
    }

    function selectTicket(ticketNumber) {
        if (!ticketNumber) return;
        void openTicketDetail(ticketNumber);
    }

    function wireDetailUi() {
        const closeBtn = document.getElementById('projectShareDetailClose');
        const panel = document.getElementById('projectShareDetail');
        if (closeBtn && panel && closeBtn.dataset.wired !== '1') {
            closeBtn.dataset.wired = '1';
            closeBtn.addEventListener('click', () => {
                panel.hidden = true;
                state.selectedTicketNumber = null;
                renderTicketList();
                renderTicketPolygons();
                invalidateShareMapSize();
            });
        }
        document.querySelectorAll('[data-share-detail-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.detailTab = btn.getAttribute('data-share-detail-tab') || 'details';
                document.querySelectorAll('[data-share-detail-tab]').forEach((b) => {
                    b.classList.toggle('is-active', b === btn);
                });
                const ticket = panel && panel._shareTicket;
                if (ticket) renderDetailTab(ticket);
            });
        });
    }

    function wireLayerToggles() {
        const ticketsInput = document.getElementById('projectShareToggleTickets');
        const photosInput = document.getElementById('projectShareTogglePhotos');
        if (ticketsInput && ticketsInput.dataset.wired !== '1') {
            ticketsInput.dataset.wired = '1';
            ticketsInput.checked = state.layersDesired.tickets !== false;
            ticketsInput.addEventListener('change', () => {
                state.layersDesired.tickets = !!ticketsInput.checked;
                paintTicketLayers();
            });
        }
        if (photosInput && photosInput.dataset.wired !== '1') {
            photosInput.dataset.wired = '1';
            photosInput.checked = state.layersDesired.photos !== false;
            photosInput.addEventListener('change', () => {
                state.layersDesired.photos = !!photosInput.checked;
                if (state.layersDesired.photos) {
                    void loadPhotosForViewport();
                } else {
                    clearPhotoMarkers();
                    syncPhotoMarkersVisibility();
                }
            });
        }
    }

    async function loadProject() {
        const data = await shareFetch('');
        state.project = data;
        state.tickets = Array.isArray(data.tickets) ? data.tickets : [];
        const title = document.getElementById('projectShareTitle');
        const badge = document.getElementById('projectShareBadge');
        if (title) title.textContent = data.projectName || 'Shared project';
        if (badge) {
            if (data.closed) {
                badge.textContent = 'Closed project · Shared view';
                badge.classList.add('project-share-badge--closed');
            } else {
                badge.textContent = 'Shared view · Read only';
            }
        }
        showMain();
        initMap();
        wireLayerToggles();
        renderTicketList();
        wireDetailUi();
        invalidateShareMapSize();
        const map = state.map;
        if (map) {
            map.on('moveend', () => void loadPhotosForViewport());
        }
        await backfillMissingPolygonsFromNv();
        renderTicketPolygons({ fit: true });
        state.mapHadInitialFit = true;
        await loadAerialMaps();
        await loadPhotosForViewport();
    }

    async function boot() {
        state.token = parseShareTokenFromPath();
        if (!SHARE_TOKEN_RE.test(state.token)) {
            setStatus('Invalid share link.', true);
            return;
        }
        try {
            await loadProject();
        } catch (e) {
            setStatus(e.message || 'This share link is not available.', true);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void boot());
    } else {
        void boot();
    }
})();
