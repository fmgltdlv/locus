/**
 * Per-ticket USAN documents: Confirmation (cached per revision) + Full history (lazy on tab).
 * Background prefetch caches confirmation only; Full history loads when the user opens that tab.
 */
(function (global) {
    'use strict';

    const MODAL_OVERLAY_ID = 'ticketDocumentPackViewerOverlay';
    // Match both legacy `{base}-confirmation-sheet.pdf` and current
    // `{ticket} - {job} - confirmation-sheet.pdf` ZIP entry names.
    const CONFIRMATION_SUFFIX = 'confirmation-sheet.pdf';
    const FULL_HISTORY_SUFFIX = 'full-history.pdf';
    const MOBILE_PDF_VIEWER_MQ = '(max-width: 768px)';
    const MOBILE_ZOOM_STEP = 1.25;
    const MOBILE_ZOOM_MIN_FACTOR = 0.5;
    const MOBILE_ZOOM_MAX_FACTOR = 4;
    const MOBILE_DOUBLE_TAP_MS = 320;
    const MOBILE_DOUBLE_TAP_MAX_DIST = 36;
    const MOBILE_DOUBLE_TAP_ZOOM_FACTOR = 2;

    let viewerInFlight = false;
    /** @type {Map<string, Promise<void>>} */
    const prefetchInFlight = new Map();
    /** Orgs where usan-document-pack returned missing credentials — skip further prefetch this session. */
    const prefetchCredentialsMissingOrgs = new Set();

    /** @type {{
     *   ticket: object,
     *   orgId: string|number,
     *   ticketBase: string,
     *   zipFilename: string,
     *   fullHistoryPdfFilename: string,
     *   confirmationBlob: Blob|null,
     *   fullHistoryBlob: Blob|null,
     *   selectedRevision: string,
     *   revisionOptions: { revision: string, status: string|null }[],
     *   blobUrls: string[],
     *   activeTab: string,
     *   pdfDocs: Record<string, object>,
     *   mobileBaseScaleByTab: Record<string, number>,
     *   mobileScaleByTab: Record<string, number>,
     *   fullHistoryLoaded: boolean,
     *   fullHistoryLoading: boolean
     * } | null} */
    let modalSession = null;
    /** @type {{ overlay: HTMLElement, startDistance: number, startScale: number, pendingScale: number, lastCenter: { x: number, y: number } } | null} */
    let mobilePinchState = null;
    /** @type {{ time: number, x: number, y: number } | null} */
    let mobileLastTap = null;

    function parseTicketNumberParts(ticketNumber) {
        const raw = String(ticketNumber || '').trim();
        if (!raw) {
            return { baseNumber: '', revisionSuffix: null, displayFull: '' };
        }
        const idx = raw.indexOf('-');
        if (idx === -1) {
            return { baseNumber: raw, revisionSuffix: null, displayFull: raw };
        }
        const baseNumber = raw.slice(0, idx);
        const revisionSuffix = raw.slice(idx + 1) || null;
        return { baseNumber, revisionSuffix, displayFull: raw };
    }

    function resolveRequestNumberForTicket(ticket) {
        if (!ticket) return null;
        const candidates = [
            ticket.ticketNumberFull,
            ticket.ticketNumber,
            ticket.requestNumberFull,
        ];
        for (const c of candidates) {
            const s = c != null ? String(c).trim() : '';
            if (!s) continue;
            const parts = parseTicketNumberParts(s);
            if (parts.revisionSuffix != null && String(parts.revisionSuffix).trim() !== '') {
                return parts.displayFull;
            }
        }
        const base =
            ticket.ticketBaseNumber != null && String(ticket.ticketBaseNumber).trim() !== ''
                ? String(ticket.ticketBaseNumber).trim()
                : parseTicketNumberParts(ticket.ticketNumber || '').baseNumber;
        const rev =
            ticket.ticketRevision != null && String(ticket.ticketRevision).trim() !== ''
                ? String(ticket.ticketRevision).trim()
                : null;
        if (base && rev) {
            return `${base}-${rev}`;
        }
        return null;
    }

    function hasUsanEnquiryId(ticket) {
        if (typeof global.getUsanEnquiryIdFromTicket === 'function') {
            return !!global.getUsanEnquiryIdFromTicket(ticket);
        }
        if (ticket && ticket.ngenJobNumber != null && String(ticket.ngenJobNumber).trim() !== '') {
            return true;
        }
        if (ticket && ticket.providerJobNumber != null && String(ticket.providerJobNumber).trim() !== '') {
            return true;
        }
        return false;
    }

    function shouldShowDocumentPackButton(ticket) {
        if (!ticket) return false;
        return hasUsanEnquiryId(ticket) && !!resolveRequestNumberForTicket(ticket);
    }

    function resolveOrganizationId(ticket) {
        if (typeof global.getCurrentOrgId === 'function') {
            const oid = global.getCurrentOrgId();
            if (oid != null) return oid;
        }
        if (ticket && ticket.organizationId != null) return ticket.organizationId;
        if (global.authModule && typeof global.authModule.getCurrentUser === 'function') {
            const user = global.authModule.getCurrentUser();
            if (user && user.organizationId != null) return user.organizationId;
        }
        return null;
    }

    function getAuthToken() {
        if (global.authModule && typeof global.authModule.getAuthToken === 'function') {
            return global.authModule.getAuthToken();
        }
        try {
            return localStorage.getItem('authToken');
        } catch {
            return null;
        }
    }

    function isOnline() {
        if (global.offlineConnectivity && typeof global.offlineConnectivity.isOnline === 'function') {
            return global.offlineConnectivity.isOnline();
        }
        return typeof navigator === 'undefined' || navigator.onLine !== false;
    }

    function userFacingErrorMessage(err, fallback) {
        const msg = err && err.message ? String(err.message) : fallback;
        if (msg.includes('NGEN_HISTORY_CREDENTIALS_MISSING')) {
            return 'USAN document download is unavailable for this organization. Contact support to configure credentials.';
        }
        return msg || fallback;
    }

    function escHtml(s) {
        if (typeof global.escapeHtmlText === 'function') {
            return global.escapeHtmlText(s);
        }
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function sanitizeFilenamePart(value) {
        return String(value || '')
            .trim()
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
            .replace(/\s+/g, ' ')
            .slice(0, 120);
    }

    function resolveJobNameForTicket(ticket) {
        const thdm = global.ticketHubDisplayMap;
        if (thdm && typeof thdm.pickTicketField === 'function') {
            const v = thdm.pickTicketField(ticket, 'jobName');
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        const raw =
            ticket.jobName ||
            ticket.providerUserReference ||
            ticket.ngenUserReference ||
            ticket.jobNumberName;
        return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
    }

    function resolveRequestNumberForRevision(ticket, revision) {
        const rev = revision != null ? String(revision).trim() : '';
        if (!ticket || !rev) {
            return resolveRequestNumberForTicket(ticket) || String(ticket.ticketNumber || '').trim();
        }
        if (Array.isArray(ticket.revisionEnquiries)) {
            const match = ticket.revisionEnquiries.find((e) => e && String(e.revision).trim() === rev);
            if (match && match.requestNumber != null && String(match.requestNumber).trim() !== '') {
                return String(match.requestNumber).trim();
            }
        }
        const base = resolveTicketBase(ticket);
        if (base) return `${base}-${rev}`;
        return resolveRequestNumberForTicket(ticket) || String(ticket.ticketNumber || '').trim();
    }

    function buildDocumentPackNamePrefix(ticket, revision) {
        const ticketNumber = resolveRequestNumberForRevision(ticket, revision);
        const jobName = sanitizeFilenamePart(resolveJobNameForTicket(ticket));
        if (ticketNumber && jobName) return `${ticketNumber} - ${jobName}`;
        return ticketNumber || jobName || 'document';
    }

    function buildDocumentPackZipFilename(ticket) {
        return `${buildDocumentPackNamePrefix(ticket)} - documents.zip`;
    }

    function buildConfirmationPdfFilename(ticket, revision) {
        return `${buildDocumentPackNamePrefix(ticket, revision)} - confirmation-sheet.pdf`;
    }

    function buildFullHistoryPdfFilename(ticket) {
        return `${buildDocumentPackNamePrefix(ticket)} - full-history.pdf`;
    }

    function getApiBase() {
        return global.authModule && global.authModule.API_BASE
            ? global.authModule.API_BASE
            : global.API_BASE || '/api';
    }

    function buildDocumentPackUrl(tn, orgId, opts) {
        const q = new URLSearchParams();
        q.set('organizationId', String(orgId));
        if (opts && opts.confirmationOnly) q.set('confirmationOnly', '1');
        if (opts && opts.fullHistoryOnly) q.set('fullHistoryOnly', '1');
        if (opts && opts.revision) q.set('revision', String(opts.revision));
        return `${getApiBase()}/tickets/${encodeURIComponent(tn)}/usan-document-pack?${q.toString()}`;
    }

    function resolveTicketBase(ticket) {
        if (global.offlineUsanDocs && typeof global.offlineUsanDocs.resolveTicketBase === 'function') {
            return global.offlineUsanDocs.resolveTicketBase(ticket);
        }
        return parseTicketNumberParts(resolveRequestNumberForTicket(ticket) || ticket.ticketNumber || '').baseNumber;
    }

    function resolveCurrentRevision(ticket) {
        if (global.offlineUsanDocs && typeof global.offlineUsanDocs.resolveRevision === 'function') {
            const r = global.offlineUsanDocs.resolveRevision(ticket);
            if (r) return r;
        }
        const parts = parseTicketNumberParts(resolveRequestNumberForTicket(ticket) || '');
        return parts.revisionSuffix || '000';
    }

    function collectRevisionOptions(ticket) {
        const map = new Map();
        const current = resolveCurrentRevision(ticket);
        const currentStatus =
            ticket && ticket.ngenEnquiryStatus != null ? String(ticket.ngenEnquiryStatus).trim() : null;
        if (current) map.set(current, { revision: current, status: currentStatus });

        const list = Array.isArray(ticket && ticket.revisionEnquiries) ? ticket.revisionEnquiries : [];
        for (const e of list) {
            if (!e || e.revision == null) continue;
            const rev = String(e.revision).trim();
            if (!rev) continue;
            const status = e.status != null ? String(e.status).trim() : null;
            const prev = map.get(rev);
            if (!prev) {
                map.set(rev, { revision: rev, status: status });
            } else if (!prev.status && status) {
                prev.status = status;
            }
        }
        return Array.from(map.values()).sort((a, b) => String(a.revision).localeCompare(String(b.revision)));
    }

    function formatRevisionLabel(opt) {
        if (!opt) return '';
        const rev = String(opt.revision || '');
        const st = opt.status ? String(opt.status).trim() : '';
        return st ? `${rev} · ${st}` : rev;
    }

    /**
     * @returns {{ tn: string, orgId: string|number, token: string, ticketBase: string, revision: string, zipFilename: string } | null}
     */
    function resolveDocumentPackRequest(ticket) {
        if (!shouldShowDocumentPackButton(ticket)) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert('USAN documents are not available for this ticket yet. Refresh from PAC/nGen first.');
            }
            return null;
        }

        const tn = String(ticket.ticketNumber || resolveRequestNumberForTicket(ticket) || '').trim();
        if (!tn) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket number is missing.');
            return null;
        }

        const orgId = resolveOrganizationId(ticket);
        if (orgId == null) {
            if (typeof global.appAlert === 'function') void global.appAlert('Organization is required to download documents.');
            return null;
        }

        const token = getAuthToken();
        if (!token) {
            if (typeof global.appAlert === 'function') void global.appAlert('Not authenticated.');
            return null;
        }

        const ticketBase = resolveTicketBase(ticket) || tn;
        const revision = resolveCurrentRevision(ticket);
        return {
            tn,
            orgId,
            token,
            ticketBase,
            revision,
            zipFilename: buildDocumentPackZipFilename(ticket),
            fullHistoryPdfFilename: buildFullHistoryPdfFilename(ticket),
        };
    }

    async function fetchDocumentPackZipResponse(url, token) {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (response.status === 401) {
            if (global.authModule && typeof global.authModule.logout === 'function') {
                global.authModule.logout();
            }
            throw new Error('Authentication expired');
        }

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            const raw = await response.text();
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    if (data && data.error) errMsg = String(data.error);
                    if (data && data.code) errMsg = `${data.code}: ${errMsg}`;
                } catch {
                    errMsg = raw.slice(0, 200) || errMsg;
                }
            }
            throw new Error(errMsg);
        }

        return response.blob();
    }

    function getUnzipSync() {
        return typeof global.__fflateUnzipSync === 'function' ? global.__fflateUnzipSync : null;
    }

    function zipEntryBasename(name) {
        const raw = String(name || '').replace(/\\/g, '/');
        const parts = raw.split('/');
        return parts[parts.length - 1] || raw;
    }

    function zipEntryMatchesSuffix(name, suffix) {
        return zipEntryBasename(name).toLowerCase().endsWith(String(suffix || '').toLowerCase());
    }

    async function extractPdfFromZip(zipBlob, suffix) {
        const unzipSync = getUnzipSync();
        if (!unzipSync) {
            throw new Error('ZIP extraction is unavailable. Refresh the page and try again.');
        }
        const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
        const files = unzipSync(zipBytes);
        for (const [name, data] of Object.entries(files)) {
            if (zipEntryMatchesSuffix(name, suffix)) {
                return new Blob([data], { type: 'application/pdf' });
            }
        }
        throw new Error('Document pack is missing expected PDF file.');
    }

    async function extractBothPdfsFromZip(zipBlob) {
        const unzipSync = getUnzipSync();
        if (!unzipSync) {
            throw new Error('ZIP extraction is unavailable. Refresh the page and try again.');
        }
        const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
        const files = unzipSync(zipBytes);
        let confirmationBytes = null;
        let fullHistoryBytes = null;
        for (const [name, data] of Object.entries(files)) {
            if (zipEntryMatchesSuffix(name, CONFIRMATION_SUFFIX)) confirmationBytes = data;
            else if (zipEntryMatchesSuffix(name, FULL_HISTORY_SUFFIX)) fullHistoryBytes = data;
        }
        if (!confirmationBytes && !fullHistoryBytes) {
            throw new Error('Document pack is missing expected PDF files.');
        }
        return {
            confirmationBlob: confirmationBytes
                ? new Blob([confirmationBytes], { type: 'application/pdf' })
                : null,
            fullHistoryBlob: fullHistoryBytes
                ? new Blob([fullHistoryBytes], { type: 'application/pdf' })
                : null,
        };
    }

    async function fetchConfirmationBlob(ticket, revision) {
        const req = resolveDocumentPackRequest(ticket);
        if (!req) throw new Error('Cannot resolve document request');
        const rev = revision || req.revision;
        const urlWithRev = buildDocumentPackUrl(req.tn, req.orgId, {
            confirmationOnly: true,
            revision: rev,
        });
        const zipBlob = await fetchDocumentPackZipResponse(urlWithRev, req.token);
        return extractPdfFromZip(zipBlob, CONFIRMATION_SUFFIX);
    }

    async function fetchFullHistoryBlob(ticket) {
        const req = resolveDocumentPackRequest(ticket);
        if (!req) throw new Error('Cannot resolve document request');
        const url = buildDocumentPackUrl(req.tn, req.orgId, { fullHistoryOnly: true });
        const zipBlob = await fetchDocumentPackZipResponse(url, req.token);
        return extractPdfFromZip(zipBlob, FULL_HISTORY_SUFFIX);
    }

    async function cacheConfirmationIfNeeded(orgId, ticketBase, revision, blob, meta) {
        if (!global.offlineUsanDocs || !blob) return;
        const existing = await global.offlineUsanDocs.getConfirmation(orgId, ticketBase, revision);
        if (existing && existing.blob) return;
        await global.offlineUsanDocs.putConfirmation(orgId, ticketBase, revision, blob, meta);
    }

    async function loadOrFetchConfirmation(ticket, revision) {
        const orgId = resolveOrganizationId(ticket);
        const ticketBase = resolveTicketBase(ticket);
        const rev = String(revision || resolveCurrentRevision(ticket) || '').trim();
        if (orgId != null && ticketBase && rev && global.offlineUsanDocs) {
            const cached = await global.offlineUsanDocs.getConfirmation(orgId, ticketBase, rev);
            if (cached && cached.blob) return cached.blob;
        }
        if (!isOnline()) {
            throw new Error('Confirmation sheet is not available offline for this revision.');
        }
        const blob = await fetchConfirmationBlob(ticket, rev);
        const status =
            (Array.isArray(ticket.revisionEnquiries)
                ? (ticket.revisionEnquiries.find((e) => e && String(e.revision) === rev) || {}).status
                : null) ||
            (rev === resolveCurrentRevision(ticket) ? ticket.ngenEnquiryStatus : null);
        await cacheConfirmationIfNeeded(orgId, ticketBase, rev, blob, {
            status: status != null ? String(status) : null,
            enquiryId: ticket.ngenJobNumber != null ? String(ticket.ngenJobNumber) : null,
            requestNumber: resolveRequestNumberForTicket(ticket),
        });
        return blob;
    }

    async function loadOrFetchFullHistory(ticket, forceRefresh) {
        const orgId = resolveOrganizationId(ticket);
        const ticketBase = resolveTicketBase(ticket);
        if (!forceRefresh && orgId != null && ticketBase && global.offlineUsanDocs) {
            const cached = await global.offlineUsanDocs.getFullHistory(orgId, ticketBase);
            if (cached && cached.blob && !isOnline()) return cached.blob;
        }
        if (!isOnline()) {
            if (orgId != null && ticketBase && global.offlineUsanDocs) {
                const cached = await global.offlineUsanDocs.getFullHistory(orgId, ticketBase);
                if (cached && cached.blob) return cached.blob;
            }
            throw new Error('Full history is not available offline.');
        }
        const blob = await fetchFullHistoryBlob(ticket);
        if (orgId != null && ticketBase && global.offlineUsanDocs) {
            await global.offlineUsanDocs.putFullHistory(orgId, ticketBase, blob, {
                requestNumber: resolveRequestNumberForTicket(ticket),
            });
        }
        return blob;
    }

    /**
     * Fire-and-forget: cache current confirmation after ticket open refresh.
     * Never awaits in the refresh path; callers must void this.
     */
    function prefetchCurrentConfirmation(ticket) {
        try {
            if (!ticket || !isOnline()) return;
            if (!shouldShowDocumentPackButton(ticket)) return;
            const orgId = resolveOrganizationId(ticket);
            const ticketBase = resolveTicketBase(ticket);
            const revision = resolveCurrentRevision(ticket);
            if (orgId == null || !ticketBase || !revision) return;
            if (prefetchCredentialsMissingOrgs.has(String(orgId))) return;
            const key = `${orgId}:${ticketBase}:confirmation:${revision}`;
            if (prefetchInFlight.has(key)) return;

            const run = (async () => {
                try {
                    if (global.offlineUsanDocs) {
                        const existing = await global.offlineUsanDocs.getConfirmation(orgId, ticketBase, revision);
                        if (existing && existing.blob) return;
                    }
                    const blob = await fetchConfirmationBlob(ticket, revision);
                    await cacheConfirmationIfNeeded(orgId, ticketBase, revision, blob, {
                        status: ticket.ngenEnquiryStatus != null ? String(ticket.ngenEnquiryStatus) : null,
                        enquiryId: ticket.ngenJobNumber != null ? String(ticket.ngenJobNumber) : null,
                        requestNumber: resolveRequestNumberForTicket(ticket),
                    });
                } catch (e) {
                    const msg = e && e.message ? String(e.message) : '';
                    if (msg.includes('NGEN_HISTORY_CREDENTIALS_MISSING')) {
                        prefetchCredentialsMissingOrgs.add(String(orgId));
                    }
                    console.warn('[ticketDocumentPackFlow] prefetch confirmation:', e && e.message ? e.message : e);
                } finally {
                    prefetchInFlight.delete(key);
                }
            })();
            prefetchInFlight.set(key, run);
        } catch (e) {
            console.warn('[ticketDocumentPackFlow] prefetch start:', e && e.message ? e.message : e);
        }
    }

    function isMobileDocumentPackViewer() {
        try {
            return global.matchMedia && global.matchMedia(MOBILE_PDF_VIEWER_MQ).matches;
        } catch {
            return false;
        }
    }

    function getPdfJsLib() {
        return global.pdfjsLib || global['pdfjs-dist/build/pdf'];
    }

    async function loadPdfDocFromBlob(blob) {
        const pdfjsLib = getPdfJsLib();
        if (!pdfjsLib) {
            throw new Error('PDF viewer is unavailable. Refresh the page and try again.');
        }
        // Prefer same-origin worker (CDN workers fail on many mobile browsers / CSP).
        try {
            const workerUrl = new URL('/js/vendor/pdf.worker.min.js', global.location.origin).href;
            if (pdfjsLib.GlobalWorkerOptions) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
            }
        } catch {
            /* keep whatever was set in index.html */
        }
        const pdfBlob =
            blob.type && blob.type.includes('pdf')
                ? blob
                : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
        const arrayBuffer = await pdfBlob.arrayBuffer();
        try {
            return await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        } catch (e) {
            const msg = e && e.message ? String(e.message) : '';
            if (/fake worker|Cannot load script|worker/i.test(msg)) {
                // Last resort: main-thread parsing (slower, works when Worker setup fails).
                return pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true }).promise;
            }
            throw e;
        }
    }

    function destroyModalPdfDocs() {
        if (!modalSession || !modalSession.pdfDocs) return;
        for (const doc of Object.values(modalSession.pdfDocs)) {
            if (doc && typeof doc.destroy === 'function') {
                try {
                    doc.destroy();
                } catch {
                    /* ignore */
                }
            }
        }
        modalSession.pdfDocs = {};
    }

    async function computeFitScaleForPdf(pdfDoc, scrollEl) {
        const page = await pdfDoc.getPage(1);
        const unscaled = page.getViewport({ scale: 1 });
        const style = global.getComputedStyle ? global.getComputedStyle(scrollEl) : null;
        const padX = style
            ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
            : 16;
        const width = Math.max(200, scrollEl.clientWidth - padX);
        return width / unscaled.width;
    }

    function getActiveTabBlob(tab) {
        if (!modalSession) return null;
        return tab === 'confirmation' ? modalSession.confirmationBlob : modalSession.fullHistoryBlob;
    }

    function touchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.hypot(dx, dy);
    }

    function touchCenter(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2,
        };
    }

    function clampMobileScale(tab, scale) {
        if (!modalSession) return scale;
        const base = modalSession.mobileBaseScaleByTab[tab];
        if (!base) return scale;
        const minScale = base * MOBILE_ZOOM_MIN_FACTOR;
        const maxScale = base * MOBILE_ZOOM_MAX_FACTOR;
        return Math.max(minScale, Math.min(maxScale, scale));
    }

    function clearMobilePinchTransform(overlay) {
        if (!overlay) return;
        const pagesEl = overlay.querySelector('.ticket-hub-pdf-modal-pdf-pages');
        if (!pagesEl) return;
        pagesEl.style.transform = '';
        pagesEl.style.transformOrigin = '';
    }

    function updateMobileZoomButtons(overlay) {
        if (!modalSession || !overlay) return;
        const tab = modalSession.activeTab;
        const base = modalSession.mobileBaseScaleByTab[tab] || 1;
        const scale = modalSession.mobileScaleByTab[tab] || base;
        const minScale = base * MOBILE_ZOOM_MIN_FACTOR;
        const maxScale = base * MOBILE_ZOOM_MAX_FACTOR;
        const zoomOutBtn = overlay.querySelector('[data-pdf-zoom="out"]');
        const zoomInBtn = overlay.querySelector('[data-pdf-zoom="in"]');
        const zoomResetBtn = overlay.querySelector('[data-pdf-zoom="reset"]');
        if (zoomOutBtn) zoomOutBtn.disabled = scale <= minScale + 0.001;
        if (zoomInBtn) zoomInBtn.disabled = scale >= maxScale - 0.001;
        if (zoomResetBtn) {
            const pct = Math.round((scale / base) * 100);
            zoomResetBtn.textContent = pct + '%';
            zoomResetBtn.disabled = Math.abs(scale - base) < 0.001;
        }
    }

    async function renderMobilePdfPages(overlay) {
        if (!modalSession) return;
        const tab = modalSession.activeTab;
        const scrollEl = overlay.querySelector('.ticket-hub-pdf-modal-scroll');
        const pagesEl = overlay.querySelector('.ticket-hub-pdf-modal-pdf-pages');
        if (!scrollEl || !pagesEl) return;

        const blob = getActiveTabBlob(tab);
        if (!blob) return;

        if (!modalSession.pdfDocs[tab]) {
            modalSession.pdfDocs[tab] = await loadPdfDocFromBlob(blob);
        }
        const pdfDoc = modalSession.pdfDocs[tab];
        if (!modalSession.mobileBaseScaleByTab[tab]) {
            modalSession.mobileBaseScaleByTab[tab] = await computeFitScaleForPdf(pdfDoc, scrollEl);
        }
        if (!modalSession.mobileScaleByTab[tab]) {
            modalSession.mobileScaleByTab[tab] = modalSession.mobileBaseScaleByTab[tab];
        }

        const scale = modalSession.mobileScaleByTab[tab];
        pagesEl.innerHTML = '';
        clearMobilePinchTransform(overlay);

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const pageWrapper = document.createElement('div');
            pageWrapper.className = 'ticket-hub-pdf-modal-page';

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale });
            const outputScale = global.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            pageWrapper.style.width = viewport.width + 'px';
            pageWrapper.appendChild(canvas);

            await page.render({
                canvasContext: ctx,
                viewport: viewport,
                transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
            }).promise;

            pagesEl.appendChild(pageWrapper);
        }

        updateMobileZoomButtons(overlay);
    }

    async function setMobilePdfScale(overlay, scale, scrollAnchor) {
        if (!modalSession) return;
        const tab = modalSession.activeTab;
        const base = modalSession.mobileBaseScaleByTab[tab];
        if (!base) return;

        const oldScale = modalSession.mobileScaleByTab[tab] || base;
        const newScale = clampMobileScale(tab, scale);
        if (Math.abs(newScale - oldScale) < 0.001) {
            updateMobileZoomButtons(overlay);
            return;
        }

        const scrollEl = overlay.querySelector('.ticket-hub-pdf-modal-scroll');
        let anchorXContent = null;
        let anchorYContent = null;
        if (scrollAnchor && scrollEl) {
            const rect = scrollEl.getBoundingClientRect();
            anchorXContent = scrollAnchor.x - rect.left + scrollEl.scrollLeft;
            anchorYContent = scrollAnchor.y - rect.top + scrollEl.scrollTop;
        }

        clearMobilePinchTransform(overlay);
        modalSession.mobileScaleByTab[tab] = newScale;
        const pagesEl = overlay.querySelector('.ticket-hub-pdf-modal-pdf-pages');
        if (pagesEl) pagesEl.innerHTML = '<div class="ticket-hub-pdf-modal-loading">Rendering…</div>';

        await renderMobilePdfPages(overlay);

        if (scrollAnchor && scrollEl && anchorXContent != null && anchorYContent != null) {
            const ratio = newScale / oldScale;
            const rect = scrollEl.getBoundingClientRect();
            scrollEl.scrollLeft = anchorXContent * ratio - (scrollAnchor.x - rect.left);
            scrollEl.scrollTop = anchorYContent * ratio - (scrollAnchor.y - rect.top);
        }
    }

    async function adjustMobilePdfZoom(overlay, direction) {
        if (!modalSession) return;
        const tab = modalSession.activeTab;
        const base = modalSession.mobileBaseScaleByTab[tab];
        if (!base) return;

        let scale = modalSession.mobileScaleByTab[tab] || base;
        if (direction === 'in') {
            scale = Math.min(scale * MOBILE_ZOOM_STEP, base * MOBILE_ZOOM_MAX_FACTOR);
        } else if (direction === 'out') {
            scale = Math.max(scale / MOBILE_ZOOM_STEP, base * MOBILE_ZOOM_MIN_FACTOR);
        } else {
            scale = base;
        }

        const scrollEl = overlay.querySelector('.ticket-hub-pdf-modal-scroll');
        let anchor = null;
        if (scrollEl) {
            const rect = scrollEl.getBoundingClientRect();
            anchor = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }

        try {
            await setMobilePdfScale(overlay, scale, anchor);
        } catch (e) {
            console.error('adjustMobilePdfZoom:', e);
            if (typeof global.appAlert === 'function') {
                void global.appAlert(userFacingErrorMessage(e, 'Failed to zoom document.'));
            }
        }
    }

    function onMobilePinchTouchStart(e) {
        if (!modalSession) return;
        if (e.touches.length === 2) {
            mobileLastTap = null;
        }
        if (e.touches.length !== 2) return;
        const overlay = document.getElementById(MODAL_OVERLAY_ID);
        if (!overlay) return;
        const tab = modalSession.activeTab;
        const renderedScale = modalSession.mobileScaleByTab[tab];
        if (!renderedScale) return;
        mobilePinchState = {
            overlay: overlay,
            startDistance: touchDistance(e.touches),
            startScale: renderedScale,
            pendingScale: renderedScale,
            lastCenter: touchCenter(e.touches),
        };
    }

    function onMobilePinchTouchMove(e) {
        if (!mobilePinchState || !modalSession || e.touches.length !== 2) return;
        e.preventDefault();
        const tab = modalSession.activeTab;
        const renderedScale = modalSession.mobileScaleByTab[tab] || mobilePinchState.startScale;
        const distance = touchDistance(e.touches);
        if (mobilePinchState.startDistance < 1 || renderedScale <= 0) return;

        const pendingScale = clampMobileScale(
            tab,
            mobilePinchState.startScale * (distance / mobilePinchState.startDistance)
        );
        mobilePinchState.pendingScale = pendingScale;
        mobilePinchState.lastCenter = touchCenter(e.touches);

        const pagesEl = mobilePinchState.overlay.querySelector('.ticket-hub-pdf-modal-pdf-pages');
        if (!pagesEl) return;
        const visualFactor = pendingScale / renderedScale;
        const rect = pagesEl.getBoundingClientRect();
        const center = mobilePinchState.lastCenter;
        pagesEl.style.transformOrigin = center.x - rect.left + 'px ' + (center.y - rect.top) + 'px';
        pagesEl.style.transform = 'scale(' + visualFactor + ')';

        const base = modalSession.mobileBaseScaleByTab[tab] || 1;
        const zoomResetBtn = mobilePinchState.overlay.querySelector('[data-pdf-zoom="reset"]');
        if (zoomResetBtn) {
            zoomResetBtn.textContent = Math.round((pendingScale / base) * 100) + '%';
        }
    }

    function onMobilePinchTouchEnd(e) {
        if (!mobilePinchState) return;
        if (e.touches.length >= 2) return;

        const state = mobilePinchState;
        mobilePinchState = null;
        if (!modalSession) {
            clearMobilePinchTransform(state.overlay);
            return;
        }

        const tab = modalSession.activeTab;
        const renderedScale = modalSession.mobileScaleByTab[tab] || state.startScale;
        clearMobilePinchTransform(state.overlay);

        if (Math.abs(state.pendingScale - renderedScale) < 0.01) {
            updateMobileZoomButtons(state.overlay);
            return;
        }

        void setMobilePdfScale(state.overlay, state.pendingScale, state.lastCenter).catch(function (err) {
            console.error('onMobilePinchTouchEnd:', err);
            if (typeof global.appAlert === 'function') {
                void global.appAlert(userFacingErrorMessage(err, 'Failed to zoom document.'));
            }
        });
    }

    function handleMobileDoubleTap(e) {
        if (!modalSession || mobilePinchState) return;
        if (e.touches.length > 0) return;
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;

        const overlay = document.getElementById(MODAL_OVERLAY_ID);
        if (!overlay) return;

        const now = Date.now();
        const x = touch.clientX;
        const y = touch.clientY;

        if (
            mobileLastTap &&
            now - mobileLastTap.time < MOBILE_DOUBLE_TAP_MS &&
            Math.hypot(x - mobileLastTap.x, y - mobileLastTap.y) < MOBILE_DOUBLE_TAP_MAX_DIST
        ) {
            mobileLastTap = null;

            const tab = modalSession.activeTab;
            const base = modalSession.mobileBaseScaleByTab[tab];
            if (!base) return;
            const current = modalSession.mobileScaleByTab[tab] || base;
            const nearBase = Math.abs(current - base) < base * 0.12;
            const target = nearBase
                ? clampMobileScale(tab, current * MOBILE_DOUBLE_TAP_ZOOM_FACTOR)
                : base;

            void setMobilePdfScale(overlay, target, { x: x, y: y }).catch(function (err) {
                console.error('handleMobileDoubleTap:', err);
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(userFacingErrorMessage(err, 'Failed to zoom document.'));
                }
            });
            return;
        }

        mobileLastTap = { time: now, x: x, y: y };
    }

    function onMobileTouchEnd(e) {
        onMobilePinchTouchEnd(e);
        handleMobileDoubleTap(e);
    }

    function initMobilePinchZoom(overlay) {
        const scrollEl = overlay.querySelector('.ticket-hub-pdf-modal-scroll');
        if (!scrollEl || scrollEl.dataset.pinchInit === '1') return;
        scrollEl.dataset.pinchInit = '1';
        scrollEl.addEventListener('touchstart', onMobilePinchTouchStart, { passive: true });
        scrollEl.addEventListener('touchmove', onMobilePinchTouchMove, { passive: false });
        scrollEl.addEventListener('touchend', onMobileTouchEnd, { passive: true });
        scrollEl.addEventListener('touchcancel', onMobileTouchEnd, { passive: true });
    }

    function revokeModalBlobUrls() {
        if (!modalSession || !modalSession.blobUrls) return;
        for (const url of modalSession.blobUrls) {
            try {
                URL.revokeObjectURL(url);
            } catch {
                /* ignore */
            }
        }
        modalSession.blobUrls = [];
    }

    function closeDocumentPackViewer() {
        mobilePinchState = null;
        mobileLastTap = null;
        destroyModalPdfDocs();
        revokeModalBlobUrls();
        modalSession = null;
        const overlay = document.getElementById(MODAL_OVERLAY_ID);
        if (overlay) overlay.remove();
    }

    function downloadBlob(blob, filename, mimeType) {
        if (global.dataExportModule && typeof global.dataExportModule.downloadBlob === 'function') {
            global.dataExportModule.downloadBlob(blob, filename, mimeType);
            return;
        }
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
    }

    function saveZipBlob(zipBlob, filename) {
        downloadBlob(zipBlob, filename, 'application/zip');
    }

    async function downloadActivePdfFromSession() {
        if (!modalSession) return;
        const tab = modalSession.activeTab || 'confirmation';
        let blob = tab === 'confirmation' ? modalSession.confirmationBlob : modalSession.fullHistoryBlob;
        if (!blob && tab === 'full-history') {
            if (!isOnline()) {
                throw new Error('Full history is not cached. Connect and open the Full history tab first.');
            }
            blob = await loadOrFetchFullHistory(modalSession.ticket, true);
            modalSession.fullHistoryBlob = blob;
            modalSession.fullHistoryLoaded = true;
        }
        if (!blob) {
            throw new Error(tab === 'confirmation' ? 'Confirmation sheet is missing.' : 'Full history is missing.');
        }
        const filename =
            tab === 'confirmation'
                ? buildConfirmationPdfFilename(modalSession.ticket, modalSession.selectedRevision)
                : modalSession.fullHistoryPdfFilename;
        downloadBlob(blob, filename, 'application/pdf');
    }

    async function buildDownloadZipFromSession() {
        if (!modalSession) return;
        let fullHistory = modalSession.fullHistoryBlob;
        if (!fullHistory) {
            if (!isOnline()) {
                throw new Error('Full history is not cached. Connect and open the Full history tab first.');
            }
            fullHistory = await loadOrFetchFullHistory(modalSession.ticket, true);
            modalSession.fullHistoryBlob = fullHistory;
            modalSession.fullHistoryLoaded = true;
        }
        if (!modalSession.confirmationBlob) {
            throw new Error('Confirmation sheet is missing.');
        }
        const zipSync = typeof global.__fflateZipSync === 'function' ? global.__fflateZipSync : null;
        if (!zipSync) {
            // Fallback: fetch combined pack
            const req = resolveDocumentPackRequest(modalSession.ticket);
            if (!req) throw new Error('Cannot build download');
            const url = buildDocumentPackUrl(req.tn, req.orgId, {});
            const zipBlob = await fetchDocumentPackZipResponse(url, req.token);
            saveZipBlob(zipBlob, modalSession.zipFilename);
            return;
        }
        const confBytes = new Uint8Array(await modalSession.confirmationBlob.arrayBuffer());
        const histBytes = new Uint8Array(await fullHistory.arrayBuffer());
        const zipBytes = zipSync({
            [buildConfirmationPdfFilename(modalSession.ticket, modalSession.selectedRevision)]: confBytes,
            [modalSession.fullHistoryPdfFilename]: histBytes,
        });
        saveZipBlob(new Blob([zipBytes], { type: 'application/zip' }), modalSession.zipFilename);
    }

    function populateRevisionSelect(overlay) {
        if (!modalSession || !overlay) return;
        const sel = overlay.querySelector('.ticket-hub-pdf-modal-revision-select');
        if (!sel) return;
        sel.innerHTML = '';
        for (const opt of modalSession.revisionOptions) {
            const o = document.createElement('option');
            o.value = opt.revision;
            o.textContent = formatRevisionLabel(opt);
            if (opt.revision === modalSession.selectedRevision) o.selected = true;
            sel.appendChild(o);
        }
        sel.disabled = modalSession.revisionOptions.length <= 1;
    }

    async function setModalTab(overlay, tab) {
        if (!modalSession) return;
        modalSession.activeTab = tab;

        const iframe = overlay.querySelector('.ticket-hub-pdf-modal-iframe');
        const mobileView = overlay.querySelector('.ticket-hub-pdf-modal-mobile-view');
        const tabs = overlay.querySelectorAll('[data-doc-tab]');
        const revWrap = overlay.querySelector('.ticket-hub-pdf-modal-revision-wrap');
        tabs.forEach(function (btn) {
            const isActive = btn.getAttribute('data-doc-tab') === tab;
            btn.classList.toggle('ticket-hub-pdf-modal-tab--active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        if (revWrap) revWrap.hidden = tab !== 'confirmation';

        if (tab === 'full-history' && !modalSession.fullHistoryLoaded && !modalSession.fullHistoryLoading) {
            modalSession.fullHistoryLoading = true;
            setModalLoading(overlay, true, 'Loading full history…');
            try {
                modalSession.fullHistoryBlob = await loadOrFetchFullHistory(modalSession.ticket, isOnline());
                modalSession.fullHistoryLoaded = true;
                if (modalSession.pdfDocs['full-history']) {
                    try {
                        modalSession.pdfDocs['full-history'].destroy();
                    } catch {
                        /* ignore */
                    }
                    delete modalSession.pdfDocs['full-history'];
                }
            } catch (e) {
                console.error('setModalTab full-history:', e);
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(userFacingErrorMessage(e, 'Failed to load full history.'));
                }
                modalSession.activeTab = 'confirmation';
                modalSession.fullHistoryLoading = false;
                setModalLoading(overlay, false);
                await setModalTab(overlay, 'confirmation');
                return;
            }
            modalSession.fullHistoryLoading = false;
            setModalLoading(overlay, false);
        }

        if (isMobileDocumentPackViewer()) {
            if (iframe) iframe.hidden = true;
            if (mobileView) mobileView.hidden = false;
            clearMobilePinchTransform(overlay);
            const pagesEl = overlay.querySelector('.ticket-hub-pdf-modal-pdf-pages');
            if (pagesEl) pagesEl.innerHTML = '<div class="ticket-hub-pdf-modal-loading">Loading page…</div>';
            try {
                await renderMobilePdfPages(overlay);
            } catch (e) {
                console.error('setModalTab mobile:', e);
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(userFacingErrorMessage(e, 'Failed to display document.'));
                }
            }
            return;
        }

        if (mobileView) mobileView.hidden = true;
        if (!iframe) return;
        const blob = tab === 'confirmation' ? modalSession.confirmationBlob : modalSession.fullHistoryBlob;
        if (!blob) return;
        const blobUrl = URL.createObjectURL(blob);
        modalSession.blobUrls.push(blobUrl);
        iframe.src = blobUrl;
        iframe.hidden = false;
    }

    function setModalLoading(overlay, loading, message) {
        const loadingEl = overlay.querySelector('.ticket-hub-pdf-modal-body > .ticket-hub-pdf-modal-loading');
        const iframe = overlay.querySelector('.ticket-hub-pdf-modal-iframe');
        const mobileView = overlay.querySelector('.ticket-hub-pdf-modal-mobile-view');
        const tabs = overlay.querySelectorAll('[data-doc-tab]');
        const downloadBtn = overlay.querySelector('.ticket-hub-pdf-modal-download-btn');
        const pdfDownloadBtn = overlay.querySelector('.ticket-hub-pdf-modal-download-pdf-btn');
        const zoomBtns = overlay.querySelectorAll('[data-pdf-zoom]');
        const mobileDownloadBtn = overlay.querySelector('[data-pdf-download]');
        const revSel = overlay.querySelector('.ticket-hub-pdf-modal-revision-select');
        if (loadingEl) {
            loadingEl.hidden = !loading;
            if (message) loadingEl.textContent = message;
        }
        if (iframe) iframe.hidden = loading || isMobileDocumentPackViewer();
        if (mobileView) mobileView.hidden = loading || !isMobileDocumentPackViewer();
        tabs.forEach(function (btn) {
            btn.disabled = loading;
        });
        zoomBtns.forEach(function (btn) {
            btn.disabled = loading;
        });
        if (downloadBtn) downloadBtn.disabled = loading;
        if (pdfDownloadBtn) pdfDownloadBtn.disabled = loading;
        if (mobileDownloadBtn) mobileDownloadBtn.disabled = loading;
        if (revSel) revSel.disabled = loading || (modalSession && modalSession.revisionOptions.length <= 1);
    }

    async function switchConfirmationRevision(overlay, revision) {
        if (!modalSession || !revision || revision === modalSession.selectedRevision) return;
        setModalLoading(overlay, true, 'Loading confirmation…');
        try {
            const blob = await loadOrFetchConfirmation(modalSession.ticket, revision);
            modalSession.confirmationBlob = blob;
            modalSession.selectedRevision = revision;
            if (modalSession.pdfDocs.confirmation) {
                try {
                    modalSession.pdfDocs.confirmation.destroy();
                } catch {
                    /* ignore */
                }
                delete modalSession.pdfDocs.confirmation;
            }
            delete modalSession.mobileBaseScaleByTab.confirmation;
            delete modalSession.mobileScaleByTab.confirmation;
            revokeModalBlobUrls();
            setModalLoading(overlay, false);
            await setModalTab(overlay, 'confirmation');
        } catch (e) {
            console.error('switchConfirmationRevision:', e);
            setModalLoading(overlay, false);
            if (typeof global.appAlert === 'function') {
                void global.appAlert(userFacingErrorMessage(e, 'Failed to load confirmation sheet.'));
            }
            populateRevisionSelect(overlay);
        }
    }

    async function openTicketDocumentPackViewer(ticket, triggerEl) {
        if (viewerInFlight) return;

        const req = resolveDocumentPackRequest(ticket);
        if (!req) return;

        closeDocumentPackViewer();

        const btn = triggerEl && triggerEl.tagName === 'BUTTON' ? triggerEl : null;
        const prevDisabled = btn ? btn.disabled : false;
        const prevText = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Loading…';
        }
        viewerInFlight = true;

        const displayLabel = resolveRequestNumberForTicket(ticket) || req.tn;
        const mobileViewer = isMobileDocumentPackViewer();
        const wrap = document.createElement('div');
        wrap.id = MODAL_OVERLAY_ID;
        wrap.className =
            'ticket-hub-pdf-modal-overlay' + (mobileViewer ? ' ticket-hub-pdf-modal-overlay--mobile' : '');
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'USAN documents');
        wrap.innerHTML =
            '<div class="ticket-hub-pdf-modal-panel">' +
            '<div class="ticket-hub-pdf-modal-header">' +
            '<div class="ticket-hub-pdf-modal-header-main">' +
            '<h3 class="ticket-hub-pdf-modal-title">USAN documents — ' +
            escHtml(displayLabel) +
            '</h3>' +
            '<div class="ticket-hub-pdf-modal-tabs" role="tablist">' +
            '<button type="button" class="ticket-hub-pdf-modal-tab ticket-hub-pdf-modal-tab--active" data-doc-tab="confirmation" role="tab" aria-selected="true" disabled>Confirmation sheet</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-tab" data-doc-tab="full-history" role="tab" aria-selected="false" disabled>Full history</button>' +
            '</div>' +
            '<div class="ticket-hub-pdf-modal-revision-wrap">' +
            '<label class="ticket-hub-pdf-modal-revision-label" for="ticketDocPackRevisionSelect">Revision</label>' +
            '<select id="ticketDocPackRevisionSelect" class="ticket-hub-pdf-modal-revision-select" disabled></select>' +
            '</div>' +
            '</div>' +
            '<div class="ticket-hub-pdf-modal-header-actions">' +
            '<button type="button" class="ticket-hub-pdf-modal-download-btn ticket-hub-pdf-modal-download-pdf-btn" disabled>Download PDF</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-download-btn" disabled>Download Doc pack</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '</div>' +
            '<div class="ticket-hub-pdf-modal-body">' +
            '<div class="ticket-hub-pdf-modal-loading">Loading confirmation…</div>' +
            '<iframe class="ticket-hub-pdf-modal-iframe" title="USAN document preview" hidden></iframe>' +
            '<div class="ticket-hub-pdf-modal-mobile-view" hidden>' +
            '<div class="ticket-hub-pdf-modal-scroll">' +
            '<div class="ticket-hub-pdf-modal-pdf-pages"></div>' +
            '</div>' +
            '<div class="ticket-hub-pdf-modal-zoom-bar">' +
            '<button type="button" class="ticket-hub-pdf-modal-zoom-btn" data-pdf-zoom="out" aria-label="Zoom out" disabled>−</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-zoom-btn ticket-hub-pdf-modal-zoom-btn--reset" data-pdf-zoom="reset" aria-label="Reset zoom" disabled>100%</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-zoom-btn" data-pdf-zoom="in" aria-label="Zoom in" disabled>+</button>' +
            '<button type="button" class="ticket-hub-pdf-modal-zoom-btn ticket-hub-pdf-modal-zoom-btn--download" data-pdf-download disabled title="Download current PDF">↓</button>' +
            '</div>' +
            '</div>' +
            '</div>' +
            '</div>';

        document.body.appendChild(wrap);
        if (mobileViewer) {
            initMobilePinchZoom(wrap);
        }

        const panel = wrap.querySelector('.ticket-hub-pdf-modal-panel');
        if (panel) {
            panel.addEventListener('click', function (ev) {
                ev.stopPropagation();
            });
        }
        wrap.addEventListener('click', function (ev) {
            if (ev.target === wrap) closeDocumentPackViewer();
        });
        const closeBtn = wrap.querySelector('.ticket-hub-pdf-modal-close');
        if (closeBtn) closeBtn.addEventListener('click', closeDocumentPackViewer);

        const downloadBtn = wrap.querySelector('.ticket-hub-pdf-modal-download-btn:not(.ticket-hub-pdf-modal-download-pdf-btn)');
        const pdfDownloadBtn = wrap.querySelector('.ticket-hub-pdf-modal-download-pdf-btn');
        const mobileDownloadBtn = wrap.querySelector('[data-pdf-download]');
        async function onDownloadPackClick() {
            if (!modalSession) return;
            try {
                await buildDownloadZipFromSession();
            } catch (e) {
                console.error('download zip:', e);
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(userFacingErrorMessage(e, 'Failed to download document pack.'));
                }
            }
        }
        async function onDownloadPdfClick() {
            if (!modalSession) return;
            try {
                await downloadActivePdfFromSession();
            } catch (e) {
                console.error('download pdf:', e);
                if (typeof global.appAlert === 'function') {
                    void global.appAlert(userFacingErrorMessage(e, 'Failed to download PDF.'));
                }
            }
        }
        if (downloadBtn) downloadBtn.addEventListener('click', function () {
            void onDownloadPackClick();
        });
        if (pdfDownloadBtn) pdfDownloadBtn.addEventListener('click', function () {
            void onDownloadPdfClick();
        });
        if (mobileDownloadBtn) {
            mobileDownloadBtn.addEventListener('click', function () {
                if (!modalSession || mobileDownloadBtn.disabled) return;
                void onDownloadPdfClick();
            });
        }

        wrap.querySelectorAll('[data-doc-tab]').forEach(function (tabBtn) {
            tabBtn.addEventListener('click', function () {
                const tab = tabBtn.getAttribute('data-doc-tab');
                if (!tab || !modalSession || tabBtn.disabled) return;
                if (!isMobileDocumentPackViewer()) {
                    revokeModalBlobUrls();
                }
                void setModalTab(wrap, tab);
            });
        });

        const revSel = wrap.querySelector('.ticket-hub-pdf-modal-revision-select');
        if (revSel) {
            revSel.addEventListener('change', function () {
                void switchConfirmationRevision(wrap, revSel.value);
            });
        }

        wrap.querySelectorAll('[data-pdf-zoom]').forEach(function (zoomBtn) {
            zoomBtn.addEventListener('click', function () {
                if (!modalSession || zoomBtn.disabled) return;
                const direction = zoomBtn.getAttribute('data-pdf-zoom');
                if (direction === 'in' || direction === 'out' || direction === 'reset') {
                    void adjustMobilePdfZoom(wrap, direction);
                }
            });
        });

        try {
            let revisionOptions = collectRevisionOptions(ticket);
            if (global.offlineUsanDocs && typeof global.offlineUsanDocs.listCachedConfirmationRevisions === 'function') {
                const cachedRevs = await global.offlineUsanDocs.listCachedConfirmationRevisions(
                    req.orgId,
                    req.ticketBase
                );
                for (const rev of cachedRevs) {
                    if (!revisionOptions.some((o) => o.revision === rev)) {
                        revisionOptions.push({ revision: rev, status: null });
                    }
                }
                revisionOptions.sort((a, b) => String(a.revision).localeCompare(String(b.revision)));
            }

            if (!isOnline()) {
                const cachedOnly = [];
                for (const opt of revisionOptions) {
                    if (!global.offlineUsanDocs) continue;
                    const row = await global.offlineUsanDocs.getConfirmation(
                        req.orgId,
                        req.ticketBase,
                        opt.revision
                    );
                    if (row && row.blob) cachedOnly.push(opt);
                }
                if (cachedOnly.length === 0) {
                    throw new Error('No confirmation sheets are cached offline for this ticket.');
                }
                revisionOptions = cachedOnly;
            }

            const preferredRev = req.revision;
            const selectedRevision = revisionOptions.some((o) => o.revision === preferredRev)
                ? preferredRev
                : revisionOptions[revisionOptions.length - 1].revision;

            const confirmationBlob = await loadOrFetchConfirmation(ticket, selectedRevision);

            modalSession = {
                ticket,
                orgId: req.orgId,
                ticketBase: req.ticketBase,
                zipFilename: req.zipFilename,
                fullHistoryPdfFilename: req.fullHistoryPdfFilename,
                confirmationBlob,
                fullHistoryBlob: null,
                selectedRevision,
                revisionOptions,
                blobUrls: [],
                activeTab: 'confirmation',
                pdfDocs: {},
                mobileBaseScaleByTab: {},
                mobileScaleByTab: {},
                fullHistoryLoaded: false,
                fullHistoryLoading: false,
            };

            populateRevisionSelect(wrap);
            setModalLoading(wrap, false);
            if (downloadBtn) downloadBtn.disabled = false;
            if (pdfDownloadBtn) pdfDownloadBtn.disabled = false;
            if (mobileDownloadBtn) mobileDownloadBtn.disabled = false;
            await setModalTab(wrap, 'confirmation');
        } catch (e) {
            console.error('openTicketDocumentPackViewer:', e);
            closeDocumentPackViewer();
            if (typeof global.appAlert === 'function') {
                void global.appAlert(userFacingErrorMessage(e, 'Failed to load USAN documents.'));
            }
        } finally {
            viewerInFlight = false;
            if (btn) {
                btn.disabled = prevDisabled;
                btn.textContent = prevText || 'View docs';
            }
        }
    }

    async function downloadFullHistoryPdf(ticket) {
        const blob = await loadOrFetchFullHistory(ticket, false);
        downloadBlob(blob, buildFullHistoryPdfFilename(ticket), 'application/pdf');
    }

    async function downloadTicketDocumentPack(ticket, triggerEl) {
        return openTicketDocumentPackViewer(ticket, triggerEl);
    }

    global.ticketDocumentPackFlow = {
        shouldShowDocumentPackButton,
        resolveRequestNumberForTicket,
        openTicketDocumentPackViewer,
        downloadTicketDocumentPack,
        downloadFullHistoryPdf,
        closeDocumentPackViewer,
        prefetchCurrentConfirmation,
    };
})(typeof window !== 'undefined' ? window : globalThis);
